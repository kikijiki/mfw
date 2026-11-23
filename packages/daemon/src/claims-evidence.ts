import type { ProjectDb, ProjectDbTx } from "@mfw/db/client";
import { events } from "@mfw/db/schema";
import { and, asc, inArray, or } from "drizzle-orm";
import {
	type ClaimAuthor,
	type ClaimSubject,
	claim,
	EVIDENCE_EVENT_TYPES,
	type GuardResult,
	guardText,
	HostEvidence,
	type RenderedClaim,
	renderClaim,
	type StrongWord,
	subjectIdsIn,
} from "./claims.ts";

/**
 * Reads the host's audit events into `HostEvidence`, and guards text with it.
 * A failed read fails closed: no evidence, so every strong word is marked.
 */

/** Ids looked up per read. A subject past the cap has no evidence, so stays unbacked. */
const MAX_SUBJECTS = 64;

type Db = ProjectDb | ProjectDbTx;

export async function loadHostEvidence(
	db: Db,
	texts: readonly string[],
	subjects: readonly (ClaimSubject | null | undefined)[] = [],
): Promise<HostEvidence> {
	const ids = [
		...new Set([
			...subjects.flatMap((s) => (s ? [s.id] : [])),
			...texts.flatMap(subjectIdsIn),
		]),
	].slice(0, MAX_SUBJECTS);
	const types = [...EVIDENCE_EVENT_TYPES];
	const global = inArray(events.type, ["main.red", "deployment.probed"]);
	const rows = await db
		.select({
			seq: events.seq,
			type: events.type,
			taskId: events.taskId,
			runId: events.runId,
			payload: events.payload,
		})
		.from(events)
		.where(
			and(
				inArray(events.type, types),
				ids.length > 0
					? or(global, inArray(events.taskId, ids), inArray(events.runId, ids))
					: global,
			),
		)
		.orderBy(asc(events.seq));
	return HostEvidence.fromEvents(rows);
}

async function evidenceOrNone(
	db: Db,
	texts: readonly string[],
	subjects: readonly (ClaimSubject | null | undefined)[],
): Promise<HostEvidence> {
	try {
		return await loadHostEvidence(db, texts, subjects);
	} catch {
		return HostEvidence.empty();
	}
}

/** Guard one text before it is stored or shown. */
export async function guardWithRecords(
	db: Db,
	text: string,
	opts: { author: ClaimAuthor; subject?: ClaimSubject | null },
): Promise<GuardResult> {
	const evidence = await evidenceOrNone(db, [text], [opts.subject]);
	return guardText(text, evidence, opts);
}

const taskSubject = (id: string | null | undefined): ClaimSubject | null =>
	id ? { kind: "task", id } : null;

/**
 * Guard brain-authored rows as they are read, so a row stored before this
 * guard, or whose evidence has since been withdrawn, still reads honestly.
 * The original stays in the row's `input`.
 */
export async function guardBrainRows<T extends object, K extends keyof T>(
	db: Db,
	rows: readonly T[],
	field: K,
): Promise<T[]> {
	const textOf = (r: T) => r[field] as unknown;
	const subjectOf = (r: T) =>
		taskSubject((r as { taskId?: string | null }).taskId);
	const texts = rows.flatMap((r) => {
		const v = textOf(r);
		return typeof v === "string" ? [v] : [];
	});
	const evidence = await evidenceOrNone(db, texts, rows.map(subjectOf));
	return rows.map((r) => {
		const v = textOf(r);
		if (typeof v !== "string") return r;
		const g = guardText(v, evidence, {
			author: "brain",
			subject: subjectOf(r),
		});
		return g.changed ? { ...r, [field]: g.text } : r;
	});
}

interface DecisionRowLike {
	role: string;
	kind?: string | null;
	action?: string | null;
	taskId?: string | null;
	reason: string | null;
	input: unknown;
}

/** The owner's own words are never marked: only model-written rows are. */
const isOwnerRow = (d: DecisionRowLike) =>
	d.role === "human" || d.kind === "override" || d.action === "brain.message";

/**
 * Decision rows as a view shows them: the reason, and a page's title and body,
 * guarded. The stored row keeps what was written.
 */
export async function guardDecisionRows<T extends DecisionRowLike>(
	db: Db,
	rows: readonly T[],
): Promise<T[]> {
	const pageOf = (d: T) =>
		d.action === "notify_human" && typeof d.input === "object" && d.input
			? (d.input as Record<string, unknown>)
			: null;
	const model = rows.filter((d) => !isOwnerRow(d));
	const evidence = await evidenceOrNone(
		db,
		model.flatMap((d) => {
			const page = pageOf(d);
			return [d.reason, page?.title, page?.body].filter(
				(t): t is string => typeof t === "string",
			);
		}),
		model.map((d) => taskSubject(d.taskId)),
	);
	return rows.map((d) => {
		if (isOwnerRow(d)) return d;
		const opts = {
			author: d.role === "brain" ? ("brain" as const) : ("agent" as const),
			subject: taskSubject(d.taskId),
		};
		const guard = (v: unknown) =>
			typeof v === "string" ? guardText(v, evidence, opts).text : v;
		const page = pageOf(d);
		return {
			...d,
			reason: d.reason === null ? null : (guard(d.reason) as string),
			...(page
				? {
						input: {
							...page,
							title: guard(page.title),
							body: guard(page.body),
						},
					}
				: {}),
		};
	});
}

/** The strong words the host can vouch for on one run, as chips for the run view. */
export async function hostClaimsForRun(
	db: Db,
	runId: string,
): Promise<RenderedClaim[]> {
	const subject: ClaimSubject = { kind: "run", id: runId };
	const evidence = await evidenceOrNone(db, [], [subject]);
	const words: StrongWord[] = ["verified", "merged", "fixed"];
	return words.flatMap((word) => {
		const backing = evidence.backing(word, subject);
		return backing ? [renderClaim(claim(word, subject, backing))] : [];
	});
}
