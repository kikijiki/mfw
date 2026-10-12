import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
	releaseClaim as boardReleaseClaim,
	type ClaimConfig,
	claimTask,
	emptyLease,
	readLease,
	type TaskLease,
	TaskOwnershipHeldError,
	withClaimLock,
	writeLease,
} from "@mfw/board";
import type {
	BoardConfig,
	BoardDocument,
	ChecklistItem,
} from "@mfw/board-core";
import {
	BoardStore,
	HierarchyError,
	KeyedLock,
	MalformedDocumentError,
	overlappingPatterns,
	parentRuleProblem,
	parseIdNum,
	RuleViolationError,
} from "@mfw/board-core";
import type { TaskStatus } from "@mfw/core/types";
import { parseStatusMap, type StatusMap } from "../board-status-map.ts";
import type { Logger } from "../log.ts";
import {
	ACCEPTANCE_FIELD,
	type MigrationReport,
	planBodyMigration,
	toChecklist,
} from "./acceptance.ts";
import {
	type ClaimGroupsReport,
	rewriteClaimSidecars,
} from "./claim-groups.ts";
import { flatBoardError } from "./extras.ts";
import {
	emptyRunState,
	patchRunState,
	type RunState,
	readRunState,
	writeRunState,
} from "./run-state.ts";
import {
	dematerializeTaskFields,
	materializeTaskFrontmatter,
	type ReopenCondition,
	type TaskFrontmatter,
} from "./types.ts";

/**
 * The daemon's stateful task index, built on `@mfw/board-core`'s stateless
 * `BoardStore` + `@mfw/board`'s claim semantics. Reproduces the OLD
 * `tasks/store.ts`'s `TaskStore` surface (same method names, same
 * `TaskRecord`/`TaskFile`/`TaskState` shapes) so `task-service.ts`'s business
 * logic needs minimal changes — only the HOW changed, not the shape.
 *
 * Deliberately NOT part of `@mfw/board`: an in-memory index, external-edit
 * detection, and a mass-delete circuit breaker are long-lived-consumer
 * concerns the stateless engine explicitly leaves to its caller (see
 * `board-core/src/store.ts`'s header comment).
 */

export { TaskOwnershipHeldError };

export class TaskConflict extends Error {
	constructor(
		readonly id: string,
		readonly currentRev: number,
	) {
		super(`${id} was modified: content rev is now ${currentRev}`);
		this.name = "TaskConflict";
	}
}

export class MalformedTaskFileError extends Error {
	constructor(
		readonly id: string,
		readonly path: string,
		readonly reason: string,
	) {
		super(
			`task ${id} cannot be changed because ${path} is malformed: ${reason}. ` +
				"Repair the task file on disk, then retry; its bytes were left unchanged.",
		);
		this.name = "MalformedTaskFileError";
	}
}

/** `@mfw/board-core`'s `MalformedDocumentError` carries no id (it only knows
 * the file path) — translate it to the daemon's own, id-carrying class at
 * every boundary a caller might be mid-mutation against a known task id. */
function translateMalformed(e: unknown, id: string): never {
	if (e instanceof MalformedDocumentError) {
		throw new MalformedTaskFileError(id, e.path, e.reason);
	}
	throw e;
}

/** `MFW-12-slug` → `MFW-12`, for a malformed task whose frontmatter cannot be
 * trusted to give its own id. Mirrors `adrs.ts`'s `idFromFileName`. */
function idFromTaskDirName(key: string, name: string): string | null {
	const m = new RegExp(`^(${key}-[1-9][0-9]*)(?:-.*)?$`).exec(name);
	return m ? (m[1] as string) : null;
}

/** One item of the task's `acceptance` checklist field (`done` on disk). */
export interface TaskCriterion {
	/** The checklist item id (`c1`, ...); absent on an item not yet written. */
	id?: string;
	text: string;
	checked: boolean;
}

function criteriaOf(fields: Record<string, unknown>): TaskCriterion[] {
	const items = (fields[ACCEPTANCE_FIELD] as ChecklistItem[] | undefined) ?? [];
	return items.map((i) => ({ id: i.id, text: i.text, checked: i.done }));
}

function acceptanceOf(
	criteria: readonly TaskCriterion[],
	previous: readonly TaskCriterion[] = [],
): ChecklistItem[] {
	return toChecklist(
		criteria.map((c) => ({
			...(c.id !== undefined ? { id: c.id } : {}),
			text: c.text.replace(/\r?\n/g, " ").trim(),
			done: c.checked,
		})),
		previous,
	);
}

export interface TaskFile {
	frontmatter: TaskFrontmatter;
	body: string;
	criteria: TaskCriterion[];
	dod: TaskFrontmatter["verification"];
}

/** Merge of `@mfw/board`'s lease (cross-process-meaningful) and the daemon's
 * own run-state sidecar (daemon-only bookkeeping) — same flat shape the old
 * `TaskState` had, so callers don't need to know it's now two files. */
export interface TaskState extends RunState, TaskLease {}

export interface TaskRecord {
	id: string;
	num: number;
	status: TaskStatus;
	path: string;
	hash: string;
	file: TaskFile;
	state: TaskState;
}

export interface CreateInput {
	title: string;
	body?: string;
	type?: TaskFrontmatter["type"];
	priority?: TaskFrontmatter["priority"];
	size?: TaskFrontmatter["size"];
	labels?: string[];
	dependsOn?: string[];
	criteria?: TaskCriterion[];
	dod?: TaskFrontmatter["verification"];
	spikeTimebox?: string | null;
	requiresResources?: TaskFrontmatter["requires_resources"];
	executionTarget?: string;
	localStagingResources?: TaskFrontmatter["local_staging_resources"];
	workloadSecretGrants?: TaskFrontmatter["workload_secret_grants"];
	requireReview?: boolean;
	parentId?: string | null;
	splitFromId?: string | null;
	lifetimeDefId?: string | null;
	source?: TaskFrontmatter["source"];
	status?: TaskStatus;
	id?: string;
	draftPrompt?: string | null;
	afterExpansion?: "backlog" | "ready";
	readyMode?: "automatic" | "manual";
	captureId?: string | null;
	owns?: string[];
	modelTier?: TaskFrontmatter["model_tier"];
	provider?: string | null;
	model?: string | null;
	discoveredFrom?: string | null;
	discoveryKey?: string | null;
	reopenWhen?: ReopenCondition[];
	/**
	 * Provenance (`brain:<actionId>#<n>`), written with the document. Doubles as
	 * the brain's idempotency key: a create whose key is already on the board
	 * returns that task instead of writing another.
	 */
	createdBy?: string | null;
}

