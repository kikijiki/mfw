import type { ProjectDb } from "@mfw/db/client";
import { runSpans, runs } from "@mfw/db/schema";
import { isTerminalRunState } from "@mfw/db/spans";
import { and, eq, inArray, isNull, like } from "drizzle-orm";

/**
 * Boot close of spans that can never close themselves. Live spans end with the
 * event that changes the value (`@mfw/db/spans`, same transaction as the
 * event), so a span stays open past a run only when its closing event was lost:
 * the run row is terminal (or gone) yet its lane never saw the end. Close those
 * at the run's `finished_at` (never before the span's own start).
 *
 * Runs that are still live are left alone: reconciliation transitions them,
 * and that transition closes the spans through the normal event path.
 */
export async function closeDanglingSpans(
	db: ProjectDb,
	now = Date.now(),
): Promise<number> {
	const open = await db
		.select({
			id: runSpans.id,
			subject: runSpans.subject,
			startTs: runSpans.startTs,
		})
		.from(runSpans)
		.where(and(isNull(runSpans.endTs), like(runSpans.subject, "run:%")));
	if (open.length === 0) return 0;

	const runIds = [...new Set(open.map((s) => s.subject.slice("run:".length)))];
	const rows: { id: string; state: string; finishedAt: Date | null }[] = [];
	for (let i = 0; i < runIds.length; i += 500) {
		rows.push(
			...(await db
				.select({
					id: runs.id,
					state: runs.state,
					finishedAt: runs.finishedAt,
				})
				.from(runs)
				.where(inArray(runs.id, runIds.slice(i, i + 500)))),
		);
	}
	const byId = new Map(rows.map((r) => [r.id, r]));

	let closed = 0;
	for (const span of open) {
		const run = byId.get(span.subject.slice("run:".length));
		if (run && !isTerminalRunState(run.state)) continue;
		const end = Math.max(
			span.startTs.getTime(),
			run?.finishedAt?.getTime() ?? now,
		);
		await db
			.update(runSpans)
			.set({ endTs: new Date(end) })
			.where(eq(runSpans.id, span.id));
		closed++;
	}
	return closed;
}
