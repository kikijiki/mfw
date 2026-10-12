import { filesOutsideOwns } from "@mfw/core/ownership";
import type { ProjectDbHandle } from "@mfw/db/client";
import { listReviewVerdicts, type ReviewVerdictRow } from "@mfw/db/outcomes";
import {
	decisions,
	events,
	type MergeJobState,
	reviewComments,
	runs,
} from "@mfw/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { git } from "./git.ts";
import { affectedPaths, parseDiffPaths } from "./git-diff-paths.ts";
import type { RunRegistry } from "./run-registry.ts";
import type { TaskService } from "./task-service.ts";

/**
 * Review v2: everything a human needs to judge agent work, in ONE
 * payload.
 *
 * v1 made this the product's weakest screen: a bare hand-rolled diff, with
 * inline comments faked as `[file:line]` text prepended to a body, and no way
 * to see the DoD results, the critic's verdict, the cost, or what the agent
 * said it did without leaving the page. Rejection threw the human's reasoning
 * away entirely and re-ran the agent with no new information.
 */

/** States a merge job passes through before it lands or parks: the window
 *  during which the task's decision has already been made (MFW-50). */
const ACTIVE_MERGE_STATES = [
	"queued",
	"merging",
	"rebasing",
	"reverifying",
] as const;
type ActiveMergeState = (typeof ACTIVE_MERGE_STATES)[number];

function isActiveMergeState(state: MergeJobState): state is ActiveMergeState {
	return (ACTIVE_MERGE_STATES as readonly string[]).includes(state);
}

export interface ReviewFile {
	path: string;
	status: "added" | "modified" | "deleted" | "renamed";
	oldText: string;
	newText: string;
	binary: boolean;
}

export interface ReviewBundle {
	taskId: string;
	acceptanceCriteria: string[];
	branch: string | null;
	baseSha: string | null;
	files: ReviewFile[];
	checks: { name: string; ok: boolean; detail?: string }[];
	acceptance: {
		outcome: string;
		detail: string;
		criteria: {
			criterion: string;
			verdict: "met" | "unmet" | "uncertain";
			/** Null for decisions recorded before evidence classes existed. */
			evidenceClass: EvidenceClass | null;
			evidence: string;
		}[];
	} | null;
	/** The task's declared `owns` and the diffed files it does not cover;
	 *  null when the task declares no scope. */
	scope: { owns: string[]; outside: string[] } | null;
	/** Which models built and judged this run, from the critic decision. */
	review: {
		implementerModel: string | null;
		reviewerModel: string | null;
		sameModel: boolean;
		/** Floored verdict; null for decisions that predate verdicts. */
		verdict: "merge" | "fix" | "reject" | null;
		mode: "critic" | "agent" | null;
		/** 1-based review round of this verdict. */
		round: number | null;
		independent: boolean | null;
	} | null;
	/** Why this candidate stopped for a human. This is distinct from the task's
	 * `require_review` preference: a critic can independently flag concerns. */
	reviewCause: ReviewCause | null;
	/** @deprecated Compatibility alias for acceptance. */
	critic: { outcome: string; detail: string } | null;
	run: {
		runId: string;
		attempt: number;
		model: string;
		durationMs: number | null;
		usage: Record<string, number> | null;
	} | null;
	truncated: boolean;
	/** Set while this run's branch is already queued or mid-merge: the review
	 *  screen must not offer approve/reject again while this is non-null
	 *  (MFW-50). `paused` is true only for `queued`: an in-flight state is
	 *  already past the point where the red-main breaker matters. */
	mergeJob: {
		state: ActiveMergeState;
		paused: boolean;
		error: string | null;
	} | null;
}

export type ReviewCause =
	| "critic_flagged"
	| "critic_unavailable"
	| "human_required"
	/** The finish-time scope check found files outside the task's `owns`. */
	| "scope_outside"
	| "review_rounds_exhausted"
	| "reviewer_not_independent"
	| "reviewer_modified_checkout";

/** One reviewer verdict as the review and task pages show it. */
export interface ReviewVerdictView {
	id: string;
	subjectRunId: string;
	mode: "critic" | "agent" | "human";
	verdict: "merge" | "fix" | "reject";
	round: number;
	reviewerModel: string | null;
	reviewerHarness: string | null;
	independent: boolean | null;
	findings: {
		file: string;
		line?: number | null;
		severity: string;
		change: string;
	}[];
	createdAt: number;
}

type EvidenceClass = "reproduced" | "source-confirmed" | "claimed";
const EVIDENCE_CLASSES: readonly unknown[] = [
	"reproduced",
	"source-confirmed",
	"claimed",
];

/** Diffs beyond this are summarized rather than shipped whole. */
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 200;

