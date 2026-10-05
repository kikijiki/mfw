import type { Logger } from "./log.ts";
import {
	type OpenRouterActivityRecord,
	OpenRouterApiError,
	type OpenRouterClientPort,
	type OpenRouterKeyUsage,
} from "./openrouter-client.ts";
import type { ProviderCredentialCoordinator } from "./settings.ts";

export const OPENROUTER_REFRESH_INTERVAL_MS = 15_000;

export interface OpenRouterActivityDay {
	date: string;
	usage: number;
	byokUsage: number;
	requests: number;
	promptTokens: number;
	completionTokens: number;
	reasoningTokens: number;
}

export interface OpenRouterActivityGroup {
	name: string;
	usage: number;
	requests: number;
	tokens: number;
}

export interface OpenRouterAccountReadModel {
	credential: {
		ready: boolean;
		validatedAt: number | null;
		validationError: string | null;
	};
	managementCredential: {
		ready: boolean;
		validatedAt: number | null;
		validationError: string | null;
	};
	checkedAt: number | null;
	observedAt: number | null;
	fresh: boolean;
	error: string | null;
	key: OpenRouterKeyUsage | null;
	credits: {
		available: boolean;
		reason: "management_key_required" | "unavailable" | null;
		totalCredits: number | null;
		totalUsage: number | null;
		remainingCredits: number | null;
		error: string | null;
	};
	accountUsage: {
		available: boolean;
		total: number | null;
		daily: number | null;
		weekly: number | null;
		monthly: number | null;
		keyCount: number;
		error: string | null;
	};
	activity: {
		available: boolean;
		reason: "management_key_required" | "unavailable" | null;
		days: OpenRouterActivityDay[];
		models: OpenRouterActivityGroup[];
		providers: OpenRouterActivityGroup[];
		error: string | null;
	};
}

function unavailable(reason: "management_key_required" | "unavailable") {
	return {
		available: false as const,
		reason,
		totalCredits: null,
		totalUsage: null,
		remainingCredits: null,
		error: null,
	};
}

function unavailableActivity(
	reason: "management_key_required" | "unavailable",
) {
	return {
		available: false as const,
		reason,
		days: [],
		models: [],
		providers: [],
		error: null,
	};
}

function unavailableAccountUsage() {
	return {
		available: false as const,
		total: null,
		daily: null,
		weekly: null,
		monthly: null,
		keyCount: 0,
		error: null,
	};
}

function errorText(error: unknown): string {
	return error instanceof OpenRouterApiError
		? error.code
		: "account_refresh_failed";
}

function aggregateActivity(records: OpenRouterActivityRecord[]) {
	const days = new Map<string, OpenRouterActivityDay>();
	const models = new Map<string, OpenRouterActivityGroup>();
	const providers = new Map<string, OpenRouterActivityGroup>();
	for (const row of records) {
		const tokenCount =
			row.promptTokens + row.completionTokens + row.reasoningTokens;
		const day = days.get(row.date) ?? {
			date: row.date,
			usage: 0,
			byokUsage: 0,
			requests: 0,
			promptTokens: 0,
			completionTokens: 0,
			reasoningTokens: 0,
		};
		day.usage += row.usage;
		day.byokUsage += row.byokUsageInference;
		day.requests += row.requests;
		day.promptTokens += row.promptTokens;
		day.completionTokens += row.completionTokens;
		day.reasoningTokens += row.reasoningTokens;
		days.set(row.date, day);
		for (const [map, name] of [
			[models, row.model],
			[providers, row.providerName],
		] as const) {
			const group = map.get(name) ?? { name, usage: 0, requests: 0, tokens: 0 };
			group.usage += row.usage;
			group.requests += row.requests;
			group.tokens += tokenCount;
			map.set(name, group);
		}
	}
	const ranked = (values: Iterable<OpenRouterActivityGroup>) =>
		[...values].sort((a, b) => b.usage - a.usage).slice(0, 20);
	return {
		days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
		models: ranked(models.values()),
		providers: ranked(providers.values()),
	};
}

export class OpenRouterAccountService implements ProviderCredentialCoordinator {
	private timer: ReturnType<typeof setInterval> | null = null;
	private inFlight: Promise<OpenRouterAccountReadModel> | null = null;
	private model: OpenRouterAccountReadModel = {
		credential: { ready: false, validatedAt: null, validationError: null },
		managementCredential: {
			ready: false,
			validatedAt: null,
			validationError: null,
		},
		checkedAt: null,
		observedAt: null,
		fresh: false,
		error: null,
		key: null,
		credits: unavailable("unavailable"),
		accountUsage: unavailableAccountUsage(),
		activity: unavailableActivity("unavailable"),
	};

	constructor(
		private readonly deps: {
			client: OpenRouterClientPort;
			managementClient?: OpenRouterClientPort;
			log: Logger;
			refreshIntervalMs?: number;
		},
	) {}

	readModel(): OpenRouterAccountReadModel {
		return structuredClone(this.model);
	}

