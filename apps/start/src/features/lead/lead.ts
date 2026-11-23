import type { Headline, HeadlineLink } from "@mfw/daemon/headlines";

import { humanizeToken } from "../../lib/format";
import { nodeRef } from "../../lib/nodeRef";
import type { RouterOutputs } from "../../lib/trpc";
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

/** The server's limit (`DIRECTION_MAX_CHARS`); a test keeps them equal. */
export const DIRECTION_CHARS = 500;

export type DirectionState =
	| "drafting"
	| "drafted"
	| "held"
	| "done"
	| "no_draft";

/** How a direction's status reads on Lead. */
export function directionBadge(
	status: DirectionState,
	received: boolean,
): { label: string; tone: "neutral" | "accent" | "ok" | "warn" } {
	switch (status) {
		case "drafting":
			return received
				? { label: "drafting", tone: "accent" }
				: { label: "waiting for the brain", tone: "neutral" };
		case "drafted":
			return { label: "drafted", tone: "accent" };
		case "held":
			return { label: "held for you", tone: "warn" };
		case "done":
			return { label: "done", tone: "ok" };
		case "no_draft":
			return { label: "no draft", tone: "neutral" };
	}
}

/** Poll only while something can still change on its own. */
export function directionsOpen(
	list: readonly { status: DirectionState }[] | undefined,
): boolean {
	return (list ?? []).some(
		(d) => d.status !== "done" && d.status !== "no_draft",
	);
}

/** The server's limit on a question; a test keeps them equal. */
export const CHAT_CHARS = 500;

type ChatEntryView = RouterOutputs["brain"]["chatThread"]["entries"][number];
export type ChatAnswerView = Extract<ChatEntryView, { kind: "answer" }>;
export type ChatCitationView = ChatAnswerView["citations"][number];

export interface ChatRow {
	id: string;
	question: string;
	answer: ChatAnswerView | null;
	directionGiven: boolean;
}

/** The append-only entries as question-and-answer rows, oldest first. */
export function chatRows(
	entries: readonly ChatEntryView[] | undefined,
): ChatRow[] {
	const list = entries ?? [];
	const answers = new Map<string, ChatAnswerView>();
	const given = new Set<string>();
	for (const e of list) {
		if (e.kind === "answer") answers.set(e.questionId, e);
		if (e.kind === "direction") given.add(e.answerId);
	}
	return list.flatMap((e) => {
		if (e.kind !== "question") return [];
		const answer = answers.get(e.id) ?? null;
		return [
			{
				id: e.id,
				question: e.text,
				answer,
				directionGiven: answer ? given.has(answer.id) : false,
			},
		];
	});
}

/** Where a citation leads. Ids go through the route builders, which encode them. */
export function citationLink(
	project: string,
	c: ChatCitationView,
): { to: string; label: string } {
	switch (c.kind) {
		case "task":
			return {
				to: href.board(project, { node: nodeRef.task(c.id) }),
				label: c.id,
			};
		case "run":
			return {
				to: href.node(project, nodeRef.run(c.id)),
				label: `run ${c.id.slice(-6)}`,
			};
		case "decision":
			return {
				to: href.node(project, nodeRef.decision(Number(c.id))),
				label: `decision ${c.id}`,
			};
		case "view":
			switch (c.id) {
				case "capacity":
					return { to: href.fleet(), label: "capacity" };
				case "needs_you":
					return {
						to: `${href.project(project)}#needs-you`,
						label: "needs you",
					};
				case "decisions":
					return {
						to: href.flow(project, { node: nodeRef.brain() }),
						label: "decisions",
					};
				default:
					return { to: href.flow(project), label: c.id };
			}
	}
}

/** What kind of answer this is, so the brain's words never read as a record. */
export function answerBadges(a: ChatAnswerView): {
	label: string;
	tone: "neutral" | "accent" | "ok" | "warn";
	title: string;
}[] {
	const out: ReturnType<typeof answerBadges> = [
		a.source === "brain"
			? {
					label: "brain's words",
					tone: "accent",
					title: "The brain's own interpretation, not a host-observed fact",
				}
			: {
					label: "from records",
					tone: "neutral",
					title: "Read straight from the database, with no model involved",
				},
	];
	if (!a.grounded) {
		out.push({
			label: "unverified: no record",
			tone: "warn",
			title: "No record backs this answer",
		});
	}
	if (a.provenance.includes("agent") || a.provenance.includes("external")) {
		out.push({
			label: "drew on agent text",
			tone: "warn",
			title: "This answer read text written by agents or outside sources",
		});
	}
	return out;
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
