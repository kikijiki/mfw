import { MFW_RUNPOD_CPU_RUNTIME } from "@mfw/core/runpod";
import type { CredentialStore } from "./credentials.ts";
import { RUNPOD_OWNERSHIP_ENV } from "./runpod-ownership.ts";
import type { RunPodPlacementRequest } from "./runpod-policy.ts";

export const RUNPOD_REST_BASE_URL = "https://rest.runpod.io/v1";
export const RUNPOD_GRAPHQL_URL = "https://api.runpod.io/graphql";

/** Public, CPU-native base used by the capped live proof and as mfw's known
 * compatible CPU runner. The amd64 manifest is pinned so provider startup does
 * not silently change underneath a durable request. */
export const MFW_RUNPOD_CPU_IMAGE = MFW_RUNPOD_CPU_RUNTIME.image;

export interface RunPodCredentialSource {
	apiKey(): Promise<string | undefined>;
}

/** This is the only production bridge from the global credential file. */
export function runPodCredentialSource(
	store: CredentialStore,
): RunPodCredentialSource {
	return { apiKey: () => store.get("runpod") };
}

export interface RunPodMachine {
	gpuTypeId?: string;
	secureCloud?: boolean;
	[key: string]: unknown;
}

export interface RunPodGpu {
	id?: string;
	count?: number;
	[key: string]: unknown;
}

export interface RunPodPod {
	id: string;
	name: string;
	desiredStatus: string;
	image: string | null;
	costPerHr: number | null;
	adjustedCostPerHr: number | null;
	cpuFlavorId: string | null;
	vcpuCount: number | null;
	memoryInGb: number | null;
	env: Record<string, string>;
	gpu: RunPodGpu | null;
	machine: RunPodMachine | null;
	publicIp: string | null;
	portMappings: Record<string, number>;
	raw: Readonly<Record<string, unknown>>;
}

export interface RunPodCreateInput {
	name: string;
	request: RunPodPlacementRequest;
	/** Account-service generated ownership plus per-lease public SSH bootstrap only. */
	createEnv: Readonly<Record<string, string>>;
}

export interface RunPodAccountBalance {
	/** Provider-reported prepaid credits in US dollars. */
	remainingCredits: number;
}

export class RunPodApiError extends Error {
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
		this.name = "RunPodApiError";
	}
}

