import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { findOwnershipConflicts, type OwnershipConflict } from "@mfw/board";
import type { BoardConfig } from "@mfw/board-core";
import type { MfwEvent } from "@mfw/core/events";
import {
	missingTemplateSections,
	parseTaskTemplate,
	type TaskTemplate,
} from "@mfw/core/template";
import type {
	Priority as TaskPriority,
	TaskSize,
	TaskSource,
	TaskStatus,
	TaskType,
} from "@mfw/core/types";
import type { ProjectDbHandle } from "@mfw/db/client";
import { appendEvent, type EventBus, type StoredEvent } from "@mfw/db/eventlog";
import { clarifications, runSteps, runs } from "@mfw/db/schema";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type { Logger } from "./log.ts";
import {
	type AttachmentInfo,
	deleteAttachment,
	listAttachments,
	putAttachment,
	readAttachment,
	readSpec,
	type SpecDoc,
	writeSpec,
} from "./tasks/extras.ts";
import {
	type BoardSuspicion,
	type CreateInput,
	type ExternalChange,
	type LoadReport,
	MalformedTaskFileError,
	sortIds,
	TaskConflict,
	type TaskCriterion,
	type TaskFile,
	TaskOwnershipHeldError,
	type TaskRecord,
	TaskIndex as TaskStore,
} from "./tasks/index.ts";
import {
	type DefinitionOfDone,
	type LocalStagingResourceRequirement,
	type ModelTier,
	OwnsSchema,
	type ReopenCondition,
	ReopenConditionSchema,
	type TaskResourceRequirement,
	type VerificationPlan,
} from "./tasks/types.ts";

export { MalformedTaskFileError };

/**
 * The task API the rest of the daemon talks to, backed by the board on disk.
 *
 * A status transition is a `rename(2)` between `.mfw/tasks/<status>/`
 * directories; a content edit is an atomic rewrite of the markdown; the
 * database only holds the audit stream, which describes what happened rather
 * than deciding what is true.
 *
 * - The event append is not in the same transaction as the state change (a
 *   rename is not a transaction). A crash in the gap loses one audit line,
 *   never the state.
 * - Optimistic concurrency (`baseRev`) is checked against the rev in the file
 *   as re-read under the lock, not against a cached row, so a hand edit and a
 *   UI save cannot silently overwrite each other.
 */

export type { TaskCriterion };

export interface TaskRow {
	id: string;
	num: number;
	title: string;
	type: TaskType;
	priority: TaskPriority;
	size: TaskSize | null;
	labels: string[];
	spikeTimebox: string | null;
	requiresResources: TaskResourceRequirement[];
	executionTarget: string;
	localStagingResources: LocalStagingResourceRequirement[];
	workloadSecretGrants: string[];
	requireReview: boolean;
	/** Paths this task may edit; empty = undeclared (see `@mfw/board-core`'s `ownership.ts`). */
	owns: string[];
	/** Model class for the run; null = the project model. */
	modelTier: ModelTier | null;
	/** The task whose run discovered this follow-up. */
	discoveredFrom: string | null;
	discoveryKey: string | null;
	/** Conditions that move this task from a parked state back to ready. */
	reopenWhen: ReopenCondition[];
	body: string;
	/** Task-specific checks. Project merge checks are added at verification. */
	verification: VerificationPlan | null;
	/** @deprecated Compatibility response for older clients. */
	dod: DefinitionOfDone | null;
	contentRev: number;
	status: TaskStatus;
	statusChangedAt: Date;
	blockedReason: string | null;
	/** The verbatim text quick-capture was given, preserved permanently. */
	draftPrompt: string | null;
	/** Destination selected when the draft was captured. */
	afterExpansion: "backlog" | "ready";
	/** Automatic tasks promote when unblocked; manual tasks remain in backlog. */
	readyMode: "automatic" | "manual";
	/** Human-facing expansion state, derived from the draft status and machine
	 * claim/retry state. Null for ordinary tasks. */
	draftPhase:
		| "queued"
		| "expanding"
		| "waiting_for_answers"
		| "retrying"
		| "failed"
		| null;
	/** Consecutive failed expansion runs; see `recordDraftExpandFailure`. */
	draftAttempts: number;
	attemptCount: number;
	stallCount: number;
	resumeCount: number;
	preservedWorktree: string | null;
	preservedBranch: string | null;
	claimedByRunId: string | null;
	claimedAt: Date | null;
	leaseExpiresAt: Date | null;
	parentId: string | null;
	splitFromId: string | null;
	lifetimeDefId: string | null;
	source: TaskSource;
	createdAt: Date;
	updatedAt: Date;
}

export interface TaskWithRefs extends TaskRow {
	dependsOn: string[];
	criteria: TaskCriterion[];
	/** Required template sections this task leaves missing or unfilled
	 * (empty for epics and for types with no template). Computed per call by
	 * `get` and `list` only, since it reads the template files. */
	templateMissing?: string[];
}

export interface BulkMoveResult {
	moved: string[];
	skipped: Array<{
		id: string;
		reason: "missing" | "changed" | "claimed" | "waiting_for_answers";
	}>;
}

export interface CriterionInput {
	text: string;
	checked?: boolean;
}

export type StatusActor =
	| "scheduler"
	| "human"
	| "brain"
	| "verifier"
	| "watchdog"
	| "boot";

export interface CreateTaskInput {
	title: string;
	body?: string;
	type?: TaskType;
	priority?: TaskPriority;
	size?: TaskSize | null;
	labels?: string[];
	dependsOn?: string[];
	criteria?: CriterionInput[];
	verification?: VerificationPlan | null;
	/** @deprecated Use verification. */
	dod?: DefinitionOfDone | null;
	spikeTimebox?: string | null;
	requiresResources?: TaskResourceRequirement[];
	executionTarget?: string;
	localStagingResources?: LocalStagingResourceRequirement[];
	workloadSecretGrants?: string[];
	requireReview?: boolean;
	afterExpansion?: "backlog" | "ready";
	readyMode?: "automatic" | "manual";
	source?: TaskSource;
	parentId?: string | null;
	lifetimeDefId?: string | null;
	splitFromId?: string | null;
	status?: TaskStatus;
	/** Import path only: adopt this id rather than allocating one. */
	id?: string;
	draftPrompt?: string | null;
	/** Quick-capture idempotency key. */
	captureId?: string | null;
	owns?: string[];
	modelTier?: ModelTier | null;
	discoveredFrom?: string | null;
	discoveryKey?: string | null;
	reopenWhen?: ReopenCondition[];
}

export interface EditTaskPatch {
	title?: string;
	body?: string;
	type?: TaskType;
	priority?: TaskPriority;
	size?: TaskSize | null;
	labels?: string[];
	dependsOn?: string[];
	criteria?: CriterionInput[];
	verification?: VerificationPlan | null;
	/** @deprecated Use verification. */
	dod?: DefinitionOfDone | null;
	spikeTimebox?: string | null;
	requiresResources?: TaskResourceRequirement[];
	executionTarget?: string;
	localStagingResources?: LocalStagingResourceRequirement[];
	workloadSecretGrants?: string[];
	requireReview?: boolean;
	afterExpansion?: "backlog" | "ready";
	readyMode?: "automatic" | "manual";
	parentId?: string | null;
	owns?: string[];
	modelTier?: ModelTier | null;
	reopenWhen?: ReopenCondition[];
}

/**
 * A spec save lost a race: the file changed since the caller read it. Carries
 * the current text so the editor can offer a merge instead of just failing.
 * Named in the API's error map, so it must stay a distinct class.
 */
export class SpecConflictError extends Error {
	constructor(
		readonly taskId: string,
		readonly current: SpecDoc,
	) {
		super(`${taskId}'s spec was modified since it was read`);
		this.name = "SpecConflictError";
	}
}

