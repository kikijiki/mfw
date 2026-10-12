import type { WakeClass } from "@mfw/core/events";
import type { WakeEvent } from "./wake-table.ts";

/**
 * The wake digest: one markdown user message per turn (target 3 to 8k tokens,
 * hard cap 16k, truncated by priority). Per-wake context lives here and never
 * in a system prompt, because the harness snapshots its system prompt on the
 * first request of a session.
 *
 * `renderDigest` is pure; `BrainRuntime` gathers the input from the board, the
 * event log and the outbox.
 */

/** ~4 characters per token. */
export const DIGEST_TARGET_CHARS = 32_000;
export const DIGEST_HARD_CAP_CHARS = 64_000;

export interface DigestAction {
	id: string;
	tool: string;
	status: string;
	taskId?: string | null;
	summary: string;
	rejection?: string | null;
}

export interface DigestRunFact {
	runId: string;
	taskId?: string | null;
	kind: string;
	role?: string | null;
	model: string;
	harness?: string | null;
	state: string;
	outcome?: string | null;
	/** How finalize settled the run (`run.settled` class), when it did. */
	settle?: string | null;
	costUsd?: number | null;
	durationMs?: number | null;
	verify?: string | null;
	scope?: string | null;
	verdict?: string | null;
	question?: string | null;
	report?: string | null;
	error?: string | null;
}

/** A task whose last run settled and which the brain has not acted on. */
export interface DigestAwaiting {
	taskId: string;
	title?: string | null;
	class: string;
	runId: string;
	ageMs: number;
}

export interface DigestLiveRun {
	runId: string;
	taskId?: string | null;
	kind: string;
	model: string;
	activity?: string | null;
	ageMs: number;
}

export interface DigestFrontierTask {
	id: string;
	title: string;
	unblocks: number;
	size?: string | null;
	priority?: string | null;
}

export interface DigestInput {
	wakeClass: WakeClass;
	turnSeq: number;
	generation: number;
	resumed: boolean;
	now: number;
	lastTurnAt: number | null;
	/** Wake-classified events in this turn's range, oldest first. */
	events: WakeEvent[];
	eventsFrom: number;
	eventsTo: number;
	/** Settle facts for runs that reached the end of finalize in the range. */
	runFacts: DigestRunFact[];
	/** The brain's own actions since its last ok turn, with their final status. */
	applied: DigestAction[];
	/** Tasks parked `awaiting_brain`: a settle nobody has acted on yet. */
	awaiting?: DigestAwaiting[];
	live: DigestLiveRun[];
	frontier: DigestFrontierTask[];
	/** Escalations and questions waiting on a person. */
	humanOpen: string[];
	/** Capacity and budget one-liners. */
	capacity: string[];
	reminders: string[];
	/** Rehydration only (a new generation): the standing plan and the recent record. */
	rehydration?: {
		plan: string | null;
		decisions: string[];
		overrides: string[];
	};
}

export const BRAIN_CHARTER = `# You are this project's brain

You are a long-lived planning agent for one software project. You are asleep
between wakes. The daemon wakes you with a digest like this one when something
needs a decision, and you act through the \`mfw_brain\` tools.

How to work:
- Start from the digest. Use the read tools (board, task, frontier, runs,
  run_report, run_log, diff, capacity, outcomes, decisions) for anything deeper.
- You decide what runs: nothing starts unless you spawn it, and the daemon's
  invariants are the only limit. \`spawn\` returns \`accepted\` with the run id;
  the scheduler launches it when capacity and admission allow, and a later
  digest reports how it went. Competing attempts end with \`select_winner\`.
- A run that did not simply verify and merge SETTLES: its class (verify_failed,
  review_fix, question, interrupted, merge_parked, ...) and its report are in
  "What happened", and its task is listed under "Waiting on you". Nothing
  happens to that task until you decide. To repair, resume, answer or fix a
  conflict, \`spawn\` with \`worktree: "continue:<runId>"\` (same branch and
  files; the settle's detail is in its prompt). Repeated failure on one task
  is refused: escalate with \`notify_human\` or archive it.
- Every act tool needs a \`rationale\` (at most 1000 characters). Add
  \`alternatives\` (what else you considered, and why not) and \`confidence\`
  when the choice was not obvious.
- A tool result can be a rejection with a \`fix\`. Rejections are information:
  pick another way, and only ask a human (\`notify_human\`) when none exists.
- You own the board. \`create_tasks\` (up to 20, all or none; tasks may name
  each other by \`ref\`), \`update_task\` (with the \`baseRev\` you read),
  \`reparent\`, \`split_task\`, \`merge_tasks\` and \`set_status\` change it
  directly, and every change is audited under your name. Planning is a run:
  \`spawn\` with role \`plan\` expands a draft or plans from a brief, and role
  \`import\` surveys the repository; either one settles \`plan_output\` with
  its proposal (tasks, specs, questions) in the digest, and you apply what is
  worth applying with the board tools.
- Keep a short working plan with \`set_plan\` (your memory across wakes and
  across rollovers) and record observations with \`note\`.
- End your turn when you have nothing more to decide. Do not wait for anything.
- You never write files, run shell commands or start background agents.`;

