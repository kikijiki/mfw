import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectDb } from "@mfw/db/client";
import { EventBus, type StoredEvent } from "@mfw/db/eventlog";
import { ulid } from "@mfw/db/ids";
import { AgentHost } from "../src/agent-host.ts";
import {
	AdapterRegistry,
	claudeAdapter,
	type ProviderConfig,
} from "../src/agents/adapter.ts";
import { SecretEnvironment } from "../src/execution-environment.ts";
import {
	ExecutionLaunchUncertainError,
	type ExecutionTarget,
	ExecutionTargetRegistry,
	InvalidExecutionTargetRequirementsError,
	type TargetResolutionInput,
} from "../src/execution-target.ts";
import { git } from "../src/git.ts";
import { silentLogger } from "../src/log.ts";
import type { RoutingSettings } from "../src/routing.ts";
import {
	GlobalStopError,
	noBackgroundAgents,
	ProviderHeldError,
	RunEngine,
	type RunEngineDeps,
	SteerUnsupportedError,
	TaskNotClaimableError,
} from "../src/run-engine.ts";
import { RunRegistry } from "../src/run-registry.ts";
import { TaskOwnershipHeldError } from "../src/tasks/index.ts";
import { makeTasks } from "./fixtures/board.ts";

async function waitFor(cond: () => Promise<boolean>, timeoutMs = 8000) {
	const t0 = Date.now();
	while (Date.now() - t0 < timeoutMs) {
		if (await cond()) return;
		await Bun.sleep(60);
	}
	throw new Error("waitFor timed out");
}

/** Fake agent driver: writes a file in cwd, commits nothing, exits 0. */
const FAKE_DRIVER = `
const dir = process.argv[2];
const cfg = JSON.parse(await Bun.file(dir + "/driver.json").text());
const { appendFileSync } = await import("node:fs");
let seq = 0;
const emit = (e) => appendFileSync(dir + "/events.jsonl",
  JSON.stringify({ ts: new Date().toISOString(), seq: seq++, ...e }) + "\\n");
emit({ type: "hello", provider: "claude-cli", capabilities: { steer: true } });
emit({ type: "message", role: "assistant", text: "working in " + cfg.cwd });
await Bun.write(cfg.cwd + "/made-by-agent.txt", "done\\n");
emit({ type: "done", reason: "complete" });
process.exit(0);
`;

/** Records the provider each invocation was built for (prepare and launch). */
class RecordingAdapters extends AdapterRegistry {
	readonly calls: ProviderConfig[] = [];
	override invocation(
		cfg: ProviderConfig,
		model: string,
		prompt: string,
		opts: { steer: boolean; disallowBackgroundAgents?: boolean },
	) {
		this.calls.push(structuredClone(cfg));
		return super.invocation(cfg, model, prompt, opts);
	}
}

async function fixture(
	opts: {
		globalPaused?: () => { reason: string } | null;
		buildTaskPrompt?: (id: string) => Promise<string>;
		executionTarget?: ExecutionTarget;
		resolveTaskExecutionTarget?: () => TargetResolutionInput;
		projectId?: string;
		provider?: { id: string; type: "claude-cli" | "codex-cli" };
		modelTiers?: Partial<Record<"light" | "standard" | "strong", string>>;
		routing?: RoutingSettings["routing"];
		providerHolds?: RunEngineDeps["providerHolds"];
		adapters?: AdapterRegistry;
		workloadSecretGrantIds?: string[];
		resolveWorkloadSecrets?: (selection: {
			projectId: string;
			taskId: string | null;
			grantIds: readonly string[];
		}) => Promise<{
			secretEnvironment: SecretEnvironment;
			binding: string;
		}>;
	} = {},
) {
	const root = await mkdtemp(join(tmpdir(), "mfw-eng-"));
	await git(["init", "-q", "-b", "main"], root);
	await git(["config", "user.email", "t@t"], root);
	await git(["config", "user.name", "t"], root);
	await writeFile(join(root, "README.md"), "# demo\n");
	await git(["add", "-A"], root);
	await git(["commit", "-q", "-m", "init"], root);

	const mfwDir = join(root, ".mfw");
	const handle = await openProjectDb(mfwDir);
	const bus = new EventBus();
	const seen: StoredEvent[] = [];
	bus.subscribe((e) => seen.push(e));
	const tasks = await makeTasks(handle, bus, mfwDir);
	const registry = new RunRegistry({
		handle,
		bus,
		runsDir: join(mfwDir, "runs"),
	});
	const host = new AgentHost();
	const adapters = opts.adapters ?? new AdapterRegistry();
	const driverPath = join(root, "fake-driver.ts");
	await writeFile(driverPath, FAKE_DRIVER);
	adapters.driverOverride = driverPath;
	adapters.buildArgv = () => ["true"];

	const live: RoutingSettings = {
		provider: opts.provider ?? { id: "claude-cli", type: "claude-cli" },
		model: "sonnet",
		...(opts.modelTiers ? { modelTiers: opts.modelTiers } : {}),
		reasoningEffort: "high",
		routing: opts.routing ?? null,
	};
	const engineDeps: RunEngineDeps = {
		handle,
		registry,
		tasks,
		host,
		executionTargets: opts.executionTarget
			? new ExecutionTargetRegistry([opts.executionTarget])
			: undefined,
		resolveTaskExecutionTarget: opts.resolveTaskExecutionTarget,
		projectId: opts.projectId,
		workloadSecretGrantIds: opts.workloadSecretGrantIds,
		resolveWorkloadSecrets: opts.resolveWorkloadSecrets,
		adapters,
		log: silentLogger(),
		projectRoot: root,
		projectName: "demo",
		integrationBranch: "main",
		// Mutable on purpose: tests change the project's routing mid-flight.
		routing: () => live,
		providerHolds: opts.providerHolds,
		defaults: {
			leaseMs: 60_000,
		},
		globalPaused: opts.globalPaused,
		buildPrompt: {
			task: opts.buildTaskPrompt ?? (async (id) => `do task ${id}`),
			continuation: async (id, parentRunId) =>
				`continue ${id} (from ${parentRunId})`,
			import: async () => "import",
			plan: async (goal) => `plan: ${goal}`,
		},
	};
	const engine = new RunEngine(engineDeps);
	return {
		root,
		handle,
		tasks,
		registry,
		host,
		engine,
		restartEngine: () => new RunEngine(engineDeps),
		seen,
		live,
	};
}

