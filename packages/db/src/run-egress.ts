import { asc, eq, sql } from "drizzle-orm";
import type { ProjectDb } from "./client.ts";
import { RUN_EGRESS_PROVENANCE } from "./provenance.ts";
import { runEgress } from "./schema.ts";

export interface RunEgressRow {
	destination: string;
	bytesUp: number;
	bytesDown: number;
	connections: number;
	denied: number;
	lastDeniedReason: string | null;
}

export interface RunEgressTotals {
	provenance: typeof RUN_EGRESS_PROVENANCE;
	bytesUp: number;
	bytesDown: number;
	denied: number;
	destinations: RunEgressRow[];
}

/** Store absolute totals. A stale or restarted counter never lowers a stored one. */
export async function recordRunEgress(
	db: ProjectDb,
	runId: string,
	rows: readonly RunEgressRow[],
	observedAt: Date,
): Promise<void> {
	if (rows.length === 0) return;
	await db.transaction(async (tx) => {
		for (const row of rows) {
			await tx
				.insert(runEgress)
				.values({
					runId,
					...row,
					provenance: RUN_EGRESS_PROVENANCE,
					observedAt,
				})
				.onConflictDoUpdate({
					target: [runEgress.runId, runEgress.destination],
					set: {
						bytesUp: sql`max(${runEgress.bytesUp}, excluded.bytes_up)`,
						bytesDown: sql`max(${runEgress.bytesDown}, excluded.bytes_down)`,
						connections: sql`max(${runEgress.connections}, excluded.connections)`,
						denied: sql`max(${runEgress.denied}, excluded.denied)`,
						lastDeniedReason: sql`coalesce(excluded.last_denied_reason, ${runEgress.lastDeniedReason})`,
						observedAt,
					},
				});
		}
	});
}

export async function listRunEgress(
	db: ProjectDb,
	runId: string,
): Promise<RunEgressRow[]> {
	return db
		.select({
			destination: runEgress.destination,
			bytesUp: runEgress.bytesUp,
			bytesDown: runEgress.bytesDown,
			connections: runEgress.connections,
			denied: runEgress.denied,
			lastDeniedReason: runEgress.lastDeniedReason,
		})
		.from(runEgress)
		.where(eq(runEgress.runId, runId))
		.orderBy(asc(runEgress.destination));
}

/**
 * A run's host-observed traffic, or null if it has none. This is the basis for
 * future spend hard stops; nothing here accounts for spend.
 */
export async function runEgressTotals(
	db: ProjectDb,
	runId: string,
): Promise<RunEgressTotals | null> {
	const destinations = await listRunEgress(db, runId);
	if (destinations.length === 0) return null;
	return {
		provenance: RUN_EGRESS_PROVENANCE,
		bytesUp: destinations.reduce((n, d) => n + d.bytesUp, 0),
		bytesDown: destinations.reduce((n, d) => n + d.bytesDown, 0),
		denied: destinations.reduce((n, d) => n + d.denied, 0),
		destinations,
	};
}