const clock = (ms: number) => new Date(ms).toISOString().slice(11, 19);

function mins(ms: number): string {
	const m = Math.max(0, Math.round(ms / 60_000));
	return m < 120 ? `${m}m` : `${Math.round(m / 60)}h`;
}

function scalar(v: unknown): string | null {
	if (typeof v === "string") return v.length > 100 ? `${v.slice(0, 100)}…` : v;
	if (typeof v === "number" || typeof v === "boolean") return String(v);
	return null;
}

/** One event as one line: `#seq hh:mm:ss type subject key=value …`. */
export function eventLine(e: WakeEvent): string {
	const subject = [e.taskId, e.runId].filter(Boolean).join(" ");
	const facts = Object.entries(e.payload)
		.map(([k, v]) => {
			const s = scalar(v);
			return s === null || s === "" ? null : `${k}=${s}`;
		})
		.filter((s): s is string => s !== null)
		.slice(0, 6);
	return `#${e.seq} ${clock(e.ts)} ${e.type}${subject ? ` ${subject}` : ""}${facts.length ? ` ${facts.join(" ")}` : ""}`;
}

function runFactLine(f: DigestRunFact): string {
	const parts = [
		`${f.runId}${f.taskId ? ` (${f.taskId})` : ""} ${f.kind}${f.role ? `/${f.role}` : ""} on ${f.harness ?? "?"}:${f.model}`,
		`state=${f.state}${f.outcome ? ` outcome=${f.outcome}` : ""}`,
	];
	if (f.durationMs != null) parts.push(`took ${mins(f.durationMs)}`);
	if (f.costUsd != null) parts.push(`cost $${f.costUsd.toFixed(2)}`);
	const lines = [`- ${parts.join(", ")}`];
	if (f.settle) lines.push(`  - settled: ${f.settle}`);
	if (f.verify) lines.push(`  - verify: ${f.verify}`);
	if (f.scope) lines.push(`  - scope: ${f.scope}`);
	if (f.verdict) lines.push(`  - review: ${f.verdict}`);
	if (f.question) lines.push(`  - question: ${f.question}`);
	if (f.report) lines.push(`  - report: ${f.report}`);
	if (f.error) lines.push(`  - error: ${f.error}`);
	return lines.join("\n");
}

interface Section {
	title: string;
	/** Lower number = kept first when the digest must be truncated. */
	priority: number;
	lines: string[];
	/** When truncating, keep the newest lines (end of the list) or the first. */
	keep: "head" | "tail";
}

/** Drop lines from the lowest-priority sections until the text fits. Returns the dropped line count. */
function fit(sections: Section[], budget: number): number {
	const size = () =>
		sections.reduce(
			(n, s) =>
				n + s.title.length + 4 + s.lines.reduce((m, l) => m + l.length + 1, 0),
			0,
		);
	let dropped = 0;
	const order = [...sections].sort((a, b) => b.priority - a.priority);
	while (size() > budget) {
		const victim = order.find((s) => s.lines.length > 0 && s.priority > 0);
		if (!victim) break;
		if (victim.keep === "tail") victim.lines.shift();
		else victim.lines.pop();
		dropped++;
	}
	return dropped;
}

