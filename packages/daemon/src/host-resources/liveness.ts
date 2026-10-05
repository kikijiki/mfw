import { readFile } from "node:fs/promises";
import type {
	HostLease,
	LeaseLivenessInspector,
	LivenessEvidence,
} from "./types.ts";

export interface SessionLiveness {
	isAlive(sessionId: string, runId: string): Promise<boolean | null>;
}

/**
 * Read-only local liveness. No signal is sent. PID reuse is rejected by the
 * persisted Linux process start time; tmux support is an injected narrow seam
 * so the coordinator never reaches back into ProjectServices.
 */
export class SystemLeaseLiveness implements LeaseLivenessInspector {
	constructor(
		private readonly deps: {
			kernelBootId: string | null;
			now?: () => number;
			sessions?: SessionLiveness;
		},
	) {}

	async inspect(lease: HostLease): Promise<LivenessEvidence> {
		const checkedAt = (this.deps.now ?? Date.now)();
		const run = lease.run;
		if (!run) {
			return {
				status: "unavailable",
				checkedAt,
				kernelBootId: this.deps.kernelBootId,
				detail: "lease has no activated run identity",
			};
		}
		if (
			run.kernelBootId &&
			this.deps.kernelBootId &&
			run.kernelBootId !== this.deps.kernelBootId
		) {
			return {
				status: "absent",
				checkedAt,
				kernelBootId: this.deps.kernelBootId,
				detail: "kernel boot id changed",
			};
		}

		if (run.sessionId && this.deps.sessions) {
			const alive = await this.deps.sessions.isAlive(run.sessionId, run.runId);
			if (alive === true) {
				return {
					status: "live",
					checkedAt,
					kernelBootId: this.deps.kernelBootId,
				};
			}
			if (alive === false && run.pid == null) {
				return {
					status: "absent",
					checkedAt,
					kernelBootId: this.deps.kernelBootId,
					detail: "tmux session vanished",
				};
			}
		}

		if (run.pid == null || !run.processStartTime) {
			return {
				status: "unavailable",
				checkedAt,
				kernelBootId: this.deps.kernelBootId,
				detail: "no verifiable pid/start-time identity",
			};
		}
		try {
			const stat = await readFile(`/proc/${run.pid}/stat`, "utf8");
			// comm is parenthesized and may contain spaces or ')'; fields after the
			// final ')' start at field 3, so starttime (field 22) is offset 19.
			const close = stat.lastIndexOf(")");
			const fields =
				close >= 0
					? stat
							.slice(close + 1)
							.trim()
							.split(/\s+/)
					: [];
			const startTime = fields[19];
			if (!startTime) {
				return {
					status: "unknown",
					checkedAt,
					kernelBootId: this.deps.kernelBootId,
					detail: "could not read process start time",
				};
			}
			return {
				status: startTime === run.processStartTime ? "live" : "absent",
				checkedAt,
				kernelBootId: this.deps.kernelBootId,
				detail:
					startTime === run.processStartTime
						? undefined
						: "pid was reused by another process",
			};
		} catch (error) {
			const code = (error as { code?: string }).code;
			return {
				status: code === "ENOENT" ? "absent" : "unavailable",
				checkedAt,
				kernelBootId: this.deps.kernelBootId,
				detail:
					code === "ENOENT" ? "process vanished" : "process state inaccessible",
			};
		}
	}
}