/** Why a task may not sit under a parent, in the board's own words. */
export interface HierarchyProblem {
	code:
		| "parent_not_found"
		| "hierarchy_cycle"
		| "parent_type_not_allowed"
		| "max_depth";
	message: string;
}

export interface ExternalChange {
	kind: "created" | "edited" | "moved" | "deleted";
	id: string;
	title: string;
	from?: TaskStatus;
	to?: TaskStatus;
}

export interface QuarantineNote {
	file: string;
	reason: string;
}

export interface LoadReport {
	loaded: number;
	adopted: string[];
	quarantined: QuarantineNote[];
	changes: ExternalChange[];
	suspended?: BoardSuspicion;
}

export interface BoardSuspicion {
	/** `"sentinel"` is a legacy name from when a literal marker file was the
	 * signal (MFW-ADR-7); it now means "the tasks directory itself looks
	 * absent", kept as-is so the shared `board.suspended` event schema
	 * (`@mfw/core/events`) doesn't need a matching change. */
	reason: "sentinel" | "mass-delete";
	indexed: number;
	found: number;
	lost: number;
}

const BREAKER_MIN_LOST = 5;

const eqJson = (a: unknown, b: unknown) =>
	JSON.stringify(a) === JSON.stringify(b);

export function sortIds(ids: string[]): string[] {
	const numSuffix = (id: string) => Number(id.slice(id.lastIndexOf("-") + 1));
	return [...ids].sort((a, b) => numSuffix(a) - numSuffix(b));
}

export interface TaskIndexDeps {
	/** The board folder: where `tasks/` (and `board.yaml`) live. */
	boardDir: string;
	/** The daemon's directory (`<repo>/.mfw`): per-task sidecars, locks and id
	 * counters. Nothing but board files is written into `boardDir`. */
	stateDir: string;
	config: BoardConfig;
	taskKey: string;
	log: Logger;
}

export class TaskIndex {
	private readonly board: BoardStore;
	private readonly config: BoardConfig;
	/** The board folder. */
	private readonly root: string;
	/** Where sidecars, locks and counters go. */
	private readonly state: string;
	private readonly taskKey: string;
	/** The claim lock's fixed half: root and field names. The status VALUES a
	 * claim compares and writes are board vocabulary, translated per claim. */
	private readonly claimConfig: Pick<
		ClaimConfig,
		"root" | "statusField" | "dependsOnField" | "ownsField"
	>;
	/** The board's status vocabulary, translated at this boundary: everything
	 * inside the index (and behind it) only ever sees the canonical eight. */
	private readonly statusMap: StatusMap;
	/** A flat task type's document IS the task file: there is no per-task
	 * directory, so nothing may be handed one. */
	private readonly flatLayout: boolean;
	/**
	 * One lock serializing every create/update: `@mfw/board-core`'s per-document
	 * locking can't by itself prevent a race ACROSS two different ids — two
	 * reciprocal `depends_on` edges, or two concurrent creates racing the same
	 * `discoveryKey`, each only lock their OWN id and can both read the other's
	 * stale pre-write state. The old `TaskStore` had exactly this same board-wide
	 * lock around every mutation for the same reason (MFW-ADR-2's `BOARD_LOCK`).
	 */
	private readonly boardLock: KeyedLock;
	private readonly index = new Map<string, TaskRecord>();
	private readonly seen = new Map<string, string>(); // id -> hash
	private suspicion: BoardSuspicion | null = null;
	private wiping = 0;

	constructor(deps: TaskIndexDeps) {
		this.config = deps.config;
		this.root = deps.boardDir;
		this.state = deps.stateDir;
		this.taskKey = deps.taskKey;
		this.board = new BoardStore(deps.boardDir, deps.config, {
			stateDir: join(deps.stateDir, ".board"),
		});
		this.boardLock = new KeyedLock(join(deps.stateDir, "locks"));
		// Parsing here IS the attach check: a board whose statuses cannot be
		// translated refuses to load, with the map to add in its message. A
		// board with no task type has nothing to translate against; it stays
		// exactly as unusable as before (the store refuses it on first use).
		const taskType = deps.config.types.task;
		this.statusMap = taskType
			? parseStatusMap(deps.config.extensions, taskType)
			: { toCanonical: (v) => v as TaskStatus, toBoard: (r) => r };
		this.flatLayout = taskType?.layout === "flat";
		this.claimConfig = {
			root: this.state,
			statusField: "status",
			dependsOnField: "depends_on",
			ownsField: "owns",
		};
	}

	get tasksDir(): string {
		return join(this.root, "tasks");
	}

	get boardSuspicion(): BoardSuspicion | null {
		return this.suspicion;
	}

	// --- reads (pure memory) ------------------------------------------------

	get(id: string): TaskRecord | undefined {
		return this.index.get(id);
	}

	list(): TaskRecord[] {
		return [...this.index.values()].sort((a, b) => a.num - b.num);
	}

	// --- record construction -------------------------------------------------

	/** A board document's status read through the map: `undefined` when the
	 * document has none at all (missing status = simply not `done`, not
	 * `draft`), never a raw board value. */
	private readStatus(
		fields: Record<string, unknown> | undefined,
	): TaskStatus | undefined {
		const raw = fields?.status;
		return typeof raw === "string"
			? this.statusMap.toCanonical(raw)
			: undefined;
	}