/** Anything carrying an optimistic-concurrency token: tasks. */
export interface Revisioned {
	id: string;
	contentRev: number;
}

/**
 * Optimistic-concurrency failure: the caller's baseRev is stale. Generic over
 * the record so `err.current` keeps its row type, and so specs can throw the
 * same class (the API maps it to CONFLICT by name; another class would become
 * INTERNAL_SERVER_ERROR).
 */
export class ConflictError<T extends Revisioned = TaskRow> extends Error {
	constructor(readonly current: T) {
		super(
			`${current.id} was modified: content rev is now ${current.contentRev}`,
		);
		this.name = "ConflictError";
	}
}

/**
 * A human tried to move a task whose run still holds a live claim (MFW-44).
 * Moving it would strand the claim (`claimedByRunId` would point at a run
 * that is still working). Carries the runId so the caller can offer "cancel
 * the run, then move".
 */
export class TaskClaimedError extends Error {
	constructor(
		readonly taskId: string,
		readonly runId: string,
	) {
		super(
			`${taskId} is claimed by run ${runId}, which is still live; stop ` +
				"the run before moving this task, or confirm cancelling it",
		);
		this.name = "TaskClaimedError";
	}
}

/** A draft remains in its own state until expansion completes. Archiving is the
 * only human status change that cancels a queued (not active) expansion. */
export class DraftStatusError extends Error {
	constructor(
		readonly taskId: string,
		readonly to: TaskStatus,
	) {
		super(
			to === "draft"
				? `${taskId} cannot be moved into Draft; create a capture instead`
				: `${taskId} is still a draft and cannot move to ${to}; wait for expansion or archive it`,
		);
		this.name = "DraftStatusError";
	}
}

/** `in_progress` is an ownership state, not a board choice. The only valid
 * entrance is `tryClaim()`, which installs the run claim and changes the
 * status as one operation. */
export class HumanInProgressError extends Error {
	constructor(readonly taskId: string) {
		super(
			`${taskId} cannot be moved into In progress; move it to Ready so a run can claim it`,
		);
		this.name = "HumanInProgressError";
	}
}

/** A Draft with an open clarification has a durable continuation in flight;
 * editing its spec would make the saved questions refer to a different prompt. */
export class DraftAwaitingAnswersError extends Error {
	constructor(readonly taskId: string) {
		super(
			`${taskId} is waiting for clarification answers; continue or archive the draft before editing it`,
		);
		this.name = "DraftAwaitingAnswersError";
	}
}

/** A claim is live while its lease has not lapsed (the freshness rule
 * `expireStaleLeases` uses). */
function isClaimLive(rec: TaskRecord, now: number): boolean {
	return (
		rec.state.claimedByRunId !== null &&
		rec.state.leaseExpiresAt !== null &&
		rec.state.leaseExpiresAt >= now
	);
}

const eqJson = (a: unknown, b: unknown) =>
	JSON.stringify(a) === JSON.stringify(b);

/**
 * Parked: nothing moves the task to ready except a human or its
 * `reopen_when`. An automatic backlog task is not parked; the DoR gate
 * (`promoteReady`) already moves it.
 */
function isParked(rec: TaskRecord): boolean {
	return (
		rec.status === "blocked" ||
		(rec.status === "backlog" && rec.file.frontmatter.ready_mode === "manual")
	);
}

type RunCondition = Extract<ReopenCondition, { run: string }>;

function isRunCondition(c: ReopenCondition): c is RunCondition {
	return "run" in c;
}

/** One condition, as the audit reason names it. */
export function describeReopenCondition(c: ReopenCondition): string {
	return isRunCondition(c)
		? `\`${c.run}\` exited ${c.expect_exit}`
		: `${c.task_done} is done`;
}

/** A parked task whose `task_done` conditions hold, waiting on commands only. */
export interface ReopenCommandCandidate {
	id: string;
	/** The whole `reopen_when` as read, handed back to `reopen()` unchanged. */
	conditions: ReopenCondition[];
	commands: RunCondition[];
}

/** Project a stored record into the row shape the daemon reads everywhere. */
export function toRow(
	rec: TaskRecord,
	workflow: { waitingForAnswers?: boolean } = {},
): TaskWithRefs {
	const fm = rec.file.frontmatter;
	const created = fm.created ? new Date(fm.created) : new Date(0);
	return {
		id: rec.id,
		num: rec.num,
		title: fm.title,
		type: fm.type,
		priority: fm.priority,
		size: fm.size,
		labels: fm.labels,
		spikeTimebox: fm.spike_timebox,
		requiresResources: fm.requires_resources,
		executionTarget: fm.execution_target,
		localStagingResources: fm.local_staging_resources,
		workloadSecretGrants: fm.workload_secret_grants,
		requireReview: fm.require_review,
		owns: fm.owns,
		modelTier: fm.model_tier,
		discoveredFrom: fm.discovered_from,
		discoveryKey: fm.discovery_key ?? null,
		reopenWhen: fm.reopen_when,
		body: rec.file.body,
		verification: rec.file.dod,
		dod: rec.file.dod,
		contentRev: fm.rev ?? 1,
		status: rec.status,
		statusChangedAt: new Date(rec.state.statusChangedAt ?? created.getTime()),
		blockedReason: fm.blocked_reason,
		draftPrompt: fm.draft_prompt,
		afterExpansion: fm.after_expansion,
		readyMode: fm.ready_mode,
		draftPhase:
			rec.status !== "draft"
				? null
				: rec.state.claimedByRunId !== null
					? "expanding"
					: workflow.waitingForAnswers
						? "waiting_for_answers"
						: rec.state.draftExhausted
							? "failed"
							: rec.state.draftAttempts > 0
								? "retrying"
								: "queued",
		draftAttempts: rec.state.draftAttempts,
		attemptCount: rec.state.attemptCount,
		stallCount: rec.state.stallCount,
		resumeCount: rec.state.resumeCount,
		preservedWorktree: rec.state.preservedWorktree,
		preservedBranch: rec.state.preservedBranch,
		claimedByRunId: rec.state.claimedByRunId,
		claimedAt: rec.state.claimedAt ? new Date(rec.state.claimedAt) : null,
		leaseExpiresAt: rec.state.leaseExpiresAt
			? new Date(rec.state.leaseExpiresAt)
			: null,
		parentId: fm.parent,
		splitFromId: fm.split_from,
		lifetimeDefId: fm.lifetime_def,
		source: fm.source,
		createdAt: created,
		updatedAt: new Date(rec.state.updatedAt ?? created.getTime()),
		dependsOn: fm.depends_on,
		criteria: rec.file.criteria,
	};
}

export class TaskService {
	readonly store: TaskStore;
	private readonly handle: ProjectDbHandle;
	private readonly bus: EventBus;
	private readonly log: Logger;

	/** Set by boot: told when the board changed, so it can be committed. */
	onBoardChanged: (() => void) | null = null;
	/** Set by boot: quick capture runs the expansion worker immediately instead
	 * of waiting for the maintenance cadence. */
	onDraftCaptured: (() => void) | null = null;
	/**
	 * Set by boot: told when the board stopped (or resumed) being believable, so
	 * the committer can refuse and the scheduler can hold dispatch.
	 */
	onBoardSuspended: ((suspended: boolean) => void) | null = null;
	private suspended = false;

	/** True while the circuit breaker holds the index at its last good state. */
	get isBoardSuspended(): boolean {
		return this.suspended;
	}

	/**
	 * MFW-48: what an unannotated task is verified against (the project's
	 * standard checks), so a merge is never decided on an exit code alone.
	 * Resolved per call rather than written into the task file, so tightening
	 * the project default covers every task that has none.
	 */
	private readonly mergeChecks: VerificationPlan | null;
	private readonly mfwDir: string;

