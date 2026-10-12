import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import { findCycle } from "@mfw/core/dag";
import {
	findOwnershipConflicts,
	overlappingPatterns,
	validateOwnsPattern,
} from "@mfw/core/ownership";
import type { ProjectDbHandle } from "@mfw/db/client";
import { appendEvent, type EventBus, type StoredEvent } from "@mfw/db/eventlog";
import { ulid } from "@mfw/db/ids";
import {
	type BrainActionStatus,
	brainActions,
	brainSessions,
	brainTurns,
	clarifications,
	type DecisionKind,
	decisions,
	events,
	groupIdOf,
} from "@mfw/db/schema";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { finishHumanOverride, recordHumanOverride } from "../human-override.ts";
import { TaskUnmergedError } from "../lifecycle.ts";
import type { Logger } from "../log.ts";
import { isIndependent } from "../review-verdict.ts";
import type { GroupRunSpec } from "../run-engine.ts";
import type { RunRegistry } from "../run-registry.ts";
import type { TaskService, TaskWithRefs } from "../task-service.ts";
import { orderBatch } from "../tasks/batch.ts";
import {
	TaskResourceRequirementSchema,
	VerificationPlanSchema,
} from "../tasks/types.ts";
import {
	NewTask,
	type NewTaskSpec,
	OwnsList,
	Priority,
	Size,
} from "./board-effects.ts";
import type { BrainActionExecutor } from "./executor.ts";
import type { BrainReadService, BrainWorld } from "./reads.ts";

/**
 * The action service behind the brain's act tools (design §2.3 to §2.5).
 *
 * Every call is validated by the invariant checks below (`check()` runs the
 * same code without recording), recorded as one `brain_actions` row plus one
 * `decisions` row, and then executed by `BrainActionExecutor`: the row is the
 * outbox, written with its pre-minted ids before any effect. A rejection is
 * information: it carries a `fix` the model can act on.
 *
 * Spawns return `accepted` with their run ids; the scheduler launches them
 * under admission. The other tools are applied before the call returns.
 * `set_plan` and `note` are the brain's own memory and apply inline.
 *
 * The validators read the board, the registry and the claim state; they write
 * nothing. The only writes in this file are the audit rows.
 */

export const ACT_TOOLS = [
	"create_tasks",
	"update_task",
	"reparent",
	"split_task",
	"merge_tasks",
	"set_status",
	"answer_question",
	"spawn",
	"spawn_attempts",
	"select_winner",
	"request_review",
	"steer",
	"stop",
	"pause",
	"resume",
	"notify_human",
	"set_budget",
	"set_plan",
	"note",
	"sleep",
] as const;
export type ActTool = (typeof ACT_TOOLS)[number];

/** Tools whose effect is the brain's own memory: applied inline, no executor. */
const APPLIED_INLINE: ReadonlySet<string> = new Set(["set_plan", "note"]);
/** Tools that carry no `rationale` requirement: their text is the rationale. */
const NO_RATIONALE: ReadonlySet<string> = new Set(["set_plan", "note"]);

export interface ActionCaps {
	/** Act calls per turn. */
	actionsPerTurn: number;
	spawnsPerTurn: number;
	tasksPerTurn: number;
	/** Live runs per task. */
	liveRunsPerTask: number;
	attemptsPerGroup: number;
	/**
	 * The loop guard (I10): this many consecutive failed attempt groups on one
	 * task refuse further spawns on it until the brain escalates or archives.
	 */
	consecutiveFailedGroups: number;
	/** Task runs per task over its lifetime before escalation (I9). */
	runsPerTask: number;
	fyiPerDay: number;
	/** The same action rejected this many times in a turn ends the turn. */
	rejectionsToEndTurn: number;
}
export const DEFAULT_ACTION_CAPS: ActionCaps = {
	actionsPerTurn: 40,
	spawnsPerTurn: 8,
	tasksPerTurn: 20,
	liveRunsPerTask: 4,
	attemptsPerGroup: 3,
	consecutiveFailedGroups: 4,
	runsPerTask: 12,
	fyiPerDay: 5,
	rejectionsToEndTurn: 3,
};

export interface Rejection {
	code: string;
	message: string;
	fix?: { kind: "setting" | "command" | "ui"; text: string };
}

export interface ActResult {
	actionId: string;
	status: BrainActionStatus;
	result?: Record<string, unknown>;
	rejection?: Rejection;
	decisionId: number | null;
	/** The same call (same idempotency key) had already been made in this turn. */
	duplicate?: boolean;
	/** The loop guard tripped: the model should end its turn. */
	endTurn?: boolean;
}

export class BrainActionError extends Error {
	constructor(
		readonly code: "no_live_turn" | "unknown_tool",
		message: string,
	) {
		super(message);
		this.name = "BrainActionError";
	}
}

export interface BrainActionDeps {
	handle: ProjectDbHandle;
	bus: EventBus;
	tasks: TaskService;
	registry: RunRegistry;
	reads: BrainReadService;
	world: BrainWorld;
	executor: BrainActionExecutor;
	log: Logger;
	caps?: Partial<ActionCaps>;
	now?: () => number;
}

// ---------------------------------------------------------------------------
// Argument schemas (strict: a typo is a rejection, not a silently ignored key)
// ---------------------------------------------------------------------------

const Memo = {
	rationale: z.string().max(1000).optional(),
	alternatives: z
		.array(z.object({ option: z.string(), why_not: z.string() }))
		.max(10)
		.optional(),
	confidence: z.enum(["low", "medium", "high"]).optional(),
	key: z.string().max(100).optional(),
};
const ARGS: Record<ActTool, z.ZodType<Record<string, unknown>>> = {
	create_tasks: z
		.object({ ...Memo, tasks: z.array(NewTask).min(1).max(20) })
		.strict(),
	update_task: z
		.object({
			...Memo,
			id: z.string().min(1),
			baseRev: z.number().int(),
			override_human_pin: z.boolean().optional(),
			patch: z
				.object({
					title: z.string().min(1).max(200).optional(),
					body: z.string().max(20_000).optional(),
					spec: z.string().max(40_000).optional(),
					depends_on: z.array(z.string()).max(50).optional(),
					owns: OwnsList.optional(),
					verification: z.record(z.string(), z.unknown()).optional(),
					acceptance: z.array(z.record(z.string(), z.unknown())).optional(),
					priority: Priority.optional(),
					size: Size.optional(),
					labels: z.array(z.string()).optional(),
					provider: z.string().nullable().optional(),
					model: z.string().nullable().optional(),
				})
				.strict(),
		})
		.strict(),
	reparent: z
		.object({ ...Memo, id: z.string().min(1), parent: z.string().nullable() })
		.strict(),
	split_task: z
		.object({
			...Memo,
			id: z.string().min(1),
			into: z.array(NewTask).min(2).max(20),
			keep_original: z.enum(["archive", "epic"]),
			stop_live: z.boolean().optional(),
		})
		.strict(),
	merge_tasks: z
		.object({
			...Memo,
			ids: z.array(z.string().min(1)).min(2).max(20),
			into: z
				.object({
					title: z.string().min(1).max(200),
					body: z.string().max(20_000).optional(),
					owns: OwnsList.optional(),
					verification: z.record(z.string(), z.unknown()).optional(),
					acceptance: z.array(z.record(z.string(), z.unknown())).optional(),
				})
				.strict(),
		})
		.strict(),
	set_status: z
		.object({
			...Memo,
			id: z.string().min(1),
			to: z.enum(["backlog", "ready", "blocked", "archived", "draft"]),
			reason: z.string().min(1).max(500),
		})
		.strict(),
	answer_question: z
		.object({ ...Memo, runId: z.string().min(1), answer: z.string().min(1) })
		.strict(),
	spawn: z
		.object({
			...Memo,
			taskId: z.string().min(1),
			role: z.enum([
				"implement",
				"attempt",
				"review",
				"verify",
				"spike",
				"research",
				"plan",
				"import",
				"conflict",
			]),
			groupId: z.string().optional(),
			harness: z.string().optional(),
			model: z.string().optional(),
			effort: z.string().optional(),
			target: z.string().optional(),
			worktree: z
				.string()
				.regex(/^(new|continue:.+|fork:.+)$/)
				.default("new"),
			brief: z.string().max(8000).optional(),
			maxUsd: z.number().positive().optional(),
		})
		.strict(),
	spawn_attempts: z
		.object({
			...Memo,
			taskId: z.string().min(1),
			variants: z
				.array(
					z
						.object({
							harness: z.string().optional(),
							model: z.string().optional(),
							effort: z.string().optional(),
							target: z.string().optional(),
							brief: z.string().max(8000).optional(),
						})
						.strict(),
				)
				.min(2)
				.max(8),
			selection: z.enum(["brain", "first_verified"]),
		})
		.strict(),
	select_winner: z
		.object({
			...Memo,
			groupId: z.string().optional(),
			runId: z.string().min(1),
		})
		.strict(),
	request_review: z
		.object({
			...Memo,
			runId: z.string().min(1),
			reviewer: z
				.object({ harness: z.string(), model: z.string() })
				.strict()
				.optional(),
			mode: z.enum(["critic", "agent"]),
		})
		.strict(),
	steer: z
		.object({ ...Memo, runId: z.string().min(1), message: z.string().min(1) })
		.strict(),
	stop: z
		.object({
			...Memo,
			runId: z.string().min(1),
			reason: z.string().min(1),
			keep_worktree: z.boolean().optional(),
		})
		.strict(),
	pause: z
		.object({
			...Memo,
			taskIds: z.array(z.string()).max(100).optional(),
			subtree: z.string().optional(),
		})
		.strict(),
	resume: z
		.object({
			...Memo,
			taskIds: z.array(z.string()).max(100).optional(),
			subtree: z.string().optional(),
		})
		.strict(),
	notify_human: z
		.object({
			...Memo,
			kind: z.enum([
				"credential",
				"product_decision",
				"destructive",
				"outward",
				"brain_stuck",
				"fyi",
			]),
			title: z.string().min(1).max(200),
			body: z.string().max(8000),
			blocking: z.array(z.string()).max(50).optional(),
			options: z.array(z.string()).max(10).optional(),
		})
		.strict(),
	set_budget: z
		.object({
			...Memo,
			budget: z.string().min(1),
			limitUsd: z.number().nonnegative().optional(),
			limitTokens: z.number().int().nonnegative().optional(),
			window: z.string().optional(),
		})
		.strict(),
	set_plan: z
		.object({ ...Memo, markdown: z.string().min(1).max(24_000) })
		.strict(),
	note: z
		.object({
			...Memo,
			taskId: z.string().optional(),
			text: z.string().min(1).max(4000),
		})
		.strict(),
	sleep: z
		.object({
			...Memo,
			wakeAfterMin: z.number().int().min(5).max(1440).optional(),
			wakeOn: z.array(z.string()).max(20).optional(),
		})
		.strict(),
};

