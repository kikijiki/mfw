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

let proc: ChildProcessWithoutNullStreams | undefined;
let state: "new" | "initialized" | "session" | "active" | "shutdown" = "new";
let sessionId: string | undefined;
let turnId: string | undefined;
let ordinal = 0;
let lastResultText: string | undefined;
let model: string | undefined;
let cwd = process.cwd();

function event(value: Record<string, unknown>) {
	writeEnvelope(notify("event", value));
}
function str(v: unknown, fallback = "") {
	return typeof v === "string" ? v : fallback;
}
function num(v: unknown) {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function send(text: string) {
	if (!proc) throw new Error("Claude provider is not running");
	proc.stdin.write(
		`${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } })}\n`,
	);
}
function spawnProvider() {
	if (proc) return;
	const argv = providerArgv([
		"claude",
		"-p",
		"--input-format",
		"stream-json",
		"--output-format",
		"stream-json",
		"--verbose",
		"--include-partial-messages",
		"--replay-user-messages",
	]);
	const actual =
		model && !argv.includes("--model") ? [...argv, "--model", model] : argv;
	const command = actual[0] ?? "claude";
	proc = spawn(command, actual.slice(1), {
		cwd,
		stdio: ["pipe", "pipe", "pipe"],
	});
	void readLines(proc.stderr, (line) => {
		process.stderr.write(`${capText(line, 2048)}\n`);
	});
	void readLines(proc.stdout, translate);
}
function translate(line: string) {
	let o: unknown;
	try {
		o = JSON.parse(line);
	} catch {
		process.stderr.write("claude bridge: malformed provider JSON\n");
		return;
	}
	if (!isRecord(o)) return;
	const type = str(o.type);
	if (type === "assistant" || type === "user") {
		const message = isRecord(o.message) ? o.message : {};
		if (!Array.isArray(message.content)) return;
		for (const raw of message.content) {
			if (!isRecord(raw)) continue;
			if (raw.type === "text" && typeof raw.text === "string") {
				// `--replay-user-messages` echoes back exactly what `send()` just
				// wrote to stdin; the driver already emitted a `message`/user event
				// of its own at turn/start and turn/steer time, so a user-role echo
				// here would double it in the transcript. An assistant text part is
				// never an echo and always new.
				if (type === "assistant") {
					event({
						type: "message",
						role: "assistant",
						text: capText(raw.text, 64 * 1024),
					});
				}
			} else if (raw.type === "thinking" && str(raw.thinking).trim())
				event({
					type: "thinking",
					text: capText(str(raw.thinking), 64 * 1024),
				});
			else if (raw.type === "tool_use")
				event({
					type: "tool_call",
					id: str(raw.id),
					name: str(raw.name, "tool"),
					input: sanitize(raw.input),
				});
			else if (raw.type === "tool_result")
				event({
					type: "tool_result",
					id: str(raw.tool_use_id),
					ok: raw.is_error !== true,
					output: capText(
						typeof raw.content === "string"
							? raw.content
							: JSON.stringify(sanitize(raw.content)),
						16 * 1024,
					),
				});
		}
	} else if (type === "result") {
		if (typeof o.result === "string") lastResultText = o.result;
		const usage = isRecord(o.usage) ? o.usage : {};
		event({
			type: "usage",
			inputTokens: num(usage.input_tokens),
			outputTokens: num(usage.output_tokens),
			cachedInputTokens: num(usage.cache_read_input_tokens),
			costUsd: num(o.total_cost_usd),
			turns: num(o.num_turns),
		});
		if (o.is_error === true) {
			event({
				type: "error",
				message: str(o.result, "Claude turn failed"),
				fatal: true,
			});
			event({
				type: "session",
				provider: "claude-cli",
				sessionId,
				turnId,
				status: "failed",
				ordinal,
			});
			writeEnvelope(
				notify("turn/completed", {
					sessionId,
					turnId,
					status: "failed",
					error: { message: str(o.result, "Claude turn failed") },
					resultText: lastResultText,
				}),
			);
		} else {
			event({
				type: "session",
				provider: "claude-cli",
				sessionId,
				turnId,
				status: "completed",
				ordinal,
			});
			writeEnvelope(
				notify("turn/completed", {
					sessionId,
					turnId,
					status: "completed",
					resultText: lastResultText,
				}),
			);
		}
		state = "session";
	} else if (type === "rate_limit_event") {
		const info = isRecord(o.rate_limit_info)
			? o.rate_limit_info
			: isRecord(o.rate_limit)
				? o.rate_limit
				: {};
		const status = str(info.status, "unknown");
		const allowed = new Set(["allowed", "allowed_warning"]);
		event({
			type: "rate_limit",
			status,
			limited: !allowed.has(status),
			resetsAt: num(info.resets_at ?? info.resetsAt) ?? null,
			utilization: num(info.utilization) ?? null,
		});
	}
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
						provider: "claude-cli",
						capabilities: {
							steer: true,
							interrupt: true,
							approvals: false,
							plan: false,
							fileChanges: false,
							commandProgress: false,
							mcp: false,
						},
					}),
				);
				break;
			case "session/start":
				if (state !== "initialized") throw new StateError();
				cwd = str(p.cwd, cwd);
				model = typeof p.model === "string" ? p.model : undefined;
				sessionId = crypto.randomUUID();
				state = "session";
				spawnProvider();
				writeEnvelope(response(req.id, { sessionId }));
				break;
			case "turn/start": {
				if (state !== "session" || p.sessionId !== sessionId)
					throw new StateError();
				const input = textInput(p.input);
				if (!input) throw new Error("invalid text input");
				turnId = crypto.randomUUID();
				ordinal++;
				state = "active";
				writeEnvelope(response(req.id, { turnId }));
				event({
					type: "session",
					provider: "claude-cli",
					sessionId,
					turnId,
					status: "active",
					ordinal,
				});
				for (const part of input) send(part.text);
				break;
			}
			case "turn/steer": {
				if (
					state !== "active" ||
					p.sessionId !== sessionId ||
					p.expectedTurnId !== turnId
				)
					throw new StateError();
				const input = textInput(p.input);
				if (!input) throw new Error("invalid text input");
				for (const part of input) send(part.text);
				writeEnvelope(response(req.id, { turnId }));
				break;
			}
			case "turn/interrupt":
				if (
					state !== "active" ||
					p.sessionId !== sessionId ||
					p.turnId !== turnId ||
					!proc
				)
					throw new StateError();
				proc.kill("SIGINT");
				writeEnvelope(response(req.id, {}));
				event({
					type: "session",
					provider: "claude-cli",
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
				state = "session";
				break;
			case "shutdown":
				state = "shutdown";
				writeEnvelope(response(req.id, {}));
				proc?.stdin.end();
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
	if (!envelope || !("id" in envelope) || !("method" in envelope)) {
		process.stderr.write("claude bridge: invalid canonical request\n");
		return;
	}
	await handle(envelope);
});
proc?.kill();