	/**
	 * A hand edit that doesn't bump `rev:` must still break optimistic
	 * concurrency (MFW-ADR-6: a hand edit and a stale UI save must not silently
	 * overwrite each other). `@mfw/board-core` is stateless and has no memory
	 * of a "prior" version to compare against, so this reconciliation — bump
	 * the EFFECTIVE rev past what the file says whenever the content hash moved
	 * but the file's own `rev:` field didn't — is the daemon's job. The bump is
	 * lazy: it lives only in the in-memory index until the next real write,
	 * which persists it (same as the old `TaskStore.reread`).
	 */
	private async toRecord(
		doc: BoardDocument,
		opts: { skipBumpCheck?: boolean } = {},
	): Promise<TaskRecord> {
		// `skipBumpCheck` is for a document we JUST wrote ourselves: comparing
		// against `this.index`'s current entry would be comparing against an
		// intermediate value `updateLocked` cached mid-transaction for its own
		// conflict check, not a genuine external edit — using it here would
		// double-bump `rev` on top of `@mfw/board-core`'s own increment.
		const prior = opts.skipBumpCheck ? undefined : this.index.get(doc.id);
		const rev =
			prior && prior.hash !== doc.hash && prior.file.frontmatter.rev === doc.rev
				? doc.rev + 1
				: doc.rev;
		const fm = materializeTaskFrontmatter(
			doc.fields,
			doc.id,
			rev,
			this.statusMap,
		);
		const lease = await readLease(this.state, doc.id);
		const runState = await readRunState(this.state, doc.id);
		const num = parseIdNum(this.taskKey, undefined, doc.id) ?? 0;
		return {
			id: doc.id,
			num,
			status: fm.status,
			path: doc.path,
			hash: doc.hash,
			file: {
				frontmatter: fm,
				body: doc.body,
				criteria: criteriaOf(doc.fields),
				dod: fm.verification,
			},
			state: { ...runState, ...lease },
		};
	}

	/** Re-read one task fresh from disk (bypassing the in-memory index). */
	private async reread(id: string): Promise<TaskRecord | undefined> {
		const doc = await this.board.readDocument("task", id);
		if (!doc) return undefined;
		const rec = await this.toRecord(doc);
		this.index.set(id, rec);
		this.seen.set(id, doc.hash);
		return rec;
	}

	// --- load / refresh / circuit breaker ------------------------------------

	async load(): Promise<LoadReport> {
		return this.boardLock.with("::board", () => this.loadLocked());
	}

	private assessScan(
		before: ReadonlyMap<string, TaskRecord>,
		currentIds: ReadonlySet<string>,
	): BoardSuspicion | null {
		if (this.wiping > 0) return null;
		const indexed = before.size;
		if (indexed === 0) return null;
		if (!existsSync(this.tasksDir)) {
			return { reason: "sentinel", indexed, found: 0, lost: indexed };
		}
		let lost = 0;
		for (const id of before.keys()) if (!currentIds.has(id)) lost++;
		const found = currentIds.size;
		if (lost >= BREAKER_MIN_LOST && lost >= Math.ceil(indexed / 2)) {
			return { reason: "mass-delete", indexed, found, lost };
		}
		return null;
	}

	private async loadLocked(): Promise<LoadReport> {
		const report: LoadReport = {
			loaded: 0,
			adopted: [],
			quarantined: [],
			changes: [],
		};
		const before = new Map(this.index);
		const docs = await this.board.listDocuments("task");
		const currentIds = new Set(docs.map((d) => d.id));
		const suspicion = this.assessScan(before, currentIds);
		if (suspicion) {
			report.suspended = suspicion;
			this.suspicion = suspicion;
			return report;
		}
		this.suspicion = null;

		for (const issue of await this.board.validate()) {
			if (issue.type !== "task") continue;
			report.quarantined.push({ file: issue.path, reason: issue.message });
		}

		this.index.clear();
		this.seen.clear();
		for (const doc of docs) {
			const rec = await this.toRecord(doc);
			this.index.set(doc.id, rec);
			this.seen.set(doc.id, doc.hash);
			report.loaded++;
			const prev = before.get(doc.id);
			if (!prev) {
				report.changes.push({
					kind: "created",
					id: doc.id,
					title: rec.file.frontmatter.title,
					to: rec.status,
				});
			} else if (prev.status !== rec.status) {
				report.changes.push({
					kind: "moved",
					id: doc.id,
					title: rec.file.frontmatter.title,
					from: prev.status,
					to: rec.status,
				});
			} else if (prev.hash !== doc.hash) {
				report.changes.push({
					kind: "edited",
					id: doc.id,
					title: rec.file.frontmatter.title,
					to: rec.status,
				});
			}
			await this.finishReopen(rec);
		}
		for (const [id, prev] of before) {
			if (!this.index.has(id)) {
				report.changes.push({
					kind: "deleted",
					id,
					title: prev.file.frontmatter.title,
					from: prev.status,
				});
			}
		}
		await this.pruneOrphanState();
		return report;
	}

	async refresh(): Promise<ExternalChange[]> {
		const docs = await this.board.listDocuments("task");
		let dirty = this.suspicion !== null;
		for (const doc of docs) {
			if (this.seen.get(doc.id) !== doc.hash) dirty = true;
		}
		if (docs.length !== this.seen.size) dirty = true;
		if (!dirty) return [];
		const report = await this.boardLock.with("::board", () =>
			this.loadLocked(),
		);
		return report.changes;
	}

	private async pruneOrphanState(): Promise<void> {
		// Sidecars for a task no longer on the board are dead weight; drop them.
		const { readdir } = await import("node:fs/promises");
		let names: string[];
		try {
			names = await readdir(join(this.state, "state", "tasks"));
		} catch {
			return;
		}
		for (const name of names) {
			if (!name.endsWith(".json")) continue;
			const id = name.replace(/\.run\.json$|\.json$/, "");
			if (this.index.has(id)) continue;
			await rm(join(this.state, "state", "tasks", name), { force: true }).catch(
				() => {},
			);
		}
	}

	// --- dependency-cycle guard (mfw-specific; @mfw/board-core only checks on validate()) ---

	private async assertNoDependencyCycle(
		taskId: string,
		depIds: string[],
	): Promise<void> {
		const docs = await this.board.listDocuments("task");
		const adjacency = new Map<string, string[]>();
		for (const doc of docs) {
			if (doc.id === taskId) continue;
			adjacency.set(
				doc.id,
				(doc.fields.depends_on as string[] | undefined) ?? [],
			);
		}
		adjacency.set(taskId, depIds);
		const stack = [...depIds];
		const seen = new Set<string>();
		while (stack.length > 0) {
			const current = stack.pop() as string;
			if (current === taskId) {
				throw new Error(`task ${taskId}: depends_on would create a cycle`);
			}
			if (seen.has(current)) continue;
			seen.add(current);
			for (const next of adjacency.get(current) ?? []) stack.push(next);
		}
	}

