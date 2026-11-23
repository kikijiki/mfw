/**
 * Pure ACP (Agent Client Protocol) -> mfw translation helpers. No I/O: the
 * bridge process owns the transport, these functions own the mapping so it can
 * be unit-tested without an agent.
 */
import type {
	ClientCapabilities,
	InitializeRequest,
	PermissionOption,
	PromptResponse,
	RequestPermissionRequest,
	RequestPermissionResponse,
	SessionConfigOption,
	SessionUpdate,
	StopReason,
	ToolCallContent,
	ToolCallLocation,
	ToolKind,
} from "@agentclientprotocol/sdk";
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type { HarnessManifestInput } from "@mfw/plugin-api/harness";
// A relative path: Bun.build inside the test runner fails on a second bundle
// that reaches this file through the workspace package name.
import { BUILTIN_HARNESS_MANIFESTS } from "../../../plugin-api/src/harness-builtins.ts";
import {
	type BinaryIdentity,
	harnessBinaryIdentity,
} from "./agent-identity.ts";
import {
	type ApprovalDecision,
	capText,
	isRecord,
	sanitize,
} from "./app-server-protocol.ts";

/** An AgentEvent payload before the driver stamps `ts` and `seq`. */
export type EventPayload = Record<string, unknown>;

export type AcpProfile = {
	/** Reported as the canonical `provider` and on `session` events. */
	id: string;
	/** Human name used in user-facing messages. */
	label: string;
	/** Extra `_meta` on the advertised client capabilities. */
	capabilityMeta?: Record<string, unknown>;
	/** The adapter also passes the model on the agent's argv (`--model`). */
	modelOnArgv?: boolean;
	/** Session mode id that restricts the agent to reading (`plan`). */
	readOnlyMode?: string;
	/**
	 * True when the agent has a layer-1 way to restrict its own tools, so it may
	 * run under the `read-only` and `none` policies.
	 */
	brainEligible: boolean;
	/**
	 * Titles of `other`-kind tools that only read (pi's `grep`, `find`, `ls`
	 * arrive as `other`); the read-only table allows them.
	 */
	readOnlyOtherTitles?: ReadonlyArray<string>;
	/**
	 * `bin` is a generic name that must be confirmed to be this agent before it
	 * is launched (see agent-identity.ts).
	 */
	identity?: { bin: string; identity: BinaryIdentity };
};

function acpProfile(m: HarnessManifestInput): AcpProfile {
	const acp = m.acp as NonNullable<HarnessManifestInput["acp"]>;
	const identity = harnessBinaryIdentity(m.id);
	return {
		id: m.id,
		label: acp.label,
		...(acp.capabilityMeta ? { capabilityMeta: acp.capabilityMeta } : {}),
		...(acp.modelOnArgv ? { modelOnArgv: true } : {}),
		...(acp.readOnlyMode ? { readOnlyMode: acp.readOnlyMode } : {}),
		brainEligible: acp.brainEligible,
		...(acp.readOnlyOtherTitles
			? { readOnlyOtherTitles: acp.readOnlyOtherTitles }
			: {}),
		...(identity ? { identity: { bin: m.detect.bin, identity } } : {}),
	};
}

/** Read without the validator: the bridge bundles this file. */
const PROFILES: ReadonlyMap<string, AcpProfile> = new Map(
	BUILTIN_HARNESS_MANIFESTS.filter((m) => m.dialect === "acp").map((m) => [
		m.id,
		acpProfile(m),
	]),
);

export function profileFor(name: string | undefined): AcpProfile {
	return (
		(name && PROFILES.get(name)) || {
			id: "acp",
			label: "ACP agent",
			brainEligible: false,
		}
	);
}

/** The agent works in its own cwd with its own tools, so no fs or terminal. */
export function buildInitializeRequest(
	profile: AcpProfile,
	clientVersion = "0.1.0",
): InitializeRequest {
	const clientCapabilities: ClientCapabilities = {};
	if (profile.capabilityMeta)
		clientCapabilities._meta = { ...profile.capabilityMeta };
	return {
		protocolVersion: PROTOCOL_VERSION,
		clientCapabilities,
		clientInfo: { name: "mfw", version: clientVersion },
	};
}

export const CAPABILITIES = {
	steer: false,
	interrupt: true,
	approvals: true,
	plan: true,
	fileChanges: true,
	commandProgress: true,
	mcp: false,
} as const;

export type CanonicalStatus = "completed" | "interrupted" | "failed";

/** Map a stop reason to a turn status; the notice names non-clean endings. */
export function stopReasonStatus(stop: StopReason): {
	status: CanonicalStatus;
	notice?: string;
} {
	if (stop === "cancelled") return { status: "interrupted" };
	if (stop === "end_turn") return { status: "completed" };
	return {
		status: "completed",
		notice: `The agent stopped the turn early (stop reason: ${stop})`,
	};
}

// ---------------------------------------------------------------------------
// Errors

