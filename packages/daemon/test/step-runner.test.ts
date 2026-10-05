import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DefinitionOfDone } from "@mfw/core/taskfile";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import { EventBus, eventsSince } from "@mfw/db/eventlog";
import { ulid } from "@mfw/db/ids";
import { engineKv, runSteps, runs } from "@mfw/db/schema";
import { and, eq } from "drizzle-orm";
import { AgentHost } from "../src/agent-host.ts";
import { ClarifyService } from "../src/clarify.ts";
import type { RunKind } from "../src/finalize/machine.ts";
import {
	type BrainPort,
	StepRunner,
	type StepRunnerDeps,
} from "../src/finalize/step-runner.ts";
import { git } from "../src/git.ts";
import type { LeftoverProcess } from "../src/leftover-processes.ts";
import { silentLogger } from "../src/log.ts";
import { RunRegistry, type RunRow } from "../src/run-registry.ts";
import { TaskService } from "../src/task-service.ts";
import { WorktreeManager } from "../src/worktree.ts";
import { makeTasks } from "./fixtures/board.ts";

/**
 * StepRunner integration tests over real temp git repos and a real project DB.
 * Each scenario walks one row of the finalization tables and asserts the
 * journal, task disposition, run terminal state and on-disk effects.
 */

interface Notification {
	kind: string;
	detail: Record<string, unknown>;
}
interface MergeJob {
	runId: string;
	taskId?: string | null;
	branch: string;
	targetBranch: string;
}

interface Env {
	root: string;
	handle: ProjectDbHandle;
	bus: EventBus;
	registry: RunRegistry;
	tasks: TaskService;
	clarify: ClarifyService;
	runner: StepRunner;
	brain: BrainPort;
	notifications: Notification[];
	merges: MergeJob[];
	spawns: { parent: string; child: string }[];
	/** What the fake leftover scan finds; tests set it before finalizing. */
	leftovers: LeftoverProcess[];
	/** Every list handed to the fake stop. */
	stopped: LeftoverProcess[][];
	makeRunner: (patch?: Partial<StepRunnerDeps>) => StepRunner;
	cleanup: () => Promise<void>;
}

async function makeEnv(
	configOverrides: {
		mergeChecks?: DefinitionOfDone | null;
		draftExpandMaxAttempts?: number;
	} = {},
): Promise<Env> {
	const { mergeChecks, ...stepRunnerConfig } = configOverrides;
	const root = await mkdtemp(join(tmpdir(), "mfw-sr-"));
	await git(["init", "-q", "-b", "main"], root);
	await git(["config", "user.email", "t@t"], root);
	await git(["config", "user.name", "t"], root);
	await writeFile(join(root, "base.txt"), "base\n");
	await git(["add", "-A"], root);
	await git(["commit", "-q", "-m", "init"], root);
	await writeFile(
		join(root, ".git/info/exclude"),
		".mfw/\nworktrees/\nMFW_REPORT.json\n",
	);

	const mfwDir = join(root, ".mfw");
	const handle = await openProjectDb(mfwDir);
	const bus = new EventBus();
	const registry = new RunRegistry({
		handle,
		bus,
		runsDir: join(mfwDir, "runs"),
	});
	const tasks = await makeTasks(handle, bus, mfwDir, "MFW", mergeChecks);
	// Real services, not stubs: create_specs must write a real `spec.md`, and the clarify writer is under test.
	const clarify = new ClarifyService({ handle, bus, log: silentLogger() });

	const notifications: Notification[] = [];
	const merges: MergeJob[] = [];
	const spawns: { parent: string; child: string }[] = [];
	// Never scan the real /proc from a test: a fake with scripted findings.
	const leftovers: LeftoverProcess[] = [];
	const stopped: LeftoverProcess[][] = [];
	const brain: BrainPort = {
		enabled: false,
		critic: async () => ({ status: "ok", flagged: false }),
		replan: async () => ({ status: "ok", action: "escalate" }),
		importReview: async () => ({ status: "ok", approved: true }),
	};

	const baseDeps: StepRunnerDeps = {
		handle,
		bus,
		registry,
		tasks,
		clarify,
		mergeQueue: {
			enqueue: async (job) => {
				merges.push(job);
			},
		},
		host: new AgentHost(),
		brain,
		notifier: {
			notify: async (kind, detail) => {
				notifications.push({ kind, detail });
			},
		},
		projectRoot: root,
		log: silentLogger(),
		config: {
			maxStalls: 3,
			maxResumes: 2,
			draftExpandMaxAttempts: 3,
			// Default DoD for runs without their own. `mergeChecks` is applied separately below so tests can pass `null`.
			mergeChecks: {
				verifier: "deterministic",
				checks: [{ diff_against_base: true }],
			},
			...stepRunnerConfig,
			// `null` means "the project has no default"; only the task service sees that, the StepRunner always needs one.
			...(mergeChecks ? { mergeChecks } : {}),
		},
		spawnRepair: async (parent, child) => {
			spawns.push({ parent, child });
		},
		spawnResume: async (parent, child) => {
			spawns.push({ parent, child });
		},
		leftovers: {
			find: async () => [...leftovers],
			stop: async (list) => {
				stopped.push([...list]);
				leftovers.splice(0);
				return {
					stopped: list.map((p) => p.pid),
					killed: [],
					absent: list.map((p) => p.pid),
					live: [],
					unknown: [],
				};
			},
		},
	};
	const makeRunner = (patch: Partial<StepRunnerDeps> = {}) =>
		new StepRunner({ ...baseDeps, ...patch });

	return {
		root,
		handle,
		bus,
		registry,
		tasks,
		clarify,
		runner: makeRunner(),
		brain,
		notifications,
		merges,
		spawns,
		leftovers,
		stopped,
		makeRunner,
		cleanup: async () => {
			handle.close();
			await rm(root, { recursive: true, force: true });
		},
	};
}

interface Worktree {
	path: string;
	branch: string;
	baseSha: string;
}

async function addWorktree(root: string, name: string): Promise<Worktree> {
	return new WorktreeManager(root).create(name, "main");
}

async function commitIn(
	wt: string,
	file: string,
	content: string,
): Promise<void> {
	await writeFile(join(wt, file), content);
	await git(["add", "-A"], wt);
	await git(["commit", "-q", "-m", `work: ${file}`], wt);
}

/** Run row in state "ended" (what the supervisor hands to the StepRunner). */
async function seedRun(
	env: Env,
	spec: {
		kind: RunKind;
		/** Must match the id `claimedTask` used for the lease (release() is keyed on it). */
		runId?: string;
		taskId?: string;
		wt?: Worktree;
		events?: string;
		exit?: string;
		report?: unknown;
	},
): Promise<RunRow> {
	const run = await env.registry.create({
		kind: spec.kind,
		...(spec.runId ? { id: spec.runId } : {}),
		...(spec.taskId ? { taskId: spec.taskId } : {}),
		label: `${spec.kind} run`,
		model: "sonnet",
		cwd: spec.wt?.path ?? env.root,
		...(spec.wt
			? {
					worktreePath: spec.wt.path,
					branch: spec.wt.branch,
					baseSha: spec.wt.baseSha,
				}
			: {}),
		integrationBranch: "main",
	});
	const dir = env.registry.runDir(run.id);
	if (spec.events !== undefined)
		await writeFile(join(dir, "events.jsonl"), spec.events);
	if (spec.exit !== undefined) await writeFile(join(dir, "exit"), spec.exit);
	if (spec.report !== undefined) {
		await writeFile(
			join(dir, "MFW_REPORT.json"),
			JSON.stringify(spec.report, null, 2),
		);
	}
	await env.registry.transition(run.id, "running");
	await env.registry.transition(run.id, "ended");
	return run;
}

let seq = 0;
function ev(e: Record<string, unknown>): string {
	seq += 1;
	return `${JSON.stringify({ ts: new Date().toISOString(), seq, ...e })}\n`;
}

const doneEvent = (resultText?: string) =>
	ev({
		type: "done",
		reason: "complete",
		...(resultText ? { resultText } : {}),
	});

async function journal(env: Env, runId: string): Promise<string[]> {
	return (await env.registry.steps(runId)).map((s) => s.step);
}

const PASSING_DOD = {
	verifier: "deterministic" as const,
	checks: [{ run: "true", expect_exit: 0 }],
};
const FAILING_DOD = {
	verifier: "deterministic" as const,
	checks: [{ run: "false", expect_exit: 0 }],
};
/** SIGSEGV every time, so `verify()` reports `crashed: true` rather than a failure. */
const CRASHING_DOD = {
	verifier: "deterministic" as const,
	checks: [{ run: "kill -11 $$", expect_exit: 0 }],
};

