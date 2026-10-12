import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import {
	type AppServerRequest,
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

/**
 * Canonical bridge over `codex exec [resume <thread>] --json`: a brain turn is
 * one process, its prompt goes over stdin (`-`), and the thread id arrives in
 * the `thread.started` JSONL line. The driver's one `turn/start` maps to that
 * process; `turn/steer` is unsupported (a brain turn is not steered).
 */

const base = providerArgv(["codex", "exec", "--json"]);
let state: "new" | "initialized" | "session" | "active" | "shutdown" = "new";
let sessionId: string | undefined;
let turnId: string | undefined;
let ordinal = 0;
let model: string | undefined;
let cwd = process.cwd();
let proc: ChildProcessWithoutNullStreams | undefined;
let lastResultText: string | undefined;
let finished = false;

function event(value: Record<string, unknown>) {
	writeEnvelope(notify("event", value));
}
function str(v: unknown, fallback = "") {
	return typeof v === "string" ? v : fallback;
}
function num(v: unknown) {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** The thread id a resumed argv already carries: `exec resume <id>`. */
function resumedThread(): string | undefined {
	const i = base.indexOf("resume");
	return i >= 0 ? base[i + 1] : undefined;
}

function complete(status: "completed" | "failed", message?: string) {
	if (finished) return;
	finished = true;
	event({
		type: "session",
		provider: "codex-cli",
		sessionId,
		turnId,
		status,
		ordinal,
	});
	writeEnvelope(
		notify("turn/completed", {
			sessionId,
			turnId,
			status,
			...(message ? { error: { message } } : {}),
			resultText: lastResultText,
		}),
	);
	state = "session";
}

function translate(line: string) {
	let o: unknown;
	try {
		o = JSON.parse(line);
	} catch {
		return;
	}
	if (!isRecord(o)) return;
	const type = str(o.type);
	if (type === "thread.started") {
		const id = str(o.thread_id);
		if (id) {
			sessionId = id;
			// The real handle replaces the placeholder reported at session/start.
			event({
				type: "session",
				provider: "codex-cli",
				sessionId: id,
				turnId,
				status: "active",
				ordinal,
			});
		}
	} else if (type === "item.completed") {
		const item = isRecord(o.item) ? o.item : {};
		const kind = str(item.type);
		const id = str(item.id, "item");
		if (kind === "agent_message") {
			lastResultText = str(item.text);
			event({
				type: "message",
				role: "assistant",
				text: capText(str(item.text), 64 * 1024),
			});
		} else if (kind === "reasoning") {
			if (str(item.text).trim())
				event({ type: "thinking", text: capText(str(item.text), 64 * 1024) });
		} else if (kind === "mcp_tool_call" || kind === "command_execution") {
			const name =
				kind === "mcp_tool_call"
					? `${str(item.server)}.${str(item.tool)}`
					: "command";
			event({
				type: "tool_call",
				id,
				name,
				input: sanitize(
					kind === "mcp_tool_call" ? item.arguments : { command: item.command },
				),
			});
			event({
				type: "tool_result",
				id,
				ok: str(item.status) !== "failed",
				output: capText(
					JSON.stringify(
						sanitize(
							kind === "mcp_tool_call" ? item.result : item.aggregated_output,
						),
					) ?? "",
					16 * 1024,
				),
			});
		}
	} else if (type === "turn.completed") {
		const u = isRecord(o.usage) ? o.usage : {};
		event({
			type: "usage",
			inputTokens: num(u.input_tokens),
			outputTokens: num(u.output_tokens),
			cachedInputTokens: num(u.cached_input_tokens),
			turns: 1,
		});
		complete("completed");
	} else if (type === "turn.failed" || type === "error") {
		const e = isRecord(o.error) ? o.error : o;
		const message = str(e.message, "Codex turn failed");
		event({ type: "error", message, fatal: true });
		complete("failed", message);
	}
}

async function readLines(
	stream: AsyncIterable<Uint8Array>,
	fn: (line: string) => void,
) {
	let buf = "";
	const decoder = new TextDecoder();
	for await (const bytes of stream) {
		buf += decoder.decode(bytes, { stream: true });
		let at = buf.indexOf("\n");
		while (at >= 0) {
			const line = buf.slice(0, at).trim();
			buf = buf.slice(at + 1);
			if (line) fn(line);
			at = buf.indexOf("\n");
		}
	}
}

function startTurn(text: string, effort: string | undefined) {
	const argv = [...base];
	if (model && !argv.includes("-m")) argv.push("-m", model);
	if (effort)
		argv.push("-c", `model_reasoning_effort=${JSON.stringify(effort)}`);
	// `-` reads the prompt from stdin, so it never appears in argv.
	argv.push("-");
	const command = argv[0] ?? "codex";
	proc = spawn(command, argv.slice(1), {
		cwd,
		stdio: ["pipe", "pipe", "pipe"],
	});
	proc.stdin.end(text);
	void readLines(proc.stderr, (line) => {
		process.stderr.write(`${capText(line, 2048)}\n`);
	});
	void readLines(proc.stdout, translate);
	proc.on("exit", (code) => {
		// The process ended without a terminal JSONL line: the turn failed.
		if (!finished) {
			const message = `codex exec exited ${code ?? "by signal"} before turn completion`;
			event({ type: "error", message, fatal: true });
			complete("failed", message);
		}
	});
}

class StateError extends Error {
	constructor() {
		super("method is not valid in the current bridge state");
	}
}

async function handle(req: AppServerRequest) {
	try {
		const p = isRecord(req.params) ? req.params : {};
		switch (req.method) {
			case "initialize":
				if (state !== "new") throw new StateError();
				state = "initialized";
				writeEnvelope(
					response(req.id, {
						protocol: 1,
						provider: "codex-cli",
						capabilities: {
							steer: false,
							interrupt: true,
							approvals: false,
							plan: false,
							fileChanges: false,
							commandProgress: false,
							mcp: true,
						},
					}),
				);
				break;
			case "session/start":
				if (state !== "initialized") throw new StateError();
				cwd = str(p.cwd, cwd);
				model = typeof p.model === "string" ? p.model : undefined;
				// A resumed turn continues its thread; a fresh one learns the id from
				// `thread.started` and reports it then.
				sessionId = resumedThread() ?? `pending-${crypto.randomUUID()}`;
				state = "session";
				writeEnvelope(response(req.id, { sessionId }));
				break;
			case "turn/start": {
				if (state !== "session") throw new StateError();
				const input = textInput(p.input);
				if (!input) throw new Error("invalid text input");
				turnId = crypto.randomUUID();
				ordinal++;
				state = "active";
				finished = false;
				writeEnvelope(response(req.id, { turnId }));
				event({
					type: "session",
					provider: "codex-cli",
					sessionId,
					turnId,
					status: "active",
					ordinal,
				});
				startTurn(
					input.map((part) => part.text).join("\n\n"),
					typeof p.effort === "string" ? p.effort : undefined,
				);
				break;
			}
			case "turn/interrupt":
				if (state !== "active" || !proc) throw new StateError();
				proc.kill("SIGINT");
				writeEnvelope(response(req.id, {}));
				if (!finished) {
					finished = true;
					event({
						type: "session",
						provider: "codex-cli",
						sessionId,
						turnId,
						status: "interrupted",
						ordinal,
					});
					writeEnvelope(
						notify("turn/completed", {
							sessionId,
							turnId,
							status: "interrupted",
							resultText: lastResultText,
						}),
					);
				}
				state = "session";
				break;
			case "shutdown":
				state = "shutdown";
				writeEnvelope(response(req.id, {}));
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
				error instanceof Error ? error.message : String(error),
			),
		);
	}
}

await readLines(Bun.stdin.stream(), (line) => {
	const envelope = parseAppServerEnvelope(line);
	if (!envelope || !("id" in envelope) || !("method" in envelope)) {
		process.stderr.write("codex exec bridge: invalid canonical request\n");
		return;
	}
	void handle(envelope);
});
proc?.kill();
