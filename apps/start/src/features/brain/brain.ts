import type { BrainState, Look } from "../../components/agent/look";
import { BRAIN_LOOK } from "../../components/agent/look";
import type { RouterOutputs } from "../../lib/trpc";

/**
 * The project brain as the UI reads it (U3), pure. Brain decisions are
 * ordinary `decisions` rows (`role: brain`); what an act call came to
 * (`proposed`, `applied`, `rejected`) is mirrored on `output.status`. In
 * shadow mode every call is `proposed`: the fixed pipeline decided and acted,
 * the row is what the brain would have done.
 */

export type BrainDecision = RouterOutputs["brain"]["decisions"][number];
export type BrainTurn = RouterOutputs["brain"]["turns"][number];
export type BrainSessionView = RouterOutputs["brain"]["session"];
export type BrainStateRow = RouterOutputs["brain"]["states"][number];

/** The hint every surface shows when no brain is configured. */
export const BRAIN_OFF_HINT =
	"Brain: off — configure brain.routes in project settings";

export type ActionState =
	| "proposed"
	| "applied"
	| "accepted"
	| "rejected"
	| "failed";

const ACTION_STATES: ReadonlySet<string> = new Set([
	"proposed",
	"applied",
	"accepted",
	"rejected",
	"failed",
]);

export function actionStateOf(
	output: Record<string, unknown> | null | undefined,
): ActionState | null {
	const v = output?.status;
	return typeof v === "string" && ACTION_STATES.has(v)
		? (v as ActionState)
		: null;
}

/** Still only a proposal: the pipeline, not the brain, made it happen. */
export function isProposed(d: Pick<BrainDecision, "output">): boolean {
	return actionStateOf(d.output) === "proposed";
}

export interface Escalation {
	kind: string;
	title: string;
	body: string;
	options: string[];
	blocking: string[];
}

/** A `notify_human` that asks for a person (anything but `fyi`), or null. */
export function escalationOf(
	d: Pick<BrainDecision, "action" | "input" | "output">,
): Escalation | null {
	if (d.action !== "notify_human") return null;
	const state = actionStateOf(d.output);
	if (state === "rejected" || state === "failed") return null;
	const i = d.input as Record<string, unknown>;
	const kind = typeof i.kind === "string" ? i.kind : "fyi";
	if (kind === "fyi") return null;
	const strings = (v: unknown): string[] =>
		Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
	return {
		kind,
		title: typeof i.title === "string" ? i.title : "The brain needs you",
		body: typeof i.body === "string" ? i.body : "",
		options: strings(i.options),
		blocking: strings(i.blocking),
	};
}

/** The node an action is about: its run, else its task; null for plans and notes. */
export function decisionTarget(
	d: Pick<BrainDecision, "taskId" | "subjectRunId" | "input">,
): string | null {
	const i = d.input as Record<string, unknown>;
	if (typeof i.runId === "string") return `run:${i.runId}`;
	if (d.subjectRunId) return `run:${d.subjectRunId}`;
	const task =
		d.taskId ??
		(typeof i.taskId === "string"
			? i.taskId
			: typeof i.id === "string"
				? i.id
				: null);
	return task ? `task:${task}` : null;
}

export type Tone = "neutral" | "accent" | "ok" | "warn" | "critical" | "info";

/** The outcome chip of a decision: what became of it. */
export function outcomeChip(
	d: Pick<BrainDecision, "output" | "outcome" | "overriddenBy" | "kind">,
): { label: string; tone: Tone } {
	if (d.overriddenBy != null) return { label: "overridden", tone: "warn" };
	const state = actionStateOf(d.output);
	if (state === "rejected") return { label: "rejected", tone: "critical" };
	if (state === "failed") return { label: "failed", tone: "critical" };
	if (state === "proposed") return { label: "proposed", tone: "info" };
	const o = d.outcome as {
		final?: string;
		firstPass?: boolean;
		repairs?: number;
	} | null;
	if (o?.final) {
		if (o.final === "merged") {
			const repairs = o.repairs ?? 0;
			return {
				label: o.firstPass
					? "merged first pass"
					: repairs > 0
						? `repaired ×${repairs}`
						: "merged",
				tone: "ok",
			};
		}
		return {
			label: o.final.replace(/_/g, " "),
			tone: o.final === "abandoned" ? "warn" : "neutral",
		};
	}
	if (d.kind === "note" || d.kind === "plan") {
		return { label: d.kind, tone: "neutral" };
	}
	return {
		label: state === "applied" ? "pending" : "recorded",
		tone: "neutral",
	};
}

export const DECISION_FILTERS = [
	{ id: "escalations", label: "needs you" },
	{ id: "low", label: "low confidence" },
	{ id: "proposed", label: "proposed" },
	{ id: "rejected", label: "rejected" },
	{ id: "overridden", label: "overridden" },
] as const;
export type DecisionFilter = (typeof DECISION_FILTERS)[number]["id"];