/** ready → claimed (in_progress) with the run holding the lease. */
async function claimedTask(
	env: Env,
	runIdPlaceholder: string,
	opts: {
		title: string;
		dod?: typeof PASSING_DOD | null;
		labels?: string[];
	},
): Promise<string> {
	const t = await env.tasks.create({
		title: opts.title,
		status: "ready",
		dod: opts.dod ?? null,
		labels: opts.labels ?? [],
	});
	expect(await env.tasks.tryClaim(t.id, runIdPlaceholder, 60_000)).toBe(true);
	return t.id;
}

describe("StepRunner v2: finalization end to end", () => {
	test("(a) verified task run enqueues a merge and parks the run in `merging` (T16)", async () => {
		const env = await makeEnv();
		env.brain.enabled = true;
		const wt = await addWorktree(env.root, "t-a");
		await commitIn(wt.path, "a.txt", "work\n");
		const runId = ulid();
		const taskId = await claimedTask(env, runId, {
			title: "verified work",
			dod: PASSING_DOD,
		});
		const run = await seedRun(env, {
			kind: "task",
			runId,
			taskId,
			wt,
			events: doneEvent("all done"),
			exit: "exit:0",
			report: { summary: "did the work" },
		});

		await env.runner.finalize(run.id);

		expect(await journal(env, run.id)).toEqual([
			"classify",
			"reap_leftovers",
			"ingest_report",
			"verify",
			"critic",
			"clear_stall",
			"enqueue_merge",
		]);
		const row = await env.registry.get(run.id);
		expect(row?.state).toBe("merging");
		expect(row?.outcome).toBe("completed");
		expect(env.merges).toEqual([
			{ runId: run.id, taskId, branch: wt.branch, targetBranch: "main" },
		]);
		// The merge queue owns the task from here.
		expect((await env.tasks.get(taskId))?.status).toBe("in_progress");
		await env.cleanup();
	});

	test("remote collection failure is durable result evidence and cannot reach verify or merge", async () => {
		const env = await makeEnv();
		const wt = await addWorktree(env.root, "collection-failed");
		const runId = ulid();
		const taskId = await claimedTask(env, runId, {
			title: "remote output was not collected",
			dod: PASSING_DOD,
		});
		const run = await seedRun(env, {
			kind: "task",
			runId,
			taskId,
			wt,
			events: doneEvent("remote said complete"),
			exit: "exit:0",
		});
		await env.registry.recordTargetLifecycle({
			runId,
			operationId: `${runId}/collect/failed`,
			phase: "collect",
			status: "failed",
			lifecycleState: "cleanup_pending",
			targetKind: "runpod",
			detail: { code: "collection_failed" },
		});
		await env.registry.recordTargetLifecycle({
			runId,
			operationId: `${runId}/dispose/completed`,
			phase: "dispose",
			status: "completed",
			lifecycleState: "absent",
			targetKind: "runpod",
		});

		await env.runner.finalize(run.id);
		expect((await env.registry.get(run.id))?.outcome).toBe("interrupted");
		expect(await journal(env, run.id)).not.toContain("verify");
		expect(env.merges).toEqual([]);
		await env.cleanup();
	});

	test("(b) watchdog kill stalls the task, blocks it, notifies and gcs a clean worktree (T4)", async () => {
		const env = await makeEnv();
		const wt = await addWorktree(env.root, "t-b");
		const runId = ulid();
		const taskId = await claimedTask(env, runId, { title: "idle agent" });
		const run = await seedRun(env, {
			kind: "task",
			runId,
			taskId,
			wt,
			events: ev({ type: "message", role: "assistant", text: "thinking" }),
			exit: "killed:watchdog-idle",
			report: { summary: "no code changes before timeout" },
		});

		await env.runner.finalize(run.id);

		expect(await journal(env, run.id)).toEqual([
			"classify",
			"reap_leftovers",
			"ingest_report",
			"bump_stall",
			"release_task",
			"notify",
			"gc_worktree",
		]);
		const task = await env.tasks.get(taskId);
		expect(task?.status).toBe("blocked");
		expect(task?.stallCount).toBe(1);
		expect(env.notifications.map((n) => n.kind)).toEqual(["blocked"]);
		const row = await env.registry.get(run.id);
		expect(row?.state).toBe("killed");
		expect(row?.killReason).toBe("watchdog-idle");
		// The report is already captured by ingest_report, so it does not make the worktree dirty.
		expect(existsSync(wt.path)).toBe(false);
		await env.cleanup();
	});

	test("(c) a step that throws resumes from the journal without re-running earlier steps", async () => {
		const env = await makeEnv();
		const wt = await addWorktree(env.root, "t-c");
		await commitIn(wt.path, "c.txt", "work\n");
		const counter = join(env.root, "verify-count.txt");
		const runId = ulid();
		const t = await env.tasks.create({
			title: "counted verify",
			status: "ready",
			requireReview: true, // T15 review gate → release_task(review)
			dod: {
				verifier: "deterministic",
				checks: [{ run: `printf x >> ${counter}`, expect_exit: 0 }],
			},
		});
		expect(await env.tasks.tryClaim(t.id, runId, 60_000)).toBe(true);
		const run = await seedRun(env, {
			kind: "task",
			runId,
			taskId: t.id,
			wt,
			events: doneEvent("done"),
			exit: "exit:0",
		});

		// First pass: release_task throws (crash between verify and release).
		let released = 0;
		const flaky = Object.create(env.tasks) as TaskService;
		flaky.release = async (...args: Parameters<TaskService["release"]>) => {
			released += 1;
			if (released === 1) throw new Error("boom: disk full");
			return TaskService.prototype.release.apply(env.tasks, args);
		};
		await env.makeRunner({ tasks: flaky }).finalize(run.id);

		expect(await readFile(counter, "utf8")).toBe("x"); // verify ran once
		const failed = (await env.registry.steps(run.id)).find(
			(s) => s.step === "release_task",
		);
		expect(failed?.status).toBe("failed");
		expect((await env.registry.get(run.id))?.state).toBe("finalizing");

		// Second pass with a healthy service: done steps are folded, not re-run.
		await env.runner.finalize(run.id);

		expect(await readFile(counter, "utf8")).toBe("x"); // still exactly once
		expect(await journal(env, run.id)).toEqual([
			"classify",
			"reap_leftovers",
			"ingest_report",
			"verify",
			"clear_stall",
			"release_task",
			"notify",
		]);
		expect((await env.tasks.get(t.id))?.status).toBe("review");
		expect((await env.registry.get(run.id))?.state).toBe("completed");
		await env.cleanup();
	});

	test("(d) a rate-limited run holds dispatch and requeues the task without consuming an attempt (T1)", async () => {
		const env = await makeEnv();
		const wt = await addWorktree(env.root, "t-d");
		await commitIn(wt.path, "d.txt", "partial\n");
		const runId = ulid();
		const taskId = await claimedTask(env, runId, { title: "limited" });
		const resetsAtSec = Math.floor((Date.now() + 3_600_000) / 1000);
		const run = await seedRun(env, {
			kind: "task",
			runId,
			taskId,
			wt,
			events:
				ev({
					type: "rate_limit",
					status: "allowed",
					limited: false,
					resetsAt: null,
				}) +
				ev({
					type: "rate_limit",
					status: "limited",
					limited: true,
					resetsAt: resetsAtSec,
				}),
			exit: "exit:1",
		});

		await env.runner.finalize(run.id);

		expect(await journal(env, run.id)).toEqual([
			"classify",
			"reap_leftovers",
			"ingest_report",
			"hold_rate_limit",
			"release_task",
		]);
		const [hold] = await env.handle.db
			.select()
			.from(engineKv)
			.where(eq(engineKv.key, "dispatch_hold"));
		expect((hold?.value as { until: number }).until).toBe(resetsAtSec * 1000);
		const task = await env.tasks.get(taskId);
		expect(task?.status).toBe("ready");
		expect(task?.stallCount).toBe(0);
		expect(task?.attemptCount).toBe(0); // no attempt consumed
		expect(task?.preservedWorktree).toBe(wt.path); // dirty work kept for resume
		const row = await env.registry.get(run.id);
		expect(row?.state).toBe("rate_limited");
		expect(row?.outcome).toBe("rate_limited");
		expect(existsSync(wt.path)).toBe(true);
		await env.cleanup();
	});

	test("(e) failed verification bumps the stall, asks the brain and escalates to a human (T24)", async () => {
		const env = await makeEnv();
		env.brain.enabled = true;
		const replanCalls: string[] = [];
		env.brain.replan = async (ctx) => {
			replanCalls.push(ctx.runId);
			return { status: "ok", action: "escalate", reason: "needs a human" };
		};
		const wt = await addWorktree(env.root, "t-e");
		await commitIn(wt.path, "e.txt", "half done\n");
		const runId = ulid();
		const taskId = await claimedTask(env, runId, {
			title: "broken work",
			dod: FAILING_DOD,
		});
		const run = await seedRun(env, {
			kind: "task",
			runId,
			taskId,
			wt,
			events: doneEvent("I think it works"),
			exit: "exit:0",
		});

		await env.runner.finalize(run.id);

		expect(await journal(env, run.id)).toEqual([
			"classify",
			"reap_leftovers",
			"ingest_report",
			"verify",
			"bump_stall",
			"replan_decide",
			"release_task",
			"notify",
		]);
		expect(replanCalls).toEqual([run.id]);
		const task = await env.tasks.get(taskId);
		expect(task?.status).toBe("blocked");
		expect(task?.stallCount).toBe(1);
		expect(env.notifications.map((n) => n.kind)).toEqual(["blocked"]);
		const row = await env.registry.get(run.id);
		expect(row?.state).toBe("failed");
		expect(row?.note).toBe("escalated to human: brain said escalate");
		expect(env.merges).toEqual([]);
		await env.cleanup();
	});

	test("(e-mfw59) escalating to blocked (T24) raises a pre-loaded session", async () => {
		const env = await makeEnv();
		env.brain.enabled = true;
		env.brain.replan = async () => ({
			status: "ok",
			action: "escalate",
			reason: "needs a human",
		});
		const wt = await addWorktree(env.root, "t-e59");
		await commitIn(wt.path, "e59.txt", "half done\n");
		const runId = ulid();
		const taskId = await claimedTask(env, runId, {
			title: "broken work",
			dod: FAILING_DOD,
		});
		const run = await seedRun(env, {
			kind: "task",
			runId,
			taskId,
			wt,
			events: doneEvent("I think it works"),
			exit: "exit:0",
		});

		const raised: unknown[] = [];
		const runner = env.makeRunner({
			sessions: {
				raise: async (input) => {
					raised.push(input);
					return { id: "sess-1" };
				},
			},
		});
		await runner.finalize(run.id);

		expect(raised).toHaveLength(1);
		expect(raised[0]).toMatchObject({
			source: "blocked",
			sourceKey: taskId,
			taskId,
			runId: run.id,
			summary: "escalated to human: brain said escalate",
		});
		const whatWasTried = (raised[0] as { whatWasTried: string[] }).whatWasTried;
		expect(whatWasTried.join(" ")).toContain("attempt 1 of");
		expect((raised[0] as { hypothesis: string }).hypothesis).toContain(
			'"escalate"',
		);
		await env.cleanup();
	});

	test("(b-mfw59) a watchdog-killed run (T4, no verify step) still raises a session", async () => {
		const env = await makeEnv();
		const wt = await addWorktree(env.root, "t-b59");
		const runId = ulid();
		const taskId = await claimedTask(env, runId, { title: "idle agent" });
		const run = await seedRun(env, {
			kind: "task",
			runId,
			taskId,
			wt,
			events: ev({ type: "message", role: "assistant", text: "thinking" }),
			exit: "killed:watchdog-idle",
		});

		const raised: unknown[] = [];
		const runner = env.makeRunner({
			sessions: {
				raise: async (input) => {
					raised.push(input);
					return { id: "sess-2" };
				},
			},
		});
		await runner.finalize(run.id);

		expect(raised).toHaveLength(1);
		expect(raised[0]).toMatchObject({
			source: "blocked",
			taskId,
			runId: run.id,
		});
		await env.cleanup();
	});

	test("(e2) a check killed by a signal is not blamed on the task and is recorded loudly (T12i, MFW-47)", async () => {
		const env = await makeEnv();
		const wt = await addWorktree(env.root, "t-e2");
		await commitIn(wt.path, "e2.txt", "half done\n");
		const runId = ulid();
		const taskId = await claimedTask(env, runId, {
			title: "unlucky work",
			dod: CRASHING_DOD,
		});
		const run = await seedRun(env, {
			kind: "task",
			runId,
			taskId,
			wt,
			events: doneEvent("done"),
			exit: "exit:0",
		});

		await env.runner.finalize(run.id);

		expect(await journal(env, run.id)).toEqual([
			"classify",
			"reap_leftovers",
			"ingest_report",
			"verify",
			"release_task",
		]);
		const task = await env.tasks.get(taskId);
		// Not blamed: back to ready, no stall or attempt consumed, dirty worktree kept for resume.
		expect(task?.status).toBe("ready");
		expect(task?.stallCount).toBe(0);
		expect(task?.attemptCount).toBe(0);
		expect(task?.preservedWorktree).toBe(wt.path);
		const row = await env.registry.get(run.id);
		expect(row?.state).toBe("failed");
		expect(row?.note).toBe("verify crashed: infrastructure, not a regression");
		expect(env.merges).toEqual([]);

		// Loud: same escalating alarm as the regression sweep's infra path.
		const [infraRow] = await env.handle.db
			.select()
			.from(engineKv)
			.where(eq(engineKv.key, "verify_infra"));
		const infra = infraRow?.value as {
			active?: boolean;
			attempts?: number;
			taskIds?: string[];
		};
		expect(infra?.active).toBe(true);
		expect(infra?.attempts).toBe(1);
		expect(infra?.taskIds).toEqual([taskId]);
		await env.cleanup();
	});

	test("(f) an import run that proposed nothing fails without a merge (I3)", async () => {
		const env = await makeEnv();
		const wt = await addWorktree(env.root, "t-f");
		const run = await seedRun(env, {
			kind: "import",
			wt,
			events: doneEvent("I looked around but found nothing to do."),
			exit: "exit:0",
		});

		await env.runner.finalize(run.id);

		expect(await journal(env, run.id)).toEqual([
			"classify",
			"reap_leftovers",
			"parse_plan",
			"ingest_report",
			"gc_worktree",
		]);
		const row = await env.registry.get(run.id);
		expect(row?.state).toBe("failed");
		expect(row?.note).toBe("importer proposed nothing");
		expect(env.merges).toEqual([]);
		await env.cleanup();
	});

	test("(f2) an import proposal lands on the board, not in a merge (I7)", async () => {
		const env = await makeEnv();
		const wt = await addWorktree(env.root, "t-f2");
		const proposal = {
			tasks: [
				{ title: "Delete the dead adapter", body: "it has no callers" },
				{ title: "Document the deploy", body: "nobody knows the steps" },
			],
		};
		const run = await seedRun(env, {
			kind: "import",
			wt,
			events: doneEvent(
				`Here you go:\n\n\`\`\`json\n${JSON.stringify(proposal)}\n\`\`\``,
			),
			exit: "exit:0",
		});

		await env.runner.finalize(run.id);

		// Opts out of the brain, so I7 is reached directly.
		expect(await journal(env, run.id)).toEqual([
			"classify",
			"reap_leftovers",
			"parse_plan",
			"create_tasks",
			"gc_worktree",
		]);
		expect(env.merges).toEqual([]);
		const created = (await env.tasks.list()).filter(
			(t) => t.source === "importer",
		);
		expect(created.map((t) => t.title)).toEqual([
			"Delete the dead adapter",
			"Document the deploy",
		]);
		await env.cleanup();
	});

	test("(f3) an import files each spec as a container task's spec.md (I7)", async () => {
		// create_specs turns the proposal into an epic whose `spec.md` is shared by the child tasks.
		const env = await makeEnv();
		const wt = await addWorktree(env.root, "t-f3");
		const proposal = {
			tasks: [
				{ title: "Delete the dead adapter" },
				{ title: "Document the deploy" },
			],
			specs: [
				{
					title: "Adapter architecture",
					body: "Adapters are resolved through the catalogue.",
					// Positional: ids do not exist until create_tasks runs.
					tasks: [0, 1],
				},
			],
		};
		const run = await seedRun(env, {
			kind: "import",
			wt,
			events: doneEvent(JSON.stringify(proposal)),
			exit: "exit:0",
		});

		await env.runner.finalize(run.id);

		expect(await journal(env, run.id)).toEqual([
			"classify",
			"reap_leftovers",
			"parse_plan",
			"create_tasks",
			"create_specs",
			"gc_worktree",
		]);
		const all = await env.tasks.list();
		const containers = all.filter((t) => t.type === "epic");
		expect(containers.map((t) => t.title)).toEqual(["Adapter architecture"]);
		const [container] = containers;
		if (!container) throw new Error("no container task");
		// Held in the backlog by manual readiness, so it is never dispatched.
		expect(container.status).toBe("backlog");
		expect(container.readyMode).toBe("manual");
		expect((await env.tasks.getSpec(container.id))?.body).toBe(
			"Adapters are resolved through the catalogue.",
		);
		// The children's `parent` is the ONLY place the link lives.
		const children = all.filter((t) => t.parentId === container.id);
		expect(children.map((t) => t.title).sort()).toEqual([
			"Delete the dead adapter",
			"Document the deploy",
		]);
		await env.cleanup();
	});

	test("(f3b) a repeated import reuses the existing container and never overwrites its spec", async () => {
		const env = await makeEnv();
		const existing = await env.tasks.create({
			title: "Adapter architecture",
			type: "epic",
			status: "backlog",
			readyMode: "manual",
		});
		await env.tasks.setSpec(existing.id, "The durable design already exists.");
		const wt = await addWorktree(env.root, "t-f3b");
		const run = await seedRun(env, {
			kind: "import",
			wt,
			events: doneEvent(
				JSON.stringify({
					tasks: [{ title: "Document the adapter" }],
					specs: [
						{
							title: "Adapter architecture",
							body: "A duplicate summary that must not overwrite the original.",
							tasks: [0],
						},
					],
				}),
			),
			exit: "exit:0",
		});

		await env.runner.finalize(run.id);

		const all = await env.tasks.list();
		expect(all.filter((t) => t.type === "epic")).toHaveLength(1);
		const task = all.find((t) => t.title === "Document the adapter");
		if (!task) throw new Error("imported task was not created");
		expect(task.parentId).toBe(existing.id);
		expect((await env.tasks.getSpec(existing.id))?.body).toBe(
			"The durable design already exists.",
		);
		await env.cleanup();
	});

	test("(f4) imported task statuses come from the report, not from a constant", async () => {
		const env = await makeEnv();
		const wt = await addWorktree(env.root, "t-f4");
		const proposal = {
			tasks: [
				{ title: "Ship the parser", status: "done" },
				{ title: "Wire the UI", status: "in_progress" },
				{ title: "Rewrite the docs", status: "blocked" },
				{ title: "Nothing stated" },
				{ title: "Nonsense status", status: "quantum" },
			],
		};
		const run = await seedRun(env, {
			kind: "import",
			wt,
			events: doneEvent(JSON.stringify(proposal)),
			exit: "exit:0",
		});

		await env.runner.finalize(run.id);

		const byTitle = new Map(
			(await env.tasks.list()).map((t) => [t.title, t.status]),
		);
		expect(byTitle.get("Ship the parser")).toBe("done");
		// `in_progress` is not importable: nothing holds its claim, so the
		// scheduler would never dispatch it and the groomer would never free it.
		expect(byTitle.get("Wire the UI")).toBe("ready");
		expect(byTitle.get("Rewrite the docs")).toBe("blocked");
		expect(byTitle.get("Nothing stated")).toBe("backlog");
		expect(byTitle.get("Nonsense status")).toBe("backlog");
		await env.cleanup();
	});

	test("(f5) a PLAN may not state a status: nothing it proposes exists yet", async () => {
		const env = await makeEnv();
		const wt = await addWorktree(env.root, "t-f5");
		const proposal = { tasks: [{ title: "Already done?", status: "done" }] };
		const run = await seedRun(env, {
			kind: "plan",
			wt,
			events: doneEvent(JSON.stringify(proposal)),
			exit: "exit:0",
		});

		await env.runner.finalize(run.id);

		expect((await env.tasks.list())[0]?.status).toBe("backlog");
		await env.cleanup();
	});

	test("(f6) a plan's questions are persisted and drive exactly one clarify ping", async () => {
		const env = await makeEnv();
		const wt = await addWorktree(env.root, "t-f6");
		const proposal = {
			tasks: [{ title: "Add billing" }],
			questions: ["Stripe or Adyen?", "  ", "Do we invoice in EUR?"],
		};
		const run = await env.registry.create({
			kind: "plan",
			label: "plan run",
			model: "sonnet",
			cwd: wt.path,
			worktreePath: wt.path,
			branch: wt.branch,
			baseSha: wt.baseSha,
			integrationBranch: "main",
			goal: "Add billing to the product",
		});
		await writeFile(
			join(env.registry.runDir(run.id), "events.jsonl"),
			doneEvent(JSON.stringify(proposal)),
		);
		await writeFile(join(env.registry.runDir(run.id), "exit"), "exit:0");
		await env.registry.transition(run.id, "running");
		await env.registry.transition(run.id, "ended");

		await env.runner.finalize(run.id);

		expect(await journal(env, run.id)).toEqual([
			"classify",
			"reap_leftovers",
			"parse_plan",
			"record_questions",
			"notify",
			"gc_worktree",
		]);
		expect(await env.tasks.list()).toEqual([]);
		const open = await env.clarify.list({ open: true });
		expect(open).toHaveLength(1);
		expect(open[0]?.kind).toBe("planner");
		expect(open[0]?.goal).toBe("Add billing to the product");
		// The blank entry is dropped rather than becoming a question nobody can
		// answer and that therefore never resolves.
		expect(open[0]?.items.map((i) => i.question)).toEqual([
			"Stripe or Adyen?",
			"Do we invoice in EUR?",
		]);
		expect(env.notifications.map((n) => n.kind)).toEqual(["clarify"]);
		await env.cleanup();
	});

	test("(f7) re-running create_specs after a lost journal row reuses the container", async () => {
		const env = await makeEnv();
		const wt = await addWorktree(env.root, "t-f7");
		const proposal = {
			tasks: [{ title: "One task" }],
			specs: [{ title: "One spec", body: "text", tasks: [0] }],
		};
		const run = await seedRun(env, {
			kind: "import",
			wt,
			events: doneEvent(JSON.stringify(proposal)),
			exit: "exit:0",
		});

		await env.runner.finalize(run.id);
		const first = (await env.tasks.list()).filter((t) => t.type === "epic");
		expect(first).toHaveLength(1);

		// Crash between the create_specs effect and its journal row.
		await env.handle.db
			.delete(runSteps)
			.where(
				and(eq(runSteps.runId, run.id), eq(runSteps.step, "create_specs")),
			);
		await env.handle.db
			.update(runs)
			.set({ state: "finalizing", finishedAt: null })
			.where(eq(runs.id, run.id));

		await env.runner.finalize(run.id);

		const after = (await env.tasks.list()).filter((t) => t.type === "epic");
		expect(after.map((t) => t.id)).toEqual(first.map((t) => t.id));
		await env.cleanup();
	});

	test("(g) a plan run creates its tasks once, re-finalization never duplicates them (P3)", async () => {
		const env = await makeEnv();
		const wt = await addWorktree(env.root, "t-g");
		const plan = {
			tasks: [
				{
					title: "Alpha",
					body: "first",
					dod: {
						verifier: "deterministic",
						checks: [{ run: "true", expect_exit: 0 }],
					},
				},
				{ title: "Beta", depends_on: [0] },
			],
		};
		const run = await seedRun(env, {
			kind: "plan",
			wt,
			events: doneEvent(`Here is the plan:\n${JSON.stringify(plan)}\nthanks!`),
			exit: "exit:0",
		});

		await env.runner.finalize(run.id);

		// No `notify`: this plan asked no questions, and the clarify ping is
		// gated on there being some.
		expect(await journal(env, run.id)).toEqual([
			"classify",
			"reap_leftovers",
			"parse_plan",
			"create_tasks",
			"gc_worktree",
		]);
		const created = await env.tasks.list();
		expect(created.map((t) => t.title)).toEqual(["Alpha", "Beta"]);
		expect(created.every((t) => t.source === "planner")).toBe(true);
		expect(created.every((t) => t.status === "backlog")).toBe(true);
		const alpha = created[0];
		expect(created[1]?.dependsOn).toEqual([alpha?.id ?? ""]);
		expect((await env.registry.get(run.id))?.state).toBe("completed");
		expect(existsSync(wt.path)).toBe(false); // plan worktrees are always gc'd

		// Crash between the create_tasks effect and its journal row: drop the row and re-drive.
		// The title+source guard must reuse, not duplicate.
		await env.handle.db
			.delete(runSteps)
			.where(
				and(eq(runSteps.runId, run.id), eq(runSteps.step, "create_tasks")),
			);
		await env.handle.db
			.update(runs)
			.set({ state: "finalizing", finishedAt: null })
			.where(eq(runs.id, run.id));

		await env.runner.finalize(run.id);

		const after = await env.tasks.list();
		expect(after.map((t) => t.id)).toEqual(created.map((t) => t.id));
		expect((await env.registry.get(run.id))?.state).toBe("completed");
		await env.cleanup();
	});

	describe("MFW-49: a plan run expanding a draft task", () => {
		test("success applies the first entry to the SAME task, in place, and clears draft", async () => {
			const env = await makeEnv();
			const wt = await addWorktree(env.root, "t-draft-ok");
			const draft = await env.tasks.captureQuick("build the thing");
			const plan = {
				tasks: [
					{
						title: "Build the thing properly",
						body: "A fleshed-out description.",
						dod: {
							verifier: "deterministic",
							checks: [{ run: "true", expect_exit: 0 }],
						},
						criteria: ["it works"],
						owns: ["src/**"],
						model_tier: "strong",
					},
				],
			};
			const run = await seedRun(env, {
				kind: "plan",
				taskId: draft.id,
				wt,
				events: doneEvent(JSON.stringify(plan)),
				exit: "exit:0",
			});
			expect(
				await env.tasks.tryClaimDraftExpansion(draft.id, run.id, 60_000),
			).toBe(true);

			await env.runner.finalize(run.id);

			expect(await journal(env, run.id)).toEqual([
				"classify",
				"reap_leftovers",
				"parse_plan",
				"create_tasks",
				"gc_worktree",
			]);
			// Exactly one task: expansion edits the draft rather than creating a second card.
			const all = await env.tasks.list();
			expect(all.map((t) => t.id)).toEqual([draft.id]);
			const after = await env.tasks.get(draft.id);
			expect(after?.status).toBe("ready");
			expect(after?.owns).toEqual(["src/**"]);
			expect(after?.modelTier).toBe("strong");
			expect(after?.title).toBe("Build the thing properly");
			expect(after?.body).toBe("A fleshed-out description.");
			expect(after?.dod).toEqual({
				verifier: "deterministic",
				checks: [{ run: "true", expect_exit: 0 }],
			});
			expect(after?.criteria).toEqual([{ text: "it works", checked: false }]);
			// The raw capture survives the expansion for diagnosis/re-expansion.
			expect(after?.draftPrompt).toBe("build the thing");
			await env.cleanup();
		});

		test("questions keep the same draft intact and create no provisional DAG", async () => {
			const env = await makeEnv();
			const wt = await addWorktree(env.root, "t-draft-clarify");
			const draft = await env.tasks.captureQuick("add billing");
			const run = await seedRun(env, {
				kind: "plan",
				taskId: draft.id,
				wt,
				events: doneEvent(
					JSON.stringify({
						tasks: [{ title: "Provisional billing task" }],
						questions: ["Stripe or Adyen?"],
					}),
				),
				exit: "exit:0",
			});
			expect(
				await env.tasks.tryClaimDraftExpansion(draft.id, run.id, 60_000),
			).toBe(true);

			await env.runner.finalize(run.id);

			expect(await journal(env, run.id)).toEqual([
				"classify",
				"reap_leftovers",
				"parse_plan",
				"record_questions",
				"notify",
				"release_task",
				"gc_worktree",
			]);
			const all = await env.tasks.list();
			expect(all).toHaveLength(1);
			expect(all[0]?.id).toBe(draft.id);
			expect(all[0]?.status).toBe("draft");
			expect(all[0]?.title).toBe(draft.title);
			expect(all[0]?.claimedByRunId).toBeNull();
			await env.cleanup();
		});

		test("an entry with no task checks remains empty instead of copying project policy", async () => {
			const env = await makeEnv();
			const wt = await addWorktree(env.root, "t-draft-nodod");
			const draft = await env.tasks.captureQuick("build the other thing");
			const plan = { tasks: [{ title: "Build the other thing" }] };
			const run = await seedRun(env, {
				kind: "plan",
				taskId: draft.id,
				wt,
				events: doneEvent(JSON.stringify(plan)),
				exit: "exit:0",
			});
			expect(
				await env.tasks.tryClaimDraftExpansion(draft.id, run.id, 60_000),
			).toBe(true);

			await env.runner.finalize(run.id);

			const after = await env.tasks.get(draft.id);
			expect(after?.status).toBe("ready");
			expect(after?.verification).toBeNull();
			await env.cleanup();
		});

		test("an unparseable proposal bumps the attempt counter but leaves the draft dispatchable-pending, below the cap", async () => {
			const env = await makeEnv({ draftExpandMaxAttempts: 3 });
			const wt = await addWorktree(env.root, "t-draft-fail");
			const draft = await env.tasks.captureQuick("do the thing");
			const run = await seedRun(env, {
				kind: "plan",
				taskId: draft.id,
				wt,
				events: doneEvent("not json at all"),
				exit: "exit:0",
			});
			expect(
				await env.tasks.tryClaimDraftExpansion(draft.id, run.id, 60_000),
			).toBe(true);

			await env.runner.finalize(run.id);

			expect(await journal(env, run.id)).toEqual([
				"classify",
				"reap_leftovers",
				"parse_plan",
				"draft_expand_failed",
				"gc_worktree",
			]);
			const after = await env.tasks.get(draft.id);
			expect(after?.status).toBe("draft");
			expect(after?.draftPhase).toBe("retrying");
			expect(after?.draftAttempts).toBe(1);
			expect(after?.dod).toBeNull();
			expect(env.notifications).toEqual([]);
			await env.cleanup();
		});

		test("bounded retries exhausted: draft stays failed and a human is told once", async () => {
			const env = await makeEnv({ draftExpandMaxAttempts: 1 });
			const wt = await addWorktree(env.root, "t-draft-exhausted");
			const draft = await env.tasks.captureQuick("do the thing");
			const run = await seedRun(env, {
				kind: "plan",
				taskId: draft.id,
				wt,
				events: doneEvent("still not json"),
				exit: "exit:0",
			});
			expect(
				await env.tasks.tryClaimDraftExpansion(draft.id, run.id, 60_000),
			).toBe(true);

			await env.runner.finalize(run.id);

			const after = await env.tasks.get(draft.id);
			expect(after?.status).toBe("draft");
			expect(after?.draftPhase).toBe("failed");
			expect(after?.verification).toBeNull();
			expect(env.notifications).toEqual([
				{ kind: "draft_expand_exhausted", detail: { taskId: draft.id } },
			]);
			await env.cleanup();
		});

		test("an explicit backlog capture stays in backlog after expansion", async () => {
			const env = await makeEnv();
			const wt = await addWorktree(env.root, "t-draft-held");
			const draft = await env.tasks.captureQuick(
				"do this later",
				"held-capture",
				"backlog",
				true,
			);
			const run = await seedRun(env, {
				kind: "plan",
				taskId: draft.id,
				wt,
				events: doneEvent(
					JSON.stringify({
						tasks: [{ title: "Do this later", criteria: ["It is done"] }],
					}),
				),
				exit: "exit:0",
			});
			expect(
				await env.tasks.tryClaimDraftExpansion(draft.id, run.id, 60_000),
			).toBe(true);

			await env.runner.finalize(run.id);

			const after = await env.tasks.get(draft.id);
			expect(after?.status).toBe("backlog");
			expect(after?.afterExpansion).toBe("backlog");
			expect(after?.readyMode).toBe("manual");
			expect(after?.requireReview).toBe(true);
			expect(await env.tasks.promoteReady()).toEqual([]);
			await env.cleanup();
		});

		test("a draft archived while its expansion run is still finalizing (successful plan) is not resurrected", async () => {
			// archiveDraft needs the claim gone, which happens when `groom` reclaims an orphaned claim.
			// Simulate: release the claim, archive the task, then finalize the run.
			const env = await makeEnv();
			const wt = await addWorktree(env.root, "t-draft-archived-ok");
			const draft = await env.tasks.captureQuick("build the thing");
			const plan = { tasks: [{ title: "Build the thing properly" }] };
			const run = await seedRun(env, {
				kind: "plan",
				taskId: draft.id,
				wt,
				events: doneEvent(JSON.stringify(plan)),
				exit: "exit:0",
			});
			expect(
				await env.tasks.tryClaimDraftExpansion(draft.id, run.id, 60_000),
			).toBe(true);
			await env.tasks.release(
				draft.id,
				run.id,
				"draft",
				"boot",
				"draft expansion run is no longer active",
			);
			expect((await env.tasks.move(draft.id, "archived", "human")).status).toBe(
				"archived",
			);

			await env.runner.finalize(run.id);

			expect(await journal(env, run.id)).toEqual([
				"classify",
				"reap_leftovers",
				"parse_plan",
				"create_tasks",
				"gc_worktree",
			]);
			// Nothing created and the archived task not moved: resurrecting it would undo the human's decision.
			const all = await env.tasks.list();
			expect(all.map((t) => t.id)).toEqual([draft.id]);
			expect(all[0]?.status).toBe("archived");
			await env.cleanup();
		});

		test("a draft archived while its expansion run is still finalizing (failed plan) is not resurrected", async () => {
			const env = await makeEnv();
			const wt = await addWorktree(env.root, "t-draft-archived-fail");
			const draft = await env.tasks.captureQuick("do the thing");
			const run = await seedRun(env, {
				kind: "plan",
				taskId: draft.id,
				wt,
				events: doneEvent("not json at all"),
				exit: "exit:0",
			});
			expect(
				await env.tasks.tryClaimDraftExpansion(draft.id, run.id, 60_000),
			).toBe(true);
			await env.tasks.release(
				draft.id,
				run.id,
				"draft",
				"boot",
				"draft expansion run is no longer active",
			);
			expect((await env.tasks.move(draft.id, "archived", "human")).status).toBe(
				"archived",
			);

			await env.runner.finalize(run.id);

			expect(await journal(env, run.id)).toEqual([
				"classify",
				"reap_leftovers",
				"parse_plan",
				"draft_expand_failed",
				"gc_worktree",
			]);
			const after = await env.tasks.get(draft.id);
			expect(after?.status).toBe("archived");
			expect(after?.draftAttempts).toBe(0);
			expect(env.notifications).toEqual([]);
			await env.cleanup();
		});

		test("a draft archived before record_questions runs gets no new ghost clarification", async () => {
			// archiveDraft closes existing clarifications, but an unfinalized run (claim already reclaimed)
			// could still raise a first one, creating an Inbox item nobody can answer.
			const env = await makeEnv();
			const wt = await addWorktree(env.root, "t-draft-archived-questions");
			const draft = await env.tasks.captureQuick(
				"add billing",
				undefined,
				"ready",
				true, // requireReview: without it, record_questions always skips.
			);
			const run = await seedRun(env, {
				kind: "plan",
				taskId: draft.id,
				wt,
				events: doneEvent(
					JSON.stringify({
						tasks: [{ title: "Provisional billing task" }],
						questions: ["Stripe or Adyen?"],
					}),
				),
				exit: "exit:0",
			});
			expect(
				await env.tasks.tryClaimDraftExpansion(draft.id, run.id, 60_000),
			).toBe(true);
			await env.tasks.release(
				draft.id,
				run.id,
				"draft",
				"boot",
				"draft expansion run is no longer active",
			);
			expect((await env.tasks.move(draft.id, "archived", "human")).status).toBe(
				"archived",
			);

			await env.runner.finalize(run.id);

			expect(await journal(env, run.id)).toEqual([
				"classify",
				"reap_leftovers",
				"parse_plan",
				"record_questions",
				"notify",
				"release_task",
				"gc_worktree",
			]);
			expect(await env.clarify.list({ open: true })).toEqual([]);
			expect((await env.tasks.get(draft.id))?.status).toBe("archived");
			await env.cleanup();
		});
	});
});