export function renderDigest(input: DigestInput): {
	markdown: string;
	truncated: number;
} {
	const header = [
		`# Wake: ${input.wakeClass}`,
		`Turn ${input.turnSeq}, generation ${input.generation}, ${input.resumed ? "resumed session" : "fresh session"}. ` +
			`${input.lastTurnAt ? `${mins(input.now - input.lastTurnAt)} since your last turn.` : "This is your first turn."} ` +
			`Events #${input.eventsFrom}..#${input.eventsTo}.`,
		...input.capacity.map((c) => `- ${c}`),
	];

	// What the owner wrote to you, whole: the event lines below truncate values.
	const owner = input.events
		.filter((e) => e.type === "human.brain_message")
		.map((e) => {
			const about = typeof e.payload.about === "string" ? e.payload.about : "";
			const text = String(e.payload.text ?? "").slice(0, 2000);
			return `- #${e.seq} ${clock(e.ts)}${about ? ` about ${about}` : ""}: ${text}`;
		});

	const sections: Section[] = [
		...(owner.length > 0
			? [
					{
						title: "From the owner",
						priority: 0,
						keep: "tail" as const,
						lines: owner,
					},
				]
			: []),
		{
			title: "Applied since your last turn",
			priority: 0,
			keep: "tail",
			lines:
				input.applied.length === 0
					? ["(nothing)"]
					: input.applied.map(
							(a) =>
								`- ${a.id} ${a.tool}${a.taskId ? ` ${a.taskId}` : ""}: ${a.status}${a.rejection ? ` (${a.rejection})` : ""}. ${a.summary}`,
						),
		},
		{
			title: "Waiting on you (awaiting_brain)",
			priority: 1,
			keep: "head",
			lines: input.awaiting?.length
				? input.awaiting.map(
						(a) =>
							`- ${a.taskId}${a.title ? ` ${a.title}` : ""}: settled ${a.class} in ${a.runId} ${mins(a.ageMs)} ago`,
					)
				: ["(nothing)"],
		},
		{
			title: "What happened",
			priority: 1,
			keep: "tail",
			lines: [
				...input.runFacts.map(runFactLine),
				...input.events.map((e) => `- ${eventLine(e)}`),
			],
		},
		{
			title: "Waiting on a person",
			priority: 2,
			keep: "head",
			lines: input.humanOpen.length
				? input.humanOpen.map((h) => `- ${h}`)
				: ["(nothing)"],
		},
		{
			title: "Live runs",
			priority: 3,
			keep: "head",
			lines: input.live.length
				? input.live.map(
						(r) =>
							`- ${r.runId}${r.taskId ? ` (${r.taskId})` : ""} ${r.kind} on ${r.model}, ${r.activity ?? "working"}, ${mins(r.ageMs)}`,
					)
				: ["(none)"],
		},
		{
			title: "Ready frontier (most unblocking first)",
			priority: 4,
			keep: "head",
			lines: input.frontier.length
				? input.frontier.map(
						(t) =>
							`- ${t.id} ${t.title}${t.size ? ` [${t.size}]` : ""}${t.unblocks ? `, unblocks ${t.unblocks}` : ""}`,
					)
				: ["(empty)"],
		},
	];
	if (input.reminders.length) {
		sections.push({
			title: "Reminders",
			priority: 2,
			keep: "head",
			lines: input.reminders.map((r) => `- ${r}`),
		});
	}
	if (input.rehydration) {
		const r = input.rehydration;
		sections.push(
			{
				title: "Your standing plan (latest set_plan)",
				priority: 1,
				keep: "head",
				lines: r.plan ? r.plan.split("\n") : ["(none recorded)"],
			},
			{
				title: "Human overrides, last 7 days",
				priority: 1,
				keep: "tail",
				lines: r.overrides.length ? r.overrides : ["(none)"],
			},
			{
				title: "Your last decisions",
				priority: 5,
				keep: "tail",
				lines: r.decisions.length ? r.decisions : ["(none)"],
			},
		);
	}

	const fixed =
		header.join("\n").length + (input.resumed ? 0 : BRAIN_CHARTER.length);
	const truncated = fit(
		sections,
		Math.max(2_000, DIGEST_HARD_CAP_CHARS - fixed - 500),
	);

	const out: string[] = [];
	if (!input.resumed) out.push(BRAIN_CHARTER, "");
	out.push(...header, "");
	const ordered = [...sections].sort((a, b) => {
		const rank = (s: Section) =>
			[
				"From the owner",
				"Applied since your last turn",
				"Waiting on you (awaiting_brain)",
				"What happened",
				"Waiting on a person",
				"Live runs",
				"Ready frontier (most unblocking first)",
				"Reminders",
				"Your standing plan (latest set_plan)",
				"Human overrides, last 7 days",
				"Your last decisions",
			].indexOf(s.title);
		return rank(a) - rank(b);
	});
	for (const s of ordered) {
		out.push(`## ${s.title}`, ...s.lines, "");
	}
	if (truncated > 0) {
		out.push(
			`(digest truncated: ${truncated} lower-priority lines dropped; use the read tools for more)`,
		);
	}
	return { markdown: `${out.join("\n").trimEnd()}\n`, truncated };
}
