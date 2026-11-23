import { join } from "node:path";
import type { ProjectDb } from "@mfw/db/client";
import { appendEvent, type EventBus, type StoredEvent } from "@mfw/db/eventlog";
import { type RunEgressRow, recordRunEgress } from "@mfw/db/run-egress";
import { engineKv } from "@mfw/db/schema";
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
	bus?: EventBus,
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
	if (stats.uploadBreach) {
		await recordEgressBreach(db, runId, stats.uploadBreach, observedAt, bus);
	}
	return rows.length;
}

/** The durable record of a run's breach, which the inbox reads. */
export const EGRESS_BREACH_KEY_PREFIX = "egress_breach:";

/** Once per run: the row is the guard, and the event commits with it. */
async function recordEgressBreach(
	db: ProjectDb,
	runId: string,
	breach: NonNullable<EgressStats["uploadBreach"]>,
	observedAt: Date,
	bus?: EventBus,
): Promise<void> {
	const stored = await db.transaction(
		async (tx): Promise<StoredEvent | null> => {
			const inserted = await tx
				.insert(engineKv)
				.values({
					key: `${EGRESS_BREACH_KEY_PREFIX}${runId}`,
					value: { runId, ...breach },
					updatedAt: observedAt,
				})
				.onConflictDoNothing()
				.returning({ key: engineKv.key });
			if (inserted.length === 0) return null;
			return appendEvent(
				tx,
				{
					type: "run.egress_budget_exceeded",
					runId,
					payload: {
						provenance: "host-observed",
						scope: breach.scope,
						destination: breach.destination,
						limitBytes: breach.limitBytes,
					},
				},
				observedAt.getTime(),
			);
		},
	);
	if (stored) bus?.publish([stored]);
}