	// --- create / update ------------------------------------------------------

	async create(input: CreateInput): Promise<TaskRecord> {
		return (await this.createWithOutcome(input)).record;
	}

	/**
	 * `create`, saying whether the task already existed (the `created_by`
	 * lookup found it): a replay after a crash must not announce it twice.
	 */
	async createWithOutcome(
		input: CreateInput,
	): Promise<{ record: TaskRecord; replayed: boolean }> {
		return this.boardLock.with("::board", () => this.createLocked(input));
	}

	/** True when the task type is a flat layout (no per-task directory, so no spec.md). */
	get flat(): boolean {
		return this.flatLayout;
	}

	/** Whether a task holds its files right now: status `in_progress` or a live claim, read from disk. */
	async holdsClaimNow(id: string): Promise<boolean> {
		const doc = await this.board.readDocument("task", id);
		if (!doc) return false;
		if (this.readStatus(doc.fields) === "in_progress") return true;
		const lease = await readLease(this.state, id);
		return (
			lease.claimedByGroupId !== null &&
			(lease.leaseExpiresAt === null || lease.leaseExpiresAt > Date.now())
		);
	}

	/**
	 * Where a new task with no explicit status starts: `backlog`, or for a board
	 * whose status map has no backlog column the nearest role it does declare,
	 * so "new task" works on a kanban board with only todo/doing/review/done.
	 */
	private initialStatus(): TaskStatus {
		for (const role of ["backlog", "draft", "ready"] as const) {
			try {
				this.statusMap.toBoard(role);
				return role;
			} catch {
				// not declared by this board's map; try the next role
			}
		}
		return "backlog";
	}

	private async createLocked(
		input: CreateInput,
	): Promise<{ record: TaskRecord; replayed: boolean }> {
		if (input.discoveryKey) {
			const existing = await this.board.listDocuments("task", {
				discovery_key: input.discoveryKey,
			});
			if (existing[0]) {
				return { record: await this.toRecord(existing[0]), replayed: true };
			}
		}
		if (input.createdBy) {
			// Re-read from disk: this is the lookup that makes a replay after a
			// crash (board written, action not yet applied) a no-op.
			const existing = await this.board.listDocuments("task", {
				created_by: input.createdBy,
			});
			if (existing[0]) {
				return { record: await this.toRecord(existing[0]), replayed: true };
			}
		}
		const dependsOn = sortIds([...new Set(input.dependsOn ?? [])]);
		if (input.id && dependsOn.length > 0) {
			await this.assertNoDependencyCycle(input.id, dependsOn);
		}
		const status = input.status ?? this.initialStatus();
		const now = new Date();
		const fm: Omit<TaskFrontmatter, "id" | "rev"> = {
			title: input.title,
			status,
			type: input.type ?? "implementation",
			priority: input.priority ?? "medium",
			size: input.size ?? null,
			labels: input.labels ?? [],
			parent: input.parentId ?? null,
			depends_on: dependsOn,
			spike_timebox: input.spikeTimebox ?? null,
			requires_resources: input.requiresResources ?? [],
			execution_target: input.executionTarget ?? "local",
			local_staging_resources: input.localStagingResources ?? [],
			workload_secret_grants: input.workloadSecretGrants ?? [],
			require_review: input.requireReview ?? false,
			created: now.toISOString(),
			source: input.source ?? "human",
			split_from: input.splitFromId ?? null,
			lifetime_def: input.lifetimeDefId ?? null,
			blocked_reason: null,
			draft_prompt: input.draftPrompt ?? null,
			after_expansion: input.afterExpansion ?? "ready",
			ready_mode: input.readyMode ?? "automatic",
			capture_id: input.captureId ?? null,
			owns: input.owns ?? [],
			model_tier: input.modelTier ?? null,
			// Only written when set, so a board whose board.yaml predates the
			// routing fields still accepts every task created without them.
			...(input.provider ? { provider: input.provider } : {}),
			...(input.model ? { model: input.model } : {}),
			discovered_from: input.discoveredFrom ?? null,
			discovery_key: input.discoveryKey ?? null,
			// Absent unless set: a board that predates the field still accepts
			// every task written without it.
			...(input.createdBy ? { created_by: input.createdBy } : {}),
			reopen_when: input.reopenWhen ?? [],
			verification: input.dod ?? null,
		};
		const doc = await this.board.createDocument("task", {
			id: input.id,
			fields: {
				...dematerializeTaskFields(fm, this.statusMap),
				[ACCEPTANCE_FIELD]: acceptanceOf(input.criteria ?? []),
			},
			body: (input.body ?? "").trim(),
		});
		await writeLease(this.state, doc.id, {
			...emptyLease(),
			statusChangedAt: now.getTime(),
		});
		await writeRunState(this.state, doc.id, emptyRunState());
		const rec = await this.toRecord(doc);
		this.index.set(doc.id, rec);
		this.seen.set(doc.id, doc.hash);
		// A hierarchy board lists the child on its parent: that file changed too.
		if (input.parentId) await this.reread(input.parentId);
		return { record: rec, replayed: false };
	}

	async update(
		id: string,
		mutate: (draft: TaskFile, rec: TaskRecord) => string[] | Promise<string[]>,
		opts: { baseRev?: number; status?: TaskStatus } = {},
	): Promise<{ record: TaskRecord; fields: string[] }> {
		return this.boardLock.with("::board", () =>
			this.updateLocked(id, mutate, opts),
		);
	}

