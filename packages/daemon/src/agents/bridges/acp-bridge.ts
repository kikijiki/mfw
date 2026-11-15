/**
 * Generic ACP bridge: speaks mfw.app-server/v1 on its own stdio and acts as the
 * ACP *client* towards an agent subprocess (`<providerArgv...>`, for example
 * `cursor-agent acp`, `gemini --acp` or `opencode acp`). `MFW_ACP_AGENT` picks
 * the agent profile and doubles as the reported provider id.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import {
	type Client,
	ClientSideConnection,
	type InitializeResponse,
	type McpServer,
	ndJsonStream,
	RequestError,
	type RequestPermissionRequest,
	type RequestPermissionResponse,
	type SessionConfigOption,
	type SessionModeState,
	type SessionNotification,
} from "@agentclientprotocol/sdk";
import {
	type AcpEndpoint,
	type AcpMcpServer,
	approvalKind,
	authFailureMessage,
	autoApprove,
	buildInitializeRequest,
	CANCELLED_PERMISSION,
	CAPABILITIES,
	type CanonicalStatus,
	CURSOR_QUESTION_SKIPPED,
	cursorPlanOutcome,
	cursorPlanSummary,
	cursorQuestionSummary,
	cursorTodosPlan,
	decisionOutcome,
	type EventPayload,
	endpointRefusedMessage,
	errorInfo,
	findSelectOption,
	isAuthRequired,
	isRestricted,
	mergeCursorCli,
	mergeCursorMcp,
	mergePiMcp,
	modelNotOfferedMessage,
	opencodeConfigContent,
	PolicyTracker,
	parseEndpoint,
	parseMcpConfig,
	parsePolicy,
	permissionDetails,
	permissionTitle,
	pickModelValue,
	pickThoughtValue,
	piEndpointExtension,
	piPolicyFlags,
	piWrapperScript,
	policyDecision,
	profileFor,
	promptUsageEvent,
	resumeFailureMessage,
	selectReadOnlyMode,
	stopReasonStatus,
	UpdateTranslator,
	wantsModel,
} from "../acp-translate.ts";
import { checkIdentity, resolvedPath } from "../agent-identity.ts";
import {
	type AppServerRequest,
	type AppServerResponse,
	capText,
	isRecord,
	notify,
	parseAppServerEnvelope,
	providerArgv,
	response,
	rpcError,
	sanitize,
	textInput,
	writeEnvelope,
} from "../app-server-protocol.ts";

const profile = profileFor(process.env.MFW_ACP_AGENT);
const policy = parsePolicy(process.env.MFW_ACP_POLICY);
const restricted = isRestricted(policy);
/** Setup problems found before the agent starts; reported at session/start. */
let setupError: string | undefined;
let endpoint: AcpEndpoint | null = null;
try {
	endpoint = parseEndpoint(process.env.MFW_ACP_ENDPOINT);
} catch (error) {
	setupError = error instanceof Error ? error.message : String(error);
}
const agentEnv: NodeJS.ProcessEnv = { ...process.env };
if (profile.id === "opencode" && !setupError) {
	// Layer 1: opencode takes its permissions and providers from this variable.
	try {
		const content = opencodeConfigContent(process.env.OPENCODE_CONFIG_CONTENT, {
			restricted,
			endpoint,
			model: process.env.MFW_ACP_MODEL,
		});
		if (content) agentEnv.OPENCODE_CONFIG_CONTENT = content;
	} catch (error) {
		setupError = error instanceof Error ? error.message : String(error);
	}
}
const argv = providerArgv([]);
const command = argv[0];
if (!command) {
	process.stderr.write(
		"acp bridge: no agent command given (pass the agent argv, e.g. `cursor-agent acp`)\n",
	);
	process.exit(2);
}

class AgentExit extends Error {}
/** Settles when the agent process fails to start or exits; never before spawn. */
let settleGone: (exit: AgentExit) => void = () => {};
const gone = new Promise<AgentExit>((resolve) => {
	settleGone = resolve;
});
const goneFlag = gone.then(() => true);
/** Started lazily at canonical `initialize`, after the identity check. */
let proc: ChildProcess | undefined;
let conn: ClientSideConnection;
/** Private temp dir for the pi wrapper script and endpoint extension. */
let tempDir: string | undefined;
process.on("exit", () => {
	if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});