export type ErrorInfo = { code?: number; message: string };

/** The human-readable part of a JSON-RPC error's `data`, when it has one. */
function dataDetail(data: unknown): string {
	if (typeof data === "string") return data;
	if (isRecord(data))
		for (const key of ["details", "message", "error"])
			if (typeof data[key] === "string") return data[key];
	return "";
}

/** Normalise a thrown value or a JSON-RPC error object. */
export function errorInfo(error: unknown): ErrorInfo {
	const record: Record<string, unknown> | undefined =
		error instanceof Error
			? (error as unknown as Record<string, unknown>)
			: isRecord(error)
				? error
				: undefined;
	if (!record) return { message: String(error) };
	const base =
		typeof record.message === "string"
			? record.message
			: JSON.stringify(sanitize(record));
	// Agents often hide the real reason in `data` behind "Internal error".
	const detail = dataDetail(record.data);
	return {
		code: typeof record.code === "number" ? record.code : undefined,
		message: detail && !base.includes(detail) ? `${base}: ${detail}` : base,
	};
}

/** ACP `auth_required` is JSON-RPC -32000; some agents only say so in prose. */
export function isAuthRequired(error: unknown): boolean {
	const { code, message } = errorInfo(error);
	return (
		code === -32000 ||
		/auth(entication|orization)?[\s_-]*(is\s+)?required|not authenticated|please (log|sign) ?in/i.test(
			message,
		)
	);
}

export function authFailureMessage(
	profile: AcpProfile,
	authMethods: ReadonlyArray<{ name?: unknown }> | null | undefined,
): string {
	const names = (authMethods ?? [])
		.map((m) => (typeof m.name === "string" ? m.name : ""))
		.filter(Boolean);
	return `${profile.label} needs authentication: sign in through the agent's own CLI${
		names.length ? ` (${names.join(", ")})` : ""
	}`;
}

// ---------------------------------------------------------------------------
// Config options (model / reasoning)

export type SelectValue = { value: string; name: string };

/** The first select option of a category (groups are flattened). */
export function findSelectOption(
	options: ReadonlyArray<SessionConfigOption> | null | undefined,
	category: string,
): { id: string; values: SelectValue[] } | undefined {
	for (const option of options ?? []) {
		if (option.category !== category || option.type !== "select") continue;
		const values: SelectValue[] = [];
		for (const entry of option.options as ReadonlyArray<unknown>) {
			if (!isRecord(entry)) continue;
			const nested = Array.isArray(entry.options) ? entry.options : [entry];
			for (const leaf of nested) {
				if (isRecord(leaf) && typeof leaf.value === "string")
					values.push({
						value: leaf.value,
						name: typeof leaf.name === "string" ? leaf.name : leaf.value,
					});
			}
		}
		return { id: option.id, values };
	}
	return undefined;
}

/** True when the canonical model string asks for a specific model. */
export function wantsModel(model: unknown): model is string {
	return typeof model === "string" && model !== "" && model !== "default";
}

/** Exact value first, then case-insensitive; undefined means not offered. */
export function pickModelValue(
	values: ReadonlyArray<SelectValue>,
	model: string,
): string | undefined {
	return (
		values.find((v) => v.value === model)?.value ??
		values.find((v) => v.value.toLowerCase() === model.toLowerCase())?.value
	);
}

export function modelNotOfferedMessage(
	profile: AcpProfile,
	model: string,
	values: ReadonlyArray<SelectValue>,
): string {
	const sample = values
		.slice(0, 8)
		.map((v) => v.value)
		.join(", ");
	return `${profile.label} does not offer model "${model}"${
		sample ? ` (offered: ${sample}${values.length > 8 ? ", …" : ""})` : ""
	}`;
}

/**
 * Value of a thought_level option matching the effort, by value or name.
 * Effort `none` also matches `off` (pi's name for no thinking).
 */
export function pickThoughtValue(
	values: ReadonlyArray<SelectValue>,
	effort: string,
): string | undefined {
	const want = effort.toLowerCase();
	const wanted = want === "none" ? [want, "off"] : [want];
	return values.find(
		(v) =>
			wanted.includes(v.value.toLowerCase()) ||
			wanted.includes(v.name.toLowerCase()),
	)?.value;
}

// ---------------------------------------------------------------------------
// Permissions

export type ApprovalKind = "command" | "file_change" | "other";

export function approvalKind(kind: ToolKind | null | undefined): ApprovalKind {
	if (kind === "execute") return "command";
	if (kind === "edit" || kind === "delete" || kind === "move")
		return "file_change";
	return "other";
}

export function permissionTitle(request: RequestPermissionRequest): string {
	const call = request.toolCall;
	return call.title || call.kind || "Permission requested";
}

export function permissionDetails(request: RequestPermissionRequest): unknown {
	const call = request.toolCall;
	return sanitize({
		toolCallId: call.toolCallId,
		kind: call.kind,
		title: call.title,
		locations: call.locations,
		rawInput: call.rawInput,
		options: request.options.map((o) => ({ name: o.name, kind: o.kind })),
	});
}

