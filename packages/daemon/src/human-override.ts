import type { ProjectDbHandle } from "@mfw/db/client";
import { appendEvent, type EventBus, type StoredEvent } from "@mfw/db/eventlog";
import { ulid } from "@mfw/db/ids";
import { brainActions, brainSessions, decisions } from "@mfw/db/schema";
import { desc, eq } from "drizzle-orm";
import type { BrainActionExecutor } from "./brain-runtime/executor.ts";
import { type HumanAction, recordHumanAction } from "./human-actions.ts";
import type { Logger } from "./log.ts";
import type { GroupRunSpec } from "./run-engine.ts";
import type { RunRegistry } from "./run-registry.ts";
import type { TaskService } from "./task-service.ts";

/**
 * A person overrides what the brain would have done (a chosen winner, a
 * reroute, an added attempt): the audit row is p4's `recordHumanAction`
 * (`role: human`) with `kind: override`, written before the effect so the
 * effect's ids are on it; `finishHumanOverride` settles it. When the person
 * reversed a brain decision, that decision gets `overridden_by` and a
 * `human.override` event wakes the brain at once.
 */

export interface HumanOverrideInput {
	action: HumanAction;
	taskId: string | null;
	subjectRunId: string | null;
	reason: string;
	input: Record<string, unknown>;
	/** The result written with the row (ids the effect will use). */
	accepted?: Record<string, unknown>;
	/** The brain decision this reverses, when there is one (wakes the brain). */
	overriddenDecisionId?: number | null;
	now?: number;
}

export async function recordHumanOverride(
	deps: { handle: ProjectDbHandle; bus: EventBus },
	o: HumanOverrideInput,
): Promise<number> {
	const nowMs = o.now ?? Date.now();
	const id =
		(await recordHumanAction(
			deps,
			{
				action: o.action,
				taskId: o.taskId,
				runId: o.subjectRunId,
				reason: o.reason,
				input: o.input,
				kind: "override",
				output: {
					status: "accepted",
					...(o.accepted ? { result: o.accepted } : {}),
				},
			},
			() => nowMs,
		)) ?? 0;
	if (id && o.overriddenDecisionId) {
		const overridden = o.overriddenDecisionId;
		const event = await deps.handle.withTx(async (tx) => {
			await tx
				.update(decisions)
				.set({ overriddenBy: id })
				.where(eq(decisions.id, overridden));
			return appendEvent(
				tx,
				{
					type: "human.override",
					...(o.taskId ? { taskId: o.taskId } : {}),
					...(o.subjectRunId ? { runId: o.subjectRunId } : {}),
					payload: {
						decisionId: id,
						overriddenDecisionId: overridden,
						reason: o.reason,
					},
				},
				nowMs,
			);
		});
		deps.bus.publish([event]);
	}
	return id;
}

/** Settle the row once the effect ran (or failed). */
export async function finishHumanOverride(
	handle: ProjectDbHandle,
	id: number,
	outcome:
		| { ok: true; result: Record<string, unknown> }
		| { ok: false; error: string },
): Promise<void> {
	await handle.db
		.update(decisions)
		.set(
			outcome.ok
				? { output: { status: "applied", result: outcome.result } }
				: {
						status: "failed",
						output: { status: "failed", error: outcome.error },
					},
		)
		.where(eq(decisions.id, id));
}

// ---------------------------------------------------------------------------
// Inverse-operation overrides of brain decisions, and messages to the brain
// ---------------------------------------------------------------------------

/**
 * The human's two levers on the brain (P6). The brain has the final say and
 * maximal autonomy; a person steps in only by choice, and every step is
 * audited:
 *
 * - `override(decisionId, reason)`: compute the inverse of one brain decision,
 *   apply it, mark the original `overridden_by`, write a `kind: "override"`
 *   decision row, emit `human.override` (which wakes the brain with the
 *   `human` class) and leave the line the next rehydration digest shows.
 *   `preview` returns the same inverse without touching anything, so the UI
 *   can show it before the person confirms.
 * - `message(text, about?)`: a durable note to the brain. A `decisions` row
 *   (so the task Story shows it) plus a `human.brain_message` event (so the
 *   brain wakes and the digest carries it).
 *
 * Inverses are read off what the decision recorded (`output.result` at record
 * time, `output.effects.result` after the effect), never recomputed from the
 * present, so an override undoes exactly what the brain did.
 */

