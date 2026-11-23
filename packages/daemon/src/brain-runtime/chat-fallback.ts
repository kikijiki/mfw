import type { ProjectDbHandle } from "@mfw/db/client";
import { decisions } from "@mfw/db/schema";
import { and, desc, eq, gte } from "drizzle-orm";
import { classifyRunFailure } from "../failure-class.ts";
import { countLanded } from "../headlines.ts";
import { startOfLocalDay } from "../project-summary.ts";
import type { RunRegistry, RunRow } from "../run-registry.ts";
import type { ChatFallbackReason } from "./chat-thread.ts";
import type { ChatCitation } from "./chat-tools.ts";
import type { Provenance } from "./decision-rights.ts";

/**
 * The fallback answerer (DESIGN W2): no model, no writes. It answers the
 * common status questions from the database, cites every row it names, and
 * says plainly when a question is outside what it can read.
 */

export type FallbackTopic = "needs" | "failed" | "spend" | "today" | "running";

const TOPICS: readonly [FallbackTopic, RegExp][] = [
	[
		"needs",
		/\b(needs? (me|my)|need from me|waiting (on|for) me|blocked on me|attention|inbox|my (input|approval))\b/i,
	],
	["failed", /\b(fail(ed|ing|ures?|s)?|broke|broken|errors?)\b/i],
	["spend", /\b(spend|spent|costs?|usage|budgets?|tokens?|how much)\b/i],
	[
		"today",
		/\b(today|did you do|have you done|what happened|landed|recap|summary)\b/i,
	],
	["running", /\b(running|in progress|active|live|working on)\b/i],
];

export function fallbackTopic(question: string): FallbackTopic | null {
	return TOPICS.find(([, re]) => re.test(question))?.[0] ?? null;
}

const VERBS =
	"stop|start|kill|cancel|pause|resume|retry|restart|rerun|spawn|create|add|make|build|fix|implement|merge|deploy|ship|release|publish|delete|remove|archive|close|approve|reject|update|change|set|raise|lower|increase|assign|move|split|revert|rollback|roll back";
const ASKED = new RegExp(
	`^(please |pls |kindly )?((can|could|would|will) you (please )?|let'?s |go ahead and |i (want|need) you to )(${VERBS})\\b`,
	"i",
);
const BARE = new RegExp(`^(please |pls |kindly )?(${VERBS})\\b`, "i");

/** Whether the owner's own words ask for something to be done. */
export function wantsAction(question: string): boolean {
	const q = question.trim();
	return ASKED.test(q) || (BARE.test(q) && !q.endsWith("?"));
}

export interface FallbackSources {
	handle: Pick<ProjectDbHandle, "db">;
	registry: Pick<RunRegistry, "list">;
	capacity: () => Promise<{
		liveWorkerRuns: number;
		budgets: {
			key: string;
			unit: string;
			used: number;
			limit: number;
		}[];
		spendLast24h: {
			agent: { usd: number; tokensIn: number };
			brain: { usd: number; tokensIn: number };
		};
	}>;
	inbox?: () => Promise<
		readonly {
			title: string;
			attention?: string;
			taskId?: string | null;
			runId?: string | null;
		}[]
	>;
	chatUsage?: () => Promise<{ turns: number; tokens: number } | null>;
	now: number;
}

export interface AnswerDraft {
	text: string;
	citations: ChatCitation[];
	grounded: boolean;
	provenance: Provenance[];
}

const WHY: Record<ChatFallbackReason, string> = {
	off: "The brain is off, so this comes straight from the records.",
	unavailable:
		"The brain is unavailable, so this comes straight from the records.",
	breaker_open:
		"The brain's act breaker is open, so this comes straight from the records.",
	over_budget:
		"The chat budget is used up, so this comes straight from the records.",
	busy: "The brain is answering another question, so this comes straight from the records.",
	failed:
		"The brain could not answer, so this comes straight from the records.",
	interrupted:
		"A restart interrupted the answer, so this comes straight from the records.",
	action_request: "",
};

const LIVE = ["starting", "running", "ended", "finalizing"] as const;
const LIST = 5;
const DAY = 86_400_000;

/** Agent-authored text, shown as a quote on one short line. */
function quoted(s: string): string {
	const line = s
		.replace(/\s+/gu, " ")
		.replace(/[\p{Cc}\p{Cf}]/gu, "")
		.trim();
	return `"${line.length > 80 ? `${line.slice(0, 80)}…` : line}"`;
}

const plural = (n: number, one: string, many = `${one}s`) =>
	`${n} ${n === 1 ? one : many}`;

function runLine(r: RunRow, tail: string): string {
	return `- ${r.id}${r.taskId ? ` (${r.taskId})` : ""}: ${tail}`;
}

function runCites(rows: readonly RunRow[]): ChatCitation[] {
	return rows.flatMap((r) => [
		{ kind: "run" as const, id: r.id },
		...(r.taskId ? [{ kind: "task" as const, id: r.taskId }] : []),
	]);
}

const more = (n: number) => (n > LIST ? [`and ${n - LIST} more.`] : []);

type Body = Omit<AnswerDraft, "grounded">;

async function running(s: FallbackSources): Promise<Body> {
	const rows = (await s.registry.list({ states: [...LIVE] })).filter(
		(r) => r.kind !== "brain",
	);
	const shown = rows.slice(-LIST).reverse();
	return {
		text:
			rows.length === 0
				? "Nothing is running."
				: [
						`${plural(rows.length, "run")} live:`,
						...shown.map((r) => runLine(r, r.state)),
						...more(rows.length),
					].join("\n"),
		citations: [{ kind: "view", id: "runs" }, ...runCites(shown)],
		provenance: ["host"],
	};
}