/** Settle with the agent call, or reject if the agent dies first. */
function withAgent<T>(call: Promise<T>): Promise<T> {
	return Promise.race([
		call,
		gone.then((e): never => {
			throw e;
		}),
	]);
}

let bridgeRequestId = 1_000_000_000;
let state: "new" | "initialized" | "session" | "active" | "shutdown" = "new";
let sessionId: string | undefined;
let turnId: string | undefined;
let turnOrdinal = 0;
let turnCancelled = false;
let approvalMode: "autonomous" | "interactive" = "autonomous";
let agentInit: InitializeResponse | undefined;
const translator = new UpdateTranslator();
/** Brain MCP server names (from MFW_ACP_MCP_CONFIG), loaded at session/start. */
let mcpServers: AcpMcpServer[] = [];
/** Shared with the tracker; filled in place once the config is read. */
const mcpNames: string[] = [];
const tracker = new PolicyTracker(
	policy,
	mcpNames,
	profile.readOnlyOtherTitles,
);
/** Set when a denied tool completed unasked; fails the turn at its end. */
let violation: string | undefined;
/** Notices raised before the first turn; emitted once the driver has said hello. */
const pendingNotices: EventPayload[] = [];
const pendingCanonical = new Map<number, (r: AppServerResponse) => void>();

function event(value: EventPayload): void {
	writeEnvelope(notify("event", value));
}
function str(v: unknown, fallback = ""): string {
	return typeof v === "string" ? v : fallback;
}
function warning(message: string): EventPayload {
	return { type: "notice", category: "warning", message };
}
function sessionEvent(status: string): void {
	event({
		type: "session",
		provider: profile.id,
		sessionId,
		turnId,
		status,
		ordinal: turnOrdinal,
	});
}

const unsupported = (name: string) => (): never => {
	// Not advertised in clientCapabilities, so a well-behaved agent never asks.
	throw RequestError.methodNotFound(name);
};
const client: Client = {
	requestPermission,
	sessionUpdate(params: SessionNotification) {
		if (state !== "active" || params.sessionId !== sessionId) return;
		for (const payload of translator.handle(params.update)) event(payload);
		const found = tracker.observe(params.update);
		if (found && !violation) {
			violation = found;
			// Stop the agent; the turn then ends as failed with this message.
			turnCancelled = true;
			onCancelled?.();
			onCancelled = undefined;
			void conn.cancel({ sessionId: params.sessionId }).catch(() => {});
		}
	},
	readTextFile: unsupported("fs/read_text_file"),
	writeTextFile: unsupported("fs/write_text_file"),
	createTerminal: unsupported("terminal/create"),
	terminalOutput: unsupported("terminal/output"),
	releaseTerminal: unsupported("terminal/release"),
	waitForTerminalExit: unsupported("terminal/wait_for_exit"),
	killTerminal: unsupported("terminal/kill"),
	extMethod,
	extNotification(method, params) {
		if (method !== "cursor/update_todos" || state !== "active") return;
		const plan = cursorTodosPlan(params);
		if (!plan) return;
		for (const payload of translator.flush()) event(payload);
		event(plan);
	},
};

/**
 * Cursor's blocking extension requests: the agent waits for an answer, so
 * each gets one. A question is recorded as a `user_input` approval and
 * answered `skipped` (like a Codex user-input request); a plan approval is
 * accepted in autonomous mode and asked of the operator in interactive mode.
 */