export function matchesFilter(d: BrainDecision, f: DecisionFilter): boolean {
	switch (f) {
		case "escalations":
			return escalationOf(d) !== null;
		case "low":
			return d.confidence === "low";
		case "proposed":
			return isProposed(d);
		case "rejected":
			return actionStateOf(d.output) === "rejected";
		case "overridden":
			return d.overriddenBy != null;
	}
}

export function applyFilters(
	rows: readonly BrainDecision[],
	active: readonly DecisionFilter[],
): BrainDecision[] {
	if (active.length === 0) return [...rows];
	return rows.filter((d) => active.every((f) => matchesFilter(d, f)));
}

export interface TurnGroup {
	/** The turn's run id; null for decisions with no turn (legacy rows). */
	turnRunId: string | null;
	turn: BrainTurn | null;
	decisions: BrainDecision[];
}

/** Decisions grouped by the turn that made them, newest turn first, each group newest first. */
export function groupByTurn(
	rows: readonly BrainDecision[],
	turns: readonly BrainTurn[],
): TurnGroup[] {
	const byRun = new Map(turns.map((t) => [t.runId, t]));
	const groups: TurnGroup[] = [];
	const index = new Map<string | null, TurnGroup>();
	for (const d of [...rows].sort((a, b) => b.id - a.id)) {
		const key = d.turnRunId ?? null;
		let g = index.get(key);
		if (!g) {
			g = {
				turnRunId: key,
				turn: key ? (byRun.get(key) ?? null) : null,
				decisions: [],
			};
			index.set(key, g);
			groups.push(g);
		}
		g.decisions.push(d);
	}
	return groups;
}

/** What a person must see first: open escalations from the last `days` days, newest first. */
export function openEscalations(
	rows: readonly BrainDecision[],
	now: number,
	days = 7,
): { decision: BrainDecision; escalation: Escalation }[] {
	const since = now - days * 86_400_000;
	const out: { decision: BrainDecision; escalation: Escalation }[] = [];
	for (const d of rows) {
		if (d.ts.getTime() < since || d.overriddenBy != null) continue;
		const escalation = escalationOf(d);
		if (escalation) out.push({ decision: d, escalation });
	}
	return out.sort((a, b) => b.decision.id - a.decision.id);
}

/** The glyph state of a brain, or null when it is off (no glyph, only a hint). */
export function brainGlyph(
	row: Pick<BrainStateRow, "enabled" | "state"> | null | undefined,
): BrainState | null {
	if (!row?.enabled || row.state === "off") return null;
	return row.state;
}

export function brainLook(
	row: Pick<BrainStateRow, "enabled" | "state"> | null | undefined,
): Look | null {
	const s = brainGlyph(row);
	return s ? BRAIN_LOOK[s] : null;
}

/** The one-line status of a brain, for headers and tooltips. */
export function brainLine(
	row: Pick<BrainStateRow, "enabled" | "state" | "failures" | "error">,
): string {
	if (!row.enabled) return BRAIN_OFF_HINT;
	switch (row.state) {
		case "turn":
			return "Brain: thinking";
		case "paused":
			return "Brain: paused";
		case "failed":
			return `Brain: stuck after ${row.failures} failed turn${row.failures === 1 ? "" : "s"}${row.error ? ` (${row.error})` : ""}`;
		case "off":
			return BRAIN_OFF_HINT;
		default:
			return "Brain: idle";
	}
}

/** The brain asks for a person: its circuit is open. */
export function brainNeedsMe(
	row: Pick<BrainStateRow, "enabled" | "state"> | null | undefined,
): boolean {
	return row?.enabled === true && row.state === "failed";
}

/** A line diff between two plans (LCS), for the Plan tab. */
export function lineDiff(
	before: string,
	after: string,
): { kind: "same" | "add" | "del"; text: string }[] {
	const a = before.split("\n");
	const b = after.split("\n");
	const n = a.length;
	const m = b.length;
	const w = m + 1;
	const lcs = new Int32Array((n + 1) * w);
	const at = (i: number, j: number): number => lcs[i * w + j] ?? 0;
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			lcs[i * w + j] =
				a[i] === b[j]
					? at(i + 1, j + 1) + 1
					: Math.max(at(i + 1, j), at(i, j + 1));
		}
	}
	const out: { kind: "same" | "add" | "del"; text: string }[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			out.push({ kind: "same", text: a[i] as string });
			i++;
			j++;
		} else if (at(i + 1, j) >= at(i, j + 1)) {
			out.push({ kind: "del", text: a[i] as string });
			i++;
		} else {
			out.push({ kind: "add", text: b[j] as string });
			j++;
		}
	}
	while (i < n) out.push({ kind: "del", text: a[i++] as string });
	while (j < m) out.push({ kind: "add", text: b[j++] as string });
	return out;
}
