import type { ProjectDbHandle } from "@mfw/db/client";
import type { EventBus } from "@mfw/db/eventlog";
import { ulid } from "@mfw/db/ids";
import { finishHumanOverride, recordHumanOverride } from "./human-override.ts";
import type { RouteInput } from "./routing.ts";
import type { GroupRunSpec, RunEngine } from "./run-engine.ts";
import type { RunRegistry } from "./run-registry.ts";
import { CLAIM_HOLDING_RUN_STATES } from "./run-registry.ts";

/**
 * Reroute (U4-04): a person moves a run's work to another harness, model or
 * host. Stop the run (its worktree is kept: an interrupted run's work is never
 * deleted), wait for it to settle, then spawn `continue:<runId>` through the
 * same `startGroupRun` path the brain's `spawn` uses, with the human's pick
 * ranked above a task pin. Recorded as one `role: human` decision that
 * reverses the run's spawning decision, which wakes the brain.
 */

export type RerouteCode =
	| "run_not_found"
	| "no_worktree"
	| "not_a_task_run"
	| "nothing_to_change"
	| "not_settled"
	| "group_closed";

export class RerouteError extends Error {
	/** The remedy in the shape the API surfaces as `data.fix`. */
	readonly fix?: { kind: "ui"; text: string };
	constructor(
		readonly code: RerouteCode,
		message: string,
		fix?: string,
	) {
		super(message);
		this.name = "RerouteError";
		if (fix) this.fix = { kind: "ui", text: fix };
	}
}

export interface RerouteInput {
	runId: string;
	harness?: string;
	model?: string;
	effort?: NonNullable<RouteInput["brain"]>["effort"];
	/** `execution_target` syntax: `local`, `ssh:<host>`, `runpod`. */
	target?: string;
	/**
	 * Resume rather than move: continue on the run's own harness and model.
	 * Allows a request that changes nothing.
	 */
	keepRoute?: boolean;
	/** What the new run is told about why it is continuing. */
	brief?: string;
	/** Why the person did this; recorded on the decision. */
	reason?: string;
}

export interface RerouteDeps {
	handle: ProjectDbHandle;
	bus: EventBus;
	registry: Pick<RunRegistry, "get" | "getGroup">;
	engine: Pick<RunEngine, "stop" | "startGroupRun">;
	/** Ask the supervisor to finalize the stopped run promptly. */
	wake?: () => void;
	/** How long to wait for the stopped run to settle. Default 60s. */
	settleMs?: number;
	/** Poll interval while waiting. Default 100ms. */
	pollMs?: number;
}

export interface RerouteResult {
	stoppedRunId: string;
	runId: string;
	groupId: string;
	decisionId: number;
}

export async function rerouteRun(
	deps: RerouteDeps,
	input: RerouteInput,
): Promise<RerouteResult> {
	const run = await deps.registry.get(input.runId);
	if (!run) throw new RerouteError("run_not_found", `no run '${input.runId}'`);
	if (run.kind !== "task" || !run.taskId) {
		throw new RerouteError(
			"not_a_task_run",
			`${run.id} is not a task run`,
			"Only a task's worker run can be rerouted.",
		);
	}
	if (!run.worktreePath || !run.branch) {
		throw new RerouteError(
			"no_worktree",
			`${run.id} has no worktree to continue`,
			"Start the task again from the board instead.",
		);
	}
	if (
		!input.keepRoute &&
		!input.harness &&
		!input.model &&
		!input.effort &&
		!input.target
	) {
		throw new RerouteError(
			"nothing_to_change",
			"a reroute needs another harness, model, effort or host",
			"Pick at least one thing to change.",
		);
	}

	const live = (id: string) =>
		deps.registry
			.get(id)
			.then((r) => !!r && CLAIM_HOLDING_RUN_STATES.includes(r.state));

	// The group the new run joins: an open competing group keeps its member
	// count (the rerouted attempt replaces the stopped one); anything else
	// is a new group of one.
	const group = run.groupId ? await deps.registry.getGroup(run.groupId) : null;
	if (group && group.kind === "competing" && group.status !== "open") {
		throw new RerouteError(
			"group_closed",
			`group ${group.id} is ${group.status}`,
			"A decided group takes no more attempts.",
		);
	}
	const joining = group?.kind === "competing" ? group : null;

	// 1. stop, keeping the worktree.
	if (await live(run.id)) {
		await deps.engine.stop(run.id);
		deps.wake?.();
		const deadline = Date.now() + (deps.settleMs ?? 60_000);
		while (await live(run.id)) {
			if (Date.now() > deadline) {
				throw new RerouteError(
					"not_settled",
					`${run.id} was stopped but has not settled yet`,
					"Try Reroute again in a moment; the worktree is kept.",
				);
			}
			await Bun.sleep(deps.pollMs ?? 100);
		}
	}

	// 2. the decision, before the effect, so the new run names it.
	const newRunId = ulid();
	const groupId = joining?.id ?? newRunId;
	const keepProvider = input.keepRoute ? (run.harness ?? run.providerId) : null;
	const pick: NonNullable<GroupRunSpec["pick"]> = {
		...(input.harness
			? { provider: input.harness }
			: keepProvider
				? { provider: keepProvider }
				: {}),
		...(input.model
			? { model: input.model }
			: input.keepRoute
				? { model: run.model }
				: {}),
		...(input.effort ? { effort: input.effort } : {}),
		// A person's pick ranks above the task's own pin and the brain's routes.
		overrideHumanPin: true,
	};
	const reason =
		input.reason?.trim() ||
		(input.keepRoute
			? `resumed ${run.id} on its own route`
			: `rerouted ${run.id} from ${run.harness ?? run.providerId ?? "?"}:${run.model}`);
	const decisionId = await recordHumanOverride(deps, {
		action: input.keepRoute ? "resume" : "reroute",
		taskId: run.taskId,
		subjectRunId: run.id,
		reason,
		input: {
			runId: run.id,
			harness: input.harness ?? null,
			model: input.model ?? null,
			effort: input.effort ?? null,
			target: input.target ?? null,
			continues: run.id,
		},
		accepted: { runId: newRunId, groupId },
		overriddenDecisionId: run.spawnedByDecisionId,
	});

	// 3. spawn continue:<runId> through the brain's own launch path.
	const spec: GroupRunSpec = {
		runId: newRunId,
		taskId: run.taskId,
		groupId,
		groupKind: joining ? "competing" : "single",
		selection: joining?.selection ?? "brain",
		role: joining ? "attempt" : "implement",
		decisionId,
		originRef: "human:ui",
		brief:
			input.brief?.trim() ||
			`A person moved this work from ${run.harness ?? run.providerId ?? "another harness"}:${run.model} to a new route. Continue in the existing worktree; do not start over.`,
		pick,
		...(input.target ? { target: input.target } : {}),
		worktree: { mode: "continue", runId: run.id },
	};
	try {
		await deps.engine.startGroupRun(spec);
	} catch (e) {
		await finishHumanOverride(deps.handle, decisionId, {
			ok: false,
			error: e instanceof Error ? e.message : String(e),
		});
		throw e;
	}
	await finishHumanOverride(deps.handle, decisionId, {
		ok: true,
		result: { runId: newRunId, groupId, stopped: run.id },
	});
	return { stoppedRunId: run.id, runId: newRunId, groupId, decisionId };
}