	private async updateLocked(
		id: string,
		mutate: (draft: TaskFile, rec: TaskRecord) => string[] | Promise<string[]>,
		opts: { baseRev?: number; status?: TaskStatus } = {},
	): Promise<{ record: TaskRecord; fields: string[] }> {
		let fields: string[] = [];
		let result: BoardDocument | null;
		try {
			result = await this.board.transact("task", id, async (current) => {
				// `toRecord` already applies MFW-ADR-6's rev-bump reconciliation (a
				// hand edit that doesn't bump `rev:` still must not silently pass a
				// stale baseRev check) by comparing against the index's prior entry
				// for this id, which still holds the pre-write value here. Cache the
				// result BEFORE the conflict check, same as the old store's
				// `reread()`: a rejected save must not leave the index showing stale
				// pre-hand-edit content.
				const rec = await this.toRecord(current);
				const effectiveRev = rec.file.frontmatter.rev;
				this.index.set(id, rec);
				this.seen.set(id, current.hash);
				if (opts.baseRev !== undefined && opts.baseRev !== effectiveRev) {
					throw new TaskConflict(id, effectiveRev);
				}
				const draft: TaskFile = structuredClone(rec.file);
				fields = await mutate(draft, rec);
				// `draft.dod` is a compatibility alias of `draft.frontmatter.verification`
				// for callers still written against the old TaskFile shape (where `dod`
				// was the only slot, since frontmatter had nowhere to put it) - keep
				// them in sync so a mutate callback that only touches one still persists.
				draft.frontmatter.verification = draft.dod;
				const statusChanged =
					opts.status !== undefined && opts.status !== rec.status;
				if (fields.length === 0 && !statusChanged) return null;
				if (
					!eqJson(rec.file.frontmatter.depends_on, draft.frontmatter.depends_on)
				) {
					await this.assertNoDependencyCycle(id, draft.frontmatter.depends_on);
				}
				const patchFields = dematerializeTaskFields(
					draft.frontmatter,
					this.statusMap,
				);
				patchFields[ACCEPTANCE_FIELD] = acceptanceOf(
					draft.criteria,
					rec.file.criteria,
				);
				if (opts.status !== undefined) {
					patchFields.status = this.statusMap.toBoard(opts.status);
				}
				return { fields: patchFields, body: draft.body.trim() };
			});
		} catch (e) {
			translateMalformed(e, id);
		}
		if (!result) {
			const rec = (await this.reread(id)) ?? this.index.get(id);
			if (!rec) throw new Error(`unknown task ${id}`);
			return { record: rec, fields: [] };
		}
		const statusChanged =
			opts.status !== undefined && opts.status !== this.index.get(id)?.status;
		const rec = await this.toRecord(result, { skipBumpCheck: true });
		if (statusChanged || opts.status !== undefined) {
			await writeLease(this.state, id, {
				...(await readLease(this.state, id)),
				statusChangedAt: Date.now(),
			});
			rec.state.statusChangedAt = Date.now();
		}
		this.index.set(id, rec);
		this.seen.set(id, result.hash);
		return { record: rec, fields };
	}

	async setStatus(
		id: string,
		to: TaskStatus,
		reason?: string | null,
		editedBy?: string,
	): Promise<TaskRecord | undefined> {
		const wantReason = to === "blocked" ? (reason ?? null) : null;
		const stamp =
			editedBy && this.declaresField("edited_by") ? editedBy : undefined;
		const result = await this.update(
			id,
			(draft) => {
				const fields: string[] = [];
				if (draft.frontmatter.blocked_reason !== wantReason) {
					draft.frontmatter.blocked_reason = wantReason;
					fields.push("blocked_reason");
				}
				if (stamp && draft.frontmatter.edited_by !== stamp) {
					draft.frontmatter.edited_by = stamp;
					fields.push("edited_by");
				}
				return fields;
			},
			{ status: to },
		);
		return result.record;
	}

	// --- hierarchy, provenance, live ownership --------------------------------

	/** Whether the task type declares `name` (provenance fields on an old board.yaml may not). */
	declaresField(name: string): boolean {
		return name in (this.config.types.task?.fields ?? {});
	}

	/** The board's hierarchy block, when the task type takes part in it. */
	private hierarchy() {
		const h = this.config.hierarchy;
		return h && h.parent in (this.config.types.task?.fields ?? {}) ? h : null;
	}

	/** The task with this `created_by`, read from disk (never the cache). */
	async findByCreatedBy(key: string): Promise<TaskRecord | null> {
		if (!this.declaresField("created_by")) return null;
		const [doc] = await this.board.listDocuments("task", { created_by: key });
		return doc ? this.toRecord(doc) : null;
	}

	/** Every task whose `created_by` starts with `prefix`, from disk. */
	async findCreatedByPrefix(prefix: string): Promise<TaskRecord[]> {
		if (!this.declaresField("created_by")) return [];
		const out: TaskRecord[] = [];
		for (const doc of await this.board.listDocuments("task")) {
			const by = doc.fields.created_by;
			if (typeof by === "string" && by.startsWith(prefix)) {
				out.push(await this.toRecord(doc));
			}
		}
		return out;
	}

	/**
	 * Depth of the chain above `parentId` (the parent itself counts) plus the
	 * height of `selfId`'s subtree: board-core's `maxDepth` measure, computed on
	 * the index so a validator can answer without a write.
	 */
	private chainDepth(parentId: string | null, selfId: string | null): number {
		let up = 0;
		const seen = new Set<string>();
		for (
			let cur: string | null = parentId;
			cur && !seen.has(cur);
			cur = this.index.get(cur)?.file.frontmatter.parent ?? null
		) {
			seen.add(cur);
			up++;
		}
		const height = (id: string, trail: Set<string>): number => {
			if (trail.has(id)) return 0;
			trail.add(id);
			let best = 0;
			for (const r of this.index.values()) {
				if (r.file.frontmatter.parent === id) {
					best = Math.max(best, 1 + height(r.id, trail));
				}
			}
			return best;
		};
		return up + (selfId ? height(selfId, new Set()) : 0);
	}

	/**
	 * Would `child` (an existing task, or a hypothetical one named by its board
	 * fields) be allowed under `parentId`? The same rules the store enforces on
	 * the write, answered without one: existence, no cycle, the hierarchy
	 * block's type rules and `maxDepth`.
	 */
	hierarchyProblem(
		child: { id?: string; fields: Record<string, unknown> },
		parentId: string,
		/** Board fields to judge the parent by instead of its current ones (a split turning it into an epic). */
		opts: { parentFields?: Record<string, unknown> } = {},
	): HierarchyProblem | null {
		const parent = this.index.get(parentId);
		if (!parent) {
			return {
				code: "parent_not_found",
				message: `parent '${parentId}' does not exist`,
			};
		}
		if (child.id) {
			if (parentId === child.id) {
				return {
					code: "hierarchy_cycle",
					message: "a task cannot be its own parent",
				};
			}
			const seen = new Set<string>();
			for (
				let cur: string | null = parent.file.frontmatter.parent;
				cur && !seen.has(cur);
				cur = this.index.get(cur)?.file.frontmatter.parent ?? null
			) {
				if (cur === child.id) {
					return {
						code: "hierarchy_cycle",
						message: `'${parentId}' is already under '${child.id}'; that would make a cycle`,
					};
				}
				seen.add(cur);
			}
		}
		const h = this.hierarchy();
		if (!h) return null;
		const rawOf = (rec: TaskRecord) =>
			dematerializeTaskFields(rec.file.frontmatter, this.statusMap);
		if (h.rules) {
			const problem = parentRuleProblem(
				h.rules,
				{ type: "task", fields: child.fields },
				{ type: "task", fields: opts.parentFields ?? rawOf(parent) },
			);
			if (problem) return { code: "parent_type_not_allowed", message: problem };
		}
		if (h.maxDepth !== undefined) {
			const depth = this.chainDepth(parentId, child.id ?? null);
			if (depth > h.maxDepth) {
				return {
					code: "max_depth",
					message: `parent chain would be ${depth} deep (maxDepth is ${h.maxDepth})`,
				};
			}
		}
		return null;
	}

