import type { ProjectDbHandle } from "@mfw/db/client";
import { appendEvent, type EventBus } from "@mfw/db/eventlog";
import { ulid } from "@mfw/db/ids";
import {
	decisions,
	type SessionResolution,
	type SessionSource,
	sessions,
} from "@mfw/db/schema";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Logger } from "./log.ts";
import type { RunRegistry, StepRow } from "./run-registry.ts";
import type { TaskService } from "./task-service.ts";

/**
 * MFW-59: when mfw cannot proceed, `raise()` composes what the daemon already
 * knows (the check's real output, what was tried, the environment, the
 * worktree) into one brief and stores it. It is called when recovery is
 * exhausted: `MergeQueue.park()`, `Maintenance.regressionSweep()`'s
 * escalation, `StepRunner.releaseTask()`'s `to: "blocked"`. It costs only a
 * row; no run starts until a human calls `open()`. Closing a session must
 * `resolve()` something, never just hide it.
 */

export interface Session {
	id: string;
	source: SessionSource;
	sourceKey: string;
	taskId: string | null;
	runId: string | null;
	mergeJobId: number | null;
	title: string;
	context: string;
	createdAt: Date;
	openedRunId: string | null;
	openedAt: Date | null;
	resolvedAt: Date | null;
	resolution: SessionResolution | null;
	resolutionReason: string | null;
}

export interface RaiseInput {
	source: SessionSource;
	/** Dedup key within `source`; see `sessions.sourceKey` in schema.ts. */
	sourceKey: string;
	taskId?: string | null;
	/** A run whose worktree is worth reusing when this session opens. Absent
	 *  for `main_red`, which is not tied to one run. */
	runId?: string | null;
	mergeJobId?: number | null;
	title: string;
	/** What happened, in the escalation site's own words (`park()`'s reason,
	 *  the finalize machine's T18/T24 note, the sweep's regression detail). */
	summary: string;
	/** Bullets: what mfw already tried before giving up. */
	whatWasTried: string[];
	/** How this ran differently from a human's shell (ephemeral worktree,
	 *  hard-linked dependency snapshot, sandbox). */
	environment: string;
	/** mfw's own belief about the cause, phrased as a hypothesis. */
	hypothesis?: string;
}

export interface SessionServiceDeps {
	handle: ProjectDbHandle;
	bus: EventBus;
	log: Logger;
	project: string;
	tasks: TaskService;
	registry: RunRegistry;
}

export class SessionService {
	/**
	 * Late-bound to `RunEngine.startSession` (boot.ts): `RunEngine` is built
	 * after `MergeQueue`/`Maintenance`, which need `sessions` first (as with
	 * `MergeQueue.unblock` and `StepRunner.spawnRepair`). Absent, `open()`
	 * throws rather than silently doing nothing.
	 */
	startSession?: (
		prompt: string,
		opts: {
			reuse?: { worktreePath: string; branch: string; baseSha?: string };
		},
	) => Promise<{ runId: string }>;

	/** Late-bound to `InboxService.dismiss` (boot.ts), since `InboxService` is
	 *  built after this service. Absent leaves a dismissed session's inbox row
	 *  to the inbox's own clear rules. */
	dismissInboxItem?: (itemId: string) => Promise<void>;

	constructor(private readonly deps: SessionServiceDeps) {}

	/**
	 * Compose and store the brief. A no-op while an unresolved session already
	 * exists for this `(source, sourceKey)`, so repeated sweeps do not spam.
	 */
	async raise(input: RaiseInput): Promise<{ id: string } | null> {
		if (await this.findOpen(input.source, input.sourceKey)) return null;
		const context = await this.compose(input);
		const id = ulid();
		await this.deps.handle.db.insert(sessions).values({
			id,
			source: input.source,
			sourceKey: input.sourceKey,
			taskId: input.taskId ?? null,
			runId: input.runId ?? null,
			mergeJobId: input.mergeJobId ?? null,
			title: input.title,
			context,
			createdAt: new Date(),
		});
		await this.publish({
			type: "session.raised",
			taskId: input.taskId ?? undefined,
			runId: input.runId ?? undefined,
			payload: { sessionId: id, source: input.source },
		});
		this.deps.log.warn(
			{ sessionId: id, source: input.source, taskId: input.taskId },
			"raised an escalation session: recovery is exhausted, a human is needed",
		);
		return { id };
	}