function selected(option: PermissionOption): RequestPermissionResponse {
	return { outcome: { outcome: "selected", optionId: option.optionId } };
}
const CANCELLED: RequestPermissionResponse = {
	outcome: { outcome: "cancelled" },
};

function firstOf(
	options: ReadonlyArray<PermissionOption>,
	...kinds: PermissionOption["kind"][]
): PermissionOption | undefined {
	for (const kind of kinds) {
		const found = options.find((o) => o.kind === kind);
		if (found) return found;
	}
	return undefined;
}

/** Autonomous mode: allow once (nothing persists in the agent), else reject. */
export function autoApprove(options: ReadonlyArray<PermissionOption>): {
	response: RequestPermissionResponse;
	accepted: boolean;
} {
	const allow = firstOf(options, "allow_once", "allow_always");
	if (allow) return { response: selected(allow), accepted: true };
	const reject = firstOf(options, "reject_once", "reject_always");
	return {
		response: reject ? selected(reject) : CANCELLED,
		accepted: false,
	};
}

/** Interactive mode: map the operator's canonical decision to an option. */
export function decisionOutcome(
	decision: ApprovalDecision | string,
	options: ReadonlyArray<PermissionOption>,
): {
	response: RequestPermissionResponse;
	status: "accepted" | "declined" | "cancelled";
} {
	let option: PermissionOption | undefined;
	if (decision === "accept") option = firstOf(options, "allow_once");
	else if (decision === "acceptForSession")
		option = firstOf(options, "allow_always", "allow_once");
	else if (decision === "decline")
		option = firstOf(options, "reject_once", "reject_always");
	else return { response: CANCELLED, status: "cancelled" };
	if (!option) return { response: CANCELLED, status: "cancelled" };
	return {
		response: selected(option),
		status: option.kind.startsWith("allow") ? "accepted" : "declined",
	};
}

export const CANCELLED_PERMISSION = CANCELLED;

// ---------------------------------------------------------------------------
// Tool policy (read-only / none)

export type AcpPolicy = "full" | "read-only" | "none";

export function parsePolicy(value: string | undefined): AcpPolicy {
	return value === "read-only" || value === "none" ? value : "full";
}

/** True when the bridge itself decides every permission request. */
export function isRestricted(policy: AcpPolicy): boolean {
	return policy !== "full";
}

type ToolIdentity = {
	kind?: string | null;
	title?: string | null;
	rawInput?: unknown;
};

/**
 * Does the tool belong to one of the MCP servers? opencode titles MCP calls
 * `<server>_<tool>`, Claude-style hosts `mcp__<server>__<tool>`, and Cursor
 * puts the server in `rawInput.providerIdentifier`.
 */
export function isMcpServerTool(
	call: ToolIdentity,
	servers: ReadonlyArray<string>,
): boolean {
	const title = call.title ?? "";
	const provider = isRecord(call.rawInput)
		? call.rawInput.providerIdentifier
		: undefined;
	return servers.some(
		(server) =>
			server !== "" &&
			(title.startsWith(`${server}_`) ||
				title.startsWith(`mcp__${server}__`) ||
				provider === server),
	);
}

const READ_ONLY_KINDS = new Set(["read", "search", "think"]);

/** The read-only/none tool table. Anything unknown is denied. */
export function classifyTool(
	policy: AcpPolicy,
	call: ToolIdentity,
	mcpServers: ReadonlyArray<string>,
	otherTitles: ReadonlyArray<string> = [],
): { allowed: boolean; reason: string } {
	const kind = call.kind ?? "unknown";
	if (policy === "full") return { allowed: true, reason: "policy full" };
	if (policy === "none")
		return { allowed: false, reason: "no tools are allowed" };
	if (READ_ONLY_KINDS.has(kind))
		return { allowed: true, reason: `${kind} is read-only` };
	if (kind === "other" && isMcpServerTool(call, mcpServers))
		return { allowed: true, reason: "brain MCP tool" };
	if (kind === "other" && otherTitles.includes(call.title ?? ""))
		return { allowed: true, reason: `${call.title} is read-only` };
	return { allowed: false, reason: `${kind} is not read-only` };
}

/**
 * The bridge's own permission answer under read-only/none. Allow selects
 * allow_once (else allow_always); deny selects reject_once, else
 * reject_always, else cancelled.
 */
export function policyDecision(
	policy: AcpPolicy,
	request: RequestPermissionRequest,
	mcpServers: ReadonlyArray<string>,
	otherTitles: ReadonlyArray<string> = [],
): { response: RequestPermissionResponse; accepted: boolean; summary: string } {
	const title = permissionTitle(request);
	const verdict = classifyTool(
		policy,
		request.toolCall,
		mcpServers,
		otherTitles,
	);
	if (verdict.allowed) {
		const allow = firstOf(request.options, "allow_once", "allow_always");
		if (allow)
			return {
				response: selected(allow),
				accepted: true,
				summary: `Read-only policy: allowed: ${title}`,
			};
	}
	const reject = firstOf(request.options, "reject_once", "reject_always");
	return {
		response: reject ? selected(reject) : CANCELLED,
		accepted: false,
		summary: `Read-only policy: denied: ${title}`,
	};
}