	/** The hierarchy's type rules alone, for two tasks that may not exist yet. */
	rulesProblem(
		child: Record<string, unknown>,
		parent: Record<string, unknown>,
	): HierarchyProblem | null {
		const rules = this.hierarchy()?.rules;
		if (!rules) return null;
		const problem = parentRuleProblem(
			rules,
			{ type: "task", fields: child },
			{ type: "task", fields: parent },
		);
		return problem
			? { code: "parent_type_not_allowed", message: problem }
			: null;
	}

	/** The board's `maxDepth`, when its hierarchy declares one. */
	get maxDepth(): number | undefined {
		return this.hierarchy()?.maxDepth;
	}

	/** Nodes on the chain from `id` up, `id` included (a parent's contribution to its child's depth). */
	depthOf(id: string | null): number {
		return this.chainDepth(id, null);
	}

	/** A task's fields as the board holds them (the shape hierarchy rules match on). */
	boardFields(id: string): Record<string, unknown> | null {
		const rec = this.index.get(id);
		return rec
			? dematerializeTaskFields(rec.file.frontmatter, this.statusMap)
			: null;
	}

	/** The board value a task of this canonical status would be written with. */
	boardFieldsFor(fm: {
		type: string;
		priority: string;
		status: TaskStatus;
	}): Record<string, unknown> {
		return {
			type: fm.type,
			priority: fm.priority,
			status: this.boardStatusFor(fm.status) ?? fm.status,
		};
	}

	/**
	 * Move a task under another parent (or to the top). Through the board's own
	 * hierarchy write when the board declares one (rules, depth, `children`
	 * kept in sync), a plain field write otherwise. `baseRev` is the caller's
	 * view of the task, checked against the effective rev.
	 */
	async setParent(
		id: string,
		parentId: string | null,
		opts: { baseRev?: number; editedBy?: string } = {},
	): Promise<{ record: TaskRecord; changed: boolean }> {
		return this.boardLock.with("::board", async () => {
			const rec = await this.reread(id);
			if (!rec) throw new Error(`unknown task ${id}`);
			const rev = rec.file.frontmatter.rev;
			if (opts.baseRev !== undefined && opts.baseRev !== rev) {
				throw new TaskConflict(id, rev);
			}
			if (rec.file.frontmatter.parent === parentId) {
				return { record: rec, changed: false };
			}
			if (parentId) {
				const problem = this.hierarchyProblem(
					{
						id,
						fields: dematerializeTaskFields(
							rec.file.frontmatter,
							this.statusMap,
						),
					},
					parentId,
				);
				if (problem) {
					throw new HierarchyError(
						problem.code === "max_depth"
							? "max-depth"
							: problem.code === "hierarchy_cycle"
								? "cycle"
								: problem.code === "parent_not_found"
									? "parent-not-found"
									: "parent-type-not-allowed",
						"task",
						id,
						problem.message,
					);
				}
			}
			const edited =
				opts.editedBy && this.declaresField("edited_by")
					? { edited_by: opts.editedBy }
					: {};
			let doc: BoardDocument;
			try {
				const h = this.hierarchy();
				doc = await this.board.updateDocument("task", id, {
					fields: { [h?.parent ?? "parent"]: parentId, ...edited },
				});
			} catch (e) {
				translateMalformed(e, id);
			}
			const next = await this.toRecord(doc, { skipBumpCheck: true });
			this.index.set(id, next);
			this.seen.set(id, doc.hash);
			// A hierarchy board keeps `children` on both parents: they changed too.
			for (const pid of [rec.file.frontmatter.parent, parentId]) {
				if (pid) await this.reread(pid);
			}
			return { record: next, changed: true };
		});
	}

	/**
	 * Other tasks that hold their files now (status `in_progress` or a live
	 * claim) and whose `owns` overlaps `owns`. Reads the claim sidecars from
	 * disk: call it inside `withClaimLock` to make the answer binding.
	 */
	async liveOwnsOverlaps(
		id: string,
		owns: readonly string[],
	): Promise<{ id: string; patterns: [string, string][] }[]> {
		if (owns.length === 0) return [];
		const out: { id: string; patterns: [string, string][] }[] = [];
		for (const doc of await this.board.listDocuments("task")) {
			if (doc.id === id) continue;
			const theirs = (doc.fields.owns as string[] | undefined) ?? [];
			const patterns = overlappingPatterns(owns, theirs);
			if (patterns.length === 0) continue;
			const lease = await readLease(this.state, doc.id);
			const leaseLive =
				lease.claimedByGroupId !== null &&
				(lease.leaseExpiresAt === null || lease.leaseExpiresAt > Date.now());
			const active = this.readStatus(doc.fields) === "in_progress" || leaseLive;
			if (active) out.push({ id: doc.id, patterns });
		}
		return out;
	}

	/** The canonical status roles this board can write (the others have no column). */
	statusRolesAvailable(): TaskStatus[] {
		const roles: TaskStatus[] = [
			"draft",
			"backlog",
			"ready",
			"in_progress",
			"blocked",
			"review",
			"done",
			"archived",
		];
		return roles.filter((r) => {
			try {
				this.statusMap.toBoard(r);
				return true;
			} catch {
				return false;
			}
		});
	}

	/** The board's own word for a canonical status role (for a refusal's fix). */
	boardStatusFor(role: TaskStatus): string | null {
		try {
			return this.statusMap.toBoard(role);
		} catch {
			return null;
		}
	}