describe("noBackgroundAgents", () => {
	test("task and repair runs (and draft expansion) cannot start background agents", () => {
		expect(noBackgroundAgents({ kind: "task", taskId: "T-1" })).toBe(true);
		expect(noBackgroundAgents({ kind: "repair", taskId: "T-1" })).toBe(true);
		expect(noBackgroundAgents({ kind: "plan", taskId: "T-1" })).toBe(true);
		expect(noBackgroundAgents({ kind: "plan", taskId: null })).toBe(false);
		expect(noBackgroundAgents({ kind: "action" })).toBe(false);
		const argv = claudeAdapter.invocation(
			{ id: "claude-cli", type: "claude-cli" },
			"sonnet",
			"p",
			{
				steer: true,
				disallowBackgroundAgents: noBackgroundAgents({ kind: "task" }),
			},
		).providerArgv;
		expect(argv[argv.indexOf("--disallowedTools") + 1]).toContain("Agent");
	});
});

describe("RunEngine v2", () => {
	test("manual and scheduled concurrent starts reserve overlapping ownership atomically", async () => {
		const launched: string[] = [];
		const target: ExecutionTarget = {
			kind: "ownership-test",
			async prepare(request) {
				return {
					targetKind: "ownership-test",
					globalLeaseRef: null,
					observedShape: null,
					workspace: {
						canonicalPath: request.projectRoot,
						executionPath: request.projectRoot,
						branch: `mfw/${request.owner.runId}`,
						baseSha: "abc123",
					},
				};
			},
			async launch(request) {
				launched.push(request.owner.runId);
			},
			async observe() {
				return { state: "running" };
			},
			async control() {},
			async collect() {
				return { observedShape: null };
			},
			async dispose() {
				return { absenceConfirmed: true, observedShape: null };
			},
			async inventory() {
				return [];
			},
			async reconcile() {
				return { observations: [], errors: [] };
			},
		};
		const f = await fixture({
			executionTarget: target,
			resolveTaskExecutionTarget: () => ({ kind: target.kind }),
		});
		try {
			const first = await f.tasks.create({
				title: "manual",
				status: "ready",
				owns: ["src/shared/**"],
			});
			const second = await f.tasks.create({
				title: "scheduled",
				status: "ready",
				owns: ["src/shared/file.ts"],
			});
			const results = await Promise.allSettled([
				f.engine.startTask(first.id, { actor: "human" }),
				f.engine.startTask(second.id, { actor: "scheduler" }),
			]);
			expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
			const failure = results.find((r) => r.status === "rejected");
			expect(failure?.status === "rejected" && failure.reason).toBeInstanceOf(
				TaskOwnershipHeldError,
			);
			expect(launched).toHaveLength(1);
			const live = await f.registry.list({ states: ["running"] });
			expect(live).toHaveLength(1);
			const winner = live[0];
			if (!winner?.taskId) throw new Error("missing winning task run");
			const loser = winner.taskId === first.id ? second : first;
			expect((await f.tasks.get(loser.id))?.status).toBe("ready");
			expect(await f.registry.list({ taskId: loser.id })).toEqual([]);
			expect(
				f.seen.find((event) => event.type === "task.held_for_resource")
					?.payload,
			).toMatchObject({ code: "owns-overlap", waitingFor: [winner.taskId] });
			await f.registry.recordExit(winner.id, { outcome: "completed" });
			await f.tasks.release(winner.taskId, winner.id, "done", "scheduler");
			await f.engine.startTask(loser.id, { actor: "human" });
			expect(launched).toHaveLength(2);
		} finally {
			await f.handle.close();
			await rm(f.root, { recursive: true, force: true });
		}
	});

	test("a stale service sees disk ownership and holds expired claims until release", async () => {
		const f = await fixture();
		try {
			const owner = await f.tasks.create({
				title: "owner",
				status: "ready",
				owns: ["src/a"],
			});
			const candidate = await f.tasks.create({
				title: "candidate",
				status: "ready",
				owns: ["src/b"],
			});
			const stale = await makeTasks(
				f.handle,
				new EventBus(),
				join(f.root, ".mfw"),
			);
			await f.tasks.edit(owner.id, { owns: ["src/b/**"] });
			expect(await f.tasks.tryClaim(owner.id, "prior-run", 0)).toBe(true);
			expect(stale.store.get(owner.id)?.status).toBe("ready");
			await expect(
				stale.tryClaim(candidate.id, "next-run", 60_000, "human"),
			).rejects.toBeInstanceOf(TaskOwnershipHeldError);
			expect(stale.store.get(candidate.id)?.state.claimedByGroupId).toBeNull();
		} finally {
			await f.handle.close();
			await rm(f.root, { recursive: true, force: true });
		}
	});

	test("prompt construction failure leaves the task ready and unclaimed", async () => {
		const f = await fixture({
			buildTaskPrompt: async () => {
				throw new Error("prompt unavailable");
			},
		});
		const t = await f.tasks.create({ title: "still ready" });
		await f.tasks.move(t.id, "ready", "human");

		await expect(f.engine.startTask(t.id)).rejects.toThrow(
			/prompt unavailable/,
		);
		const task = await f.tasks.get(t.id);
		expect(task?.status).toBe("ready");
		expect(task?.claimedByRunId).toBeNull();
		expect(await f.registry.list()).toEqual([]);
	});

	test("startTask: claim → worktree off integration branch → tmux → running → agent works", async () => {
		const f = await fixture();
		const t = await f.tasks.create({ title: "build a thing" });
		await f.tasks.move(t.id, "ready", "human");

		const { runId } = await f.engine.startTask(t.id);
		const run = await f.registry.get(runId);
		expect(run?.state).toBe("running");
		expect(run?.worktreePath).toContain("worktrees/");
		expect(run?.branch).toBe(`mfw/${runId}`);
		expect(run?.integrationBranch).toBe("main");
		expect(run?.providerId).toBe("claude-cli");
		expect(run?.reasoningEffort).toBe("high");
		const driverConfig = JSON.parse(
			await Bun.file(join(f.registry.runDir(runId), "driver.json")).text(),
		);
		expect(driverConfig.reasoningEffort).toBe("high");

		const task = await f.tasks.get(t.id);
		expect(task?.status).toBe("in_progress");
		expect(task?.claimedByRunId).toBe(runId);

		// the fake driver ran inside the worktree via tmux
		await waitFor(async () => {
			const exit = await f.host.readExit(f.registry.runDir(runId));
			return exit.kind === "exit" && exit.code === 0;
		});
		expect(
			await Bun.file(
				join(run?.worktreePath ?? "", "made-by-agent.txt"),
			).exists(),
		).toBe(true);
		f.handle.close();
		await rm(f.root, { recursive: true, force: true });
	}, 20_000);

	test("startTask resolves the run model from the task's model_tier", async () => {
		const f = await fixture({ modelTiers: { strong: "claude-opus-5" } });

		// No tier: the project model.
		const plain = await f.tasks.create({ title: "no tier" });
		await f.tasks.move(plain.id, "ready", "human");
		const plainRun = await f.engine.startTask(plain.id);
		expect((await f.registry.get(plainRun.runId))?.model).toBe("sonnet");

		// A tier the project overrides.
		const strong = await f.tasks.create({
			title: "strong tier",
			modelTier: "strong",
		});
		await f.tasks.move(strong.id, "ready", "human");
		const strongRun = await f.engine.startTask(strong.id);
		expect((await f.registry.get(strongRun.runId))?.model).toBe(
			"claude-opus-5",
		);

		// A tier the project does not override: the catalogue default.
		const light = await f.tasks.create({
			title: "light tier",
			modelTier: "light",
		});
		await f.tasks.move(light.id, "ready", "human");
		const lightRun = await f.engine.startTask(light.id);
		expect((await f.registry.get(lightRun.runId))?.model).toBe("haiku");

		// An explicit caller override still wins over the task's own tier.
		const overridden = await f.tasks.create({
			title: "explicit wins",
			modelTier: "strong",
		});
		await f.tasks.move(overridden.id, "ready", "human");
		const overriddenRun = await f.engine.startTask(overridden.id, {
			model: "claude-fable-5",
		});
		expect((await f.registry.get(overriddenRun.runId))?.model).toBe(
			"claude-fable-5",
		);

		f.handle.close();
		await rm(f.root, { recursive: true, force: true });
	}, 20_000);

	test("changing the project provider between prepare and launch keeps the run's provider", async () => {
		const adapters = new RecordingAdapters();
		const f = await fixture({ adapters });
		const task = await f.tasks.create({ title: "prepared on claude" });
		await f.tasks.move(task.id, "ready", "human");

		const prepared = await f.engine.prepareTaskRun(task.id);
		const row = await f.registry.get(prepared.runId);
		expect(row).toMatchObject({
			providerId: "claude-cli",
			model: "sonnet",
			harness: "claude-cli",
			modelVendor: "anthropic",
		});
		expect(row?.routing).toMatchObject({
			provider: "claude-cli",
			model: "sonnet",
			reason: "project-model",
			target: "local",
		});

		// The operator switches the project to Codex live, before launch.
		f.live.provider = { id: "codex-cli", type: "codex-cli" };
		f.live.model = "gpt-5.6-sol";
		adapters.calls.length = 0;
		await f.engine.launchPreparedRun(prepared);

		expect(adapters.calls.map((c) => c.id)).toEqual(["claude-cli"]);
		const driverConfig = JSON.parse(
			await Bun.file(
				join(f.registry.runDir(prepared.runId), "driver.json"),
			).text(),
		);
		expect(driverConfig.model).toBe("sonnet");

		// The next run follows the new settings without a restart.
		const next = await f.tasks.create({ title: "after the switch" });
		await f.tasks.move(next.id, "ready", "human");
		const nextRun = await f.engine.startTask(next.id);
		expect(await f.registry.get(nextRun.runId)).toMatchObject({
			providerId: "codex-cli",
			model: "gpt-5.6-sol",
			modelVendor: "openai",
		});
		f.handle.close();
		await rm(f.root, { recursive: true, force: true });
	}, 20_000);

	test("task provider/model pins route the run and are persisted with the reason", async () => {
		const f = await fixture();
		const task = await f.tasks.create({
			title: "pinned",
			provider: "codex-cli",
			model: "gpt-5.6-terra",
		});
		expect((await f.tasks.get(task.id))?.provider).toBe("codex-cli");
		await f.tasks.move(task.id, "ready", "human");
		const { runId } = await f.engine.prepareTaskRun(task.id);
		const run = await f.registry.get(runId);
		expect(run).toMatchObject({
			providerId: "codex-cli",
			model: "gpt-5.6-terra",
		});
		expect(run?.routing).toMatchObject({ reason: "task", pinned: true });
		f.handle.close();
		await rm(f.root, { recursive: true, force: true });
	}, 20_000);

	test("a held route refuses a scheduled start before the claim; a human start goes ahead", async () => {
		const f = await fixture({
			providerHolds: {
				snapshot: async () => (key: string) =>
					key === "claude-cli"
						? { until: Date.now() + 60_000, reason: "rate-limited run X" }
						: null,
			},
		});
		const task = await f.tasks.create({ title: "held" });
		await f.tasks.move(task.id, "ready", "human");
		await expect(f.engine.startTask(task.id)).rejects.toBeInstanceOf(
			ProviderHeldError,
		);
		expect((await f.tasks.get(task.id))?.claimedByRunId).toBeNull();
		expect(await f.registry.list()).toEqual([]);

		const { runId } = await f.engine.prepareTaskRun(task.id, {
			actor: "human",
		});
		expect((await f.registry.get(runId))?.providerId).toBe("claude-cli");
		f.handle.close();
		await rm(f.root, { recursive: true, force: true });
	}, 20_000);

	test("an endpoint route launches Codex on it, with the key only via the endpoint's grant", async () => {
		const adapters = new RecordingAdapters();
		const selections: string[][] = [];
		const f = await fixture({
			adapters,
			routing: {
				endpoints: {
					or: {
						baseUrl: "https://openrouter.ai/api/v1",
						envKey: "OPENROUTER_API_KEY",
						grant: "or-key",
						model: "qwen/qwen3-coder",
						vendor: "openrouter",
					},
				},
			},
			resolveWorkloadSecrets: async (selection) => {
				selections.push([...selection.grantIds]);
				return {
					secretEnvironment: new SecretEnvironment(
						selection.grantIds.includes("or-key")
							? { OPENROUTER_API_KEY: "sk-test" }
							: {},
					),
					binding: "b1",
				};
			},
		});
		const task = await f.tasks.create({
			title: "via openrouter",
			provider: "or",
		});
		await f.tasks.move(task.id, "ready", "human");
		const { runId } = await f.engine.startTask(task.id);
		const run = await f.registry.get(runId);
		expect(run).toMatchObject({
			providerId: "codex-cli",
			model: "qwen/qwen3-coder",
			modelVendor: "openrouter",
			workloadSecretGrantIds: ["or-key"],
		});
		expect(adapters.calls.at(-1)?.endpoint).toEqual({
			id: "or",
			baseUrl: "https://openrouter.ai/api/v1",
			envKey: "OPENROUTER_API_KEY",
		});
		expect(selections.at(-1)).toEqual(["or-key"]);
		// The key value never lands on the row.
		expect(JSON.stringify(run)).not.toContain("sk-test");
		f.handle.close();
		await rm(f.root, { recursive: true, force: true });
	}, 20_000);

	test("prepareTaskRun writes claim, starting row, worktree, and target journal without launching", async () => {
		const f = await fixture();
		const task = await f.tasks.create({ title: "admit before launch" });
		await f.tasks.move(task.id, "ready", "human");

		const prepared = await f.engine.prepareTaskRun(task.id, { actor: "human" });
		const run = await f.registry.get(prepared.runId);
		expect(run).toMatchObject({
			state: "starting",
			executionTarget: "local",
			targetLifecycleState: "prepared",
			targetProjectId: "demo",
		});
		expect(run?.worktreePath).toContain("worktrees/");
		expect((await f.tasks.get(task.id))?.claimedByRunId).toBe(prepared.runId);
		expect(await f.host.isAlive(prepared.runId)).toBe(false);
		expect(
			await Bun.file(
				join(f.registry.runDir(prepared.runId), "driver.json"),
			).exists(),
		).toBe(false);
		expect(
			(await f.registry.targetJournal(prepared.runId)).map((entry) => [
				entry.phase,
				entry.status,
			]),
		).toEqual([
			["prepare", "intent"],
			["prepare", "completed"],
		]);

		await f.engine.launchPreparedRun(prepared);
		await f.engine.launchPreparedRun(prepared); // idempotent compatibility retry
		expect((await f.registry.get(prepared.runId))?.state).toBe("running");
		expect(
			(await f.registry.targetJournal(prepared.runId)).filter(
				(entry) => entry.phase === "launch" && entry.status === "completed",
			).length,
		).toBe(1);

		await waitFor(async () => {
			const exit = await f.host.readExit(f.registry.runDir(prepared.runId));
			return exit.kind === "exit";
		});
		f.handle.close();
		await rm(f.root, { recursive: true, force: true });
	}, 20_000);

	test("invalid remote/host requirements fail before claim, run creation, or target effects", async () => {
		const f = await fixture();
		const task = await f.tasks.create({ title: "invalid placement" });
		await f.tasks.move(task.id, "ready", "human");

		await expect(
			f.engine.prepareTaskRun(task.id, {
				target: {
					kind: "remote-test",
					requiresResources: [{ scope: "host", id: "gpu" }],
				},
			}),
		).rejects.toThrow(InvalidExecutionTargetRequirementsError);
		expect((await f.tasks.get(task.id))?.status).toBe("ready");
		expect((await f.tasks.get(task.id))?.claimedByRunId).toBeNull();
		expect(await f.registry.list()).toEqual([]);
		f.handle.close();
		await rm(f.root, { recursive: true, force: true });
	});

	test("selects an injected target while preserving stable ownership and the prepare/launch boundary", async () => {
		const calls: string[] = [];
		const target: ExecutionTarget = {
			kind: "remote-test",
			async prepare(request) {
				calls.push(`prepare:${request.owner.ownerKey}`);
				return {
					targetKind: "remote-test",
					workspace: {
						canonicalPath: join(
							request.projectRoot,
							"worktrees",
							request.owner.runId,
						),
						executionPath: "/remote/worktree",
						branch: `mfw/${request.owner.runId}`,
						baseSha: "abc123",
					},
					globalLeaseRef: "global-lease-1",
					observedShape: { cpu: 8 },
				};
			},
			async launch(request) {
				calls.push(
					`launch:${request.owner.ownerKey}:${request.workspace.executionPath}`,
				);
			},
			async observe() {
				calls.push("observe");
				return { state: "running", observedShape: { cpu: 8 } };
			},
			async control() {},
			async collect() {
				return { observedShape: { cpu: 8 } };
			},
			async dispose() {
				return { absenceConfirmed: true, observedShape: { cpu: 8 } };
			},
			async inventory() {
				return [];
			},
			async reconcile() {
				return { observations: [], errors: [] };
			},
		};
		const f = await fixture({
			executionTarget: target,
			projectId: "project-stable-1",
			resolveTaskExecutionTarget: () => ({
				kind: "remote-test",
				requestedShape: { cpu: 8 },
				requiresResources: ["serial"],
				localStagingResources: [{ scope: "host", id: "disk" }],
			}),
		});
		const task = await f.tasks.create({ title: "remote contract" });
		await f.tasks.move(task.id, "ready", "human");

		const resolved = await f.engine.resolveTaskExecutionTarget(task.id);
		expect(resolved.requirements).toEqual({
			executionHost: [],
			projectSemaphores: [{ scope: "project", id: "serial", amount: 1 }],
			// An omitted host amount stays omitted until admission resolves the
			// referenced definition. Slot resources default to one there; quantity
			// resources must remain explicit.
			localStaging: [{ scope: "host", id: "disk", amount: undefined }],
		});
		expect(calls).toEqual([]);

		const prepared = await f.engine.prepareTaskRun(task.id, {
			target: resolved,
		});
		expect(calls).toEqual([`prepare:project-stable-1/${prepared.runId}/1`]);
		const row = await f.registry.get(prepared.runId);
		expect(row).toMatchObject({
			state: "starting",
			executionTarget: "remote-test",
			targetProjectId: "project-stable-1",
			targetLeaseRef: "global-lease-1",
			targetExecutionPath: "/remote/worktree",
			targetRequestedShape: { cpu: 8 },
			targetObservedShape: { cpu: 8 },
		});

		await f.engine.launchPreparedRun(prepared);
		expect(calls).toEqual([
			`prepare:project-stable-1/${prepared.runId}/1`,
			`launch:project-stable-1/${prepared.runId}/1:/remote/worktree`,
			"observe",
		]);
		expect((await f.registry.get(prepared.runId))?.state).toBe("running");
		f.handle.close();
		await rm(f.root, { recursive: true, force: true });
	});

	test("collection failure is journaled but never waives unconditional disposal", async () => {
		let disposeCalls = 0;
		const target: ExecutionTarget = {
			kind: "remote-test",
			async prepare(request) {
				return {
					targetKind: "remote-test",
					workspace: {
						canonicalPath: request.projectRoot,
						executionPath: "/remote/worktree",
						branch: "main",
						baseSha: "abc123",
					},
					globalLeaseRef: "global-cleanup-lease",
					observedShape: { phase: "ready" },
				};
			},
			async launch() {},
			async observe() {
				return { state: "running" };
			},
			async control() {},
			async collect() {
				throw new Error("collection transport lost");
			},
			async dispose() {
				disposeCalls++;
				return { absenceConfirmed: true, observedShape: { phase: "absent" } };
			},
			async inventory() {
				return [];
			},
			async reconcile() {
				return { observations: [], errors: [] };
			},
		};
		const f = await fixture({
			executionTarget: target,
			resolveTaskExecutionTarget: () => ({ kind: "remote-test" }),
		});
		const task = await f.tasks.create({
			title: "must delete after collect failure",
		});
		await f.tasks.move(task.id, "ready", "human");
		const { runId } = await f.engine.startTask(task.id);

		const result = await f.engine.finalizeExecutionTarget(runId);
		expect(result.collectionError).toBeInstanceOf(Error);
		expect(disposeCalls).toBe(1);
		expect(
			(await f.registry.get(runId))?.targetAbsenceConfirmedAt,
		).not.toBeNull();
		expect(
			(await f.registry.targetJournal(runId)).map((entry) => [
				entry.phase,
				entry.status,
			]),
		).toContainEqual(["collect", "failed"]);
		expect(
			(await f.registry.targetJournal(runId)).map((entry) => [
				entry.phase,
				entry.status,
			]),
		).toContainEqual(["dispose", "completed"]);
		f.handle.close();
		await rm(f.root, { recursive: true, force: true });
	});

	test("restart adopts an uncertain detached launch without a duplicate driver or premature cleanup", async () => {
		let detachedLaunches = 0;
		let launchCalls = 0;
		let collectCalls = 0;
		let disposeCalls = 0;
		const target: ExecutionTarget = {
			kind: "remote-test",
			async prepare(request) {
				return {
					targetKind: this.kind,
					workspace: {
						canonicalPath: request.projectRoot,
						executionPath: "/remote/worktree",
						branch: "main",
						baseSha: "abc123",
					},
					globalLeaseRef: "uncertain-launch-lease",
					observedShape: null,
				};
			},
			async launch() {
				launchCalls++;
				if (detachedLaunches === 0) {
					detachedLaunches++;
					throw new ExecutionLaunchUncertainError(
						"network_lost after detached launch",
					);
				}
				// A retry observes the durable remote identity and does not spawn.
			},
			async observe() {
				return { state: "running" };
			},
			async control() {},
			async collect() {
				collectCalls++;
				return { observedShape: null };
			},
			async dispose() {
				disposeCalls++;
				return { absenceConfirmed: true, observedShape: null };
			},
			async inventory() {
				return [];
			},
			async reconcile() {
				return { observations: [], errors: [] };
			},
		};
		const f = await fixture({
			executionTarget: target,
			resolveTaskExecutionTarget: () => ({ kind: "remote-test" }),
		});
		const task = await f.tasks.create({ title: "uncertain remote launch" });
		await f.tasks.move(task.id, "ready", "human");
		const prepared = await f.engine.prepareTaskRun(task.id);
		await expect(f.engine.launchPreparedRun(prepared)).resolves.toEqual({
			runId: prepared.runId,
		});
		expect((await f.registry.get(prepared.runId))?.state).toBe("starting");
		expect((await f.registry.get(prepared.runId))?.targetLifecycleState).toBe(
			"launching",
		);
		expect(detachedLaunches).toBe(1);
		expect(collectCalls).toBe(0);
		expect(disposeCalls).toBe(0);

		const restarted = f.restartEngine();
		await restarted.launchPreparedRun({ runId: prepared.runId });
		expect((await f.registry.get(prepared.runId))?.state).toBe("running");
		expect(launchCalls).toBe(2);
		expect(detachedLaunches).toBe(1);
		expect(collectCalls).toBe(0);
		expect(disposeCalls).toBe(0);
		f.handle.close();
		await rm(f.root, { recursive: true, force: true });
	});

	test("snapshots task/project grant IDs and resolves their values only at target launch", async () => {
		const canary = "MFW98_WORKLOAD_SECRET_CANARY";
		const resolutions: {
			projectId: string;
			taskId: string | null;
			grantIds: readonly string[];
		}[] = [];
		let launchedSecrets: SecretEnvironment | undefined;
		const target: ExecutionTarget = {
			kind: "remote-test",
			async prepare(request) {
				return {
					targetKind: this.kind,
					workspace: {
						canonicalPath: request.projectRoot,
						executionPath: "/remote/worktree",
						branch: "main",
						baseSha: "abc123",
					},
					globalLeaseRef: "grant-lease",
					observedShape: null,
				};
			},
			async launch(request) {
				launchedSecrets = request.driver.secretEnvironment;
			},
			async observe() {
				return { state: "running" };
			},
			async control() {},
			async collect() {
				return { observedShape: null };
			},
			async dispose() {
				return { absenceConfirmed: true, observedShape: null };
			},
			async inventory() {
				return [];
			},
			async reconcile() {
				return { observations: [], errors: [] };
			},
		};
		const f = await fixture({
			executionTarget: target,
			projectId: "project-grants",
			workloadSecretGrantIds: ["project-provider"],
			resolveTaskExecutionTarget: () => ({ kind: "remote-test" }),
			resolveWorkloadSecrets: async (selection) => {
				resolutions.push(selection);
				return {
					secretEnvironment: new SecretEnvironment({ CODEX_API_KEY: canary }),
					binding: "opaque-version-1",
				};
			},
		});
		const task = await f.tasks.create({
			title: "credential-bound remote task",
			workloadSecretGrants: ["task-provider"],
		});
		await f.tasks.move(task.id, "ready", "human");
		const prepared = await f.engine.prepareTaskRun(task.id);
		expect(resolutions).toEqual([]);
		expect(
			(await f.registry.get(prepared.runId))?.workloadSecretGrantIds,
		).toEqual(["project-provider", "task-provider"]);
		await f.engine.launchPreparedRun(prepared);
		expect(resolutions).toEqual([
			{
				projectId: "project-grants",
				taskId: task.id,
				grantIds: ["project-provider", "task-provider"],
			},
		]);
		expect(launchedSecrets?.names()).toEqual(["CODEX_API_KEY"]);
		expect(JSON.stringify(await f.registry.get(prepared.runId))).not.toContain(
			canary,
		);
		f.handle.close();
		await rm(f.root, { recursive: true, force: true });
	});

	for (const evidenceFailure of ["revoked", "rotated"] as const) {
		test(`restart with ${evidenceFailure} credentials blocks evidence but still proves target absence`, async () => {
			const launchedCanary = "MFW98_LAUNCHED_SECRET_old";
			const rotatedCanary = "MFW98_ROTATED_SECRET_new";
			let credentialState: "launch" | "revoked" | "rotated" = "launch";
			let disposed = 0;
			let launched = false;
			let evidenceBlocked = false;
			const target: ExecutionTarget = {
				kind: "remote-test",
				async prepare(request) {
					return {
						targetKind: this.kind,
						workspace: {
							canonicalPath: request.projectRoot,
							executionPath: "/remote/worktree",
							branch: "main",
							baseSha: "abc123",
						},
						globalLeaseRef: "credential-restart-lease",
						observedShape: null,
					};
				},
				async launch() {
					launched = true;
				},
				async observe(ref) {
					if (credentialState === "launch") return { state: "running" };
					evidenceBlocked = ref.evidenceSecretsUnavailable === true;
					if (!evidenceBlocked) {
						await writeFile(join(ref.runDir, "events.jsonl"), launchedCanary);
					}
					return { state: "exited", exitCode: 0 };
				},
				async control() {},
				async collect(ref) {
					if (ref.evidenceSecretsUnavailable) {
						throw new Error("evidence secrets unavailable");
					}
					throw new Error("unsafe collection was attempted");
				},
				async dispose() {
					disposed++;
					return {
						absenceConfirmed: true,
						observedShape: { phase: "absent" },
					};
				},
				async inventory() {
					return [];
				},
				async reconcile() {
					return { observations: [], errors: [] };
				},
			};
			const f = await fixture({
				executionTarget: target,
				projectId: "project-credential-restart",
				workloadSecretGrantIds: ["agent-grant"],
				resolveTaskExecutionTarget: () => ({ kind: "remote-test" }),
				resolveWorkloadSecrets: async () => {
					if (credentialState === "revoked") {
						throw new Error("credential unavailable");
					}
					return {
						secretEnvironment: new SecretEnvironment({
							CODEX_API_KEY:
								credentialState === "rotated" ? rotatedCanary : launchedCanary,
						}),
						binding:
							credentialState === "rotated"
								? "opaque-version-2"
								: "opaque-version-1",
					};
				},
			});
			const task = await f.tasks.create({ title: `${evidenceFailure} grant` });
			await f.tasks.move(task.id, "ready", "human");
			const { runId } = await f.engine.startTask(task.id);
			expect(launched).toBe(true);
			const launchedRow = await f.registry.get(runId);
			expect(launchedRow?.workloadSecretNames).toEqual(["CODEX_API_KEY"]);
			expect(launchedRow?.workloadSecretBinding).toBe("opaque-version-1");
			expect(JSON.stringify(launchedRow)).not.toContain(launchedCanary);

			credentialState = evidenceFailure;
			const restarted = f.restartEngine();
			expect((await restarted.observeRun(runId)).state).toBe("exited");
			expect(evidenceBlocked).toBe(true);
			expect(
				await Bun.file(join(f.registry.runDir(runId), "events.jsonl")).exists(),
			).toBe(false);
			await f.registry.recordExit(runId, {
				outcome: "completed",
				exitCode: 0,
			});
			const finalized = await restarted.finalizeExecutionTarget(runId);
			expect(finalized.collectionError).toBeInstanceOf(Error);
			expect(disposed).toBe(1);
			expect(
				(await f.registry.get(runId))?.targetAbsenceConfirmedAt,
			).not.toBeNull();
			expect(
				(await f.registry.targetJournal(runId)).map((entry) => [
					entry.phase,
					entry.status,
				]),
			).toContainEqual(["collect", "failed"]);
			f.handle.close();
			await rm(f.root, { recursive: true, force: true });
		});
	}

	test("unclaimable task refuses to start; no run row leaks", async () => {
		const f = await fixture();
		const t = await f.tasks.create({ title: "not ready" }); // stays backlog
		await expect(f.engine.startTask(t.id)).rejects.toThrow(/not claimable/);
		expect((await f.registry.list({})).length).toBe(0);
		f.handle.close();
		await rm(f.root, { recursive: true, force: true });
	});

	test("MFW-35: the master stop blocks startTask too, no claim, no run row", async () => {
		const f = await fixture({
			globalPaused: () => ({ reason: "incident: cost spike" }),
		});
		const t = await f.tasks.create({ title: "would run" });
		await f.tasks.move(t.id, "ready", "human");
		await expect(f.engine.startTask(t.id)).rejects.toThrow(GlobalStopError);
		expect((await f.tasks.get(t.id))?.status).toBe("ready");
		expect((await f.registry.list({})).length).toBe(0);
		f.handle.close();
		await rm(f.root, { recursive: true, force: true });
	});

	test("MFW-35: a hand-started run is attributed to the human, not the scheduler", async () => {
		const f = await fixture();
		const t = await f.tasks.create({ title: "hand run" });
		await f.tasks.move(t.id, "ready", "human");
		f.seen.length = 0;
		await f.engine.startTask(t.id, { actor: "human" });
		const claim = f.seen.find((e) => e.type === "task.status_changed");
		expect((claim?.payload as { actor?: string } | undefined)?.actor).toBe(
			"human",
		);
		f.handle.close();
		await rm(f.root, { recursive: true, force: true });
	});

	test("steer is triple-gated: rejected before hello verification, accepted after", async () => {
		const f = await fixture();
		const t = await f.tasks.create({ title: "steerable" });
		await f.tasks.move(t.id, "ready", "human");
		const { runId } = await f.engine.startTask(t.id);

		await expect(f.engine.steer(runId, "hi")).rejects.toThrow(
			SteerUnsupportedError,
		);
		// the supervisor would copy hello → capabilities; simulate it
		await f.registry.setCapabilities(runId, { steer: true, verified: true });
		await f.engine.steer(runId, "hi");
		const steer = await Bun.file(
			join(f.registry.runDir(runId), "steer.jsonl"),
		).text();
		expect(steer.trim()).toBe(JSON.stringify("hi"));
		// a verified non-steerable run still refuses
		await f.registry.setCapabilities(runId, { steer: false, verified: true });
		await expect(f.engine.steer(runId, "again")).rejects.toThrow(
			SteerUnsupportedError,
		);
		f.handle.close();
		await rm(f.root, { recursive: true, force: true });
	}, 20_000);

	/** A finished run whose settle released its task, as finalize leaves it. */
	async function settledParent(
		f: Awaited<ReturnType<typeof fixture>>,
		title: string,
	) {
		const t = await f.tasks.create({ title });
		await f.tasks.move(t.id, "ready", "human");
		const { runId } = await f.engine.startTask(t.id);
		await waitFor(async () => {
			const exit = await f.host.readExit(f.registry.runDir(runId));
			return exit.kind === "exit";
		});
		await f.registry.transition(runId, "failed", { outcome: "completed" });
		await f.tasks.release(t.id, runId, "ready", "scheduler", "settled");
		const parent = await f.registry.get(runId);
		return { taskId: t.id, runId, parent };
	}

	test("a continue: group run reuses the parent's worktree and branch, takes the claim as its own group, and writes relation continue", async () => {
		const f = await fixture();
		const { taskId, runId, parent } = await settledParent(f, "flaky");
		const childId = ulid();
		const spec = {
			runId: childId,
			taskId,
			groupId: childId,
			groupKind: "single" as const,
			role: "implement" as const,
			actionId: "act-1",
			worktree: { mode: "continue" as const, runId },
		};

		await f.engine.startGroupRun(spec);

		const child = await f.registry.get(childId);
		expect(child?.worktreePath).toBe(parent?.worktreePath);
		expect(child?.branch).toBe(parent?.branch);
		expect(child?.baseSha).toBe(parent?.baseSha);
		expect(child?.attempt).toBe((parent?.attempt ?? 1) + 1);
		// With no pick from the brain, the continuation keeps the parent's route.
		expect(child?.providerId).toBe(parent?.providerId);
		expect(child?.model).toBe(parent?.model);
		expect(child?.reasoningEffort).toBe(parent?.reasoningEffort);
		expect(child?.initialPrompt).toContain(
			`continue ${taskId} (from ${runId})`,
		);
		expect((await f.tasks.get(taskId))?.claimedByRunId).toBe(childId);
		// typed lineage: the first run roots its chain, the continuation joins it
		expect(parent?.relation).toBe("fresh");
		expect(parent?.chainRootId).toBe(runId);
		expect(child?.relation).toBe("continue");
		expect(child?.chainRootId).toBe(runId);
		expect(child?.originRef).toBe("brain:act-1");
		const started = f.seen.find(
			(e) => e.type === "run.started" && e.runId === childId,
		);
		expect(started?.payload).toMatchObject({
			kind: "task",
			taskId,
			parentRunId: runId,
			relation: "continue",
		});
		// idempotent by run id
		await f.engine.startGroupRun(spec);
		expect(
			(await f.registry.list({})).filter((r) => r.id === childId).length,
		).toBe(1);
		f.handle.close();
		await rm(f.root, { recursive: true, force: true });
	}, 20_000);

	test("a continuation never re-asks the parent's journaled question: its report is removed from the worktree", async () => {
		const f = await fixture();
		const { taskId, runId, parent } = await settledParent(f, "asks");
		const worktree = parent?.worktreePath as string;
		await writeFile(
			join(worktree, "MFW_REPORT.json"),
			JSON.stringify({ status: "question", question: "Keep v1?" }),
		);

		const childId = ulid();
		await f.engine.startGroupRun({
			runId: childId,
			taskId,
			groupId: childId,
			groupKind: "single",
			role: "implement",
			actionId: "act-2",
			brief: "The answer is: until March.",
			worktree: { mode: "continue", runId },
		});

		const child = await f.registry.get(childId);
		expect(child?.worktreePath).toBe(worktree);
		expect(child?.initialPrompt).toContain("until March");
		expect(existsSync(join(worktree, "MFW_REPORT.json"))).toBe(false);
		f.handle.close();
		await rm(f.root, { recursive: true, force: true });
	}, 20_000);

	test("a continue: spawn for a task a human has since moved out of ready starts nothing", async () => {
		const f = await fixture();
		const { taskId, runId } = await settledParent(f, "asks, then moved");
		await f.tasks.move(taskId, "backlog", "human", "not now");
		const childId = ulid();
		await expect(
			f.engine.startGroupRun({
				runId: childId,
				taskId,
				groupId: childId,
				groupKind: "single",
				role: "implement",
				actionId: "act-3",
				worktree: { mode: "continue", runId },
			}),
		).rejects.toThrow(TaskNotClaimableError);
		expect((await f.tasks.get(taskId))?.status).toBe("backlog");
		expect(await f.registry.get(childId)).toBeNull();
		f.handle.close();
		await rm(f.root, { recursive: true, force: true });
	}, 20_000);

	test("the autonomous continuation entry points are gone: repair, resume, answered resume and unblock are spawns", () => {
		const e = RunEngine.prototype as unknown as Record<string, unknown>;
		for (const gone of [
			"startRepair",
			"startResume",
			"startAnsweredResume",
			"startUnblock",
		]) {
			expect(e[gone], gone).toBeUndefined();
		}
	});

	test("non-task entry points write their relation and origin", async () => {
		const f = await fixture();
		const imp = await f.engine.startImport({ originRef: "human:ui" });
		const plan = await f.engine.startPlan("ship it");
		const replan = await f.engine.startPlan("ship it", {
			parentRunId: plan.runId,
			answers: [{ question: "q", answer: "a" }],
		});
		const action = await f.engine.startAction("do", {
			originRef: "trigger:del-9",
		});
		const manual = await f.engine.startAction("do");
		const session = await f.engine.startSession("help", { sessionId: "s-1" });
		const get = async (id: string) => {
			const r = await f.registry.get(id);
			return {
				relation: r?.relation,
				chainRootId: r?.chainRootId === id ? "self" : r?.chainRootId,
				originRef: r?.originRef,
			};
		};
		expect(await get(imp.runId)).toEqual({
			relation: "fresh",
			chainRootId: "self",
			originRef: "human:ui",
		});
		expect(await get(plan.runId)).toMatchObject({ relation: "fresh" });
		expect(await get(replan.runId)).toEqual({
			relation: "replan",
			chainRootId: "self",
			originRef: `clarify:${plan.runId}`,
		});
		expect(await get(action.runId)).toMatchObject({
			relation: "trigger",
			originRef: "trigger:del-9",
		});
		expect(await get(manual.runId)).toMatchObject({
			relation: "fresh",
			originRef: null,
		});
		expect(await get(session.runId)).toMatchObject({
			relation: "session",
			originRef: "session:s-1",
		});
		for (const r of [imp, plan, replan, action, manual, session]) {
			await waitFor(async () => {
				const exit = await f.host.readExit(f.registry.runDir(r.runId));
				return exit.kind === "exit";
			});
		}
		f.handle.close();
		await rm(f.root, { recursive: true, force: true });
	}, 30_000);

	test("a regression repair references a done task without claiming or reopening it", async () => {
		const f = await fixture();
		const task = await f.tasks.create({ title: "historical task" });
		await f.tasks.move(task.id, "done", "human");

		const { runId } = await f.engine.startRegressionRepair(
			task.id,
			"regression-1",
			"full suite failed",
		);
		const run = await f.registry.get(runId);
		expect(run).toMatchObject({ kind: "repair", taskId: task.id });
		expect(run?.relation).toBe("recovery");
		expect(run?.chainRootId).toBe(runId);
		expect((await f.tasks.get(task.id))?.status).toBe("done");
		expect((await f.tasks.get(task.id))?.claimedByRunId).toBeNull();

		await waitFor(async () => {
			const exit = await f.host.readExit(f.registry.runDir(runId));
			return exit.kind === "exit";
		});
		f.handle.close();
		await rm(f.root, { recursive: true, force: true });
	}, 20_000);
});

