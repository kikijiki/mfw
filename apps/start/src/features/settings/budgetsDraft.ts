/**
 * Pure draft logic for the Budgets section (no React): one editable budget as
 * strings, its validation into the `budgets.set` input, and the one-line
 * "spent of limit" reading of a `budgets.list` row.
 */

export type BudgetKind = "agent" | "resource" | "brain";
export type BudgetScope = "project" | "machine";
export type BudgetUnit = "usd" | "tokens" | "slot_hours";
export type LiveRunPolicy = "stop" | "finish_turn";

export const BUDGET_WINDOWS = ["hour", "day", "week", "month"] as const;
export const BUDGET_UNITS: readonly BudgetUnit[] = [
	"usd",
	"tokens",
	"slot_hours",
];

/** The fields of a `budgets.list` row the draft needs. */
export interface BudgetRowLike {
	kind: BudgetKind;
	scope: BudgetScope;
	key: string;
	window: string;
	unit: BudgetUnit;
	limit: number;
	warnAt: number | null;
	liveRunPolicy: LiveRunPolicy;
	used: number;
	fraction: number;
	phase: "ok" | "warned" | "exhausted";
	windowResetsAt: number;
}

export interface BudgetDraft {
	scope: BudgetScope;
	kind: BudgetKind;
	key: string;
	window: string;
	unit: BudgetUnit;
	limit: string;
	/** Percent (1..100) or empty for no warning. */
	warnPercent: string;
	liveRunPolicy: LiveRunPolicy;
}

export interface BudgetSetInput {
	scope: BudgetScope;
	kind: BudgetKind;
	key: string;
	entry: {
		window: string;
		limitUsd?: number;
		limitTokens?: number;
		limitSlotHours?: number;
		warnAt?: number;
		liveRunPolicy?: LiveRunPolicy;
	};
}

export function blankDraft(kind: BudgetKind = "resource"): BudgetDraft {
	return {
		scope: "project",
		kind,
		key: kind === "brain" ? "brain" : "",
		window: "month",
		unit: kind === "agent" ? "tokens" : "usd",
		limit: "",
		warnPercent: "80",
		liveRunPolicy: "stop",
	};
}

export function draftOf(row: BudgetRowLike): BudgetDraft {
	return {
		scope: row.scope,
		kind: row.kind,
		key: row.key,
		window: row.window,
		unit: row.unit,
		limit: String(row.limit),
		warnPercent:
			row.warnAt === null ? "" : String(Math.round(row.warnAt * 100)),
		liveRunPolicy: row.liveRunPolicy,
	};
}

const WINDOW = /^(?:hour|day|week|month|[1-9][0-9]{0,3}[mhd])$/;
const KEY = /^[A-Za-z0-9._:@*-]{1,80}$/;

/** The `budgets.set` input for a draft; throws a sentence naming what to fix. */
export function validateBudgetDraft(draft: BudgetDraft): BudgetSetInput {
	const key = draft.kind === "brain" ? "brain" : draft.key.trim();
	if (!KEY.test(key)) {
		throw new Error(
			draft.kind === "agent"
				? "Account must be a provider key such as claude-cli or codex-cli@openrouter"
				: "Resource must be a key such as runpod:main or host:build-box (a trailing * matches a prefix)",
		);
	}
	const window = draft.window.trim();
	if (!WINDOW.test(window)) {
		throw new Error(
			"Window must be hour, day, week, month, or like 5h, 12h, 7d",
		);
	}
	const limit = Number(draft.limit);
	if (!Number.isFinite(limit) || limit <= 0) {
		throw new Error("Limit must be greater than zero");
	}
	if (draft.unit === "tokens" && !Number.isInteger(limit)) {
		throw new Error("A token limit must be a whole number");
	}
	let warnAt: number | undefined;
	if (draft.warnPercent.trim() !== "") {
		const pct = Number(draft.warnPercent);
		if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
			throw new Error("Warn at must be between 1 and 100 percent");
		}
		warnAt = pct / 100;
	}
	const unitField =
		draft.unit === "usd"
			? { limitUsd: limit }
			: draft.unit === "tokens"
				? { limitTokens: limit }
				: { limitSlotHours: limit };
	return {
		scope: draft.scope,
		kind: draft.kind,
		key,
		entry: {
			window,
			...unitField,
			...(warnAt === undefined ? {} : { warnAt }),
			...(draft.kind === "resource"
				? { liveRunPolicy: draft.liveRunPolicy }
				: {}),
		},
	};
}

export function formatAmount(n: number, unit: BudgetUnit): string {
	if (unit === "usd") return `$${n.toFixed(2)}`;
	if (unit === "slot_hours") return `${n.toFixed(1)} slot-h`;
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M tokens`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k tokens`;
	return `${Math.round(n)} tokens`;
}

/** "$110.00 of $100.00 (110%)". */
export function spendReading(row: BudgetRowLike): string {
	const pct = Math.round(row.fraction * 100);
	return `${formatAmount(row.used, row.unit)} of ${formatAmount(row.limit, row.unit)} (${pct}%)`;
}

export type BudgetTone = "ok" | "warn" | "critical";

export function budgetTone(row: Pick<BudgetRowLike, "phase">): BudgetTone {
	return row.phase === "exhausted"
		? "critical"
		: row.phase === "warned"
			? "warn"
			: "ok";
}

/** What exhaustion does for this kind, as the panel's one-line consequence. */
export function consequenceOf(
	row: Pick<BudgetRowLike, "kind" | "liveRunPolicy">,
): string {
	switch (row.kind) {
		case "agent":
			return "At the limit this account is held until the window resets; the brain may route to another harness.";
		case "brain":
			return "At the limit the brain is paused until the window resets.";
		case "resource":
			return row.liveRunPolicy === "stop"
				? "At the limit new work on it is held and live runs are stopped."
				: "At the limit new work on it is held and live runs stop after their turn.";
	}
}

/** Bar width as a 0..100 integer, clamped. */
export function barPercent(row: Pick<BudgetRowLike, "fraction">): number {
	return Math.max(0, Math.min(100, Math.round(row.fraction * 100)));
}