async function extMethod(
	method: string,
	params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const itemId = str(params.toolCallId) || undefined;
	if (method === "cursor/ask_question") {
		const requestId = String(bridgeRequestId++);
		const summary = cursorQuestionSummary(params);
		const details = sanitize(params);
		for (const payload of translator.flush()) event(payload);
		event({
			type: "approval",
			requestId,
			itemId,
			kind: "user_input",
			status: "pending",
			summary,
			details,
		});
		event({
			type: "approval",
			requestId,
			itemId,
			kind: "user_input",
			status: "cancelled",
			summary,
		});
		return CURSOR_QUESTION_SKIPPED;
	}
	if (method === "cursor/create_plan") {
		const summary = cursorPlanSummary(params);
		for (const payload of translator.flush()) event(payload);
		if (state !== "active" || turnCancelled)
			return cursorPlanOutcome("cancel").outcome;
		if (approvalMode !== "interactive") {
			event({
				type: "approval",
				requestId: String(bridgeRequestId++),
				itemId,
				kind: "other",
				status: "accepted",
				summary: `Auto-approved: ${summary}`,
			});
			return cursorPlanOutcome("accept").outcome;
		}
		const decision = await askOperator({
			itemId,
			kind: "other",
			summary,
			details: sanitize(params),
		});
		const { outcome, status } = cursorPlanOutcome(decision.value);
		decision.resolved(status);
		return outcome;
	}
	throw RequestError.methodNotFound(method);
}

/**
 * One canonical `approval/request` round trip: records the pending approval,
 * waits for the driver's decision, and lets the caller record how it resolved.
 */
async function askOperator(request: {
	itemId: string | undefined;
	kind: string;
	summary: string;
	details: unknown;
}): Promise<{
	value: string;
	resolved: (status: "accepted" | "declined" | "cancelled") => void;
}> {
	const requestId = String(bridgeRequestId++);
	const { itemId, kind, summary, details } = request;
	event({
		type: "approval",
		requestId,
		itemId,
		kind,
		status: "pending",
		summary,
		details,
	});
	const cid = Number(requestId);
	writeEnvelope({
		v: 1,
		id: cid,
		method: "approval/request",
		params: { sessionId, turnId, requestId, kind, summary, details },
	});
	const answered = await new Promise<AppServerResponse>((resolve) =>
		pendingCanonical.set(cid, resolve),
	);
	const result =
		"result" in answered && isRecord(answered.result) ? answered.result : {};
	return {
		value: str(result.decision, "cancel"),
		resolved: (status) =>
			event({
				type: "approval",
				requestId,
				itemId,
				kind,
				status,
				summary: "Approval resolved",
			}),
	};
}

/**
 * Confirm a generically named binary is the agent mfw means before launching
 * it; returns the failure reason, and for help-text identities the real
 * binary's path (pi's wrapper execs it).
 */
async function verifyIdentity(): Promise<{
	reason?: string;
	realBin?: string;
}> {
	const wanted = profile.identity;
	if (!wanted) return {};
	const { bin, identity } = wanted;
	if (identity.kind === "symlink-target") {
		// Only the generic name is ambiguous; any other argv[0] is the user's choice.
		if (command !== bin) return {};
		const found = Bun.which(bin, { PATH: agentEnv.PATH });
		if (!found) return { reason: `\`${bin}\` not found on PATH` };
		const verdict = checkIdentity(identity, bin, {
			resolvedPath: resolvedPath(found),
		});
		return verdict.ok ? {} : { reason: verdict.reason };
	}
	const real = Bun.which(
		process.env.MFW_ACP_PI_BIN || process.env.PI_ACP_PI_COMMAND || bin,
		{ PATH: agentEnv.PATH },
	);
	if (!real) return { reason: `\`${bin}\` not found on PATH` };
	let helpText = "";
	try {
		const run = Bun.spawn([real, ...identity.args], {
			stdout: "pipe",
			stderr: "pipe",
			stdin: "ignore",
			timeout: 5000,
		});
		const [out, err] = await Promise.all([
			new Response(run.stdout).text(),
			new Response(run.stderr).text(),
		]);
		await run.exited;
		helpText = `${out}\n${err}`;
	} catch {}
	const verdict = checkIdentity(identity, bin, { helpText });
	return verdict.ok ? { realBin: real } : { reason: verdict.reason };
}

/**
 * pi-acp offers no way to pass pi flags, so a wrapper script (in a private
 * temp dir) execs the real pi with the policy's flags and the endpoint
 * extension, and `PI_ACP_PI_COMMAND` points pi-acp at it.
 */