/**
 * Tracks tool calls across updates (kind, title and input merge) to find one
 * the policy denies that nevertheless completed without the bridge granting
 * it. Only `completed` counts: opencode moves a denied call to `in_progress`
 * before the permission outcome and then to `failed`.
 */
export class PolicyTracker {
	private calls = new Map<string, ToolIdentity>();
	private granted = new Set<string>();

	constructor(
		private readonly policy: AcpPolicy,
		private readonly mcpServers: ReadonlyArray<string>,
		private readonly otherTitles: ReadonlyArray<string> = [],
	) {}

	reset(): void {
		this.calls.clear();
		this.granted.clear();
	}

	grant(toolCallId: string): void {
		this.granted.add(toolCallId);
	}

	/** Returns the violation message when this update completes a denied call. */
	observe(update: SessionUpdate): string | undefined {
		if (
			!isRestricted(this.policy) ||
			(update.sessionUpdate !== "tool_call" &&
				update.sessionUpdate !== "tool_call_update")
		)
			return undefined;
		const id = update.toolCallId;
		if (update.sessionUpdate === "tool_call") {
			this.calls.delete(id);
			this.granted.delete(id);
		}
		const call = this.calls.get(id) ?? {};
		this.calls.set(id, call);
		if (update.kind) call.kind = update.kind;
		if (update.title) call.title = update.title;
		if (update.rawInput !== undefined && update.rawInput !== null)
			call.rawInput = update.rawInput;
		if (update.status !== "completed" || this.granted.has(id)) return undefined;
		// A violation is a mutating tool that ran. Under `none` every request is
		// denied, but a read the agent ran on its own is not a violation.
		const table = this.policy === "none" ? "read-only" : this.policy;
		if (classifyTool(table, call, this.mcpServers, this.otherTitles).allowed)
			return undefined;
		return `read-only policy violated: ${call.kind ?? "unknown"} tool '${call.title ?? id}' ran without permission`;
	}
}

// ---------------------------------------------------------------------------
// MCP servers, agent-side config (layer 1) and routing endpoints

export type AcpMcpServer = {
	name: string;
	command: string;
	args: string[];
	env: Array<{ name: string; value: string }>;
};

/**
 * Parse the turn's `mcp.json` into ACP stdio entries. Errors never echo env
 * values.
 */
export function parseMcpConfig(text: string): AcpMcpServer[] {
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		throw new Error("not valid JSON");
	}
	const servers = isRecord(data) ? data.mcpServers : undefined;
	if (!isRecord(servers)) throw new Error("no mcpServers object");
	return Object.entries(servers).map(([name, raw]) => {
		if (!isRecord(raw) || typeof raw.command !== "string" || !raw.command)
			throw new Error(`server '${name}' has no command`);
		const args = Array.isArray(raw.args) ? raw.args : [];
		if (!args.every((a) => typeof a === "string"))
			throw new Error(`server '${name}' has non-string args`);
		const env = isRecord(raw.env) ? raw.env : {};
		return {
			name,
			command: raw.command,
			args: args as string[],
			env: Object.entries(env).map(([k, v]) => ({ name: k, value: String(v) })),
		};
	});
}

/** Deep-merge plain objects; `over` wins, arrays and scalars are replaced. */
export function deepMerge(
	base: Record<string, unknown>,
	over: Record<string, unknown>,
): Record<string, unknown> {
	const out: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(over)) {
		const existing = out[key];
		out[key] =
			isRecord(existing) && isRecord(value)
				? deepMerge(existing, value)
				: value;
	}
	return out;
}

export type AcpEndpoint = { id: string; baseUrl: string; envKey?: string };

export function parseEndpoint(text: string | undefined): AcpEndpoint | null {
	if (!text) return null;
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		throw new Error("MFW_ACP_ENDPOINT is not valid JSON");
	}
	if (
		!isRecord(data) ||
		typeof data.id !== "string" ||
		!data.id ||
		typeof data.baseUrl !== "string" ||
		!data.baseUrl
	)
		throw new Error("MFW_ACP_ENDPOINT needs an id and a baseUrl");
	return {
		id: data.id,
		baseUrl: data.baseUrl,
		envKey:
			typeof data.envKey === "string" && data.envKey ? data.envKey : undefined,
	};
}

export function endpointRefusedMessage(
	profile: AcpProfile,
	endpoint: AcpEndpoint,
): string {
	return `${profile.label} cannot use OpenAI-compatible endpoint '${endpoint.id}': it has no provider configuration over ACP`;
}

