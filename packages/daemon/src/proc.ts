/**
 * Hardened subprocess runner v2.
 *
 * Every invocation has a timeout; there is no unbounded default. Output is
 * capped per stream and tail-kept (errors live at the end). On timeout the
 * whole process group gets SIGTERM, then SIGKILL 5 s later.
 */

export interface ProcOpts {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	input?: string;
	/** DEFAULT 60_000. 0/Infinity are rejected: pass an explicit finite budget. */
	timeoutMs?: number;
	/** DEFAULT 4 MiB per stream, tail-kept (head dropped, marker inserted). */
	maxOutputBytes?: number;
	signal?: AbortSignal;
}

export interface ProcResult {
	/** null when the process died from a signal (timeout/abort kill). */
	exitCode: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	truncated: boolean;
	/** Set when the process died from a signal, whether or not we sent it (timeout/abort, SIGSEGV, OOM-kill). null when it ran to an exit code. `timedOut` says if it was deliberate. */
	signalCode: NodeJS.Signals | null;
}

export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
export const TRUNCATION_MARKER = "[…truncated…]\n";

const SIGKILL_GRACE_MS = 5_000;

/** Rolling tail buffer: keeps at most `cap` bytes, dropping from the head. */
class TailBuffer {
	private chunks: Uint8Array[] = [];
	private total = 0;
	truncated = false;

	constructor(private readonly cap: number) {}

	push(chunk: Uint8Array): void {
		this.chunks.push(chunk);
		this.total += chunk.byteLength;
		while (this.total > this.cap) {
			const head = this.chunks[0] as Uint8Array;
			const excess = this.total - this.cap;
			if (head.byteLength <= excess) {
				this.chunks.shift();
				this.total -= head.byteLength;
			} else {
				this.chunks[0] = head.subarray(excess);
				this.total -= excess;
			}
			this.truncated = true;
		}
	}

	toString(): string {
		const joined = new Uint8Array(this.total);
		let off = 0;
		for (const c of this.chunks) {
			joined.set(c, off);
			off += c.byteLength;
		}
		const text = new TextDecoder().decode(joined);
		return this.truncated ? TRUNCATION_MARKER + text : text;
	}
}

async function drain(
	stream: ReadableStream<Uint8Array>,
	into: TailBuffer,
): Promise<void> {
	// A reader loop rather than `for await`: ReadableStream is only async-
	// iterable under Node/Bun libs, and this module is also typechecked in the
	// app build where the DOM lib's ReadableStream has no asyncIterator.
	const reader = stream.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value) into.push(value);
		}
	} catch {
		// stream torn down by a group kill: the tail we have is the result
	} finally {
		reader.releaseLock();
	}
}

export async function runProc(
	argv: string[],
	opts: ProcOpts = {},
): Promise<ProcResult> {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		throw new RangeError(
			`runProc: timeoutMs must be a positive finite number, got ${timeoutMs}`,
		);
	}
	const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
	if (!Number.isFinite(maxOutputBytes) || maxOutputBytes <= 0) {
		throw new RangeError(
			`runProc: maxOutputBytes must be a positive finite number, got ${maxOutputBytes}`,
		);
	}
	if (argv.length === 0) throw new Error("runProc: empty argv");

	// detached ⇒ the child setsid()s and leads its own process group, so a
	// negative-pid kill reaps everything it spawned.
	let proc: ReturnType<typeof Bun.spawn>;
	try {
		proc = Bun.spawn(argv, {
			cwd: opts.cwd,
			env: opts.env as Record<string, string | undefined> | undefined,
			detached: true,
			stdin:
				opts.input != null ? new TextEncoder().encode(opts.input) : "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
	} catch (e) {
		// Bun.spawn throws for a missing binary or cwd, but callers expect a
		// ProcResult (and probe paths that may not exist). Report like a shell: exit 127, message on stderr.
		return {
			exitCode: 127,
			stdout: "",
			stderr: e instanceof Error ? e.message : String(e),
			timedOut: false,
			truncated: false,
			signalCode: null,
		};
	}

	let timedOut = false;
	const timers: ReturnType<typeof setTimeout>[] = [];

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
	const terminate = (isTimeout: boolean) => {
		if (isTimeout) timedOut = true;
		killGroup("SIGTERM");
		timers.push(setTimeout(() => killGroup("SIGKILL"), SIGKILL_GRACE_MS));
	};

	timers.push(setTimeout(() => terminate(true), timeoutMs));

	const onAbort = () => terminate(false);
	if (opts.signal?.aborted) onAbort();
	else opts.signal?.addEventListener("abort", onAbort, { once: true });

	const out = new TailBuffer(maxOutputBytes);
	const err = new TailBuffer(maxOutputBytes);
	try {
		// Both are pipes by construction above; the cast is only needed because
		// wrapping the spawn in a try/catch widens Bun's inferred stdio types.
		await Promise.all([
			drain(proc.stdout as ReadableStream<Uint8Array>, out),
			drain(proc.stderr as ReadableStream<Uint8Array>, err),
			proc.exited,
		]);
	} finally {
		for (const t of timers) clearTimeout(t);
		opts.signal?.removeEventListener("abort", onAbort);
	}

	return {
		exitCode: proc.exitCode,
		stdout: out.toString(),
		stderr: err.toString(),
		timedOut,
		truncated: out.truncated || err.truncated,
		signalCode: proc.signalCode,
	};
}