async function preparePi(realPi: string): Promise<void> {
	const wrapEndpoint = endpoint && !setupError;
	if (!restricted && !wrapEndpoint) return;
	let names: string[] = [];
	try {
		names = (await loadMcpServers()).map((s) => s.name);
	} catch {
		// A bad MCP config is reported at session/start.
	}
	const flags = piPolicyFlags(policy, names);
	tempDir = await mkdtemp(join(tmpdir(), "mfw-acp-pi-"));
	await chmod(tempDir, 0o700);
	if (endpoint && wrapEndpoint) {
		const model = process.env.MFW_ACP_MODEL;
		if (!wantsModel(model)) {
			setupError = `pi needs a model for endpoint '${endpoint.id}'`;
		} else {
			const file = join(tempDir, "mfw-endpoint.js");
			await writeFile(file, piEndpointExtension(endpoint, model), {
				mode: 0o600,
			});
			flags.push("-e", file);
		}
	}
	const wrapper = join(tempDir, "pi-wrapper.sh");
	await writeFile(wrapper, piWrapperScript(realPi, flags), { mode: 0o700 });
	await chmod(wrapper, 0o700);
	agentEnv.PI_ACP_PI_COMMAND = wrapper;
}

/** Start the agent process and the ACP connection over its stdio. */
function spawnAgent(): void {
	const child = spawn(command as string, argv.slice(1), {
		stdio: ["pipe", "pipe", "pipe"],
		env: agentEnv,
	});
	proc = child;
	child.stdin.on("error", () => {});
	child.once("error", (e) =>
		settleGone(new AgentExit(`${profile.label} failed to start: ${e.message}`)),
	);
	child.once("exit", (code, signal) =>
		settleGone(
			new AgentExit(
				`${profile.label} exited unexpectedly (${signal ?? `code ${code}`})`,
			),
		),
	);
	conn = new ClientSideConnection(
		() => client,
		ndJsonStream(
			Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
			Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
		),
	);
	void readLines(child.stderr, (line) => {
		process.stderr.write(`${capText(line, 2048)}\n`);
	});
}

async function requestPermission(
	params: RequestPermissionRequest,
): Promise<RequestPermissionResponse> {
	if (state !== "active" || turnCancelled || params.sessionId !== sessionId)
		return CANCELLED_PERMISSION;
	for (const payload of translator.flush()) event(payload);
	const kind = approvalKind(params.toolCall.kind);
	const title = permissionTitle(params);
	const itemId = params.toolCall.toolCallId;
	if (restricted) {
		// The bridge decides alone; the operator is never asked under a policy.
		const decided = policyDecision(
			policy,
			params,
			mcpNames,
			profile.readOnlyOtherTitles,
		);
		if (decided.accepted) tracker.grant(itemId);
		event({
			type: "approval",
			requestId: String(bridgeRequestId++),
			itemId,
			kind,
			status: decided.accepted ? "accepted" : "declined",
			summary: decided.summary,
		});
		return decided.response;
	}
	if (approvalMode !== "interactive") {
		const requestId = String(bridgeRequestId++);
		const { response: answer, accepted } = autoApprove(params.options);
		event({
			type: "approval",
			requestId,
			itemId,
			kind,
			status: accepted ? "accepted" : "declined",
			summary: accepted
				? `Auto-approved: ${title}`
				: `Declined (no allow option offered): ${title}`,
		});
		return answer;
	}
	const decision = await askOperator({
		itemId,
		kind,
		summary: title,
		details: permissionDetails(params),
	});
	const { response: outcome, status } = decisionOutcome(
		decision.value,
		params.options,
	);
	decision.resolved(status);
	return outcome;
}

class StateError extends Error {
	constructor() {
		super("method is not valid in the current bridge state");
	}
}

/** Fail with the sign-in instruction when the agent says it needs auth. */
async function guarded<T>(call: Promise<T>): Promise<T> {
	try {
		return await withAgent(call);
	} catch (error) {
		if (!(error instanceof AgentExit) && isAuthRequired(error))
			throw new Error(
				authFailureMessage(profile, agentInit?.authMethods ?? undefined),
			);
		throw error;
	}
}