export type InverseStep =
	| { op: "set_status"; taskId: string; to: string; summary: string }
	| { op: "reparent"; taskId: string; parent: string | null; summary: string }
	| { op: "stop_run"; runId: string; summary: string }
	| { op: "cancel_spawn"; actionId: string; summary: string }
	| { op: "continue_run"; runId: string; taskId: string; summary: string }
	| { op: "release_holds"; taskIds: string[]; summary: string }
	| { op: "hold_tasks"; taskIds: string[]; summary: string };

export interface OverridePreview {
	decisionId: number;
	tool: string | null;
	taskId: string | null;
	/**
	 * `ready`: an inverse exists and can be applied. `acknowledge`: the effect
	 * has no inverse (a steer, a note to a person); the override records the
	 * disagreement and tells the brain. `overridden`, `not_applicable`: nothing
	 * to do.
	 */
	state: "ready" | "acknowledge" | "overridden" | "not_applicable";
	overriddenBy: number | null;
	/** One line: what applying will do. */
	summary: string;
	steps: InverseStep[];
}

export class OverrideError extends Error {
	constructor(
		readonly code:
			| "unknown_decision"
			| "reason_required"
			| "not_overridable"
			| "already_overridden"
			| "step_failed",
		message: string,
	) {
		super(message);
		this.name = "OverrideError";
	}
}

export interface HumanOverrideDeps {
	handle: ProjectDbHandle;
	bus: EventBus;
	tasks: TaskService;
	registry: RunRegistry;
	engine: {
		stop(runId: string): Promise<void>;
		startGroupRun(spec: GroupRunSpec): Promise<{ runId: string }>;
	};
	executor: Pick<
		BrainActionExecutor,
		"releaseHolds" | "addHolds" | "cancelPending"
	>;
	log: Logger;
	wakeScheduler?: () => void;
	now?: () => number;
}

type DecisionRow = typeof decisions.$inferSelect;

const LIVE = ["starting", "running", "ended", "finalizing", "merging"];
const MAX_TEXT = 4000;

const strs = (v: unknown): string[] =>
	Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** Where a decision's recorded facts live: the effects after the call, else the record-time preview. */
function factsOf(d: DecisionRow): Record<string, unknown> {
	const out = d.output as {
		result?: Record<string, unknown>;
		effects?: { result?: Record<string, unknown> } & Record<string, unknown>;
	};
	return {
		...(out.result ?? {}),
		...(out.effects ?? {}),
		...(out.effects?.result ?? {}),
	};
}

export class HumanOverrideService {
	private readonly now: () => number;

	constructor(private readonly deps: HumanOverrideDeps) {
		this.now = deps.now ?? (() => Date.now());
	}

	private async load(decisionId: number): Promise<DecisionRow> {
		const [d] = await this.deps.handle.db
			.select()
			.from(decisions)
			.where(eq(decisions.id, decisionId));
		if (!d) {
			throw new OverrideError("unknown_decision", `no decision #${decisionId}`);
		}
		return d;
	}

	/** What overriding this decision would do. Writes nothing. */
	async preview(decisionId: number): Promise<OverridePreview> {
		const d = await this.load(decisionId);
		return this.inverseOf(d);
	}