/**
 * The opencode `OPENCODE_CONFIG_CONTENT` value: the inherited value with our
 * read-only permissions and/or endpoint provider merged over it.
 */
export function opencodeConfigContent(
	inherited: string | undefined,
	opts: {
		restricted: boolean;
		endpoint?: AcpEndpoint | null;
		model?: string;
	},
): string | undefined {
	if (!opts.restricted && !opts.endpoint) return undefined;
	let base: Record<string, unknown> = {};
	if (inherited?.trim()) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(inherited);
		} catch {
			throw new Error("inherited OPENCODE_CONFIG_CONTENT is not valid JSON");
		}
		if (!isRecord(parsed))
			throw new Error("inherited OPENCODE_CONFIG_CONTENT is not an object");
		base = parsed;
	}
	let ours: Record<string, unknown> = {};
	// Verified on opencode 1.19.5: a denied permission removes the tool.
	// Web search is outbound like webfetch; the brain contract has neither.
	if (opts.restricted)
		ours = {
			permission: {
				edit: "deny",
				bash: "deny",
				webfetch: "deny",
				task: "deny",
				external_directory: "deny",
				websearch: "deny",
				codesearch: "deny",
			},
		};
	const endpoint = opts.endpoint;
	if (endpoint) {
		if (!opts.model)
			throw new Error(
				`endpoint '${endpoint.id}' needs a model (MFW_ACP_MODEL) to configure OpenCode`,
			);
		ours = deepMerge(ours, {
			provider: {
				[`mfw-${endpoint.id}`]: {
					npm: "@ai-sdk/openai-compatible",
					name: `mfw ${endpoint.id}`,
					options: {
						baseURL: endpoint.baseUrl,
						...(endpoint.envKey ? { apiKey: `{env:${endpoint.envKey}}` } : {}),
					},
					models: { [opts.model]: {} },
				},
			},
		});
	}
	return JSON.stringify(deepMerge(base, ours));
}

export const CURSOR_CLI_DENY = ["Shell(*)", "Write(**)", "WebFetch(*)"];

function union(a: unknown, b: string[]): string[] {
	const out = Array.isArray(a)
		? a.filter((x): x is string => typeof x === "string")
		: [];
	for (const item of b) if (!out.includes(item)) out.push(item);
	return out;
}

function parseExistingJson(text: string | undefined): Record<string, unknown> {
	if (!text?.trim()) return {};
	const parsed: unknown = JSON.parse(text);
	if (!isRecord(parsed)) throw new Error("not a JSON object");
	return parsed;
}

/** `.cursor/mcp.json`: existing user entries kept, ours win on a name clash. */
export function mergeCursorMcp(
	existing: string | undefined,
	servers: ReadonlyArray<AcpMcpServer>,
): string {
	const base = parseExistingJson(existing);
	const entries = isRecord(base.mcpServers) ? { ...base.mcpServers } : {};
	for (const s of servers)
		entries[s.name] = {
			command: s.command,
			args: s.args,
			env: Object.fromEntries(s.env.map((e) => [e.name, e.value])),
		};
	return `${JSON.stringify({ ...base, mcpServers: entries }, null, 2)}\n`;
}

/**
 * `.cursor/cli.json` permissions: Read plus the brain's MCP servers allowed
 * (no MCP under `none`), shell, write and web denied; deny wins in Cursor.
 */
export function mergeCursorCli(
	existing: string | undefined,
	policy: AcpPolicy,
	serverNames: ReadonlyArray<string>,
): string {
	const base = parseExistingJson(existing);
	const permissions = isRecord(base.permissions) ? base.permissions : {};
	const allow = [
		"Read(**)",
		...(policy === "none" ? [] : serverNames.map((n) => `Mcp(${n}:*)`)),
	];
	return `${JSON.stringify(
		{
			...base,
			permissions: {
				...permissions,
				allow: union(permissions.allow, allow),
				deny: union(permissions.deny, CURSOR_CLI_DENY),
			},
		},
		null,
		2,
	)}\n`;
}

/** Single-quote an argument for POSIX sh. */
export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * pi's own flags per policy (pi-acp passes none through, so a wrapper adds
 * them). `none` is pi with no tools at all; `read-only` keeps the read tools
 * plus the brain's MCP servers (exposed as `mcp__<server>__<tool>`).
 */
export function piPolicyFlags(
	policy: AcpPolicy,
	mcpServers: ReadonlyArray<string>,
): string[] {
	if (policy === "none")
		return ["--no-approve", "--no-extensions", "--no-tools", "--no-mcp"];
	if (policy === "full") return [];
	const tools = [
		"read",
		"grep",
		"find",
		"ls",
		...mcpServers.map((name) => `mcp__${name}__*`),
	];
	return [
		"--approve",
		"--no-extensions",
		"-e",
		"builtin:mcp",
		"--tools",
		tools.join(","),
	];
}