	constructor(opts: {
		handle: ProjectDbHandle;
		bus: EventBus;
		mfwDir: string;
		config: BoardConfig;
		taskKey: string;
		log: Logger;
		mergeChecks?: VerificationPlan | null;
	}) {
		this.handle = opts.handle;
		this.bus = opts.bus;
		this.log = opts.log;
		this.mergeChecks = opts.mergeChecks ?? null;
		this.mfwDir = opts.mfwDir;
		this.store = new TaskStore({
			mfwDir: opts.mfwDir,
			config: opts.config,
			taskKey: opts.taskKey,
			log: opts.log,
		});
	}

	/** Project-wide merge checks followed by focused task checks. A task can
	 *  strengthen project policy but can never replace it. */
	effectiveVerification(
		taskVerification: VerificationPlan | null,
	): VerificationPlan | null {
		const checks = [] as VerificationPlan["checks"];
		const seen = new Set<string>();
		for (const plan of [this.mergeChecks, taskVerification]) {
			for (const check of plan?.checks ?? []) {
				const key = JSON.stringify(check);
				if (seen.has(key)) continue;
				seen.add(key);
				checks.push(check);
			}
		}
		return checks.length > 0 ? { verifier: "deterministic", checks } : null;
	}

	/** Repository-wide policy, exposed separately for regression sweeps. */
	projectMergeChecks(): VerificationPlan | null {
		return this.mergeChecks;
	}

	/**
	 * The template for a task type: `.mfw/templates/<type>.md`, else
	 * `.mfw/templates/task.md`, else null. Read per call (it is a small file a
	 * human edits by hand, so no cache to invalidate).
	 */
	async templateFor(type: TaskType): Promise<TaskTemplate | null> {
		const dir = join(this.mfwDir, "templates");
		for (const name of [`${type}.md`, "task.md"]) {
			try {
				return parseTaskTemplate(await readFile(join(dir, name), "utf8"));
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
			}
		}
		return null;
	}

	/**
	 * Pairs of not-yet-landed tasks whose `owns` overlap with no dependency
	 * ordering them: nothing stops both from being dispatched, except the
	 * scheduler's own overlap hold, which then decides the order by priority.
	 */
	ownershipConflicts(): OwnershipConflict[] {
		const open = this.store
			.list()
			.filter((r) => r.status !== "done" && r.status !== "archived");
		return findOwnershipConflicts(
			open.map((r) => ({
				id: r.id,
				owns: r.file.frontmatter.owns,
				dependsOn: r.file.frontmatter.depends_on,
			})),
		);
	}

	/** @deprecated Compatibility alias. */
	effectiveDod(dod: DefinitionOfDone | null): DefinitionOfDone | null {
		return this.effectiveVerification(dod);
	}

	// ---------------------------------------------------------------------
	// audit
	// ---------------------------------------------------------------------

	/** Append + publish. The state change already happened on disk. */
	private async emit(...events: MfwEvent[]): Promise<void> {
		if (events.length === 0) return;
		// Every audit event follows a board write, so this is the one place that
		// needs to know the board moved.
		this.onBoardChanged?.();
		let rows: StoredEvent[];
		try {
			rows = await this.handle.withTx(async (tx) => {
				const out: StoredEvent[] = [];
				for (const e of events) out.push(await appendEvent(tx, e));
				return out;
			});
		} catch (e) {
			// The board is already correct; a lost audit line must not fail the call.
			this.log.warn({ err: e }, "could not record task audit event");
			return;
		}
		this.bus.publish(rows);
	}

	// ---------------------------------------------------------------------
	// load / external changes
	// ---------------------------------------------------------------------

	/** Build the index from the board. Called once at attach. */
	async load(): Promise<LoadReport> {
		const report = await this.store.load();
		await this.noteSuspension(report.suspended, report.loaded);
		for (const q of report.quarantined) {
			await this.emit({
				type: "task.quarantined",
				payload: { file: q.file, reason: q.reason },
			});
		}
		return report;
	}

	/**
	 * Announce a circuit-breaker trip, and its recovery, once each. The board
	 * is re-scanned every couple of seconds and the trip condition persists,
	 * so emitting per scan would flood the log.
	 */
	private async noteSuspension(
		suspicion: BoardSuspicion | undefined,
		loaded: number,
	): Promise<void> {
		const now = suspicion !== undefined;
		if (now === this.suspended) return;
		this.suspended = now;
		this.onBoardSuspended?.(now);
		if (suspicion) {
			const s = suspicion;
			this.log.error(
				{ ...s },
				s.reason === "sentinel"
					? "the board directory has no mfw sentinel, so this checkout does not " +
							"carry the board. Holding the last known board and pausing dispatch " +
							"rather than reporting every task as deleted"
					: "most of the board vanished between two scans; treating this as a " +
							"git operation rather than as deletions. Holding the last known " +
							"board and pausing dispatch",
			);
			// Not through `emit()`: that calls onBoardChanged, and a board nobody
			// believes must not be committed.
			await this.publish({ type: "board.suspended", payload: { ...s } });
		} else {
			this.log.info("the board is back, resuming");
			await this.publish({ type: "board.resumed", payload: { loaded } });
		}
	}

	/** Append + publish without marking the board dirty. */
	private async publish(event: MfwEvent): Promise<void> {
		try {
			const rows = await this.handle.withTx(async (tx) => [
				await appendEvent(tx, event),
			]);
			this.bus.publish(rows);
		} catch (e) {
			this.log.warn({ err: e }, "could not record board event");
		}
	}

	/**
	 * Detect and record edits made outside the daemon. Every change is accepted
	 * (the file is the task); the events update the UI and record that a human
	 * did it.
	 */
	async refresh(): Promise<ExternalChange[]> {
		const changes = await this.store.refresh();
		await this.noteSuspension(
			this.store.boardSuspicion ?? undefined,
			this.store.list().length,
		);
		const events: MfwEvent[] = [];
		for (const c of changes) {
			if (c.kind === "created") {
				events.push({
					type: "task.created",
					taskId: c.id,
					payload: { source: "file", title: c.title },
				});
			} else if (c.kind === "deleted") {
				events.push({
					type: "task.deleted",
					taskId: c.id,
					payload: { title: c.title },
				});
			} else if (c.kind === "moved" && c.from && c.to) {
				events.push({
					type: "task.status_changed",
					taskId: c.id,
					payload: { from: c.from, to: c.to, actor: "human" },
				});
			} else if (c.kind === "edited") {
				events.push({
					type: "task.edited",
					taskId: c.id,
					payload: {
						source: "file",
						fields: ["file"],
						rev: this.store.get(c.id)?.file.frontmatter.rev ?? 0,
					},
				});
			}
		}
		await this.emit(...events);
		return changes;
	}

	// ---------------------------------------------------------------------
	// create / read
	// ---------------------------------------------------------------------