	private async inverseOf(d: DecisionRow): Promise<OverridePreview> {
		const base = {
			decisionId: d.id,
			tool: d.action,
			taskId: d.taskId,
			overriddenBy: d.overriddenBy,
		};
		const none = (
			state: "not_applicable" | "overridden" | "acknowledge",
			summary: string,
		): OverridePreview => ({ ...base, state, summary, steps: [] });

		if (d.overriddenBy != null) {
			return none(
				"overridden",
				`already overridden by decision #${d.overriddenBy}`,
			);
		}
		if (d.role !== "brain") {
			return none("not_applicable", "only a brain decision can be overridden");
		}
		if (d.kind === "plan" || d.kind === "note" || d.kind === "rollover") {
			return none(
				"not_applicable",
				"this is the brain's own memory, not an effect; message the brain instead",
			);
		}
		const status = (d.output as { status?: string }).status;
		if (status !== "applied" && status !== "accepted") {
			return none(
				"not_applicable",
				`the call was ${status ?? "not applied"}, so there is nothing to undo`,
			);
		}
		const f = factsOf(d);
		const a = d.input as Record<string, unknown>;
		const previous = (f.previous ?? {}) as Record<string, unknown>;
		const steps: InverseStep[] = [];
		const gone = (why: string) =>
			none(
				"acknowledge",
				`${why}; overriding records your disagreement and tells the brain`,
			);

		switch (d.action) {
			case "set_status": {
				const id = String(a.id ?? d.taskId ?? "");
				const prev = previous.status;
				if (typeof prev !== "string") {
					return gone(
						"this decision did not record the task's previous status",
					);
				}
				steps.push({
					op: "set_status",
					taskId: id,
					to: prev,
					summary: `move ${id} back to ${prev}`,
				});
				break;
			}
			case "reparent": {
				const id = String(a.id ?? d.taskId ?? "");
				if (!("parent" in previous)) {
					return gone(
						"this decision did not record the task's previous parent",
					);
				}
				const parent = (previous.parent as string | null) ?? null;
				steps.push({
					op: "reparent",
					taskId: id,
					parent,
					summary: parent
						? `move ${id} back under ${parent}`
						: `make ${id} a root task again`,
				});
				break;
			}
			case "create_tasks": {
				for (const id of strs(f.ids)) {
					steps.push({
						op: "set_status",
						taskId: id,
						to: "archived",
						summary: `archive ${id}`,
					});
				}
				if (steps.length === 0) return gone("no created task was recorded");
				break;
			}
			case "split_task": {
				for (const id of strs(f.ids)) {
					steps.push({
						op: "set_status",
						taskId: id,
						to: "archived",
						summary: `archive ${id}`,
					});
				}
				const orig = String(a.id ?? d.taskId ?? "");
				if (typeof previous.status === "string" && orig) {
					steps.push({
						op: "set_status",
						taskId: orig,
						to: previous.status,
						summary: `move ${orig} back to ${previous.status}`,
					});
				}
				if (steps.length === 0) return gone("no split result was recorded");
				break;
			}
			case "merge_tasks": {
				for (const id of strs(f.ids)) {
					steps.push({
						op: "set_status",
						taskId: id,
						to: "archived",
						summary: `archive merged task ${id}`,
					});
				}
				const prevStatuses = (previous.statuses ?? {}) as Record<
					string,
					string
				>;
				for (const [id, st] of Object.entries(prevStatuses)) {
					steps.push({
						op: "set_status",
						taskId: id,
						to: st,
						summary: `move ${id} back to ${st}`,
					});
				}
				if (steps.length === 0) return gone("no merge result was recorded");
				break;
			}
			case "spawn":
			case "spawn_attempts": {
				const [row] = await this.deps.handle.db
					.select()
					.from(brainActions)
					.where(eq(brainActions.decisionId, d.id));
				if (row?.status === "accepted") {
					steps.push({
						op: "cancel_spawn",
						actionId: row.id,
						summary: "cancel the spawn before it launches",
					});
				}
				for (const runId of strs(f.runIds)) {
					const run = await this.deps.registry.get(runId);
					if (run && LIVE.includes(run.state)) {
						steps.push({
							op: "stop_run",
							runId,
							summary: `stop run ${runId}`,
						});
					}
				}
				if (steps.length === 0) {
					return gone("the spawned runs have already ended");
				}
				break;
			}
			case "stop": {
				const runId = String(a.runId ?? "");
				const run = runId ? await this.deps.registry.get(runId) : null;
				if (!run?.taskId) {
					return gone(`run ${runId} is not a task run that can be continued`);
				}
				steps.push({
					op: "continue_run",
					runId,
					taskId: run.taskId,
					summary: `continue ${run.taskId} in run ${runId}'s worktree`,
				});
				break;
			}
			case "pause": {
				const ids = strs(f.taskIds);
				if (ids.length === 0) return gone("no paused task was recorded");
				steps.push({
					op: "release_holds",
					taskIds: ids,
					summary: `release the hold on ${ids.join(", ")}`,
				});
				break;
			}
			case "resume": {
				const ids = strs(f.taskIds);
				if (ids.length === 0) return gone("no resumed task was recorded");
				steps.push({
					op: "hold_tasks",
					taskIds: ids,
					summary: `hold ${ids.join(", ")} again`,
				});
				break;
			}
			default:
				return gone(`${d.action ?? "this call"} has no inverse operation`);
		}
		return {
			...base,
			state: "ready",
			summary: steps.map((s) => s.summary).join("; "),
			steps,
		};
	}

