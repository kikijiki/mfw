import { join } from "node:path";
import { acquireKernelLock } from "./kernel-lock.ts";

/**
 * Per-key advisory lock, in-process and across processes, for read-modify-write
 * of board files. Uses kernel `flock` on a stable lock file, so process death
 * releases ownership. Every board writer (a CLI invocation, a long-running
 * consumer) must take the same lock.
 *
 * The lock file is deliberately never unlinked: a waiter could hold the old
 * inode while a successor locks a new one at the same path.
 */

export interface LockOptions {
	/** Give up waiting after this long. */
	timeoutMs?: number;
	log?: { warn: (o: Record<string, unknown>, m: string) => void };
}

export class KeyedLock {
	private readonly chains = new Map<string, Promise<unknown>>();
	private readonly timeoutMs: number;

	constructor(
		private readonly dir: string,
		private readonly opts: LockOptions = {},
	) {
		this.timeoutMs = opts.timeoutMs ?? 15_000;
	}

	/** Run `fn` holding the lock for `key`. Re-entrancy is NOT supported. */
	async with<T>(key: string, fn: () => Promise<T>): Promise<T> {
		const previous = this.chains.get(key) ?? Promise.resolve();
		const current = previous.then(
			() => this.exclusive(key, fn),
			() => this.exclusive(key, fn),
		);
		this.chains.set(key, current);
		try {
			return await current;
		} finally {
			if (this.chains.get(key) === current) this.chains.delete(key);
		}
	}

	private async exclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
		const lock = await acquireKernelLock(this.path(key), {
			wait: true,
			timeoutMs: this.timeoutMs,
			metadata: { pid: process.pid, at: Date.now(), key },
			busyMessage: `timed out waiting for the lock on ${key} (held by another process)`,
		});
		try {
			return await fn();
		} finally {
			await lock.release().catch((error) => {
				this.opts.log?.warn(
					{ key, error: String(error) },
					"failed to release a board lock cleanly",
				);
			});
		}
	}

	private path(key: string): string {
		// Keys are document ids, restricted to a safe id grammar; encode anyway
		// so a future caller cannot escape the dir.
		return join(this.dir, `${encodeURIComponent(key)}.lock`);
	}
}