export class ReviewService {
	constructor(
		private readonly deps: {
			handle: ProjectDbHandle;
			registry: RunRegistry;
			tasks: TaskService;
			projectRoot: string;
			/** Review `fix` rounds auto-repaired before a human decides. */
			maxReviewRounds?: number;
			mergeQueue?: {
				byRun(
					runId: string,
				): Promise<{ state: MergeJobState; error: string | null } | null>;
				paused(): Promise<boolean>;
			};
		},
	) {}

	/** The whole judgement payload for a task awaiting review. */
	async bundle(taskId: string, runId?: string): Promise<ReviewBundle> {
		const task = await this.deps.tasks.get(taskId);
		const acceptanceCriteria =
			task?.criteria.map((criterion) => criterion.text) ?? [];
		const runRows = await this.deps.registry.list({ taskId });
		// `runId` pins one attempt (the group compare view); else the newest run with a branch.
		const run =
			runRows
				.filter((r) => r.branch && (!runId || r.id === runId))
				.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0] ??
			null;

		const empty: ReviewBundle = {
			taskId,
			acceptanceCriteria,
			branch: null,
			baseSha: null,
			files: [],
			checks: [],
			acceptance: null,
			scope: null,
			review: null,
			reviewCause: null,
			critic: null,
			run: null,
			truncated: false,
			mergeJob: null,
		};
		if (!run?.branch || !run.baseSha) return empty;

		const files = await this.diffFiles(run.baseSha, run.branch);
		const checks = await this.checksFor(run.id);
		const { acceptance, review } = await this.acceptanceFor(run.id);
		const owns = task?.owns ?? [];
		const scope =
			owns.length > 0
				? {
						owns,
						outside: filesOutsideOwns(owns, files.affectedPaths),
					}
				: null;
		const reviewCause = await this.reviewCauseFor(taskId, acceptance);
		const mergeJob = await this.mergeJobFor(run.id);