	/** Apply the inverse and record the override. Idempotent on an override already recorded. */
	async override(
		decisionId: number,
		reason: string,
	): Promise<{
		decisionId: number;
		preview: OverridePreview;
		applied: string[];
	}> {
		const why = reason.trim();
		if (!why) {
			throw new OverrideError(
				"reason_required",
				"a reason is required to override a decision",
			);
		}
		const d = await this.load(decisionId);
		if (d.overriddenBy != null) {
			throw new OverrideError(
				"already_overridden",
				`decision #${decisionId} was already overridden by #${d.overriddenBy}`,
			);
		}
		const preview = await this.inverseOf(d);
		if (preview.state === "not_applicable") {
			throw new OverrideError("not_overridable", preview.summary);
		}

		// The override row is minted first so the effects can name it
		// (`human:override-<n>`, `spawned_by_decision_id`); `overridden_by` and
		// the event land in one transaction after the effects held.
		const nowMs = this.now();
		const overrideId = await recordHumanAction(
			this.deps,
			{
				action: "override",
				taskId: d.taskId,
				runId: d.subjectRunId,
				reason: why,
				input: {
					overriddenDecisionId: d.id,
					tool: d.action,
					inverse: preview.summary,
					steps: preview.steps.map((s) => s.summary),
				},
				kind: "override",
				output: { status: "applying" },
			},
			() => nowMs,
		);
		if (overrideId === null) {
			throw new OverrideError(
				"step_failed",
				"the override could not be recorded",
			);
		}

		const applied: string[] = [];
		try {
			for (const step of preview.steps) {
				await this.applyStep(step, overrideId, why);
				applied.push(step.summary);
			}
		} catch (e) {
			const error = e instanceof Error ? e.message : String(e);
			await finishHumanOverride(this.deps.handle, overrideId, {
				ok: false,
				error,
			});
			this.deps.log.warn({ err: e, decisionId, overrideId }, "override failed");
			throw new OverrideError(
				"step_failed",
				`${error}${applied.length ? ` (already applied: ${applied.join("; ")})` : ""}`,
			);
		}

		const events: StoredEvent[] = [];
		await this.deps.handle.withTx(async (tx) => {
			await tx
				.update(decisions)
				.set({
					status: "ok",
					output: { status: "applied", result: { applied } },
					finishedAt: new Date(this.now()),
				})
				.where(eq(decisions.id, overrideId));
			await tx
				.update(decisions)
				.set({ overriddenBy: overrideId })
				.where(eq(decisions.id, d.id));
			events.push(
				await appendEvent(
					tx,
					{
						type: "human.override",
						...(d.taskId ? { taskId: d.taskId } : {}),
						...(d.subjectRunId ? { runId: d.subjectRunId } : {}),
						payload: {
							decisionId: overrideId,
							overriddenDecisionId: d.id,
							reason: why.slice(0, 500),
							...(d.action ? { tool: d.action } : {}),
							inverse: preview.summary.slice(0, 300),
						},
					},
					this.now(),
				),
			);
		});
		this.deps.bus.publish(events);
		return { decisionId: overrideId, preview, applied };
	}