	async create(input: CreateTaskInput): Promise<TaskWithRefs> {
		const spec: CreateInput = {
			title: input.title,
			body: input.body,
			type: input.type,
			priority: input.priority,
			size: input.size,
			labels: input.labels,
			dependsOn: input.dependsOn,
			criteria: (input.criteria ?? []).map((c) => ({
				text: c.text,
				checked: c.checked ?? false,
			})),
			dod:
				input.verification !== undefined
					? input.verification
					: (input.dod ?? null),
			spikeTimebox: input.spikeTimebox,
			requiresResources: input.requiresResources,
			executionTarget: input.executionTarget,
			localStagingResources: input.localStagingResources,
			workloadSecretGrants: input.workloadSecretGrants,
			requireReview: input.requireReview,
			parentId: input.parentId ?? null,
			splitFromId: input.splitFromId ?? null,
			lifetimeDefId: input.lifetimeDefId ?? null,
			source: input.source ?? "human",
			status: input.status,
			draftPrompt: input.draftPrompt ?? null,
			afterExpansion: input.afterExpansion ?? "ready",
			readyMode: input.readyMode ?? "automatic",
			captureId: input.captureId ?? null,
			owns: OwnsSchema.parse(input.owns ?? []),
			modelTier: input.modelTier ?? null,
			discoveredFrom: input.discoveredFrom ?? null,
			discoveryKey: input.discoveryKey ?? null,
			reopenWhen: (input.reopenWhen ?? []).map(canonicalReopen),
			...(input.id ? { id: input.id } : {}),
		};
		const rec = await this.store.create(spec);
		await this.emit({
			type: "task.created",
			taskId: rec.id,
			payload: {
				source: rec.file.frontmatter.source,
				title: rec.file.frontmatter.title,
			},
		});
		return toRow(rec);
	}

	/**
	 * MFW-49: file a raw one-liner as a card instantly, with no LLM round trip.
	 * The text becomes the initial title and body; an expansion pass later
	 * specifies the task, and `draftPrompt` keeps the verbatim text.
	 */
	async captureQuick(
		rawText: string,
		requestId?: string,
		afterExpansion: "backlog" | "ready" = "ready",
		requireReview = false,
	): Promise<TaskWithRefs> {
		const text = rawText.trim();
		if (text.length === 0) {
			throw new Error("captured text must not be empty");
		}
		if (requestId) {
			const existing = this.store
				.list()
				.find((record) => record.file.frontmatter.capture_id === requestId);
			if (existing) return toRow(existing);
		}
		const task = await this.create({
			title: deriveDraftTitle(text),
			body: text,
			status: "draft",
			draftPrompt: text,
			afterExpansion,
			readyMode: afterExpansion === "backlog" ? "manual" : "automatic",
			requireReview,
			captureId: requestId ?? null,
			source: "human",
		});
		this.onDraftCaptured?.();
		return task;
	}

	async get(id: string): Promise<TaskWithRefs | null> {
		const rec = this.store.get(id);
		if (!rec) return null;
		const waiting = await this.waitingForAnswersTaskIds();
		const missing = await this.templateMissing(rec, this.templateCache());
		return {
			...toRow(rec, { waitingForAnswers: waiting.has(id) }),
			templateMissing: missing,
		};
	}

	async list(status?: TaskStatus): Promise<TaskWithRefs[]> {
		const waiting = await this.waitingForAnswersTaskIds();
		const templates = this.templateCache();
		const out: TaskWithRefs[] = [];
		for (const record of this.store.list()) {
			if (status !== undefined && record.status !== status) continue;
			out.push({
				...toRow(record, { waitingForAnswers: waiting.has(record.id) }),
				templateMissing: await this.templateMissing(record, templates),
			});
		}
		return out;
	}

	/**
	 * A per-call template lookup. Scoped to one `list`/`promoteReady` so a
	 * board of fifty tasks reads each template once, while a template edited
	 * by hand is seen on the next call without any invalidation.
	 */
	private templateCache(): (type: TaskType) => Promise<TaskTemplate | null> {
		const cache = new Map<TaskType, Promise<TaskTemplate | null>>();
		return (type) => {
			let hit = cache.get(type);
			if (!hit) {
				hit = this.templateFor(type);
				cache.set(type, hit);
			}
			return hit;
		};
	}

	/** Required template sections the task has not filled in. Epics are
	 * containers for other tasks, not a spec to be written, so never gated. */
	private async templateMissing(
		rec: TaskRecord,
		templates: (type: TaskType) => Promise<TaskTemplate | null>,
	): Promise<string[]> {
		const type = rec.file.frontmatter.type;
		if (type === "epic") return [];
		const template = await templates(type);
		if (!template) return [];
		return missingTemplateSections(template, {
			body: rec.file.body,
			criteriaCount: rec.file.criteria.length,
			hasVerification: (rec.file.dod?.checks.length ?? 0) > 0,
		});
	}

	/** Open clarification rows are the durable pause token for Draft expansion
	 * (derived from the clarification/run join, so no second flag can disagree
	 * after a crash). */
	private async waitingForAnswersTaskIds(): Promise<Set<string>> {
		const rows = await this.handle.db
			.select({ taskId: runs.taskId })
			.from(clarifications)
			.innerJoin(runs, eq(runs.id, clarifications.runId))
			.where(and(isNull(clarifications.resolvedAt), isNotNull(runs.taskId)));
		return new Set(rows.flatMap((row) => (row.taskId ? [row.taskId] : [])));
	}

	// ---------------------------------------------------------------------
	// delete
	// ---------------------------------------------------------------------

	/**
	 * Refuse destructive operations against a board the daemon does not
	 * currently believe. While the breaker holds, the index is the last good
	 * state and the directory is something else (likely a checkout without the
	 * board), so a delete would report success while the task's file survives on
	 * its own branch.
	 */
	private assertBelievable(what: string): void {
		if (!this.suspended) return;
		throw new Error(
			`the board is suspended (see board.suspended), refusing to ${what} a ` +
				"board the daemon does not currently believe. Restore the checkout " +
				"first, then try again.",
		);
	}

	/**
	 * Delete one task: its markdown file and its sidecar state, nothing else.
	 * A live owner must be stopped first, since deleting underneath it discards
	 * the task identity its result and finalizer are correlated with.
	 */
	async remove(id: string): Promise<boolean> {
		this.assertBelievable("delete a task from");
		const rec = this.store.get(id);
		if (!rec) return false;
		if (isClaimLive(rec, Date.now()) && rec.state.claimedByRunId) {
			throw new TaskClaimedError(id, rec.state.claimedByRunId);
		}
		const title = rec.file.frontmatter.title;
		const removed = await this.store.remove(id);
		if (!removed) return false;
		await this.emit({
			type: "task.deleted",
			taskId: id,
			payload: { title },
		});
		return true;
	}

	// ---------------------------------------------------------------------
	// spec and attachments (the optional parts of a task directory)
	// ---------------------------------------------------------------------

	/** The task's `spec.md`, or an empty doc if it has none. Null: no such task. */
	async getSpec(id: string): Promise<SpecDoc | null> {
		const rec = this.store.get(id);
		return rec ? readSpec(dirname(rec.path)) : null;
	}

	/**
	 * Save the spec. `baseHash` is what the caller last read; a stale one throws
	 * `SpecConflictError` rather than overwriting. A blank body deletes the file,
	 * so "no spec" stays a real state and not an empty file.
	 */
	async setSpec(
		id: string,
		body: string,
		baseHash?: string,
	): Promise<SpecDoc | null> {
		this.assertBelievable("edit a task on");
		const saved = await this.store.withTaskDir(id, async (dir) => {
			const doc = await writeSpec(dir, body, baseHash);
			if (doc === null) throw new SpecConflictError(id, await readSpec(dir));
			return doc;
		});
		if (saved === null) return null;
		await this.emitExtrasEdit(id, "spec");
		return saved;
	}

	async listTaskAttachments(id: string): Promise<AttachmentInfo[] | null> {
		const rec = this.store.get(id);
		return rec ? listAttachments(dirname(rec.path)) : null;
	}

	async addAttachment(
		id: string,
		name: string,
		bytes: Uint8Array,
	): Promise<AttachmentInfo | null> {
		this.assertBelievable("edit a task on");
		const info = await this.store.withTaskDir(id, (dir) =>
			putAttachment(dir, name, bytes),
		);
		if (info === null) return null;
		await this.emitExtrasEdit(id, "attachments");
		return info;
	}