describe("the task-level review gate (requireReview, T11)", () => {
	test("a no-DoD task merges on a passing exit code when nobody asked to look", async () => {
		const env = await makeEnv();
		const wt = await addWorktree(env.root, "t-skip");
		await commitIn(wt.path, "feature.txt", "done\n");
		const taskId = (await env.tasks.create({ title: "no dod, nobody asked" }))
			.id;
		await env.tasks.move(taskId, "ready", "human");
		await env.tasks.tryClaim(taskId, "run-skip", 60_000);
		const run = await seedRun(env, {
			kind: "task",
			runId: "run-skip",
			taskId,
			wt,
			events: doneEvent("done"),
			exit: "exit:0",
		});

		await env.runner.finalize(run.id);

		expect(await journal(env, run.id)).toEqual([
			"classify",
			"reap_leftovers",
			"ingest_report",
			"clear_stall",
			"enqueue_merge",
		]);
		expect((await env.registry.get(run.id))?.state).toBe("merging");
		expect(env.merges).toEqual([
			{ runId: run.id, taskId, branch: wt.branch, targetBranch: "main" },
		]);
		await env.cleanup();
	});

	test("the task's OWN requireReview stops it", async () => {
		const env = await makeEnv();
		const wt = await addWorktree(env.root, "t-req");
		await commitIn(wt.path, "feature.txt", "done\n");
		const taskId = (
			await env.tasks.create({
				title: "I want to look at this one",
				requireReview: true,
			})
		).id;
		await env.tasks.move(taskId, "ready", "human");
		await env.tasks.tryClaim(taskId, "run-req", 60_000);
		const run = await seedRun(env, {
			kind: "task",
			runId: "run-req",
			taskId,
			wt,
			events: doneEvent("done"),
			exit: "exit:0",
		});

		await env.runner.finalize(run.id);

		expect((await env.tasks.get(taskId))?.status).toBe("review");
		expect(env.merges).toEqual([]);
		await env.cleanup();
	});
});

