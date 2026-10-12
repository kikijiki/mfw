import type { ProjectSummary } from "@mfw/daemon/project-summary";

import { formatDuration } from "../../lib/format";
import { nodeRef } from "../../lib/nodeRef";
import { href } from "../../routes";
import type { DispatchStatusLike } from "../dispatch/state";

/**
 * What the sidebar says about one project, pure: the single status badge (by
 * priority), the one-sentence tooltip, and the muted stats chips of the
 * expanded row. The collapsed rail and the expanded row read the same
 * model, so they cannot disagree.
 *
 * Badge priority: needs-you count, blocked dispatch, brain stuck or paused,
 * live runs, dispatch running. Nothing else earns a badge.
 */

export type RailTone = "ok" | "warn" | "critical" | "accent" | "neutral";

export type BadgeKind =
	| "needs"
	| "blocked"
	| "brain-stuck"
	| "brain-paused"
	| "live"
	| "running";

export interface RailBadge {
	kind: BadgeKind;
	/** Short text drawn in the badge: a count, or a one-character glyph. */
	text: string;
	tone: RailTone;
	/** The badge's own words, used inside the tooltip and as its accessible name. */
	label: string;
}

export interface RailBrain {
	enabled: boolean;
	state: "off" | "idle" | "turn" | "paused" | "failed";
}

export interface RailInput {
	name: string;
	dispatch: DispatchStatusLike | null | undefined;
	brain: RailBrain | null | undefined;
	/** Inbox items naming the project. */
	needs: number;
	/** Live worker runs. */
	liveRuns: number;
}

const plural = (n: number, one: string, many = `${one}s`) =>
	`${n} ${n === 1 ? one : many}`;

/** Why dispatch cannot make progress, or null when it is fine or manually stopped. */
export function blockedReason(
	dispatch: DispatchStatusLike | null | undefined,
): { text: string; tone: "warn" | "critical" } | null {
	if (!dispatch) return null;
	// A project nobody switched on is just stopped; blocked only matters once it should run.
	if (!dispatch.projectPlaying) return null;
	if (dispatch.blocked === "no_brain_route") {
		return { text: "no brain configured", tone: "warn" };
	}
	switch (dispatch.state) {
		case "held":
			return { text: "rate-limited", tone: "warn" };
		case "main_red":
			return { text: "main is red", tone: "critical" };
		case "board_suspended":
			return { text: "board suspended", tone: "critical" };
		default:
			return null;
	}
}

/** `dispatch running`, `dispatch stopped`, ... */
export function dispatchPhrase(
	dispatch: DispatchStatusLike | null | undefined,
): string | null {
	if (!dispatch) return null;
	const blocked = blockedReason(dispatch);
	if (blocked) return `dispatch blocked: ${blocked.text}`;
	switch (dispatch.state) {
		case "dispatching":
			return "dispatch running";
		case "stopped_global":
			return "dispatch waiting for mfw";
		default:
			return dispatch.projectPlaying ? "dispatch running" : "dispatch stopped";
	}
}

/** `brain idle`, `brain thinking`, `brain stuck`, ... or null when no brain is configured. */
export function brainPhrase(
	brain: RailBrain | null | undefined,
): string | null {
	if (!brain) return null;
	if (!brain.enabled || brain.state === "off") return "no brain configured";
	switch (brain.state) {
		case "turn":
			return "brain thinking";
		case "paused":
			return "brain paused";
		case "failed":
			return "brain stuck";
		default:
			return "brain idle";
	}
}

export function needsPhrase(n: number): string {
	return `${n} ${n === 1 ? "needs" : "need"} you`;
}

/** The one badge a project wears, or null when it is quiet. */
export function projectBadge(input: RailInput): RailBadge | null {
	if (input.needs > 0) {
		return {
			kind: "needs",
			text: input.needs > 99 ? "99+" : String(input.needs),
			tone: "accent",
			label: needsPhrase(input.needs),
		};
	}
	const blocked = blockedReason(input.dispatch);
	if (blocked) {
		return {
			kind: "blocked",
			text: "!",
			tone: blocked.tone,
			label: `dispatch blocked: ${blocked.text}`,
		};
	}
	if (input.brain?.enabled && input.brain.state === "failed") {
		return {
			kind: "brain-stuck",
			text: "!",
			tone: "critical",
			label: "brain stuck",
		};
	}
	if (input.brain?.enabled && input.brain.state === "paused") {
		return {
			kind: "brain-paused",
			text: "‖",
			tone: "warn",
			label: "brain paused",
		};
	}
	if (input.liveRuns > 0) {
		return {
			kind: "live",
			text: String(input.liveRuns),
			tone: "ok",
			label: plural(input.liveRuns, "live run"),
		};
	}
	if (dispatchPhrase(input.dispatch) === "dispatch running") {
		return { kind: "running", text: "", tone: "ok", label: "dispatch running" };
	}
	return null;
}

/** `dummy-todo: dispatch running, brain idle, 2 need you`, the tile's tooltip and name. */
export function projectTooltip(
	input: RailInput,
	summary?: ProjectSummary | null,
	now = Date.now(),
): string {
	const parts: string[] = [];
	const d = dispatchPhrase(input.dispatch);
	if (d) parts.push(d);
	const b = brainPhrase(input.brain);
	if (b) parts.push(b);
	if (input.liveRuns > 0) parts.push(plural(input.liveRuns, "live run"));
	if (input.needs > 0) parts.push(needsPhrase(input.needs));
	if (summary) {
		const t = summary.tasks;
		if (t.in_progress > 0) parts.push(`${t.in_progress} in progress`);
		if (t.review > 0) parts.push(`${t.review} in review`);
		if (t.blocked > 0) parts.push(`${t.blocked} blocked`);
		const ago = lastActivityPhrase(summary.lastActivityAt, now);
		if (parts.length === 0 && ago) parts.push(ago);
	}
	return parts.length > 0 ? `${input.name} — ${parts.join(", ")}` : input.name;
}

