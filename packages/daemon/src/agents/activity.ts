import type {
	BackgroundJob,
	QuestionSource,
	RunActivity,
	RunActivityDetail,
	StallCause,
} from "@mfw/core/activity";
import type { AgentEvent } from "./events.ts";

/**
 * Activity classification, PURE. `foldActivity` accumulates normalized
 * AgentEvents into an `ActivityFold`; `activityOf` reads the live activity
 * off it, `finalActivity` the one a finished run is labelled with.
 *
 * The fold is incremental (feed it only new events, see `run-event-tail.ts`)
 * and bounded: it keeps statuses per approval request and only the tool calls
 * it has to pair with a later result (background jobs, their polls and kills,
 * questions), never the transcript.
 */

type ApprovalEvent = Extract<AgentEvent, { type: "approval" }>;
export type ApprovalStatus = ApprovalEvent["status"];

interface Question {
	text: string;
	source: QuestionSource;
	options?: string[];
}

/** A subagent seen in the transcript (`run_subagents` row, U7). */
export interface SubagentFold {
	/** The starting `Agent`/`Task` tool call id, or a Codex sub-thread id. */
	toolUseId: string;
	/** The subagent that started this one, else null (the run itself). */
	parentToolUseId: string | null;
	agentType: string;
	description: string;
	startedAt: string;
	endedAt: string | null;
	status: "running" | "ok" | "error";
	/** Tool calls the subagent made, by tool name. */
	tools: Record<string, number>;
	/** First and last `events.jsonl` seq of the subagent's own entries. */
	entryFromSeq: number;
	entryToSeq: number;
	/** Started with `run_in_background`: the call's result is only the launch. */
	background: boolean;
}

export interface ActivityFold {
	/** Subagents by their key (see `SubagentFold.toolUseId`), in start order. */
	subagents: Map<string, SubagentFold>;
	/** Latest status per approval request id. */
	approvals: Map<
		string,
		{ status: ApprovalStatus; kind: string; summary: string }
	>;
	/** The last session status was completed / interrupted / failed. */
	turnEnded: boolean;
	/** The driver wrote `done`. */
	done: boolean;
	/** Background jobs started and not seen to finish, by starting call id. */
	background: Map<string, BackgroundJob>;
	/** Calls polling (BashOutput) a job: call id → job id. */
	polls: Map<string, string>;
	/** An `AskUserQuestion` call with no result yet. */
	openQuestionCall: string | null;
	/** The newest question signal (tool, user_input approval). */
	question: Question | null;
	lastAssistantText: string | null;
	turns: number;
	lastEventAt: string | null;
	/** The harness session id from the newest `session` event (`runs.native_session_id`). */
	nativeSessionId: string | null;
	/** The newest `usage` event's totals (the last one wins, as at finalize). */
	usage: { tokensIn: number; tokensOut: number; costUsd?: number } | null;
}

export function emptyFold(): ActivityFold {
	return {
		subagents: new Map(),
		approvals: new Map(),
		turnEnded: false,
		done: false,
		background: new Map(),
		polls: new Map(),
		openQuestionCall: null,
		question: null,
		lastAssistantText: null,
		turns: 0,
		lastEventAt: null,
		nativeSessionId: null,
		usage: null,
	};
}

const SUMMARY_CAP = 200;
const LIST_CAP = 10;

const cap = (s: string) =>
	s.length > SUMMARY_CAP ? `${s.slice(0, SUMMARY_CAP - 1)}…` : s;

function record(v: unknown): Record<string, unknown> {
	return typeof v === "object" && v !== null
		? (v as Record<string, unknown>)
		: {};
}