describe("report ingestion is the non-forced cleanup boundary", () => {
	test("a transient report read failure preserves the worktree until retry journals it", async () => {
		const env = await makeEnv();
		const wt = await addWorktree(env.root, "report-read-failure");
		const reportPath = join(wt.path, "MFW_REPORT.json");
		await writeFile(reportPath, JSON.stringify({ summary: "must survive" }));
		const run = await seedRun(env, {
			kind: "action",
			wt,
			events: doneEvent("action done"),
			exit: "exit:0",
		});

		await chmod(reportPath, 0o000);
		await env.runner.finalize(run.id);
		expect(existsSync(wt.path)).toBe(true);
		expect(
			(await env.registry.steps(run.id)).find(
				(step) => step.step === "ingest_report",
			)?.status,
		).toBe("failed");
		expect(await journal(env, run.id)).not.toContain("gc_worktree");

		await chmod(reportPath, 0o600);
		await env.runner.finalize(run.id);
		expect(existsSync(wt.path)).toBe(false);
		expect(
			(await env.registry.steps(run.id)).find(
				(step) => step.step === "ingest_report",
			)?.status,
		).toBe("done");
		await env.cleanup();
	});

	test("action cleanup journals its worktree report before removal", async () => {
		const env = await makeEnv();
		const wt = await addWorktree(env.root, "report-action");
		const report = { summary: "action evidence", status: "completed" };
		await writeFile(join(wt.path, "MFW_REPORT.json"), JSON.stringify(report));
		const run = await seedRun(env, {
			kind: "action",
			wt,
			events: doneEvent("action done"),
			exit: "exit:0",
		});

		await env.runner.finalize(run.id);

		expect(await journal(env, run.id)).toEqual([
			"classify",
			"reap_leftovers",
			"ingest_report",
			"gc_worktree",
		]);
		const ingested = (await env.registry.steps(run.id)).find(
			(step) => step.step === "ingest_report",
		);
		expect(ingested?.result).toEqual({
			report,
			worktreeReport: {
				state: "present",
				sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
			},
		});
		expect(existsSync(wt.path)).toBe(false);
		await env.cleanup();
	});

	test("failed repair cleanup journals its report before removal", async () => {
		const env = await makeEnv();
		const wt = await addWorktree(env.root, "report-failed-repair");
		const report = { summary: "repair interrupted after diagnostics" };
		await writeFile(join(wt.path, "MFW_REPORT.json"), JSON.stringify(report));
		const run = await seedRun(env, { kind: "repair", wt });

		await env.runner.finalize(run.id);

		expect(await journal(env, run.id)).toEqual([
			"classify",
			"reap_leftovers",
			"ingest_report",
			"gc_worktree",
		]);
		expect(
			(await env.registry.steps(run.id)).find(
				(step) => step.step === "ingest_report",
			)?.result,
		).toEqual({
			report,
			worktreeReport: {
				state: "present",
				sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
			},
		});
		expect(existsSync(wt.path)).toBe(false);
		await env.cleanup();
	});

	test("interrupted task cleanup cannot discard an uningested report", async () => {
		const env = await makeEnv({ mergeChecks: null });
		const wt = await addWorktree(env.root, "report-interrupted-task");
		const runId = ulid();
		const taskId = await claimedTask(env, runId, {
			title: "interrupted report",
		});
		const report = { summary: "captured before interruption" };
		await writeFile(join(wt.path, "MFW_REPORT.json"), JSON.stringify(report));
		const run = await seedRun(env, { kind: "task", runId, taskId, wt });

		await env.runner.finalize(run.id);

		expect(await journal(env, run.id)).toEqual([
			"classify",
			"reap_leftovers",
			"ingest_report",
			"decide_resume",
			"release_task",
			"gc_worktree",
		]);
		expect(
			(await env.registry.steps(run.id)).find(
				(step) => step.step === "ingest_report",
				"decide_resume",
			)?.result,
		).toEqual({
			report,
			worktreeReport: {
				state: "present",
				sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
			},
		});
		expect(existsSync(wt.path)).toBe(false);
		expect((await env.tasks.get(taskId))?.status).toBe("ready");
		await env.cleanup();
	});

	test("a report rewritten after journaled ingestion survives restart cleanup", async () => {
		const env = await makeEnv();
		const wt = await addWorktree(env.root, "report-post-ingest-rewrite");
		const original = '{"summary":"first version"}\n';
		const reportPath = join(wt.path, "MFW_REPORT.json");
		await writeFile(reportPath, original);
		const run = await seedRun(env, {
			kind: "action",
			wt,
			events: doneEvent("action done"),
			exit: "exit:0",
		});
		await env.registry.beginStep(run.id, "ingest_report");
		await env.registry.finishStep(run.id, "ingest_report", {
			report: { summary: "first version" },
			worktreeReport: {
				state: "present",
				sha256: createHash("sha256").update(original).digest("hex"),
			},
		});
		await writeFile(reportPath, '{"summary":"late rewrite"}\n');

		await env.runner.finalize(run.id);

		expect(existsSync(wt.path)).toBe(true);
		expect(await readFile(reportPath, "utf8")).toContain("late rewrite");
		expect(
			(await env.registry.steps(run.id)).find(
				(step) => step.step === "gc_worktree",
			)?.result,
		).toEqual({ removed: false, preserved: true });
		await env.cleanup();
	});
});

