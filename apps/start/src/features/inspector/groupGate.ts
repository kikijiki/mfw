import type { RouterOutputs } from "../../lib/trpc";

/**
 * The pure half of the group compare view: whether `Select winner` is
 * offered for an attempt and why not. The server is the authority: each
 * attempt arrives with `select`, the answer of the same validator that
 * would run if the button were pressed (invariants I1 and I2, `groups.get`).
 * `mirrorGate` is the same rule written down here, so the table can say
 * which gate an attempt is stuck on before the answer arrives and a
 * disagreement between the two is a test failure, not a surprise.
 */

export type GroupData = RouterOutputs["groups"]["get"];
export type GroupAttempt = GroupData["attempts"][number];

/** The codes the server's `select_winner` validator answers with. */
export type SelectBlock =
	| "group_closed"
	| "not_verified"
	| "run_not_settled"
	| "scope_outside"
	| "review_not_passed";

/**
 * The first gate an attempt fails, in the order the server checks them
 * (`vSelectWinner`): group still open, verified, settled, inside its scope,
 * and not reviewed down. `null` = nothing blocks it.
 */
export function mirrorGate(
	group: Pick<GroupData, "status">,
	attempt: Pick<GroupAttempt, "facts">,
): SelectBlock | null {
	const f = attempt.facts;
	if (group.status !== "open") return "group_closed";
	if (!f.verified) return "not_verified";
	if (!f.settled) return "run_not_settled";
	if (f.scopeOutside > 0) return "scope_outside";
	if (f.review && (f.review.status !== "ok" || f.review.verdict !== "merge")) {
		return "review_not_passed";
	}
	return null;
}

const SHORT: Record<SelectBlock, string> = {
	group_closed: "group already decided",
	not_verified: "not verified",
	run_not_settled: "still running",
	scope_outside: "changed files outside its scope",
	review_not_passed: "review did not allow it",
};

export interface SelectGate {
	enabled: boolean;
	/** The server's code when it refused, else the mirror's. */
	code: string | null;
	/** One short phrase for the disabled button's label. */
	short: string | null;
	/** The server's message, when it refused. */
	message: string | null;
	/** The server's fix text, when it gave one. */
	fix: string | null;
}

export function selectGate(
	group: Pick<GroupData, "status">,
	attempt: Pick<GroupAttempt, "facts" | "select">,
): SelectGate {
	if (attempt.select.ok) {
		return {
			enabled: true,
			code: null,
			short: null,
			message: null,
			fix: null,
		};
	}
	const r = attempt.select.rejection;
	const mirrored = mirrorGate(group, attempt);
	return {
		enabled: false,
		code: r.code,
		short: SHORT[r.code as SelectBlock] ?? (mirrored ? SHORT[mirrored] : null),
		message: r.message,
		fix: r.fix?.text ?? null,
	};
}

/** The run ids of an attempt group's live attempts: what "Stop all" stops. */
export function liveAttemptIds(group: Pick<GroupData, "attempts">): string[] {
	return group.attempts
		.filter((a) =>
			["starting", "running", "ended", "finalizing"].includes(a.state),
		)
		.map((a) => a.runId);
}

/** Total lines added and removed over a bundle's files. */
export function diffTotals(
	files: readonly {
		added: number;
		removed: number;
	}[],
): { added: number; removed: number; files: number } {
	const total = { added: 0, removed: 0, files: 0 };
	for (const f of files) {
		total.added += f.added;
		total.removed += f.removed;
		total.files += 1;
	}
	return total;
}
