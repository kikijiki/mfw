import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
	acquireKernelLock,
	type KernelLock,
	KernelLockError,
} from "../kernel-lock.ts";

const HELD_KEY = Symbol.for("mfw.heldDaemonHomeLocks");
const globalScope = globalThis as Record<symbol, unknown>;
if (!globalScope[HELD_KEY]) globalScope[HELD_KEY] = new Set<string>();
const heldHomes = globalScope[HELD_KEY] as Set<string>;

export class DaemonLockError extends Error {
	constructor(
		readonly lockPath: string,
		message: string,
	) {
		super(message);
		this.name = "DaemonLockError";
	}
}

export interface DaemonLock {
	path: string;
	release(): Promise<void>;
}

/**
 * Hold a kernel advisory flock for the daemon lifetime. The helper owns the
 * locked descriptor and waits on a pipe whose writer is retained here; if the
 * daemon crashes the pipe closes and the kernel releases the lock with the
 * helper. The lock file itself is intentionally persistent: unlinking it after
 * unlock creates an inode race in which a new daemon can lock the old inode
 * while a third daemon creates and locks a different one at the same path.
 */
export async function acquireDaemonLock(
	mfwHome: string,
	input: { processBootId: string; timeoutMs?: number },
): Promise<DaemonLock> {
	const home = resolve(mfwHome);
	const lockPath = join(home, "daemon.lock");
	if (heldHomes.has(home)) {
		throw new DaemonLockError(
			lockPath,
			`this process already owns ${home}; shut the other orchestrator down first`,
		);
	}
	await mkdir(home, { recursive: true, mode: 0o700 });
	let lock: KernelLock;
	try {
		lock = await acquireKernelLock(lockPath, {
			timeoutMs: input.timeoutMs ?? 2_000,
			busyMessage: "another mfw daemon already owns this mfwHome",
			metadata: {
				pid: process.pid,
				processBootId: input.processBootId,
				acquiredAt: Date.now(),
			},
		});
	} catch (error) {
		throw new DaemonLockError(
			lockPath,
			error instanceof KernelLockError
				? error.message
				: `cannot acquire ${lockPath}: ${String(error)}`,
		);
	}
	heldHomes.add(home);
	let released = false;
	return {
		path: lockPath,
		async release() {
			if (released) return;
			released = true;
			heldHomes.delete(home);
			await lock.release();
		},
	};
}