	private async applyStep(
		step: InverseStep,
		overrideId: number,
		reason: string,
	): Promise<void> {
		const { tasks, engine, registry } = this.deps;
		switch (step.op) {
			case "set_status": {
				const cur = await tasks.get(step.taskId);
				if (!cur) throw new Error(`unknown task ${step.taskId}`);
				if (cur.status === step.to) return; // replay, or already there
				await tasks.move(
					step.taskId,
					step.to as never,
					"human",
					`override #${overrideId}: ${reason}`,
				);
				return;
			}
			case "reparent": {
				await tasks.reparentByHuman(step.taskId, step.parent, {
					decisionId: overrideId,
				});
				return;
			}
			case "cancel_spawn": {
				await this.deps.executor.cancelPending(
					step.actionId,
					`overridden by decision #${overrideId}: ${reason}`,
				);
				return;
			}
			case "stop_run": {
				const run = await registry.get(step.runId);
				if (!run || !LIVE.includes(run.state)) return;
				await engine.stop(step.runId);
				this.deps.wakeScheduler?.();
				return;
			}
			case "continue_run": {
				const live = (await registry.list({ taskId: step.taskId })).find((r) =>
					LIVE.includes(r.state),
				);
				if (live) {
					if (live.id === step.runId) {
						throw new Error(
							`run ${step.runId} is still live; wait for it to end, then override`,
						);
					}
					return; // something already continues the task: replay
				}
				const task = await tasks.get(step.taskId);
				if (!task) throw new Error(`unknown task ${step.taskId}`);
				if (task.status !== "ready" && task.status !== "in_progress") {
					await tasks.move(
						step.taskId,
						"ready",
						"human",
						`override #${overrideId}: continue`,
					);
				}
				const runId = ulid();
				await engine.startGroupRun({
					runId,
					taskId: step.taskId,
					groupId: runId,
					groupKind: "single",
					role: "implement",
					actionId: `override-${overrideId}`,
					decisionId: overrideId,
					originRef: `human:override-${overrideId}`,
					worktree: { mode: "continue", runId: step.runId },
				});
				return;
			}
			case "release_holds": {
				await this.deps.executor.releaseHolds(step.taskIds);
				this.deps.wakeScheduler?.();
				return;
			}
			case "hold_tasks": {
				await this.deps.executor.addHolds(
					step.taskIds,
					`held again by override #${overrideId}`,
					`override-${overrideId}`,
				);
				return;
			}
		}
	}

	/** Write to the brain. `about` is a node ref (`task:T-1`, `run:<id>`, `decision:<n>`). */
	async message(input: {
		text: string;
		about?: string;
	}): Promise<{ decisionId: number; about: string | null }> {
		const text = input.text.trim();
		if (!text) throw new Error("a message to the brain needs text");
		if (text.length > MAX_TEXT) {
			throw new Error(`message too long (max ${MAX_TEXT} characters)`);
		}
		let taskId: string | null = null;
		let runId: string | null = null;
		const about = input.about?.trim() || null;
		if (about) {
			const m = /^(task|run|decision):(.+)$/.exec(about);
			if (!m) {
				throw new Error(
					`about must be task:<id>, run:<id> or decision:<n>, got '${about}'`,
				);
			}
			const [, kind, id] = m as unknown as [string, string, string];
			if (kind === "task") taskId = id;
			else if (kind === "run") {
				runId = id;
				taskId = (await this.deps.registry.get(id))?.taskId ?? null;
			} else {
				const n = Number(id);
				if (!Number.isInteger(n))
					throw new Error(`bad decision ref '${about}'`);
				const d = await this.load(n);
				taskId = d.taskId;
				runId = d.subjectRunId;
			}
		}
		const [session] = await this.deps.handle.db
			.select({ id: brainSessions.id })
			.from(brainSessions)
			.orderBy(desc(brainSessions.createdAt))
			.limit(1);
		const nowMs = this.now();
		const events: StoredEvent[] = [];
		let decisionId = 0;
		decisionId =
			(await recordHumanAction(
				this.deps,
				{
					action: "brain.message",
					taskId,
					runId,
					reason: text,
					input: { ...(about ? { about } : {}) },
				},
				() => nowMs,
			)) ?? 0;
		if (!decisionId) throw new Error("the message could not be recorded");
		await this.deps.handle.withTx(async (tx) => {
			events.push(
				await appendEvent(
					tx,
					{
						type: "human.brain_message",
						...(taskId ? { taskId } : {}),
						...(runId ? { runId } : {}),
						payload: {
							...(session ? { sessionId: session.id } : {}),
							text,
							...(about ? { about } : {}),
							decisionId,
						},
					},
					nowMs,
				),
			);
		});
		this.deps.bus.publish(events);
		return { decisionId, about };
	}
}