	async getAttachment(id: string, name: string): Promise<Buffer | null> {
		const rec = this.store.get(id);
		return rec ? readAttachment(dirname(rec.path), name) : null;
	}

	async removeAttachment(id: string, name: string): Promise<boolean> {
		this.assertBelievable("edit a task on");
		const removed = await this.store.withTaskDir(id, (dir) =>
			deleteAttachment(dir, name),
		);
		if (!removed) return false;
		await this.emitExtrasEdit(id, "attachments");
		return true;
	}

	private async emitExtrasEdit(
		id: string,
		field: "spec" | "attachments",
	): Promise<void> {
		const rec = this.store.get(id);
		await this.emit({
			type: "task.edited",
			taskId: id,
			payload: {
				source: "api",
				fields: [field],
				rev: rec?.file.frontmatter.rev ?? 1,
			},
		});
	}

	/**
	 * Delete the whole board. Refused while the circuit breaker holds the index
	 * at its last good state. The wipe is a declared operation the store
	 * recognises, not a breaker exemption (see `TaskStore.wipe`).
	 */
	async wipe(): Promise<{ deleted: string[] }> {
		this.assertBelievable("wipe");
		const titles = new Map(
			this.store.list().map((r) => [r.id, r.file.frontmatter.title]),
		);
		const deleted = await this.store.wipe();
		await this.emit(
			...deleted.map(
				(id): MfwEvent => ({
					type: "task.deleted",
					taskId: id,
					payload: { title: titles.get(id) ?? id },
				}),
			),
		);
		return { deleted };
	}

	// ---------------------------------------------------------------------
	// edit
	// ---------------------------------------------------------------------

	async edit(
		id: string,
		patch: EditTaskPatch,
		opts?: { baseRev?: number; source?: "api" | "file" | "brain" },
	): Promise<TaskWithRefs> {
		const before = this.store.get(id);
		if (
			opts?.source !== "brain" &&
			before?.status === "draft" &&
			(await this.waitingForAnswersTaskIds()).has(id)
		) {
			throw new DraftAwaitingAnswersError(id);
		}
		if (
			opts?.source !== "brain" &&
			before &&
			isClaimLive(before, Date.now()) &&
			before.state.claimedByRunId
		) {
			throw new TaskClaimedError(id, before.state.claimedByRunId);
		}
		let result: { record: TaskRecord; fields: string[] };
		try {
			result = await this.store.update(
				id,
				(draft) => {
					const fields = applyPatch(draft, patch);
					if (
						before?.status === "draft" &&
						opts?.source !== "brain" &&
						(patch.body !== undefined || patch.title !== undefined)
					) {
						const prompt = (patch.body || patch.title || "").trim();
						if (prompt && draft.frontmatter.draft_prompt !== prompt) {
							draft.frontmatter.draft_prompt = prompt;
							fields.push("draft_prompt");
						}
					}
					return fields;
				},
				opts?.baseRev === undefined ? {} : { baseRev: opts.baseRev },
			);
		} catch (e) {
			throw this.asConflict(e);
		}
		if (result.fields.length > 0) {
			await this.touch(id);
			// Editing the captured prompt asks for another expansion pass; reset the
			// counter so a manual re-trigger gets a full budget of attempts.
			if (result.fields.includes("draft_prompt")) {
				await this.store.patchState(id, {
					draftAttempts: 0,
					draftExhausted: false,
				});
			}
			await this.emit({
				type: "task.edited",
				taskId: id,
				payload: {
					source: opts?.source ?? "api",
					fields: result.fields,
					rev: result.record.file.frontmatter.rev ?? 1,
				},
			});
			if (result.fields.includes("draft_prompt")) {
				this.onDraftCaptured?.();
			}
			// `patchState` above returns a fresh record rather than mutating
			// `result.record` in place (unlike the old store) - re-fetch so the
			// response reflects the sidecar changes just made.
			return toRow(this.store.get(id) ?? result.record);
		}
		return toRow(result.record);
	}

	/** Translate the store's conflict into the one the API maps to CONFLICT. */
	private asConflict(e: unknown): unknown {
		if (e instanceof TaskConflict) {
			const rec = this.store.get(e.id);
			if (rec) return new ConflictError(toRow(rec));
		}
		return e;
	}

	private async touch(id: string): Promise<void> {
		await this.store.patchState(id, { updatedAt: Date.now() });
	}

	// ---------------------------------------------------------------------
	// status + lease
	// ---------------------------------------------------------------------

	/** One rename between status folders, plus the audit line. */
	async move(
		id: string,
		to: TaskStatus,
		actor: StatusActor,
		reason?: string,
	): Promise<TaskWithRefs> {
		const cur = this.store.get(id);
		if (!cur) throw new Error(`unknown task ${id}`);
		if (cur.status === to && (to !== "blocked" || !reason)) return toRow(cur);
		if (actor === "human" && to === "in_progress") {
			throw new HumanInProgressError(id);
		}
		// Only humans are guarded: the scheduler, verifier and finalizer
		// legitimately move a claimed task through a run's lifecycle.
		if (actor === "human" && isClaimLive(cur, Date.now())) {
			const runId = cur.state.claimedByRunId;
			if (runId) throw new TaskClaimedError(id, runId);
		}
		if (
			actor === "human" &&
			cur.status === "draft" &&
			(await this.waitingForAnswersTaskIds()).has(id)
		) {
			throw new DraftAwaitingAnswersError(id);
		}
		if (actor === "human" && to === "draft") {
			throw new DraftStatusError(id, to);
		}
		if (actor === "human" && cur.status === "draft" && to !== "archived") {
			throw new DraftStatusError(id, to);
		}
		if (actor === "human" && (to === "backlog" || to === "ready")) {
			const readyMode = to === "backlog" ? "manual" : "automatic";
			const intent = await this.store.update(id, (draft) => {
				if (draft.frontmatter.ready_mode === readyMode) return [];
				draft.frontmatter.ready_mode = readyMode;
				return ["ready_mode"];
			});
			if (intent.fields.length > 0) {
				await this.touch(id);
				await this.emit({
					type: "task.edited",
					taskId: id,
					payload: {
						source: "api",
						fields: intent.fields,
						rev: intent.record.file.frontmatter.rev ?? 1,
					},
				});
			}
		}
		const from = cur.status;
		const rec = await this.store.setStatus(id, to, reason ?? null);
		if (!rec) throw new Error(`unknown task ${id}`);
		if (from !== to) {
			await this.emit({
				type: "task.status_changed",
				taskId: id,
				payload: {
					from,
					to,
					actor,
					...(reason !== undefined ? { reason } : {}),
				},
			});
		}
		return toRow(rec);
	}

	/**
	 * Move the exact set of cards the operator saw when confirming a column
	 * action. Each goes through `move()`, so claim protection, Draft ownership,
	 * ready intent and audit events still apply. Cards that changed since render
	 * are skipped.
	 */
	async moveMany(
		ids: string[],
		from: TaskStatus,
		to: TaskStatus,
		actor: StatusActor,
	): Promise<BulkMoveResult> {
		const uniqueIds = [...new Set(ids)];
		const result: BulkMoveResult = { moved: [], skipped: [] };
		for (const id of uniqueIds) {
			const current = this.store.get(id);
			if (!current) {
				result.skipped.push({ id, reason: "missing" });
				continue;
			}
			if (current.status !== from) {
				result.skipped.push({ id, reason: "changed" });
				continue;
			}
			try {
				await this.move(id, to, actor);
				result.moved.push(id);
			} catch (error) {
				if (
					error instanceof TaskClaimedError ||
					error instanceof DraftAwaitingAnswersError
				) {
					result.skipped.push({
						id,
						reason:
							error instanceof TaskClaimedError
								? "claimed"
								: "waiting_for_answers",
					});
					continue;
				}
				throw error;
			}
		}
		return result;
	}