// ---------------------------------------------------------------------------
// The expanded row's second line
// ---------------------------------------------------------------------------

export type ChipKey =
	| "needs"
	| "progress"
	| "ready"
	| "blocked"
	| "review"
	| "sessions"
	| "worktrees"
	| "brain"
	| "spend";

export interface StatChip {
	key: ChipKey;
	/** Text drawn next to the icon. */
	text: string;
	/** Full sentence for the tooltip and accessible name. */
	label: string;
	tone: RailTone;
	/** Where a click goes. */
	to: string;
}

/** `$0.42`, `$12`, `<$0.01`. */
export function formatSpend(usd: number): string {
	if (usd <= 0) return "$0";
	if (usd < 0.01) return "<$0.01";
	if (usd < 10) return `$${usd.toFixed(2)}`;
	return `$${Math.round(usd)}`;
}

/** `3m ago`, `just now`, or null when nothing ever happened. */
export function lastActivityPhrase(
	at: number | null | undefined,
	now = Date.now(),
): string | null {
	if (at === null || at === undefined) return null;
	const delta = now - at;
	if (delta < 10_000) return "just now";
	return `${formatDuration(delta)} ago`;
}

/**
 * Non-zero chips only; an idle project shows no chips and the caller draws
 * `idleLine`. The brain chip appears only when it is doing something worth a
 * word (thinking, paused, stuck), as idle is the quiet default.
 */
export function statChips(
	project: string,
	summary: ProjectSummary | null | undefined,
	live?: { needs?: number; liveRuns?: number },
): StatChip[] {
	if (!summary) return [];
	const t = summary.tasks;
	const chips: StatChip[] = [];
	const board = href.board(project);
	const add = (c: StatChip) => chips.push(c);
	const needs = live?.needs ?? summary.needsYou;
	if (needs > 0) {
		add({
			key: "needs",
			text: String(needs),
			label: needsPhrase(needs),
			tone: "accent",
			to: href.flow(project, { f: "needs:me" }),
		});
	}
	if (t.in_progress > 0) {
		add({
			key: "progress",
			text: String(t.in_progress),
			label: `${plural(t.in_progress, "task")} in progress`,
			tone: "accent",
			to: board,
		});
	}
	if (t.ready > 0) {
		add({
			key: "ready",
			text: String(t.ready),
			label: `${t.ready} ready to start`,
			tone: "neutral",
			to: board,
		});
	}
	if (t.blocked > 0) {
		add({
			key: "blocked",
			text: String(t.blocked),
			label: `${plural(t.blocked, "task")} blocked`,
			tone: "warn",
			to: board,
		});
	}
	if (t.review > 0) {
		add({
			key: "review",
			text: String(t.review),
			label: `${plural(t.review, "task")} in review`,
			tone: "accent",
			to: `${board}?gate=review`,
		});
	}
	const liveRuns = live?.liveRuns ?? summary.sessions.live;
	if (liveRuns > 0) {
		const waiting = summary.sessions.waiting;
		add({
			key: "sessions",
			text: String(liveRuns),
			label: `${plural(liveRuns, "live session")}${waiting > 0 ? `, ${waiting} waiting on you` : ""}`,
			tone: "ok",
			to: href.flow(project, { f: "live" }),
		});
	}
	const wt = summary.worktrees;
	if (wt.active + wt.parked > 0) {
		add({
			key: "worktrees",
			text: String(wt.active + wt.parked),
			label: `${plural(wt.active + wt.parked, "worktree")} (${wt.active} active, ${wt.parked} parked)`,
			tone: "neutral",
			to: href.files(project),
		});
	}
	const b = summary.brain;
	if (
		b.enabled &&
		(b.state === "turn" || b.state === "paused" || b.state === "failed")
	) {
		add({
			key: "brain",
			text:
				b.state === "turn"
					? "thinking"
					: b.state === "paused"
						? "paused"
						: "stuck",
			label: `Brain: ${b.state === "turn" ? "thinking" : b.state === "paused" ? "paused" : "stuck"}`,
			tone:
				b.state === "failed"
					? "critical"
					: b.state === "paused"
						? "warn"
						: "accent",
			to: href.flow(project, { node: nodeRef.brain() }),
		});
	}
	if (summary.spendTodayUsd >= 0.01) {
		add({
			key: "spend",
			text: formatSpend(summary.spendTodayUsd),
			label: `${formatSpend(summary.spendTodayUsd)} spent today`,
			tone: "neutral",
			to: href.flow(project),
		});
	}
	return chips;
}

/** The quiet second line of a project with no chips: `idle · 3h ago`. */
export function idleLine(
	summary: ProjectSummary | null | undefined,
	now = Date.now(),
): string | null {
	if (!summary) return null;
	const ago = lastActivityPhrase(summary.lastActivityAt, now);
	return ago ? `idle · ${ago}` : "idle";
}

/** The trailing activity text after chips, e.g. `3m ago`; null when never. */
export function activityAgo(
	summary: ProjectSummary | null | undefined,
	now = Date.now(),
): string | null {
	return lastActivityPhrase(summary?.lastActivityAt, now);
}
