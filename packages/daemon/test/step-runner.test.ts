import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import { EventBus, eventsSince } from "@mfw/db/eventlog";
import { ulid } from "@mfw/db/ids";
import { engineKv, runSteps, runs } from "@mfw/db/schema";
import { and, eq } from "drizzle-orm";
import { AgentHost } from "../src/agent-host.ts";
import { ClarifyService } from "../src/clarify.ts";
import { PROJECT_DEFAULTS } from "../src/config.ts";
import type { CheckRunner } from "../src/containment/check-runner.ts";
import { ensureRunDirLayout } from "../src/containment/run-dir.ts";
import type { RunKind } from "../src/finalize/machine.ts";
import {
	type BrainPort,
	StepRunner,
	type StepRunnerDeps,
} from "../src/finalize/step-runner.ts";
import { git } from "../src/git.ts";
import type { LeftoverProcess } from "../src/leftover-processes.ts";
import { silentLogger } from "../src/log.ts";
import { runProc } from "../src/proc.ts";
import { runProvenanceView } from "../src/run-provenance-view.ts";
import { RunRegistry, type RunRow } from "../src/run-registry.ts";
import {
	clearRunWorkspace,
	createRunWorkspace,
} from "../src/run-workspace/factory.ts";
import { TaskService } from "../src/task-service.ts";
import type { VerificationPlan } from "../src/tasks/types.ts";
import { makeTasks } from "./fixtures/board.ts";
import { agentGit, useCheckClones } from "./support/check-clones.ts";

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
	requireVerified?: boolean;
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
	/** What the fake leftover scan finds; tests set it before finalizing. */
	leftovers: LeftoverProcess[];
	/** Every list handed to the fake stop. */
	stopped: LeftoverProcess[][];
	makeRunner: (patch?: Partial<StepRunnerDeps>) => StepRunner;
	cleanup: () => Promise<void>;
}

async function makeEnv(
	configOverrides: {
		mergeChecks?: VerificationPlan | null;
		draftExpandMaxAttempts?: number;
	} = {},
): Promise<Env> {
	const { mergeChecks, ...stepRunnerConfig } = configOverrides;
	const root = await mkdtemp(join(tmpdir(), "mfw-sr-"));
	const dropClones = useCheckClones(root);
	await git(["init", "-q", "-b", "main"], root);
	await git(["config", "user.email", "t@t"], root);
	await git(["config", "user.name", "t"], root);
	await writeFile(join(root, "base.txt"), "base\n");
	await git(["add", "-A"], root);
	await git(["commit", "-q", "-m", "init"], root);
	await writeFile(join(root, ".git/info/exclude"), ".mfw/\nMFW_REPORT.json\n");

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
	// Never scan the real /proc from a test: a fake with scripted findings.
	const leftovers: LeftoverProcess[] = [];
	const stopped: LeftoverProcess[][] = [];
	const brain: BrainPort = {
		enabled: false,
		critic: async () => ({ status: "ok", flagged: false }),
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
		leftovers,
		stopped,
		makeRunner,
		cleanup: async () => {
			handle.close();
			await dropClones();
			await rm(root, { recursive: true, force: true });
		},
	};
}

interface Workspace {
	path: string;
	branch: string;
	baseSha: string;
}

/** A run's private clone, seeded as a launch would. */
async function addWorkspace(root: string, name: string): Promise<Workspace> {
	return createRunWorkspace(root).seed(name, "main");
}

/** The agent commits in its clone, with the sandbox's `GIT_DIR`. */
async function commitIn(
	wt: string,
	file: string,
	content: string,
): Promise<void> {
	await mkdir(join(wt, file, ".."), { recursive: true });
	await writeFile(join(wt, file), content);
	await agentGit(wt, ["add", "-A"]);
	await agentGit(wt, ["commit", "-q", "-m", `work: ${file}`]);
}