		return {
			taskId,
			acceptanceCriteria,
			branch: run.branch,
			baseSha: run.baseSha,
			files: files.files,
			checks,
			acceptance,
			scope,
			review,
			reviewCause,
			critic: acceptance
				? { outcome: acceptance.outcome, detail: acceptance.detail }
				: null,
			run: {
				runId: run.id,
				attempt: run.attempt,
				model: run.model,
				durationMs: run.finishedAt
					? run.finishedAt.getTime() - run.startedAt.getTime()
					: null,
				usage: run.usage,
			},
			truncated: files.truncated,
			mergeJob,
		};
	}

	/** Read the actual transition that put the task in Review. Guessing from
	 * `require_review` would mislabel critic escalations such as MFW-70. */
	private async reviewCauseFor(
		taskId: string,
		acceptance: ReviewBundle["acceptance"],
	): Promise<ReviewBundle["reviewCause"]> {
		const rows = await this.deps.handle.db
			.select({ payload: events.payload })
			.from(events)
			.where(
				and(eq(events.taskId, taskId), eq(events.type, "task.status_changed")),
			)
			.orderBy(desc(events.seq));
		for (const row of rows) {
			const payload = row.payload as { to?: unknown; reason?: unknown };
			if (payload.to !== "review") continue;
			const reason = typeof payload.reason === "string" ? payload.reason : "";
			for (const cause of [
				"review_rounds_exhausted",
				"reviewer_not_independent",
				"reviewer_modified_checkout",
			] as const) {
				if (reason.includes(cause)) return cause;
			}
			if (reason.includes("critic gate")) {
				return acceptance?.outcome === "flagged"
					? "critic_flagged"
					: "critic_unavailable";
			}
			// Before "review gate": the scope note says "scope gate → review".
			if (reason.includes("scope gate")) return "scope_outside";
			if (reason.includes("review gate")) return "human_required";
			return null;
		}
		return null;
	}

	private async mergeJobFor(runId: string): Promise<ReviewBundle["mergeJob"]> {
		const job = await this.deps.mergeQueue?.byRun(runId);
		if (!job || !isActiveMergeState(job.state)) return null;
		return {
			state: job.state,
			paused:
				job.state === "queued"
					? ((await this.deps.mergeQueue?.paused()) ?? false)
					: false,
			error: job.error,
		};
	}

	/** Both sides of every changed file, read straight from git objects so the
	 *  worktree's current state can't skew what the human is judging. */
	private async diffFiles(
		baseSha: string,
		branch: string,
	): Promise<{
		files: ReviewFile[];
		affectedPaths: string[];
		truncated: boolean;
	}> {
		const root = this.deps.projectRoot;
		const listed = await git(
			["diff", "--name-status", "-z", "-M", `${baseSha}..${branch}`],
			root,
		);
		if (listed.exitCode !== 0)
			return { files: [], affectedPaths: [], truncated: false };

		const changes = parseDiffPaths(listed.stdout);
		const files: ReviewFile[] = [];
		let truncated = false;

		for (const { code, oldPath, newPath } of changes) {
			if (files.length >= MAX_FILES) {
				truncated = true;
				break;
			}
			const status: ReviewFile["status"] = code.startsWith("A")
				? "added"
				: code.startsWith("D")
					? "deleted"
					: code.startsWith("R")
						? "renamed"
						: "modified";

			const oldText =
				status === "added" ? "" : await this.show(`${baseSha}:${oldPath}`);
			const newText =
				status === "deleted" ? "" : await this.show(`${branch}:${newPath}`);
			const binary = oldText === BINARY_SENTINEL || newText === BINARY_SENTINEL;

			files.push({
				path: newPath,
				status,
				oldText: binary ? "" : oldText,
				newText: binary ? "" : newText,
				binary,
			});
		}
		return { files, affectedPaths: affectedPaths(changes), truncated };
	}

	private async show(ref: string): Promise<string> {
		const r = await git(["show", ref], this.deps.projectRoot);
		if (r.exitCode !== 0) return "";
		if (r.stdout.length > MAX_FILE_BYTES) return BINARY_SENTINEL;
		// A NUL byte is git's own heuristic for "not text".
		return r.stdout.includes("\0") ? BINARY_SENTINEL : r.stdout;
	}

	/** DoD results from the run's finalize journal: the evidence, not a claim. */
	private async checksFor(
		runId: string,
	): Promise<{ name: string; ok: boolean; detail?: string }[]> {
		const steps = await this.deps.registry.steps(runId);
		const verify = steps.find((s) => s.step === "verify");
		const result = verify?.result as
			| { checks?: { check?: string; ok?: boolean; detail?: string }[] }
			| undefined;
		return (result?.checks ?? []).map((c) => ({
			name: c.check ?? "check",
			ok: c.ok === true,
			detail: c.detail,
		}));
	}

	private async acceptanceFor(runId: string): Promise<{
		acceptance: ReviewBundle["acceptance"];
		review: ReviewBundle["review"];
	}> {
		const [row] = await this.deps.handle.db
			.select()
			.from(decisions)
			.where(
				and(eq(decisions.subjectRunId, runId), eq(decisions.role, "critic")),
			)
			.orderBy(desc(decisions.ts))
			.limit(1);
		if (!row) return { acceptance: null, review: null };
		const output = row.output as {
			criteria?: {
				criterion?: unknown;
				verdict?: unknown;
				evidenceClass?: unknown;
				evidence?: unknown;
			}[];
			implementerModel?: unknown;
			reviewerModel?: unknown;
			sameModel?: unknown;
			verdict?: unknown;
			mode?: unknown;
			round?: unknown;
			independent?: unknown;
		};
		const criteria = (output.criteria ?? [])
			.filter(
				(item) =>
					typeof item.criterion === "string" &&
					(item.verdict === "met" ||
						item.verdict === "unmet" ||
						item.verdict === "uncertain"),
			)
			.map((item) => ({
				criterion: item.criterion as string,
				verdict: item.verdict as "met" | "unmet" | "uncertain",
				evidenceClass: EVIDENCE_CLASSES.includes(item.evidenceClass)
					? (item.evidenceClass as EvidenceClass)
					: null,
				evidence: typeof item.evidence === "string" ? item.evidence : "",
			}));
		// Older critic decisions predate the model record.
		const review: ReviewBundle["review"] =
			typeof output.reviewerModel === "string"
				? {
						implementerModel:
							typeof output.implementerModel === "string"
								? output.implementerModel
								: null,
						reviewerModel: output.reviewerModel,
						sameModel: output.sameModel === true,
						verdict:
							output.verdict === "merge" ||
							output.verdict === "fix" ||
							output.verdict === "reject"
								? (output.verdict as "merge" | "fix" | "reject")
								: null,
						mode:
							output.mode === "critic" || output.mode === "agent"
								? (output.mode as "critic" | "agent")
								: null,
						round: typeof output.round === "number" ? output.round : null,
						independent:
							typeof output.independent === "boolean"
								? output.independent
								: null,
					}
				: null;
		return {
			acceptance: {
				outcome: row.action ?? row.status,
				detail: row.reason ?? "",
				criteria,
			},
			review,
		};
	}

	// ---------- verdict history ----------

	/** Every verdict on the task (oldest first) and the rounds consumed so far. */
	async verdicts(taskId: string): Promise<{
		round: number;
		maxRounds: number;
		verdicts: ReviewVerdictView[];
	}> {
		const task = await this.deps.tasks.get(taskId);
		const rows = await listReviewVerdicts(this.deps.handle.db, { taskId });
		return {
			round: task?.reviewRound ?? 0,
			maxRounds: this.deps.maxReviewRounds ?? 2,
			verdicts: rows.map(toVerdictView),
		};
	}

	/** The newest verdict per task, for board card chips. */
	async latestVerdicts(): Promise<
		Record<string, { verdict: ReviewVerdictView["verdict"]; round: number }>
	> {
		const rows = await listReviewVerdicts(this.deps.handle.db);
		const out: Record<
			string,
			{ verdict: ReviewVerdictView["verdict"]; round: number }
		> = {};
		for (const r of rows) {
			if (r.taskId) out[r.taskId] = { verdict: r.verdict, round: r.round };
		}
		return out;
	}

	// ---------- structured inline comments ----------

	async listComments(taskId: string) {
		return this.deps.handle.db
			.select()
			.from(reviewComments)
			.where(eq(reviewComments.taskId, taskId))
			.orderBy(reviewComments.createdAt);
	}

	async addComment(input: {
		taskId: string;
		file: string;
		line: number;
		side: "old" | "new";
		body: string;
	}) {
		const [row] = await this.deps.handle.db
			.insert(reviewComments)
			.values({ ...input, createdAt: new Date() })
			.returning();
		return row;
	}

	async resolveComment(id: number, resolved: boolean) {
		await this.deps.handle.db
			.update(reviewComments)
			.set({ resolved })
			.where(eq(reviewComments.id, id));
	}

	async deleteComment(id: number) {
		await this.deps.handle.db
			.delete(reviewComments)
			.where(eq(reviewComments.id, id));
	}

	/**
	 * Human rejection: snapshot the brief (reason plus unresolved comments)
	 * into the task's run-state sidecar, then send the task back to `ready`.
	 * The next run's prompt carries the brief (`buildPrompts`).
	 */
	async reject(taskId: string, reason: string) {
		const task = await this.deps.tasks.get(taskId);
		if (!task) throw new Error(`unknown task ${taskId}`);
		if (task.status !== "review")
			throw new Error(
				`task ${taskId} is not awaiting review (status: ${task.status})`,
			);
		await this.deps.tasks.setPendingFeedback(
			taskId,
			await this.repairBrief(taskId, reason),
		);
		// The next attempt is a fresh chain with a fresh review budget.
		await this.deps.tasks.clearReviewRound(taskId);
		return this.deps.tasks.move(taskId, "ready", "human", reason);
	}

	/**
	 * The rejection feedback the next run receives: the human's reason plus
	 * every unresolved inline comment, addressed to its file and line.
	 * `reject` stores it; the API also exposes it as a preview.
	 */
	async repairBrief(taskId: string, reason: string): Promise<string> {
		const open = (await this.listComments(taskId)).filter((c) => !c.resolved);
		const lines = [
			"## A human rejected the previous attempt",
			"",
			reason.trim(),
		];
		if (open.length > 0) {
			lines.push("", "### Unresolved review comments");
			for (const c of open) {
				lines.push(`- \`${c.file}:${c.line}\`: ${c.body}`);
			}
		}
		lines.push(
			"",
			"Address every point above. Merge and task verification checks run again afterwards, followed by acceptance review.",
		);
		return lines.join("\n");
	}
}

const BINARY_SENTINEL = " __mfw_binary__";

function toVerdictView(r: ReviewVerdictRow): ReviewVerdictView {
	return {
		id: r.id,
		subjectRunId: r.subjectRunId,
		mode: r.mode,
		verdict: r.verdict,
		round: r.round,
		reviewerModel: r.reviewerModel ?? null,
		reviewerHarness: r.reviewerHarness ?? null,
		independent: r.independent ?? null,
		findings: (Array.isArray(r.findings) ? r.findings : []).filter(
			(f): f is ReviewVerdictView["findings"][number] =>
				typeof f === "object" &&
				f !== null &&
				typeof (f as { change?: unknown }).change === "string",
		),
		createdAt: r.createdAt.getTime(),
	};
}

/** Which runs are still awaiting a human decision (for the review queue). */
export async function reviewQueue(
	handle: ProjectDbHandle,
): Promise<{ runId: string; taskId: string | null; label: string }[]> {
	const rows = await handle.db
		.select()
		.from(runs)
		.where(eq(runs.state, "needs_review"))
		.orderBy(desc(runs.startedAt));
	return rows.map((r) => ({
		runId: r.id,
		taskId: r.taskId,
		label: r.label,
	}));
}
