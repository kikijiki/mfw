/**
 * Project-scoped arbitration for expensive verification work.
 *
 * Foreground checks (run finalization and merge re-verification) are
 * serialized and always win. A background regression sweep may run only when
 * no foreground check is queued; the first foreground waiter aborts it and
 * waits for the child process to exit before starting. This prevents two full
 * test suites from sharing process names, tmux sockets and machine resources.
 */
export class VerificationCoordinator {
	private foregroundTail: Promise<void> = Promise.resolve();
	private foregroundWaiting = 0;
	private background:
		| { controller: AbortController; done: Promise<void> }
		| undefined;

	get backgroundActive(): boolean {
		return this.background !== undefined;
	}

	preemptBackground(): void {
		this.background?.controller.abort("foreground verification requested");
	}

	async foreground<T>(work: () => Promise<T>): Promise<T> {
		this.foregroundWaiting++;
		this.preemptBackground();
		const previous = this.foregroundTail;
		let release!: () => void;
		this.foregroundTail = new Promise<void>((resolve) => {
			release = resolve;
		});
		try {
			await previous;
			await this.background?.done;
			return await work();
		} finally {
			this.foregroundWaiting--;
			release();
		}
	}

	async backgroundWork<T>(
		work: (signal: AbortSignal) => Promise<T>,
	): Promise<{ status: "completed"; value: T } | { status: "busy" }> {
		if (this.background || this.foregroundWaiting > 0)
			return { status: "busy" };
		await this.foregroundTail;
		if (this.background || this.foregroundWaiting > 0)
			return { status: "busy" };

		const controller = new AbortController();
		let settle!: () => void;
		const done = new Promise<void>((resolve) => {
			settle = resolve;
		});
		this.background = { controller, done };
		try {
			return { status: "completed", value: await work(controller.signal) };
		} finally {
			this.background = undefined;
			settle();
		}
	}
}

export class VerificationPreemptedError extends Error {
	constructor() {
		super("background verification was preempted by foreground work");
		this.name = "VerificationPreemptedError";
	}
}