/** Run row in state "ended" (what the supervisor hands to the StepRunner). */
async function seedRun(
	env: Env,
	spec: {
		kind: RunKind;
		/** Must match the id `claimedTask` used for the lease (release() is keyed on it). */
		runId?: string;
		taskId?: string;
		wt?: Workspace;
		events?: string;
		exit?: string;
		report?: unknown;
		routing?: Record<string, unknown>;
		providerId?: string;
	},
): Promise<RunRow> {
	const run = await env.registry.create({
		...(spec.routing ? { routing: spec.routing } : {}),
		...(spec.providerId ? { providerId: spec.providerId } : {}),
		kind: spec.kind,
		...(spec.runId ? { id: spec.runId } : {}),
		...(spec.taskId ? { taskId: spec.taskId } : {}),
		label: `${spec.kind} run`,
		model: "sonnet",
		cwd: spec.wt?.path ?? env.root,
		...(spec.wt
			? {
					workspacePath: spec.wt.path,
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

/** The journaled settle facts: free-form JSON the tests read by path. */
type SettleFacts = {
	verify?: { passed: boolean; failing: { check: string }[] };
	report?: { question?: string };
	archivedRef?: string;
	killReason?: string;
	scope?: { outside: number; outsideFiles: string[] };
	review?: {
		status?: string;
		verdict?: string | null;
		cause?: string;
		findings?: { file: string; severity: string }[];
	};
	outcome?: string;
	proposal?: { tasks?: unknown[]; truncatedTasks?: number };
};

/** `run.settled` events for a run, newest last. */
async function settledEvents(env: Env, runId: string) {
	return (await eventsSince(env.handle.db, 0, 5000)).filter(
		(e) => e.type === "run.settled" && e.runId === runId,
	) as unknown as {
		payload: { class: string; groupId: string | null; facts: SettleFacts };
	}[];
}

async function awaitingOf(env: Env) {
	const [row] = await env.handle.db
		.select()
		.from(engineKv)
		.where(eq(engineKv.key, "brain_awaiting"));
	return (
		(
			row?.value as
				| { awaiting?: Record<string, { runId: string; class: string }> }
				| undefined
		)?.awaiting ?? {}
	);
}

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
		verification?: typeof PASSING_DOD | null;
		labels?: string[];
	},
): Promise<string> {
	const t = await env.tasks.create({
		title: opts.title,
		status: "ready",
		verification: opts.verification ?? null,
		labels: opts.labels ?? [],
	});
	expect(await env.tasks.tryClaim(t.id, runIdPlaceholder, 60_000)).toBe(true);
	return t.id;
}

describe("StepRunner v2: finalization end to end", () => {
	test("(a) verified task run enqueues a merge and parks the run in `merging` (T16)", async () => {
		const env = await makeEnv();
		env.brain.enabled = true;
		const wt = await addWorkspace(env.root, "t-a");
		await commitIn(wt.path, "a.txt", "work\n");
		const runId = ulid();
		const taskId = await claimedTask(env, runId, {
			title: "verified work",
			verification: PASSING_DOD,
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
			{
				runId: run.id,
				taskId,
				branch: wt.branch,
				targetBranch: "main",
				requireVerified: true,
			},
		]);
		// The merge queue owns the task from here.
		expect((await env.tasks.get(taskId))?.status).toBe("in_progress");
		await env.cleanup();
	});

	test("verification records the exact commit it passed", async () => {
		const env = await makeEnv();
		const wt = await addWorkspace(env.root, "t-pin");
		await commitIn(wt.path, "a.txt", "work\n");
		const head = (await agentGit(wt.path, ["rev-parse", "HEAD"])).stdout;
		const runId = ulid();
		const taskId = await claimedTask(env, runId, {
			title: "pinned work",
			verification: PASSING_DOD,
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

		expect((await env.registry.get(run.id))?.verifiedSha).toBe(head);
		expect(env.merges).toHaveLength(1);
		await env.cleanup();
	});

	test("a file left uncommitted is never what was verified: the commit is checked and queued as it is", async () => {
		const env = await makeEnv();
		const wt = await addWorkspace(env.root, "t-uncommitted");
		await commitIn(wt.path, "a.txt", "work\n");
		await writeFile(join(wt.path, "only-on-disk.txt"), "not committed\n");
		const runId = ulid();
		const taskId = await claimedTask(env, runId, {
			title: "uncommitted work",
			verification: PASSING_DOD,
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

		// The checks ran on a clone of the committed tip, which lacks the file.
		const verified = (await env.registry.get(run.id))?.verifiedSha;
		expect(verified).toBe(
			(await agentGit(wt.path, ["rev-parse", "mfw/t-uncommitted"])).stdout,
		);
		const files = await git(
			["ls-tree", "-r", "--name-only", verified as string],
			env.root,
		);
		expect(files.stdout.split("\n")).not.toContain("only-on-disk.txt");
		expect(env.merges).toHaveLength(1);
		await env.cleanup();
	});

	test("remote collection failure is durable result evidence and cannot reach verify or merge", async () => {
		const env = await makeEnv();
		const wt = await addWorkspace(env.root, "collection-failed");
		const runId = ulid();
		const taskId = await claimedTask(env, runId, {
			title: "remote output was not collected",
			verification: PASSING_DOD,
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

	test("(b) a watchdog kill settles watchdog_killed: task back to ready awaiting the brain, no block, no ping, clean workspace gc'd (T4)", async () => {
		const env = await makeEnv();
		const wt = await addWorkspace(env.root, "t-b");
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
			"settle",
			"gc_workspace",
		]);
		const task = await env.tasks.get(taskId);
		expect(task?.status).toBe("ready");
		expect(task?.claimedByRunId).toBeNull();
		expect(task?.stallCount).toBe(1);
		expect(env.notifications).toEqual([]);
		const row = await env.registry.get(run.id);
		expect(row?.state).toBe("killed");
		expect(row?.killReason).toBe("watchdog-idle");
		const settled = await settledEvents(env, run.id);
		expect(settled).toHaveLength(1);
		expect(settled[0]?.payload).toMatchObject({
			class: "watchdog_killed",
			groupId: run.id,
			facts: { outcome: "killed_watchdog", killReason: "watchdog-idle" },
		});
		expect((await awaitingOf(env))[taskId]).toMatchObject({
			runId: run.id,
			class: "watchdog_killed",
		});
		// The report is already captured by ingest_report, so it does not make the workspace dirty.
		expect(existsSync(wt.path)).toBe(false);
		await env.cleanup();
	});

	test("(c) a step that throws resumes from the journal without re-running earlier steps", async () => {
		const env = await makeEnv();
		const wt = await addWorkspace(env.root, "t-c");
		await commitIn(wt.path, "c.txt", "work\n");
		const counter = join(env.root, "verify-count.txt");
		const runId = ulid();
		const t = await env.tasks.create({
			title: "counted verify",
			status: "ready",
			requireReview: true, // T15 review gate → release_task(review)
			verification: {
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
		const wt = await addWorkspace(env.root, "t-d");
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
		expect(task?.preservedWorkspace).toBe(wt.path); // dirty work kept for resume
		const row = await env.registry.get(run.id);
		expect(row?.state).toBe("rate_limited");
		expect(row?.outcome).toBe("rate_limited");
		expect(existsSync(wt.path)).toBe(true);
		await env.cleanup();
	});

	test("a rate-limited run reports only its own route's provider account", async () => {
		const env = await makeEnv();
		const holds: { key: string; until: number; project?: string }[] = [];
		const runner = env.makeRunner({
			providerHolds: {
				report: async (key, hold) => {
					holds.push({ key, until: hold.until, project: hold.project });
					return { scope: "project", key, until: hold.until };
				},
			},
			projectName: "demo",
		});
		const wt = await addWorkspace(env.root, "limited-endpoint");
		const runId = ulid();
		const taskId = await claimedTask(env, runId, { title: "limited" });
		const resetsAtSec = Math.floor((Date.now() + 3_600_000) / 1000);
		const run = await seedRun(env, {
			kind: "task",
			runId,
			taskId,
			wt,
			providerId: "codex-cli",
			routing: {
				provider: "codex-cli",
				model: "m",
				holdKey: "codex-cli@local",
			},
			events: ev({
				type: "rate_limit",
				status: "limited",
				limited: true,
				resetsAt: resetsAtSec,
			}),
			exit: "exit:1",
		});
		await runner.finalize(run.id);
		expect(holds).toEqual([
			{ key: "codex-cli@local", until: resetsAtSec * 1000, project: "demo" },
		]);
		// Not the project-wide gate: other providers keep dispatching.
		const rows = await env.handle.db
			.select()
			.from(engineKv)
			.where(eq(engineKv.key, "dispatch_hold"));
		expect(rows).toEqual([]);
		await env.cleanup();
	});

	test("an auth failure holds the run's provider for the owner, with no retry and no attempt consumed", async () => {
		const env = await makeEnv();
		const holds: {
			key: string;
			until: number;
			reason: string;
			confirmedUntil?: number;
		}[] = [];
		const runner = env.makeRunner({
			providerHolds: {
				report: async (key, hold) => {
					holds.push({
						key,
						until: hold.until,
						reason: hold.reason,
						...(hold.confirmedUntil !== undefined
							? { confirmedUntil: hold.confirmedUntil }
							: {}),
					});
					return { scope: "project", key, until: hold.until };
				},
			},
			projectName: "demo",
		});
		const wt = await addWorkspace(env.root, "auth-failed");
		const runId = ulid();
		const taskId = await claimedTask(env, runId, { title: "logged out" });
		const run = await seedRun(env, {
			kind: "task",
			runId,
			taskId,
			wt,
			providerId: "codex-cli",
			routing: { provider: "codex-cli", model: "m", holdKey: "codex-cli" },
			events: ev({
				type: "error",
				message:
					"Your access token could not be refreshed. Please run codex login again.",
			}),
			exit: "exit:1",
		});
		const before = Date.now();
		await runner.finalize(run.id);
		expect(holds).toHaveLength(1);
		expect(holds[0]).toMatchObject({ key: "codex-cli", reason: "auth" });
		// The agent's word alone holds briefly; a day needs a second project.
		expect(holds[0]?.until).toBeLessThanOrEqual(Date.now() + 3_600_000);
		expect(holds[0]?.confirmedUntil).toBeGreaterThan(before + 23 * 3_600_000);
		const task = await env.tasks.get(taskId);
		expect(task?.status).toBe("ready");
		expect(task?.attemptCount).toBe(0);
		expect((await env.registry.get(run.id))?.outcome).toBe("rate_limited");
		await env.cleanup();
	});

	test("auth wording in a run that exited cleanly is not a login failure", async () => {
		const env = await makeEnv();
		const holds: string[] = [];
		const runner = env.makeRunner({
			providerHolds: {
				report: async (key, hold) => {
					holds.push(key);
					return { scope: "project", key, until: hold.until };
				},
			},
			projectName: "demo",
		});
		const run = await seedRun(env, {
			kind: "plan",
			providerId: "codex-cli",
			events: ev({
				type: "text",
				text: "the docs say: authentication failed means retry",
			}),
			exit: "exit:0",
		});
		await runner.finalize(run.id);
		expect(holds).toEqual([]);
		await env.cleanup();
	});

	test("a claude run's rate_limit events feed the weekly-meter observer; other providers' do not", async () => {
		const env = await makeEnv();
		const seen: unknown[] = [];
		const runner = env.makeRunner({
			claudeRateLimits: { observe: (o) => void seen.push(o) },
		});
		const events = ev({
			type: "rate_limit",
			status: "allowed_warning",
			limited: false,
			resetsAt: 1_900_000_000,
			utilization: 0.8,
		});
		for (const providerId of ["claude-cli", "codex-cli"]) {
			const wt = await addWorkspace(env.root, `obs-${providerId}`);
			const runId = ulid();
			const taskId = await claimedTask(env, runId, { title: providerId });
			const run = await seedRun(env, {
				kind: "task",
				runId,
				taskId,
				wt,
				providerId,
				events,
				exit: "exit:0",
			});
			await runner.finalize(run.id);
		}
		expect(seen).toEqual([
			{
				status: "allowed_warning",
				limited: false,
				resetsAt: 1_900_000_000,
				utilization: 0.8,
			},
		]);
		await env.cleanup();
	});

	test("(e) failed verification settles verify_failed with the failing checks: no replan call, no block, no ping (T17)", async () => {
		const env = await makeEnv();
		env.brain.enabled = true;
		const wt = await addWorkspace(env.root, "t-e");
		await commitIn(wt.path, "e.txt", "half done\n");
		const runId = ulid();
		const taskId = await claimedTask(env, runId, {
			title: "broken work",
			verification: FAILING_DOD,
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
			"settle",
		]);
		const task = await env.tasks.get(taskId);
		expect(task?.status).toBe("ready");
		expect(task?.stallCount).toBe(1);
		// The work is kept for a `continue:` spawn.
		expect(task?.preservedWorkspace).toBe(wt.path);
		expect(existsSync(wt.path)).toBe(true);
		expect(env.notifications).toEqual([]);
		const row = await env.registry.get(run.id);
		expect(row?.state).toBe("failed");
		expect(row?.note).toBe("verify failed");
		expect(env.merges).toEqual([]);
		const [settled] = await settledEvents(env, run.id);
		expect(settled?.payload.class).toBe("verify_failed");
		expect(settled?.payload.facts.verify?.passed).toBe(false);
		expect(settled?.payload.facts.verify?.failing[0]?.check).toContain("false");
		await env.cleanup();
	});

	test("(e-settle) a crash between the settle's effects and its journal row replays to exactly one event, one awaiting entry and one stall", async () => {
		const env = await makeEnv();
		const wt = await addWorkspace(env.root, "t-e-settle");
		await commitIn(wt.path, "e.txt", "half done\n");
		const runId = ulid();
		const taskId = await claimedTask(env, runId, {
			title: "broken work",
			verification: FAILING_DOD,
		});
		const run = await seedRun(env, {
			kind: "task",
			runId,
			taskId,
			wt,
			events: doneEvent("done"),
			exit: "exit:0",
		});
		const finish = env.registry.finishStep.bind(env.registry);
		let lose = true;
		env.registry.finishStep = async (id, step, result) => {
			if (step === "settle" && lose) {
				lose = false;
				throw new Error("journal unavailable");
			}
			await finish(id, step, result);
		};

		await env.runner.finalize(run.id);
		expect(await settledEvents(env, run.id)).toHaveLength(1);
		await env.makeRunner().finalize(run.id);

		expect(await settledEvents(env, run.id)).toHaveLength(1);
		expect(Object.keys(await awaitingOf(env))).toEqual([taskId]);
		expect((await env.tasks.get(taskId))?.stallCount).toBe(1);
		expect((await env.registry.get(run.id))?.state).toBe("failed");
		await env.cleanup();
	});

	test("(e2) a check killed by a signal is not blamed on the task and is recorded loudly (T12i, MFW-47)", async () => {
		const env = await makeEnv();
		const wt = await addWorkspace(env.root, "t-e2");
		await commitIn(wt.path, "e2.txt", "half done\n");
		const runId = ulid();
		const taskId = await claimedTask(env, runId, {
			title: "unlucky work",
			verification: CRASHING_DOD,
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
		// Not blamed: back to ready, no stall or attempt consumed, dirty workspace kept for resume.
		expect(task?.status).toBe("ready");
		expect(task?.stallCount).toBe(0);
		expect(task?.attemptCount).toBe(0);
		expect(task?.preservedWorkspace).toBe(wt.path);
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

	/** The proposal a plan or import run's settle carries. */
	async function proposalOf(env: Env, runId: string) {
		const [settled] = await settledEvents(env, runId);
		return {
			cls: settled?.payload.class,
			facts: settled?.payload.facts as unknown as {
				proposal?: {
					parsed: boolean;
					tasks?: { title: string; status?: string; owns?: string[] }[];
					specs?: { title: string; body: string; tasks: (string | number)[] }[];
					questions?: string[];
				};
			},
		};
	}

	test("(f) an import run that proposed nothing settles plan_output with parsed: false, creates nothing, merges nothing", async () => {
		const env = await makeEnv();
		const wt = await addWorkspace(env.root, "t-f");
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
			"settle",
			"gc_workspace",
		]);
		const row = await env.registry.get(run.id);
		expect(row?.state).toBe("failed");
		expect(row?.note).toBe("importer proposed nothing");
		expect(env.merges).toEqual([]);
		const p = await proposalOf(env, run.id);
		expect(p.cls).toBe("plan_output");
		expect(p.facts.proposal).toEqual({ parsed: false });
		expect(await env.tasks.list()).toEqual([]);
		await env.cleanup();
	});

	test("(f2) an import proposal rides the settle for the brain: no task is created, no merge, nobody paged (I7)", async () => {
		const env = await makeEnv();
		const wt = await addWorkspace(env.root, "t-f2");
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

		expect(await journal(env, run.id)).toEqual([
			"classify",
			"reap_leftovers",
			"parse_plan",
			"settle",
			"gc_workspace",
		]);
		expect(env.merges).toEqual([]);
		expect(env.notifications).toEqual([]);
		expect(await env.tasks.list()).toEqual([]);
		const p = await proposalOf(env, run.id);
		expect(p.cls).toBe("plan_output");
		expect(p.facts.proposal?.parsed).toBe(true);
		expect(p.facts.proposal?.tasks?.map((t) => t.title)).toEqual([
			"Delete the dead adapter",
			"Document the deploy",
		]);
		expect((await env.registry.get(run.id))?.state).toBe("completed");
		await env.cleanup();
	});

	test("(f3) specs, statuses, owns and questions are normalized into the proposal; nothing is written or asked", async () => {
		const env = await makeEnv();
		const wt = await addWorkspace(env.root, "t-f3");
		const proposal = {
			tasks: [
				{ title: "Ship the parser", status: "done" },
				{ title: "Wire the UI", status: "in_progress", owns: ["src/ui/**"] },
				{ title: "Nonsense status", status: "quantum" },
				{ title: "Nothing stated" },
			],
			specs: [
				{
					title: "Adapter architecture",
					body: "Adapters are resolved through the catalogue.",
					tasks: [0, 1],
				},
			],
			questions: ["Stripe or Adyen?", "  ", "Do we invoice in EUR?"],
		};
		const run = await seedRun(env, {
			kind: "import",
			wt,
			events: doneEvent(JSON.stringify(proposal)),
			exit: "exit:0",
		});

		await env.runner.finalize(run.id);

		const p = (await proposalOf(env, run.id)).facts.proposal;
		const byTitle = new Map(p?.tasks?.map((t) => [t.title, t]));
		expect(byTitle.get("Ship the parser")?.status).toBe("done");
		// `in_progress` is not importable: it lands as ready.
		expect(byTitle.get("Wire the UI")?.status).toBe("ready");
		expect(byTitle.get("Wire the UI")?.owns).toEqual(["src/ui/**"]);
		expect(byTitle.get("Nonsense status")?.status).toBeUndefined();
		expect(p?.specs).toEqual([
			{
				title: "Adapter architecture",
				body: "Adapters are resolved through the catalogue.",
				tasks: [0, 1],
			},
		]);
		// The blank entry is dropped.
		expect(p?.questions).toEqual(["Stripe or Adyen?", "Do we invoice in EUR?"]);
		expect(await env.tasks.list()).toEqual([]);
		expect(await env.clarify.list({ open: true })).toEqual([]);
		expect(env.notifications).toEqual([]);
		await env.cleanup();
	});

	test("(g) a plan run settles plan_output once; re-finalization after a lost journal row neither duplicates the event nor creates tasks (P3)", async () => {
		const env = await makeEnv();
		const wt = await addWorkspace(env.root, "t-g");
		const plan = {
			tasks: [
				{
					title: "Alpha",
					body: "first",
					verification: {
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

		expect(await journal(env, run.id)).toEqual([
			"classify",
			"reap_leftovers",
			"parse_plan",
			"settle",
			"gc_workspace",
		]);
		expect(await env.tasks.list()).toEqual([]);
		const p = await proposalOf(env, run.id);
		expect(p.cls).toBe("plan_output");
		expect(p.facts.proposal?.tasks?.map((t) => t.title)).toEqual([
			"Alpha",
			"Beta",
		]);
		expect((await env.registry.get(run.id))?.state).toBe("completed");
		expect(existsSync(wt.path)).toBe(false); // plan workspaces are always gc'd

		// Crash between the settle's effect and its journal row.
		await env.handle.db
			.delete(runSteps)
			.where(and(eq(runSteps.runId, run.id), eq(runSteps.step, "settle")));
		await env.handle.db
			.update(runs)
			.set({ state: "finalizing", finishedAt: null })
			.where(eq(runs.id, run.id));

		await env.runner.finalize(run.id);

		expect(await settledEvents(env, run.id)).toHaveLength(1);
		expect(await env.tasks.list()).toEqual([]);
		expect((await env.registry.get(run.id))?.state).toBe("completed");
		await env.cleanup();
	});

	test("a plan with many tasks is capped in the settle facts, and says so", async () => {
		const env = await makeEnv();
		const wt = await addWorkspace(env.root, "t-cap");
		const plan = {
			tasks: Array.from({ length: 45 }, (_, i) => ({ title: `Task ${i}` })),
		};
		const run = await seedRun(env, {
			kind: "plan",
			wt,
			events: doneEvent(JSON.stringify(plan)),
			exit: "exit:0",
		});
		await env.runner.finalize(run.id);
		const [settled] = await settledEvents(env, run.id);
		const proposal = settled?.payload.facts.proposal;
		expect(proposal?.tasks).toHaveLength(40);
		expect(proposal?.truncatedTasks).toBe(5);
		await env.cleanup();
	});

	describe("a plan run expanding a draft task", () => {
		test("success leaves the draft a draft, releases its claim, and parks it awaiting the brain with the proposal", async () => {
			const env = await makeEnv();
			const wt = await addWorkspace(env.root, "t-draft-ok");
			const draft = await env.tasks.captureQuick("build the thing");
			const plan = {
				tasks: [
					{
						title: "Build the thing properly",
						body: "A fleshed-out description.",
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
				"settle",
				"gc_workspace",
			]);
			// The draft is untouched: applying the expansion is the brain's
			// update_task, with a rationale.
			const after = await env.tasks.get(draft.id);
			expect(after?.status).toBe("draft");
			expect(after?.claimedByRunId).toBeNull();
			expect(after?.title).not.toBe("Build the thing properly");
			expect(after?.draftPrompt).toBe("build the thing");
			expect((await env.tasks.list()).map((t) => t.id)).toEqual([draft.id]);
			expect((await awaitingOf(env))[draft.id]).toMatchObject({
				runId: run.id,
				class: "plan_output",
			});
			const p = await proposalOf(env, run.id);
			expect(p.facts.proposal?.tasks?.[0]).toMatchObject({
				title: "Build the thing properly",
				owns: ["src/**"],
			});
			await env.cleanup();
		});

		test("an unparseable proposal bumps the attempt counter but leaves the draft pending, below the cap", async () => {
			const env = await makeEnv({ draftExpandMaxAttempts: 3 });
			const wt = await addWorkspace(env.root, "t-draft-fail");
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
				"settle",
				"gc_workspace",
			]);
			const after = await env.tasks.get(draft.id);
			expect(after?.status).toBe("draft");
			expect(after?.draftPhase).toBe("retrying");
			expect(after?.draftAttempts).toBe(1);
			expect(after?.verification).toBeNull();
			expect(env.notifications).toEqual([]);
			await env.cleanup();
		});

		test("bounded retries exhausted: the draft stays failed in the record and nobody is paged by finalize", async () => {
			const env = await makeEnv({ draftExpandMaxAttempts: 1 });
			const wt = await addWorkspace(env.root, "t-draft-exhausted");
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
			expect(env.notifications).toEqual([]);
			await env.cleanup();
		});

		test("a stopped expansion settles stopped and records the failed attempt", async () => {
			const env = await makeEnv();
			const wt = await addWorkspace(env.root, "t-draft-stopped");
			const draft = await env.tasks.captureQuick("do the thing");
			const run = await seedRun(env, {
				kind: "plan",
				taskId: draft.id,
				wt,
				events: ev({ type: "message", role: "assistant", text: "thinking" }),
				exit: "killed:manual",
			});
			expect(
				await env.tasks.tryClaimDraftExpansion(draft.id, run.id, 60_000),
			).toBe(true);

			await env.runner.finalize(run.id);

			expect((await proposalOf(env, run.id)).cls).toBe("stopped");
			expect((await env.tasks.get(draft.id))?.draftAttempts).toBe(1);
			expect((await env.registry.get(run.id))?.state).toBe("killed");
			await env.cleanup();
		});

		test("a draft archived while its expansion is finalizing is not resurrected", async () => {
			const env = await makeEnv();
			const wt = await addWorkspace(env.root, "t-draft-archived");
			const draft = await env.tasks.captureQuick("never mind");
			const run = await seedRun(env, {
				kind: "plan",
				taskId: draft.id,
				wt,
				events: doneEvent(JSON.stringify({ tasks: [{ title: "Ghost" }] })),
				exit: "exit:0",
			});
			expect(
				await env.tasks.tryClaimDraftExpansion(draft.id, run.id, 60_000),
			).toBe(true);
			await env.tasks.release(draft.id, run.id, "draft", "human", "released");
			await env.tasks.move(draft.id, "archived", "human", "not wanted");

			await env.runner.finalize(run.id);

			expect((await env.tasks.get(draft.id))?.status).toBe("archived");
			expect(
				(await env.tasks.list()).filter((t) => t.title === "Ghost"),
			).toEqual([]);
			expect((await awaitingOf(env))[draft.id]).toMatchObject({
				class: "plan_output",
			});
			await env.cleanup();
		});
	});
});

describe("scope watchdog: T4s kill and the finish-time scope gate", () => {
	test("a scope kill saves the work to wip/ before the workspace goes, settles scope_violation with the ref, and never repairs", async () => {
		const env = await makeEnv();
		const wt = await addWorkspace(env.root, "t-scope");
		await commitIn(wt.path, "committed.txt", "committed\n");
		await writeFile(join(wt.path, "other.ts"), "uncommitted drift\n");
		const runId = ulid();
		const taskId = await claimedTask(env, runId, { title: "drifting agent" });
		const run = await seedRun(env, {
			kind: "task",
			runId,
			taskId,
			wt,
			events: ev({ type: "message", role: "assistant", text: "editing" }),
			exit: "killed:watchdog-scope",
		});
		// What the supervisor persisted when it killed.
		await env.registry.setScopeSample(run.id, {
			files: 2,
			outside: 1,
			foreign: 1,
			level: "violation",
			maxFiles: 150,
			sampledAt: Date.now(),
			outsideFiles: ["other.ts"],
			foreignFiles: [{ path: "other.ts", taskId: "MFW-999" }],
		});

		await env.runner.finalize(run.id);

		expect(await journal(env, run.id)).toEqual([
			"classify",
			"reap_leftovers",
			"ingest_report",
			"archive_wip",
			"settle",
			"gc_workspace",
		]);
		const row = await env.registry.get(run.id);
		expect(row?.state).toBe("killed");
		expect(row?.killReason).toBe("watchdog-scope");
		const task = await env.tasks.get(taskId);
		expect(task?.status).toBe("ready");
		expect(task?.stallCount).toBe(1);
		expect(env.notifications).toEqual([]);
		// The workspace is gone, the work is not: the wip branch holds the
		// committed file AND the uncommitted one.
		expect(existsSync(wt.path)).toBe(false);
		const ref = `wip/${taskId}-${run.id}`;
		const tree = await git(["ls-tree", "-r", "--name-only", ref], env.root);
		expect(tree.exitCode).toBe(0);
		expect(tree.stdout.split("\n")).toEqual(
			expect.arrayContaining(["committed.txt", "other.ts"]),
		);
		const [settled] = await settledEvents(env, run.id);
		expect(settled?.payload.class).toBe("scope_violation");
		expect(settled?.payload.facts.archivedRef).toBe(ref);
		expect(settled?.payload.facts.killReason).toBe("watchdog-scope");
		await env.cleanup();
	});

	test("verified work that changed files outside its owns settles scope_outside (T14s), is not merged and is not sent to a person", async () => {
		const env = await makeEnv();
		const wt = await addWorkspace(env.root, "t-outside");
		await commitIn(wt.path, "src/owned.ts", "owned\n");
		await commitIn(wt.path, "docs/stray.md", "stray\n");
		const runId = ulid();
		const t = await env.tasks.create({
			title: "scoped work",
			status: "ready",
			verification: PASSING_DOD,
			owns: ["src/**"],
		});
		expect(await env.tasks.tryClaim(t.id, runId, 60_000)).toBe(true);
		const run = await seedRun(env, {
			kind: "task",
			runId,
			taskId: t.id,
			wt,
			events: doneEvent("done"),
			exit: "exit:0",
			report: { summary: "did it" },
		});
		const runner = env.makeRunner({
			scopePolicy: () => ({ onFinish: "review" }),
		});

		await runner.finalize(run.id);

		const steps = await env.registry.steps(run.id);
		expect(steps.map((s) => s.step)).toContain("scope_check");
		expect(steps.find((s) => s.step === "scope_check")?.result).toMatchObject({
			outside: 1,
			outsideFiles: ["docs/stray.md"],
		});
		expect(env.merges).toEqual([]);
		expect((await env.tasks.get(t.id))?.status).toBe("ready");
		expect((await env.registry.get(run.id))?.state).toBe("needs_review");
		const [settled] = await settledEvents(env, run.id);
		expect(settled?.payload.class).toBe("scope_outside");
		expect(settled?.payload.facts.scope).toMatchObject({
			outside: 1,
			outsideFiles: ["docs/stray.md"],
		});
		expect(env.notifications).toEqual([]);
		await env.cleanup();
	});

	test("with onFinish off the same run merges", async () => {
		const env = await makeEnv();
		const wt = await addWorkspace(env.root, "t-outside-off");
		await commitIn(wt.path, "docs/stray.md", "stray\n");
		const runId = ulid();
		const t = await env.tasks.create({
			title: "scoped work",
			status: "ready",
			verification: PASSING_DOD,
			owns: ["src/**"],
		});
		expect(await env.tasks.tryClaim(t.id, runId, 60_000)).toBe(true);
		const run = await seedRun(env, {
			kind: "task",
			runId,
			taskId: t.id,
			wt,
			events: doneEvent("done"),
			exit: "exit:0",
			report: { summary: "did it" },
		});
		await env
			.makeRunner({ scopePolicy: () => ({ onFinish: "off" }) })
			.finalize(run.id);
		expect(await journal(env, run.id)).not.toContain("scope_check");
		expect(env.merges).toHaveLength(1);
		await env.cleanup();
	});
});

describe("the task-level review gate (requireReview, T11)", () => {
	test("a no-DoD task merges on a passing exit code when nobody asked to look", async () => {
		const env = await makeEnv();
		const wt = await addWorkspace(env.root, "t-skip");
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
			{
				runId: run.id,
				taskId,
				branch: wt.branch,
				targetBranch: "main",
				requireVerified: false,
			},
		]);
		await env.cleanup();
	});

	test("the task's OWN requireReview stops it", async () => {
		const env = await makeEnv();
		const wt = await addWorkspace(env.root, "t-req");
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
	test("a transient report read failure preserves the workspace until retry journals it", async () => {
		const env = await makeEnv();
		const wt = await addWorkspace(env.root, "report-read-failure");
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
		expect(await journal(env, run.id)).not.toContain("gc_workspace");

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

	test("action cleanup journals its workspace report before removal", async () => {
		const env = await makeEnv();
		const wt = await addWorkspace(env.root, "report-action");
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
			"gc_workspace",
		]);
		const ingested = (await env.registry.steps(run.id)).find(
			(step) => step.step === "ingest_report",
		);
		expect(ingested?.result).toEqual({
			report,
			workspaceReport: {
				state: "present",
				sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
			},
		});
		expect(existsSync(wt.path)).toBe(false);
		await env.cleanup();
	});

	test("failed repair cleanup journals its report before removal", async () => {
		const env = await makeEnv();
		const wt = await addWorkspace(env.root, "report-failed-repair");
		const report = { summary: "repair interrupted after diagnostics" };
		await writeFile(join(wt.path, "MFW_REPORT.json"), JSON.stringify(report));
		const run = await seedRun(env, { kind: "repair", wt });

		await env.runner.finalize(run.id);

		expect(await journal(env, run.id)).toEqual([
			"classify",
			"reap_leftovers",
			"ingest_report",
			"gc_workspace",
		]);
		expect(
			(await env.registry.steps(run.id)).find(
				(step) => step.step === "ingest_report",
			)?.result,
		).toEqual({
			report,
			workspaceReport: {
				state: "present",
				sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
			},
		});
		expect(existsSync(wt.path)).toBe(false);
		await env.cleanup();
	});

	test("interrupted task cleanup cannot discard an uningested report", async () => {
		const env = await makeEnv({ mergeChecks: null });
		const wt = await addWorkspace(env.root, "report-interrupted-task");
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
			"settle",
			"gc_workspace",
		]);
		expect(
			(await env.registry.steps(run.id)).find(
				(step) => step.step === "ingest_report",
			)?.result,
		).toEqual({
			report,
			workspaceReport: {
				state: "present",
				sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
			},
		});
		expect(existsSync(wt.path)).toBe(false);
		expect((await env.tasks.get(taskId))?.status).toBe("ready");
		await env.cleanup();
	});

	test("a report rewritten after journaled ingestion survives cleanup", async () => {
		const env = await makeEnv();
		const wt = await addWorkspace(env.root, "report-post-ingest-rewrite");
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
			workspaceReport: {
				state: "present",
				sha256: createHash("sha256").update(original).digest("hex"),
			},
		});
		await writeFile(reportPath, '{"summary":"late rewrite"}\n');

		await env.runner.finalize(run.id);

		// Not the journaled report, and never imported: the clone is kept.
		expect(existsSync(wt.path)).toBe(true);
		expect(await readFile(reportPath, "utf8")).toContain("late rewrite");
		expect(
			(await env.registry.steps(run.id)).find(
				(step) => step.step === "gc_workspace",
			)?.result,
		).toEqual({ removed: false, preserved: true });
		await env.cleanup();
	});
});

describe("MFW-48: a project default DoD stands in for a task with none", () => {
	test("a no-DoD task is actually verified, and merges when the default passes", async () => {
		const env = await makeEnv({ mergeChecks: PASSING_DOD });
		const wt = await addWorkspace(env.root, "t-default-pass");
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
			{
				runId: run.id,
				taskId,
				branch: wt.branch,
				targetBranch: "main",
				requireVerified: true,
			},
		]);
		// The default is resolved at verification time, never written to the file.
		expect((await env.tasks.get(taskId))?.verification).toBeNull();
		await env.cleanup();
	});

	test("a no-DoD task does not merge on exit 0 when the default fails", async () => {
		const env = await makeEnv({ mergeChecks: FAILING_DOD });
		const wt = await addWorkspace(env.root, "t-default-fail");
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
			"settle",
		]);
		expect(env.merges).toEqual([]);
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
		const wt = await addWorkspace(env.root, "t-followups");
		const runId = ulid();
		const taskId = await claimedTask(env, runId, {
			title: "parser work",
			verification: PASSING_DOD,
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
			wt: await addWorkspace(env.root, "t-followups-2"),
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
	test("are stopped, journaled, and a completed run settles background_work instead of being verified", async () => {
		const env = await makeEnv();
		const wt = await addWorkspace(env.root, "t-leftover");
		await commitIn(wt.path, "a.txt", "work\n");
		const runId = ulid();
		const taskId = await claimedTask(env, runId, {
			title: "left a watcher running",
			verification: PASSING_DOD,
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
			"settle",
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
		expect(env.merges).toEqual([]);
		// The work stays in the workspace for the brain's `continue:` spawn.
		expect(existsSync(wt.path)).toBe(true);
		expect((await env.tasks.get(taskId))?.status).toBe("ready");
		const [settled] = await settledEvents(env, run.id);
		expect(settled?.payload.class).toBe("background_work");
		expect((await env.registry.get(run.id))?.state).toBe("failed");
		await env.cleanup();
	});

	test("nothing left running: nothing stopped, verification as usual", async () => {
		const env = await makeEnv();
		const wt = await addWorkspace(env.root, "t-no-leftover");
		await commitIn(wt.path, "a.txt", "work\n");
		const runId = ulid();
		const taskId = await claimedTask(env, runId, {
			title: "clean exit",
			verification: PASSING_DOD,
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
		expect(await journal(env, run.id)).not.toContain("settle");
		await env.cleanup();
	});
});

describe("plan entries: owns and model_tier", () => {
	test("valid owns patterns and a known tier reach the proposal the brain applies", async () => {
		const env = await makeEnv();
		const wt = await addWorkspace(env.root, "t-plan-owns");
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

		const [settled] = await settledEvents(env, run.id);
		const tasks = (
			settled?.payload.facts.proposal as unknown as {
				tasks: { title: string; owns: string[]; modelTier?: string }[];
			}
		).tasks;
		const [scoped, unscoped] = tasks;
		expect(scoped?.owns).toEqual(["src/parser", "docs/**"]);
		expect(scoped?.modelTier).toBe("strong");
		expect(unscoped?.owns).toEqual([]);
		expect(unscoped?.modelTier).toBeUndefined();
		await env.cleanup();
	});
});

describe("durable cleanup", () => {
	async function backgroundRun(exit = "exit:0") {
		const env = await makeEnv();
		const wt = await addWorkspace(env.root, "durable-cleanup");
		await commitIn(wt.path, "a.txt", "work\n");
		const runId = ulid();
		const taskId = await claimedTask(env, runId, {
			title: "background work",
			verification: PASSING_DOD,
		});
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
	])("a run that left work running settles background_work and keeps its workspace (%s)", async (exit) => {
		const { env, run, taskId, wt } = await backgroundRun(exit);
		await env.runner.finalize(run.id);
		expect((await settledEvents(env, run.id))[0]?.payload.class).toBe(
			exit ? "background_work" : "interrupted",
		);
		expect((await env.tasks.get(taskId))?.claimedByRunId).toBeNull();
		expect(await journal(env, run.id)).not.toContain("verify");
		expect(existsSync(wt.path)).toBe(true);
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
		expect((await settledEvents(env, run.id))[0]?.payload.class).toBe(
			"background_work",
		);
		expect(env.merges).toEqual([]);
		const reaped = (await env.registry.journalGuard(
			run.id,
			"reap_leftovers",
		)) as { processes: LeftoverProcess[] };
		expect(reaped.processes).toEqual([process]);
		await env.cleanup();
	});

	test("unconfirmed cleanup parks visibly while retaining claim and resources", async () => {
		const { env, run, taskId, process, wt } = await backgroundRun();
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
		expect((await settledEvents(env, run.id))[0]?.payload.class).toBe(
			"background_work",
		);
		await env.cleanup();
	});

	test("regression repair cleans up and files follow-ups without taking its historical task", async () => {
		const env = await makeEnv();
		const task = await env.tasks.create({
			title: "historical done task",
			status: "done",
			verification: PASSING_DOD,
		});
		const wt = await addWorkspace(env.root, "repair-cleanup");
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

describe("usage accounting", () => {
	test("classify keeps cached-input and reasoning-output tokens from the last usage event", async () => {
		const env = await makeEnv();
		const wt = await addWorkspace(env.root, "usage");
		const runId = ulid();
		const taskId = await claimedTask(env, runId, { title: "count me" });
		const run = await seedRun(env, {
			kind: "task",
			runId,
			taskId,
			wt,
			events:
				ev({ type: "usage", inputTokens: 1, outputTokens: 1 }) +
				ev({
					type: "usage",
					inputTokens: 1200,
					outputTokens: 300,
					cachedInputTokens: 900,
					reasoningOutputTokens: 120,
					costUsd: 0.42,
					turns: 3,
					cumulative: true,
				}),
			exit: "killed:manual",
		});

		await env.runner.finalize(run.id);

		expect((await env.registry.get(run.id))?.usage).toEqual({
			inputTokens: 1200,
			outputTokens: 300,
			cachedInputTokens: 900,
			reasoningOutputTokens: 120,
			costUsd: 0.42,
			turns: 3,
		});
		await env.cleanup();
	});
});

describe("a human stop-and-move survives finalization", () => {
	for (const to of ["backlog", "done"] as const) {
		test(`cancel-and-move to ${to}, then finalize T3: the task stays ${to}`, async () => {
			const env = await makeEnv();
			const wt = await addWorkspace(env.root, `cancel-${to}`);
			const runId = ulid();
			const taskId = await claimedTask(env, runId, { title: "stop me" });
			const run = await seedRun(env, {
				kind: "task",
				runId,
				taskId,
				wt,
				events: ev({ type: "message", role: "assistant", text: "working" }),
				exit: "killed:manual",
			});
			// What `tasks.move({cancelRun: true})` does after `engine.stop`.
			await env.tasks.release(taskId, runId, to, "human", "operator stop");

			await env.runner.finalize(run.id);

			expect(await journal(env, run.id)).toContain("release_task");
			const task = await env.tasks.get(taskId);
			expect(task?.status).toBe(to);
			expect(task?.claimedByRunId).toBeNull();
			expect((await env.registry.get(run.id))?.outcome).toBe("killed_manual");
			await env.cleanup();
		});
	}
});

describe("activity at finalize: questions and background work", () => {
	test("a question report settles question without a stall, raises a task clarification and keeps the workspace; nobody is pinged", async () => {
		const env = await makeEnv();
		const wt = await addWorkspace(env.root, "asks");
		await commitIn(wt.path, "half.txt", "half done\n");
		const runId = ulid();
		const taskId = await claimedTask(env, runId, {
			title: "needs a decision",
			verification: PASSING_DOD,
		});
		await writeFile(
			join(wt.path, "MFW_REPORT.json"),
			JSON.stringify({
				status: "question",
				question: "Keep the v1 endpoint for old clients?",
				options: ["keep it", "remove it"],
			}),
		);
		const run = await seedRun(env, {
			kind: "task",
			runId,
			taskId,
			wt,
			events: doneEvent("I need a decision."),
			exit: "exit:0",
		});

		await env.runner.finalize(run.id);

		expect(await journal(env, run.id)).toEqual([
			"classify",
			"reap_leftovers",
			"ingest_report",
			"record_question",
			"settle",
		]);
		const task = await env.tasks.get(taskId);
		expect(task?.status).toBe("ready");
		expect(task?.stallCount).toBe(0);
		expect(task?.preservedWorkspace).toBe(wt.path);
		expect(existsSync(wt.path)).toBe(true);
		const [question] = await env.clarify.list({ open: true });
		expect(question).toMatchObject({ runId: run.id, kind: "task" });
		expect(question?.items[0]?.question).toContain(
			"Keep the v1 endpoint for old clients?",
		);
		expect(question?.items[0]?.question).toContain("keep it | remove it");
		expect(env.notifications).toEqual([]);
		const [settled] = await settledEvents(env, run.id);
		expect(settled?.payload.class).toBe("question");
		expect(settled?.payload.facts.report?.question).toContain("v1 endpoint");
		const after = await env.registry.get(run.id);
		expect(after?.state).toBe("completed");
		expect(after?.activity).toBe("needs_answer");
		expect(after?.activityDetail).toMatchObject({
			question: "Keep the v1 endpoint for old clients?",
			questionSource: "report",
		});
		await env.cleanup();
	});

	test("a question report without question text is ignored (verification decides)", async () => {
		const env = await makeEnv();
		const wt = await addWorkspace(env.root, "asks-nothing");
		await commitIn(wt.path, "done.txt", "done\n");
		const runId = ulid();
		const taskId = await claimedTask(env, runId, {
			title: "empty question",
			verification: PASSING_DOD,
		});
		await writeFile(
			join(wt.path, "MFW_REPORT.json"),
			JSON.stringify({ status: "question" }),
		);
		const run = await seedRun(env, {
			kind: "task",
			runId,
			taskId,
			wt,
			events: doneEvent(),
			exit: "exit:0",
		});
		await env.runner.finalize(run.id);
		expect(await journal(env, run.id)).toContain("verify");
		expect(await env.clarify.list({ open: true })).toEqual([]);
		await env.cleanup();
	});

	test('the scope prompt\'s `"status": "blocked"` report is honoured like `escalation`', async () => {
		const env = await makeEnv();
		const wt = await addWorkspace(env.root, "status-blocked");
		const runId = ulid();
		const taskId = await claimedTask(env, runId, {
			title: "out of scope",
			verification: PASSING_DOD,
		});
		await writeFile(
			join(wt.path, "MFW_REPORT.json"),
			JSON.stringify({ status: "blocked", issues: ["needs src/other"] }),
		);
		const run = await seedRun(env, {
			kind: "task",
			runId,
			taskId,
			wt,
			events: doneEvent(),
			exit: "exit:0",
		});
		await env.runner.finalize(run.id);
		expect(await journal(env, run.id)).not.toContain("verify");
		expect((await settledEvents(env, run.id))[0]?.payload.class).toBe(
			"report_blocked",
		);
		expect((await env.tasks.get(taskId))?.status).toBe("ready");
		expect(env.notifications).toEqual([]);
		await env.cleanup();
	});

	test("a turn that ended on a background job settles background_work instead of failing verify, and the run is labelled stalled", async () => {
		const env = await makeEnv();
		const wt = await addWorkspace(env.root, "bg-job");
		const runId = ulid();
		const taskId = await claimedTask(env, runId, {
			title: "runs tests in the background",
			verification: FAILING_DOD,
		});
		const events =
			ev({
				type: "tool_call",
				id: "b1",
				name: "Bash",
				input: { command: "bun test", run_in_background: true },
			}) +
			ev({
				type: "tool_result",
				id: "b1",
				ok: true,
				output: "Command running in background with ID: bash_1",
			}) +
			ev({ type: "message", role: "assistant", text: "Tests are running." }) +
			ev({
				type: "session",
				provider: "claude-cli",
				sessionId: "s",
				status: "completed",
				ordinal: 1,
			}) +
			doneEvent();
		const run = await seedRun(env, {
			kind: "task",
			runId,
			taskId,
			wt,
			events,
			exit: "exit:0",
		});

		await env.runner.finalize(run.id);

		const steps = await journal(env, run.id);
		expect(steps).toEqual([
			"classify",
			"reap_leftovers",
			"ingest_report",
			"settle",
		]);
		expect((await env.tasks.get(taskId))?.stallCount).toBe(0);
		const [settled] = await settledEvents(env, run.id);
		expect(settled?.payload.class).toBe("background_work");
		const classify = (await env.registry.steps(run.id)).find(
			(s) => s.step === "classify",
		);
		expect(classify?.result).toMatchObject({
			background: [
				expect.objectContaining({ tool: "Bash", summary: "bun test" }),
			],
		});
		const after = await env.registry.get(run.id);
		expect(after?.activity).toBe("stalled");
		expect(after?.activityDetail).toMatchObject({ stallCause: "background" });
		await env.cleanup();
	});
});

describe("StepRunner: review verdicts", () => {
	async function reviewedRun(critic: BrainPort["critic"]) {
		const env = await makeEnv();
		const runner = env.makeRunner({
			brain: { ...env.brain, enabled: true, criticEnabled: true, critic },
		});
		const wt = await addWorkspace(env.root, `rv-${ulid().slice(-6)}`);
		await commitIn(wt.path, "a.txt", "work\n");
		const runId = ulid();
		const t = await env.tasks.create({
			title: "reviewed work",
			status: "ready",
			verification: PASSING_DOD,
			criteria: [{ text: "parses the input" }, { text: "handles errors" }],
		});
		expect(await env.tasks.tryClaim(t.id, runId, 60_000)).toBe(true);
		const run = await seedRun(env, {
			kind: "task",
			runId,
			taskId: t.id,
			wt,
			events: doneEvent("done"),
			exit: "exit:0",
			report: { summary: "did it" },
		});
		await runner.finalize(run.id);
		return { env, run, taskId: t.id };
	}

	test("a fix verdict settles review_fix with the findings, consumes a review round and no stall; nothing is spawned", async () => {
		const { env, run, taskId } = await reviewedRun(async () => ({
			status: "ok",
			flagged: true,
			verdict: "fix",
			round: 1,
			findings: [{ file: "a.txt", severity: "blocker", change: "do more" }],
		}));
		expect(await journal(env, run.id)).toEqual([
			"classify",
			"reap_leftovers",
			"ingest_report",
			"verify",
			"critic",
			"settle",
		]);
		const task = await env.tasks.get(taskId);
		expect(task?.reviewRound).toBe(1);
		expect(task?.stallCount).toBe(0);
		expect(task?.status).toBe("ready");
		expect(env.merges).toEqual([]);
		const [settled] = await settledEvents(env, run.id);
		expect(settled?.payload.class).toBe("review_fix");
		expect(settled?.payload.facts.review).toMatchObject({
			verdict: "fix",
			findings: [{ file: "a.txt", severity: "blocker" }],
		});
		expect((await env.registry.get(run.id))?.state).toBe("needs_review");
		await env.cleanup();
	});

	test("a failed review with a cause settles infra_failure carrying the cause; nothing merges and nobody is paged", async () => {
		const { env, run, taskId } = await reviewedRun(async () => ({
			status: "failed",
			cause: "reviewer_not_independent",
			reason: "same model",
		}));
		const task = await env.tasks.get(taskId);
		expect(task?.status).toBe("ready");
		expect(env.merges).toEqual([]);
		const [settled] = await settledEvents(env, run.id);
		expect(settled?.payload.class).toBe("infra_failure");
		expect(settled?.payload.facts.review).toMatchObject({
			status: "failed",
			cause: "reviewer_not_independent",
		});
		expect(env.notifications).toEqual([]);
		await env.cleanup();
	});

	test("criteria the reviewer found met on real evidence are ticked; claimed ones are not", async () => {
		const { env, taskId } = await reviewedRun(async () => ({
			status: "ok",
			flagged: false,
			verdict: "merge",
			round: 1,
			criteria: [
				{
					criterion: "parses the input",
					verdict: "met",
					evidenceClass: "reproduced",
					evidence: "ran it",
				},
				{
					criterion: "handles errors",
					verdict: "met",
					evidenceClass: "claimed",
					evidence: "the agent says so",
				},
			],
		}));
		const task = await env.tasks.get(taskId);
		expect(task?.criteria.map((c) => [c.text, c.checked])).toEqual([
			["parses the input", true],
			["handles errors", false],
		]);
		await env.cleanup();
	});
});

describe("provenance: a forged outbox never renders as host-observed", () => {
	/** A run the host launched split, ended with `hostExit`, and an agent's forgeries. */
	async function forgedRun(env: Env, name: string, hostExit: string) {
		const wt = await addWorkspace(env.root, name);
		await commitIn(wt.path, `${name}.txt`, "work\n");
		const runId = ulid();
		const taskId = await claimedTask(env, runId, { title: name });
		const run = await seedRun(env, { kind: "task", runId, taskId, wt });
		const dir = env.registry.runDir(run.id);
		const { control, outbox } = ensureRunDirLayout(dir);
		await env.registry.markRunDirSplit(run.id);
		await writeFile(join(control, "driver.json"), "{}");
		await writeFile(join(control, "exit"), hostExit);
		await writeFile(join(outbox, "exit"), "exit:0");
		const fake = JSON.stringify({ status: "success", summary: "all done" });
		await writeFile(join(outbox, "MFW_REPORT.json"), fake);
		await writeFile(join(wt.path, "MFW_REPORT.json"), fake);
		return { run, taskId, control, outbox };
	}

	test("the host's non-zero exit wins the verdict and both facts are kept", async () => {
		const env = await makeEnv({ mergeChecks: null });
		const { run, taskId } = await forgedRun(env, "forged", "exit:3");

		await env.runner.finalize(run.id);

		const row = await env.registry.get(run.id);
		expect(row?.exitCode).toBe(3);
		expect(row?.state).toBe("failed");
		expect(env.merges).toEqual([]);
		expect((await env.tasks.get(taskId))?.status).not.toBe("done");

		const view = await runProvenanceView(env.handle.db, run.id);
		expect(view.exit).toEqual({
			observed: { kind: "exit", code: 3 },
			agentSays: { kind: "exit", code: 0 },
			disagree: true,
		});
		expect(view.reportStatus).toBe("success");
		expect(view.facts).toContainEqual({
			fact: "report",
			provenance: "sandbox-reported",
		});
		await env.cleanup();
	});

	test("positive control: the same run with a clean host exit is not failed", async () => {
		const env = await makeEnv({ mergeChecks: null });
		const { run } = await forgedRun(env, "honest", "exit:0");
		await env.runner.finalize(run.id);
		const row = await env.registry.get(run.id);
		expect(row?.exitCode).toBe(0);
		expect(row?.state).not.toBe("failed");
		const view = await runProvenanceView(env.handle.db, run.id);
		expect(view.exit.observed).toEqual({ kind: "exit", code: 0 });
		expect(view.exit.disagree).toBe(false);
		await env.cleanup();
	});

	test("a control/exit planted in a flat run dir earns no host-observed tag", async () => {
		const env = await makeEnv({ mergeChecks: null });
		const wt = await addWorkspace(env.root, "planted");
		const runId = ulid();
		const taskId = await claimedTask(env, runId, { title: "planted" });
		const run = await seedRun(env, { kind: "task", runId, taskId, wt });
		// No markRunDirSplit: this is what an agent in an older run could build.
		const { control } = ensureRunDirLayout(env.registry.runDir(run.id));
		await writeFile(join(control, "driver.json"), "{}");
		await writeFile(join(control, "exit"), "exit:0");

		await env.runner.finalize(run.id);

		const view = await runProvenanceView(env.handle.db, run.id);
		expect(view.exit.observed).toBeNull();
		expect(view.exit.agentSays).toEqual({ kind: "exit", code: 0 });
		await env.cleanup();
	});

	test("a report symlinked to a host file is not ingested", async () => {
		const env = await makeEnv({ mergeChecks: null });
		const { run, outbox } = await forgedRun(env, "linked", "exit:3");
		const wtReport = join(run.workspacePath as string, "MFW_REPORT.json");
		const secret = join(env.root, "host-secret.json");
		await writeFile(secret, JSON.stringify({ status: "HOSTSECRET" }));
		for (const path of [wtReport, join(outbox, "MFW_REPORT.json")]) {
			await rm(path);
			await symlink(secret, path);
		}
		await env.runner.finalize(run.id);
		const view = await runProvenanceView(env.handle.db, run.id);
		expect(view.reportStatus).toBeNull();
		const steps = await env.registry.steps(run.id);
		expect(JSON.stringify(steps)).not.toContain("HOSTSECRET");
		await env.cleanup();
	});

	test("a FIFO as the report does not hang finalize", async () => {
		const env = await makeEnv({ mergeChecks: null });
		const { run, outbox } = await forgedRun(env, "fifo", "exit:3");
		const wtReport = join(run.workspacePath as string, "MFW_REPORT.json");
		for (const path of [wtReport, join(outbox, "MFW_REPORT.json")]) {
			await rm(path);
			Bun.spawnSync(["mkfifo", path]);
		}
		await env.runner.finalize(run.id);
		expect((await env.registry.get(run.id))?.state).toBe("failed");
		await env.cleanup();
	}, 20_000);

	test("a crash after classify keeps the host's exit through the restart", async () => {
		const env = await makeEnv({ mergeChecks: null });
		const { run, control } = await forgedRun(env, "crash", "exit:3");
		const crashing = env.makeRunner({
			leftovers: {
				find: async () => {
					throw new Error("crash after classify");
				},
				stop: async () => ({
					stopped: [],
					killed: [],
					absent: [],
					live: [],
					unknown: [],
				}),
			},
		});
		await crashing.finalize(run.id).catch(() => {});
		expect((await journal(env, run.id))[0]).toBe("classify");
		const before = await runProvenanceView(env.handle.db, run.id);
		expect(before.exit.observed).toEqual({ kind: "exit", code: 3 });

		// Even a changed file cannot rewrite what was already observed.
		await writeFile(join(control, "exit"), "exit:0");
		await env.registry.clearStaleFinalizeOwners("next-boot");
		await env.makeRunner().finalize(run.id);

		const row = await env.registry.get(run.id);
		expect(row?.exitCode).toBe(3);
		expect(row?.state).toBe("failed");
		const after = await runProvenanceView(env.handle.db, run.id);
		expect(after.exit.observed).toEqual({ kind: "exit", code: 3 });
		expect(after.exit.agentSays).toEqual({ kind: "exit", code: 0 });
		await env.cleanup();
	});
});

describe("a run on the default config", () => {
	const dodOn = (word: string) => ({
		verifier: "deterministic" as const,
		checks: [{ run: `grep -q ${word} state.txt`, expect_exit: 0 }],
	});

	/** Default mode and workspace, with a stand-in for the verifier sandbox. */
	async function defaultEnv() {
		expect(PROJECT_DEFAULTS.approvalMode).toBe("autonomous");
		const env = await makeEnv();
		const workspaces = await mkdtemp(join(tmpdir(), "mfw-sr-clones-"));
		const trees: string[] = [];
		const checkRunner: CheckRunner = (req) => {
			trees.push(req.tree);
			return runProc(["sh", "-c", req.command], {
				cwd: req.tree,
				timeoutMs: req.timeoutMs,
				maxOutputBytes: req.maxOutputBytes,
			});
		};
		const drop = useCheckClones(env.root, {
			workspaceRoot: workspaces,
			checkRunner,
		});
		return {
			env,
			trees,
			workspaces,
			runner: env.runner,
			done: async () => {
				await drop();
				await env.cleanup();
			},
		};
	}

	async function endedRun(
		env: Env,
		name: string,
		verification: ReturnType<typeof dodOn>,
		content: string,
	) {
		const wt = await addWorkspace(env.root, name);
		await commitIn(wt.path, "state.txt", content);
		const runId = ulid();
		const taskId = await claimedTask(env, runId, { title: name, verification });
		const run = await seedRun(env, {
			kind: "task",
			runId,
			taskId,
			wt,
			events: doneEvent("done"),
			exit: "exit:0",
		});
		return { wt, run };
	}

	const verifyFacts = async (env: Env, runId: string) =>
		(await settledEvents(env, runId))[0]?.payload.facts.verify;

	test("a passing check passes, and runs only in the sandbox on a clone", async () => {
		const t = await defaultEnv();
		const { wt, run } = await endedRun(
			t.env,
			"d-pass",
			dodOn("good"),
			"good\n",
		);

		await t.runner.finalize(run.id);

		expect(t.env.merges.map((m) => m.runId)).toEqual([run.id]);
		expect(t.trees.length).toBe(1);
		expect(t.trees[0]?.startsWith(t.workspaces)).toBe(true);
		expect(t.trees[0]).not.toBe(wt.path);
		await t.done();
	});

	test("a failing check fails", async () => {
		const t = await defaultEnv();
		const { run } = await endedRun(t.env, "d-fail", dodOn("good"), "bad\n");

		await t.runner.finalize(run.id);

		expect(t.env.merges).toEqual([]);
		expect(t.trees.length).toBe(1);
		expect((await verifyFacts(t.env, run.id))?.passed).toBe(false);
		await t.done();
	});

	test("an uncommitted edit cannot turn a failing commit green", async () => {
		const t = await defaultEnv();
		const { wt, run } = await endedRun(
			t.env,
			"d-dirty",
			dodOn("good"),
			"bad\n",
		);
		await writeFile(join(wt.path, "state.txt"), "good\n");

		await t.runner.finalize(run.id);

		expect(t.env.merges).toEqual([]);
		expect((await verifyFacts(t.env, run.id))?.passed).toBe(false);
		await t.done();
	});

	test("missing dependencies are an infrastructure result that names the fix", async () => {
		const t = await defaultEnv();
		const { wt, run } = await endedRun(t.env, "d-deps", dodOn("good"), "bad\n");
		await commitIn(wt.path, "package.json", "{}\n");

		await t.runner.finalize(run.id);

		expect(t.env.merges).toEqual([]);
		const events = await eventsSince(t.env.handle.db, 0, 5000);
		const check = events.find(
			(e) => e.type === "verify.check" && e.runId === run.id,
		) as unknown as { payload: { classification?: string; detail?: string } };
		expect(check.payload.classification).toBe("crashed");
		expect(check.payload.detail).toContain("not available in the sandbox");
		await t.done();
	});

	test("with no run workspace settings finalize refuses, and nothing runs on the host", async () => {
		const t = await defaultEnv();
		const marker = join(t.env.root, "ran-on-host");
		const dod = {
			verifier: "deterministic" as const,
			checks: [{ run: `touch '${marker}'`, expect_exit: 0 }],
		};
		const { run } = await endedRun(t.env, "d-none", dod, "good\n");
		clearRunWorkspace(t.env.root);

		await expect(t.runner.finalize(run.id)).rejects.toThrow(
			"no run workspace settings",
		);

		expect(existsSync(marker)).toBe(false);
		expect(t.env.merges).toEqual([]);
		await t.done();
	});
});