	/** Transfer the lease to a child run (repair/resume) without a release. */
	async moveLease(
		id: string,
		newRunId: string,
		expectedRunId?: string,
	): Promise<void> {
		await this.store.patchState(id, (state) =>
			state.claimedByRunId === null ||
			state.claimedByRunId === newRunId ||
			(expectedRunId !== undefined && state.claimedByRunId !== expectedRunId)
				? {}
				: { claimedByRunId: newRunId, claimedAt: Date.now() },
		);
	}

	/**
	 * Restore a claim that `release` already cleared, so a retried operation's
	 * own eventual `release` matches by `runId` again (MFW-51: `onParked`
	 * released the claim when the merge job parked). No-op if the task is no
	 * longer unclaimed, so a retry never steals a fresh dispatch's claim.
	 *
	 * `leaseExpiresAt: null` opts out of `expireStaleLeases`: nothing renews a
	 * lease for a merge in flight.
	 */
	async reclaimForRetry(id: string, runId: string): Promise<void> {
		const rec = this.store.get(id);
		if (!rec || rec.state.claimedByRunId !== null) return;
		await this.store.patchState(id, {
			claimedByRunId: runId,
			claimedAt: Date.now(),
			leaseExpiresAt: null,
		});
	}

	/**
	 * Claim a ready task for a run. The compare-and-swap is the rename out of
	 * `ready/` (see `TaskStore.claim`); exactly one caller wins.
	 *
	 * `actor` defaults to `"scheduler"`; a hand-started run (`runs.startTask`,
	 * MFW-35) passes `"human"` so the audit trail can tell them apart.
	 */
	async tryClaim(
		id: string,
		runId: string,
		leaseMs: number,
		actor: StatusActor = "scheduler",
	): Promise<boolean> {
		let rec: TaskRecord | null;
		try {
			rec = await this.store.claim(id, runId, leaseMs);
		} catch (error) {
			if (error instanceof TaskOwnershipHeldError) {
				await this.emit({
					type: "task.held_for_resource",
					taskId: id,
					payload: {
						scope: "project",
						code: error.code,
						waitingFor: [...error.waitingFor],
						reason: error.message,
					},
				});
			}
			throw error;
		}
		if (!rec) return false;
		await this.emit(
			{ type: "task.claimed", taskId: id, payload: { runId } },
			{
				type: "task.status_changed",
				taskId: id,
				payload: { from: "ready", to: "in_progress", actor },
			},
		);
		return true;
	}

	/** Reserve a draft for one expansion run without changing its workflow
	 * state. The claim powers the same edit/move/delete guard as coding work. */
	async tryClaimDraftExpansion(
		id: string,
		runId: string,
		leaseMs: number,
	): Promise<boolean> {
		const claim = await this.store.claimDraftExpansion(id, runId, leaseMs);
		if (!claim) return false;
		if (claim.alreadyOwned) return true;
		await this.emit({
			type: "task.claimed",
			taskId: id,
			payload: { runId, purpose: "draft_expansion" },
		});
		return true;
	}

	/**
	 * Clear the lease and set the status, but only if `runId` still holds the
	 * claim. Idempotent: releasing an already-unclaimed task at the same status
	 * is a no-op. Callers decide from a snapshot, so if the claim has since
	 * moved to another run this returns null and leaves that claim untouched
	 * (see `TaskStore.releaseClaim`).
	 *
	 * Two more stale-snapshot cases also return null:
	 *
	 * - The task no longer exists (deleted while a run had it claimed); there
	 *   is nothing left to release.
	 * - The task's current status is `archived` and the caller wants to move it
	 *   elsewhere. Archiving is a terminal, human-decided disposition (see
	 *   `DraftStatusError` / `clarify.archiveDraft`); without this guard a stale
	 *   run's eventual `release` would resurrect an archived task.
	 */
	async release(
		id: string,
		runId: string | null,
		to: TaskStatus,
		actor: StatusActor,
		reason?: string,
	): Promise<TaskWithRefs | null> {
		const before = this.store.get(id);
		if (!before) return null;
		if (before.status === "archived" && to !== "archived") return null;
		const result = await this.store.releaseClaim(id, runId, to, reason ?? null);
		if (!result) return null;
		const { record: rec, from, releasedRunId } = result;
		const events: MfwEvent[] = [];
		if (releasedRunId) {
			events.push({
				type: "task.claim_released",
				taskId: id,
				payload: {
					runId: releasedRunId,
					purpose: from === "draft" ? "draft_expansion" : "task_run",
					...(reason ? { reason } : {}),
				},
			});
		}
		if (from !== to) {
			events.push({
				type: "task.status_changed",
				taskId: id,
				payload: {
					from,
					to,
					actor,
					...(reason !== undefined ? { reason } : {}),
				},
			});
		}
		if (events.length > 0) await this.emit(...events);
		return toRow(rec);
	}

	/** Extend the lease of whatever task `runId` currently holds. */
	async renewLease(runId: string, leaseMs: number): Promise<boolean> {
		let renewed = false;
		for (const rec of this.store.list()) {
			if (rec.state.claimedByRunId !== runId) continue;
			await this.store.patchState(rec.id, {
				leaseExpiresAt: Date.now() + leaseMs,
			});
			renewed = true;
		}
		return renewed;
	}

	/**
	 * Expired leases, `task.lease_expired`. Only an `in_progress` task goes back
	 * to `ready`; a `draft` keeps its status (its lease is a draft-expansion
	 * claim); any other status (e.g. finished by a CLI transition that never
	 * released the binding) just has the stale lease cleared. Returns task ids.
	 */
	async expireStaleLeases(now = Date.now()): Promise<string[]> {
		const expired: string[] = [];
		for (const rec of this.store.list()) {
			const runId = rec.state.claimedByRunId;
			if (runId === null || rec.state.leaseExpiresAt === null) continue;
			if (isClaimLive(rec, now)) continue;
			const [cleanup] = await this.handle.db
				.select({ status: runSteps.status })
				.from(runSteps)
				.where(
					and(eq(runSteps.runId, runId), eq(runSteps.step, "reap_leftovers")),
				);
			if (cleanup && cleanup.status !== "done") continue;
			const from = rec.status;
			const to: TaskStatus = from === "in_progress" ? "ready" : from;
			await this.store.patchState(rec.id, {
				claimedByRunId: null,
				claimedAt: null,
				leaseExpiresAt: null,
			});
			if (from === "in_progress" || from === "draft") {
				await this.store.setStatus(rec.id, to, null);
			}
			const events: MfwEvent[] = [
				{ type: "task.lease_expired", taskId: rec.id, payload: { runId } },
			];
			if (from !== to) {
				events.push({
					type: "task.status_changed",
					taskId: rec.id,
					payload: {
						from,
						to,
						actor: "watchdog",
						reason: "lease expired",
					},
				});
			}
			await this.emit(...events);
			expired.push(rec.id);
		}
		return expired;
	}

	// ---------------------------------------------------------------------
	// draft expansion (MFW-49)
	// ---------------------------------------------------------------------

	/**
	 * An expansion run against this draft ended without a usable plan. Below
	 * `maxAttempts` this only bumps the counter (the maintenance sweep retries).
	 * At the cap it stays a failed draft, so an unexpanded capture never becomes
	 * executable work.
	 *
	 * Returns null for a task that is no longer a draft (stale run).
	 */
	async recordDraftExpandFailure(
		id: string,
		maxAttempts: number,
		_fallbackVerification?: VerificationPlan,
	): Promise<{
		exhausted: boolean;
		attempts: number;
	} | null> {
		const rec = this.store.get(id);
		if (rec?.status !== "draft") return null;
		const attempts = rec.state.draftAttempts + 1;
		const exhausted = attempts >= maxAttempts;
		await this.store.patchState(id, {
			draftAttempts: attempts,
			draftExhausted: exhausted,
		});
		return { exhausted, attempts };
	}

