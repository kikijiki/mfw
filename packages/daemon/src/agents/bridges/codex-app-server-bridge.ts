import { spawn } from "node:child_process";
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

const argv = providerArgv(["codex", "app-server"]);
const command = argv[0] ?? "codex";
const proc = spawn(command, argv.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
let nativeId = 1;
let bridgeRequestId = 1_000_000_000;
let state: "new" | "initialized" | "session" | "active" | "shutdown" = "new";
let sessionId: string | undefined;
let turnId: string | undefined;
let turnOrdinal = 0;
let lastResultText: string | undefined;
let lastRateLimitFingerprint: string | undefined;
const itemText = new Map<string, string>();
const pendingNative = new Map<
	number,
	{ resolve: (v: unknown) => void; reject: (e: Error) => void }
>();
const pendingCanonical = new Map<number, (r: AppServerResponse) => void>();

function nativeSend(value: unknown): void {
	proc.stdin.write(`${JSON.stringify(value)}\n`);
}
function nativeCall(method: string, params: unknown): Promise<unknown> {
	const id = nativeId++;
	nativeSend({ id, method, params });
	return new Promise((resolve, reject) =>
		pendingNative.set(id, { resolve, reject }),
	);
}
function event(value: Record<string, unknown>): void {
	writeEnvelope(notify("event", value));
}
function str(v: unknown, fallback = ""): string {
	return typeof v === "string" ? v : fallback;
}
function num(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function idOf(item: Record<string, unknown>): string {
	return str(item.id, str(item.itemId, "item"));
}

async function handleCanonical(req: AppServerRequest): Promise<void> {
	try {
		const p = isRecord(req.params) ? req.params : {};
		switch (req.method) {
			case "initialize": {
				if (state !== "new") throw new StateError();
				await nativeCall("initialize", {
					clientInfo: isRecord(p.client)
						? p.client
						: { name: "mfw", version: "1" },
					capabilities: {},
				});
				nativeSend({ method: "initialized", params: {} });
				state = "initialized";
				writeEnvelope(
					response(req.id, {
						protocol: 1,
						provider: "codex-cli",
						capabilities: {
							steer: true,
							interrupt: true,
							approvals: true,
							plan: true,
							fileChanges: true,
							commandProgress: true,
							mcp: true,
						},
					}),
				);
				break;
			}
			case "session/start": {
				if (state !== "initialized") throw new StateError();
				const approvalPolicy =
					p.approvalMode === "interactive" ? "on-request" : "never";
				const result = await nativeCall("thread/start", {
					cwd: str(p.cwd),
					model: typeof p.model === "string" ? p.model : undefined,
					approvalPolicy,
					sandbox: "danger-full-access",
				});
				const thread =
					isRecord(result) && isRecord(result.thread)
						? result.thread
						: undefined;
				sessionId = thread && str(thread.id);
				if (!sessionId) throw new Error("thread/start returned no thread id");
				state = "session";
				writeEnvelope(response(req.id, { sessionId }));
				break;
			}
			case "turn/start": {
				if (state !== "session" || p.sessionId !== sessionId)
					throw new StateError();
				const input = textInput(p.input);
				if (!input) throw new Error("invalid text input");
				const result = await nativeCall("turn/start", {
					threadId: sessionId,
					input,
					effort: typeof p.effort === "string" ? p.effort : undefined,
				});
				const turn =
					isRecord(result) && isRecord(result.turn) ? result.turn : undefined;
				turnId = turn && str(turn.id);
				if (!turnId) throw new Error("turn/start returned no turn id");
				state = "active";
				writeEnvelope(response(req.id, { turnId }));
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
				const result = await nativeCall("turn/steer", {
					threadId: sessionId,
					expectedTurnId: turnId,
					input,
				});
				const returned =
					isRecord(result) && isRecord(result.turn)
						? str(result.turn.id)
						: turnId;
				writeEnvelope(response(req.id, { turnId: returned }));
				break;
			}
			case "turn/interrupt":
				if (
					state !== "active" ||
					p.sessionId !== sessionId ||
					p.turnId !== turnId
				)
					throw new StateError();
				await nativeCall("turn/interrupt", { threadId: sessionId, turnId });
				writeEnvelope(response(req.id, {}));
				break;
			case "shutdown":
				state = "shutdown";
				writeEnvelope(response(req.id, {}));
				proc.stdin.end();
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
class StateError extends Error {
	constructor() {
		super("method is not valid in the current bridge state");
	}
}

function complete(status: string, error?: unknown): void {
	if (!sessionId || !turnId || state !== "active") return;
	const canonical =
		status === "completed"
			? "completed"
			: status === "interrupted" || status === "cancelled"
				? "interrupted"
				: "failed";
	const params: Record<string, unknown> = {
		sessionId,
		turnId,
		status: canonical,
		resultText: lastResultText,
	};
	if (canonical === "failed")
		params.error = { message: str(error, "Codex turn failed") };
	event({
		type: "session",
		provider: "codex-cli",
		sessionId,
		turnId,
		status: canonical,
		ordinal: turnOrdinal,
	});
	writeEnvelope(notify("turn/completed", params));
	state = "session";
}

function translate(method: string, params: Record<string, unknown>): void {
	const item = isRecord(params.item) ? params.item : params;
	const itemType = str(item.type);
	if (method === "turn/started") {
		const t = isRecord(params.turn) ? params.turn : {};
		turnId ||= str(t.id);
		turnOrdinal = num(t.ordinal) ?? turnOrdinal + 1;
		event({
			type: "session",
			provider: "codex-cli",
			sessionId,
			turnId,
			status: "active",
			ordinal: turnOrdinal,
		});
	} else if (method === "turn/completed") {
		const t = isRecord(params.turn) ? params.turn : params;
		complete(str(t.status, "completed"), t.error);
	} else if (method.includes("agentMessage/delta")) {
		const id = str(params.itemId, idOf(item));
		itemText.set(id, (itemText.get(id) ?? "") + str(params.delta));
	} else if (method.includes("reasoning") && method.endsWith("delta")) {
		const text = str(params.delta);
		if (text.trim())
			event({ type: "thinking", text: capText(text, 64 * 1024) });
	} else if (method === "turn/plan/updated") {
		event({
			type: "plan",
			explanation: params.explanation,
			steps: sanitize(params.plan ?? params.steps ?? []),
		});
	} else if (method === "turn/diff/updated") {
		event({ type: "diff", turnId, diff: capText(str(params.diff), 64 * 1024) });
	} else if (method === "item/commandExecution/outputDelta") {
		event({
			type: "tool_progress",
			id: str(params.itemId),
			output: capText(str(params.delta), 16 * 1024),
		});
	} else if (method === "item/completed" || method === "item/started") {
		const phase = method.endsWith("completed") ? "completed" : "started";
		const id = idOf(item);
		if (itemType === "agentMessage" && phase === "completed") {
			const text = str(item.text, itemText.get(id) ?? "");
			itemText.delete(id);
			if (text) {
				lastResultText = text;
				event({
					type: "message",
					role: "assistant",
					text: capText(text, 64 * 1024),
				});
			}
		} else if (itemType === "reasoning") {
			const text = str(item.summary, str(item.text));
			if (text.trim())
				event({ type: "thinking", text: capText(text, 64 * 1024) });
		} else if (itemType === "commandExecution") {
			if (phase === "started")
				event({
					type: "tool_call",
					id,
					name: "command",
					input: sanitize({ command: item.command, cwd: item.cwd }),
				});
			else
				event({
					type: "tool_result",
					id,
					ok: item.exitCode === 0 || item.status === "completed",
					output: capText(
						str(item.aggregatedOutput, str(item.output)),
						16 * 1024,
					),
				});
		} else if (itemType === "fileChange") {
			const rawChanges = Array.isArray(item.changes) ? item.changes : [];
			const changes = rawChanges.map((change) => {
				const value = isRecord(change) ? change : {};
				const rawKind = str(value.kind, str(value.type)).toLowerCase();
				const kind = rawKind.includes("add")
					? "add"
					: rawKind.includes("delete") || rawKind.includes("remove")
						? "delete"
						: rawKind.includes("update") || rawKind.includes("modify")
							? "update"
							: "unknown";
				return {
					path: str(value.path, str(value.filePath, "unknown")),
					kind,
					diff:
						typeof value.diff === "string"
							? capText(value.diff, 64 * 1024)
							: undefined,
				};
			});
			event({
				type: "file_change",
				id,
				phase,
				status: item.status,
				changes,
			});
			if (phase === "started")
				event({
					type: "tool_call",
					id,
					name: "file_change",
					input: sanitize(item.changes),
				});
			else
				event({
					type: "tool_result",
					id,
					ok: item.status !== "failed",
					output: capText(
						JSON.stringify(sanitize(item.changes ?? [])),
						16 * 1024,
					),
				});
		} else if (itemType === "mcpToolCall") {
			event({
				type: "mcp_activity",
				id,
				server: item.server,
				tool: str(item.tool, str(item.name, "tool")),
				phase,
				input: sanitize(item.arguments ?? item.input),
				output: sanitize(item.result ?? item.output),
				ok: phase === "completed" ? item.status !== "failed" : undefined,
			});
			if (phase === "started")
				event({
					type: "tool_call",
					id,
					name: str(item.tool, "mcp"),
					input: sanitize(item.arguments ?? item.input),
				});
			else
				event({
					type: "tool_result",
					id,
					ok: item.status !== "failed",
					output: capText(
						JSON.stringify(sanitize(item.result ?? item.output ?? "")),
						16 * 1024,
					),
				});
		} else if (itemType && itemType !== "userMessage") {
			if (phase === "started")
				event({ type: "tool_call", id, name: itemType, input: sanitize(item) });
			else
				event({
					type: "tool_result",
					id,
					ok: item.status !== "failed",
					output: capText(JSON.stringify(sanitize(item)), 16 * 1024),
				});
		}
	} else if (method.includes("tokenUsage")) {
		const tokenUsage = isRecord(params.tokenUsage) ? params.tokenUsage : params;
		const usage = isRecord(tokenUsage.total) ? tokenUsage.total : tokenUsage;
		event({
			type: "usage",
			cumulative: true,
			inputTokens: num(usage.inputTokens ?? usage.input_tokens),
			outputTokens: num(usage.outputTokens ?? usage.output_tokens),
			cachedInputTokens: num(
				usage.cachedInputTokens ?? usage.cached_input_tokens,
			),
			reasoningOutputTokens: num(
				usage.reasoningOutputTokens ?? usage.reasoning_output_tokens,
			),
		});
	} else if (method.includes("rateLimit")) {
		const limits = isRecord(params.rateLimits) ? params.rateLimits : params;
		const windows = [limits.primary, limits.secondary]
			.filter(isRecord)
			.map((window) => ({
				usedPercent: num(window.usedPercent),
				resetsAt: num(window.resetsAt),
			}))
			.filter(
				(
					window,
				): window is { usedPercent: number; resetsAt: number | undefined } =>
					window.usedPercent !== undefined,
			);
		const mostUsed = windows.sort((a, b) => b.usedPercent - a.usedPercent)[0];
		// Account metadata without a usable quota window is not transcript
		// activity. Keep it on the raw protocol log instead of inventing a notice.
		if (mostUsed) {
			const utilization = Math.max(0, mostUsed.usedPercent / 100);
			const limited = mostUsed.usedPercent >= 100;
			const rawReset = mostUsed.resetsAt;
			const resetsAt =
				rawReset === undefined
					? null
					: rawReset < 1_000_000_000_000
						? rawReset * 1000
						: rawReset;
			const update = {
				type: "rate_limit",
				status: limited ? "limited" : "allowed",
				limited,
				resetsAt,
				utilization,
			};
			const fingerprint = JSON.stringify(update);
			if (fingerprint !== lastRateLimitFingerprint) {
				lastRateLimitFingerprint = fingerprint;
				event(update);
			}
		}
	} else if (method === "error") {
		event({
			type: "error",
			message: str(params.message, "Codex error"),
			fatal: true,
		});
	} else if (
		method.includes("warning") ||
		method.includes("reroute") ||
		method.includes("safety")
	) {
		event({
			type: "notice",
			category: method.includes("reroute")
				? "model_reroute"
				: method.includes("safety")
					? "safety"
					: "warning",
			message: str(params.message, method),
			metadata: sanitize(params),
		});
	}
}

async function serverRequest(
	id: number,
	method: string,
	params: Record<string, unknown>,
): Promise<void> {
	const approval = /requestApproval/i.test(method);
	if (!approval) {
		nativeSend({
			id,
			error: { code: -32601, message: "Unsupported server request" },
		});
		return;
	}
	const requestId = String(bridgeRequestId++);
	event({
		type: "approval",
		requestId,
		itemId: params.itemId,
		kind: method.includes("command")
			? "command"
			: method.includes("fileChange")
				? "file_change"
				: "other",
		status: "pending",
		summary: str(params.reason, str(params.command, "Approval requested")),
		details: sanitize(params),
	});
	const cid = Number(requestId);
	writeEnvelope({
		v: 1,
		id: cid,
		method: "approval/request",
		params: {
			sessionId,
			turnId,
			requestId,
			kind: method.includes("command")
				? "command"
				: method.includes("fileChange")
					? "file_change"
					: "other",
			summary: str(params.reason, str(params.command, "Approval requested")),
			details: sanitize(params),
		},
	});
	const answer = await new Promise<AppServerResponse>((resolve) =>
		pendingCanonical.set(cid, resolve),
	);
	const result =
		"result" in answer && isRecord(answer.result) ? answer.result : {};
	const decision = str(result.decision, "cancel");
	event({
		type: "approval",
		requestId,
		itemId: params.itemId,
		kind: method.includes("command") ? "command" : "file_change",
		status:
			decision === "accept" || decision === "acceptForSession"
				? "accepted"
				: decision === "decline"
					? "declined"
					: "cancelled",
		summary: "Approval resolved",
	});
	nativeSend({ id, result: { decision } });
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
void readLines(proc.stderr, (line) => {
	process.stderr.write(`${capText(line, 2048)}\n`);
});
void readLines(proc.stdout, async (line) => {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		process.stderr.write("codex bridge: malformed provider JSON\n");
		return;
	}
	if (!isRecord(value)) return;
	if (typeof value.id === "number" && !("method" in value)) {
		const pending = pendingNative.get(value.id);
		if (!pending) return;
		pendingNative.delete(value.id);
		if ("error" in value)
			pending.reject(
				new Error(
					str(
						isRecord(value.error) ? value.error.message : undefined,
						"provider RPC error",
					),
				),
			);
		else pending.resolve(value.result);
		return;
	}
	if (typeof value.id === "number" && typeof value.method === "string") {
		await serverRequest(
			value.id,
			value.method,
			isRecord(value.params) ? value.params : {},
		);
		return;
	}
	if (typeof value.method === "string")
		translate(value.method, isRecord(value.params) ? value.params : {});
});

await readLines(Bun.stdin.stream(), async (line) => {
	const envelope = parseAppServerEnvelope(line);
	if (!envelope) {
		process.stderr.write("codex bridge: invalid canonical envelope\n");
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
proc.kill();
