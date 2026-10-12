import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MfwEvent } from "@mfw/core/events";
import { openProjectDb } from "@mfw/db/client";
import { appendEvent, EventBus } from "@mfw/db/eventlog";
import { brainSessions, brainTurns, mergeJobs } from "@mfw/db/schema";
import { desc } from "drizzle-orm";
import type { ExecutorCrashPoint } from "../../src/brain-runtime/executor.ts";
import {
	type BrainConfig,
	type BrainLauncher,
	BrainRuntime,
	resolveBrainConfig,
} from "../../src/brain-runtime/runtime.ts";
import {
	BRAIN_TURN_LABEL,
	type BrainTurnLaunch,
} from "../../src/brain-runtime/turn-run.ts";
import { silentLogger } from "../../src/log.ts";
import type { RoutingDecision } from "../../src/routing.ts";
import type { GroupRunSpec } from "../../src/run-engine.ts";
import { RunRegistry, type RunRow } from "../../src/run-registry.ts";
import { makeTasks } from "../fixtures/board.ts";

/**
 * The brain runtime over a real DB, registry and board, with a fake launcher
 * and a controllable clock: wake timing and turn bookkeeping without tmux.
 */

export interface Launched {
	runId: string;
	prompt: string;
	launch: BrainTurnLaunch;
	scratchDir: string;
}