	async start(): Promise<void> {
		await this.refresh("startup");
		if (this.timer) return;
		this.timer = setInterval(() => {
			void this.refresh("periodic").catch((error) =>
				this.deps.log.warn(
					{ code: errorText(error) },
					"OpenRouter account refresh failed",
				),
			);
		}, this.deps.refreshIntervalMs ?? OPENROUTER_REFRESH_INTERVAL_MS);
		this.timer.unref?.();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	async refresh(
		_reason = "operator_refresh",
	): Promise<OpenRouterAccountReadModel> {
		if (this.inFlight) return this.inFlight;
		this.inFlight = this.refreshNow().finally(() => {
			this.inFlight = null;
		});
		return this.inFlight;
	}

	async setCredential(
		mutate: (validate: () => Promise<void>) => Promise<void>,
	): Promise<void> {
		await mutate(async () => {
			const key = await this.deps.client.getCurrentKey();
			if (key.isManagementKey) {
				throw new OpenRouterApiError(
					"invalid_response",
					"Use a standard OpenRouter key for inference",
				);
			}
		});
		await this.refresh("credential_updated");
	}

	async setManagementCredential(
		mutate: (validate: () => Promise<void>) => Promise<void>,
	): Promise<void> {
		const client = this.deps.managementClient;
		if (!client) throw new Error("OpenRouter management client is unavailable");
		await mutate(async () => {
			const key = await client.getCurrentKey();
			if (!key.isManagementKey) {
				throw new OpenRouterApiError(
					"invalid_response",
					"OpenRouter management key required",
				);
			}
		});
		await this.refresh("management_credential_updated");
	}

	async removeManagementCredential(mutate: () => Promise<void>): Promise<void> {
		await mutate();
		await this.refresh("management_credential_removed");
	}

	async removeCredential(mutate: () => Promise<void>): Promise<void> {
		await mutate();
		await this.refresh("credential_removed");
	}

	private async refreshNow(): Promise<OpenRouterAccountReadModel> {
		const checkedAt = Date.now();
		const [ready, managementReady] = await Promise.all([
			this.deps.client.credentialReady(),
			this.deps.managementClient?.credentialReady() ?? Promise.resolve(false),
		]);
		if (!ready && !managementReady) {
			this.model = {
				...this.model,
				credential: { ready: false, validatedAt: null, validationError: null },
				managementCredential: {
					ready: false,
					validatedAt: null,
					validationError: null,
				},
				checkedAt,
				fresh: false,
				error: null,
				key: null,
				credits: unavailable("unavailable"),
				accountUsage: unavailableAccountUsage(),
				activity: unavailableActivity("unavailable"),
			};
			return this.readModel();
		}

		let key: OpenRouterKeyUsage | null = null;
		let inferenceError: string | null = null;
		if (ready)
			try {
				key = await this.deps.client.getCurrentKey();
			} catch (error) {
				const code = errorText(error);
				inferenceError = code;
			}

		let credits: OpenRouterAccountReadModel["credits"] =
			unavailable("unavailable");
		let activity: OpenRouterAccountReadModel["activity"] = managementReady
			? unavailableActivity("unavailable")
			: unavailableActivity("management_key_required");
		const accountClient = managementReady
			? this.deps.managementClient
			: ready
				? this.deps.client
				: undefined;
		let accountUsage: OpenRouterAccountReadModel["accountUsage"] =
			unavailableAccountUsage();
		const [creditResult, activityResult, keysResult] = await Promise.allSettled(
			[
				// Account credits are available to ordinary API keys in the live API.
				// Attempt the read and report its result instead of guessing from key type.
				accountClient?.getCredits() ?? Promise.reject(new Error("unavailable")),
				managementReady && this.deps.managementClient
					? this.deps.managementClient.getActivity()
					: Promise.resolve(null),
				managementReady && this.deps.managementClient
					? this.deps.managementClient.listKeys()
					: Promise.resolve(null),
			],
		);
		if (creditResult.status === "fulfilled") {
			credits = {
				available: true,
				reason: null,
				totalCredits: creditResult.value.totalCredits,
				totalUsage: creditResult.value.totalUsage,
				remainingCredits:
					creditResult.value.totalCredits - creditResult.value.totalUsage,
				error: null,
			};
		} else {
			credits = { ...credits, error: errorText(creditResult.reason) };
		}
		let managementError: string | null = null;
		if (managementReady) {
			if (
				activityResult.status === "fulfilled" &&
				activityResult.value !== null
			) {
				activity = {
					available: true,
					reason: null,
					...aggregateActivity(activityResult.value),
					error: null,
				};
			} else if (activityResult.status === "rejected") {
				managementError = errorText(activityResult.reason);
				activity = { ...activity, error: managementError };
			}
			if (keysResult.status === "fulfilled" && keysResult.value !== null) {
				accountUsage = keysResult.value.reduce(
					(total, item) => ({
						available: true,
						total: (total.total ?? 0) + item.usage,
						daily: (total.daily ?? 0) + item.usageDaily,
						weekly: (total.weekly ?? 0) + item.usageWeekly,
						monthly: (total.monthly ?? 0) + item.usageMonthly,
						keyCount: total.keyCount + 1,
						error: null,
					}),
					{
						available: true,
						total: 0,
						daily: 0,
						weekly: 0,
						monthly: 0,
						keyCount: 0,
						error: null,
					},
				);
			} else if (keysResult.status === "rejected") {
				const code = errorText(keysResult.reason);
				managementError ??= code;
				accountUsage = { ...accountUsage, error: code };
			}
		}

		const observedAt = Date.now();
		this.model = {
			credential: {
				ready,
				validatedAt:
					ready && !inferenceError
						? observedAt
						: this.model.credential.validatedAt,
				validationError: inferenceError,
			},
			managementCredential: {
				ready: managementReady,
				validatedAt:
					managementReady && !managementError
						? observedAt
						: this.model.managementCredential.validatedAt,
				validationError: managementError,
			},
			checkedAt,
			observedAt,
			fresh: !inferenceError && !managementError,
			error: inferenceError ?? managementError,
			key,
			credits,
			accountUsage,
			activity,
		};
		return this.readModel();
	}
}