describe("MFW-48: a project default DoD stands in for a task with none", () => {
	test("a no-DoD task is actually verified, and merges when the default passes", async () => {
		const env = await makeEnv({ mergeChecks: PASSING_DOD });
		const wt = await addWorktree(env.root, "t-default-pass");
		await commitIn(wt.path, "feature.txt", "done\n");
		const taskId = (await env.tasks.create({ title: "quick-captured, no dod" }))
			.id;
		await env.tasks.move(taskId, "ready", "human");
		await env.tasks.tryClaim(taskId, "run-default-pass", 60_000);
		const run = await seedRun(env, {
			kind: "task",
			runId: "run-default-pass",
			taskId,
			wt,
			events: doneEvent("done"),
			exit: "exit:0",
		});

		await env.runner.finalize(run.id);

		// The "no DoD" shortcut (T11) is not taken: it goes through `verify` (T16), not the exit code alone.
		expect(await journal(env, run.id)).toEqual([
			"classify",
			"reap_leftovers",
			"ingest_report",
			"verify",
			"clear_stall",
			"enqueue_merge",
		]);
		expect((await env.registry.get(run.id))?.state).toBe("merging");
		expect(env.merges).toEqual([
			{ runId: run.id, taskId, branch: wt.branch, targetBranch: "main" },
		]);
		// The default is resolved at verification time, never written to the file.
		expect((await env.tasks.get(taskId))?.dod).toBeNull();
		await env.cleanup();
	});

	test("a no-DoD task does not merge on exit 0 when the default fails", async () => {
		const env = await makeEnv({ mergeChecks: FAILING_DOD });
		const wt = await addWorktree(env.root, "t-default-fail");
		await commitIn(wt.path, "feature.txt", "done\n");
		const taskId = (await env.tasks.create({ title: "quick-captured, broken" }))
			.id;
		await env.tasks.move(taskId, "ready", "human");
		await env.tasks.tryClaim(taskId, "run-default-fail", 60_000);
		const run = await seedRun(env, {
			kind: "task",
			runId: "run-default-fail",
			taskId,
			wt,
			events: doneEvent("I think it works"),
			exit: "exit:0",
		});

		await env.runner.finalize(run.id);

		expect(await journal(env, run.id)).toEqual([
			"classify",
			"reap_leftovers",
			"ingest_report",
			"verify",
			"bump_stall",
			"spawn_repair",
		]);
		expect(env.merges).toEqual([]);
		expect(env.spawns).toEqual([{ parent: run.id, child: expect.any(String) }]);
		await env.cleanup();
	});
});

