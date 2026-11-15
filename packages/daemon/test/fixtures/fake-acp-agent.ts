/**
 * Mock ACP agent over stdio. The prompt text picks the scenario:
 * PERMISSION, WAIT_FOR_CANCEL, FAIL; anything else is a normal turn. The
 * normal turn echoes what the client did (model, config calls, initialize
 * meta) in its assistant text so tests can assert on it.
 * FAKE_ACP_AUTH_REQUIRED=1 makes session/new fail with auth_required.
 *
 * Policy/session scenarios: MCP_ECHO (names of the mcpServers it was given),
 * MODE? (current mode), ENV? (OPENCODE_CONFIG_CONTENT), PROVIDERS? (recorded
 * providers/set calls), TRY_WRITE (asks permission for an edit), SNEAKY_WRITE
 * (an edit completes without asking), MCP_TOOL (asks for a brain MCP tool).
 * Env: FAKE_ACP_NO_RESUME / FAKE_ACP_NO_LOAD drop those capabilities,
 * FAKE_ACP_STATE_DIR persists sessions across processes, FAKE_ACP_NO_MODES
 * offers no mode surface, FAKE_ACP_MODE_AS_OPTION offers a `mode` config
 * option instead of `modes`, FAKE_ACP_PROVIDERS advertises providers,
 * FAKE_ACP_EXTRA_MODEL adds a model value. With FAKE_ACP_STATE_DIR every
 * session request is appended to requests.log; FAKE_ACP_UNIQUE_IDS=1 mints a
 * distinct session id per session/new. FAKE_ACP_QUIET=1 makes every prompt a
 * plain one-line reply with no tool calls (a read-only-compliant agent).
 * SNEAKY:<kind>:<title> completes a tool of that kind without asking.
 * PI_ENV? reports, as JSON, the wrapper script PI_ACP_PI_COMMAND points at,
 * the pi endpoint extension next to it, the session cwd's .pi/mcp.json and
 * the file modes. FAKE_ACP_STARTED_MARKER=<file> is written when the process
 * starts (so tests can prove it never did); FAKE_ACP_THOUGHT_OFF=1 adds an
 * `off` thought level.
 */
import {
	appendFileSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import {
	type Agent,
	AgentSideConnection,
	ndJsonStream,
	PROTOCOL_VERSION,
	RequestError,
	type SessionConfigOption,
} from "@agentclientprotocol/sdk";

if (process.env.FAKE_ACP_STARTED_MARKER)
	writeFileSync(process.env.FAKE_ACP_STARTED_MARKER, "started");
const sets: string[] = [];
let sessionCwd = "";
let picker = false;
let advertisedFs = false;
let cancel: (() => void) | undefined;
const current: Record<string, string> = {
	model: "mock-fast",
	thought: "medium",
	mode: "default",
};
let mcpNames: string[] = [];
const providerCalls: string[] = [];
const stateDir = process.env.FAKE_ACP_STATE_DIR;
const modeAsOption = process.env.FAKE_ACP_MODE_AS_OPTION === "1";
const noModes = process.env.FAKE_ACP_NO_MODES === "1";

/** FAKE_ACP_STATE_DIR/requests.log: one JSON line per session request, for tests. */
function logRequest(
	method: string,
	p: {
		sessionId?: string;
		cwd?: string;
		mcpServers?: ReadonlyArray<{ name: string }>;
	},
	returned?: string,
): void {
	if (!stateDir) return;
	mkdirSync(stateDir, { recursive: true });
	appendFileSync(
		join(stateDir, "requests.log"),
		`${JSON.stringify({
			method,
			sessionId: p.sessionId ?? returned ?? null,
			cwd: p.cwd ?? null,
			mcpServers: names(p.mcpServers),
			policy: process.env.MFW_ACP_POLICY ?? null,
			mode: current.mode,
		})}\n`,
	);
}
function saveSession(id: string, servers: unknown): void {
	if (!stateDir) return;
	mkdirSync(stateDir, { recursive: true });
	writeFileSync(join(stateDir, `${id}.json`), JSON.stringify({ servers }));
}
function requireSession(id: string): void {
	if (!stateDir) throw new RequestError(-32002, "session not found");
	try {
		readFileSync(join(stateDir, `${id}.json`), "utf8");
	} catch {
		throw new RequestError(-32002, `session ${id} not found`);
	}
}
function readOrNull(file: string): string | null {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return null;
	}
}
/** What the pi profile's bridge prepared, as the real pi-acp would find it. */
function piEnvReport(): string {
	const wrapper = process.env.PI_ACP_PI_COMMAND;
	const modeOf = (path: string) => (statSync(path).mode & 0o777).toString(8);
	return JSON.stringify({
		model: current.model,
		wrapper: wrapper ? readOrNull(wrapper) : null,
		wrapperMode: wrapper ? modeOf(wrapper) : null,
		dirMode: wrapper ? modeOf(dirname(wrapper)) : null,
		extension: wrapper
			? readOrNull(join(dirname(wrapper), "mfw-endpoint.js"))
			: null,
		mcp: readOrNull(join(sessionCwd, ".pi/mcp.json")),
	});
}
function names(servers: ReadonlyArray<{ name: string }> | undefined): string[] {
	return (servers ?? []).map((s) => s.name);
}
const modeList = [
	{ id: "default", name: "Default" },
	{ id: "plan", name: "Plan" },
];
function modesState() {
	return noModes || modeAsOption
		? {}
		: {
				modes: {
					currentModeId: current.mode as string,
					availableModes: modeList,
				},
			};
}

