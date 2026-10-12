import type { InboxItem } from "@mfw/daemon/inbox";

import {
	type BrainState,
	type Look,
	lookForRun,
} from "../../components/agent/look";
import type { RunState } from "../../components/StatusPill";
import { nodeRef } from "../../lib/nodeRef";
import { href } from "../../routes";
import { shownActivity } from "../agents/activity";
import { brainGlyph, brainLine, brainNeedsMe } from "../brain/brain";
import { oldestFirst } from "../home/needs";

/**
 * The presence bar's model (design §3.1), pure. Per project: one dot per live
 * run coloured by its activity, collapsing to a count past `COLLAPSE_AFTER`,
 * plus how many inbox items name the project.
 *
 * The needs side is `inbox.list` and nothing else: the total equals the
 * shell badge and the Home queue by construction (`needsTotal` is the list
 * length, not a recount of anything else).
 */

/**
 * Where the bar's marks go: a project chip opens that project's Flow, and a
 * run dot opens Flow with that run selected (the docked inspector), since the
 * bar's question is "what is that agent doing, and where in the work".
 */
export const projectTarget = (project: string): string => href.flow(project);
export const runTarget = (project: string, runId: string): string =>
	href.flow(project, { node: nodeRef.run(runId) });

/** More live runs than this in one project render as a dot and ×N. */
export const COLLAPSE_AFTER = 5;

export interface PresenceRun {
	project: string;
	runId: string;
	state: string;
	activity?: unknown;
	taskId?: string | null;
	taskTitle?: string | null;
	label?: string;
	model?: string;
	startedAt: number;
}

export interface PresenceDot {
	runId: string;
	taskId: string | null;
	look: Look;
	/** One-line peek: task, activity, model. Age is added by the caller. */
	peek: string;
}

export interface PresenceProject {
	project: string;
	dots: PresenceDot[];
	runCount: number;
	/** More than `COLLAPSE_AFTER` live runs: draw a dot and ×runCount instead of dots. */
	collapsed: boolean;
	needs: number;
	/** The project's brain glyph state, or null when no brain is configured. */
	brain: BrainState | null;
	/** The brain's one-line status, for the glyph's tooltip. */
	brainLine: string | null;
	/** The brain's circuit is open: it needs a person. */
	brainStuck: boolean;
}

/** What presence needs of a project's brain (a row of `brain.states`). */
export interface PresenceBrain {
	project: string;
	enabled: boolean;
	state: "off" | "idle" | "turn" | "paused" | "failed";
	failures: number;
	error: string | null;
}

export interface PresenceView {
	projects: PresenceProject[];
	/** Every live run across projects. */
	runTotal: number;
	/** `inbox.list` length. */
	needsTotal: number;
	/** The inbox items, oldest first (the popover's order, and what `n` walks). */
	needs: InboxItem[];
}

function dotOf(run: PresenceRun): PresenceDot {
	const activity = shownActivity(run);
	const look = lookForRun({
		state: run.state as RunState,
		activity: activity ?? undefined,
	});
	const what = run.taskId ?? run.label ?? run.runId.slice(-8);
	const parts = [what, look.label, run.model].filter(Boolean);
	return {
		runId: run.runId,
		taskId: run.taskId ?? null,
		look,
		peek: parts.join(" · "),
	};
}

export function presenceView(
	runs: readonly PresenceRun[] | undefined,
	inbox: readonly InboxItem[] | undefined,
	brains?: readonly PresenceBrain[],
): PresenceView {
	const byProject = new Map<string, PresenceProject>();
	const slot = (project: string): PresenceProject => {
		let entry = byProject.get(project);
		if (!entry) {
			entry = {
				project,
				dots: [],
				runCount: 0,
				collapsed: false,
				needs: 0,
				brain: null,
				brainLine: null,
				brainStuck: false,
			};
			byProject.set(project, entry);
		}
		return entry;
	};
	// A brain that is thinking, paused or stuck is activity worth a chip of
	// its own even with no run live; an idle one only decorates a chip that
	// is there anyway.
	const brainOf = new Map((brains ?? []).map((b) => [b.project, b]));
	for (const b of brains ?? []) {
		if (brainGlyph(b) && b.state !== "idle") slot(b.project);
	}

	// Oldest run first so dots keep a stable position as new runs start.
	const ordered = [...(runs ?? [])].sort((a, b) => a.startedAt - b.startedAt);
	for (const run of ordered) {
		const entry = slot(run.project);
		entry.dots.push(dotOf(run));
		entry.runCount += 1;
	}
	for (const item of inbox ?? []) slot(item.project).needs += 1;

	const projects = [...byProject.values()];
	for (const p of projects) {
		p.collapsed = p.runCount > COLLAPSE_AFTER;
		const b = brainOf.get(p.project);
		if (b) {
			p.brain = brainGlyph(b);
			p.brainLine = brainLine(b);
			p.brainStuck = brainNeedsMe(b);
		}
	}
	// Projects that need you first, then by name.
	projects.sort(
		(a, b) => b.needs - a.needs || a.project.localeCompare(b.project),
	);

	const needs = oldestFirst(inbox ?? []);
	return {
		projects,
		runTotal: ordered.length,
		needsTotal: needs.length,
		needs,
	};
}