/** Drop a done step's journal row and hand the run back to finalization, as a crash between the effect and its journal row would. */
async function forgetStep(env: Env, runId: string, step: string) {
	await env.handle.db
		.delete(runSteps)
		.where(and(eq(runSteps.runId, runId), eq(runSteps.step, step)));
	await env.handle.db
		.update(runs)
		.set({ state: "finalizing", finishedAt: null })
		.where(eq(runs.id, runId));
}

describe("follow-ups reported by a task run", () => {
	const report = {
		status: "failed",
		summary: "ran out of scope",
		follow_ups: [
			{
				title: "Fix the flaky parser test",
				body: "It fails one run in ten.",
				criteria: ["parser test passes 50 runs in a row", 7],
			},
			{ title: "   " },
			{ title: "Document the retry flag" },
		],
	};

	test("become manual backlog tasks once, across re-execution and a later run", async () => {
		const env = await makeEnv();
		const wt = await addWorktree(env.root, "t-followups");
		const runId = ulid();
		const taskId = await claimedTask(env, runId, {
			title: "parser work",
			dod: PASSING_DOD,
		});
		const run = await seedRun(env, {
			kind: "task",
			runId,
			taskId,
			wt,
			exit: "killed:manual",
			report,
		});

		await env.runner.finalize(run.id);

		const steps = await journal(env, run.id);
		expect(steps.slice(0, 4)).toEqual([
			"classify",
			"reap_leftovers",
			"ingest_report",
			"create_followups",
		]);
		const followUps = () =>
			env.tasks
				.list()
				.then((all) => all.filter((t) => t.discoveredFrom === taskId));
		const first = await followUps();
		expect(first.map((t) => t.title).sort()).toEqual([
			"Document the retry flag",
			"Fix the flaky parser test",
		]);
		const flaky = first.find((t) => t.title === "Fix the flaky parser test");
		expect(flaky?.status).toBe("backlog");
		expect(flaky?.readyMode).toBe("manual");
		expect(flaky?.source).toBe("followup");
		expect(flaky?.parentId).toBeNull();
		expect(flaky?.body).toContain("It fails one run in ten.");
		expect(flaky?.criteria.map((c) => c.text)).toEqual([
			"parser test passes 50 runs in a row",
		]);
		const stepRow = (await env.registry.steps(run.id)).find(
			(s) => s.step === "create_followups",
		);
		expect(stepRow?.result).toEqual({
			created: first.map((t) => t.id),
			reused: [],
		});

		// Mutable human edits do not change the immutable discovery identity.
		const renamed = first[0];
		if (!renamed) throw new Error("missing follow-up");
		await env.tasks.edit(renamed.id, { title: "Clarified title" });
		// Crash between the effect and its journal row: re-drive.
		await forgetStep(env, run.id, "create_followups");
		await env.runner.finalize(run.id);
		expect((await followUps()).map((t) => t.id)).toEqual(
			first.map((t) => t.id),
		);

		// A later run of the same task reporting the same follow-up.
		const run2Id = ulid();
		expect(await env.tasks.tryClaim(taskId, run2Id, 60_000)).toBe(true);
		const run2 = await seedRun(env, {
			kind: "task",
			runId: run2Id,
			taskId,
			wt: await addWorktree(env.root, "t-followups-2"),
			exit: "killed:manual",
			report,
		});
		await env.runner.finalize(run2.id);
		expect((await followUps()).map((t) => t.id)).toEqual(
			first.map((t) => t.id),
		);
		await env.cleanup();
	});
});

