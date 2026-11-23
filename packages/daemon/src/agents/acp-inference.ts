import { isRecord, parseAppServerEnvelope } from "./app-server-protocol.ts";

/**
 * In-process `mfw.app-server/v1` client for ONE prompt: spawns the ACP bridge
 * (policy `none`, so the agent has no tools), runs initialize -> session/start
 * -> turn/start, waits for `turn/completed` and returns the final assistant
 * text and usage. Used by the critic; the run driver is for task runs.
 */

export interface AcpOneShotOpts {
	argv: string[];
	cwd: string;
	env: Record<string, string>;
	model: string;
	reasoningEffort?: string;
	timeoutMs: number;
	signal?: AbortSignal;
}

export interface AcpOneShotResult {
	text: string;
	usage: Record<string, number>;
}

const KILL_GRACE_MS = 2_000;
const REQUEST_TIMEOUT_MS = 30_000;
const STDERR_TAIL = 2_000;

const USAGE_KEYS = [
	"inputTokens",
	"outputTokens",
	"cachedInputTokens",
	"reasoningOutputTokens",
	"costUsd",
	"turns",
] as const;

export async function runAcpOneShot(
	prompt: string,
	opts: AcpOneShotOpts,
): Promise<AcpOneShotResult> {
	const proc = Bun.spawn(opts.argv, {
		cwd: opts.cwd,
		// Exactly this: the prompt is agent-written, the daemon's env is not for it.
		env: opts.env,
		detached: true,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const killGroup = (sig: NodeJS.Signals) => {
		try {
			process.kill(-proc.pid, sig);
		} catch {
			try {
				proc.kill(sig);
			} catch {
				// already gone
			}
		}
	};

	let stderrTail = "";
	const usage: Record<string, number> = {};
	let lastAssistant = "";
	let fatalError: string | undefined;
	let nextId = 1;
	const pending = new Map<
		number,
		{ resolve: (v: unknown) => void; reject: (e: Error) => void }
	>();
	let completed: (v: Record<string, unknown>) => void = () => {};
	const completion = new Promise<Record<string, unknown>>((resolve) => {
		completed = resolve;
	});
	let closed = false;
	let stopped: Error | undefined;
	const failAll = (error: Error) => {
		for (const w of pending.values()) w.reject(error);
		pending.clear();
	};

	const send = (value: object) => {
		if (closed) return;
		try {
			proc.stdin.write(`${JSON.stringify({ v: 1, ...value })}\n`);
			proc.stdin.flush();
		} catch {
			// the process is gone; the exit path reports it
		}
	};
	const call = (method: string, params: unknown): Promise<unknown> => {
		const id = nextId++;
		send({ id, method, params });
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error(`acp agent: ${method} timed out`));
			}, REQUEST_TIMEOUT_MS);
			pending.set(id, {
				resolve: (v) => {
					clearTimeout(timer);
					resolve(v);
				},
				reject: (e) => {
					clearTimeout(timer);
					reject(e);
				},
			});
		});
	};

	const addUsage = (event: Record<string, unknown>) => {
		const cumulative = event.cumulative === true;
		for (const key of USAGE_KEYS) {
			const v = event[key];
			if (typeof v !== "number" || !Number.isFinite(v)) continue;
			usage[key] = cumulative ? v : (usage[key] ?? 0) + v;
		}
	};

	const handleLine = (line: string) => {
		const env = parseAppServerEnvelope(line) as Record<string, unknown> | null;
		if (!env) return;
		const method = env.method;
		const id = env.id;
		if (typeof method !== "string") {
			if (typeof id !== "number") return;
			const waiter = pending.get(id);
			if (!waiter) return;
			pending.delete(id);
			const err = env.error;
			if (isRecord(err)) {
				waiter.reject(
					new Error(`acp agent: ${String(err.message ?? "request failed")}`),
				);
			} else waiter.resolve(env.result);
			return;
		}
		if (typeof id === "number") {
			// Server request. Nothing here may grant anything: decline approvals.
			if (method === "approval/request")
				send({ id, result: { decision: "decline" } });
			else
				send({
					id,
					error: { code: "UNSUPPORTED", message: `unsupported: ${method}` },
				});
			return;
		}
		if (method === "turn/completed") {
			completed(isRecord(env.params) ? env.params : {});
			return;
		}
		if (method !== "event" || !isRecord(env.params)) return;
		const event = env.params;
		if (event.type === "message" && event.role === "assistant") {
			if (typeof event.text === "string") lastAssistant = event.text;
		} else if (event.type === "usage") addUsage(event);
		else if (event.type === "error" && event.fatal === true)
			fatalError =
				typeof event.message === "string" ? event.message : "acp agent error";
	};

	const pump = async (
		stream: ReadableStream<Uint8Array>,
		onLine: (line: string) => void,
	) => {
		const decoder = new TextDecoder();
		let buffer = "";
		const reader = stream.getReader();
		try {
			for (;;) {
				const { done, value: bytes } = await reader.read();
				if (done) break;
				buffer += decoder.decode(bytes, { stream: true });
				let nl = buffer.indexOf("\n");
				while (nl >= 0) {
					const line = buffer.slice(0, nl).trim();
					buffer = buffer.slice(nl + 1);
					if (line) onLine(line);
					nl = buffer.indexOf("\n");
				}
			}
		} catch {
			// stream torn down by a group kill
		} finally {
			reader.releaseLock();
		}
	};
	const outDone = pump(proc.stdout, handleLine);
	const errDone = pump(proc.stderr, (line) => {
		stderrTail = `${stderrTail}${line}\n`.slice(-STDERR_TAIL);
	});

	void proc.exited.then(() => {
		const detail = stderrTail.trim();
		const error = new Error(
			`acp agent exited before turn completion${detail ? `: ${detail}` : ""}`,
		);
		failAll(error);
		completed({ status: "failed", error: { message: error.message } });
	});

	// Hard stops: the budget and the caller's signal both kill the group.
	const stop = (message: string) => {
		if (stopped) return;
		stopped = new Error(message);
		failAll(stopped);
		completed({ status: "failed", error: { message } });
		killGroup("SIGTERM");
		setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS).unref();
	};
	const timer = setTimeout(() => stop("acp agent timed out"), opts.timeoutMs);
	const onAbort = () => stop("acp agent aborted");
	if (opts.signal?.aborted) onAbort();
	else opts.signal?.addEventListener("abort", onAbort, { once: true });

	try {
		await call("initialize", {
			client: { name: "mfw", version: "0.1.0" },
			protocol: 1,
		});
		const session = (await call("session/start", {
			cwd: opts.cwd,
			model: opts.model,
			reasoningEffort: opts.reasoningEffort,
			approvalMode: "autonomous",
		})) as { sessionId?: unknown };
		if (typeof session.sessionId !== "string")
			throw new Error("acp agent returned no session id");
		const started = (await call("turn/start", {
			sessionId: session.sessionId,
			input: [{ type: "text", text: prompt }],
			effort: opts.reasoningEffort,
		})) as { turnId?: unknown };
		if (typeof started.turnId !== "string")
			throw new Error("acp agent returned no turn id");
		const done = await completion;
		if (stopped) throw stopped;
		if (done.status !== "completed" || fatalError) {
			const err = isRecord(done.error) ? done.error.message : undefined;
			throw new Error(
				`acp agent turn failed: ${
					fatalError ?? (typeof err === "string" ? err : String(done.status))
				}`,
			);
		}
		const text =
			typeof done.resultText === "string" && done.resultText
				? done.resultText
				: lastAssistant;
		return { text, usage };
	} catch (error) {
		if (stopped) throw stopped;
		throw error;
	} finally {
		clearTimeout(timer);
		opts.signal?.removeEventListener("abort", onAbort);
		if (!stopped) await call("shutdown", {}).catch(() => {});
		closed = true;
		try {
			proc.stdin.end();
		} catch {
			// already closed
		}
		killGroup("SIGTERM");
		const killer = setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS);
		await Promise.race([
			proc.exited,
			new Promise((r) => setTimeout(r, KILL_GRACE_MS + 500)),
		]);
		clearTimeout(killer);
		await Promise.race([
			Promise.all([outDone, errDone]),
			new Promise((r) => setTimeout(r, 500)),
		]);
	}
}
