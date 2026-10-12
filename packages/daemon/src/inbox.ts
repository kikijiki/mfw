import type { ProjectDbHandle } from "@mfw/db/client";
import {
	brainActions,
	brainSessions,
	brainTurns,
	clarifications,
	engineKv,
	inboxDismissals,
	mergeJobs,
	runSteps,
	runs,
} from "@mfw/db/schema";
import { and, desc, eq, gte, inArray, isNull, ne } from "drizzle-orm";
import { readAwaiting } from "./brain-runtime/awaiting.ts";
import { TASK_QUESTION_KIND } from "./clarify.ts";
import { ESCALATE_AFTER_SWEEPS } from "./maintenance.ts";
import type { TaskRow, TaskService } from "./task-service.ts";

/**
 * The operator's attention queue. Derived in one place so the badge,
 * notifications and list agree; lives in the daemon so the API layer has no
 * business logic or direct DB access.
 */

export type InboxKind =
	| "main_red"
	| "clarify"
	| "review"
	| "blocked"
	| "failed_run"
	| "merge_parked"
	| "trigger_disarmed"
	| "trigger_failed"
	| "sweep_infra"
	| "verify_infra"
	| "admission"
	| "draft_failed"
	| "ownership_conflict"
	| "followups"
	| "needs_answer"
	| "approval_pending"
	| "stalled"
	/** A resource budget is exhausted: tasks that depend on it are held (`budgets.ts`). */
	| "budget"
	/** The brain's circuit is open (repeated failed turns); a person resets it. */
	| "brain_stuck"
	/** The brain asked for a person (`notify_human`, any kind but `fyi`). */
	| "brain_notice";

export type InboxSeverity = "critical" | "attention" | "info";

export interface InboxItem {
	/** Stable across recomputation, so dismissals and notifications key off it. */
	id: string;
	project: string;
	kind: InboxKind;
	severity: InboxSeverity;
	title: string;
	detail: string;
	taskId?: string;
	runId?: string;
	/** `trigger_disarmed` / `trigger_failed`: the trigger definition id. */
	defId?: string;
	/** `merge_parked` only: the merge job id its retry/abandon/sendToReady actions key off. */
	mergeJobId?: number;
	/** The exact remedy, for kinds that are a refusal (`admission`). */
	fix?: string;
	/**
	 * The node to select for this item: `run:<id>` when the item is about a
	 * live or failed run, else `task:<id>`, else `merge:<jobId>`; `brain` (the
	 * project's root node) for project-level items such as `main_red`.
	 */
	ref: string;
	/** How to answer in place, for items a person can answer or approve. */
	answer?: InboxAnswer;
	/** `approval_pending`: the pending tool approval the answer resolves. */
	requestId?: string;
	ts: number;
}

export type InboxAnswer =
	| { mode: "text" }
	| { mode: "options"; options: string[] }
	| { mode: "approve"; requestId?: string };

/** Items keyed on the run rather than the task: answering or inspecting them is a run-level act. */
const RUN_KINDS: ReadonlySet<InboxKind> = new Set([
	"needs_answer",
	"clarify",
	"approval_pending",
	"stalled",
	"failed_run",
]);

function refOf(item: Omit<InboxItem, "ref">): string {
	if (RUN_KINDS.has(item.kind) && item.runId) return `run:${item.runId}`;
	if (item.taskId) return `task:${item.taskId}`;
	if (item.mergeJobId !== undefined) return `merge:${item.mergeJobId}`;
	if (item.runId) return `run:${item.runId}`;
	return "brain";
}

/**
 * Severity is about involvement, not alarm:
 *   critical = mfw is stuck and cannot proceed without you.
 *   attention = a decision only you can make.
 *   info = handled, no reply needed.
 *
 * `main_red` and the `*_infra` kinds are computed dynamically in `collect()`;
 * their entries here are fallbacks.
 */
