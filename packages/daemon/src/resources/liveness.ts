import { readFile } from "node:fs/promises";
import type { LeaseLiveness } from "./coordinator.ts";
import {
	type LeaseEvidence,
	REMOTE_RUN_SESSION_PREFIX,
	type ResourceLease,
} from "./types.ts";

export interface SessionLiveness {
	isAlive(sessionId: string, runId: string): Promise<boolean | null>;
}

/**
 * Read-only local liveness: no signal is sent, and PID reuse is rejected by
 * the persisted process start time. A remote run cannot be judged from here,
 * so it reads `unknown` and keeps its capacity until its project observes it.
 */
export class SystemLeaseLiveness implements LeaseLiveness {
	constructor(
		private readonly deps: {
			kernelBootId: string | null;
			sessions?: SessionLiveness;
		},
	) {}

	async inspect(lease: ResourceLease): Promise<LeaseEvidence> {
		const run = lease.run;
		if (!run) return "unknown";
		if (run.sessionId?.startsWith(REMOTE_RUN_SESSION_PREFIX)) return "unknown";
		if (
			run.kernelBootId &&
			this.deps.kernelBootId &&
			run.kernelBootId !== this.deps.kernelBootId
		) {
			return "absent";
		}
		if (run.sessionId && this.deps.sessions) {
			const alive = await this.deps.sessions.isAlive(run.sessionId, run.runId);
			if (alive === true) return "live";
			if (alive === false && run.pid == null) return "absent";
		}
		if (run.pid == null || !run.processStartTime) return "unknown";
		try {
			const stat = await readFile(`/proc/${run.pid}/stat`, "utf8");
			// comm may contain spaces or ')'; starttime is 19 fields past the last ')'.
			const close = stat.lastIndexOf(")");
			const fields =
				close >= 0
					? stat
							.slice(close + 1)
							.trim()
							.split(/\s+/)
					: [];
			const startTime = fields[19];
			if (!startTime) return "unknown";
			return startTime === run.processStartTime ? "live" : "absent";
		} catch (error) {
			return (error as { code?: string }).code === "ENOENT"
				? "absent"
				: "unknown";
		}
	}
}