describe("processes a task run left running", () => {
	test("are stopped, journaled, and a completed run is resumed instead of verified", async () => {
		const env = await makeEnv();
		const wt = await addWorktree(env.root, "t-leftover");
		await commitIn(wt.path, "a.txt", "work\n");
		const runId = ulid();
		const taskId = await claimedTask(env, runId, {
			title: "left a watcher running",
			dod: PASSING_DOD,
		});
		const leftover = {
			pid: 4242,
			command: "bun test --watch",
			cwd: wt.path,
			runId,
			bootId: "boot",
			startTimeTicks: "42",
		};
		env.leftovers.push(leftover);
		const run = await seedRun(env, {
			kind: "task",
			runId,
			taskId,
			wt,
			events: doneEvent("done"),
			exit: "exit:0",
			report: { summary: "done" },
		});

		await env.runner.finalize(run.id);

		expect(await journal(env, run.id)).toEqual([
			"classify",
			"reap_leftovers",
			"ingest_report",
			"decide_resume",
			"spawn_resume",
		]);
		expect(env.stopped).toEqual([[leftover]]);
		const reap = (await env.registry.steps(run.id)).find(
			(s) => s.step === "reap_leftovers",
		);
		expect(reap?.result).toEqual({
			processes: [leftover],
			stopped: [4242],
			killed: [],
		});
		const audit = (await eventsSince(env.handle.db, 0, 1000)).find(
			(e) =>
				e.type === "run.finalize_step" &&
				(e.payload as { step?: string }).step === "reap_leftovers",
		);
		expect((audit?.payload as { detail?: string }).detail).toBe(
			"stopped 1 of 1 leftover processes",
		);
		expect(env.spawns).toEqual([{ parent: run.id, child: expect.any(String) }]);
		expect(env.merges).toEqual([]);
		expect((await env.tasks.get(taskId))?.resumeCount).toBe(1);
		expect((await env.registry.get(run.id))?.state).toBe("completed");
		await env.cleanup();
	});

	test("nothing left running: nothing stopped, verification as usual", async () => {
		const env = await makeEnv();
		const wt = await addWorktree(env.root, "t-no-leftover");
		await commitIn(wt.path, "a.txt", "work\n");
		const runId = ulid();
		const taskId = await claimedTask(env, runId, {
			title: "clean exit",
			dod: PASSING_DOD,
		});
		const run = await seedRun(env, {
			kind: "task",
			runId,
			taskId,
			wt,
			events: doneEvent("done"),
			exit: "exit:0",
			report: { summary: "done" },
		});

		await env.runner.finalize(run.id);

		expect(env.stopped).toEqual([]);
		expect(await journal(env, run.id)).toContain("verify");
		expect(env.spawns).toEqual([]);
		await env.cleanup();
	});
});