const SEVERITY: Record<InboxKind, InboxSeverity> = {
	main_red: "critical",
	// Only pushed after `MergeQueue` exhausted its retries (`merge-queue.ts`).
	merge_parked: "critical",
	clarify: "attention",
	review: "attention",
	// All automatic remedies (repair, resume, stall retries) ran out.
	blocked: "critical",
	// A disarm is a trust decision and is never auto-cleared (see `arming.ts`).
	trigger_disarmed: "attention",
	// Bumped to "critical" per item when armed with `on_failure: hold_dispatch`.
	trigger_failed: "attention",
	// "info" below `ESCALATE_AFTER_SWEEPS` (still retrying), "critical" past it.
	sweep_infra: "info",
	// Same, for the finalize-time verify of a completed run's DoD checks.
	verify_infra: "info",
	admission: "attention",
	// Not urgent (the task dispatches on its default DoD), but a column of
	// unexpanded cards must not go silent.
	draft_failed: "attention",
	failed_run: "info",
	// Not wrong yet (the scheduler serializes them), but only a person can
	// decide which goes first or whether the claims are too broad.
	ownership_conflict: "attention",
	// Parked in backlog on purpose; nothing runs until someone triages them.
	followups: "info",
	// A task run stopped to ask; its task waits blocked until answered.
	needs_answer: "attention",
	// A live run is paused on a tool approval only a person can give.
	approval_pending: "attention",
	// A live run went quiet, or ended its turn on background work.
	stalled: "attention",
	// Only a person can raise the limit; the rest of the board keeps running.
	budget: "attention",
	// The brain cannot proceed on its own; dispatch continues on the fixed pipeline.
	brain_stuck: "critical",
	// Only a person can supply what the brain asked for.
	brain_notice: "attention",
};

/** How long an un-dismissed `notify_human` stays in the queue. */
const BRAIN_NOTICE_DAYS = 7;

const RANK: Record<InboxSeverity, number> = {
	critical: 0,
	attention: 1,
	info: 2,
};

export class InboxService {
	constructor(
		private readonly deps: {
			handle: ProjectDbHandle;
			project: string;
			tasks: TaskService;
			/** Triggers that disarmed themselves. Narrow read, not the whole `TriggerService`, to avoid a definition scan. */
			triggers?: {
				disarmed(): Promise<
					{ defId: string; at: number; reason: string; armedBy: string }[]
				>;
				/** Triggers whose last delivery died. Same scan-free read as `disarmed`. */
				failing(): Promise<
					{ defId: string; at: number; detail: string; holdDispatch: boolean }[]
				>;
			};
			/** Whether this project's `main_red` breaker admits its own cause task. Read live so settings changes show on the next render. */
			selfRepairMainRed?: () => boolean;
			/** Tasks already queued or mid-merge; not re-offered for review. Scan-free like `triggers`. */
			mergeQueue?: {
				activeByTask(): Promise<{ taskId: string }[]>;
			};
			/** Exhausted budgets (agent, resource, brain), one item per (key, window). */
			budgets?: {
				exhaustedForInbox(): Promise<
					{
						id: string;
						key: string;
						kind: "resource" | "brain";
						used: number;
						limit: number;
						unit: "usd" | "tokens" | "slot_hours";
						resetsAt: number;
						ts: number;
					}[]
				>;
			};
			admission?: {
				issues(): Promise<
					{
						id: string;
						taskId: string;
						runId: string;
						holdReason: string | null;
						fix?: { text: string };
						updatedAt: Date;
					}[]
				>;
			};
		},
	) {}

	/** Everything needing attention in this project, newest-and-worst first. */
	async list(): Promise<InboxItem[]> {
		const dismissed = new Set(
			(await this.deps.handle.db.select().from(inboxDismissals)).map(
				(d) => d.itemId,
			),
		);
		const items = (await this.collect()).filter((i) => !dismissed.has(i.id));
		items.sort((a, b) => RANK[a.severity] - RANK[b.severity] || b.ts - a.ts);
		return items;
	}

	async dismiss(itemId: string): Promise<void> {
		await this.deps.handle.db
			.insert(inboxDismissals)
			.values({ itemId, dismissedAt: new Date() })
			.onConflictDoNothing();
	}

	/** Drop dismissals for items that cleared, so a recurrence surfaces again. */
	async prune(): Promise<number> {
		const live = new Set((await this.collect()).map((i) => i.id));
		const rows = await this.deps.handle.db.select().from(inboxDismissals);
		let pruned = 0;
		for (const row of rows) {
			if (live.has(row.itemId)) continue;
			await this.deps.handle.db
				.delete(inboxDismissals)
				.where(eq(inboxDismissals.itemId, row.itemId));
			pruned++;
		}
		return pruned;
	}