	// --- claim / release --------------------------------------------------

	/** Run `fn` under the lock `claim()` holds, so no claim lands meanwhile. */
	withClaimLock<T>(fn: () => Promise<T>): Promise<T> {
		return withClaimLock(this.claimConfig, fn);
	}

	async claim(
		id: string,
		runId: string,
		leaseMs: number,
		fromStatus: TaskStatus = "ready",
		leadRunId?: string,
	): Promise<TaskRecord | null> {
		// `claimTask` finds its candidate via `listDocuments`, which silently
		// skips a malformed entry (one bad file must not hide the others) — that
		// would otherwise make a broken task's claim just quietly fail instead of
		// surfacing the real reason. Check readability explicitly first.
		try {
			await this.board.readDocument("task", id);
		} catch (e) {
			translateMalformed(e, id);
		}
		const doc = await claimTask(
			this.board,
			id,
			runId,
			leaseMs,
			// The claim lock compares and writes board values, so both the
			// status it comes FROM and the two it knows how to write are
			// translated here — and nowhere else.
			this.statusMap.toBoard(fromStatus),
			{
				...this.claimConfig,
				doneStatus: this.statusMap.toBoard("done"),
				activeStatus: this.statusMap.toBoard("in_progress"),
			},
			leadRunId ? { leadRunId } : {},
		);
		if (!doc) return null;
		const rec = await this.toRecord(doc);
		this.index.set(id, rec);
		this.seen.set(id, doc.hash);
		return rec;
	}

	/** Reserve a `draft` for its expansion run without changing status. */
	async claimDraftExpansion(
		id: string,
		runId: string,
		leaseMs: number,
	): Promise<{ record: TaskRecord; alreadyOwned: boolean } | null> {
		const doc = await this.board.readDocument("task", id);
		if (this.readStatus(doc?.fields) !== "draft") return null;
		const lease = await readLease(this.state, id);
		const now = Date.now();
		if (lease.claimedByGroupId === runId) {
			await writeLease(this.state, id, {
				...lease,
				leaseExpiresAt: now + leaseMs,
			});
			const rec = await this.reread(id);
			return rec ? { record: rec, alreadyOwned: true } : null;
		}
		if (lease.claimedByGroupId !== null) return null;
		await writeLease(this.state, id, {
			...lease,
			claimedByGroupId: runId,
			leadRunId: null,
			claimedAt: now,
			leaseExpiresAt: now + leaseMs,
		});
		const rec = await this.reread(id);
		return rec ? { record: rec, alreadyOwned: false } : null;
	}

	/**
	 * Clear a claim and move the task's status; counterpart to `claim()`. Only
	 * a claim held by a DIFFERENT run refuses — an unclaimed task must go
	 * through (`review`'s already dropped its claim; `onMerged` still releases
	 * it to `done` quoting the run id). `resumeCount` resets on a clean landing
	 * (done/review), daemon-only bookkeeping `@mfw/board`'s generic release
	 * knows nothing about.
	 */
	async releaseClaim(
		id: string,
		expectedRunId: string | null,
		to: TaskStatus,
		reason: string | null,
	): Promise<{
		record: TaskRecord;
		from: TaskStatus;
		releasedRunId: string | null;
	} | null> {
		const lease = await readLease(this.state, id);
		const held = lease.claimedByGroupId;
		if (held !== null && held !== expectedRunId) return null;
		const current = await this.board.readDocument("task", id);
		if (!current) return null;
		const from = this.statusMap.toCanonical(current.fields.status as string);
		if (to === "done" || to === "review") {
			await patchRunState(this.state, id, { resumeCount: 0 });
		}
		const record = await this.setStatus(id, to, reason);
		if (!record) return null;
		await writeLease(this.state, id, {
			claimedByGroupId: null,
			leadRunId: null,
			claimedAt: null,
			leaseExpiresAt: null,
			statusChangedAt: Date.now(),
			worktree: null,
		});
		const rec = await this.reread(id);
		return rec ? { record: rec, from, releasedRunId: held } : null;
	}

	// --- reopen conditions --------------------------------------------------

	/**
	 * Called both from `reopen()` (unlocked at that point) and from inside
	 * `loadLocked()` (already holding `::board`) — `updateLocked`, not the
	 * public `update()`, so the latter case does not deadlock on its own lock.
	 */
	private async finishReopen(rec: TaskRecord): Promise<void> {
		const intent = rec.state.reopenIntent;
		if (!intent || rec.status !== "ready") return;
		if (eqJson(rec.file.frontmatter.reopen_when, intent.conditions)) {
			await this.updateLocked(rec.id, (draft) => {
				draft.frontmatter.reopen_when = [];
				draft.frontmatter.blocked_reason = null;
				return ["reopen_when", "blocked_reason"];
			});
		}
		await patchRunState(this.state, rec.id, { reopenIntent: undefined });
	}

	async reopen(
		id: string,
		conditions: ReopenCondition[],
		eligible: (rec: TaskRecord) => Promise<boolean>,
	): Promise<{ from: TaskStatus } | null> {
		const rec = await this.reread(id);
		if (
			!rec ||
			conditions.length === 0 ||
			!eqJson(rec.file.frontmatter.reopen_when, conditions) ||
			!(await eligible(rec))
		) {
			return null;
		}
		const docs = await this.board.listDocuments("task");
		const byId = new Map(docs.map((d) => [d.id, d]));
		if (
			conditions.some(
				(c) =>
					"task_done" in c &&
					this.readStatus(byId.get(c.task_done)?.fields) !== "done",
			)
		) {
			return null;
		}
		if (
			rec.file.frontmatter.depends_on.some(
				(d) => this.readStatus(byId.get(d)?.fields) !== "done",
			)
		) {
			return null;
		}
		const from = rec.status;
		await patchRunState(this.state, id, {
			stallCount: 0,
			attemptCount: 0,
			resumeCount: 0,
			reopenIntent: { conditions },
		});
		const result = await this.update(id, () => [], { status: "ready" });
		await this.finishReopen(result.record);
		return { from };
	}

	// --- claim group migration -----------------------------------------------

	/** Rename every legacy sidecar's holder key under the claim lock. */
	async migrateClaimSidecars(): Promise<ClaimGroupsReport> {
		return this.withClaimLock(() => rewriteClaimSidecars(this.state));
	}