describe("plan entries: owns and model_tier", () => {
	test("valid owns patterns and a known tier reach the created task", async () => {
		const env = await makeEnv();
		const wt = await addWorktree(env.root, "t-plan-owns");
		const plan = {
			tasks: [
				{
					title: "Scoped",
					owns: ["./src/parser/", "../escape", "/abs", "a/b**c", 3, "docs/**"],
					model_tier: "strong",
				},
				{ title: "Unscoped", model_tier: "enormous" },
			],
		};
		const run = await seedRun(env, {
			kind: "plan",
			wt,
			events: doneEvent(JSON.stringify(plan)),
			exit: "exit:0",
		});

		await env.runner.finalize(run.id);

		const [scoped, unscoped] = await env.tasks.list();
		expect(scoped?.owns).toEqual(["src/parser", "docs/**"]);
		expect(scoped?.modelTier).toBe("strong");
		expect(unscoped?.owns).toEqual([]);
		expect(unscoped?.modelTier).toBeNull();
		await env.cleanup();
	});
});

describe("durable cleanup and resume decisions", () => {
	async function backgroundRun(initialCount = 0, exit = "exit:0") {
		const env = await makeEnv();
		const wt = await addWorktree(env.root, "durable-cleanup");
		await commitIn(wt.path, "a.txt", "work\n");
		const runId = ulid();
		const taskId = await claimedTask(env, runId, {
			title: "background work",
			dod: PASSING_DOD,
		});
		await env.tasks.setResumeOrdinal(taskId, initialCount);
		const process: LeftoverProcess = {
			pid: 4242,
			command: "build --watch",
			cwd: wt.path,
			runId,
			bootId: "boot",
			startTimeTicks: "42",
		};
		env.leftovers.push(process);
		const run = await seedRun(env, {
			kind: "task",
			runId,
			taskId,
			wt,
			...(exit ? { exit } : {}),
		});
		return { env, run, taskId, process, wt };
	}

	test.each([
		"exit:0",
		"",
	])("last resume allowance keeps the parent off the child's worktree (%s)", async (exit) => {
		const { env, run, taskId, wt } = await backgroundRun(1, exit);
		const runner = env.makeRunner({
			spawnResume: async (parent, child) => {
				env.spawns.push({ parent, child });
				await env.tasks.moveLease(taskId, child);
			},
		});
		await runner.finalize(run.id);
		expect(env.spawns).toHaveLength(1);
		expect((await env.tasks.get(taskId))?.claimedByRunId).toBe(
			env.spawns[0]?.child,
		);
		expect((await env.tasks.get(taskId))?.resumeCount).toBe(2);
		expect(await journal(env, run.id)).not.toContain("verify");
		expect(await journal(env, run.id)).not.toContain("release_task");
		expect(await journal(env, run.id)).not.toContain("gc_worktree");
		expect(existsSync(wt.path)).toBe(true);
		await env.cleanup();
	});

	test("exhausted resume allowance stays on verification through clear_stall", async () => {
		const { env, run, taskId } = await backgroundRun(2);
		await env.runner.finalize(run.id);
		expect(env.spawns).toEqual([]);
		expect(env.merges).toHaveLength(1);
		expect((await env.tasks.get(taskId))?.resumeCount).toBe(2);
		expect(
			(await env.registry.steps(run.id)).find((s) => s.step === "decide_resume")
				?.result,
		).toEqual({ selected: false, ordinal: 3 });
		await env.cleanup();
	});

	test("spawn failure reuses its reserved child and ordinal after restart", async () => {
		const { env, run, taskId } = await backgroundRun(1);
		const children: string[] = [];
		const runner = env.makeRunner({
			spawnResume: async (_parent, child) => {
				children.push(child);
				if (children.length === 1) throw new Error("crash before spawn");
				await env.tasks.moveLease(taskId, child);
			},
		});
		await runner.finalize(run.id);
		expect((await env.tasks.get(taskId))?.resumeCount).toBe(2);
		await runner.finalize(run.id);
		expect(children).toHaveLength(2);
		expect(children[0]).toBe(children[1]);
		expect((await env.tasks.get(taskId))?.resumeCount).toBe(2);
		expect(await journal(env, run.id)).not.toContain("verify");
		await env.cleanup();
	});

	test("a legacy completed spawn remains authoritative without a decision row", async () => {
		const { env, run, taskId } = await backgroundRun(1);
		await env.runner.finalize(run.id);
		const child = env.spawns[0]?.child;
		if (!child) throw new Error("missing child");
		await env.tasks.moveLease(taskId, child);
		await forgetStep(env, run.id, "decide_resume");
		await env.makeRunner().finalize(run.id);
		expect((await env.tasks.get(taskId))?.claimedByRunId).toBe(child);
		expect(await journal(env, run.id)).not.toContain("verify");
		expect(await journal(env, run.id)).not.toContain("release_task");
		expect(env.spawns).toHaveLength(1);
		await env.cleanup();
	});

	test("a lost completion write retains interrupted-command evidence after restart", async () => {
		const { env, run, process } = await backgroundRun();
		const finish = env.registry.finishStep.bind(env.registry);
		let fail = true;
		env.registry.finishStep = async (id, step, result) => {
			if (step === "reap_leftovers" && fail) {
				fail = false;
				throw new Error("journal unavailable");
			}
			await finish(id, step, result);
		};
		await env.runner.finalize(run.id);
		expect(env.leftovers).toEqual([]);
		expect(
			(await env.registry.journalGuard(run.id, "reap_leftovers")) as unknown,
		).toEqual({ processes: [process] });
		await env.makeRunner().finalize(run.id);
		expect(env.spawns).toHaveLength(1);
		expect(env.merges).toEqual([]);
		const reaped = (await env.registry.journalGuard(
			run.id,
			"reap_leftovers",
		)) as { processes: LeftoverProcess[] };
		expect(reaped.processes).toEqual([process]);
		await env.cleanup();
	});

	test("unconfirmed cleanup parks visibly while retaining claim and resources", async () => {
		const { env, run, taskId, process, wt } = await backgroundRun(2);
		const runner = env.makeRunner({
			leftovers: {
				find: async () => [process],
				stop: async () => ({
					stopped: [],
					killed: [],
					absent: [],
					live: [process.pid],
					unknown: [],
				}),
			},
		});
		await runner.finalize(run.id);
		await runner.finalize(run.id);
		expect((await env.registry.get(run.id))?.state).toBe("finalize_error");
		expect(await env.registry.hasPendingCleanup(run.id)).toBe(true);
		expect((await env.tasks.get(taskId))?.claimedByRunId).toBe(run.id);
		expect(env.notifications.some((n) => n.kind === "finalize_error")).toBe(
			true,
		);
		expect(env.merges).toEqual([]);
		expect(await journal(env, run.id)).not.toContain("verify");
		expect(existsSync(wt.path)).toBe(true);
		await env.cleanup();
	});

	test("children created during shutdown are journaled before their cleanup", async () => {
		const { env, run, process } = await backgroundRun();
		const child = { ...process, pid: 4243, startTimeTicks: "43" };
		let live = [process];
		const runner = env.makeRunner({
			leftovers: {
				find: async () => [...live],
				stop: async (list) => {
					const guard = (await env.registry.journalGuard(
						run.id,
						"reap_leftovers",
					)) as { processes: LeftoverProcess[] };
					for (const p of list) expect(guard.processes).toContainEqual(p);
					live = list.some((p) => p.pid === child.pid) ? [] : [child];
					return {
						stopped: list.map((p) => p.pid),
						killed: [],
						absent: list.map((p) => p.pid),
						live: [],
						unknown: [],
					};
				},
			},
		});
		await runner.finalize(run.id);
		const guard = (await env.registry.journalGuard(
			run.id,
			"reap_leftovers",
		)) as { processes: LeftoverProcess[] };
		expect(guard.processes).toEqual([process, child]);
		expect(env.spawns).toHaveLength(1);
		await env.cleanup();
	});

	test("regression repair cleans up and files follow-ups without taking its historical task", async () => {
		const env = await makeEnv();
		const task = await env.tasks.create({
			title: "historical done task",
			status: "done",
			dod: PASSING_DOD,
		});
		const wt = await addWorktree(env.root, "repair-cleanup");
		const run = await seedRun(env, {
			kind: "repair",
			taskId: task.id,
			wt,
			exit: "exit:0",
			report: { follow_ups: [{ title: "Found separate bug" }] },
		});
		env.leftovers.push({
			pid: 4242,
			command: "writer",
			cwd: wt.path,
			runId: run.id,
			bootId: "boot",
			startTimeTicks: "42",
		});
		await env.runner.finalize(run.id);
		expect((await journal(env, run.id)).slice(0, 4)).toEqual([
			"classify",
			"reap_leftovers",
			"ingest_report",
			"create_followups",
		]);
		expect(env.stopped).toHaveLength(1);
		expect(
			(await env.tasks.list()).filter((t) => t.discoveredFrom === task.id),
		).toHaveLength(1);
		expect((await env.tasks.get(task.id))?.status).toBe("done");
		expect((await env.tasks.get(task.id))?.claimedByRunId).toBeNull();
		expect((await env.registry.get(run.id))?.state).toBe("failed");
		expect(env.merges).toEqual([]);
		await env.cleanup();
	});
});