/** The wrapper script pi-acp runs in place of `pi` (`PI_ACP_PI_COMMAND`). */
export function piWrapperScript(
	realPi: string,
	flags: ReadonlyArray<string>,
): string {
	return `#!/bin/sh\nexec ${[realPi, ...flags].map(shellQuote).join(" ")} "$@"\n`;
}

/** `.pi/mcp.json`: existing entries kept, ours win; tools exposed directly. */
export function mergePiMcp(
	existing: string | undefined,
	servers: ReadonlyArray<AcpMcpServer>,
): string {
	const base = parseExistingJson(existing);
	const entries = isRecord(base.mcpServers) ? { ...base.mcpServers } : {};
	for (const s of servers)
		entries[s.name] = {
			command: s.command,
			args: s.args,
			env: Object.fromEntries(s.env.map((e) => [e.name, e.value])),
			exposure: "direct",
		};
	return `${JSON.stringify({ ...base, mcpServers: entries }, null, 2)}\n`;
}

/**
 * A pi extension registering the endpoint as provider `mfw-<id>`. pi reads the
 * key from the environment variable (`$NAME`); its value is never written.
 */
export function piEndpointExtension(
	endpoint: AcpEndpoint,
	model: string,
): string {
	const provider = {
		name: `mfw ${endpoint.id}`,
		baseUrl: endpoint.baseUrl,
		api: "openai-completions",
		...(endpoint.envKey ? { apiKey: `$${endpoint.envKey}` } : {}),
		models: [
			{
				id: model,
				name: model,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 8192,
			},
		],
	};
	const id = JSON.stringify(`mfw-${endpoint.id}`);
	return `export default function (pi) {\n\tpi.registerProvider(${id}, ${JSON.stringify(provider)});\n}\n`;
}

export type ModeSelection =
	| { via: "mode"; modeId: string }
	| { via: "option"; configId: string; value: string };

/**
 * How to put the session into the profile's read-only mode: the `modes`
 * surface first, then a `mode` config option; undefined when neither offers it.
 */
export function selectReadOnlyMode(
	modes: { availableModes: ReadonlyArray<{ id: string }> } | null | undefined,
	options: ReadonlyArray<SessionConfigOption> | null | undefined,
	wanted: string,
): ModeSelection | undefined {
	if (modes?.availableModes.some((m) => m.id === wanted))
		return { via: "mode", modeId: wanted };
	const option = findSelectOption(options, "mode");
	if (option?.values.some((v) => v.value === wanted))
		return { via: "option", configId: option.id, value: wanted };
	return undefined;
}

export function resumeFailureMessage(
	sessionId: string,
	detail: string,
): string {
	return `session ${sessionId} not found or could not be resumed: ${detail}`;
}

// ---------------------------------------------------------------------------
// session/update -> events

const TEXT_CAP = 64 * 1024;
const OUTPUT_CAP = 16 * 1024;

function blockText(block: unknown): string {
	return isRecord(block) &&
		block.type === "text" &&
		typeof block.text === "string"
		? block.text
		: "";
}

/** Joined text of a tool call's `content` blocks. */
function contentText(
	content: ReadonlyArray<ToolCallContent> | null | undefined,
) {
	const parts: string[] = [];
	for (const item of content ?? []) {
		if (item.type === "content") {
			const text = blockText(item.content);
			if (text) parts.push(text);
		}
	}
	return parts.join("\n");
}

/** A small unified-style rendering: the whole old text out, the new text in. */
export function renderDiff(
	path: string,
	oldText: string | null | undefined,
	newText: string,
): string {
	const out = [
		`--- ${oldText == null ? "/dev/null" : `a/${path}`}`,
		`+++ b/${path}`,
	];
	if (oldText != null) for (const l of oldText.split("\n")) out.push(`-${l}`);
	for (const l of newText.split("\n")) out.push(`+${l}`);
	return capText(out.join("\n"), TEXT_CAP);
}

/** Stateful translator: accumulates streamed text and de-duplicates diffs. */
/** What is known so far about one tool call, merged across its updates. */
type OpenCall = {
	kind?: ToolKind | null;
	title?: string | null;
	rawInput?: unknown;
	locations?: ToolCallLocation[] | null;
	/** True once its `tool_call` event has been emitted. */
	announced: boolean;
	/** True once a `diff` content block produced a `file_change`. */
	diffed: boolean;
};

type ToolFields = {
	toolCallId: string;
	kind?: ToolKind | null;
	title?: string | null;
	status?: string | null;
	rawInput?: unknown;
	rawOutput?: unknown;
	locations?: ToolCallLocation[] | null;
	content?: ReadonlyArray<ToolCallContent> | null;
};

function hasInput(raw: unknown): boolean {
	if (raw === undefined || raw === null) return false;
	return !isRecord(raw) || Object.keys(raw).length > 0;
}

