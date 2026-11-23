import { join } from "node:path";
import type { ProjectDb } from "@mfw/db/client";
import { type RunEgressRow, recordRunEgress } from "@mfw/db/run-egress";
import {
	type EgressStats,
	MAX_EGRESS_STATS_BYTES,
	parseEgressStats,
} from "./containment/egress-stats.ts";
import { readRegularFile } from "./containment/safe-file.ts";

/** One row per destination, allowed and denied traffic merged. */
export function egressRows(stats: EgressStats): RunEgressRow[] {
	const rows = new Map<string, RunEgressRow>();
	const row = (destination: string): RunEgressRow => {
		let r = rows.get(destination);
		if (!r) {
			r = {
				destination,
				bytesUp: 0,
				bytesDown: 0,
				connections: 0,
				denied: 0,
				lastDeniedReason: null,
			};
			rows.set(destination, r);
		}
		return r;
	};
	for (const [destination, a] of Object.entries(stats.allowed)) {
		Object.assign(row(destination), a);
	}
	for (const [destination, d] of Object.entries(stats.denied)) {
		const r = row(destination);
		r.denied = d.count;
		r.lastDeniedReason = d.lastReason;
	}
	return [...rows.values()];
}

/**
 * Copy a run's proxy counters into L1. The file sits in the host-only run root
 * and only the proxy writes it. A run with no egress has no file, and damaged
 * counters are skipped rather than recorded.
 */
export async function ingestRunEgress(
	db: ProjectDb,
	runId: string,
	runDir: string,
	observedAt: Date,
): Promise<number> {
	const read = await readRegularFile(
		join(runDir, "egress", "stats.json"),
		MAX_EGRESS_STATS_BYTES,
	);
	// A file over the cap is damage, not a prefix to parse.
	const whole =
		read && read.size <= MAX_EGRESS_STATS_BYTES
			? read.buffer.toString("utf8")
			: null;
	const stats = parseEgressStats(whole);
	if (!stats) return 0;
	const rows = egressRows(stats);
	await recordRunEgress(db, runId, rows, observedAt);
	return rows.length;
}