	/**
	 * A plan run tied to this draft parsed at least one task; `entry` (the
	 * first) is applied to this task in place. The subsequent release moves the
	 * same card from `draft` to its recorded destination.
	 *
	 * Project merge checks are not materialised here; an omitted plan inherits
	 * them at verification time.
	 */
	async applyDraftExpansion(
		id: string,
		entry: {
			title: string;
			body?: string | null;
			verification?: VerificationPlan | null;
			/** @deprecated Use verification. */
			dod?: DefinitionOfDone | null;
			criteria?: CriterionInput[];
			owns?: string[];
			modelTier?: ModelTier | null;
		},
		_fallbackVerification?: VerificationPlan,
	): Promise<TaskWithRefs> {
		const result = await this.store.update(id, (draft, rec) => {
			if (rec.status !== "draft") {
				throw new Error(`task ${id} is not a draft`);
			}
			const fields: string[] = [];
			// Captured drafts may have explicit human routing edits. Fill only
			// undeclared fields; expansion must not erase those choices.
			if (draft.frontmatter.owns.length === 0 && entry.owns !== undefined) {
				const owns = OwnsSchema.parse(entry.owns);
				if (owns.length > 0) {
					draft.frontmatter.owns = owns;
					fields.push("owns");
				}
			}
			if (draft.frontmatter.model_tier === null && entry.modelTier != null) {
				draft.frontmatter.model_tier = entry.modelTier;
				fields.push("model_tier");
			}
			const title = entry.title.trim();
			if (title.length > 0 && draft.frontmatter.title !== title) {
				draft.frontmatter.title = title;
				fields.push("title");
			}
			const body = entry.body ?? "";
			if (body.length > 0 && draft.body !== body) {
				draft.body = body;
				fields.push("body");
			}
			const verification =
				entry.verification !== undefined ? entry.verification : entry.dod;
			if (
				verification !== undefined &&
				!eqJson(verification ?? null, draft.dod)
			) {
				draft.dod = verification ?? null;
				fields.push("verification");
			}
			if (entry.criteria !== undefined) {
				const want: TaskCriterion[] = entry.criteria.map((c) => ({
					text: c.text,
					checked: c.checked ?? false,
				}));
				if (!eqJson(want, draft.criteria)) {
					draft.criteria = want;
					fields.push("criteria");
				}
			}
			return fields;
		});
		if (result.fields.length > 0) {
			await this.touch(id);
			await this.emit({
				type: "task.edited",
				taskId: id,
				payload: {
					source: "brain",
					fields: result.fields,
					rev: result.record.file.frontmatter.rev ?? 1,
				},
			});
		}
		return toRow(result.record);
	}

	// ---------------------------------------------------------------------
	// scheduling views
	// ---------------------------------------------------------------------

	/** DoR gate: specified backlog tasks with all dependencies done become
	 * ready. Verification is a merge gate, not part of task readiness.
	 * Drafts live in their own state and are therefore outside this scan.
	 *
	 * A task whose type template has required sections missing stays in
	 * backlog; that only holds the automatic move, so a human can still move
	 * it to ready by hand. Parked tasks whose `task_done` reopen conditions
	 * all hold are reopened here too (see `reopenWhereTasksDone`). */
	async promoteReady(): Promise<string[]> {
		const promoted = await this.reopenWhereTasksDone();
		const templates = this.templateCache();
		const byId = new Map(this.store.list().map((r) => [r.id, r]));
		for (const rec of this.store.list()) {
			if (rec.status !== "backlog") continue;
			if (rec.file.frontmatter.ready_mode === "manual") continue;
			// Automatic promotion requires a real specification; a title-only
			// capture/import stays in backlog until expanded or moved explicitly.
			if (rec.file.body.trim().length === 0 && rec.file.criteria.length === 0) {
				continue;
			}
			const unmet = rec.file.frontmatter.depends_on.some(
				(d) => byId.get(d)?.status !== "done",
			);
			if (unmet) continue;
			if ((await this.templateMissing(rec, templates)).length > 0) continue;
			await this.store.setStatus(rec.id, "ready", null);
			await this.emit({
				type: "task.status_changed",
				taskId: rec.id,
				payload: {
					from: "backlog",
					to: "ready",
					actor: "scheduler",
					reason: "DoR passed",
				},
			});
			promoted.push(rec.id);
		}
		return promoted;
	}

	// ---------------------------------------------------------------------
	// reopen conditions
	// ---------------------------------------------------------------------
	//
	// `reopen_when` is one-shot: a successful reopen clears it. A condition
	// that stays true (a dependency that is done stays done, a command that
	// passes keeps passing) would otherwise reopen the task every time it is
	// parked again, so a human or agent parking it a second time could never
	// make it stay parked. Whoever parks it again states a fresh condition.

	/** Parked, unclaimed tasks with conditions, plus whether every
	 * `task_done` condition holds. */
	private reopenScan(): { rec: TaskRecord; tasksDone: boolean }[] {
		const byId = new Map(this.store.list().map((r) => [r.id, r]));
		const out: { rec: TaskRecord; tasksDone: boolean }[] = [];
		for (const rec of this.store.list()) {
			const conditions = rec.file.frontmatter.reopen_when;
			if (conditions.length === 0 || !isParked(rec)) continue;
			// A claimed task belongs to its run, whatever its folder says.
			if (rec.state.claimedByRunId !== null) continue;
			const tasksDone = conditions.every(
				(c) => isRunCondition(c) || byId.get(c.task_done)?.status === "done",
			);
			out.push({ rec, tasksDone });
		}
		return out;
	}

	/**
	 * Reopen parked tasks whose conditions are all `task_done` and all hold.
	 * Cheap enough for every scheduler tick. A task that also has a command
	 * condition waits for maintenance (`reopenCommandCandidates`).
	 */
	private async reopenWhereTasksDone(): Promise<string[]> {
		const reopened: string[] = [];
		for (const { rec, tasksDone } of this.reopenScan()) {
			const conditions = rec.file.frontmatter.reopen_when;
			if (!tasksDone || conditions.some(isRunCondition)) continue;
			if (await this.reopen(rec.id, conditions)) reopened.push(rec.id);
		}
		return reopened;
	}

	/**
	 * Parked tasks whose only unchecked conditions are commands. Commands run
	 * only once every `task_done` condition holds, so a command is never paid
	 * for while the task could not reopen anyway.
	 */
	reopenCommandCandidates(): ReopenCommandCandidate[] {
		return this.reopenScan().flatMap(({ rec, tasksDone }) => {
			const conditions = rec.file.frontmatter.reopen_when;
			const commands = conditions.filter(isRunCondition);
			if (!tasksDone || commands.length === 0) return [];
			return [{ id: rec.id, conditions, commands }];
		});
	}

	/** Recheck board facts and readiness under the board lock. The store retains
	 * the condition through the rename and recovers interrupted completion. */
	async reopen(id: string, conditions: ReopenCondition[]): Promise<boolean> {
		const result = await this.store.reopen(id, conditions, async (rec) => {
			if (!isParked(rec) || rec.state.claimedByRunId !== null) return false;
			if (!rec.file.body.trim() && rec.file.criteria.length === 0) return false;
			return (
				(await this.templateMissing(rec, this.templateCache())).length === 0
			);
		});
		if (!result) return false;
		await this.emit({
			type: "task.status_changed",
			taskId: id,
			payload: {
				from: result.from,
				to: "ready",
				actor: "scheduler",
				reason: `reopen condition met: ${conditions.map(describeReopenCondition).join(", ")}`,
			},
		});
		return true;
	}

