import type {
	FleetBudget,
	FleetHealthState,
	FleetHold,
	FleetRunChip,
} from "@mfw/daemon/fleet";

import { type Look, lookForRun } from "../../components/agent/look";
import type { RunState } from "../../components/StatusPill";
import { formatCost, formatDuration, formatTokens } from "../../lib/format";
import { nodeRef } from "../../lib/nodeRef";
import { href } from "../../routes";
import { shownActivity } from "../agents/activity";

/**
 * Pure helpers for the Fleet page (design §9): where a run chip goes, how a
 * budget reads as a meter, and how a hold reads as "unavailable until".
 */

/**
 * Where a chip goes: its node in its own project's Flow, inspector docked.
 * A chip the registry has no row for (a lease whose run is unknown) has no
 * project to open, so it has no target.
 */
export function chipTarget(chip: {
	project: string | null;
	runId: string;
}): string | null {
	if (!chip.project) return null;
	return href.flow(chip.project, { node: nodeRef.run(chip.runId) });
}

const KNOWN_STATES = new Set([
	"starting",
	"running",
	"ended",
	"finalizing",
	"merging",
	"completed",
	"failed",
	"killed",
	"interrupted",
	"rate_limited",
	"needs_review",
	"finalize_error",
]);

/** The chip's agent state mark: activity while live, else the lifecycle state. */
export function chipLook(
	chip: Pick<FleetRunChip, "state" | "activity">,
): Look | null {
	if (!KNOWN_STATES.has(chip.state)) return null;
	return lookForRun({
		state: chip.state as RunState,
		activity: shownActivity(chip) ?? undefined,
	});
}

/** One-line tooltip: what it works on, its state, model. */
export function chipPeek(chip: FleetRunChip): string {
	const what = chip.taskId ?? chip.label ?? chip.runId.slice(-8);
	const look = chipLook(chip);
	return [
		chip.project ? `${chip.project}/${what}` : what,
		look?.label ?? "no registry row",
		chip.model,
	]
		.filter(Boolean)
		.join(" · ");
}

export type MeterTone = "ok" | "warn" | "critical";

export interface Meter {
	/** 0..100, capped; the bar's fill. */
	pct: number;
	label: string;
	tone: MeterTone;
}

function amount(unit: FleetBudget["unit"], v: number): string {
	if (unit === "usd") return formatCost(v);
	if (unit === "tokens") return formatTokens(Math.round(v));
	return `${v.toFixed(1)}h`;
}

/** `$12.00 / $30.00 day`, with the fill and a tone that follows the budget's own phase. */
export function budgetMeter(b: FleetBudget): Meter {
	const pct = Math.max(0, Math.min(100, Math.round(b.fraction * 100)));
	const tone: MeterTone =
		b.phase === "exhausted" ? "critical" : b.phase === "warned" ? "warn" : "ok";
	return {
		pct,
		label: `${amount(b.unit, b.used)} / ${amount(b.unit, b.limit)} ${b.window}`,
		tone,
	};
}

/** Slots in use against capacity, `4/8`. */
export function slotMeter(inUse: number, capacity: number): Meter {
	const pct =
		capacity > 0 ? Math.max(0, Math.min(100, (inUse / capacity) * 100)) : 100;
	return {
		pct: Math.round(pct),
		label: `${inUse}/${capacity}`,
		tone: capacity > 0 && inUse >= capacity ? "warn" : "ok",
	};
}

/** A wall-clock time for a reset; `timeZone` is for tests. */
export function formatClock(ts: number, timeZone?: string): string {
	return new Date(ts).toLocaleTimeString("en-GB", {
		hour: "2-digit",
		minute: "2-digit",
		timeZone,
	});
}

/**
 * The marker on a node that cannot take new work: `unavailable until 14:32
 * (in 14m)`. A hold with no reset (a person paused it) says so instead of
 * promising a time.
 */
export function unavailableLabel(
	hold: Pick<FleetHold, "until" | "reason" | "source"> | null,
	now: number,
	timeZone?: string,
): string | null {
	if (!hold) return null;
	if (hold.until === null) return `held: ${hold.reason}`;
	if (hold.until <= now) return null;
	return `unavailable until ${formatClock(hold.until, timeZone)} (in ${formatDuration(hold.until - now)})`;
}

export const HEALTH_LABEL: Record<FleetHealthState, string> = {
	ok: "ok",
	degraded: "degraded",
	unavailable: "unavailable",
	unknown: "not checked",
	disabled: "disabled",
};

export const HEALTH_TOKEN: Record<FleetHealthState, string> = {
	ok: "--mfw-ok",
	degraded: "--mfw-warn",
	unavailable: "--mfw-critical",
	unknown: "--mfw-fg-faint",
	disabled: "--mfw-fg-faint",
};

/** `$1.50 today · 100 tokens`. */
export function spendLine(spend: { usd: number; tokens: number }): string {
	return `${formatCost(spend.usd)} today · ${formatTokens(spend.tokens)} tokens`;
}

/** The budget's owner for display: a machine ceiling, or a project's own. */
export function budgetScopeLabel(b: Pick<FleetBudget, "scope" | "project">) {
	return b.scope === "machine" ? "all projects" : (b.project ?? "project");
}