	// --- acceptance migration ------------------------------------------------

	/**
	 * Move each task's `## Acceptance Criteria` body list into its
	 * `acceptance` field (see `acceptance.ts`), every task re-read and
	 * rewritten under its own document lock and the board lock. Refuses while
	 * the circuit breaker distrusts the board (returns null): rewriting a board
	 * that may be a stale checkout would make it permanent. A task a board rule
	 * refuses keeps its body and is reported as skipped.
	 */
	async migrateBodyCriteria(): Promise<MigrationReport | null> {
		return this.boardLock.with("::board", async () => {
			if (this.suspicion) return null;
			const report: MigrationReport = { migrated: [], skipped: [] };
			for (const doc of await this.board.listDocuments("task")) {
				const first = planBodyMigration(doc.body, criteriaOf(doc.fields)).kind;
				if (first === "none") continue;
				let skipped: string | null = null;
				let written: BoardDocument | null;
				try {
					written = await this.board.transact("task", doc.id, async (cur) => {
						const plan = planBodyMigration(cur.body, criteriaOf(cur.fields));
						if (plan.kind === "skip") skipped = plan.reason;
						if (plan.kind !== "move") return null;
						return {
							fields: { [ACCEPTANCE_FIELD]: toChecklist(plan.items) },
							body: plan.body,
						};
					});
				} catch (e) {
					if (e instanceof RuleViolationError) {
						report.skipped.push({ id: doc.id, reason: e.message });
						continue;
					}
					if (e instanceof MalformedDocumentError) {
						report.skipped.push({ id: doc.id, reason: e.reason });
						continue;
					}
					throw e;
				}
				if (skipped !== null) {
					report.skipped.push({ id: doc.id, reason: skipped });
				}
				if (!written) continue;
				const rec = await this.toRecord(written, { skipBumpCheck: true });
				this.index.set(doc.id, rec);
				this.seen.set(doc.id, written.hash);
				report.migrated.push(doc.id);
			}
			return report;
		});
	}

	// --- directory / spec / attachments -------------------------------------

	async withTaskDir<T>(
		id: string,
		fn: (dir: string) => Promise<T>,
	): Promise<T | null> {
		// On a flat board `dirname()` of the task's path is the type's OWN
		// directory, shared by every task: never hand that out as "the task's
		// directory" to write in.
		if (this.flatLayout) throw flatBoardError();
		const rec = this.index.get(id) ?? (await this.reread(id));
		return rec ? fn(dirname(rec.path)) : null;
	}

	// --- delete --------------------------------------------------------------

	async remove(id: string): Promise<boolean> {
		return this.boardLock.with("::board", () => this.removeLocked(id));
	}

	private async removeLocked(id: string): Promise<boolean> {
		let removed: boolean;
		try {
			removed = await this.board.deleteDocument("task", id);
		} catch (e) {
			translateMalformed(e, id);
		}
		if (!removed) return false;
		this.index.delete(id);
		this.seen.delete(id);
		await this.removeSidecars(id);
		return true;
	}

	/**
	 * Wiping and scanning both read the whole board; without a shared lock a
	 * scan queued mid-wipe would catch it half-emptied and mistake that for a
	 * `git reset --hard` (the mass-delete breaker). Holding `::board` for the
	 * whole wipe, not per task, makes a concurrent `load()`/`refresh()` wait
	 * for the wipe to finish rather than observe it in progress.
	 */
	async wipe(): Promise<string[]> {
		return this.boardLock.with("::board", () => this.wipeLocked());
	}

	private async wipeLocked(): Promise<string[]> {
		for (const issue of await this.board.validate()) {
			if (issue.type !== "task") continue;
			// A flat task's file is the document itself; a directory-layout
			// task's id is the name of the directory holding it.
			const name = this.flatLayout
				? basename(issue.path, ".md")
				: basename(dirname(issue.path));
			const id = idFromTaskDirName(this.taskKey, name) ?? name;
			throw new MalformedTaskFileError(id, issue.path, issue.message);
		}
		this.wiping++;
		try {
			const docs = await this.board.listDocuments("task");
			const removed: string[] = [];
			for (const doc of docs) {
				if (await this.removeLocked(doc.id)) removed.push(doc.id);
			}
			return removed;
		} finally {
			this.wiping--;
		}
	}

	private async removeSidecars(id: string): Promise<void> {
		await rm(join(this.state, "state", "tasks", `${id}.json`), {
			force: true,
		}).catch(() => {});
		await rm(join(this.state, "state", "tasks", `${id}.run.json`), {
			force: true,
		}).catch(() => {});
	}

	// --- sidecar state (disposable, merged lease+run-state) -------------------

	async patchState(
		id: string,
		patch: Partial<TaskState> | ((state: TaskState) => Partial<TaskState>),
	): Promise<TaskRecord | undefined> {
		const rec = this.index.get(id) ?? (await this.reread(id));
		if (!rec) return undefined;
		const delta = typeof patch === "function" ? patch(rec.state) : patch;
		const leaseKeys = new Set([
			"claimedByGroupId",
			"leadRunId",
			"claimedAt",
			"leaseExpiresAt",
			"statusChangedAt",
			"worktree",
		]);
		const leaseDelta: Partial<TaskLease> = {};
		const runDelta: Partial<RunState> = {};
		for (const [k, v] of Object.entries(delta)) {
			if (leaseKeys.has(k)) (leaseDelta as Record<string, unknown>)[k] = v;
			else (runDelta as Record<string, unknown>)[k] = v;
		}
		let lease = await readLease(this.state, id);
		if (Object.keys(leaseDelta).length > 0) {
			lease = { ...lease, ...leaseDelta };
			await writeLease(this.state, id, lease);
		}
		let runState = await readRunState(this.state, id);
		if (Object.keys(runDelta).length > 0) {
			runState = { ...runState, ...runDelta };
			await writeRunState(this.state, id, runState);
		}
		const updated: TaskRecord = { ...rec, state: { ...runState, ...lease } };
		this.index.set(id, updated);
		return updated;
	}
}

// Re-exported so callers that imported the generic release helper from
// `@mfw/board` directly through the old `./tasks/store.ts` barrel keep working.
export { boardReleaseClaim };
