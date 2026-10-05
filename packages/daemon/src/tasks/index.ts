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
	writeLease,
} from "@mfw/board";
import type { BoardConfig, BoardDocument } from "@mfw/board-core";
import {
	BoardStore,
	KeyedLock,
	MalformedDocumentError,
	parseIdNum,
} from "@mfw/board-core";
import type { TaskStatus } from "@mfw/core/types";
import type { Logger } from "../log.ts";
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

export interface TaskCriterion {
	text: string;
	checked: boolean;
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
	discoveredFrom?: string | null;
	discoveryKey?: string | null;
	reopenWhen?: ReopenCondition[];
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

const CRITERIA_HEADING_RE = /^##[ \t]+acceptance criteria[ \t]*$/im;
const CRITERION_RE = /^- (?:\[([ xX])\][ \t]*)?(.*)$/;
const HEADING_RE = /^#{1,2}[ \t]+\S/;
const BLANK_RE = /^[ \t]*$/;

/** Pull the (purely documentary — nothing treats it as acceptance evidence)
 * `## Acceptance Criteria` checklist out of the body, the same convention the
 * old taskfile.ts parser used, minus fence-awareness (criteria are cosmetic,
 * not worth re-building a fence scanner for). */
export function extractCriteria(raw: string): {
	body: string;
	criteria: TaskCriterion[];
} {
	const lines = raw.split("\n");
	let start = -1;
	for (let i = 0; i < lines.length; i++) {
		if (CRITERIA_HEADING_RE.test(lines[i] as string)) {
			start = i;
			break;
		}
	}
	if (start === -1) return { body: raw, criteria: [] };
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		if (HEADING_RE.test(lines[i] as string)) {
			end = i;
			break;
		}
	}
	const criteria: TaskCriterion[] = [];
	for (let i = start + 1; i < end; i++) {
		const line = lines[i] as string;
		if (BLANK_RE.test(line)) continue;
		const m = CRITERION_RE.exec(line);
		if (m) {
			criteria.push({
				text: (m[2] as string).trimEnd(),
				checked: ((m[1] as string | undefined) ?? "").toLowerCase() === "x",
			});
		}
	}
	let removeStart = start;
	while (removeStart > 0 && BLANK_RE.test(lines[removeStart - 1] as string))
		removeStart--;
	const body = [...lines.slice(0, removeStart), ...lines.slice(end)]
		.join("\n")
		.replace(/^(?:[ \t]*\n)+/, "")
		.replace(/\s+$/, "");
	return { body, criteria };
}

/** The inverse of `extractCriteria`: re-append the checklist to the body before writing. */
export function reassembleBody(
	body: string,
	criteria: readonly TaskCriterion[],
): string {
	const trimmed = body.trim();
	if (criteria.length === 0) return trimmed;
	const items = criteria.map((c) =>
		`- ${c.text.replace(/\r?\n/g, " ")}`.trimEnd(),
	);
	const section = `## Acceptance Criteria\n\n${items.join("\n")}`;
	return trimmed.length > 0 ? `${trimmed}\n\n${section}` : section;
}

const eqJson = (a: unknown, b: unknown) =>
	JSON.stringify(a) === JSON.stringify(b);

export function sortIds(ids: string[]): string[] {
	const numSuffix = (id: string) => Number(id.slice(id.lastIndexOf("-") + 1));
	return [...ids].sort((a, b) => numSuffix(a) - numSuffix(b));
}

export interface TaskIndexDeps {
	mfwDir: string;
	config: BoardConfig;
	taskKey: string;
	log: Logger;
}