	async list(opts: { open?: boolean } = {}): Promise<Session[]> {
		const base = this.deps.handle.db.select().from(sessions);
		const rows = await (opts.open
			? base.where(isNull(sessions.resolvedAt))
			: base
		).orderBy(desc(sessions.createdAt));
		return rows;
	}

	async get(id: string): Promise<Session | null> {
		const [row] = await this.deps.handle.db
			.select()
			.from(sessions)
			.where(eq(sessions.id, id));
		return row ?? null;
	}

	/**
	 * Start the run: a steerable agent session seeded with the composed brief,
	 * reusing the relevant worktree when there is one. Idempotent: an
	 * already-opened session returns its existing run.
	 */
	async open(id: string): Promise<{ runId: string }> {
		const session = await this.get(id);
		if (!session) throw new NotFoundError(`unknown session ${id}`);
		if (session.openedRunId) return { runId: session.openedRunId };
		if (!this.startSession) {
			throw new Error("sessions cannot be opened: no run engine wired");
		}
		let reuse:
			| { worktreePath: string; branch: string; baseSha?: string }
			| undefined;
		if (session.runId) {
			const run = await this.deps.registry.get(session.runId);
			if (run?.worktreePath && run.branch) {
				reuse = {
					worktreePath: run.worktreePath,
					branch: run.branch,
					baseSha: run.baseSha ?? undefined,
				};
			}
		}
		const { runId } = await this.startSession(session.context, { reuse });
		await this.deps.handle.db
			.update(sessions)
			.set({ openedRunId: runId, openedAt: new Date() })
			.where(eq(sessions.id, id));
		await this.publish({
			type: "session.opened",
			taskId: session.taskId ?? undefined,
			runId,
			payload: { sessionId: id },
		});
		return { runId };
	}

	/**
	 * Close the session with a disposition. `"dismissed"` requires a reason and
	 * also clears the inbox row this session was raised for, since nothing else
	 * would. `"fixed"` and `"retried"` need no reason: the underlying inbox row
	 * clears itself once the operator's action takes effect.
	 */
	async resolve(
		id: string,
		resolution: SessionResolution,
		reason?: string,
	): Promise<void> {
		const session = await this.get(id);
		if (!session) throw new NotFoundError(`unknown session ${id}`);
		if (session.resolvedAt) return;
		const trimmed = reason?.trim() || undefined;
		if (resolution === "dismissed" && !trimmed) {
			throw new Error("dismissing a session needs a reason");
		}
		await this.deps.handle.db
			.update(sessions)
			.set({
				resolvedAt: new Date(),
				resolution,
				resolutionReason: trimmed ?? null,
			})
			.where(eq(sessions.id, id));
		await this.publish({
			type: "session.resolved",
			taskId: session.taskId ?? undefined,
			payload: { sessionId: id, resolution, reason: trimmed },
		});
		if (resolution === "dismissed") {
			await this.dismissInboxItem?.(this.itemId(session)).catch((e) => {
				this.deps.log.warn(
					{ err: e, sessionId: id },
					"session dismissed but its inbox item could not be cleared",
				);
			});
		}
	}

	/** The `InboxService` id this session's source item is keyed under
	 *  (inbox.ts's `collect()`); keep in sync by hand.
	 *
	 *  `main_red` is scoped to `taskId` (the cause), not just the project: such
	 *  a session only resolves via a human, so an old one can be open when a new
	 *  regression raises its own, and a project-wide id would let dismissing the
	 *  stale one swallow the current incident's inbox row. `causeTaskId` can be
	 *  absent (see `unambiguousCauseTask`), hence the "unattributed" placeholder. */
	private itemId(session: Session): string {
		switch (session.source) {
			case "main_red":
				return `main_red:${this.deps.project}:${session.taskId ?? "unattributed"}`;
			case "merge_parked":
				return `merge_parked:${session.mergeJobId}`;
			case "blocked":
				return `blocked:${session.taskId}`;
		}
	}

	private async findOpen(
		source: SessionSource,
		sourceKey: string,
	): Promise<{ id: string } | null> {
		const [row] = await this.deps.handle.db
			.select({ id: sessions.id })
			.from(sessions)
			.where(
				and(
					eq(sessions.source, source),
					eq(sessions.sourceKey, sourceKey),
					isNull(sessions.resolvedAt),
				),
			)
			.limit(1);
		return row ?? null;
	}

