/**
 * The contract between the verifier and the sandbox that runs its checks. Kept
 * apart from check-sandbox.ts so the verifier does not load the launch path.
 */

import { dlopen, FFIType, ptr } from "bun:ffi";
import { closeSync, readSync } from "node:fs";
import type { ProcResult } from "../proc.ts";
import type { VerifyRole } from "./role-profiles.ts";

/** The check did not run. This says nothing about the code under test. */
export class CheckSandboxRefusal extends Error {
	constructor(
		readonly code: string,
		reason: string,
		readonly fix: string,
	) {
		super(reason);
		this.name = "CheckSandboxRefusal";
	}
}

export interface CheckRunRequest {
	role: VerifyRole;
	/** The disposable clone's work tree. */
	tree: string;
	command: string;
	prefix?: string;
	timeoutMs: number;
	maxOutputBytes: number;
	signal?: AbortSignal;
}

export type CheckRunner = (req: CheckRunRequest) => Promise<ProcResult>;

/** What the sandbox entry writes just before it execs the check. */
export const CHECK_STARTED = "started\n";

/**
 * A host-owned pipe. Non-blocking, so the read end can be asked once, after the
 * child has exited, without depending on when the write end closes.
 */
export function openStartPipe(): { read: number; write: number } {
	const O_NONBLOCK = 0o4000;
	const O_CLOEXEC = 0o2000000;
	const fds = new Int32Array(2);
	const libc = dlopen("libc.so.6", {
		pipe2: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
	});
	try {
		if (libc.symbols.pipe2(ptr(fds), O_NONBLOCK | O_CLOEXEC) !== 0) {
			throw new CheckSandboxRefusal(
				"no_start_pipe",
				"could not create the check's start pipe",
				"check the daemon's open file limit",
			);
		}
	} finally {
		libc.close();
	}
	return { read: fds[0] as number, write: fds[1] as number };
}

/** True when the entry reported in. Reads once, and closes the read end. */
export function checkStartedOn(readFd: number): boolean {
	const buf = Buffer.alloc(CHECK_STARTED.length + 1);
	try {
		const n = readSync(readFd, buf, 0, buf.length, null);
		return buf.subarray(0, n).toString() === CHECK_STARTED;
	} catch {
		// EAGAIN: nothing was ever written.
		return false;
	} finally {
		closeSync(readFd);
	}
}

/** Drain a stream, keeping the last `max` bytes. */
export async function drainTail(
	stream: AsyncIterable<Uint8Array>,
	max: number,
): Promise<{ text: string; truncated: boolean }> {
	const chunks: Uint8Array[] = [];
	let held = 0;
	let truncated = false;
	for await (const chunk of stream) {
		chunks.push(chunk);
		held += chunk.length;
		while (held > max && chunks.length > 1) {
			held -= (chunks.shift() as Uint8Array).length;
			truncated = true;
		}
	}
	let bytes = Buffer.concat(chunks);
	if (bytes.length > max) {
		bytes = bytes.subarray(bytes.length - max);
		truncated = true;
	}
	return { text: bytes.toString(), truncated };
}
