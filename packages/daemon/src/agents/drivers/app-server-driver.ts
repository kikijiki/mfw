/** Shared mfw.app-server/v1 run driver. Provider bridges own vendor protocols. */
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FileSink } from "bun";
import {
	type ApprovalDecision,
	type AppServerEnvelope,
	type AppServerRequest,
	type AppServerResponse,
	parseAppServerEnvelope,
} from "../app-server-protocol.ts";
import { AgentEventSchema } from "../events.ts";

const runDir = process.argv[2];
if (!runDir) {
	console.error("usage: app-server-driver.ts <runDir>");
	process.exit(2);
}

const cfg = JSON.parse(readFileSync(join(runDir, "driver.json"), "utf8")) as {
	bridgeArgv: string[];
	providerArgv: string[];
	cwd: string;
	env?: Record<string, string>;
	model?: string;
	reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh" | "max";
	initialMessage: string;
	steer?: boolean;
	approvalMode?: "autonomous" | "interactive";
};
const eventsPath = join(runDir, "events.jsonl");
const controlsPath = join(runDir, "control.jsonl");
let seq = 0;
let terminal = false;
let fatal = false;
let lastResultText: string | undefined;

function emit(payload: Record<string, unknown>): void {
	const candidate = { ts: new Date().toISOString(), seq: seq++, ...payload };
	const parsed = AgentEventSchema.safeParse(candidate);
	if (!parsed.success) {
		process.stderr.write(
			`app-server driver: invalid event ${String(payload.type ?? "unknown")}\n`,
		);
		return;
	}
	appendFileSync(eventsPath, `${JSON.stringify(parsed.data)}\n`);
}

const child = Bun.spawn([...cfg.bridgeArgv, ...cfg.providerArgv], {
	cwd: cfg.cwd,
	env: { ...process.env, ...(cfg.env ?? {}) },
	stdin: "pipe",
	stdout: "pipe",
	stderr: "pipe",
});
const writer = child.stdin as FileSink;
let nextId = 1;
const pending = new Map<
	number,
	{ resolve: (value: unknown) => void; reject: (error: Error) => void }
>();
const serverRequests = new Map<string, AppServerRequest>();

function send(envelope: AppServerEnvelope): void {
	writer.write(`${JSON.stringify(envelope)}\n`);
	writer.flush?.();
}

function call(method: string, params: unknown): Promise<unknown> {
	const id = nextId++;
	send({ v: 1, id, method, params });
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pending.delete(id);
			reject(new Error(`${method} timed out`));
		}, 10_000);
		pending.set(id, {
			resolve: (value) => {
				clearTimeout(timer);
				resolve(value);
			},
			reject: (error) => {
				clearTimeout(timer);
				reject(error);
			},
		});
	});
}

function handleResponse(response: AppServerResponse): void {
	const waiter = pending.get(response.id);
	if (!waiter) return;
	pending.delete(response.id);
	if ("error" in response) {
		waiter.reject(
			new Error(`${response.error.code}: ${response.error.message}`),
		);
	} else waiter.resolve(response.result);
}

let completedResolve: ((value: Record<string, unknown>) => void) | null = null;
function handleEnvelope(envelope: AppServerEnvelope): void {
	if ("id" in envelope && !("method" in envelope)) {
		handleResponse(envelope);
		return;
	}
	if (!("method" in envelope)) return;
	if ("id" in envelope) {
		serverRequests.set(String(envelope.id), envelope);
		if (
			envelope.method === "approval/request" &&
			cfg.approvalMode !== "interactive"
		) {
			serverRequests.delete(String(envelope.id));
			send({ v: 1, id: envelope.id, result: { decision: "decline" } });
		}
		return;
	}
	if (envelope.method === "event") {
		if (typeof envelope.params === "object" && envelope.params !== null) {
			emit(envelope.params as Record<string, unknown>);
		}
		return;
	}
	if (envelope.method === "turn/completed") {
		const params =
			typeof envelope.params === "object" && envelope.params !== null
				? (envelope.params as Record<string, unknown>)
				: {};
		if (typeof params.resultText === "string")
			lastResultText = params.resultText;
		completedResolve?.(params);
		completedResolve = null;
	}
}

async function readLines(
	stream: ReadableStream<Uint8Array>,
	handle: (line: string) => void,
	failOnEof: boolean,
): Promise<void> {
	const decoder = new TextDecoder();
	let buffer = "";
	for await (const bytes of stream) {
		buffer += decoder.decode(bytes, { stream: true });
		let newline = buffer.indexOf("\n");
		while (newline >= 0) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			if (line) handle(line);
			newline = buffer.indexOf("\n");
		}
	}
	if (failOnEof && !terminal) {
		const error = new Error("provider bridge exited before turn completion");
		for (const waiter of pending.values()) waiter.reject(error);
		pending.clear();
		completedResolve?.({ status: "failed", error: { message: error.message } });
		fail(error.message);
	}
}

void readLines(
	child.stdout,
	(line) => {
		const envelope = parseAppServerEnvelope(line);
		if (envelope) handleEnvelope(envelope);
		else process.stderr.write("app-server driver: malformed bridge envelope\n");
	},
	true,
);
void readLines(
	child.stderr,
	(line) => process.stderr.write(`${line}\n`),
	false,
);