describe("run context", () => {
	test("the agent is told its own run id, project and task", async () => {
		// The review found mfw's MCP tools unreachable in practice because
		// nothing ever told an agent which run it was.
		const f = await fixture();
		const t = await f.tasks.create({ title: "self-aware" });
		await f.tasks.move(t.id, "ready", "human");
		const { runId } = await f.engine.startTask(t.id);

		const driverCfg = JSON.parse(
			await Bun.file(join(f.registry.runDir(runId), "driver.json")).text(),
		) as { env: Record<string, string> };
		expect(driverCfg.env.MFW_RUN_ID).toBe(runId);
		expect(driverCfg.env.MFW_PROJECT).toBe("demo");
		expect(driverCfg.env.MFW_TASK_ID).toBe(t.id);
		expect(driverCfg.env.MFW_RUN_KIND).toBe("task");
		expect(driverCfg.env.MFW_REPORT_PATH).toContain("MFW_REPORT.json");

		f.handle.close();
		await rm(f.root, { recursive: true, force: true });
	}, 20_000);
});

describe("approvals", () => {
	test("an approval requested after a 2 MiB transcript is answerable, and its answer is seen incrementally", async () => {
		const controls: unknown[] = [];
		const target: ExecutionTarget = {
			kind: "approval-test",
			async prepare() {
				throw new Error("not launched in this test");
			},
			async launch() {},
			async observe() {
				return { state: "running" };
			},
			async control(_ref, command) {
				controls.push(command);
			},
			async collect() {
				return { observedShape: null };
			},
			async dispose() {
				return { absenceConfirmed: true, observedShape: null };
			},
			async inventory() {
				return [];
			},
			async reconcile() {
				return { observations: [], errors: [] };
			},
		};
		const f = await fixture({ executionTarget: target });
		try {
			const run = await f.registry.create({
				kind: "task",
				label: "long transcript",
				model: "sonnet",
				cwd: f.root,
				executionTarget: target.kind,
				capabilities: { steer: false, verified: true, approvals: true },
			});
			await f.registry.transition(run.id, "running");
			const events = join(f.registry.runDir(run.id), "events.jsonl");
			let seq = 0;
			const line = (e: Record<string, unknown>) =>
				`${JSON.stringify({ ts: new Date().toISOString(), seq: seq++, ...e })}\n`;
			const filler = line({
				type: "message",
				role: "assistant",
				text: "é".repeat(2000), // multi-byte, so byte and char offsets differ
			});
			const approval = (status: string) =>
				line({
					type: "approval",
					requestId: "req-1",
					kind: "command",
					status,
					summary: "run the tests",
				});
			const count = Math.ceil((2 * 1024 * 1024) / filler.length) + 1;
			await writeFile(events, filler.repeat(count) + approval("pending"));

			await f.engine.respondApproval(run.id, "req-1", "accept");
			expect(controls).toEqual([
				{ type: "approval", requestId: "req-1", decision: "accept" },
			]);

			await appendFile(events, filler + approval("accepted"));
			await expect(
				f.engine.respondApproval(run.id, "req-1", "accept"),
			).rejects.toThrow(/not pending/);
			await expect(
				f.engine.respondApproval(run.id, "req-unknown", "accept"),
			).rejects.toThrow(/not pending/);
			expect(controls).toHaveLength(1);
		} finally {
			f.handle.close();
			await rm(f.root, { recursive: true, force: true });
		}
	}, 20_000);
});