	/** Assemble everything mfw already knows into one brief. */
	private async compose(input: RaiseInput): Promise<string> {
		const lines: string[] = [`# ${input.title}`, "", input.summary];

		if (input.taskId) {
			const task = await this.deps.tasks.get(input.taskId);
			if (task) {
				const criteria = task.criteria
					.map((c) => `- [${c.checked ? "x" : " "}] ${c.text}`)
					.join("\n");
				lines.push(
					"",
					`## Task: ${task.id}`,
					task.title,
					"",
					task.body,
					...(criteria ? [criteria] : []),
				);
			}
		}

		if (input.runId) {
			const run = await this.deps.registry.get(input.runId);
			if (run) {
				lines.push(
					"",
					"## Where this ran",
					`- run: ${run.id} (${run.kind}, attempt ${run.attempt})`,
					`- worktree: ${run.worktreePath ?? "(none, no worktree to reuse)"}`,
					...(run.branch ? [`- branch: ${run.branch}`] : []),
					...(run.exitCode !== null ? [`- exit code: ${run.exitCode}`] : []),
					...(run.killReason ? [`- killed: ${run.killReason}`] : []),
				);
				const tail = renderVerifyTail(
					(await this.deps.registry.steps(run.id)).find(
						(s) => s.step === "verify",
					),
				);
				if (tail) lines.push("", "## Last check output (tail, not head)", tail);
			}
		}

		if (input.mergeJobId != null) {
			lines.push("", `## Merge job #${input.mergeJobId}`);
		}

		if (input.whatWasTried.length > 0) {
			lines.push(
				"",
				"## What mfw already tried",
				...input.whatWasTried.map((s) => `- ${s}`),
			);
		}

		if (input.taskId) {
			const trace = await this.recentDecisions(input.taskId);
			if (trace) lines.push("", "## The brain's recent involvement", trace);
		}

		lines.push("", "## Environment", input.environment);

		if (input.hypothesis) {
			lines.push(
				"",
				"## mfw's hypothesis (a guess, not a verdict)",
				input.hypothesis,
			);
		}

		lines.push(
			"",
			"## You",
			"This is a steerable session with this project's own tools. Ask it " +
				"questions, or tell it what to do: inspect the worktree above, " +
				"reproduce the failure, fix it, or decide it is not worth fixing. " +
				"It cannot act on its own; everything it does is at your request. " +
				"When you are done, resolve this session (fixed, retried, or " +
				"dismissed with a reason); closing it without one leaves the " +
				"underlying item as stuck as it is now.",
		);

		return lines.join("\n");
	}

	/** The brain's last few calls about this task, if any. */
	private async recentDecisions(taskId: string): Promise<string | null> {
		const rows = await this.deps.handle.db
			.select()
			.from(decisions)
			.where(eq(decisions.taskId, taskId))
			.orderBy(desc(decisions.ts))
			.limit(3);
		if (rows.length === 0) return null;
		return rows
			.map(
				(d) =>
					`- ${d.role} → ${d.status}${d.action ? ` (${d.action})` : ""}${
						d.reason ? `: ${d.reason}` : ""
					}`,
			)
			.join("\n");
	}

	private async publish(
		event: Parameters<typeof appendEvent>[1],
	): Promise<void> {
		try {
			const rows = await this.deps.handle.withTx(async (tx) => [
				await appendEvent(tx, event),
			]);
			this.deps.bus.publish(rows);
		} catch (e) {
			this.deps.log.warn({ err: e }, "could not record session event");
		}
	}
}

/** Render the failing checks of a journaled `verify` step. `detail` (from
 *  `verifier.ts`) is already the tail of the output, not the head. */
function renderVerifyTail(step: StepRow | undefined): string | null {
	const result = step?.result as
		| {
				checks?: {
					check: string;
					ok: boolean;
					classification?: string;
					detail?: string;
				}[];
		  }
		| undefined;
	const failing = (result?.checks ?? []).filter((c) => c && c.ok === false);
	if (failing.length === 0) return null;
	return failing
		.map(
			(c) =>
				`- [${c.classification ?? "failed"}] ${c.check}\n${
					(c.detail ?? "").trim() || "(no output captured)"
				}`,
		)
		.join("\n\n");
}

/** Named so `trpc.ts`'s error map turns it into NOT_FOUND, not a 500. */
export class NotFoundError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NotFoundError";
	}
}
