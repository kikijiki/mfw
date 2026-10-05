import type { CredentialStore } from "./credentials.ts";

export const OPENROUTER_API_BASE_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_CREDENTIAL_ID = "openrouter";
export const OPENROUTER_MANAGEMENT_CREDENTIAL_ID = "openrouter-management";

export interface OpenRouterCredentialSource {
	apiKey(): Promise<string | undefined>;
}

export function openRouterCredentialSource(
	store: CredentialStore,
	credentialId = OPENROUTER_CREDENTIAL_ID,
): OpenRouterCredentialSource {
	return { apiKey: () => store.get(credentialId) };
}

export class OpenRouterApiError extends Error {
	constructor(
		readonly code:
			| "credential_missing"
			| "timeout"
			| "network_error"
			| "response_too_large"
			| "http_error"
			| "invalid_json"
			| "invalid_response",
		message: string,
		readonly status: number | null = null,
	) {
		super(message);
		this.name = "OpenRouterApiError";
	}
}

export interface OpenRouterKeyUsage {
	label: string | null;
	usage: number;
	usageDaily: number;
	usageWeekly: number;
	usageMonthly: number;
	byokUsage: number;
	byokUsageDaily: number;
	byokUsageWeekly: number;
	byokUsageMonthly: number;
	limit: number | null;
	limitRemaining: number | null;
	limitReset: string | null;
	includeByokInLimit: boolean;
	isFreeTier: boolean;
	isManagementKey: boolean;
	expiresAt: string | null;
}

export interface OpenRouterCredits {
	totalCredits: number;
	totalUsage: number;
}

export interface OpenRouterListedKeyUsage {
	usage: number;
	usageDaily: number;
	usageWeekly: number;
	usageMonthly: number;
}

export interface OpenRouterActivityRecord {
	date: string;
	model: string;
	providerName: string;
	requests: number;
	promptTokens: number;
	completionTokens: number;
	reasoningTokens: number;
	usage: number;
	byokUsageInference: number;
}

export interface OpenRouterClientPort {
	credentialReady(): Promise<boolean>;
	getCurrentKey(): Promise<OpenRouterKeyUsage>;
	getCredits(): Promise<OpenRouterCredits>;
	getActivity(): Promise<OpenRouterActivityRecord[]>;
	listKeys(): Promise<OpenRouterListedKeyUsage[]>;
}

export interface OpenRouterClientOptions {
	credentials: OpenRouterCredentialSource;
	fetch?: typeof globalThis.fetch;
	baseUrl?: string;
	timeoutMs?: number;
	maxResponseBytes?: number;
}

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function finiteNonNegative(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new OpenRouterApiError(
			"invalid_response",
			`OpenRouter returned an invalid ${field}`,
		);
	}
	return value;
}

function optionalFiniteNonNegative(
	value: unknown,
	field: string,
): number | null {
	return value === null || value === undefined
		? null
		: finiteNonNegative(value, field);
}

function boolean(value: unknown, field: string): boolean {
	if (typeof value !== "boolean") {
		throw new OpenRouterApiError(
			"invalid_response",
			`OpenRouter returned an invalid ${field}`,
		);
	}
	return value;
}

function optionalString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0 || value.length > 500) {
		throw new OpenRouterApiError(
			"invalid_response",
			`OpenRouter returned an invalid ${field}`,
		);
	}
	return value;
}

function responseData(value: unknown): Record<string, unknown> {
	const data = record(record(value)?.data);
	if (!data) {
		throw new OpenRouterApiError(
			"invalid_response",
			"OpenRouter returned a response without account data",
		);
	}
	return data;
}

export function parseOpenRouterKeyUsage(value: unknown): OpenRouterKeyUsage {
	const data = responseData(value);
	return {
		label: optionalString(data.label),
		usage: finiteNonNegative(data.usage, "key usage"),
		usageDaily: finiteNonNegative(data.usage_daily, "daily key usage"),
		usageWeekly: finiteNonNegative(data.usage_weekly, "weekly key usage"),
		usageMonthly: finiteNonNegative(data.usage_monthly, "monthly key usage"),
		byokUsage: finiteNonNegative(data.byok_usage, "BYOK usage"),
		byokUsageDaily: finiteNonNegative(
			data.byok_usage_daily,
			"daily BYOK usage",
		),
		byokUsageWeekly: finiteNonNegative(
			data.byok_usage_weekly,
			"weekly BYOK usage",
		),
		byokUsageMonthly: finiteNonNegative(
			data.byok_usage_monthly,
			"monthly BYOK usage",
		),
		limit: optionalFiniteNonNegative(data.limit, "key limit"),
		limitRemaining: optionalFiniteNonNegative(
			data.limit_remaining,
			"remaining key limit",
		),
		limitReset: optionalString(data.limit_reset),
		includeByokInLimit: boolean(
			data.include_byok_in_limit,
			"BYOK limit setting",
		),
		isFreeTier: boolean(data.is_free_tier, "free-tier setting"),
		isManagementKey: boolean(data.is_management_key, "management-key setting"),
		expiresAt: optionalString(data.expires_at),
	};
}

export function parseOpenRouterCredits(value: unknown): OpenRouterCredits {
	const data = responseData(value);
	return {
		totalCredits: finiteNonNegative(data.total_credits, "total credits"),
		totalUsage: finiteNonNegative(data.total_usage, "total account usage"),
	};
}