function configOptions(): SessionConfigOption[] {
	const extra = process.env.FAKE_ACP_EXTRA_MODEL;
	const mode: SessionConfigOption[] =
		modeAsOption && !noModes
			? [
					{
						id: "mode",
						name: "Mode",
						category: "mode",
						type: "select",
						currentValue: current.mode as string,
						options: modeList.map((m) => ({ value: m.id, name: m.name })),
					},
				]
			: [];
	return [
		...mode,
		{
			id: "model",
			name: "Model",
			category: "model",
			type: "select",
			currentValue: current.model as string,
			options: [
				{ value: "mock-fast", name: "Mock Fast" },
				{ value: "mock-smart", name: "Mock Smart" },
				...(extra ? [{ value: extra, name: extra }] : []),
			],
		},
		{
			id: "thought",
			name: "Thinking",
			category: "thought_level",
			type: "select",
			currentValue: current.thought as string,
			options: [
				...(process.env.FAKE_ACP_THOUGHT_OFF === "1"
					? [{ value: "off", name: "off" }]
					: []),
				{ value: "low", name: "Low" },
				{ value: "medium", name: "Medium" },
				{ value: "high", name: "High" },
			],
		},
	];
}

const conn: AgentSideConnection = new AgentSideConnection(
	(): Agent => ({
		initialize(params) {
			const caps = params.clientCapabilities;
			picker = Boolean(
				(caps?._meta as { parameterizedModelPicker?: unknown } | undefined)
					?.parameterizedModelPicker,
			);
			advertisedFs = Boolean(caps?.fs?.readTextFile || caps?.terminal);
			return {
				protocolVersion: PROTOCOL_VERSION,
				agentCapabilities: {
					loadSession: process.env.FAKE_ACP_NO_LOAD !== "1",
					sessionCapabilities:
						process.env.FAKE_ACP_NO_RESUME === "1" ? {} : { resume: {} },
					...(process.env.FAKE_ACP_PROVIDERS === "1" ? { providers: {} } : {}),
				},
				authMethods: [{ id: "login", name: "Mock Login" }],
			};
		},
		newSession(params) {
			if (process.env.FAKE_ACP_AUTH_REQUIRED === "1")
				throw RequestError.authRequired();
			mcpNames = names(params.mcpServers);
			sessionCwd = params.cwd;
			const sid =
				process.env.FAKE_ACP_UNIQUE_IDS === "1"
					? `acp-session-${crypto.randomUUID()}`
					: "acp-session-1";
			logRequest("session/new", params, sid);
			saveSession(sid, mcpNames);
			return {
				sessionId: sid,
				configOptions: configOptions(),
				...modesState(),
			};
		},
		async loadSession(params) {
			logRequest("session/load", params);
			requireSession(params.sessionId);
			mcpNames = names(params.mcpServers);
			sessionCwd = params.cwd;
			// A real agent replays the whole conversation; the bridge must drop it.
			for (const [kind, text] of [
				["user_message_chunk", "REPLAYED user"],
				["agent_message_chunk", "REPLAYED"],
			] as const)
				await conn.sessionUpdate({
					sessionId: params.sessionId,
					update: { sessionUpdate: kind, content: { type: "text", text } },
				});
			return { configOptions: configOptions(), ...modesState() };
		},
		resumeSession(params) {
			logRequest("session/resume", params);
			requireSession(params.sessionId);
			mcpNames = names(params.mcpServers);
			return { configOptions: configOptions(), ...modesState() };
		},
		setSessionMode(params) {
			current.mode = params.modeId;
			return {};
		},
		unstable_listProviders() {
			return {
				providers: [
					{ id: "main", supported: ["anthropic"], required: true },
					{ id: "alt", supported: ["anthropic", "openai"], required: false },
				],
			};
		},
		unstable_setProvider(params) {
			providerCalls.push(
				JSON.stringify({
					id: params.id,
					apiType: params.apiType,
					baseUrl: params.baseUrl,
					headers: params.headers,
				}),
			);
			return {};
		},
		authenticate() {
			throw new Error("authenticate must not be called");
		},
		setSessionConfigOption(params) {
			const value = "value" in params ? String(params.value) : "";
			sets.push(`${params.configId}=${value}`);
			current[params.configId] = value;
			return { configOptions: configOptions() };
		},
		cancel() {
			cancel?.();
		},
		async prompt(params) {
			const sessionId = params.sessionId;
			const text = params.prompt
				.map((b) => (b.type === "text" ? b.text : ""))
				.join("\n");
			const update = (u: Record<string, unknown>) =>
				conn.sessionUpdate({ sessionId, update: u } as never);
			const say = (t: string) =>
				update({
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: t },
				});

			if (process.env.FAKE_ACP_QUIET === "1") {
				// A well-behaved read-only agent: one reply, no tools.
				await say("noted");
				return { stopReason: "end_turn" };
			}

			if (text.includes("FAIL")) throw new Error("mock agent exploded");

			if (text.includes("CRASH")) {
				await say("about to crash");
				setTimeout(() => process.exit(3), 50);
				return new Promise<never>(() => {});
			}

			if (text.includes("IGNORE_CANCEL")) {
				await say("never answering");
				return new Promise<never>(() => {});
			}

			if (text.includes("WAIT_FOR_CANCEL")) {
				await say("waiting for cancel");
				await new Promise<void>((resolve) => {
					cancel = resolve;
				});
				return { stopReason: "cancelled" };
			}

			if (text.includes("MCP_ECHO")) {
				await say(`mcp=${mcpNames.join(",") || "none"}`);
				return { stopReason: "end_turn" };
			}
			if (text.includes("MODE?")) {
				await say(`mode=${current.mode}`);
				return { stopReason: "end_turn" };
			}
			if (text.includes("PI_ENV?")) {
				await say(piEnvReport());
				return { stopReason: "end_turn" };
			}
			if (text.includes("ENV?")) {
				await say(
					`model=${current.model} env=${process.env.OPENCODE_CONFIG_CONTENT ?? "unset"}`,
				);
				return { stopReason: "end_turn" };
			}
			if (text.includes("PROVIDERS?")) {
				await say(`providers=[${providerCalls.join(",")}]`);
				return { stopReason: "end_turn" };
			}

			if (text.includes("SNEAKY_WRITE")) {
				await update({
					sessionUpdate: "tool_call",
					toolCallId: "sneak-1",
					title: "Write secrets.txt",
					kind: "edit",
					status: "in_progress",
				});
				await update({
					sessionUpdate: "tool_call_update",
					toolCallId: "sneak-1",
					status: "completed",
				});
				// Wait for the bridge to cancel us; give up so a missed cancel shows.
				await Promise.race([
					new Promise<void>((resolve) => {
						cancel = resolve;
					}),
					Bun.sleep(3000),
				]);
				return { stopReason: "cancelled" };
			}

			// SNEAKY:<kind>:<title>: a tool of that kind completes without asking.
			if (text.includes("SNEAKY:")) {
				const [, kind = "other", title = "tool"] = text
					.slice(text.indexOf("SNEAKY:"))
					.split(":");
				await update({
					sessionUpdate: "tool_call",
					toolCallId: "sneak-2",
					title,
					kind,
					status: "in_progress",
				});
				await update({
					sessionUpdate: "tool_call_update",
					toolCallId: "sneak-2",
					status: "completed",
				});
				await Promise.race([
					new Promise<void>((resolve) => {
						cancel = resolve;
					}),
					Bun.sleep(300),
				]);
				await say(`ran:${title}`);
				return { stopReason: "end_turn" };
			}

			const askTool = async (
				id: string,
				title: string,
				kind: "edit" | "other",
				label: string,
			) => {
				await update({
					sessionUpdate: "tool_call",
					toolCallId: id,
					title,
					kind,
					status: "in_progress",
				});
				const answer = await conn.requestPermission({
					sessionId,
					toolCall: { toolCallId: id, title, kind },
					options: [
						{ optionId: "once", name: "Allow once", kind: "allow_once" },
						{ optionId: "no", name: "Reject", kind: "reject_once" },
					],
				});
				const chosen =
					answer.outcome.outcome === "selected"
						? answer.outcome.optionId
						: "cancelled";
				await update({
					sessionUpdate: "tool_call_update",
					toolCallId: id,
					status: chosen === "once" ? "completed" : "failed",
				});
				await say(`${label}:${chosen}`);
				return { stopReason: "end_turn" as const };
			};
			if (text.includes("TRY_WRITE"))
				return askTool("write-1", "Write notes.txt", "edit", "write");
			if (text.includes("MCP_TOOL"))
				return askTool("mcp-1", "mfw_brain_board_read", "other", "mcp");

			if (text.includes("PERMISSION")) {
				const answer = await conn.requestPermission({
					sessionId,
					toolCall: {
						toolCallId: "perm-1",
						title: "Run rm -rf build",
						kind: "execute",
						rawInput: { command: "rm -rf build", apiToken: "hunter2" },
					},
					options: [
						{ optionId: "always", name: "Always allow", kind: "allow_always" },
						{ optionId: "once", name: "Allow once", kind: "allow_once" },
						{ optionId: "no", name: "Reject", kind: "reject_once" },
					],
				});
				await say(
					`permission:${
						answer.outcome.outcome === "selected"
							? answer.outcome.optionId
							: "cancelled"
					}`,
				);
				return { stopReason: "end_turn" };
			}

			if (text.includes("CURSOR_EXT")) {
				// Shapes from Cursor's documented ACP extension methods.
				await conn.extNotification("cursor/update_todos", {
					todos: [
						{ id: "1", content: "inspect", status: "completed" },
						{ id: "2", content: "dropped", status: "cancelled" },
						{ id: "3", content: "fix", status: "in_progress" },
					],
				});
				const asked = await conn.extMethod("cursor/ask_question", {
					toolCallId: "q-1",
					questions: [
						{
							id: "q1",
							prompt: "Which mode?",
							options: [{ id: "a", label: "A" }],
						},
					],
				});
				const planned = await conn.extMethod("cursor/create_plan", {
					toolCallId: "p-1",
					name: "Refactor",
					plan: "1. do it",
					todos: [],
				});
				const outcome = (r: Record<string, unknown>) =>
					String((r.outcome as { outcome?: unknown })?.outcome);
				await say(`question:${outcome(asked)} plan:${outcome(planned)}`);
				return { stopReason: "end_turn" };
			}

			await update({
				sessionUpdate: "agent_thought_chunk",
				content: { type: "text", text: "thinking it over" },
			});
			await say("Working ");
			await say("on it. ");
			await update({
				sessionUpdate: "tool_call",
				toolCallId: "tool-1",
				title: "Run ls",
				kind: "execute",
				status: "in_progress",
				rawInput: { command: "ls", token: "abc123" },
			});
			await update({
				sessionUpdate: "tool_call_update",
				toolCallId: "tool-1",
				status: "completed",
				content: [
					{ type: "content", content: { type: "text", text: "a.txt\nb.txt" } },
				],
			});
			await update({
				sessionUpdate: "tool_call",
				toolCallId: "tool-2",
				title: "Edit a.txt",
				kind: "edit",
				status: "completed",
				content: [
					{ type: "diff", path: "/work/a.txt", oldText: "old", newText: "new" },
				],
			});
			await update({
				sessionUpdate: "plan",
				entries: [
					{ content: "Look around", priority: "high", status: "completed" },
					{ content: "Edit file", priority: "medium", status: "in_progress" },
				],
			});
			await update({
				sessionUpdate: "usage_update",
				used: 10,
				size: 1000,
				cost: { amount: 0.25, currency: "USD" },
			});
			await say(
				`Done. model=${current.model} thought=${current.thought} sets=${sets.join(",") || "none"} picker=${picker} fs=${advertisedFs}`,
			);
			return {
				stopReason: "end_turn",
				usage: { totalTokens: 15, inputTokens: 10, outputTokens: 5 },
			};
		},
	}),
	ndJsonStream(
		Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
		Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
	),
);
await conn.closed;
process.exit(0);
