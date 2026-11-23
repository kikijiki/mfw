import type { ProjectDb, ProjectDbHandle, ProjectDbTx } from "@mfw/db/client";
import { engineKv } from "@mfw/db/schema";
import { eq } from "drizzle-orm";
import { isTainting, type Provenance } from "./decision-rights.ts";

/**
 * What each brain session has read, by provenance (DESIGN W2 "Untrusted input
 * to the brain"). The unit is the session, not the turn: a resumed session
 * still holds every earlier turn's text in its context, and its plan and notes
 * can carry that text forward, so taint is sticky for the session's life.
 *
 * Recorded BEFORE the content reaches the model, in `engine_kv` so a daemon
 * restart cannot forget it. A session with no record reads as untrusted.
 */

export const BRAIN_PROVENANCE_KEY = "brain_provenance";

/** Sessions kept; `everTainted` outlives pruning. */
const MAX_SESSIONS = 32;

interface Ledger {
	sessions: Record<string, { tags: Provenance[]; at: number }>;
	/** Any session of this project ever read untrusted text. */
	everTainted: boolean;
}

type Db = Pick<ProjectDbHandle, "db" | "withTx">;

async function read(db: ProjectDb | ProjectDbTx): Promise<Ledger> {
	const [row] = await db
		.select()
		.from(engineKv)
		.where(eq(engineKv.key, BRAIN_PROVENANCE_KEY));
	const v = row?.value as Partial<Ledger> | undefined;
	return { sessions: v?.sessions ?? {}, everTainted: v?.everTainted === true };
}

/** Add what a session is about to read. A no-op write is skipped. */
export async function recordProvenance(
	handle: Db,
	sessionId: string,
	tags: readonly Provenance[],
	now: number,
): Promise<void> {
	if (tags.length === 0) return;
	await handle.withTx(async (tx) => {
		const ledger = await read(tx);
		const cur = ledger.sessions[sessionId]?.tags ?? [];
		const merged = [...new Set([...cur, ...tags])];
		if (ledger.sessions[sessionId] && merged.length === cur.length) return;
		ledger.sessions[sessionId] = { tags: merged, at: now };
		if (merged.some(isTainting)) ledger.everTainted = true;
		const ids = Object.keys(ledger.sessions);
		if (ids.length > MAX_SESSIONS) {
			ids
				.filter((id) => id !== sessionId)
				.sort(
					(a, b) =>
						(ledger.sessions[a]?.at ?? 0) - (ledger.sessions[b]?.at ?? 0),
				)
				.slice(0, ids.length - MAX_SESSIONS)
				.forEach((id) => {
					delete ledger.sessions[id];
				});
		}
		const value = ledger as unknown as Record<string, unknown>;
		await tx
			.insert(engineKv)
			.values({ key: BRAIN_PROVENANCE_KEY, value, updatedAt: new Date(now) })
			.onConflictDoUpdate({
				target: engineKv.key,
				set: { value, updatedAt: new Date(now) },
			});
	});
}

/** What a session has read. Empty means no record: `decide` treats that as untrusted. */
export async function sessionProvenance(
	handle: Db,
	sessionId: string,
): Promise<Provenance[]> {
	return (await read(handle.db)).sessions[sessionId]?.tags ?? [];
}

/** Whether memory carried over from earlier sessions may hold untrusted text. */
export async function memoryTainted(handle: Db): Promise<boolean> {
	return (await read(handle.db)).everTainted;
}

interface TaskAuthorship {
	source?: string | null;
	createdBy?: string | null;
	editedBy?: string | null;
	/** Set once any API token has written to the task; never cleared. */
	tokenAuthoredBy?: string | null;
}

/** A token holder is not the owner, so anything a token wrote is untrusted. */
function tokenTouched(t: TaskAuthorship): boolean {
	return (
		!!t.tokenAuthoredBy ||
		!!t.createdBy?.startsWith("token:") ||
		!!t.editedBy?.startsWith("token:")
	);
}

/**
 * Who wrote a task. Only a task a person created through mfw, and no API token
 * has written to since, counts as the owner's: a board file can arrive through
 * a merge, so it does not.
 */
export function taskProvenance(t: TaskAuthorship): Provenance {
	if (t.createdBy?.startsWith("brain:") || tokenTouched(t)) return "agent";
	return t.source === "human" ? "owner_board" : "agent";
}

/** False only for a task known to come from the brain, a run or a token (`RightsFacts.ownerAuthored`). */
export function knownNonOwnerTask(t: TaskAuthorship): boolean {
	if (t.createdBy?.startsWith("brain:") || tokenTouched(t)) return true;
	return ["brain", "planner", "followup"].includes(t.source ?? "");
}