export interface RunPodClientOptions {
	credentials: RunPodCredentialSource;
	fetch?: typeof globalThis.fetch;
	baseUrl?: string;
	graphqlUrl?: string;
	timeoutMs?: number;
	maxResponseBytes?: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function finiteNumber(value: unknown): number | null {
	const n = typeof value === "string" && value.trim() ? Number(value) : value;
	return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function stringValue(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function normalizeEnv(value: unknown): Record<string, string> {
	const record = asRecord(value);
	if (record) {
		return Object.fromEntries(
			Object.entries(record).filter(
				(entry): entry is [string, string] => typeof entry[1] === "string",
			),
		);
	}
	if (!Array.isArray(value)) return {};
	const entries: Array<[string, string]> = [];
	for (const item of value) {
		const env = asRecord(item);
		if (typeof env?.key === "string" && typeof env.value === "string") {
			entries.push([env.key, env.value]);
		}
	}
	return Object.fromEntries(entries);
}

export function parseRunPodPod(value: unknown): RunPodPod {
	const raw = asRecord(value);
	if (!raw || typeof raw.id !== "string" || raw.id.trim().length === 0) {
		throw new RunPodApiError(
			"invalid_response",
			"RunPod returned a Pod without a valid id",
		);
	}
	const machine = asRecord(raw.machine);
	const gpu = asRecord(raw.gpu);
	const mappings = asRecord(raw.portMappings);
	return {
		id: raw.id,
		name: typeof raw.name === "string" ? raw.name : "",
		desiredStatus:
			typeof raw.desiredStatus === "string" ? raw.desiredStatus : "UNKNOWN",
		image: stringValue(raw.image) ?? stringValue(raw.imageName),
		costPerHr: finiteNumber(raw.costPerHr),
		adjustedCostPerHr: finiteNumber(raw.adjustedCostPerHr),
		cpuFlavorId: stringValue(raw.cpuFlavorId),
		vcpuCount: finiteNumber(raw.vcpuCount),
		memoryInGb: finiteNumber(raw.memoryInGb),
		env: normalizeEnv(raw.env),
		gpu: gpu as RunPodGpu | null,
		machine: machine as RunPodMachine | null,
		publicIp: stringValue(raw.publicIp),
		portMappings: Object.fromEntries(
			Object.entries(mappings ?? {}).flatMap(([key, value]) => {
				const port = finiteNumber(value);
				return port === null ? [] : [[key, port]];
			}),
		),
		raw: Object.freeze({ ...raw }),
	};
}

/** Accept the documented bare array and a defensive legacy `{pods: []}` wrapper. */
export function parseRunPodPodList(value: unknown): RunPodPod[] {
	const wrapped = asRecord(value);
	const values = Array.isArray(value)
		? value
		: Array.isArray(wrapped?.pods)
			? wrapped.pods
			: null;
	if (!values) {
		throw new RunPodApiError(
			"invalid_response",
			"RunPod Pod inventory was not an array",
		);
	}
	const pods = values.map(parseRunPodPod);
	if (new Set(pods.map((pod) => pod.id)).size !== pods.length) {
		throw new RunPodApiError(
			"invalid_response",
			"RunPod Pod inventory contained duplicate ids",
		);
	}
	return pods;
}

/** Parse the documented GraphQL `myself { clientBalance }` response. */
export function parseRunPodAccountBalance(
	value: unknown,
): RunPodAccountBalance {
	const envelope = asRecord(value);
	if (!envelope) {
		throw new RunPodApiError(
			"invalid_response",
			"RunPod account balance response was not an object",
		);
	}
	if (Array.isArray(envelope.errors) && envelope.errors.length > 0) {
		throw new RunPodApiError(
			"invalid_response",
			"RunPod account balance query returned GraphQL errors",
		);
	}
	const myself = asRecord(asRecord(envelope.data)?.myself);
	const clientBalance = myself?.clientBalance;
	if (typeof clientBalance !== "number" || !Number.isFinite(clientBalance)) {
		throw new RunPodApiError(
			"invalid_response",
			"RunPod account balance response had no finite clientBalance",
		);
	}
	return { remainingCredits: clientBalance };
}

async function boundedBody(
	response: Response,
	maximum: number,
): Promise<string> {
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > maximum) {
		throw new RunPodApiError(
			"response_too_large",
			"RunPod response exceeded the configured size limit",
			response.status,
		);
	}
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maximum) {
				await reader.cancel();
				throw new RunPodApiError(
					"response_too_large",
					"RunPod response exceeded the configured size limit",
					response.status,
				);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(body);
}

export class RunPodClient {
	private readonly fetcher: typeof globalThis.fetch;
	private readonly baseUrl: string;
	private readonly graphqlUrl: string;
	private readonly timeoutMs: number;
	private readonly maxResponseBytes: number;

	constructor(private readonly options: RunPodClientOptions) {
		this.fetcher = options.fetch ?? globalThis.fetch;
		this.baseUrl = (options.baseUrl ?? RUNPOD_REST_BASE_URL).replace(/\/$/, "");
		this.graphqlUrl = options.graphqlUrl ?? RUNPOD_GRAPHQL_URL;
		this.timeoutMs = options.timeoutMs ?? 20_000;
		this.maxResponseBytes = options.maxResponseBytes ?? 1024 * 1024;
	}

	async credentialReady(): Promise<boolean> {
		return Boolean((await this.options.credentials.apiKey())?.trim());
	}

	private async request(
		method: "GET" | "POST" | "DELETE",
		path: string,
		body?: Readonly<Record<string, unknown>>,
	): Promise<unknown> {
		return this.requestUrl(method, `${this.baseUrl}${path}`, body);
	}

	private async requestUrl(
		method: "GET" | "POST" | "DELETE",
		url: string,
		body?: Readonly<Record<string, unknown>>,
	): Promise<unknown> {
		const apiKey = (await this.options.credentials.apiKey())?.trim();
		if (!apiKey) {
			throw new RunPodApiError(
				"credential_missing",
				"RunPod credential is not configured",
			);
		}
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		let response: Response;
		let text: string;
		try {
			response = await this.fetcher(url, {
				method,
				headers: {
					Authorization: `Bearer ${apiKey}`,
					...(body ? { "Content-Type": "application/json" } : {}),
				},
				body: body ? JSON.stringify(body) : undefined,
				signal: controller.signal,
			});
			text = await boundedBody(response, this.maxResponseBytes);
		} catch (error) {
			if (error instanceof RunPodApiError) throw error;
			throw new RunPodApiError(
				controller.signal.aborted ? "timeout" : "network_error",
				controller.signal.aborted
					? "RunPod request timed out"
					: "RunPod request failed before a complete response was received",
			);
		} finally {
			clearTimeout(timer);
		}
		if (!response.ok) {
			// Provider bodies are intentionally excluded: they can echo request data.
			throw new RunPodApiError(
				"http_error",
				`RunPod request failed with HTTP ${response.status}`,
				response.status,
			);
		}
		if (!text.trim()) return null;
		try {
			return JSON.parse(text);
		} catch {
			throw new RunPodApiError(
				"invalid_json",
				"RunPod returned invalid JSON",
				response.status,
			);
		}
	}

	/** Cheap read-only query for RunPod's provider-reported prepaid credits. */
	async getAccountBalance(): Promise<RunPodAccountBalance> {
		return parseRunPodAccountBalance(
			await this.requestUrl("POST", this.graphqlUrl, {
				query: "query MfwAccountBalance { myself { clientBalance } }",
			}),
		);
	}

	/** Always requests the complete account inventory; no project/provider filter is accepted. */
	async listPods(): Promise<RunPodPod[]> {
		return parseRunPodPodList(
			await this.request("GET", "/pods?includeMachine=true"),
		);
	}

	async createPod(input: RunPodCreateInput): Promise<RunPodPod> {
		const request = input.request;
		const names = Object.keys(input.createEnv).sort();
		if (
			names.length !== 3 ||
			!names.includes(RUNPOD_OWNERSHIP_ENV) ||
			!names.includes("SSH_PUBLIC_KEY") ||
			!names.includes("PUBLIC_KEY") ||
			input.createEnv.PUBLIC_KEY !== input.createEnv.SSH_PUBLIC_KEY
		) {
			throw new RunPodApiError(
				"invalid_response",
				"RunPod create environment must contain only ownership and matching SSH_PUBLIC_KEY/PUBLIC_KEY",
			);
		}
		const common = {
			name: input.name,
			imageName: request.image,
			cloudType: request.cloud,
			computeType: request.computeType,
			containerDiskInGb: request.containerDiskInGb,
			volumeInGb: request.volumeInGb,
			interruptible: false,
			locked: false,
			// Full SSH is the production transport as well as the recovery path.
			ports: ["22/tcp"],
			supportPublicIp: true,
			env: { ...input.createEnv },
		};
		const body =
			request.computeType === "GPU"
				? {
						...common,
						gpuTypeIds: [request.gpuTypeId],
						gpuTypePriority: "custom",
						gpuCount: request.gpuCount,
						allowedCudaVersions: request.allowedCudaVersions,
						...(request.minVcpuPerGpu
							? { minVCPUPerGPU: request.minVcpuPerGpu }
							: {}),
						...(request.minRamPerGpu
							? { minRAMPerGPU: request.minRamPerGpu }
							: {}),
					}
				: {
						...common,
						cpuFlavorIds: [request.cpuFlavorId],
						cpuFlavorPriority: "custom",
						vcpuCount: request.vcpuCount,
					};
		return parseRunPodPod(await this.request("POST", "/pods", body));
	}

	async deletePod(podId: string): Promise<void> {
		if (!podId.trim()) {
			throw new RunPodApiError("invalid_response", "RunPod Pod id is empty");
		}
		try {
			await this.request("DELETE", `/pods/${encodeURIComponent(podId)}`);
		} catch (error) {
			if (error instanceof RunPodApiError && error.status === 404) return;
			throw error;
		}
	}
}
