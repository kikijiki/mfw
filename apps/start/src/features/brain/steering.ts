import { actionStateOf, type BrainDecision } from "./brain";

/**
 * Steering the brain (U6, pure): when a person can reverse a decision, how a
 * person's own rows read in the feed, and how the P6 outcome fold reads on a
 * decision. The brain keeps the final say; these are the choices a person has
 * when they decide to step in, and each one is audited server-side.
 */

/** A wake class as a person reads it: `human` is the owner's own message or override. */
export function wakeLabel(wakeClass: string): string {
	return wakeClass === "human" ? "woken by you" : wakeClass.replace(/_/g, " ");
}

/**
 * Whether a person can reverse this decision: a brain call whose effect was
 * applied or accepted, not already overridden, and not the brain's own memory
 * (a plan or note changes nothing outside it; message the brain instead).
 */
export function canOverride(
	d: Pick<BrainDecision, "role" | "kind" | "output" | "overriddenBy">,
): boolean {
	if (d.role !== "brain" || d.overriddenBy != null) return false;
	if (d.kind === "plan" || d.kind === "note" || d.kind === "rollover") {
		return false;
	}
	const state = actionStateOf(d.output);
	return state === "applied" || state === "accepted";
}

/** What a person did to the brain, as a feed row: an override of a call, or a message. */
export function humanRowOf(
	d: Pick<BrainDecision, "role" | "kind" | "action" | "input">,
): { label: string; detail: string | null } | null {
	if (d.role !== "human") return null;
	const i = d.input as Record<string, unknown>;
	if (d.kind === "override") {
		const n =
			typeof i.overriddenDecisionId === "number"
				? i.overriddenDecisionId
				: null;
		return {
			label:
				n != null
					? `you overrode decision ${n}`
					: `you overrode the brain: ${(d.action ?? "decision").replace(/[_.]/g, " ")}`,
			detail: typeof i.inverse === "string" ? i.inverse : null,
		};
	}
	if (d.action === "brain.message") {
		return {
			label: "you wrote to the brain",
			detail: typeof i.about === "string" ? `about ${i.about}` : null,
		};
	}
	return null;
}

/** "merged first pass · $0.42 · 12m": the P6 outcome fold, for an expanded row. */
export function outcomeSummary(
	outcome: Record<string, unknown> | null | undefined,
): string | null {
	const o = outcome as {
		final?: string;
		firstPass?: boolean;
		repairs?: number;
		reviewRounds?: number;
		costUsd?: number | null;
		durationMs?: number | null;
		chains?: number;
	} | null;
	if (!o?.final) return null;
	const parts: string[] = [];
	if (o.final === "merged") {
		const repairs = o.repairs ?? 0;
		const rounds = o.reviewRounds ?? 0;
		parts.push(
			o.firstPass
				? "merged first pass"
				: `merged after ${repairs} repair${repairs === 1 ? "" : "s"}${rounds ? `, ${rounds} review round${rounds === 1 ? "" : "s"}` : ""}`,
		);
	} else {
		parts.push(o.final.replace(/_/g, " "));
	}
	if (typeof o.costUsd === "number") parts.push(`$${o.costUsd.toFixed(2)}`);
	if (typeof o.durationMs === "number") {
		const m = Math.round(o.durationMs / 60_000);
		parts.push(m < 1 ? "<1m" : `${m}m`);
	}
	if ((o.chains ?? 1) > 1) parts.push(`${o.chains} attempts`);
	return parts.join(" · ");
}

/** The runs a decision started or acted on, from what it recorded. */
export function decisionRuns(
	d: Pick<BrainDecision, "output" | "input" | "subjectRunId">,
): string[] {
	const out = d.output as {
		result?: Record<string, unknown>;
		effects?: Record<string, unknown>;
	};
	const ids = new Set<string>();
	const add = (v: unknown) => {
		if (typeof v === "string") ids.add(v);
		else if (Array.isArray(v)) {
			for (const x of v) if (typeof x === "string") ids.add(x);
		}
	};
	add(out.result?.runIds);
	add(out.effects?.runIds);
	add(out.effects?.launched);
	add(out.result?.runId);
	add((d.input as Record<string, unknown>).runId);
	add(d.subjectRunId);
	return [...ids];
}

/** The note a person sends from a notify_human item to hand the choice back. */
export function letBrainDecideText(title: string): string {
	return `I will not answer this myself: "${title}". Decide it yourself with what you know, and tell me only if it is destructive or outward-facing.`;
}