export async function brainUnit(
	opts: {
		config?: Partial<BrainConfig> | null;
		hostname?: string;
		maxConcurrent?: number;
		/** A board.yaml to start from instead of the default (hierarchy, custom statuses). */
		boardYaml?: string;
		taskKey?: string;
		/** Mutable: set `.reason` to a string to stop dispatch, null to resume. */
		dispatchBlock?: { reason: string | null };
	} = {},
) {
	const root = await mkdtemp(join(tmpdir(), "mfw-test-brain-unit-"));
	const mfwDir = join(root, ".mfw");
	const handle = await openProjectDb(mfwDir);
	const bus = new EventBus();
	const registry = new RunRegistry({
		handle,
		bus,
		runsDir: join(mfwDir, "runs"),
	});
	if (opts.boardYaml) {
		await mkdir(mfwDir, { recursive: true });
		await writeFile(join(mfwDir, "board.yaml"), opts.boardYaml);
	}
	const tasks = await makeTasks(handle, bus, mfwDir, opts.taskKey ?? "MFW");
	const clock = { t: 1_800_000_000_000 };
	const launched: Launched[] = [];
	const state = { held: null as RoutingDecision["held"], startFails: false };
	const baseConfig = resolveBrainConfig({
		routes: [{ provider: "claude-cli", model: "sonnet" }],
	}) as BrainConfig;
	const config: BrainConfig | null =
		opts.config === null ? null : { ...baseConfig, ...opts.config };

	const engine: BrainLauncher = {
		async routeBrain(target) {
			const route = {
				provider: target.provider,
				model: target.model ?? "sonnet",
				effort: target.effort ?? "medium",
				endpoint: null,
				candidates: [],
				held: state.held,
			} as unknown as RoutingDecision;
			return {
				route,
				held: state.held,
			};
		},
		async startBrainTurn(o) {
			if (state.startFails) throw new Error("launch refused");
			await registry.create({
				id: o.runId,
				kind: "brain",
				label: BRAIN_TURN_LABEL,
				model: o.route.model,
				providerId: o.route.provider,
				cwd: o.scratchDir,
				worktreePath: o.scratchDir,
				branch: "mfw-brain",
				baseSha: "0".repeat(40),
			});
			await registry.transition(o.runId, "running", { from: "starting" });
			launched.push({
				runId: o.runId,
				prompt: o.prompt,
				launch: o.launch,
				scratchDir: o.scratchDir,
			});
			return { runId: o.runId };
		},
	};

	/** What the executor asked of the engine and the merge queue, in order. */
	const effects: { tool: string; args: unknown[] }[] = [];
	/** Crash seams and failures the tests arm. */
	const hooks: {
		crashAt?: (point: ExecutorCrashPoint) => void;
		failLaunch?: string;
	} = {};
	const groupEngine = {
		async startGroupRun(spec: GroupRunSpec) {
			effects.push({ tool: "startGroupRun", args: [spec] });
			if (hooks.failLaunch) throw new Error(hooks.failLaunch);
			const existing = await registry.get(spec.runId);
			if (existing && existing.state !== "starting") {
				return { runId: existing.id };
			}
			const task = await tasks.get(spec.taskId);
			if (task?.claimedByGroupId !== spec.groupId) {
				const ok = await tasks.tryClaim(
					spec.taskId,
					spec.groupId,
					60_000,
					"scheduler",
					"ready",
					spec.groupId === spec.runId ? undefined : { leadRunId: spec.runId },
				);
				if (!ok) throw new Error(`task ${spec.taskId} is not claimable`);
			}
			await registry.ensureGroup({
				id: spec.groupId,
				taskId: spec.taskId,
				kind: spec.groupKind,
				selection: spec.selection ?? "brain",
				createdByAction: spec.actionId,
			});
			await registry.create({
				id: spec.runId,
				kind: "task",
				taskId: spec.taskId,
				label: `${spec.taskId}#${spec.role}`,
				model: spec.pick?.model ?? "sonnet",
				providerId: spec.pick?.provider ?? "claude-cli",
				harness: spec.pick?.provider ?? "claude-cli",
				cwd: root,
				groupId: spec.groupId,
				role: spec.role,
				originRef: `brain:${spec.actionId}`,
			});
			await registry.transition(spec.runId, "running", { from: "starting" });
			return { runId: spec.runId };
		},
		async startPlan(
			goal: string,
			o: { runId: string; taskId?: string; model?: string; originRef?: string },
		) {
			effects.push({ tool: "startPlan", args: [goal, o] });
			if (hooks.failLaunch) throw new Error(hooks.failLaunch);
			const existing = await registry.get(o.runId);
			if (existing && existing.state !== "starting") {
				return { runId: existing.id };
			}
			await registry.create({
				id: o.runId,
				kind: "plan",
				...(o.taskId ? { taskId: o.taskId } : {}),
				label: o.taskId ? "plan#expand" : "plan",
				model: o.model ?? "sonnet",
				providerId: "claude-cli",
				harness: "claude-cli",
				cwd: root,
				...(o.originRef ? { originRef: o.originRef } : {}),
			});
			await registry.transition(o.runId, "running", { from: "starting" });
			return { runId: o.runId };
		},
		async startImport(o: {
			runId: string;
			model?: string;
			originRef?: string;
		}) {
			effects.push({ tool: "startImport", args: [o] });
			if (hooks.failLaunch) throw new Error(hooks.failLaunch);
			const existing = await registry.get(o.runId);
			if (existing && existing.state !== "starting") {
				return { runId: existing.id };
			}
			await registry.create({
				id: o.runId,
				kind: "import",
				label: "import",
				model: o.model ?? "sonnet",
				providerId: "claude-cli",
				harness: "claude-cli",
				cwd: root,
				...(o.originRef ? { originRef: o.originRef } : {}),
			});
			await registry.transition(o.runId, "running", { from: "starting" });
			return { runId: o.runId };
		},
		async stop(runId: string) {
			effects.push({ tool: "stop", args: [runId] });
		},
		async steer(runId: string, message: string) {
			effects.push({ tool: "steer", args: [runId, message] });
		},
	};

	const runtime = new BrainRuntime({
		handle,
		bus,
		registry,
		tasks,
		engine,
		exec: {
			projectRoot: root,
			integrationBranch: "main",
			engine: groupEngine,
			mergeQueue: {
				async enqueue(job) {
					effects.push({ tool: "enqueue", args: [job] });
					await handle.db.insert(mergeJobs).values({
						runId: job.runId,
						taskId: job.taskId ?? null,
						branch: job.branch,
						targetBranch: job.targetBranch,
						enqueuedAt: new Date(),
						updatedAt: new Date(),
					});
				},
			},
			crashAt: (point) => hooks.crashAt?.(point),
			review: async ({ runId }) => {
				effects.push({ tool: "review", args: [runId] });
				return { status: "ok", verdict: "merge" };
			},
			notifyHuman: async (input) => {
				effects.push({ tool: "notify_human", args: [input] });
			},
			answerQuestion: async (runId, answer) => {
				effects.push({ tool: "answer_question", args: [runId, answer] });
			},
		},
		log: silentLogger(),
		mfwDir,
		projectName: "unit",
		bootId: "boot-1",
		config: () => config,
		world: {
			maxConcurrent: () => opts.maxConcurrent ?? 2,
			...(opts.dispatchBlock
				? {
						dispatchPaused: async () =>
							opts.dispatchBlock?.reason
								? { reason: opts.dispatchBlock.reason }
								: null,
					}
				: {}),
		},
		hostname: opts.hostname ?? "host-a",
		now: () => clock.t,
		mcp: { url: "http://127.0.0.1:1/trpc", script: "/nonexistent/mcp.ts" },
	});

	const api = {
		root,
		mfwDir,
		handle,
		bus,
		registry,
		tasks,
		runtime,
		clock,
		launched,
		state,
		effects,
		hooks,
		/** Append an event stamped with the test clock. */
		async emit(event: MfwEvent): Promise<number> {
			const [e] = await handle.withTx(async (tx) => [
				await appendEvent(tx, event, clock.t),
			]);
			return e?.seq ?? 0;
		},
		async human(text = "hi") {
			return api.emit({ type: "human.brain_message", payload: { text } });
		},
		async taskCreated(taskId: string) {
			return api.emit({
				type: "task.created",
				taskId,
				payload: { source: "human", title: taskId },
			});
		},
		/** End a launched turn's run the way finalize would. */
		async endRun(
			runId: string,
			how: {
				state?: RunRow["state"];
				exitCode?: number;
				usage?: Record<string, number>;
				killReason?: RunRow["killReason"];
			} = {},
		) {
			await registry.transition(runId, how.state ?? "completed", {
				exitCode: how.exitCode ?? 0,
				outcome: "completed",
				...(how.killReason ? { killReason: how.killReason } : {}),
				...(how.usage ? { usage: how.usage } : {}),
				finishedAt: new Date(clock.t),
			});
		},
		advance(ms: number) {
			clock.t += ms;
		},
		async session() {
			const [s] = await handle.db.select().from(brainSessions);
			return s;
		},
		async turns() {
			return handle.db.select().from(brainTurns).orderBy(desc(brainTurns.seq));
		},
		async cleanup() {
			handle.close();
			await rm(root, { recursive: true, force: true });
		},
	};
	return api;
}

export type BrainUnit = Awaited<ReturnType<typeof brainUnit>>;