const reject = (
	code: string,
	message: string,
	fix?: Rejection["fix"],
): { ok: false; rejection: Rejection } => ({
	ok: false,
	rejection: { code, message, ...(fix ? { fix } : {}) },
});
type Verdict =
	| { ok: true; preview: Record<string, unknown> }
	| { ok: false; rejection: Rejection };
const accept = (preview: Record<string, unknown> = {}): Verdict => ({
	ok: true,
	preview,
});

const EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"];

const SECRET_WORDS =
	/\b(password|passphrase|api[-_ ]?key|secret|token|credential|private key|ssh key)\b/i;

/** Canonical JSON: sorted keys, so the same call hashes the same. */
function canonical(v: unknown): string {
	if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
	if (v && typeof v === "object") {
		return `{${Object.entries(v as Record<string, unknown>)
			.filter(([, x]) => x !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : 1))
			.map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`)
			.join(",")}}`;
	}
	return JSON.stringify(v);
}

/** `sha256(turnRunId + tool + canonical_json(args minus rationale))`; an explicit `key` makes a deliberate repeat distinct. */
export function idempotencyKey(
	turnRunId: string,
	tool: string,
	args: Record<string, unknown>,
): string {
	const { rationale: _r, alternatives: _a, confidence: _c, ...rest } = args;
	return createHash("sha256")
		.update(turnRunId + tool + canonical(rest))
		.digest("hex");
}

/** What a call is about, for the loop guard and the audit row. */
function subjectOf(args: Record<string, unknown>): {
	taskId: string | null;
	runId: string | null;
} {
	const s = (k: string) =>
		typeof args[k] === "string" ? (args[k] as string) : null;
	return {
		taskId: s("taskId") ?? s("id"),
		runId: s("runId"),
	};
}

export class BrainActionService {
	private readonly caps: ActionCaps;
	private readonly now: () => number;

	constructor(private readonly deps: BrainActionDeps) {
		this.caps = { ...DEFAULT_ACTION_CAPS, ...deps.caps };
		this.now = deps.now ?? (() => Date.now());
	}

	/**
	 * One act-tool call. Validates, records (`brain_actions` + `decisions` +
	 * `brain.action`) in one transaction, and returns the result the model
	 * sees. Idempotent on `(turn, tool, args)`.
	 */
	async act(input: {
		turnRunId: string;
		tool: string;
		args: Record<string, unknown>;
	}): Promise<ActResult> {
		const { turnRunId, tool } = input;
		if (!(ACT_TOOLS as readonly string[]).includes(tool)) {
			throw new BrainActionError("unknown_tool", `unknown act tool '${tool}'`);
		}
		const db = this.deps.handle.db;
		const [turn] = await db
			.select()
			.from(brainTurns)
			.where(eq(brainTurns.runId, turnRunId));
		if (turn?.status !== "running") {
			throw new BrainActionError(
				"no_live_turn",
				`turn ${turnRunId} is not a live brain turn: act tools work only during a wake`,
			);
		}
		const [session] = await db
			.select()
			.from(brainSessions)
			.where(eq(brainSessions.id, turn.sessionId));
		if (!session) {
			throw new BrainActionError("no_live_turn", "the brain session is gone");
		}

		const rawArgs = input.args ?? {};
		const idemKey = idempotencyKey(turnRunId, tool, rawArgs);
		const existing = await this.byIdem(idemKey);
		if (existing) return { ...existing, duplicate: true };

		// 1. shape, rationale, caps, loop guard, then the invariants
		const evaluated = await this.evaluate(tool as ActTool, rawArgs, turnRunId);
		const args = evaluated.args;
		const verdict = evaluated.verdict;

		// 2. record. The effect ids are minted here and written with the row,
		// before anything takes effect (the outbox rule).
		const inline = APPLIED_INLINE.has(tool);
		const status: BrainActionStatus = !verdict.ok
			? "rejected"
			: inline
				? "applied"
				: "accepted";
		const effects =
			verdict.ok && !inline
				? await this.effectsFor(tool as ActTool, args)
				: null;
		const actionId = ulid();
		const subject = subjectOf(args);
		const kind: DecisionKind =
			tool === "set_plan" ? "plan" : tool === "note" ? "note" : "action";
		const nowMs = this.now();
		const output: Record<string, unknown> = {
			status,
			...(verdict.ok
				? { result: { ...verdict.preview, ...(effects ?? {}) } }
				: { rejection: verdict.rejection }),
		};
		const alternatives = (args.alternatives ?? null) as
			| { option: string; why_not: string }[]
			| null;
		const confidence = (args.confidence ?? null) as
			| "low"
			| "medium"
			| "high"
			| null;
		const text =
			tool === "set_plan"
				? String(args.markdown ?? "")
				: tool === "note"
					? String(args.text ?? "")
					: String(args.rationale ?? "");

		const events: StoredEvent[] = [];
		let decisionId = 0;
		try {
			await this.deps.handle.withTx(async (tx) => {
				const [d] = await tx
					.insert(decisions)
					.values({
						ts: new Date(nowMs),
						role: "brain",
						taskId: subject.taskId,
						subjectRunId: subject.runId,
						brainRunId: turnRunId,
						model: session.model,
						status: "ok",
						action: tool,
						// A plan is the brain's memory: kept whole.
						reason: tool === "set_plan" ? text : text.slice(0, 4000),
						input: args,
						output,
						durationMs: 0,
						finishedAt: new Date(nowMs),
						brainSessionId: session.id,
						turnRunId,
						kind,
						alternatives,
						confidence,
						contextRefs: this.deps.reads.refsFor(turnRunId),
						harness: session.harness,
					})
					.returning({ id: decisions.id });
				decisionId = d?.id ?? 0;
				await tx.insert(brainActions).values({
					id: actionId,
					idemKey,
					sessionId: session.id,
					turnRunId,
					tool,
					args,
					status,
					rejection: verdict.ok ? null : verdict.rejection,
					effects,
					decisionId,
					createdAt: new Date(nowMs),
					appliedAt: inline && verdict.ok ? new Date(nowMs) : null,
				});
				await tx
					.update(brainTurns)
					.set({ actionsCount: sql`${brainTurns.actionsCount} + 1` })
					.where(eq(brainTurns.runId, turnRunId));
				events.push(
					await appendEvent(
						tx,
						{
							type: "brain.action",
							runId: turnRunId,
							...(subject.taskId ? { taskId: subject.taskId } : {}),
							payload: {
								actionId,
								tool,
								status,
								decisionId,
								sessionId: session.id,
							},
						},
						nowMs,
					),
				);
			});
		} catch (e) {
			// A concurrent identical call won the unique idempotency key.
			const winner = await this.byIdem(idemKey);
			if (winner) return { ...winner, duplicate: true };
			throw e;
		}
		this.deps.bus.publish(events);

		const rejected = !verdict.ok;
		const endTurn =
			rejected &&
			(await this.rejectionCount(turnRunId, tool, args)) >=
				this.caps.rejectionsToEndTurn;

		// 3. effect. Spawns wait for the scheduler's admission; the rest run now.
		let finalStatus: BrainActionStatus = status;
		let rejection: Rejection | undefined = verdict.ok
			? undefined
			: verdict.rejection;
		let result: Record<string, unknown> | undefined = verdict.ok
			? { ...verdict.preview, ...(effects ?? {}) }
			: undefined;
		if (verdict.ok && status === "accepted") {
			if (tool === "spawn" || tool === "spawn_attempts") {
				this.deps.executor.nudge();
			} else {
				const out = await this.deps.executor.execute(actionId);
				finalStatus = out.status === "applied" ? "applied" : "failed";
				if (out.status === "applied") {
					result = { ...result, ...(out.result ?? {}) };
				} else {
					rejection = out.rejection ?? {
						code: "effect_failed",
						message: out.error ?? "the effect failed",
					};
					result = undefined;
				}
			}
		}
		return {
			actionId,
			status: finalStatus,
			decisionId,
			...(rejection ? { rejection } : result ? { result } : {}),
			...(endTurn ? { endTurn: true } : {}),
		};
	}

	/**
	 * Would this call be accepted? The same answer `act` records, without
	 * recording it and without the per-turn caps. `act` runs the same
	 * validators, so a check and the live call cannot disagree.
	 */
	async check(
		tool: string,
		args: Record<string, unknown>,
	): Promise<
		| { ok: true; preview: Record<string, unknown> }
		| { ok: false; rejection: Rejection }
	> {
		if (!(ACT_TOOLS as readonly string[]).includes(tool)) {
			throw new BrainActionError("unknown_tool", `unknown act tool '${tool}'`);
		}
		return (await this.evaluate(tool as ActTool, args, null)).verdict;
	}

	/**
	 * A person picks the winner of an attempt group: a human override of the
	 * brain. The same validator (`vSelectWinner`, invariants I1/I2) and the same
	 * effect (`applySelectWinner`) as the brain's `select_winner`, so a person
	 * cannot merge what the brain could not. The server is the authority: a
	 * refusal carries its `fix` text. One `role: human` decision records it.
	 */
	async selectWinnerAsHuman(input: {
		runId: string;
		groupId?: string;
		reason?: string;
	}): Promise<
		| {
				ok: true;
				decisionId: number;
				groupId: string;
				result: Record<string, unknown>;
		  }
		| { ok: false; rejection: Rejection }
	> {
		const reason = input.reason?.trim() || "winner chosen by a person";
		const args: Record<string, unknown> = {
			runId: input.runId,
			...(input.groupId ? { groupId: input.groupId } : {}),
			rationale: reason,
		};
		const verdict = await this.vSelectWinner(args);
		if (!verdict.ok) return { ok: false, rejection: verdict.rejection };
		const fx = (await this.effectsFor("select_winner", args)) as {
			groupId: string;
			runId: string;
			losers: string[];
		};
		const run = await this.deps.registry.get(input.runId);
		const decisionId = await recordHumanOverride(this.deps, {
			action: "select_winner",
			taskId: run?.taskId ?? null,
			subjectRunId: input.runId,
			reason,
			input: { ...args, groupId: fx.groupId },
			accepted: fx,
			now: this.now(),
		});
		let result: Record<string, unknown>;
		try {
			result = await this.deps.executor.applySelectWinner(fx, "human");
		} catch (e) {
			await finishHumanOverride(this.deps.handle, decisionId, {
				ok: false,
				error: e instanceof Error ? e.message : String(e),
			});
			throw e;
		}
		await finishHumanOverride(this.deps.handle, decisionId, {
			ok: true,
			result: { ...fx, ...result },
		});
		return { ok: true, decisionId, groupId: fx.groupId, result };
	}

	/**
	 * A person adds one more attempt to an open competing group (`Add
	 * attempt…`). The same `spawn` validator the brain faces (claim, caps,
	 * capacity, paused dispatch) and the same launch path; the pick ranks above
	 * a task pin because a person made it.
	 */
	async addAttemptAsHuman(input: {
		groupId: string;
		harness?: string;
		model?: string;
		effort?: string;
		target?: string;
		brief?: string;
		reason?: string;
	}): Promise<
		| { ok: true; runId: string; groupId: string; decisionId: number }
		| { ok: false; rejection: Rejection }
	> {
		const group = await this.deps.registry.getGroup(input.groupId);
		if (!group) {
			return {
				ok: false,
				rejection: {
					code: "group_not_found",
					message: `no attempt group '${input.groupId}'`,
				},
			};
		}
		const reason = input.reason?.trim() || "attempt added by a person";
		const args: Record<string, unknown> = {
			taskId: group.taskId,
			role: "attempt",
			groupId: group.id,
			worktree: "new",
			rationale: reason,
			...(input.harness ? { harness: input.harness } : {}),
			...(input.model ? { model: input.model } : {}),
			...(input.effort ? { effort: input.effort } : {}),
			...(input.target ? { target: input.target } : {}),
			...(input.brief ? { brief: input.brief } : {}),
		};
		const verdict = await this.validate("spawn", args);
		if (!verdict.ok) return { ok: false, rejection: verdict.rejection };
		const runId = ulid();
		const decisionId = await recordHumanOverride(this.deps, {
			action: "add_attempt",
			taskId: group.taskId,
			subjectRunId: null,
			reason,
			input: args,
			accepted: { runId, groupId: group.id },
			now: this.now(),
		});
		try {
			await this.deps.executor.startHumanRun({
				runId,
				taskId: group.taskId,
				groupId: group.id,
				groupKind: "competing",
				selection: group.selection,
				role: "attempt",
				decisionId,
				originRef: "human:ui",
				...(input.brief ? { brief: input.brief } : {}),
				pick: {
					...(input.harness ? { provider: input.harness } : {}),
					...(input.model ? { model: input.model } : {}),
					...(input.effort
						? {
								effort: input.effort as NonNullable<
									NonNullable<GroupRunSpec["pick"]>["effort"]
								>,
							}
						: {}),
					overrideHumanPin: true,
				},
				...(input.target ? { target: input.target } : {}),
				worktree: { mode: "new" },
			});
		} catch (e) {
			await finishHumanOverride(this.deps.handle, decisionId, {
				ok: false,
				error: e instanceof Error ? e.message : String(e),
			});
			throw e;
		}
		await finishHumanOverride(this.deps.handle, decisionId, {
			ok: true,
			result: { runId, groupId: group.id },
		});
		return { ok: true, runId, groupId: group.id, decisionId };
	}

	/**
	 * A person pauses or resumes tasks: the brain's hold store, so neither the
	 * scheduler nor the brain starts runs for a paused task. One human decision.
	 */
	async holdAsHuman(input: {
		taskIds: readonly string[];
		subtree?: string;
		paused: boolean;
		reason?: string;
	}): Promise<{ decisionId: number; taskIds: string[] }> {
		const reason =
			input.reason?.trim() ||
			(input.paused ? "paused by a person" : "resumed by a person");
		const first = input.taskIds[0] ?? input.subtree ?? null;
		const decisionId = await recordHumanOverride(this.deps, {
			action: input.paused ? "pause" : "resume",
			taskId: first,
			subjectRunId: null,
			reason,
			input: {
				taskIds: [...input.taskIds],
				...(input.subtree ? { subtree: input.subtree } : {}),
			},
			now: this.now(),
		});
		const taskIds = await this.deps.executor.setHumanHolds({
			taskIds: input.taskIds,
			...(input.subtree ? { subtree: input.subtree } : {}),
			paused: input.paused,
			reason,
			decisionId,
		});
		await finishHumanOverride(this.deps.handle, decisionId, {
			ok: true,
			result: { taskIds },
		});
		return { decisionId, taskIds };
	}

	/** Shape, rationale, (turn caps and loop guard when in a turn), invariants. */
	private async evaluate(
		tool: ActTool,
		rawArgs: Record<string, unknown>,
		turnRunId: string | null,
	): Promise<{ verdict: Verdict; args: Record<string, unknown> }> {
		const parsed = ARGS[tool].safeParse(rawArgs);
		if (!parsed.success) {
			return {
				args: rawArgs,
				verdict: reject(
					"invalid_args",
					parsed.error.issues
						.map((i) => `${i.path.join(".") || "(args)"}: ${i.message}`)
						.join("; "),
				),
			};
		}
		const args = parsed.data;
		const rationale =
			typeof args.rationale === "string" ? args.rationale.trim() : "";
		if (!NO_RATIONALE.has(tool) && rationale.length === 0) {
			return {
				args,
				verdict: reject(
					"rationale_required",
					`${tool} needs a rationale (at most 1,000 characters): say why this, now`,
				),
			};
		}
		const guarded = turnRunId ? await this.guard(turnRunId, tool, args) : null;
		return {
			args,
			verdict: guarded ?? (await this.validate(tool, args)),
		};
	}

	/**
	 * The ids a tool's effect will use, minted now so they are on the outbox row
	 * before the effect runs: a replay after a crash adopts them instead of
	 * minting again.
	 */
	private async effectsFor(
		tool: ActTool,
		a: Record<string, unknown>,
	): Promise<Record<string, unknown> | null> {
		switch (tool) {
			case "spawn": {
				const role =
					a.role === "attempt"
						? "attempt"
						: a.role === "plan"
							? "plan"
							: a.role === "import"
								? "import"
								: "implement";
				const runId = ulid();
				if (role === "plan" || role === "import") {
					return {
						runIds: [runId],
						groupId: runId,
						groupKind: "single",
						selection: "brain",
						role,
					};
				}
				if (role === "implement") {
					return {
						runIds: [runId],
						groupId: runId,
						groupKind: "single",
						selection: "brain",
						role,
					};
				}
				const joining = typeof a.groupId === "string" ? a.groupId : null;
				const group = joining
					? await this.deps.registry.getGroup(joining)
					: null;
				return {
					runIds: [runId],
					groupId: joining ?? ulid(),
					groupKind: "competing",
					selection: group?.selection ?? "brain",
					role,
				};
			}
			case "spawn_attempts": {
				const n = (a.variants as unknown[]).length;
				return {
					runIds: Array.from({ length: n }, () => ulid()),
					groupId: ulid(),
					groupKind: "competing",
					selection: a.selection,
					role: "attempt",
				};
			}
			case "select_winner": {
				const run = await this.deps.registry.get(String(a.runId));
				const groupId = run ? groupIdOf(run) : String(a.groupId ?? "");
				const members = await this.deps.registry.groupRuns(groupId);
				return {
					groupId,
					runId: String(a.runId),
					losers: members.filter((m) => m.id !== a.runId).map((m) => m.id),
				};
			}
			// What a human override needs to put things back: the state the call
			// is about to replace, read before the effect (a replay after a crash
			// reads the same record, since it lives on the outbox row).
			case "set_status": {
				const t = await this.deps.tasks.get(String(a.id));
				return t ? { previous: { status: t.status } } : null;
			}
			case "reparent": {
				const t = await this.deps.tasks.get(String(a.id));
				return t ? { previous: { parent: t.parentId } } : null;
			}
			case "split_task": {
				const t = await this.deps.tasks.get(String(a.id));
				return t ? { previous: { status: t.status } } : null;
			}
			case "merge_tasks": {
				const statuses: Record<string, string> = {};
				for (const id of a.ids as string[]) {
					const t = await this.deps.tasks.get(id);
					if (t) statuses[id] = t.status;
				}
				return { previous: { statuses } };
			}
			default:
				return null;
		}
	}

	private async byIdem(idemKey: string): Promise<ActResult | null> {
		const [row] = await this.deps.handle.db
			.select()
			.from(brainActions)
			.where(eq(brainActions.idemKey, idemKey));
		if (!row) return null;
		const [d] = row.decisionId
			? await this.deps.handle.db
					.select()
					.from(decisions)
					.where(eq(decisions.id, row.decisionId))
			: [];
		const result = (
			d?.output as { result?: Record<string, unknown> } | undefined
		)?.result;
		return {
			actionId: row.id,
			status: row.status,
			decisionId: row.decisionId,
			...(row.rejection
				? { rejection: row.rejection as Rejection }
				: result
					? { result }
					: {}),
		};
	}

	private async rejectionCount(
		turnRunId: string,
		tool: string,
		args: Record<string, unknown>,
	): Promise<number> {
		const s = subjectOf(args);
		const rows = await this.deps.handle.db
			.select()
			.from(brainActions)
			.where(
				and(
					eq(brainActions.turnRunId, turnRunId),
					eq(brainActions.tool, tool),
					eq(brainActions.status, "rejected"),
				),
			);
		return rows.filter((r) => {
			const o = subjectOf(r.args);
			return o.taskId === s.taskId && o.runId === s.runId;
		}).length;
	}

	/** Caps and the loop guard (I9, I10). Null = pass. */
	private async guard(
		turnRunId: string,
		tool: string,
		args: Record<string, unknown>,
	): Promise<Verdict | null> {
		const rows = await this.deps.handle.db
			.select()
			.from(brainActions)
			.where(eq(brainActions.turnRunId, turnRunId));
		const made = rows.filter((r) => r.status !== "rejected");
		if (rows.length >= this.caps.actionsPerTurn) {
			return reject(
				"turn_cap",
				`${this.caps.actionsPerTurn} act calls this turn is the cap`,
				{ kind: "ui", text: "End your turn; remaining work wakes you again." },
			);
		}
		if (tool === "spawn" || tool === "spawn_attempts") {
			const spawns = made
				.filter((r) => r.tool === "spawn" || r.tool === "spawn_attempts")
				.reduce(
					(n, r) =>
						n +
						(r.tool === "spawn_attempts"
							? ((r.args.variants as unknown[] | undefined)?.length ?? 1)
							: 1),
					0,
				);
			const adding =
				tool === "spawn_attempts"
					? ((args.variants as unknown[] | undefined)?.length ?? 1)
					: 1;
			if (spawns + adding > this.caps.spawnsPerTurn) {
				return reject(
					"spawn_cap",
					`at most ${this.caps.spawnsPerTurn} spawns per turn (${spawns} already made)`,
					{ kind: "ui", text: "Spawn the rest on your next wake." },
				);
			}
		}
		if (tool === "create_tasks" || tool === "split_task") {
			const created = made.reduce(
				(n, r) =>
					n +
					((r.args.tasks as unknown[] | undefined)?.length ??
						(r.args.into as unknown[] | undefined)?.length ??
						0),
				0,
			);
			const adding =
				(args.tasks as unknown[] | undefined)?.length ??
				(args.into as unknown[] | undefined)?.length ??
				0;
			if (created + adding > this.caps.tasksPerTurn) {
				return reject(
					"task_cap",
					`at most ${this.caps.tasksPerTurn} task creations per turn (${created} already made)`,
					{ kind: "ui", text: "Create the rest on your next wake." },
				);
			}
		}
		const rejections = await this.rejectionCount(turnRunId, tool, args);
		if (rejections >= this.caps.rejectionsToEndTurn) {
			return reject(
				"loop_guard",
				`${tool} on the same subject was rejected ${rejections} times this turn`,
				{
					kind: "ui",
					text: "Stop retrying this: pick another approach, or notify_human(kind: brain_stuck) and end your turn.",
				},
			);
		}
		return null;
	}

	// -----------------------------------------------------------------------
	// Validators. Each answers what the live executor would answer.
	// -----------------------------------------------------------------------

	private async validate(
		tool: ActTool,
		a: Record<string, unknown>,
	): Promise<Verdict> {
		switch (tool) {
			case "create_tasks":
				return this.vCreate(a.tasks as z.infer<typeof NewTask>[]);
			case "update_task":
				return this.vUpdate(a);
			case "reparent":
				return this.vReparent(a);
			case "split_task":
				return this.vSplit(a);
			case "merge_tasks":
				return this.vMerge(a);
			case "set_status":
				return this.vSetStatus(a);
			case "answer_question":
				return this.vAnswer(a);
			case "spawn":
				return this.vSpawn(a);
			case "spawn_attempts":
				return this.vSpawnAttempts(a);
			case "select_winner":
				return this.vSelectWinner(a);
			case "request_review":
				return this.vRequestReview(a);
			case "steer":
				return this.vSteer(a);
			case "stop":
				return this.vStop(a);
			case "pause":
			case "resume":
				return this.vPause(tool, a);
			case "notify_human":
				return this.vNotify(a);
			case "set_budget":
				return this.vSetBudget(a);
			case "set_plan":
				return accept({ chars: String(a.markdown).length });
			case "note":
				return this.vNote(a);
			case "sleep":
				return accept({
					wakeAfterMin: a.wakeAfterMin ?? null,
					wakeOn: a.wakeOn ?? [],
				});
		}
	}

	private async task(id: string): Promise<TaskWithRefs | null> {
		return this.deps.tasks.get(id);
	}

	private missingTask(id: string): Verdict {
		return reject("task_not_found", `no task '${id}'`, {
			kind: "ui",
			text: "Read the board for current ids; never invent one.",
		});
	}

	private ownsProblem(owns: readonly string[] | undefined): Verdict | null {
		for (const p of owns ?? []) {
			const why = validateOwnsPattern(p);
			if (why) {
				return reject("invalid_owns", `owns pattern '${p}': ${why}`, {
					kind: "ui",
					text: "Use repo-relative paths or globs without '..' or a leading '/'.",
				});
			}
		}
		return null;
	}

	/** Tasks whose claim is live and whose `owns` overlaps `owns` (I3). */
	private async claimOverlaps(owns: readonly string[], exceptId?: string) {
		if (owns.length === 0) return [];
		const held = (await this.deps.tasks.list("in_progress")).filter(
			(t) => t.id !== exceptId && t.owns.length > 0,
		);
		const out: { id: string; patterns: [string, string][] }[] = [];
		for (const t of held) {
			const patterns = overlappingPatterns(owns, t.owns);
			if (patterns.length > 0) out.push({ id: t.id, patterns });
		}
		return out;
	}

	private get store() {
		return this.deps.tasks.store;
	}

	/**
	 * Everything a batch of new tasks must satisfy before anything is written:
	 * shape of each spec, references that resolve (to the board or to another
	 * task of the batch), no cycle through the batch, the board's statuses and
	 * hierarchy rules, and file scopes that are ordered against live work.
	 * `excluding` names tasks that stop being open as part of the same action
	 * (the original of a split, the originals of a merge).
	 */
	private async checkNewTasks(
		specs: NewTaskSpec[],
		o: {
			label?: string;
			excluding?: ReadonlySet<string>;
			parentFields?: Record<string, Record<string, unknown>>;
		} = {},
	): Promise<{ order: number[] } | { verdict: Verdict }> {
		const label = o.label ?? "tasks";
		const store = this.store;
		const fail = (v: Verdict) => ({ verdict: v });
		if (!store.declaresField("created_by")) {
			return fail(
				reject(
					"provenance_unavailable",
					"this board's board.yaml does not declare created_by, so tasks the brain writes could not be told from a person's",
					{
						kind: "command",
						text: "Re-attach the project (or add `created_by: { optional: true }` to the task type's fields in board.yaml).",
					},
				),
			);
		}
		const all = await this.deps.tasks.list();
		const byId = new Map(all.map((t) => [t.id, t]));
		const refs = new Set(
			specs.flatMap((t) => (t.ref !== undefined ? [t.ref] : [])),
		);
		const roles = store.statusRolesAvailable();
		for (const [i, t] of specs.entries()) {
			const at = `${label}[${i}]`;
			const bad = this.ownsProblem(t.owns);
			if (bad) return fail(bad);
			if (t.spec && store.flat) {
				return fail(
					reject(
						"spec_unsupported",
						`${at}.spec: this board keeps each task in one file, so there is no spec.md`,
						{ kind: "ui", text: "Put the text in body instead." },
					),
				);
			}
			if (t.status && !roles.includes(t.status)) {
				return fail(
					reject(
						"status_unavailable",
						`${at}.status '${t.status}' has no column on this board (it has: ${roles
							.map((r) => store.boardStatusFor(r))
							.join(", ")})`,
						{
							kind: "ui",
							text: "Use a status the board declares, or omit status.",
						},
					),
				);
			}
			if (t.verification) {
				const v = VerificationPlanSchema.safeParse(t.verification);
				if (!v.success) {
					return fail(
						reject(
							"invalid_verification",
							`${at}.verification: ${v.error.issues.map((x) => x.message).join("; ")}`,
							{
								kind: "ui",
								text: "Use {verifier, checks: [{run, expect_exit?}|{files_exist}|{diff_against_base}]}.",
							},
						),
					);
				}
			}
			if (t.requires_resources) {
				const r = z
					.array(TaskResourceRequirementSchema)
					.safeParse(t.requires_resources);
				if (!r.success) {
					return fail(
						reject(
							"invalid_resources",
							`${at}.requires_resources: ${r.error.issues.map((x) => x.message).join("; ")}`,
						),
					);
				}
			}
			for (const item of t.acceptance ?? []) {
				if (typeof item.text !== "string" || item.text.trim() === "") {
					return fail(
						reject(
							"invalid_acceptance",
							`${at}.acceptance: every item needs a text`,
						),
					);
				}
			}
			if (t.parent && !refs.has(t.parent) && !byId.has(t.parent)) {
				return fail(
					reject(
						"parent_not_found",
						`${at}.parent '${t.parent}' does not exist`,
						{
							kind: "ui",
							text: "Create the parent first, name it by the ref of a task in this call, or omit parent.",
						},
					),
				);
			}
			for (const dep of t.depends_on ?? []) {
				if (!refs.has(dep) && !byId.has(dep)) {
					return fail(
						reject(
							"dependency_not_found",
							`${at}.depends_on '${dep}' does not exist`,
							{
								kind: "ui",
								text: "Depend only on tasks that exist on the board, or on the ref of a task in this call.",
							},
						),
					);
				}
			}
		}

		const ordered = orderBatch(
			specs.map((t) => ({
				ref: t.ref,
				parent: t.parent ?? null,
				dependsOn: t.depends_on ?? [],
			})),
		);
		if (!ordered.ok) {
			return fail(
				reject(ordered.code, ordered.message, {
					kind: "ui",
					text: "Drop one of the edges on the cycle, or merge the tasks.",
				}),
			);
		}

		// The board's hierarchy rules, existing parents and batch parents alike.
		const refIndex = new Map(
			specs.flatMap((t, i) =>
				t.ref !== undefined ? [[t.ref, i] as const] : [],
			),
		);
		const fieldsOf = (t: NewTaskSpec) =>
			store.boardFieldsFor({
				type: t.type,
				priority: t.priority ?? "medium",
				status: t.status ?? "backlog",
			});
		const ancestors = (i: number, seen = new Set<number>()): number => {
			if (seen.has(i)) return 0;
			seen.add(i);
			const parent = specs[i]?.parent;
			if (!parent) return 0;
			const j = refIndex.get(parent);
			if (j !== undefined) return 1 + ancestors(j, seen);
			return store.depthOf(parent);
		};
		for (const [i, t] of specs.entries()) {
			if (!t.parent) continue;
			const j = refIndex.get(t.parent);
			const problem =
				j !== undefined
					? store.rulesProblem(fieldsOf(t), fieldsOf(specs[j] as NewTaskSpec))
					: store.hierarchyProblem({ fields: fieldsOf(t) }, t.parent, {
							...(o.parentFields?.[t.parent]
								? {
										parentFields: o.parentFields[t.parent] as Record<
											string,
											unknown
										>,
									}
								: {}),
						});
			if (problem) {
				return fail(
					reject(problem.code, `${label}[${i}]: ${problem.message}`, {
						kind: "ui",
						text: "Pick a parent the board's hierarchy rules allow, or none.",
					}),
				);
			}
			const max = store.maxDepth;
			if (max !== undefined && ancestors(i) > max) {
				return fail(
					reject(
						"max_depth",
						`${label}[${i}]: parent chain would be ${ancestors(i)} deep (maxDepth is ${max})`,
						{
							kind: "ui",
							text: "Flatten the batch or pick a shallower parent.",
						},
					),
				);
			}
		}

		// File scopes: a new task's owns may overlap live work only when a
		// depends_on edge orders them (`ownership` of the board's conflicts rule).
		const excluding = o.excluding ?? new Set<string>();
		const newId = (i: number) => `\u0000new:${i}`;
		const nodes = [
			...all
				.filter(
					(t) =>
						t.status !== "done" &&
						t.status !== "archived" &&
						!excluding.has(t.id),
				)
				.map((t) => ({ id: t.id, owns: t.owns, dependsOn: t.dependsOn })),
			...specs.map((t, i) => ({
				id: newId(i),
				owns: t.owns ?? [],
				dependsOn: (t.depends_on ?? []).map((d) => {
					const j = refIndex.get(d);
					return j !== undefined ? newId(j) : d;
				}),
			})),
		];
		for (const c of findOwnershipConflicts(nodes)) {
			const a = c.a.startsWith("\u0000new:");
			const b = c.b.startsWith("\u0000new:");
			if (!a && !b) continue;
			const name = (id: string) =>
				id.startsWith("\u0000new:") ? `${label}[${id.slice(5)}]` : id;
			const existing = a ? c.b : c.a;
			const mine = a ? c.a : c.b;
			const pair = c.patterns[0] as [string, string];
			return fail(
				reject(
					"owns_unordered",
					`${name(mine)} owns ${a ? pair[0] : pair[1]}, which overlaps ${name(existing)} (${a ? pair[1] : pair[0]}) with nothing ordering them`,
					{
						kind: "ui",
						text: `Add depends_on ${name(existing)} to ${name(mine)}, or narrow owns.`,
					},
				),
			);
		}
		return { order: ordered.order };
	}

	/**
	 * Would rewriting every dependent of `from` to depend on `to` close a
	 * cycle, given the new tasks' own dependencies? Returns the cycle path.
	 */
	private async cycleAfterRewire(
		from: readonly string[],
		to: readonly string[],
		extra: { id: string; dependsOn: string[] }[],
	): Promise<string[] | null> {
		const gone = new Set(from);
		const all = await this.deps.tasks.list();
		const nodes = [
			...all
				.filter((t) => !gone.has(t.id))
				.map((t) => ({
					id: t.id,
					status: t.status as never,
					depends_on: t.dependsOn.some((d) => gone.has(d))
						? [...new Set([...t.dependsOn.filter((d) => !gone.has(d)), ...to])]
						: t.dependsOn,
				})),
			...extra.map((e) => ({
				id: e.id,
				status: "backlog" as never,
				depends_on: e.dependsOn.filter((d) => !gone.has(d)),
			})),
		];
		return findCycle(nodes);
	}

	private async vCreate(tasks: NewTaskSpec[]): Promise<Verdict> {
		const checked = await this.checkNewTasks(tasks);
		if ("verdict" in checked) return checked.verdict;
		return accept({
			wouldCreate: tasks.length,
			titles: tasks.map((t) => t.title),
		});
	}

	private async vUpdate(a: Record<string, unknown>): Promise<Verdict> {
		const t = await this.task(String(a.id));
		if (!t) return this.missingTask(String(a.id));
		if (t.contentRev !== a.baseRev) {
			return reject(
				"stale_rev",
				`${t.id} is at rev ${t.contentRev}, you edited rev ${String(a.baseRev)}`,
				{
					kind: "ui",
					text: "Re-read the task (task tool), then apply your change to the current rev.",
				},
			);
		}
		const patch = a.patch as Record<string, unknown>;
		const owns = patch.owns as string[] | undefined;
		if (owns) {
			const bad = this.ownsProblem(owns);
			if (bad) return bad;
			if (t.status === "in_progress" || t.claimedByRunId) {
				const overlaps = await this.claimOverlaps(owns, t.id);
				if (overlaps.length > 0) {
					return reject(
						"owns_overlap",
						`owns would overlap ${overlaps.map((o) => o.id).join(", ")} (running)`,
						{
							kind: "ui",
							text: `Depend on ${overlaps.map((o) => o.id).join(", ")} or narrow owns.`,
						},
					);
				}
			}
		}
		if (patch.verification) {
			const v = VerificationPlanSchema.safeParse(patch.verification);
			if (!v.success) {
				return reject(
					"invalid_verification",
					`patch.verification: ${v.error.issues.map((x) => x.message).join("; ")}`,
				);
			}
		}
		for (const item of (patch.acceptance as Record<string, unknown>[]) ?? []) {
			if (typeof item.text !== "string" || item.text.trim() === "") {
				return reject(
					"invalid_acceptance",
					"patch.acceptance: every item needs a text",
				);
			}
		}
		const deps = patch.depends_on as string[] | undefined;
		if (deps) {
			const all = await this.deps.tasks.list();
			const ids = new Set(all.map((x) => x.id));
			const missing = deps.find((d) => !ids.has(d));
			if (missing) {
				return reject(
					"dependency_not_found",
					`depends_on '${missing}' does not exist`,
				);
			}
			const nodes = all.map((x) => ({
				id: x.id,
				status: x.status as never,
				depends_on: x.id === t.id ? deps : x.dependsOn,
			}));
			const cycle = findCycle(nodes);
			if (cycle) {
				return reject(
					"dependency_cycle",
					`would create a cycle: ${cycle.join(" -> ")}`,
					{
						kind: "ui",
						text: "Drop one of the dependencies on the cycle.",
					},
				);
			}
		}
		if (
			(patch.provider !== undefined || patch.model !== undefined) &&
			(t.provider || t.model) &&
			a.override_human_pin !== true
		) {
			return reject(
				"human_pin",
				`${t.id} has a routing pin set by a person (provider ${t.provider ?? "-"}, model ${t.model ?? "-"})`,
				{
					kind: "ui",
					text: "Pass override_human_pin: true if you really mean to clear it; it is audited.",
				},
			);
		}
		return accept({
			id: t.id,
			fields: Object.keys(patch),
			fromRev: t.contentRev,
		});
	}

	private async vReparent(a: Record<string, unknown>): Promise<Verdict> {
		const t = await this.task(String(a.id));
		if (!t) return this.missingTask(String(a.id));
		const parentId = a.parent as string | null;
		if (parentId === t.parentId) {
			return accept({ id: t.id, parent: parentId, unchanged: true });
		}
		if (t.status === "in_progress" || t.claimedByGroupId) {
			return reject("mid_run", `${t.id} is running`, {
				kind: "ui",
				text: "Reparent after the run settles.",
			});
		}
		if (parentId === null) return accept({ id: t.id, parent: null });
		if (parentId === t.id) {
			return reject("hierarchy_cycle", "a task cannot be its own parent");
		}
		const parent = await this.task(parentId);
		if (!parent) return this.missingTask(parentId);
		// Not while the new parent or an ancestor of it is running or merging.
		const seen = new Set<string>();
		for (
			let cur: TaskWithRefs | null = parent;
			cur && !seen.has(cur.id);
			cur = cur.parentId ? await this.task(cur.parentId) : null
		) {
			seen.add(cur.id);
			const merging = (await this.liveRuns(cur.id)).some(
				(r) => r.state === "merging",
			);
			if (cur.status === "in_progress" || merging) {
				return reject(
					"mid_run",
					`${cur.id} (the new parent or one of its ancestors) is ${merging ? "merging" : "running"}`,
					{ kind: "ui", text: "Reparent after the run settles." },
				);
			}
		}
		if ((await this.liveRuns(t.id)).some((r) => r.state === "merging")) {
			return reject("mid_run", `${t.id} is merging`, {
				kind: "ui",
				text: "Reparent after the merge lands.",
			});
		}
		const fields = this.store.boardFields(t.id) ?? {};
		const problem = this.store.hierarchyProblem({ id: t.id, fields }, parentId);
		if (problem) {
			return reject(problem.code, problem.message, {
				kind: "ui",
				text:
					problem.code === "hierarchy_cycle"
						? "Pick a parent that is not a descendant of the task."
						: "Pick a parent the board's hierarchy rules allow, or none.",
			});
		}
		return accept({ id: t.id, from: t.parentId, to: parentId });
	}

	private async liveRuns(taskId: string) {
		return (await this.deps.registry.list({ taskId })).filter((r) =>
			["starting", "running", "ended", "finalizing", "merging"].includes(
				r.state,
			),
		);
	}

	private async vSplit(a: Record<string, unknown>): Promise<Verdict> {
		const t = await this.task(String(a.id));
		if (!t) return this.missingTask(String(a.id));
		if (t.status === "done" || t.status === "archived") {
			return reject("terminal_task", `${t.id} is already ${t.status}`, {
				kind: "ui",
				text: "Create new tasks instead; a closed task is not split.",
			});
		}
		const live = await this.liveRuns(t.id);
		if (live.length > 0 && a.stop_live !== true) {
			return reject("live_run", `${t.id} has ${live.length} live run(s)`, {
				kind: "ui",
				text: "Pass stop_live: true to stop them first, or wait for them to settle.",
			});
		}
		if (a.keep_original === "archive") {
			const all = await this.deps.tasks.list();
			if (all.some((x) => x.parentId === t.id)) {
				return reject(
					"has_children",
					`${t.id} has children, which an archived parent would orphan`,
					{
						kind: "ui",
						text: "Use keep_original: epic, or reparent the children first.",
					},
				);
			}
			try {
				await this.deps.tasks.assertClosable(t.id, "archived");
			} catch (e) {
				if (e instanceof TaskUnmergedError) {
					return reject("unmerged_work", e.message, {
						kind: "ui",
						text: "Merge or discard the run's branch before archiving, or use keep_original: epic.",
					});
				}
				throw e;
			}
		}
		const into = a.into as NewTaskSpec[];
		const epicFields =
			a.keep_original === "epic"
				? this.store.boardFieldsFor({
						type: "epic",
						priority: t.priority,
						status: t.status,
					})
				: undefined;
		// A child with no parent of its own sits under the epic.
		const placed = into.map((c) =>
			a.keep_original === "epic" && !c.parent ? { ...c, parent: t.id } : c,
		);
		const checked = await this.checkNewTasks(placed, {
			label: "into",
			excluding: new Set([t.id]),
			...(epicFields ? { parentFields: { [t.id]: epicFields } } : {}),
		});
		if ("verdict" in checked) return checked.verdict;
		const refIndex = new Map(
			into.flatMap((c, i) => (c.ref ? [[c.ref, i] as const] : [])),
		);
		const extra = into.map((c, i) => ({
			id: `\u0000new:${i}`,
			dependsOn: (c.depends_on ?? []).map((d) => {
				const j = refIndex.get(d);
				return j !== undefined ? `\u0000new:${j}` : d;
			}),
		}));
		const cycle = await this.cycleAfterRewire(
			[t.id],
			extra.map((e) => e.id),
			extra,
		);
		if (cycle) {
			return reject(
				"dependency_cycle",
				`what depended on ${t.id} would depend on its parts, and one of them depends back on it: ${cycle.join(" -> ").replaceAll("\u0000new:", "into[")}`,
				{
					kind: "ui",
					text: "Drop the dependency that points back, or order the parts differently.",
				},
			);
		}
		return accept({
			id: t.id,
			into: into.length,
			keep: a.keep_original,
		});
	}

	private async vMerge(a: Record<string, unknown>): Promise<Verdict> {
		const ids = a.ids as string[];
		if (new Set(ids).size !== ids.length) {
			return reject("duplicate_ids", "ids names the same task twice");
		}
		const all = await this.deps.tasks.list();
		for (const id of ids) {
			const t = await this.task(id);
			if (!t) return this.missingTask(id);
			if ((await this.liveRuns(id)).length > 0) {
				return reject("live_run", `${id} has a live run`, {
					kind: "ui",
					text: "Merge tasks only after their runs settle.",
				});
			}
			if (t.status === "done" || t.status === "archived") {
				return reject("terminal_task", `${id} is already ${t.status}`);
			}
			if (all.some((x) => x.parentId === id)) {
				return reject(
					"has_children",
					`${id} has children, which an archived parent would orphan`,
					{ kind: "ui", text: "Reparent the children first." },
				);
			}
			try {
				await this.deps.tasks.assertClosable(id, "archived");
			} catch (e) {
				if (e instanceof TaskUnmergedError) {
					return reject("unmerged_work", e.message, {
						kind: "ui",
						text: "Merge or discard the run's branch before merging this task away.",
					});
				}
				throw e;
			}
		}
		const into = a.into as {
			title: string;
			owns?: string[];
			verification?: Record<string, unknown>;
			acceptance?: Record<string, unknown>[];
		};
		if (into.verification) {
			const v = VerificationPlanSchema.safeParse(into.verification);
			if (!v.success) {
				return reject(
					"invalid_verification",
					`into.verification: ${v.error.issues.map((x) => x.message).join("; ")}`,
				);
			}
		}
		const bad = this.ownsProblem(into.owns);
		if (bad) return bad;
		const set = new Set(ids);
		const recs = all.filter((x) => set.has(x.id));
		const merged = {
			title: into.title,
			type: (recs[0]?.type ?? "implementation") as NewTaskSpec["type"],
			size: "m" as const,
			owns: into.owns ?? [...new Set(recs.flatMap((r) => r.owns))],
			depends_on: [
				...new Set(recs.flatMap((r) => r.dependsOn).filter((d) => !set.has(d))),
			],
		};
		const checked = await this.checkNewTasks([merged], {
			label: "into",
			excluding: set,
		});
		if ("verdict" in checked) return checked.verdict;
		const cycle = await this.cycleAfterRewire(
			ids,
			["\u0000new:0"],
			[{ id: "\u0000new:0", dependsOn: merged.depends_on }],
		);
		if (cycle) {
			return reject(
				"dependency_cycle",
				`the merged task would sit on a cycle: ${cycle.join(" -> ").replaceAll("\u0000new:0", "(merged)")}`,
				{
					kind: "ui",
					text: "Do not merge tasks that other tasks reach through each other.",
				},
			);
		}
		return accept({ merging: ids });
	}

	private async vSetStatus(a: Record<string, unknown>): Promise<Verdict> {
		const t = await this.task(String(a.id));
		if (!t) return this.missingTask(String(a.id));
		const to = a.to as "backlog" | "ready" | "blocked" | "archived" | "draft";
		if (t.status === to) return accept({ id: t.id, unchanged: true });
		const roles = this.store.statusRolesAvailable();
		if (!roles.includes(to)) {
			return reject(
				"status_unavailable",
				`this board has no column for '${to}' (it has: ${roles
					.map((r) => this.store.boardStatusFor(r))
					.join(", ")})`,
				{ kind: "ui", text: "Use a status the board declares." },
			);
		}
		const live = await this.liveRuns(t.id);
		if (live.length > 0) {
			return reject("task_claimed", `${t.id} has a live run (${live[0]?.id})`, {
				kind: "ui",
				text: "Stop the run first (stop), then change the status.",
			});
		}
		if (t.draftPhase === "waiting_for_answers") {
			return reject(
				"draft_awaiting_answers",
				`${t.id} is a draft waiting for a person's answers`,
				{
					kind: "ui",
					text: "Leave it, or notify_human; the answers resume its planning.",
				},
			);
		}
		if (to === "archived") {
			try {
				await this.deps.tasks.assertClosable(t.id, "archived");
			} catch (e) {
				if (e instanceof TaskUnmergedError) {
					return reject("unmerged_work", e.message, {
						kind: "ui",
						text: "Merge or discard the run's branch before archiving, or leave the task as it is.",
					});
				}
				throw e;
			}
		}
		return accept({ id: t.id, from: t.status, to });
	}

	/** A `plan`-role spawn: expand a draft, or plan from a brief (read-only). */
	private async vPlan(
		t: TaskWithRefs,
		a: Record<string, unknown>,
	): Promise<Verdict> {
		if (t.status === "done" || t.status === "archived") {
			return reject("terminal_task", `${t.id} is already ${t.status}`);
		}
		if (a.maxUsd !== undefined) {
			return reject(
				"max_usd_unsupported",
				"a per-run spend cap is not enforced yet, so it is refused rather than ignored",
				{ kind: "ui", text: "Omit maxUsd." },
			);
		}
		const paused = await this.deps.world.dispatchPaused?.();
		if (paused) {
			return reject(
				"dispatch_paused",
				`dispatch is stopped: ${paused.reason}`,
				{
					kind: "ui",
					text: "Plan and note, but wait for a person to resume dispatch.",
				},
			);
		}
		const held = (await this.deps.executor.holds())[t.id];
		if (held) {
			return reject(
				"task_paused",
				`${t.id} is held (${held.by}): ${held.reason}`,
				{ kind: "ui", text: "Use resume to lift your own pause first." },
			);
		}
		if (t.status === "draft") {
			if (t.draftPhase === "waiting_for_answers") {
				return reject(
					"draft_awaiting_answers",
					`${t.id} is waiting for a person's answers`,
					{
						kind: "ui",
						text: "Planning resumes when they answer; do not spawn another.",
					},
				);
			}
			if (t.draftPhase === "failed") {
				return reject(
					"expansion_exhausted",
					`${t.id}'s draft expansion failed ${t.draftAttempts} times`,
					{
						kind: "ui",
						text: "notify_human: the draft needs a rewritten prompt, or archive it with set_status.",
					},
				);
			}
		}
		const live = await this.deps.registry.list({
			kinds: ["plan"],
			states: ["starting", "running", "ended", "finalizing"],
		});
		if (live.some((r) => r.taskId === t.id) || t.claimedByGroupId) {
			return reject("already_planning", `${t.id} already has a planning run`, {
				kind: "ui",
				text: "Wait for it to settle; its output arrives in a later digest.",
			});
		}
		const pending = (await this.deps.executor.accepted(["spawn"])).some((r) => {
			const x = r.args as Record<string, unknown>;
			return x.role === "plan" && x.taskId === t.id;
		});
		if (pending) {
			return reject(
				"already_planning",
				`a plan run for ${t.id} is already accepted and waiting for the scheduler`,
				{ kind: "ui", text: "Wait for it to start." },
			);
		}
		const planCap = this.deps.world.maxPlanRuns?.() ?? 2;
		if (live.length >= planCap) {
			return reject(
				"plan_cap",
				`${live.length} planning runs are already live (cap ${planCap})`,
				{ kind: "ui", text: "Wait for one to settle." },
			);
		}
		return accept({
			taskId: t.id,
			role: "plan",
			mode: t.status === "draft" ? "expand" : "plan",
		});
	}

	/**
	 * `spawn` role `import`: one read-only survey of the repository whose
	 * proposal (`plan_output`) the brain applies with the board tools. `taskId`
	 * anchors the audit row (any task, typically the one the survey serves); the
	 * run itself claims nothing.
	 */
	private async vImport(
		t: TaskWithRefs,
		a: Record<string, unknown>,
	): Promise<Verdict> {
		if (a.worktree !== undefined && a.worktree !== "new") {
			return reject("worktree_unavailable", "an import run has no worktree", {
				kind: "ui",
				text: "Omit worktree.",
			});
		}
		const paused = await this.deps.world.dispatchPaused?.();
		if (paused) {
			return reject(
				"dispatch_paused",
				`dispatch is stopped: ${paused.reason}`,
				{
					kind: "ui",
					text: "Plan and note, but wait for a person to resume dispatch.",
				},
			);
		}
		const live = await this.deps.registry.list({
			kinds: ["import"],
			states: ["starting", "running", "ended", "finalizing"],
		});
		const pending = (await this.deps.executor.accepted(["spawn"])).some(
			(r) => (r.args as Record<string, unknown>).role === "import",
		);
		if (live.length > 0 || pending) {
			return reject("already_importing", "an import run is already live", {
				kind: "ui",
				text: "Wait for it to settle; its proposal arrives in a later digest.",
			});
		}
		return accept({ taskId: t.id, role: "import" });
	}

	private async vAnswer(a: Record<string, unknown>): Promise<Verdict> {
		const runId = String(a.runId);
		const run = await this.deps.registry.get(runId);
		if (!run) {
			return reject("run_not_found", `no run '${runId}'`);
		}
		const [c] = await this.deps.handle.db
			.select()
			.from(clarifications)
			.where(eq(clarifications.runId, runId));
		const open = c && !c.resolvedAt && c.items.some((i) => i.answer === null);
		const asking =
			open ||
			(run.activity === "needs_answer" &&
				["starting", "running", "ended", "finalizing"].includes(run.state));
		if (!asking) {
			return reject("no_open_question", `run ${runId} has no open question`, {
				kind: "ui",
				text: "Check run_report for the run's state; only an open question can be answered.",
			});
		}
		const question = c?.items.map((i) => i.question).join("\n") ?? "";
		if (SECRET_WORDS.test(question) || SECRET_WORDS.test(String(a.answer))) {
			return reject(
				"needs_human",
				"the question or the answer involves a credential or secret",
				{
					kind: "ui",
					text: "Use notify_human(kind: credential); a brain never supplies secrets.",
				},
			);
		}
		return accept({ runId, taskId: run.taskId });
	}

	private async vSpawn(a: Record<string, unknown>): Promise<Verdict> {
		const taskId = String(a.taskId);
		const t = await this.task(taskId);
		if (!t) return this.missingTask(taskId);
		const role = a.role as string;
		if (role === "plan") return this.vPlan(t, a);
		if (role === "import") return this.vImport(t, a);
		if (role !== "implement" && role !== "attempt") {
			return reject(
				"role_unavailable",
				`role '${role}' cannot be spawned yet: only implement, attempt, plan and import are live`,
				{
					kind: "ui",
					text: "Use role implement for one run, role plan to expand a draft or plan from a brief, or spawn_attempts / role attempt for competing runs.",
				},
			);
		}
		if (a.maxUsd !== undefined) {
			return reject(
				"max_usd_unsupported",
				"a per-run spend cap is not enforced yet, so it is refused rather than ignored",
				{
					kind: "ui",
					text: "Omit maxUsd; budgets arrive with the budget phase.",
				},
			);
		}
		if (typeof a.effort === "string" && !EFFORTS.includes(a.effort)) {
			return reject(
				"invalid_effort",
				`effort '${a.effort}' is not one of ${EFFORTS.join(", ")}`,
				{
					kind: "ui",
					text: `Use one of: ${EFFORTS.join(", ")}, or omit effort.`,
				},
			);
		}
		const held = (await this.deps.executor.holds())[taskId];
		if (held) {
			return reject(
				"task_paused",
				`${taskId} is held (${held.by}): ${held.reason}`,
				{ kind: "ui", text: "Use resume to lift your own pause first." },
			);
		}
		const paused = await this.deps.world.dispatchPaused?.();
		if (paused) {
			return reject(
				"dispatch_paused",
				`dispatch is stopped: ${paused.reason}`,
				{
					kind: "ui",
					text: "Plan and note, but wait for a person to resume dispatch.",
				},
			);
		}
		const exploratory = ["research", "spike", "plan"].includes(role);
		if (!exploratory) {
			const all = await this.deps.tasks.list();
			const byId = new Map(all.map((x) => [x.id, x]));
			const open = t.dependsOn.filter((d) => byId.get(d)?.status !== "done");
			if (open.length > 0) {
				return reject(
					"dependencies_open",
					`${taskId} depends on unfinished ${open.join(", ")}`,
					{
						kind: "ui",
						text: `Wait for ${open.join(", ")} to merge, or spawn a research/spike run.`,
					},
				);
			}
			if (t.status !== "ready" && t.status !== "in_progress") {
				return reject("not_ready", `${taskId} is ${t.status}, not ready`, {
					kind: "ui",
					text: "Move it to ready (set_status) when its definition is complete.",
				});
			}
		}
		// The loop guard (I10) and the lifetime run cap (I9): a task that keeps
		// failing is the brain's to escalate or archive, not to retry forever.
		const history = await this.failureHistory(taskId);
		if (history.failedGroups >= this.caps.consecutiveFailedGroups) {
			return reject(
				"task_stuck",
				`${taskId} has failed ${history.failedGroups} attempt groups in a row (cap ${this.caps.consecutiveFailedGroups})`,
				{
					kind: "ui",
					text: "escalate or archive: notify_human(kind: brain_stuck) with what you tried, or set_status archived. A person moving the task resets this.",
				},
			);
		}
		if (history.runs >= this.caps.runsPerTask) {
			return reject(
				"task_run_budget",
				`${taskId} has used ${history.runs} runs (cap ${this.caps.runsPerTask})`,
				{
					kind: "ui",
					text: "escalate or archive: notify_human(kind: brain_stuck) with what you tried, or set_status archived.",
				},
			);
		}
		const live = await this.liveRuns(taskId);
		if (live.length >= this.caps.liveRunsPerTask) {
			return reject(
				"task_run_cap",
				`${taskId} already has ${live.length} live runs`,
				{
					kind: "ui",
					text: "Wait for one to settle or stop one.",
				},
			);
		}
		if (t.claimedByGroupId) {
			const joining = role === "attempt" && a.groupId === t.claimedByGroupId;
			if (!joining) {
				return reject(
					"task_claimed",
					`${taskId} is claimed by ${t.claimedByRunId ?? t.claimedByGroupId}`,
					{
						kind: "ui",
						text:
							role === "attempt"
								? `Pass groupId ${t.claimedByGroupId} to join its attempt group, or stop the claim holder.`
								: "Wait for the claim holder to settle, join its group with role attempt and its groupId, or stop it.",
					},
				);
			}
		}
		if (role === "attempt" && typeof a.groupId === "string") {
			const group = await this.deps.registry.getGroup(a.groupId);
			if (
				!group ||
				group.taskId !== taskId ||
				group.kind !== "competing" ||
				group.status !== "open"
			) {
				return reject(
					"group_unavailable",
					`${a.groupId} is not an open attempt group of ${taskId}`,
					{
						kind: "ui",
						text: "Omit groupId to open a new group, or use the id from spawn_attempts.",
					},
				);
			}
			const members = await this.deps.registry.groupRuns(group.id);
			if (members.length >= this.caps.attemptsPerGroup) {
				return reject(
					"attempt_cap",
					`group ${group.id} already has ${members.length} attempts (cap ${this.caps.attemptsPerGroup})`,
					{ kind: "ui", text: "Select a winner or stop an attempt first." },
				);
			}
		}
		const overlaps = await this.claimOverlaps(t.owns, t.id);
		if (overlaps.length > 0 && !exploratory) {
			return reject(
				"owns_overlap",
				`owns overlaps ${overlaps.map((o) => o.id).join(", ")} (running)`,
				{
					kind: "ui",
					text: `Depend on ${overlaps.map((o) => o.id).join(", ")} or narrow owns.`,
				},
			);
		}
		const running = (
			await this.deps.registry.list({
				states: ["starting", "running", "ended", "finalizing"],
			})
		).filter((r) => r.kind !== "brain");
		const reserved = await this.deps.executor.reservedSlots();
		if (running.length + reserved >= this.deps.world.maxConcurrent()) {
			return reject(
				"capacity",
				`${running.length + reserved} of ${this.deps.world.maxConcurrent()} worker slots are in use or promised to your earlier spawns`,
				{
					kind: "ui",
					text: "Wait for a run to settle; you are woken when capacity frees.",
				},
			);
		}
		const spent = await this.deps.world.budgetHold?.(t);
		if (spent) {
			return reject(
				"budget_exhausted",
				`${taskId} depends on ${spent.key}: ${spent.reason}`,
				{
					kind: "setting",
					text: `Raise the budget for ${spent.key} (owner), or spawn work that does not use it; it resets ${new Date(spent.until).toISOString()}.`,
				},
			);
		}
		const routeHeld = await this.deps.world.routeHeld?.(t, {
			...(typeof a.harness === "string" ? { provider: a.harness } : {}),
			...(typeof a.model === "string" ? { model: a.model } : {}),
		});
		if (routeHeld) {
			return reject(
				"provider_held",
				`${routeHeld.key} is held: ${routeHeld.reason}`,
				{
					kind: "ui",
					text: "Name another harness or model in the spawn, or wait for the hold to clear.",
				},
			);
		}
		const worktree = String(a.worktree ?? "new");
		if (worktree.startsWith("fork:")) {
			return reject(
				"fork_unsupported",
				"worktree: fork:<runId> is not available yet",
				{
					kind: "ui",
					text: "Use worktree: new, or continue:<runId> on a settled run of this task.",
				},
			);
		}
		if (worktree.startsWith("continue:")) {
			const parent = await this.deps.registry.get(worktree.split(":")[1] ?? "");
			if (!parent || parent.taskId !== taskId || !parent.worktreePath) {
				return reject(
					"worktree_unavailable",
					`${worktree} is not a finished run of ${taskId} with a worktree`,
					{
						kind: "ui",
						text: "Use worktree: new, or name a run of this task whose worktree still exists.",
					},
				);
			}
			if (
				["starting", "running", "ended", "finalizing", "merging"].includes(
					parent.state,
				)
			) {
				return reject("worktree_live", `${parent.id} is still live`, {
					kind: "ui",
					text: "continue: works only on a settled run; stop it first.",
				});
			}
			const present = await access(parent.worktreePath).then(
				() => true,
				() => false,
			);
			if (!present) {
				return reject(
					"worktree_gone",
					`${parent.id}'s worktree no longer exists (it was clean, or archived)`,
					{
						kind: "ui",
						text: "Use worktree: new; a scope-killed run's work is on its wip/ branch (named in the settle).",
					},
				);
			}
		}
		return accept({
			taskId,
			role,
			worktree,
			harness: a.harness ?? null,
			model: a.model ?? null,
		});
	}

	/**
	 * How the task's runs have gone: attempt groups that failed in a row (the
	 * newest first, until one landed, is live, or a person moved the task) and
	 * the lifetime count of its runs. Neutral outcomes (rate limits, a manual
	 * stop) neither count nor break the streak.
	 */
	private async failureHistory(
		taskId: string,
	): Promise<{ failedGroups: number; runs: number }> {
		const rows = (await this.deps.registry.list({ taskId })).filter(
			(r) => r.kind === "task",
		);
		const moved = await this.deps.handle.db
			.select({ ts: events.ts, payload: events.payload })
			.from(events)
			.where(
				and(eq(events.taskId, taskId), eq(events.type, "task.status_changed")),
			)
			.orderBy(desc(events.seq))
			.limit(50);
		const since =
			moved.find((e) => e.payload.actor === "human")?.ts.getTime() ?? 0;
		const groups = new Map<string, typeof rows>();
		for (const r of rows) {
			if (r.startedAt.getTime() < since) continue;
			const id = groupIdOf(r);
			groups.set(id, [...(groups.get(id) ?? []), r]);
		}
		const FAILED = new Set([
			"failed",
			"killed",
			"interrupted",
			"finalize_error",
			"needs_review",
		]);
		const ordered = [...groups.values()].sort(
			(x, y) =>
				Math.max(...y.map((r) => r.startedAt.getTime())) -
				Math.max(...x.map((r) => r.startedAt.getTime())),
		);
		let failedGroups = 0;
		for (const members of ordered) {
			const neutral = members.every(
				(r) => r.state === "rate_limited" || r.outcome === "killed_manual",
			);
			if (neutral) continue;
			if (members.every((r) => FAILED.has(r.state))) {
				failedGroups++;
				continue;
			}
			break;
		}
		return { failedGroups, runs: rows.length };
	}

	private async vSpawnAttempts(a: Record<string, unknown>): Promise<Verdict> {
		const variants = a.variants as unknown[];
		if (variants.length > this.caps.attemptsPerGroup) {
			return reject(
				"attempt_cap",
				`${variants.length} attempts exceeds the cap of ${this.caps.attemptsPerGroup}`,
				{
					kind: "ui",
					text: `Spawn at most ${this.caps.attemptsPerGroup} variants.`,
				},
			);
		}
		// All or none: the first inadmissible variant rejects the whole call.
		for (const [i, v] of (a.variants as Record<string, unknown>[]).entries()) {
			const verdict = await this.vSpawn({
				taskId: a.taskId,
				role: "attempt",
				worktree: "new",
				...(v.harness ? { harness: v.harness } : {}),
				...(v.model ? { model: v.model } : {}),
				...(v.effort ? { effort: v.effort } : {}),
				...(v.target ? { target: v.target } : {}),
			});
			if (!verdict.ok) {
				return reject(
					verdict.rejection.code,
					`variant ${i}: ${verdict.rejection.message}`,
					verdict.rejection.fix,
				);
			}
		}
		const running = (
			await this.deps.registry.list({
				states: ["starting", "running", "ended", "finalizing"],
			})
		).filter((r) => r.kind !== "brain").length;
		const spoken = running + (await this.deps.executor.reservedSlots());
		if (spoken + variants.length > this.deps.world.maxConcurrent()) {
			return reject(
				"capacity",
				`${variants.length} attempts need ${variants.length} slots; ${Math.max(0, this.deps.world.maxConcurrent() - spoken)} are free`,
				{
					kind: "ui",
					text: "Spawn fewer variants, or wait for capacity. No partial fan-out.",
				},
			);
		}
		return accept({
			taskId: a.taskId,
			variants: variants.length,
			selection: a.selection,
		});
	}

	private async vSelectWinner(a: Record<string, unknown>): Promise<Verdict> {
		const runId = String(a.runId);
		const f = await this.deps.executor.facts(runId);
		if (!f.run) return reject("run_not_found", `no run '${runId}'`);
		const groupId = groupIdOf(f.run);
		if (typeof a.groupId === "string" && a.groupId !== groupId) {
			return reject(
				"group_mismatch",
				`${runId} belongs to group ${groupId}, not ${a.groupId}`,
				{ kind: "ui", text: `Pass groupId ${groupId}, or omit it.` },
			);
		}
		const group = await this.deps.registry.getGroup(groupId);
		if (group?.kind !== "competing") {
			return reject(
				"not_competing",
				`${runId} is not an attempt of a competing group`,
				{
					kind: "ui",
					text: "A single run merges through the gates by itself; select_winner chooses among spawn_attempts runs.",
				},
			);
		}
		if (group.status !== "open") {
			return reject(
				"group_closed",
				`group ${groupId} is ${group.status}${group.winnerRunId ? ` (winner ${group.winnerRunId})` : ""}`,
				{ kind: "ui", text: "A group has at most one winner." },
			);
		}
		if (!f.verified) {
			return reject("not_verified", `${runId} has not passed verification`, {
				kind: "ui",
				text: "Only a run that settled verified can win; request a repair or another attempt.",
			});
		}
		if (!f.settled) {
			return reject("run_not_settled", `${runId} has not finished`, {
				kind: "ui",
				text: "Wait for it to settle; you are woken when it does.",
			});
		}
		if (f.scopeOutside > 0) {
			return reject(
				"scope_outside",
				`${runId} changed files outside its task's scope`,
				{
					kind: "ui",
					text: "Scope violations go to review, never straight to merge.",
				},
			);
		}
		if (
			f.review &&
			(f.review.status !== "ok" || f.review.verdict !== "merge")
		) {
			return reject(
				"review_not_passed",
				`the review floor did not allow ${runId} to merge (${f.review.verdict ?? f.review.status})`,
				{
					kind: "ui",
					text: "Choose another verified attempt, or spawn a repair on this run's worktree.",
				},
			);
		}
		return accept({ runId, taskId: f.run.taskId, groupId });
	}

	private async vRequestReview(a: Record<string, unknown>): Promise<Verdict> {
		const runId = String(a.runId);
		const run = await this.deps.registry.get(runId);
		if (!run) return reject("run_not_found", `no run '${runId}'`);
		const reviewer = a.reviewer as
			| { harness: string; model: string }
			| undefined;
		if (reviewer) {
			const independent = isIndependent(
				{ harness: run.harness ?? run.providerId, model: run.model },
				reviewer,
			);
			if (!independent) {
				return reject(
					"reviewer_not_independent",
					`reviewer ${reviewer.harness}:${reviewer.model} is the same model and harness as the worker`,
					{
						kind: "ui",
						text: "Pick a reviewer that differs from the worker in model or harness.",
					},
				);
			}
		}
		return accept({ runId, mode: a.mode });
	}

	private async vSteer(a: Record<string, unknown>): Promise<Verdict> {
		const runId = String(a.runId);
		const run = await this.deps.registry.get(runId);
		if (!run) return reject("run_not_found", `no run '${runId}'`);
		if (!["starting", "running"].includes(run.state)) {
			return reject("run_not_live", `${runId} is ${run.state}`, {
				kind: "ui",
				text: "Only a live run can be steered.",
			});
		}
		if (!run.capabilities.verified || !run.capabilities.steer) {
			return reject(
				"steer_unsupported",
				`${runId}'s harness cannot be steered`,
				{
					kind: "ui",
					text: "Stop it and spawn a continuation with a brief instead.",
				},
			);
		}
		return accept({ runId });
	}

	private async vStop(a: Record<string, unknown>): Promise<Verdict> {
		const runId = String(a.runId);
		const run = await this.deps.registry.get(runId);
		if (!run) return reject("run_not_found", `no run '${runId}'`);
		if (!["starting", "running", "ended", "finalizing"].includes(run.state)) {
			return reject("run_not_live", `${runId} is already ${run.state}`);
		}
		return accept({ runId, taskId: run.taskId });
	}

	private async vPause(tool: "pause" | "resume", a: Record<string, unknown>) {
		const ids = (a.taskIds as string[] | undefined) ?? [];
		if (ids.length === 0 && !a.subtree) {
			return reject("no_target", `${tool} needs taskIds or a subtree`);
		}
		for (const id of ids) {
			if (!(await this.task(id))) return this.missingTask(id);
		}
		if (a.subtree && !(await this.task(String(a.subtree)))) {
			return this.missingTask(String(a.subtree));
		}
		return accept({ tool, taskIds: ids, subtree: a.subtree ?? null });
	}

	private async vSetBudget(a: Record<string, unknown>): Promise<Verdict> {
		if (!this.deps.world.checkBudget) {
			return reject(
				"ceiling_unknown",
				`no budget ceiling is configured for '${String(a.budget)}'`,
				{
					kind: "setting",
					text: "Ask the owner to add the budget in Settings.",
				},
			);
		}
		const v = await this.deps.world.checkBudget({
			budget: String(a.budget),
			...(typeof a.limitUsd === "number" ? { limitUsd: a.limitUsd } : {}),
			...(typeof a.limitTokens === "number"
				? { limitTokens: a.limitTokens }
				: {}),
			...(typeof a.window === "string" ? { window: a.window } : {}),
		});
		if (!v.ok) {
			return reject(v.code, v.message, { kind: "ui", text: v.fix });
		}
		return accept({ budget: v.id, limit: v.limit, ceiling: v.ceiling });
	}

	private async vNotify(a: Record<string, unknown>) {
		if (a.kind === "fyi") {
			const dayAgo = new Date(this.now() - 86_400_000);
			const rows = await this.deps.handle.db
				.select()
				.from(brainActions)
				.where(eq(brainActions.tool, "notify_human"));
			const n = rows.filter(
				(r) =>
					r.args.kind === "fyi" &&
					r.status !== "rejected" &&
					r.createdAt >= dayAgo,
			).length;
			if (n >= this.caps.fyiPerDay) {
				return reject(
					"fyi_rate_limited",
					`${this.caps.fyiPerDay} fyi notices per day is the cap`,
					{
						kind: "ui",
						text: "Put it in note or set_plan; the owner reads the audit trail.",
					},
				);
			}
		}
		for (const id of (a.blocking as string[] | undefined) ?? []) {
			if (!(await this.task(id))) return this.missingTask(id);
		}
		return accept({ kind: a.kind, blocking: a.blocking ?? [] });
	}

	private async vNote(a: Record<string, unknown>): Promise<Verdict> {
		if (typeof a.taskId === "string" && !(await this.task(a.taskId))) {
			return this.missingTask(a.taskId);
		}
		return accept({ taskId: a.taskId ?? null });
	}
}