function fail(message: string): void {
	if (terminal) return;
	fatal = true;
	emit({ type: "error", message, fatal: true });
}

let controlOffset = 0;
let controlRemainder = "";
type Control =
	| { type: "steer"; message: string }
	| { type: "interrupt" }
	| { type: "approval"; requestId: string; decision: ApprovalDecision };

function drainControls(): Control[] {
	let text: string;
	try {
		text = readFileSync(controlsPath, "utf8");
	} catch {
		return [];
	}
	if (text.length < controlOffset) {
		controlOffset = 0;
		controlRemainder = "";
	}
	const fresh = controlRemainder + text.slice(controlOffset);
	controlOffset = text.length;
	const lines = fresh.split("\n");
	controlRemainder = lines.pop() ?? "";
	const out: Control[] = [];
	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			const value = JSON.parse(line) as Control;
			if (value.type === "steer" && typeof value.message === "string")
				out.push(value);
			else if (value.type === "interrupt") out.push(value);
			else if (
				value.type === "approval" &&
				typeof value.requestId === "string" &&
				["accept", "acceptForSession", "decline", "cancel"].includes(
					value.decision,
				)
			)
				out.push(value);
		} catch {
			process.stderr.write("app-server driver: ignored malformed control\n");
		}
	}
	return out;
}

function turnCompletion(): Promise<Record<string, unknown>> {
	return new Promise((resolve) => {
		completedResolve = resolve;
	});
}

try {
	const initialized = (await call("initialize", {
		client: { name: "mfw", version: "0.1.0" },
		protocol: 1,
	})) as Record<string, unknown>;
	const capabilities = (initialized.capabilities ?? {}) as Record<
		string,
		unknown
	>;
	const session = (await call("session/start", {
		cwd: cfg.cwd,
		model: cfg.model,
		reasoningEffort: cfg.reasoningEffort,
		approvalMode: cfg.approvalMode ?? "autonomous",
	})) as { sessionId?: unknown };
	if (typeof session.sessionId !== "string")
		throw new Error("bridge returned no session id");
	const sessionId = session.sessionId;
	emit({
		type: "hello",
		provider: String(initialized.provider ?? "unknown"),
		capabilities: {
			...capabilities,
			steer: cfg.steer !== false && capabilities.steer === true,
		},
	});
	emit({
		type: "session",
		provider: String(initialized.provider ?? "unknown"),
		sessionId,
		status: "started",
		ordinal: 0,
	});

	let nextInputs = [cfg.initialMessage];
	const retryInputs: string[] = [];
	while (nextInputs.length && !fatal) {
		const text = nextInputs.join("\n\n");
		const completion = turnCompletion();
		const started = (await call("turn/start", {
			sessionId,
			input: [{ type: "text", text }],
			effort: cfg.reasoningEffort,
		})) as { turnId?: unknown };
		if (typeof started.turnId !== "string")
			throw new Error("bridge returned no turn id");
		const turnId = started.turnId;
		emit({ type: "message", role: "user", text });
		let completed = false;
		let completionValue: Record<string, unknown> = {};
		void completion.then((value) => {
			completed = true;
			completionValue = value;
		});
		while (!completed && !fatal) {
			for (const control of drainControls()) {
				if (control.type === "steer" && cfg.steer !== false) {
					try {
						await call("turn/steer", {
							sessionId,
							expectedTurnId: turnId,
							input: [{ type: "text", text: control.message }],
						});
						emit({ type: "message", role: "user", text: control.message });
					} catch (error) {
						emit({
							type: "error",
							message: error instanceof Error ? error.message : String(error),
							fatal: false,
						});
						retryInputs.push(control.message);
					}
				} else if (control.type === "interrupt") {
					await call("turn/interrupt", { sessionId, turnId }).catch((error) =>
						fail(error instanceof Error ? error.message : String(error)),
					);
				} else if (control.type === "approval") {
					const request = serverRequests.get(control.requestId);
					if (request) {
						serverRequests.delete(control.requestId);
						send({
							v: 1,
							id: request.id,
							result: { decision: control.decision },
						});
					}
				}
			}
			await Bun.sleep(50);
		}
		if (fatal) break;
		await Bun.sleep(1500);
		nextInputs = [
			...retryInputs.splice(0),
			...drainControls()
				.filter(
					(c): c is Extract<Control, { type: "steer" }> => c.type === "steer",
				)
				.map((c) => c.message),
		];
		const status = String(completionValue.status ?? "failed");
		if (status === "failed") {
			const error = completionValue.error as { message?: unknown } | undefined;
			fail(
				typeof error?.message === "string"
					? error.message
					: "provider turn failed",
			);
		} else if (status === "interrupted") {
			terminal = true;
			emit({ type: "done", reason: "killed", resultText: lastResultText });
		}
	}
	if (!terminal) {
		terminal = true;
		emit({
			type: "done",
			reason: fatal ? "error" : "complete",
			resultText: lastResultText,
		});
	}
	await call("shutdown", {}).catch(() => {});
} catch (error) {
	fail(error instanceof Error ? error.message : String(error));
	if (!terminal) {
		terminal = true;
		emit({ type: "done", reason: "error", resultText: lastResultText });
	}
}

try {
	writer.end();
} catch {}
const code = await child.exited;
process.exit(fatal || code !== 0 ? 1 : 0);
