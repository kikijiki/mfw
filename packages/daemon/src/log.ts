import pino from "pino";

/**
 * Observability spine: one root logger, JSON to stdout
 * (pretty in dev). Every service gets `log.child({ svc })`; run-scoped work
 * binds `{ project, runId, taskId, step }`. No `console.*` in v2 code.
 *
 * Error-event policy: a catch block must (a) rethrow, (b) log with context
 * and bump a Health counter, or (c) carry a `// best-effort:` comment naming
 * why silence is correct.
 */

export type Logger = pino.Logger;

let root: Logger | null = null;

export function rootLogger(): Logger {
	if (!root) {
		const dev = process.env.NODE_ENV !== "production" && process.stdout.isTTY;
		root = pino({
			level: process.env.MFW_LOG_LEVEL ?? "info",
			base: undefined, // no pid/hostname noise for a single-user daemon
			...(dev
				? {
						transport: {
							target: "pino-pretty",
							options: { colorize: true, translateTime: "HH:MM:ss" },
						},
					}
				: {}),
		});
	}
	return root;
}

export function svcLogger(svc: string): Logger {
	return rootLogger().child({ svc });
}

/** Test hook: silence or replace the root logger. */
export function setRootLogger(logger: Logger): void {
	root = logger;
}

export function silentLogger(): Logger {
	return pino({ level: "silent" });
}