async function needs(s: FallbackSources): Promise<Body | null> {
	if (!s.inbox) return null;
	const items = (await s.inbox()).filter((i) => i.attention === "act");
	const shown = items.slice(0, LIST);
	return {
		text:
			items.length === 0
				? "Nothing needs you."
				: [
						`${plural(items.length, "item")} need${items.length === 1 ? "s" : ""} you:`,
						...shown.map((i) => `- ${quoted(i.title)}`),
						...more(items.length),
					].join("\n"),
		citations: [
			{ kind: "view", id: "needs_you" },
			...shown.flatMap((i) => [
				...(i.taskId ? [{ kind: "task" as const, id: i.taskId }] : []),
				...(i.runId ? [{ kind: "run" as const, id: i.runId }] : []),
			]),
		],
		// Inbox titles can quote what an agent wrote.
		provenance: items.length ? ["host", "agent"] : ["host"],
	};
}

async function failed(s: FallbackSources): Promise<Body> {
	const since = s.now - DAY;
	const settled = (await s.registry.list({})).filter(
		(r) =>
			r.kind !== "brain" && r.finishedAt && r.finishedAt.getTime() >= since,
	);
	const classed = settled.map((r) => ({
		r,
		c: classifyRunFailure({
			state: r.state,
			outcome: r.outcome,
			killReason: r.killReason,
			exitCode: r.exitCode,
		}),
	}));
	// `unconfirmed` is never shown as a failure (DESIGN W2 pattern 4).
	const bad = classed.filter((x) => x.c && x.c !== "unconfirmed");
	const unconfirmed = classed.length
		? classed.filter((x) => x.c === "unconfirmed").length
		: 0;
	const shown = bad.slice(-LIST).reverse();
	const note = unconfirmed
		? [
				`${plural(unconfirmed, "run")} ended unconfirmed, not counted as failed.`,
			]
		: [];
	return {
		text: [
			bad.length === 0
				? "No run failed in the last 24 hours."
				: `${plural(bad.length, "run")} failed in the last 24 hours:`,
			...shown.map((x) => runLine(x.r, `${x.c} (${x.r.state})`)),
			...more(bad.length),
			...note,
		].join("\n"),
		citations: [
			{ kind: "view", id: "runs" },
			...runCites(shown.map((x) => x.r)),
		],
		provenance: ["host"],
	};
}

async function today(s: FallbackSources): Promise<Body> {
	const from = startOfLocalDay(s.now);
	const rows = await s.handle.db
		.select({
			id: decisions.id,
			kind: decisions.kind,
			action: decisions.action,
			taskId: decisions.taskId,
		})
		.from(decisions)
		.where(and(eq(decisions.role, "brain"), gte(decisions.ts, from)))
		.orderBy(desc(decisions.id));
	const landed = await countLanded(s.handle as ProjectDbHandle, from);
	const shown = rows.slice(0, LIST);
	return {
		text: [
			`Today: ${plural(landed, "merge")} landed, ${plural(rows.length, "brain decision")}.`,
			...shown.map(
				(d) =>
					`- decision ${d.id}: ${d.action ?? d.kind}${d.taskId ? ` on ${d.taskId}` : ""}`,
			),
			...more(rows.length),
		].join("\n"),
		citations: [
			{ kind: "view", id: "decisions" },
			...shown.flatMap((d) => [
				{ kind: "decision" as const, id: String(d.id) },
				...(d.taskId ? [{ kind: "task" as const, id: d.taskId }] : []),
			]),
		],
		provenance: ["host"],
	};
}

async function spend(s: FallbackSources): Promise<Body> {
	const c = await s.capacity();
	const { agent, brain } = c.spendLast24h;
	const chat = await s.chatUsage?.();
	return {
		text: [
			`Reported spend in the last 24 hours: agents $${agent.usd.toFixed(2)}, brain $${brain.usd.toFixed(2)}. Runs that reported no cost are not in these totals.`,
			...c.budgets
				.slice(0, LIST)
				.map((b) => `- budget ${b.key}: ${b.used} of ${b.limit} ${b.unit}`),
			...(chat
				? [
						`Chat, all projects: ${plural(chat.turns, "turn")}, ${chat.tokens} tokens counted or reserved.`,
					]
				: []),
		].join("\n"),
		citations: [{ kind: "view", id: "capacity" }],
		provenance: ["host"],
	};
}

const CANNOT =
	"I can't answer that from the records. I can tell you what is running, what needs you, what failed recently, what was done today, and spend.";

/** Answer from the records. A source that fails is reported, never guessed around. */
export async function fallbackAnswer(
	question: string,
	reason: ChatFallbackReason,
	s: FallbackSources,
): Promise<AnswerDraft> {
	const why = WHY[reason];
	const say = (text: string) => (why ? `${why}\n${text}` : text);
	const unverified = (text: string): AnswerDraft => ({
		text: say(text),
		citations: [],
		grounded: false,
		provenance: ["host"],
	});
	const topic = fallbackTopic(question);
	if (!topic) return unverified(CANNOT);
	let body: Body | null;
	try {
		body =
			topic === "running"
				? await running(s)
				: topic === "needs"
					? await needs(s)
					: topic === "failed"
						? await failed(s)
						: topic === "today"
							? await today(s)
							: await spend(s);
	} catch {
		return unverified("I could not read the records for that just now.");
	}
	if (!body) return unverified(CANNOT);
	const seen = new Set<string>();
	const citations = body.citations.filter((c) => {
		const k = `${c.kind}:${c.id}`;
		if (seen.has(k)) return false;
		seen.add(k);
		return true;
	});
	return { ...body, text: say(body.text), citations, grounded: true };
}