function str(v: unknown): string | undefined {
	return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** Tools that start work that outlives the call when asked to. */
const BACKGROUND_CAPABLE = new Set(["Bash", "Agent", "Task"]);
/** Tools whose call starts a subagent. */
const SUBAGENT_TOOLS = new Set(["Agent", "Task"]);
/** A run's subagent rows are capped (a runaway fan-out). */
const SUBAGENT_CAP = 200;
/** Entry kinds that belong to the subagent alone, not to the run's activity. */
const SUBAGENT_OWN_TYPES = new Set([
	"message",
	"thinking",
	"tool_call",
	"tool_result",
	"tool_progress",
	"file_change",
	"mcp_activity",
	"plan",
	"diff",
]);
/** Tools that stop a background job by id. */
const KILL_TOOLS = new Set(["KillShell", "KillBash", "TaskStop"]);
/** Tools that read a background job's output (and its status). */
const POLL_TOOLS = new Set(["BashOutput", "TaskOutput", "AgentOutput"]);
const JOB_ID_KEYS = ["shell_id", "bash_id", "task_id", "agent_id", "id"];

function jobIdOf(input: Record<string, unknown>): string | undefined {
	for (const key of JOB_ID_KEYS) {
		const v = str(input[key]);
		if (v) return v;
	}
	return undefined;
}

/** The id a provider printed for a job it started in the background. */
function jobIdFromResult(output: string): string | undefined {
	const m =
		/\bID:?\s*[`'"]?([A-Za-z0-9_-]{2,})/.exec(output) ??
		/\bid\s+[`'"]?([A-Za-z0-9_-]{2,})/i.exec(output);
	return m?.[1];
}

const FINISHED_STATUS =
	/<status>\s*(completed|killed|failed|exited|done)\s*<\/status>|\bstatus:\s*(completed|killed|failed|exited|done)\b/i;

function questionFromTool(input: Record<string, unknown>): Question {
	const first = record(
		Array.isArray(input.questions) ? input.questions[0] : {},
	);
	const text =
		str(first.question) ?? str(input.question) ?? "The agent asked a question";
	const rawOptions = Array.isArray(first.options)
		? first.options
		: Array.isArray(input.options)
			? input.options
			: [];
	const options = rawOptions
		.map((o) => str(o) ?? str(record(o).label))
		.filter((o): o is string => o !== undefined)
		.slice(0, LIST_CAP)
		.map(cap);
	return {
		text: cap(text),
		source: "tool",
		...(options.length ? { options } : {}),
	};
}

function removeJob(fold: ActivityFold, jobId: string): void {
	for (const [callId, job] of fold.background) {
		if (job.jobId === jobId || callId === jobId) fold.background.delete(callId);
	}
}

/** Fold events (oldest first) into `fold`, in place; returns it. */
export function foldActivity(
	fold: ActivityFold,
	events: readonly AgentEvent[],
): ActivityFold {
	for (const e of events) {
		fold.lastEventAt = e.ts;
		const key = e.parent?.toolUseId ?? e.parent?.threadId;
		if (key !== undefined) {
			// A subagent's entry: account it to the subagent, and keep it out of
			// the run's own activity (its last message is not the run's answer).
			let sub = fold.subagents.get(key);
			if (!sub && fold.subagents.size < SUBAGENT_CAP) {
				const thread = e.parent?.threadId !== undefined;
				sub = newSubagent(fold, key, e.ts, e.seq, {
					agentType: thread ? "thread" : "agent",
					description: thread ? key : "subagent",
				});
			}
			if (sub) {
				sub.entryToSeq = e.seq;
				if (e.type === "tool_call") {
					sub.tools[e.name] = (sub.tools[e.name] ?? 0) + 1;
				}
			}
			if (SUBAGENT_OWN_TYPES.has(e.type)) {
				if (e.type === "tool_call" && SUBAGENT_TOOLS.has(e.name)) {
					startSubagent(fold, e, key);
				}
				continue;
			}
		}
		switch (e.type) {
			case "message":
				if (e.role === "assistant") {
					fold.turns++;
					fold.lastAssistantText = e.text;
				} else {
					// A new turn or a steer: the agent has its next input.
					fold.turnEnded = false;
					fold.question = null;
					fold.lastAssistantText = null;
				}
				break;
			case "session":
				if (e.sessionId) fold.nativeSessionId = e.sessionId;
				fold.turnEnded =
					e.status === "completed" ||
					e.status === "interrupted" ||
					e.status === "failed";
				break;
			case "approval":
				fold.approvals.set(e.requestId, {
					status: e.status,
					kind: e.kind,
					summary: e.summary,
				});
				if (e.kind === "user_input" && e.status === "pending") {
					fold.question = { text: cap(e.summary), source: "user_input" };
				}
				break;
			case "tool_call": {
				const input = record(e.input);
				if (e.name === "AskUserQuestion") {
					fold.openQuestionCall = e.id;
					fold.question = questionFromTool(input);
				} else if (
					BACKGROUND_CAPABLE.has(e.name) &&
					input.run_in_background === true
				) {
					if (fold.background.size < LIST_CAP * 5) {
						fold.background.set(e.id, {
							callId: e.id,
							tool: e.name,
							summary: cap(
								str(input.description) ??
									str(input.command) ??
									str(input.prompt) ??
									e.name,
							),
						});
					}
				} else if (KILL_TOOLS.has(e.name)) {
					const id = jobIdOf(input);
					if (id) removeJob(fold, id);
				} else if (POLL_TOOLS.has(e.name)) {
					const id = jobIdOf(input);
					if (id) fold.polls.set(e.id, id);
				}
				if (SUBAGENT_TOOLS.has(e.name)) startSubagent(fold, e, null);
				break;
			}
			case "tool_result": {
				const job = fold.background.get(e.id);
				if (job) {
					if (!e.ok) fold.background.delete(e.id);
					else {
						const jobId = jobIdFromResult(e.output);
						if (jobId) job.jobId = jobId;
					}
				}
				const polled = fold.polls.get(e.id);
				if (polled !== undefined) {
					fold.polls.delete(e.id);
					if (FINISHED_STATUS.test(e.output)) removeJob(fold, polled);
				}
				if (fold.openQuestionCall === e.id) fold.openQuestionCall = null;
				const sub = fold.subagents.get(e.id);
				// A background subagent's result is only its launch; the job ends it.
				if (sub && sub.status === "running" && (!sub.background || !e.ok)) {
					endSubagent(sub, e.ts, e.ok);
				}
				break;
			}
			case "usage":
				fold.usage = {
					tokensIn: e.inputTokens ?? fold.usage?.tokensIn ?? 0,
					tokensOut: e.outputTokens ?? fold.usage?.tokensOut ?? 0,
					...(e.costUsd !== undefined
						? { costUsd: e.costUsd }
						: fold.usage?.costUsd !== undefined
							? { costUsd: fold.usage.costUsd }
							: {}),
				};
				break;
			case "done":
				fold.done = true;
				// Nothing is running once the run is done.
				for (const sub of fold.subagents.values()) {
					if (sub.status === "running")
						endSubagent(sub, e.ts, e.reason === "complete");
				}
				break;
			default:
				break;
		}
	}
	// A background subagent ends with its job (a poll saw it finish, or a kill).
	for (const sub of fold.subagents.values()) {
		if (
			sub.background &&
			sub.status === "running" &&
			!fold.background.has(sub.toolUseId)
		) {
			endSubagent(sub, fold.lastEventAt ?? sub.startedAt, true);
		}
	}
	return fold;
}

function newSubagent(
	fold: ActivityFold,
	key: string,
	ts: string,
	seq: number,
	init: { agentType: string; description: string; parent?: string | null },
): SubagentFold {
	const sub: SubagentFold = {
		toolUseId: key,
		parentToolUseId: init.parent ?? null,
		agentType: init.agentType,
		description: init.description,
		startedAt: ts,
		endedAt: null,
		status: "running",
		tools: {},
		entryFromSeq: seq,
		entryToSeq: seq,
		background: false,
	};
	fold.subagents.set(key, sub);
	return sub;
}

/** An `Agent`/`Task` tool call: a subagent starts (or a lazily created row learns what it is). */
function startSubagent(
	fold: ActivityFold,
	e: Extract<AgentEvent, { type: "tool_call" }>,
	nestedUnder: string | null,
): void {
	const input = record(e.input);
	const agentType = str(input.subagent_type) ?? "agent";
	const description = cap(
		str(input.description) ?? str(input.prompt) ?? e.name,
	);
	const existing = fold.subagents.get(e.id);
	const sub =
		existing ??
		(fold.subagents.size < SUBAGENT_CAP
			? newSubagent(fold, e.id, e.ts, e.seq, {
					agentType,
					description,
					parent: nestedUnder,
				})
			: undefined);
	if (!sub) return;
	if (existing) {
		sub.agentType = agentType;
		sub.description = description;
		sub.startedAt = e.ts;
		sub.entryFromSeq = Math.min(sub.entryFromSeq, e.seq);
	}
	sub.background =
		input.run_in_background === true && fold.background.has(e.id);
}

function endSubagent(sub: SubagentFold, ts: string, ok: boolean): void {
	sub.endedAt = ts;
	sub.status = ok ? "ok" : "error";
}

/** The final assistant message reads as a question to the operator. */
export function endsWithQuestion(text: string | null): boolean {
	if (!text) return false;
	const lines = text.trim().split("\n");
	const last = lines[lines.length - 1]?.trim() ?? "";
	return last.endsWith("?");
}

function pendingApprovals(fold: ActivityFold) {
	return [...fold.approvals.entries()].filter(
		([, a]) => a.status === "pending",
	);
}

function detailOf(
	fold: ActivityFold,
	extra: {
		question?: Question | null;
		stallCause?: StallCause;
	} = {},
): RunActivityDetail {
	const pending = pendingApprovals(fold).filter(
		([, a]) => a.kind !== "user_input",
	);
	const question = extra.question ?? null;
	return {
		pendingApprovals: pending.map(([id]) => id).slice(-LIST_CAP),
		...(pending.length
			? { approvalSummary: cap(pending[pending.length - 1]?.[1].summary ?? "") }
			: {}),
		...(question
			? {
					question: question.text,
					questionSource: question.source,
					...(question.options ? { options: question.options } : {}),
				}
			: {}),
		background: [...fold.background.values()].slice(0, LIST_CAP),
		...(extra.stallCause ? { stallCause: extra.stallCause } : {}),
		turns: fold.turns,
		lastEventAt: fold.lastEventAt,
	};
}

export interface ActivityResult {
	activity: RunActivity;
	detail: RunActivityDetail;
}

/**
 * The live activity of a running run. `lastOutputAt` is the transcript's
 * mtime (ms); with `idleMs` set, silence past half of it is an early
 * `stalled` warning before the idle watchdog kills the run.
 */
export function activityOf(
	fold: ActivityFold,
	opts: { now: number; idleMs?: number; lastOutputAt?: number | null },
): ActivityResult {
	if (fold.done) return { activity: "ended", detail: detailOf(fold) };
	const approvals = pendingApprovals(fold);
	if (approvals.some(([, a]) => a.kind !== "user_input")) {
		return { activity: "awaiting_approval", detail: detailOf(fold) };
	}
	if (
		fold.openQuestionCall !== null ||
		approvals.some(([, a]) => a.kind === "user_input")
	) {
		return {
			activity: "needs_answer",
			detail: detailOf(fold, { question: fold.question }),
		};
	}
	if (fold.turnEnded) {
		if (fold.background.size > 0) {
			return {
				activity: "stalled",
				detail: detailOf(fold, { stallCause: "background" }),
			};
		}
		if (endsWithQuestion(fold.lastAssistantText)) {
			return {
				activity: "needs_answer",
				detail: detailOf(fold, {
					question: {
						text: cap(fold.lastAssistantText?.trim() ?? ""),
						source: "heuristic",
					},
				}),
			};
		}
		return { activity: "idle", detail: detailOf(fold) };
	}
	const last =
		opts.lastOutputAt ??
		(fold.lastEventAt ? Date.parse(fold.lastEventAt) : Number.NaN);
	if (
		opts.idleMs &&
		opts.idleMs > 0 &&
		Number.isFinite(last) &&
		opts.now - last > opts.idleMs / 2
	) {
		return {
			activity: "stalled",
			detail: detailOf(fold, { stallCause: "silent" }),
		};
	}
	return { activity: "working", detail: detailOf(fold) };
}

/**
 * The label a finished run keeps. A question the agent wrote to its report
 * wins; then background work its turn ended on; then the heuristic (a final
 * message ending in `?` with no report), which only labels the run for the
 * UI and never changes what finalization does.
 */
export function finalActivity(
	fold: ActivityFold,
	report: { question?: string; options?: string[] } | null,
): ActivityResult {
	if (report?.question) {
		return {
			activity: "needs_answer",
			detail: detailOf(fold, {
				question: {
					text: cap(report.question),
					source: "report",
					...(report.options?.length
						? { options: report.options.slice(0, LIST_CAP).map(cap) }
						: {}),
				},
			}),
		};
	}
	if (fold.background.size > 0) {
		return {
			activity: "stalled",
			detail: detailOf(fold, { stallCause: "background" }),
		};
	}
	if (!report && endsWithQuestion(fold.lastAssistantText)) {
		return {
			activity: "needs_answer",
			detail: detailOf(fold, {
				question: fold.question ?? {
					text: cap(fold.lastAssistantText?.trim() ?? ""),
					source: "heuristic",
				},
			}),
		};
	}
	return { activity: "ended", detail: detailOf(fold) };
}

/** Changes worth persisting and announcing; ignores the turn counter and timestamps. */
export function activitySignature(r: ActivityResult): string {
	const d = r.detail;
	return JSON.stringify([
		r.activity,
		d.pendingApprovals,
		d.question ?? null,
		d.background.map((b) => b.callId),
		d.stallCause ?? null,
	]);
}
