import type { Headline, HeadlineLink } from "@mfw/daemon/headlines";

import { humanizeToken } from "../../lib/format";
import { href } from "../../routes";

/**
 * The Lead page's pure rules (`/p/$project/`): which headline is this
 * project's, where each headline number leads from here, what the brain's
 * paragraph and standing intent read as, and the drill-down links.
 */

/** This project's mechanical headline, or null when it has none yet. */
export function headlineFor(
	headlines: readonly Headline[] | undefined,
	project: string,
): Headline | null {
	return headlines?.find((h) => h.project === project) ?? null;
}

/**
 * Where a headline number leads from Lead. "Needs you" is the section below
 * on this page, not Home's machine-wide list.
 */
export function leadTarget(project: string, link: HeadlineLink): string {
	switch (link) {
		case "landed":
			return href.repoCommits(project);
		case "needs_you":
			return `${href.project(project)}#needs-you`;
		case "main":
			return href.repo(project);
		case "budgets":
			return href.projectSettings(project);
	}
}

/** The longest paragraph Lead shows before "Read the full plan". */
export const PARAGRAPH_CHARS = 600;

/**
 * The brain's paragraph: the first paragraph of its latest plan, which is the
 * brain's own words (a brain-interpretation, never a host-observed fact).
 * `clipped` says the plan has more than is shown.
 */
export function brainParagraph(plan: string | null | undefined): {
	text: string;
	clipped: boolean;
} | null {
	const body = (plan ?? "").trim();
	if (body === "") return null;
	const first = (body.split(/\n\s*\n/)[0] ?? "").trim();
	const more = first.length < body.length;
	if (first.length <= PARAGRAPH_CHARS) return { text: first, clipped: more };
	return {
		text: `${first.slice(0, PARAGRAPH_CHARS).trimEnd()}…`,
		clipped: true,
	};
}

/** One brain intent as `brain.intents` returns it, reduced to what the sentence needs. */
export interface LeadIntent {
	taskId: string;
	tool: string;
	rationale: string;
	state: string | null;
}

/**
 * The brain's current intent: its newest standing action (`brain.intents` is
 * newest first), as one sentence. In shadow mode it is only proposed.
 */
export function intentSentence(
	intents: readonly LeadIntent[] | undefined,
): { text: string; taskId: string; proposed: boolean; more: number } | null {
	const top = intents?.[0];
	if (!top) return null;
	const proposed = top.state === "proposed";
	const what = humanizeToken(top.tool);
	return {
		text: `${proposed ? "Would " : "Next: "}${what} on ${top.taskId}${top.rationale ? ` — ${top.rationale}` : ""}`,
		taskId: top.taskId,
		proposed,
		more: Math.max(0, (intents?.length ?? 0) - 1),
	};
}

export interface DrillLink {
	label: string;
	to: string;
}

/** The one-click drill-down: everything that used to be the landing page. */
export function drillLinks(project: string): DrillLink[] {
	return [
		{ label: "Board", to: href.board(project) },
		{ label: "Flow", to: href.flow(project) },
		{ label: "Docs", to: href.docs(project) },
		{ label: "Repo", to: href.repo(project) },
		{ label: "Triggers", to: href.triggers(project) },
	];
}