/** Read MFW_ACP_MCP_CONFIG; a missing or invalid file fails the session. */
async function loadMcpServers(): Promise<AcpMcpServer[]> {
	const path = process.env.MFW_ACP_MCP_CONFIG;
	if (!path) return [];
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code ?? "unreadable";
		throw new Error(`MFW_ACP_MCP_CONFIG ${path} cannot be read (${code})`);
	}
	try {
		return parseMcpConfig(text);
	} catch (error) {
		throw new Error(
			`MFW_ACP_MCP_CONFIG ${path} is invalid: ${error instanceof Error ? error.message : "unreadable"}`,
		);
	}
}

/**
 * Cursor takes MCP servers and permissions from project files in the cwd.
 * They are written only outside git checkouts: never into a user's repo.
 */
async function writeCursorFiles(cwd: string): Promise<void> {
	const wantMcp = mcpServers.length > 0;
	if (!wantMcp && !restricted) return;
	const dir = await projectConfigDir(cwd, ".cursor", "Cursor");
	if (wantMcp)
		await mergeFile(dir, "mcp.json", (old) => mergeCursorMcp(old, mcpServers));
	if (restricted)
		await mergeFile(dir, "cli.json", (old) =>
			mergeCursorCli(old, policy, mcpNames),
		);
}

/**
 * pi reads its MCP servers from `<cwd>/.pi/mcp.json` (the wrapper's `--approve`
 * trusts it); pi-acp ignores the `mcpServers` of session/new.
 */
async function writePiFiles(cwd: string): Promise<void> {
	if (policy !== "read-only" || mcpServers.length === 0) return;
	const dir = await projectConfigDir(cwd, ".pi", "pi");
	await mergeFile(dir, "mcp.json", (old) => mergePiMcp(old, mcpServers));
}

/** `<cwd>/<name>`, created; refused inside a git checkout (never write into a user's repo). */
async function projectConfigDir(
	cwd: string,
	name: string,
	label: string,
): Promise<string> {
	if (existsSync(join(cwd, ".git")))
		throw new Error(
			`refusing to write ${label} config into ${cwd}: it is a git checkout`,
		);
	const dir = join(cwd, name);
	await mkdir(dir, { recursive: true });
	return dir;
}

async function mergeFile(
	dir: string,
	name: string,
	build: (old?: string) => string,
): Promise<void> {
	const file = join(dir, name);
	let old: string | undefined;
	try {
		old = await readFile(file, "utf8");
	} catch {}
	let next: string;
	try {
		next = build(old);
	} catch (error) {
		throw new Error(
			`cannot merge ${file}: ${error instanceof Error ? error.message : "invalid"}`,
		);
	}
	await writeFile(file, next);
}

/** Route the agent to an OpenAI-compatible endpoint; returns true when done via providers/set. */
async function applyEndpoint(ep: AcpEndpoint): Promise<boolean> {
	if (agentInit?.agentCapabilities?.providers) {
		const listed = await withAgent(conn.unstable_listProviders({}));
		const provider = listed.providers.find((x) =>
			x.supported.includes("openai"),
		);
		if (!provider)
			throw new Error(
				`${profile.label} has no provider that supports OpenAI-compatible endpoints (endpoint '${ep.id}')`,
			);
		const key = ep.envKey ? process.env[ep.envKey] : undefined;
		await withAgent(
			conn.unstable_setProvider({
				id: provider.id,
				apiType: "openai",
				baseUrl: ep.baseUrl,
				headers: key ? { Authorization: `Bearer ${key}` } : {},
			}),
		);
		return true;
	}
	// opencode takes a config provider; pi a generated extension (the wrapper).
	if (profile.id === "opencode" || profile.id === "pi") return false;
	throw new Error(endpointRefusedMessage(profile, ep));
}

type Existing = {
	modes?: SessionModeState | null;
	configOptions?: SessionConfigOption[] | null;
};