export class UpdateTranslator {
	private message = "";
	private thought = "";
	private seenDiffs = new Set<string>();
	/**
	 * Calls not yet completed. `pending` means the input is still streaming or
	 * awaiting approval (opencode opens a call with `{}` or a bare `cwd` and
	 * sends the command in its first update), so the `tool_call` event waits
	 * until the call leaves `pending`, a permission request names it, or the
	 * turn ends.
	 */
	private calls = new Map<string, OpenCall>();
	/** Calls completed this turn: a late duplicate update must not reopen one. */
	private finished = new Set<string>();
	/** Text of the last assistant message flushed in the current turn. */
	lastResultText: string | undefined;

	beginTurn(): void {
		this.message = "";
		this.thought = "";
		this.lastResultText = undefined;
		this.calls.clear();
		this.finished.clear();
	}

	/**
	 * Emit buffered text and announce calls still waiting for input. Call
	 * before a permission request and when a turn ends.
	 */
	flush(): EventPayload[] {
		const out = this.flushText();
		for (const [id, call] of this.calls)
			if (!call.announced) out.push(this.announce(id, call));
		return out;
	}

	private flushText(): EventPayload[] {
		const out: EventPayload[] = [];
		if (this.thought.trim())
			out.push({ type: "thinking", text: capText(this.thought, TEXT_CAP) });
		this.thought = "";
		if (this.message) {
			this.lastResultText = this.message;
			out.push({
				type: "message",
				role: "assistant",
				text: capText(this.message, TEXT_CAP),
			});
		}
		this.message = "";
		return out;
	}

	/** Translate one `session/update` payload into zero or more events. */
	handle(update: SessionUpdate): EventPayload[] {
		switch (update.sessionUpdate) {
			case "agent_message_chunk": {
				const out = this.flushThought();
				this.message += blockText(update.content);
				return out;
			}
			case "agent_thought_chunk": {
				const out = this.flushMessage();
				this.thought += blockText(update.content);
				return out;
			}
			case "tool_call":
				// A fresh `tool_call` restarts the call, even under a reused id.
				this.calls.delete(update.toolCallId);
				this.finished.delete(update.toolCallId);
				return [...this.flushText(), ...this.tool(update)];
			case "tool_call_update":
				return [...this.flushText(), ...this.tool(update)];
			case "plan":
				return [...this.flushText(), planEvent(update.entries)];
			case "plan_update":
				return update.plan.type === "items"
					? [...this.flushText(), planEvent(update.plan.entries)]
					: [];
			case "usage_update": {
				const cost = update.cost;
				if (cost?.currency !== "USD") return [];
				return [
					...this.flushText(),
					{ type: "usage", cumulative: true, costUsd: cost.amount },
				];
			}
			default:
				return [];
		}
	}

	private flushMessage(): EventPayload[] {
		if (!this.message) return [];
		const text = this.message;
		this.message = "";
		this.lastResultText = text;
		return [
			{ type: "message", role: "assistant", text: capText(text, TEXT_CAP) },
		];
	}
	private flushThought(): EventPayload[] {
		const text = this.thought;
		this.thought = "";
		return text.trim()
			? [{ type: "thinking", text: capText(text, TEXT_CAP) }]
			: [];
	}

	private tool(update: ToolFields): EventPayload[] {
		const id = update.toolCallId;
		const call = this.calls.get(id) ?? {
			announced: this.finished.has(id),
			diffed: false,
		};
		this.calls.set(id, call);
		if (update.kind) call.kind = update.kind;
		if (update.title) call.title = update.title;
		if (hasInput(update.rawInput)) call.rawInput = update.rawInput;
		if (update.locations?.length) call.locations = update.locations;
		const status = update.status;
		const done = status === "completed" || status === "failed";
		const out: EventPayload[] = [];
		if (!call.announced && status !== "pending")
			out.push(this.announce(id, call));
		const diffs = this.diffs(id, status, update.content);
		if (diffs.length) call.diffed = true;
		out.push(...diffs);
		if (done) {
			if (!call.diffed) out.push(...locationChange(id, status, call));
			this.calls.delete(id);
			this.finished.add(id);
		}
		out.push(...this.result(id, status, update));
		return out;
	}

	private announce(id: string, call: OpenCall): EventPayload {
		call.announced = true;
		const name =
			call.kind && call.kind !== "other" ? call.kind : call.title || "tool";
		return {
			type: "tool_call",
			id,
			name,
			input: sanitize(
				hasInput(call.rawInput)
					? call.rawInput
					: {
							title: call.title ?? undefined,
							...(call.locations ? { locations: call.locations } : {}),
						},
			),
		};
	}

	private diffs(
		id: string,
		status: string | null | undefined,
		content: ReadonlyArray<ToolCallContent> | null | undefined,
	): EventPayload[] {
		const phase =
			status === "completed" || status === "failed" ? "completed" : "started";
		const changes: Array<{ path: string; kind: string; diff: string }> = [];
		for (const item of content ?? []) {
			if (item.type !== "diff") continue;
			const key = `${id}\0${phase}\0${item.path}\0${item.oldText ?? ""}\0${item.newText}`;
			if (this.seenDiffs.has(key)) continue;
			this.seenDiffs.add(key);
			changes.push({
				path: item.path,
				kind: item.oldText == null ? "add" : "update",
				diff: renderDiff(item.path, item.oldText, item.newText),
			});
		}
		return changes.length
			? [
					{
						type: "file_change",
						id,
						phase,
						status: status ?? undefined,
						changes,
					},
				]
			: [];
	}