	private async collect(): Promise<InboxItem[]> {
		const items = await this.collectItems();
		return items.map((item) => ({ ...item, ref: refOf(item) }));
	}

	private async collectItems(): Promise<Omit<InboxItem, "ref">[]> {
		const db = this.deps.handle.db;
		const project = this.deps.project;
		const items: Omit<InboxItem, "ref">[] = [];
		for (const issue of (await this.deps.admission?.issues()) ?? []) {
			items.push({
				id: `admission:${issue.id}`,
				project,
				kind: "admission",
				severity: "attention",
				title: "task admission needs attention",
				detail: issue.holdReason ?? "host admission is unavailable",
				...(issue.fix ? { fix: issue.fix.text } : {}),
				taskId: issue.taskId,
				runId: issue.runId,
				ts: issue.updatedAt.getTime(),
			});
		}

		for (const b of (await this.deps.budgets?.exhaustedForInbox()) ?? []) {
			const amount = (n: number) =>
				b.unit === "usd"
					? `$${n.toFixed(2)}`
					: b.unit === "slot_hours"
						? `${n.toFixed(1)} slot-hours`
						: `${Math.round(n)} tokens`;
			items.push({
				id: b.id,
				project,
				kind: "budget",
				severity: "attention",
				title: `budget exhausted: ${b.key}`,
				detail: `${amount(b.used)} of ${amount(b.limit)} spent; ${
					b.kind === "brain"
						? "the project brain is paused (no turns)"
						: `tasks that depend on ${b.key} are held`
				} until ${new Date(b.resetsAt).toISOString()} or the limit is raised`,
				fix: "Raise the budget in Settings → Budgets, or wait for the window to reset.",
				ts: b.ts,
			});
		}

		const [red] = await db
			.select()
			.from(engineKv)
			.where(eq(engineKv.key, "main_red"));
		if (red && (red.value as { red?: boolean }).red) {
			const v = red.value as {
				since?: number;
				causeTaskId?: string;
				escalated?: boolean;
			};
			const main = await this.mainRedInfo(v.causeTaskId, v.escalated === true);
			items.push({
				// Scoped to the cause (see `SessionService.itemId()`) so a stale
				// session for a past cause cannot dismiss the current one.
				id: `main_red:${project}:${v.causeTaskId ?? "unattributed"}`,
				project,
				kind: "main_red",
				severity: main.severity,
				title: v.escalated ? "main is red: repair has stalled" : "main is red",
				detail: main.detail,
				taskId: v.causeTaskId,
				ts: v.since ?? Date.now(),
			});
		}

		// A check failing identically at the last known-good commit means the
		// sweep cannot verify, not that a task regressed; it gets its own item.
		const [infraRow] = await db
			.select()
			.from(engineKv)
			.where(eq(engineKv.key, "sweep_infra"));
		if (infraRow && (infraRow.value as { active?: boolean }).active) {
			const v = infraRow.value as {
				since?: number;
				attempts?: number;
				detail?: string;
				taskIds?: string[];
			};
			const attempts = v.attempts ?? 0;
			items.push({
				id: `sweep_infra:${project}`,
				project,
				kind: "sweep_infra",
				severity: attempts >= ESCALATE_AFTER_SWEEPS ? "critical" : "info",
				title: "regression sweep cannot verify reliably",
				detail:
					v.detail ??
					"checks are failing the same way at the last known-good commit",
				ts: v.since ?? Date.now(),
			});
		}

		// Same signal-death fact from the finalize-time DoD check; shares
		// `ESCALATE_AFTER_SWEEPS` with `sweep_infra`.
		const [verifyInfraRow] = await db
			.select()
			.from(engineKv)
			.where(eq(engineKv.key, "verify_infra"));
		if (
			verifyInfraRow &&
			(verifyInfraRow.value as { active?: boolean }).active
		) {
			const v = verifyInfraRow.value as {
				since?: number;
				attempts?: number;
				detail?: string;
				taskIds?: string[];
			};
			const attempts = v.attempts ?? 0;
			const taskId = v.taskIds?.[0];
			items.push({
				id: `verify_infra:${project}`,
				project,
				kind: "verify_infra",
				severity: attempts >= ESCALATE_AFTER_SWEEPS ? "critical" : "info",
				title: "a DoD check keeps crashing, not failing",
				detail:
					v.detail ??
					"a check process was killed by a signal; this looks like a " +
						"toolchain or infrastructure problem, not a code regression",
				taskId,
				ts: v.since ?? Date.now(),
			});
		}

		const openClarify = await db
			.select({
				clarification: clarifications,
				taskId: runs.taskId,
				activityDetail: runs.activityDetail,
			})
			.from(clarifications)
			.leftJoin(runs, eq(runs.id, clarifications.runId))
			.where(isNull(clarifications.resolvedAt));
		const questionTasks = new Set<string>();
		// A worker's question is the brain's first (`answer_question`); a person
		// sees it once the brain escalated it, or when no brain is there to ask.
		const awaiting = await readAwaiting(this.deps.handle);
		const [session] = await db
			.select({ status: brainSessions.status })
			.from(brainSessions)
			.where(ne(brainSessions.status, "retired"));
		const brainDecides = !!session && session.status !== "failed";
		for (const { clarification: c, taskId, activityDetail } of openClarify) {
			const unanswered = c.items.filter((i) => i.answer === null).length;
			if (c.kind === TASK_QUESTION_KIND) {
				if (taskId) questionTasks.add(taskId);
				if (
					brainDecides &&
					taskId &&
					awaiting[taskId]?.runId === c.runId &&
					awaiting[taskId]?.class === "question"
				) {
					continue;
				}
				// The options the agent offered live on its activity detail.
				const offered = (activityDetail as { options?: unknown } | null)
					?.options;
				const options = Array.isArray(offered)
					? offered.filter((o): o is string => typeof o === "string")
					: [];
				items.push({
					id: `needs_answer:${c.runId}`,
					project,
					kind: "needs_answer",
					severity: SEVERITY.needs_answer,
					title: "an agent is waiting for your answer",
					detail: c.items[0]?.question ?? "",
					answer:
						options.length > 0
							? { mode: "options", options }
							: { mode: "text" },
					...(taskId ? { taskId } : {}),
					runId: c.runId,
					ts: c.createdAt.getTime(),
				});
				continue;
			}
			items.push({
				id: `clarify:${c.runId}`,
				project,
				kind: "clarify",
				severity: SEVERITY.clarify,
				title:
					unanswered > 0
						? `${unanswered} question${unanswered === 1 ? "" : "s"} blocking planning`
						: "Answers saved; continuation needs retry",
				detail: c.goal ?? c.kind,
				answer: { mode: "text" },
				...(taskId ? { taskId } : {}),
				runId: c.runId,
				ts: c.createdAt.getTime(),
			});
		}

		// A park below the retry budget is `MergeQueue` retrying on its own
		// (`retryParked`). Only exhausted jobs (same `ESCALATE_AFTER_SWEEPS`
		// threshold as `park()`) belong here.
		const parked = await db
			.select()
			.from(mergeJobs)
			.where(eq(mergeJobs.state, "parked"));
		for (const j of parked) {
			if (j.parkRetries < ESCALATE_AFTER_SWEEPS) continue;
			items.push({
				id: `merge_parked:${j.id}`,
				project,
				kind: "merge_parked",
				severity: SEVERITY.merge_parked,
				title: `merge parked: ${j.branch}`,
				detail: j.error ?? "conflict needs a human",
				taskId: j.taskId ?? undefined,
				runId: j.runId,
				mergeJobId: j.id,
				ts: j.updatedAt.getTime(),
			});
		}

		// Stays until a human re-arms or disarms the definition.
		for (const d of (await this.deps.triggers?.disarmed()) ?? []) {
			items.push({
				id: `trigger_disarmed:${d.defId}`,
				project,
				kind: "trigger_disarmed",
				severity: SEVERITY.trigger_disarmed,
				title: `trigger disarmed: ${d.defId}`,
				detail:
					d.reason === "hash-drift"
						? `its definition changed after ${d.armedBy} armed it; it will not fire until it is armed again`
						: `disarmed automatically (${d.reason})`,
				defId: d.defId,
				ts: d.at,
			});
		}

		// Last delivery died, dead-lettered, or failed with no retry configured.
		// Clears when the trigger next succeeds (`arming.clearFailing`).
		for (const f of (await this.deps.triggers?.failing()) ?? []) {
			items.push({
				id: `trigger_failed:${f.defId}`,
				project,
				kind: "trigger_failed",
				severity: f.holdDispatch ? "critical" : SEVERITY.trigger_failed,
				title: `trigger failed: ${f.defId}`,
				detail: f.detail,
				defId: f.defId,
				ts: f.at,
			});
		}

		const activeMerges = (await this.deps.mergeQueue?.activeByTask()) ?? [];
		const activeMergeTasks = new Set(activeMerges.map((r) => r.taskId));
		const attention = (await this.deps.tasks.list()).filter(
			(t) => t.status === "review" || t.status === "blocked",
		);
		for (const t of attention) {
			// Already in the merge queue's hands until it lands or parks.
			if (t.status === "review" && activeMergeTasks.has(t.id)) continue;
			// Blocked on its own run's question: the needs_answer item says so.
			if (t.status === "blocked" && questionTasks.has(t.id)) continue;
			const kind: InboxKind = t.status === "review" ? "review" : "blocked";
			items.push({
				id: `${kind}:${t.id}`,
				project,
				kind,
				severity: SEVERITY[kind],
				title:
					kind === "review"
						? `review ready: ${t.title}`
						: `blocked: ${t.title}`,
				detail: t.blockedReason ?? "",
				taskId: t.id,
				ts: t.statusChangedAt.getTime(),
			});
		}

		// Queued/retrying expansion is autonomous; only exhausted drafts are listed.
		const drafts = (await this.deps.tasks.list()).filter(
			(t) => t.status === "draft" && t.draftPhase === "failed",
		);
		for (const t of drafts) {
			items.push({
				id: `draft_failed:${t.id}`,
				project,
				kind: "draft_failed",
				severity: SEVERITY.draft_failed,
				title: `draft expansion needs help: ${t.title}`,
				detail: `${t.draftAttempts} expansion attempts failed. Edit and save the draft to retry.`,
				taskId: t.id,
				ts: t.createdAt.getTime(),
			});
		}

		// Unordered overlaps in declared `owns`. Keyed by the pair so a dismissal
		// sticks to that pair and a new overlap surfaces on its own.
		const allTasks = await this.deps.tasks.list();
		const byId = new Map(allTasks.map((t) => [t.id, t]));
		for (const c of this.deps.tasks.ownershipConflicts()) {
			const a = byId.get(c.a);
			const b = byId.get(c.b);
			const pairs = c.patterns
				.map(([pa, pb]) => `${pa} (${c.a}) and ${pb} (${c.b})`)
				.join(", ");
			items.push({
				id: `ownership_conflict:${c.a}:${c.b}`,
				project,
				kind: "ownership_conflict",
				severity: SEVERITY.ownership_conflict,
				title: `two tasks claim the same files: ${c.a} and ${c.b}`,
				detail:
					`${pairs}. They will run one after the other, in priority ` +
					"order, unless a dependency orders them.",
				taskId: c.a,
				ts: Math.max(a?.updatedAt.getTime() ?? 0, b?.updatedAt.getTime() ?? 0),
			});
		}

		// Follow-ups a run reported, parked in backlog until someone looks.
		const followups = new Map<string, TaskRow[]>();
		for (const t of allTasks) {
			if (
				t.source !== "followup" ||
				t.status !== "backlog" ||
				t.readyMode !== "manual" ||
				!t.discoveredFrom
			) {
				continue;
			}
			const group = followups.get(t.discoveredFrom) ?? [];
			group.push(t);
			followups.set(t.discoveredFrom, group);
		}
		for (const [source, group] of followups) {
			items.push({
				// A dismissal acknowledges only the discoveries present at that time.
				id: `followups:${source}:${group
					.map((t) => t.id)
					.sort()
					.join(",")}`,
				project,
				kind: "followups",
				severity: SEVERITY.followups,
				title: `${group.length} follow-up${group.length === 1 ? "" : "s"} from ${source} to triage`,
				detail: group.map((t) => `${t.id}: ${t.title}`).join("; "),
				taskId: source,
				ts: Math.max(...group.map((t) => t.createdAt.getTime())),
			});
		}

		// Live runs whose activity needs a person. Keyed by run and activity so
		// a dismissal covers this episode only.
		const waiting = await db
			.select()
			.from(runs)
			.where(
				and(
					inArray(runs.state, ["starting", "running"]),
					inArray(runs.activity, ["awaiting_approval", "stalled"]),
				),
			);
		for (const r of waiting) {
			const detail = (r.activityDetail ?? {}) as {
				pendingApprovals?: string[];
				approvalSummary?: string;
				stallCause?: string;
				lastEventAt?: string | null;
			};
			const approval = r.activity === "awaiting_approval";
			const kind: InboxKind = approval ? "approval_pending" : "stalled";
			// The newest pending approval is the one `approvalSummary` describes.
			const requestId = approval ? detail.pendingApprovals?.at(-1) : undefined;
			items.push({
				id: `${kind}:${r.id}`,
				project,
				kind,
				severity: SEVERITY[kind],
				title: approval
					? `approval needed: ${r.label}`
					: detail.stallCause === "background"
						? `turn ended on background work: ${r.label}`
						: `run has gone quiet: ${r.label}`,
				detail: approval
					? (detail.approvalSummary ?? "a tool call is waiting for approval")
					: detail.stallCause === "background"
						? "its background jobs die when the session closes; it will be resumed"
						: "no transcript output for a while; the idle watchdog stops it if this goes on",
				...(approval
					? {
							answer: {
								mode: "approve" as const,
								...(requestId ? { requestId } : {}),
							},
							...(requestId ? { requestId } : {}),
						}
					: {}),
				...(r.taskId ? { taskId: r.taskId } : {}),
				runId: r.id,
				ts: detail.lastEventAt
					? Date.parse(detail.lastEventAt) || r.startedAt.getTime()
					: r.startedAt.getTime(),
			});
		}

		// A failed run with a task is already routed by the finalize machine
		// (retry, repair, archive, or a review/blocked item), so listing it too
		// would add stale rows. Failed cleanup is the exception: the task must
		// keep its claim, so its retained writers need a separate visible error.
		const failed = await db
			.select()
			.from(runs)
			.where(inArray(runs.state, ["failed", "finalize_error", "needs_review"]));
		for (const r of failed) {
			if (!r.finishedAt) continue;
			let pendingCleanup = false;
			if (r.state === "finalize_error") {
				const [cleanup] = await db
					.select({ step: runSteps.step })
					.from(runSteps)
					.where(
						and(
							eq(runSteps.runId, r.id),
							eq(runSteps.step, "reap_leftovers"),
							ne(runSteps.status, "done"),
						),
					);
				pendingCleanup = cleanup !== undefined;
			}
			if (r.taskId && !pendingCleanup) continue;
			items.push({
				id: `failed_run:${r.id}`,
				project,
				kind: "failed_run",
				severity:
					r.state === "needs_review" ? "attention" : SEVERITY.failed_run,
				title: pendingCleanup
					? `process cleanup needs attention: ${r.label}`
					: r.state === "needs_review"
						? `import needs approval: ${r.label}`
						: `run failed: ${r.label}`,
				detail: r.note ?? r.state,
				taskId: r.taskId ?? undefined,
				runId: r.id,
				ts: r.finishedAt.getTime(),
			});
		}

		items.push(...(await this.brainItems()));
		return items;
	}