/** Continue a native session: resume when offered (no replay), else load. */
async function resumeSession(
	id: string,
	cwd: string,
	servers: McpServer[],
): Promise<Existing> {
	const sessionCaps = agentInit?.agentCapabilities?.sessionCapabilities;
	const canResume = Boolean(sessionCaps?.resume);
	const canLoad = Boolean(agentInit?.agentCapabilities?.loadSession);
	if (!canResume && !canLoad)
		throw new Error(
			resumeFailureMessage(
				id,
				`${profile.label} supports neither session/resume nor session/load`,
			),
		);
	try {
		// Load replays history as updates; they are dropped (no active turn).
		return canResume
			? await withAgent(
					conn.resumeSession({ sessionId: id, cwd, mcpServers: servers }),
				)
			: await withAgent(
					conn.loadSession({ sessionId: id, cwd, mcpServers: servers }),
				);
	} catch (error) {
		if (error instanceof AgentExit) throw error;
		if (isAuthRequired(error))
			throw new Error(
				authFailureMessage(profile, agentInit?.authMethods ?? undefined),
			);
		throw new Error(resumeFailureMessage(id, errorInfo(error).message));
	}
}

async function startSession(p: Record<string, unknown>): Promise<string> {
	if (setupError) throw new Error(setupError);
	const cwd = str(p.cwd);
	mcpServers = await loadMcpServers();
	mcpNames.splice(0, mcpNames.length, ...mcpServers.map((s) => s.name));
	if (profile.id === "cursor-agent") await writeCursorFiles(cwd);
	if (profile.id === "pi") await writePiFiles(cwd);
	let requestedModel: unknown = p.model;
	if (endpoint) {
		const viaProviders = await guarded(applyEndpoint(endpoint));
		if (!viaProviders && wantsModel(process.env.MFW_ACP_MODEL))
			requestedModel = `mfw-${endpoint.id}/${process.env.MFW_ACP_MODEL}`;
	}
	const acpServers: McpServer[] = mcpServers.map((s) => ({
		name: s.name,
		command: s.command,
		args: s.args,
		env: s.env,
	}));
	const resumeId = process.env.MFW_ACP_RESUME_SESSION;
	let id: string;
	let created: Existing;
	if (resumeId) {
		created = await resumeSession(resumeId, cwd, acpServers);
		id = resumeId;
	} else {
		const fresh = await guarded(
			conn.newSession({ cwd, mcpServers: acpServers }),
		);
		created = fresh;
		id = fresh.sessionId;
	}
	let options: SessionConfigOption[] | null | undefined = created.configOptions;
	if (restricted && profile.readOnlyMode) {
		const pick = selectReadOnlyMode(
			created.modes,
			options,
			profile.readOnlyMode,
		);
		if (!pick)
			pendingNotices.push(
				warning(
					`${profile.label} offers no "${profile.readOnlyMode}" mode; relying on its agent-side restrictions`,
				),
			);
		else if (pick.via === "mode")
			await withAgent(
				conn.setSessionMode({ sessionId: id, modeId: pick.modeId }),
			);
		else {
			const applied = await withAgent(
				conn.setSessionConfigOption({
					sessionId: id,
					configId: pick.configId,
					value: pick.value,
				}),
			);
			options = applied.configOptions ?? options;
		}
	}
	if (wantsModel(requestedModel)) {
		const model = findSelectOption(options, "model");
		if (model) {
			const value = pickModelValue(model.values, requestedModel);
			// Fail closed: never silently run on another model.
			if (!value)
				throw new Error(
					modelNotOfferedMessage(profile, requestedModel, model.values),
				);
			const applied = await withAgent(
				conn.setSessionConfigOption({
					sessionId: id,
					configId: model.id,
					value,
				}),
			);
			options = applied.configOptions ?? options;
		} else if (!profile.modelOnArgv) {
			// The SDK has no stable model-switch request without a config option.
			pendingNotices.push(
				warning(
					`${profile.label} exposes no model selector; running on its default model instead of "${requestedModel}"`,
				),
			);
		}
	}
	const thought = findSelectOption(options, "thought_level");
	const effort = typeof p.reasoningEffort === "string" ? p.reasoningEffort : "";
	const level =
		thought && effort ? pickThoughtValue(thought.values, effort) : "";
	if (thought && level) {
		await withAgent(
			conn.setSessionConfigOption({
				sessionId: id,
				configId: thought.id,
				value: level,
			}),
		).catch((error) =>
			pendingNotices.push(
				warning(
					`${profile.label} rejected reasoning level "${effort}": ${errorInfo(error).message}`,
				),
			),
		);
	}
	return id;
}