export function parseOpenRouterActivity(
	value: unknown,
): OpenRouterActivityRecord[] {
	const data = record(value)?.data;
	if (!Array.isArray(data) || data.length > 10_000) {
		throw new OpenRouterApiError(
			"invalid_response",
			"OpenRouter returned invalid or excessive activity data",
		);
	}
	return data.map((item) => {
		const row = record(item);
		if (!row) {
			throw new OpenRouterApiError(
				"invalid_response",
				"OpenRouter returned an invalid activity row",
			);
		}
		return {
			date: requiredString(row.date, "activity date"),
			model: requiredString(row.model, "activity model"),
			providerName: requiredString(row.provider_name, "activity provider"),
			requests: finiteNonNegative(row.requests, "request count"),
			promptTokens: finiteNonNegative(row.prompt_tokens, "prompt token count"),
			completionTokens: finiteNonNegative(
				row.completion_tokens,
				"completion token count",
			),
			reasoningTokens: finiteNonNegative(
				row.reasoning_tokens,
				"reasoning token count",
			),
			usage: finiteNonNegative(row.usage, "activity usage"),
			byokUsageInference: finiteNonNegative(
				row.byok_usage_inference,
				"activity BYOK usage",
			),
		};
	});
}

export function parseOpenRouterListedKeys(
	value: unknown,
): OpenRouterListedKeyUsage[] {
	const data = record(value)?.data;
	if (!Array.isArray(data) || data.length > 10_000) {
		throw new OpenRouterApiError(
			"invalid_response",
			"OpenRouter returned invalid or excessive API key data",
		);
	}
	return data.map((item) => {
		const row = record(item);
		if (!row) {
			throw new OpenRouterApiError(
				"invalid_response",
				"OpenRouter returned an invalid API key row",
			);
		}
		return {
			usage: finiteNonNegative(row.usage, "API key usage"),
			usageDaily: finiteNonNegative(row.usage_daily, "daily API key usage"),
			usageWeekly: finiteNonNegative(row.usage_weekly, "weekly API key usage"),
			usageMonthly: finiteNonNegative(
				row.usage_monthly,
				"monthly API key usage",
			),
		};
	});
}

export class OpenRouterClient implements OpenRouterClientPort {
	private readonly fetchImpl: typeof globalThis.fetch;
	private readonly baseUrl: string;
	private readonly timeoutMs: number;
	private readonly maxResponseBytes: number;

	constructor(private readonly options: OpenRouterClientOptions) {
		this.fetchImpl = options.fetch ?? globalThis.fetch;
		this.baseUrl = (options.baseUrl ?? OPENROUTER_API_BASE_URL).replace(
			/\/$/,
			"",
		);
		this.timeoutMs = options.timeoutMs ?? 10_000;
		this.maxResponseBytes = options.maxResponseBytes ?? 1_000_000;
	}

	async credentialReady(): Promise<boolean> {
		return Boolean(await this.options.credentials.apiKey());
	}

	async getCurrentKey(): Promise<OpenRouterKeyUsage> {
		return parseOpenRouterKeyUsage(await this.request("/key"));
	}

	async getCredits(): Promise<OpenRouterCredits> {
		return parseOpenRouterCredits(await this.request("/credits"));
	}

	async getActivity(): Promise<OpenRouterActivityRecord[]> {
		return parseOpenRouterActivity(await this.request("/activity"));
	}

	async listKeys(): Promise<OpenRouterListedKeyUsage[]> {
		const keys: OpenRouterListedKeyUsage[] = [];
		for (let offset = 0; offset < 10_000; offset += 100) {
			const page = parseOpenRouterListedKeys(
				await this.request(`/keys?include_disabled=true&offset=${offset}`),
			);
			keys.push(...page);
			if (page.length < 100) return keys;
		}
		throw new OpenRouterApiError(
			"response_too_large",
			"OpenRouter returned more API keys than MFW accepts",
		);
	}

	private async request(path: string): Promise<unknown> {
		const apiKey = await this.options.credentials.apiKey();
		if (!apiKey) {
			throw new OpenRouterApiError(
				"credential_missing",
				"OpenRouter API key is not configured",
			);
		}
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
		let response: Response;
		try {
			response = await this.fetchImpl(`${this.baseUrl}${path}`, {
				headers: { Authorization: `Bearer ${apiKey}` },
				signal: controller.signal,
			});
		} catch (error) {
			throw new OpenRouterApiError(
				error instanceof Error && error.name === "AbortError"
					? "timeout"
					: "network_error",
				error instanceof Error && error.name === "AbortError"
					? "OpenRouter did not respond before the timeout"
					: "OpenRouter could not be reached",
			);
		} finally {
			clearTimeout(timeout);
		}
		if (!response.ok) {
			throw new OpenRouterApiError(
				"http_error",
				response.status === 401 || response.status === 403
					? "OpenRouter rejected this API key"
					: `OpenRouter returned HTTP ${response.status}`,
				response.status,
			);
		}
		const declared = Number(response.headers.get("content-length"));
		if (Number.isFinite(declared) && declared > this.maxResponseBytes) {
			throw new OpenRouterApiError(
				"response_too_large",
				"OpenRouter returned more account data than MFW accepts",
			);
		}
		const text = await response.text();
		if (new TextEncoder().encode(text).byteLength > this.maxResponseBytes) {
			throw new OpenRouterApiError(
				"response_too_large",
				"OpenRouter returned more account data than MFW accepts",
			);
		}
		try {
			return JSON.parse(text);
		} catch {
			throw new OpenRouterApiError(
				"invalid_json",
				"OpenRouter returned malformed account data",
			);
		}
	}
}