	/**
	 * What the brain needs from a person: an open circuit, and its
	 * `notify_human` calls (not `fyi`: those live in the audit trail). A
	 * `proposed` notice counts too: in shadow mode nothing else would deliver
	 * it, and the owner must see what the brain asked for.
	 */
	private async brainItems(): Promise<Omit<InboxItem, "ref">[]> {
		const db = this.deps.handle.db;
		const project = this.deps.project;
		const out: Omit<InboxItem, "ref">[] = [];
		const [failed] = await db
			.select()
			.from(brainSessions)
			.where(eq(brainSessions.status, "failed"));
		if (failed) {
			const [lastTurn] = await db
				.select()
				.from(brainTurns)
				.where(eq(brainTurns.sessionId, failed.id))
				.orderBy(desc(brainTurns.seq))
				.limit(1);
			const waiting = Object.keys(await readAwaiting(this.deps.handle)).length;
			out.push({
				id: `brain_stuck:${failed.id}`,
				project,
				kind: "brain_stuck",
				severity: SEVERITY.brain_stuck,
				title: "the project brain is stuck",
				detail: `${failed.consecutiveFailures} failed turns in a row${
					lastTurn?.error ? `: ${lastTurn.error}` : ""
				}. Retry it from the brain inspector. ${waiting} task${waiting === 1 ? "" : "s"} wait${waiting === 1 ? "s" : ""} on it (awaiting_brain); verified work keeps merging.`,
				ts: (lastTurn?.endedAt ?? failed.createdAt).getTime(),
			});
		}
		const since = new Date(Date.now() - BRAIN_NOTICE_DAYS * 86_400_000);
		const notices = await db
			.select()
			.from(brainActions)
			.where(
				and(
					eq(brainActions.tool, "notify_human"),
					gte(brainActions.createdAt, since),
				),
			);
		for (const n of notices) {
			if (n.status === "rejected" || n.status === "failed") continue;
			const args = n.args as {
				kind?: string;
				title?: string;
				body?: string;
				options?: string[];
				blocking?: string[];
			};
			if (args.kind === "fyi") continue;
			out.push({
				id: `brain_notice:${n.id}`,
				project,
				kind: "brain_notice",
				severity: SEVERITY.brain_notice,
				title: `brain: ${args.title ?? "needs you"}`,
				detail: args.body ?? "",
				...(args.blocking?.[0] ? { taskId: args.blocking[0] } : {}),
				ts: n.createdAt.getTime(),
			});
		}
		return out;
	}