async function handleCanonical(req: AppServerRequest): Promise<void> {
	try {
		const p = isRecord(req.params) ? req.params : {};
		switch (req.method) {
			case "initialize": {
				if (state !== "new") throw new StateError();
				if (restricted && !profile.brainEligible)
					throw new Error(
						`${profile.label} has no way to restrict its own tools, so it cannot run under the ${policy} policy`,
					);
				const checked = await verifyIdentity();
				if (checked.reason) throw new Error(checked.reason);
				if (profile.id === "pi" && checked.realBin)
					await preparePi(checked.realBin);
				spawnAgent();
				agentInit = await guarded(
					conn.initialize(buildInitializeRequest(profile)),
				);
				state = "initialized";
				writeEnvelope(
					response(req.id, {
						protocol: 1,
						provider: profile.id,
						capabilities: {
							...CAPABILITIES,
							// The brain's MCP servers ride on every session this bridge opens.
							mcp: Boolean(process.env.MFW_ACP_MCP_CONFIG),
						},
					}),
				);
				break;
			}
			case "session/start": {
				if (state !== "initialized") throw new StateError();
				approvalMode =
					p.approvalMode === "interactive" ? "interactive" : "autonomous";
				sessionId = await startSession(p);
				state = "session";
				writeEnvelope(response(req.id, { sessionId }));
				break;
			}
			case "turn/start": {
				if (state !== "session" || p.sessionId !== sessionId)
					throw new StateError();
				const input = textInput(p.input);
				if (!input) throw new Error("invalid text input");
				turnOrdinal++;
				turnId = `turn-${turnOrdinal}`;
				turnCancelled = false;
				violation = undefined;
				tracker.reset();
				translator.beginTurn();
				state = "active";
				// The driver's call times out; answer now and let the turn run on.
				writeEnvelope(response(req.id, { turnId }));
				for (const notice of pendingNotices.splice(0)) event(notice);
				sessionEvent("active");
				void runTurn(
					sessionId as string,
					turnId,
					input.map((i) => i.text),
				);
				break;
			}
			case "turn/steer":
				writeEnvelope(
					rpcError(
						req.id,
						"UNSUPPORTED",
						"ACP agents cannot be steered mid-turn",
					),
				);
				break;
			case "turn/interrupt":
				if (
					state !== "active" ||
					p.sessionId !== sessionId ||
					p.turnId !== turnId
				)
					throw new StateError();
				turnCancelled = true;
				onCancelled?.();
				onCancelled = undefined;
				await withAgent(conn.cancel({ sessionId: sessionId as string }));
				// Per spec the open permission request must end as cancelled.
				for (const [id, resolve] of pendingCanonical) {
					pendingCanonical.delete(id);
					resolve({ v: 1, id, result: { decision: "cancel" } });
				}
				writeEnvelope(response(req.id, {}));
				break;
			case "shutdown":
				state = "shutdown";
				writeEnvelope(response(req.id, {}));
				void terminateAgent();
				break;
			default:
				writeEnvelope(
					rpcError(req.id, "UNSUPPORTED", `unsupported method: ${req.method}`),
				);
		}
	} catch (error) {
		writeEnvelope(
			rpcError(
				req.id,
				error instanceof StateError ? "INVALID_STATE" : "PROVIDER_ERROR",
				error instanceof Error ? error.message : errorInfo(error).message,
			),
		);
	}
}

/** How long an agent may take to answer the open prompt after `session/cancel`. */
const CANCEL_GRACE_MS = Number(process.env.MFW_ACP_CANCEL_GRACE_MS) || 10_000;
class CancelTimeout extends Error {}
let onCancelled: (() => void) | undefined;
/**
 * Rejects CANCEL_GRACE_MS after an interrupt, so an agent that never answers
 * its cancelled prompt cannot hold the run open forever.
 */