	private result(
		id: string,
		status: string | null | undefined,
		call: {
			content?: ReadonlyArray<ToolCallContent> | null;
			rawOutput?: unknown;
		},
	): EventPayload[] {
		const text = contentText(call.content);
		if (status === "completed" || status === "failed") {
			let output = text;
			if (!output && call.rawOutput !== undefined && call.rawOutput !== null)
				output =
					typeof call.rawOutput === "string"
						? call.rawOutput
						: JSON.stringify(sanitize(call.rawOutput));
			return [
				{
					type: "tool_result",
					id,
					ok: status === "completed",
					output: capText(output, OUTPUT_CAP),
				},
			];
		}
		if (status === "in_progress" && text)
			return [{ type: "tool_progress", id, output: capText(text, OUTPUT_CAP) }];
		return [];
	}
}

/**
 * A finished edit/delete/move that carried no `diff` block (opencode reports
 * writes this way) still names its files through `locations`.
 */
function locationChange(
	id: string,
	status: string,
	call: OpenCall,
): EventPayload[] {
	const kind =
		call.kind === "delete"
			? "delete"
			: call.kind === "edit" || call.kind === "move"
				? "unknown"
				: undefined;
	if (!kind || !call.locations?.length) return [];
	return [
		{
			type: "file_change",
			id,
			phase: "completed",
			status,
			changes: call.locations.map((l) => ({ path: l.path, kind })),
		},
	];
}

// ---------------------------------------------------------------------------
// Cursor extension methods (`cursor/*`, documented with Cursor's ACP mode)

/** What a blocking `cursor/ask_question` asks, for the transcript. */
export function cursorQuestionSummary(params: Record<string, unknown>): string {
	const questions = Array.isArray(params.questions) ? params.questions : [];
	const first = isRecord(questions[0]) ? questions[0] : {};
	if (typeof first.prompt === "string" && first.prompt) return first.prompt;
	return typeof params.title === "string" && params.title
		? params.title
		: "The agent asked a question";
}

/** The reply to `cursor/ask_question`: an unattended run answers nothing. */
export const CURSOR_QUESTION_SKIPPED = {
	outcome: {
		outcome: "skipped",
		reason:
			"No one is available to answer: decide yourself and state the assumption.",
	},
};

/** What a blocking `cursor/create_plan` asks to approve. */
export function cursorPlanSummary(params: Record<string, unknown>): string {
	for (const key of ["name", "overview"])
		if (typeof params[key] === "string" && params[key])
			return `Plan approval: ${params[key]}`;
	return "Plan approval requested";
}

/** The full `cursor/create_plan` response for a canonical decision. */
export function cursorPlanOutcome(decision: string): {
	outcome: Record<string, unknown>;
	status: "accepted" | "declined" | "cancelled";
} {
	const reply = (outcome: string) => ({ outcome: { outcome } });
	if (decision === "accept" || decision === "acceptForSession")
		return { outcome: reply("accepted"), status: "accepted" };
	if (decision === "decline")
		return { outcome: reply("rejected"), status: "declined" };
	return { outcome: reply("cancelled"), status: "cancelled" };
}

/** `cursor/update_todos` as a plan event; cancelled todos are dropped. */
export function cursorTodosPlan(
	params: Record<string, unknown>,
): EventPayload | undefined {
	const todos = Array.isArray(params.todos) ? params.todos : [];
	const entries = todos.flatMap((t) =>
		isRecord(t) &&
		typeof t.content === "string" &&
		(t.status === "pending" ||
			t.status === "in_progress" ||
			t.status === "completed")
			? [{ content: t.content, status: t.status }]
			: [],
	);
	return entries.length ? planEvent(entries) : undefined;
}

function planEvent(
	entries: ReadonlyArray<{ content: string; status: string }>,
): EventPayload {
	return {
		type: "plan",
		steps: entries.map((e) => ({ step: e.content, status: e.status })),
	};
}

/** Token counts from a `PromptResponse.usage`, as a usage event. */
export function promptUsageEvent(
	usage: PromptResponse["usage"],
): EventPayload | undefined {
	if (!usage) return undefined;
	const n = (v: unknown) =>
		typeof v === "number" && Number.isFinite(v) ? v : undefined;
	return {
		type: "usage",
		inputTokens: n(usage.inputTokens),
		outputTokens: n(usage.outputTokens),
		cachedInputTokens: n(usage.cachedReadTokens),
		reasoningOutputTokens: n(usage.thoughtTokens),
	};
}