export class TaskIndex {
	private readonly board: BoardStore;
	private readonly root: string;
	private readonly taskKey: string;
	private readonly claimConfig: ClaimConfig;
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
		this.root = deps.mfwDir;
		this.taskKey = deps.taskKey;
		this.board = new BoardStore(deps.mfwDir, deps.config);
		this.boardLock = new KeyedLock(join(deps.mfwDir, "locks"));
		this.claimConfig = {
			root: this.root,
			statusField: "status",
			dependsOnField: "depends_on",
			ownsField: "owns",
			doneStatus: "done",
			activeStatus: "in_progress",
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
		const fm = materializeTaskFrontmatter(doc.fields, doc.id, rev);
		const { body, criteria } = extractCriteria(doc.body);
		const lease = await readLease(this.root, doc.id);
		const runState = await readRunState(this.root, doc.id);
		const num = parseIdNum(this.taskKey, undefined, doc.id) ?? 0;
		return {
			id: doc.id,
			num,
			status: fm.status,
			path: doc.path,
			hash: doc.hash,
			file: { frontmatter: fm, body, criteria, dod: fm.verification },
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
			names = await readdir(join(this.root, "state", "tasks"));
		} catch {
			return;
		}
		for (const name of names) {
			if (!name.endsWith(".json")) continue;
			const id = name.replace(/\.run\.json$|\.json$/, "");
			if (this.index.has(id)) continue;
			await rm(join(this.root, "state", "tasks", name), { force: true }).catch(
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
		return this.boardLock.with("::board", () => this.createLocked(input));
	}

	private async createLocked(input: CreateInput): Promise<TaskRecord> {
		if (input.discoveryKey) {
			const existing = await this.board.listDocuments("task", {
				discovery_key: input.discoveryKey,
			});
			if (existing[0]) return this.toRecord(existing[0]);
		}
		const dependsOn = sortIds([...new Set(input.dependsOn ?? [])]);
		if (input.id && dependsOn.length > 0) {
			await this.assertNoDependencyCycle(input.id, dependsOn);
		}
		const status = input.status ?? "backlog";
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
			discovered_from: input.discoveredFrom ?? null,
			discovery_key: input.discoveryKey ?? null,
			reopen_when: input.reopenWhen ?? [],
			verification: input.dod ?? null,
		};
		const doc = await this.board.createDocument("task", {
			id: input.id,
			fields: dematerializeTaskFields(fm),
			body: reassembleBody(input.body ?? "", input.criteria ?? []),
		});
		await writeLease(this.root, doc.id, {
			...emptyLease(),
			statusChangedAt: now.getTime(),
		});
		await writeRunState(this.root, doc.id, emptyRunState());
		const rec = await this.toRecord(doc);
		// The canonical render never re-encodes a checkbox (same as the old
		// renderer); re-parsing the just-written body would silently clear every
		// `checked: true`. The caller's own criteria are authoritative here.
		rec.file.criteria = input.criteria ?? [];
		this.index.set(doc.id, rec);
		this.seen.set(doc.id, doc.hash);
		return rec;
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
		let criteria: TaskCriterion[] = [];
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
				criteria = draft.criteria;
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
				const patchFields = dematerializeTaskFields(draft.frontmatter);
				if (opts.status !== undefined) patchFields.status = opts.status;
				return {
					fields: patchFields,
					body: reassembleBody(draft.body, draft.criteria),
				};
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
		// Same reasoning as `create()`: the draft's criteria are authoritative,
		// the canonical render never re-encodes a checkbox.
		rec.file.criteria = criteria;
		if (statusChanged || opts.status !== undefined) {
			await writeLease(this.root, id, {
				...(await readLease(this.root, id)),
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
	): Promise<TaskRecord | undefined> {
		const wantReason = to === "blocked" ? (reason ?? null) : null;
		const result = await this.update(
			id,
			(draft) => {
				if (draft.frontmatter.blocked_reason === wantReason) return [];
				draft.frontmatter.blocked_reason = wantReason;
				return ["blocked_reason"];
			},
			{ status: to },
		);
		return result.record;
	}

	// --- claim / release --------------------------------------------------

	async claim(
		id: string,
		runId: string,
		leaseMs: number,
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
			"ready",
			this.claimConfig,
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
		if (doc?.fields.status !== "draft") return null;
		const lease = await readLease(this.root, id);
		const now = Date.now();
		if (lease.claimedByRunId === runId) {
			await writeLease(this.root, id, {
				...lease,
				leaseExpiresAt: now + leaseMs,
			});
			const rec = await this.reread(id);
			return rec ? { record: rec, alreadyOwned: true } : null;
		}
		if (lease.claimedByRunId !== null) return null;
		await writeLease(this.root, id, {
			...lease,
			claimedByRunId: runId,
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
		const lease = await readLease(this.root, id);
		const held = lease.claimedByRunId;
		if (held !== null && held !== expectedRunId) return null;
		const current = await this.board.readDocument("task", id);
		if (!current) return null;
		const from = current.fields.status as TaskStatus;
		if (to === "done" || to === "review") {
			await patchRunState(this.root, id, { resumeCount: 0 });
		}
		const record = await this.setStatus(id, to, reason);
		if (!record) return null;
		await writeLease(this.root, id, {
			claimedByRunId: null,
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
		await patchRunState(this.root, rec.id, { reopenIntent: undefined });
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
					"task_done" in c && byId.get(c.task_done)?.fields.status !== "done",
			)
		) {
			return null;
		}
		if (
			rec.file.frontmatter.depends_on.some(
				(d) => byId.get(d)?.fields.status !== "done",
			)
		) {
			return null;
		}
		const from = rec.status;
		await patchRunState(this.root, id, {
			stallCount: 0,
			attemptCount: 0,
			resumeCount: 0,
			reopenIntent: { conditions },
		});
		const result = await this.update(id, () => [], { status: "ready" });
		await this.finishReopen(result.record);
		return { from };
	}

	// --- directory / spec / attachments -------------------------------------

	async withTaskDir<T>(
		id: string,
		fn: (dir: string) => Promise<T>,
	): Promise<T | null> {
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
			const name = basename(dirname(issue.path));
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
		await rm(join(this.root, "state", "tasks", `${id}.json`), {
			force: true,
		}).catch(() => {});
		await rm(join(this.root, "state", "tasks", `${id}.run.json`), {
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
			"claimedByRunId",
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
		let lease = await readLease(this.root, id);
		if (Object.keys(leaseDelta).length > 0) {
			lease = { ...lease, ...leaseDelta };
			await writeLease(this.root, id, lease);
		}
		let runState = await readRunState(this.root, id);
		if (Object.keys(runDelta).length > 0) {
			runState = { ...runState, ...runDelta };
			await writeRunState(this.root, id, runState);
		}
		const updated: TaskRecord = { ...rec, state: { ...runState, ...lease } };
		this.index.set(id, updated);
		return updated;
	}
}

// Re-exported so callers that imported the generic release helper from
// `@mfw/board` directly through the old `./tasks/store.ts` barrel keep working.
export { boardReleaseClaim };