	/**
	 * Says whether a human is needed or mfw is already repairing. `escalated`
	 * outranks everything: the cause survived several sweeps, so claiming
	 * self-repair would be false. Severity follows the same branches as the
	 * text: `critical` when nothing is happening on its own, `info` while a
	 * cause task is running or queued.
	 */
	private async mainRedInfo(
		causeTaskId: string | undefined,
		escalated: boolean,
	): Promise<{ detail: string; severity: InboxSeverity }> {
		if (!causeTaskId) {
			return {
				detail: "merges are paused until the sweep passes",
				severity: "critical",
			};
		}
		if (escalated) {
			return {
				detail: `merges are paused; ${causeTaskId} has not cleared after repeated attempts; needs a human`,
				severity: "critical",
			};
		}
		if (!this.deps.selfRepairMainRed?.()) {
			return {
				detail: `merges are paused; broken by ${causeTaskId}`,
				severity: "critical",
			};
		}
		const cause = await this.deps.tasks.get(causeTaskId);
		switch (cause?.status) {
			case "in_progress":
				return {
					detail: `merges are paused; mfw is repairing itself (${causeTaskId} is running)`,
					severity: "info",
				};
			case "blocked":
				return {
					detail: `self-repair failed; broken by ${causeTaskId}; needs a human`,
					severity: "critical",
				};
			case "ready":
				return {
					detail: `merges are paused; mfw has queued its own repair (${causeTaskId})`,
					severity: "info",
				};
			default:
				return {
					detail: `merges are paused; broken by ${causeTaskId}`,
					severity: "critical",
				};
		}
	}
}

/** Merge per-project lists into one cross-project queue with badge counts. */
export function mergeInboxes(lists: InboxItem[][]): {
	items: InboxItem[];
	counts: { total: number; critical: number; attention: number };
} {
	const items = lists.flat();
	items.sort((a, b) => RANK[a.severity] - RANK[b.severity] || b.ts - a.ts);
	return {
		items,
		counts: {
			total: items.length,
			critical: items.filter((i) => i.severity === "critical").length,
			attention: items.filter((i) => i.severity === "attention").length,
		},
	};
}