	/**
	 * Ready tasks whose every dependency is done (the scheduler's pick set).
	 *
	 * A task holding a claim is excluded even if its status says `ready`: that
	 * is a stranded claim, and `TaskStore.claim` refuses it, so picking it would
	 * make the scheduler fail dispatch every tick until the lease expires.
	 */
	async readySet(): Promise<TaskWithRefs[]> {
		const byId = new Map(this.store.list().map((r) => [r.id, r]));
		return this.store
			.list()
			.filter(
				(r) =>
					r.status === "ready" &&
					r.state.claimedByRunId === null &&
					!r.file.frontmatter.depends_on.some(
						(d) => byId.get(d)?.status !== "done",
					),
			)
			.map((record) => toRow(record));
	}

	// ---------------------------------------------------------------------
	// runtime counters (disposable sidecar state)
	// ---------------------------------------------------------------------

	async bumpStall(id: string): Promise<number> {
		const rec = this.store.get(id);
		if (!rec) throw new Error(`unknown task ${id}`);
		const next = rec.state.stallCount + 1;
		await this.store.patchState(id, { stallCount: next });
		return next;
	}

	/** Clear a stall without resetting the still-active finalization budget. */
	async clearStall(id: string): Promise<void> {
		await this.store.patchState(id, { stallCount: 0 });
	}

	async bumpAttempt(id: string): Promise<number> {
		const rec = this.store.get(id);
		if (!rec) throw new Error(`unknown task ${id}`);
		const next = rec.state.attemptCount + 1;
		await this.store.patchState(id, { attemptCount: next });
		return next;
	}

	async bumpResume(id: string): Promise<number> {
		const rec = this.store.get(id);
		if (!rec) throw new Error(`unknown task ${id}`);
		const next = rec.state.resumeCount + 1;
		await this.store.patchState(id, { resumeCount: next });
		return next;
	}

	/** Idempotent accounting for a resume ordinal persisted by finalization. */
	async setResumeOrdinal(id: string, ordinal: number): Promise<void> {
		await this.store.patchState(id, (state) => ({
			resumeCount: Math.max(state.resumeCount, ordinal),
		}));
	}

	/** Resume-not-restart pointer; cleared on merge/GC. */
	async recordPreservedWorktree(
		id: string,
		worktree: string,
		branch: string,
	): Promise<void> {
		await this.store.patchState(id, {
			preservedWorktree: worktree,
			preservedBranch: branch,
		});
	}

	async clearPreservedWorktree(id: string): Promise<void> {
		await this.store.patchState(id, {
			preservedWorktree: null,
			preservedBranch: null,
		});
	}

	// ---------------------------------------------------------------------
	// graph (UI DAG)
	// ---------------------------------------------------------------------

	async graph(): Promise<{
		nodes: {
			id: string;
			title: string;
			status: TaskStatus;
			type: TaskType;
			priority: TaskPriority;
		}[];
		edges: { from: string; to: string }[];
	}> {
		const recs = this.store.list();
		const known = new Set(recs.map((r) => r.id));
		const edges: { from: string; to: string }[] = [];
		for (const r of recs) {
			for (const dep of r.file.frontmatter.depends_on) {
				// Skip dangling edges (a human can delete a file); they would draw a
				// phantom node.
				if (known.has(dep)) edges.push({ from: r.id, to: dep });
			}
		}
		return {
			nodes: recs.map((r) => ({
				id: r.id,
				title: r.file.frontmatter.title,
				status: r.status,
				type: r.file.frontmatter.type,
				priority: r.file.frontmatter.priority,
			})),
			edges,
		};
	}
}

// ---------------------------------------------------------------------------
// patch application
// ---------------------------------------------------------------------------

function applyPatch(draft: TaskFile, patch: EditTaskPatch): string[] {
	const fm = draft.frontmatter;
	const fields: string[] = [];
	const set = <K extends keyof typeof fm>(
		key: K,
		value: (typeof fm)[K],
		name: string,
	) => {
		if (eqJson(fm[key], value)) return;
		fm[key] = value;
		fields.push(name);
	};

	if (patch.title !== undefined) set("title", patch.title, "title");
	if (patch.type !== undefined) set("type", patch.type, "type");
	if (patch.priority !== undefined) set("priority", patch.priority, "priority");
	if (patch.size !== undefined) set("size", patch.size ?? null, "size");
	if (patch.labels !== undefined) set("labels", patch.labels, "labels");
	if (patch.requireReview !== undefined) {
		set("require_review", patch.requireReview, "require_review");
	}
	if (patch.afterExpansion !== undefined) {
		set("after_expansion", patch.afterExpansion, "after_expansion");
		set(
			"ready_mode",
			patch.afterExpansion === "backlog" ? "manual" : "automatic",
			"ready_mode",
		);
	}
	if (patch.readyMode !== undefined) {
		set("ready_mode", patch.readyMode, "ready_mode");
	}
	if (patch.spikeTimebox !== undefined) {
		set("spike_timebox", patch.spikeTimebox ?? null, "spike_timebox");
	}
	if (patch.requiresResources !== undefined) {
		set("requires_resources", patch.requiresResources, "requires_resources");
	}
	if (patch.executionTarget !== undefined) {
		set("execution_target", patch.executionTarget, "execution_target");
	}
	if (patch.localStagingResources !== undefined) {
		set(
			"local_staging_resources",
			patch.localStagingResources,
			"local_staging_resources",
		);
	}
	if (patch.workloadSecretGrants !== undefined) {
		set(
			"workload_secret_grants",
			[...new Set(patch.workloadSecretGrants)].sort(),
			"workload_secret_grants",
		);
	}
	if (patch.parentId !== undefined) {
		set("parent", patch.parentId ?? null, "parent");
	}
	if (patch.owns !== undefined) {
		set("owns", OwnsSchema.parse(patch.owns), "owns");
	}
	if (patch.modelTier !== undefined) {
		set("model_tier", patch.modelTier ?? null, "model_tier");
	}
	if (patch.reopenWhen !== undefined) {
		set("reopen_when", patch.reopenWhen.map(canonicalReopen), "reopen_when");
	}
	if (patch.dependsOn !== undefined) {
		set("depends_on", sortIds([...new Set(patch.dependsOn)]), "depends_on");
	}
	if (patch.body !== undefined && patch.body !== draft.body) {
		draft.body = patch.body;
		fields.push("body");
	}
	const verification =
		patch.verification !== undefined ? patch.verification : patch.dod;
	if (
		(patch.verification !== undefined || patch.dod !== undefined) &&
		!eqJson(verification ?? null, draft.dod)
	) {
		draft.dod = verification ?? null;
		fields.push("verification");
	}
	if (patch.criteria !== undefined) {
		const want: TaskCriterion[] = patch.criteria.map((c) => ({
			text: c.text,
			checked: c.checked ?? false,
		}));
		if (!eqJson(want, draft.criteria)) {
			draft.criteria = want;
			fields.push("criteria");
		}
	}
	return fields;
}

/** Validated, with defaults filled, so the file and the row agree. */
function canonicalReopen(condition: ReopenCondition): ReopenCondition {
	return ReopenConditionSchema.parse(condition) as ReopenCondition;
}

/** Frontmatter titles must be non-empty and one line; a captured note may be
 *  neither, so take the first line and truncate. */
const DRAFT_TITLE_MAX = 80;
function deriveDraftTitle(text: string): string {
	const firstLine = (text.split("\n", 1)[0] ?? "").trim() || text;
	if (firstLine.length <= DRAFT_TITLE_MAX) return firstLine;
	return `${firstLine.slice(0, DRAFT_TITLE_MAX - 1).trimEnd()}…`;
}
