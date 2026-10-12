import { ulid } from "@mfw/db/ids";
import { brainTurns } from "@mfw/db/schema";
import { desc, eq } from "drizzle-orm";
import type { ActResult } from "../../src/brain-runtime/actions.ts";
import type { StoredBrainConfig } from "../../src/config.ts";
import type { ProjectServices } from "../../src/services.ts";

/**
 * Tests that exercise dispatch through a real boot need what production
 * needs: a brain route, and a spawn action. The route stub below is a valid
 * production config that can never wake the brain (`maxTurnsPerDay: 0`), so
 * no brain turn ever launches inside such a test; the spawn is made the way
 * the brain's tool call makes it, through the action service, in a turn row
 * the helper opens.
 */
export const STUB_BRAIN: StoredBrainConfig = {
	routes: [{ provider: "claude-cli", model: "stub" }],
	// Capped from the first wake: a stub route, not a live brain.
	maxTurnsPerDay: 0,
	heartbeatMin: 100_000,
};

/** The one live turn row a helper-made spawn acts in (created once per session). */
export async function openTurn(svc: ProjectServices): Promise<string> {
	let session = await svc.brainRuntime.currentSession();
	if (!session) {
		await svc.brainRuntime.tick();
		session = await svc.brainRuntime.currentSession();
	}
	if (!session) throw new Error("the project has no brain route configured");
	const [live] = await svc.handle.db
		.select()
		.from(brainTurns)
		.where(eq(brainTurns.status, "running"));
	if (live) return live.runId;
	const [last] = await svc.handle.db
		.select()
		.from(brainTurns)
		.where(eq(brainTurns.sessionId, session.id))
		.orderBy(desc(brainTurns.seq))
		.limit(1);
	const runId = ulid();
	await svc.handle.db.insert(brainTurns).values({
		runId,
		sessionId: session.id,
		seq: (last?.seq ?? 0) + 1,
		generation: session.generation,
		wakeClass: "human",
		eventsFrom: 0,
		eventsTo: 0,
		resumed: false,
		status: "running",
		startedAt: new Date(),
	});
	return runId;
}

let counter = 0;

/** `spawn` for one task, as the brain would; returns the accepted action. */
export async function brainSpawn(
	svc: ProjectServices,
	taskId: string,
	over: Record<string, unknown> = {},
): Promise<ActResult> {
	const turnRunId = await openTurn(svc);
	const r = await svc.brainRuntime.actions.act({
		turnRunId,
		tool: "spawn",
		args: {
			taskId,
			role: "implement",
			rationale: "test: start it",
			// Distinct calls in one turn are distinct actions.
			key: `t${++counter}`,
			...over,
		},
	});
	if (r.status !== "accepted") {
		throw new Error(
			`spawn of ${taskId} was ${r.status}: ${r.rejection?.code ?? ""} ${r.rejection?.message ?? ""}`,
		);
	}
	return r;
}
