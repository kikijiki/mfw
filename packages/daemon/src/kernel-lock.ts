import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { FileSink } from "bun";

export class KernelLockError extends Error {
	constructor(
		readonly lockPath: string,
		message: string,
	) {
		super(message);
		this.name = "KernelLockError";
	}
}

export interface KernelLock {
	path: string;
	release(): Promise<void>;
}

export interface KernelLockOptions {
	/** Wait for the current owner, or fail immediately. */
	wait?: boolean;
	/** Bounds acquisition only. An omitted timeout permits an ordinary queue. */
	timeoutMs?: number;
	/** Diagnostic bytes only. The live kernel lock is the ownership proof. */
	metadata?: unknown;
	/** Human-facing description used when a fail-fast acquisition is refused. */
	busyMessage?: string;
}

async function firstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let text = "";
	try {
		for (;;) {
			const part = await reader.read();
			if (part.done) return text;
			text += decoder.decode(part.value, { stream: true });
			const newline = text.indexOf("\n");
			if (newline >= 0) return text.slice(0, newline);
		}
	} finally {
		reader.releaseLock();
	}
}

/**
 * Hold an advisory flock by keeping a helper's stdin pipe open. If this
 * process exits, the pipe closes, the helper exits, and the kernel releases
 * the lock. The lock file is deliberately persistent: unlinking it can let
 * contenders lock different inodes at the same pathname.
 */
export async function acquireKernelLock(
	rawPath: string,
	options: KernelLockOptions = {},
): Promise<KernelLock> {
	const lockPath = resolve(rawPath);
	await mkdir(dirname(lockPath), { recursive: true });
	const marker = `MFW_LOCKED_${crypto.randomUUID()}`;
	let proc: ReturnType<typeof Bun.spawn>;
	try {
		proc = Bun.spawn(
			[
				"flock",
				"--exclusive",
				...(options.wait ? [] : ["--nonblock"]),
				lockPath,
				"sh",
				"-c",
				'printf "%s\\n" "$1"; cat >/dev/null',
				"mfw-lock-holder",
				marker,
			],
			{ stdin: "pipe", stdout: "pipe", stderr: "pipe" },
		);
	} catch (error) {
		throw new KernelLockError(
			lockPath,
			`cannot start the lock helper for ${lockPath}: ${String(error)}`,
		);
	}

	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const acquired = firstLine(proc.stdout as ReadableStream<Uint8Array>);
		const output =
			options.timeoutMs === undefined
				? await acquired
				: await Promise.race([
						acquired,
						new Promise<never>((_, reject) => {
							timer = setTimeout(
								() => reject(new Error("lock acquisition timed out")),
								options.timeoutMs,
							);
						}),
					]);
		if (output !== marker) {
			const stderr = await new Response(
				proc.stderr as ReadableStream<Uint8Array>,
			).text();
			throw new Error(
				options.busyMessage ?? (stderr.trim() || "the lock is already held"),
			);
		}
	} catch (error) {
		(proc.stdin as FileSink).end();
		proc.kill();
		await proc.exited.catch(() => -1);
		throw new KernelLockError(
			lockPath,
			`cannot acquire ${lockPath}: ${error instanceof Error ? error.message : String(error)}`,
		);
	} finally {
		if (timer) clearTimeout(timer);
	}

	if (options.metadata !== undefined) {
		try {
			await writeFile(lockPath, `${JSON.stringify(options.metadata)}\n`, {
				mode: 0o600,
			});
		} catch (error) {
			(proc.stdin as FileSink).end();
			proc.kill();
			await proc.exited.catch(() => -1);
			throw new KernelLockError(
				lockPath,
				`acquired ${lockPath} but could not publish lock metadata: ${String(error)}`,
			);
		}
	}

	let released = false;
	return {
		path: lockPath,
		async release() {
			if (released) return;
			released = true;
			(proc.stdin as FileSink).end();
			let killTimer: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					proc.exited,
					new Promise<void>((resolve) => {
						killTimer = setTimeout(() => {
							proc.kill();
							resolve();
						}, 1_000);
					}),
				]);
				await proc.exited.catch(() => -1);
			} finally {
				if (killTimer) clearTimeout(killTimer);
			}
		},
	};
}
