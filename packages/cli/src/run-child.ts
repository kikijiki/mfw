import { constants } from "node:os";

/** Signals `mfw server` hands on to its child instead of dying and orphaning it. */
export const FORWARDED_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;

/**
 * Marks a process started by {@link runForwarding}. A process that sees it must
 * run its work directly and never spawn through here again, so a child that
 * resolves back to this entry point cannot recurse.
 */
export const CHILD_DEPTH_ENV = "MFW_CHILD_DEPTH";

/**
 * Runs `argv` as a foreground child with inherited stdio and resolves to the
 * code `mfw` should exit with.
 *
 * SIGTERM, SIGINT and SIGHUP sent to this process are forwarded to the child
 * (once each), and this process stays up until the child has exited, so the
 * server is never left running without its parent. The exit code is the
 * child's; a child killed by a signal gives 128 + the signal number, as a
 * shell reports it; a child that cannot start gives 127.
 */
export async function runForwarding(
	argv: string[],
	cwd?: string,
	err: (line: string) => void = (l) => console.error(l),
): Promise<number> {
	if (Number(process.env[CHILD_DEPTH_ENV] ?? 0) >= 1) {
		err(
			`mfw: refusing to start ${argv[0] ?? "a child"} from a process mfw already started (${CHILD_DEPTH_ENV} is set)`,
		);
		return 1;
	}
	let child: ReturnType<typeof Bun.spawn>;
	try {
		child = Bun.spawn(argv, {
			cwd,
			env: { ...process.env, [CHILD_DEPTH_ENV]: "1" },
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
		});
	} catch (e) {
		err(`mfw: cannot start ${argv[0] ?? "the child"}: ${(e as Error).message}`);
		return 127;
	}
	const handlers = FORWARDED_SIGNALS.map((sig) => {
		const handler = () => {
			try {
				child.kill(sig);
			} catch {
				// Already gone: the wait below reports how it ended.
			}
		};
		process.on(sig, handler);
		return [sig, handler] as const;
	});
	try {
		const code = await child.exited;
		const signal = child.signalCode;
		if (signal) return 128 + (constants.signals[signal] ?? 0);
		return code;
	} finally {
		for (const [sig, handler] of handlers) process.off(sig, handler);
	}
}