function cancelDeadline(): Promise<never> {
	return new Promise((_, reject) => {
		onCancelled = () =>
			setTimeout(
				() =>
					reject(
						new CancelTimeout(
							`${profile.label} did not end the turn within ${CANCEL_GRACE_MS} ms of cancel`,
						),
					),
				CANCEL_GRACE_MS,
			);
	});
}

async function runTurn(
	sid: string,
	tid: string,
	texts: string[],
): Promise<void> {
	let status: CanonicalStatus = "completed";
	let failure: string | undefined;
	const after: EventPayload[] = [];
	try {
		const result = await Promise.race([
			withAgent(
				conn.prompt({
					sessionId: sid,
					prompt: texts.map((text) => ({ type: "text", text })),
				}),
			),
			cancelDeadline(),
		]);
		const mapped = stopReasonStatus(result.stopReason);
		status = mapped.status;
		if (mapped.notice) after.push(warning(mapped.notice));
		const usage = promptUsageEvent(result.usage);
		if (usage) after.push(usage);
		// Updates sent just before the reply are handled on the next ticks.
		await Bun.sleep(10);
	} catch (error) {
		// The driver turns a failed completion into the run's one fatal error.
		status = error instanceof CancelTimeout ? "interrupted" : "failed";
		failure = errorInfo(error).message;
		// A closed connection usually means the agent died: name its exit instead.
		const exit = await Promise.race([gone, Bun.sleep(200).then(() => null)]);
		if (exit && !(error instanceof CancelTimeout)) failure = exit.message;
		if (error instanceof CancelTimeout) after.push(warning(failure));
	}
	if (violation) {
		status = "failed";
		failure = violation;
	}
	for (const payload of translator.flush()) event(payload);
	for (const payload of after) event(payload);
	sessionEvent(status);
	const params: Record<string, unknown> = {
		sessionId: sid,
		turnId: tid,
		status,
		resultText: translator.lastResultText,
	};
	if (status === "failed")
		params.error = { message: failure ?? "ACP turn failed" };
	writeEnvelope(notify("turn/completed", params));
	if (state === "active") state = "session";
}

/** Close stdin, then escalate: opencode, for one, ignores stdin closing. */
let terminating: Promise<void> | undefined;
function terminateAgent(): Promise<void> {
	terminating ??= (async () => {
		const child = proc;
		if (!child) return;
		try {
			child.stdin?.end();
		} catch {}
		const exitedWithin = async (ms: number) =>
			await Promise.race([goneFlag, Bun.sleep(ms).then(() => false)]);
		if (await exitedWithin(500)) return;
		child.kill("SIGTERM");
		if (await exitedWithin(2000)) return;
		child.kill("SIGKILL");
		await exitedWithin(1000);
	})();
	return terminating;
}

async function readLines(
	stream: AsyncIterable<Uint8Array>,
	fn: (line: string) => void | Promise<void>,
) {
	let buf = "";
	const decoder = new TextDecoder();
	for await (const bytes of stream) {
		buf += decoder.decode(bytes, { stream: true });
		let at = buf.indexOf("\n");
		while (at >= 0) {
			const line = buf.slice(0, at).trim();
			buf = buf.slice(at + 1);
			if (line) await fn(line);
			at = buf.indexOf("\n");
		}
	}
}
await readLines(Bun.stdin.stream(), async (line) => {
	const envelope = parseAppServerEnvelope(line);
	if (!envelope) {
		process.stderr.write("acp bridge: invalid canonical envelope\n");
		return;
	}
	if ("id" in envelope && !("method" in envelope)) {
		const pending = pendingCanonical.get(envelope.id);
		if (pending) {
			pendingCanonical.delete(envelope.id);
			pending(envelope);
		}
		return;
	}
	if ("id" in envelope && "method" in envelope) await handleCanonical(envelope);
});
await terminateAgent();
process.exit(0);
