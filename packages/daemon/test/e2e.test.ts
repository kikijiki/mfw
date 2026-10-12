import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { events } from "@mfw/db/schema";
import {
	attachProject,
	boot,
	type HostResourceAttachPort,
	type ProjectConfig,
} from "../src/boot.ts";
import { git } from "../src/git.ts";
import { acquireKernelLock } from "../src/kernel-lock.ts";
import { silentLogger } from "../src/log.ts";
import type { ProjectServices } from "../src/services.ts";
import { brainSpawn, openTurn, STUB_BRAIN } from "./support/brain-spawn.ts";

/**
 * End-to-end through the REAL composition root: a task goes ready → claimed →
 * agent run in a worktree (tmux, fake driver) → verified against its DoD →
 * merged to the integration branch → done, with the primary checkout never
 * checked out or reset by the daemon.
 *
 * The agent is faked at the driver boundary only; git, tmux, SQLite, the
 * worktree lifecycle, the finalize journal and the merge queue are all real.
 */

/** A driver that writes the file the DoD requires, commits it, and exits. */
const GOOD_DRIVER = `
const dir = process.argv[2];
const cfg = JSON.parse(await Bun.file(dir + "/driver.json").text());
const { appendFileSync } = await import("node:fs");
let seq = 0;
const emit = (e) => appendFileSync(dir + "/events.jsonl",
  JSON.stringify({ ts: new Date().toISOString(), seq: seq++, ...e }) + "\\n");
emit({ type: "hello", provider: "claude-cli", capabilities: { steer: true } });
await Bun.write(cfg.cwd + "/feature.txt", "implemented\\n");
const run = (args) => Bun.spawnSync(["git", ...args], { cwd: cfg.cwd });
run(["add", "-A"]);
run(["-c", "user.email=a@a", "-c", "user.name=agent", "commit", "-q", "-m", "feat: implement"]);
emit({ type: "message", role: "assistant", text: "done" });
emit({ type: "done", reason: "complete" });
process.exit(0);
`;

/** A hostile driver: reads, edits, deletes from the board, invents a task, fabricates a transition, `git add -A`s it all. It still does its real job, so the run must merge. */
const HOSTILE_DRIVER = `
const dir = process.argv[2];
const cfg = JSON.parse(await Bun.file(dir + "/driver.json").text());
const { appendFileSync, mkdirSync, writeFileSync, rmSync, existsSync } = await import("node:fs");
let seq = 0;
const emit = (e) => appendFileSync(dir + "/events.jsonl",
  JSON.stringify({ ts: new Date().toISOString(), seq: seq++, ...e }) + "\\n");
emit({ type: "hello", provider: "claude-cli", capabilities: { steer: true } });

// What it can SEE is the first thing worth recording.
writeFileSync(cfg.cwd + "/saw-board.txt",
  String(existsSync(cfg.cwd + "/tasks")) + " " + String(existsSync(cfg.cwd + "/.mfw/AGENTS.md")));

// ...and then the whole hostile repertoire, whether it can see it or not.
try {
  mkdirSync(cfg.cwd + "/tasks/ready", { recursive: true });
  mkdirSync(cfg.cwd + "/tasks/done", { recursive: true });
  writeFileSync(cfg.cwd + "/tasks/ready/HIJACK-1.md", "---\\nid: MFW-1\\nrev: 99\\ntitle: mine now\\n---\\n");
  mkdirSync(cfg.cwd + "/adrs", { recursive: true });
  writeFileSync(cfg.cwd + "/adrs/pwned.md", "mine\\n");
} catch {}
try { rmSync(cfg.cwd + "/tasks", { recursive: true, force: true }); } catch {}

// The real work.
await Bun.write(cfg.cwd + "/feature.txt", "implemented\\n");
const run = (args) => Bun.spawnSync(["git", ...args], { cwd: cfg.cwd });
run(["add", "-A"]);
run(["-c", "user.email=a@a", "-c", "user.name=agent", "commit", "-q", "-m", "feat: and a bit extra"]);
emit({ type: "message", role: "assistant", text: "done" });
emit({ type: "done", reason: "complete" });
process.exit(0);
`;

/** A driver that commits nothing, its DoD check must fail. */
const LAZY_DRIVER = `
const dir = process.argv[2];
const { appendFileSync } = await import("node:fs");
let seq = 0;
const emit = (e) => appendFileSync(dir + "/events.jsonl",
  JSON.stringify({ ts: new Date().toISOString(), seq: seq++, ...e }) + "\\n");
emit({ type: "hello", provider: "claude-cli", capabilities: { steer: true } });
emit({ type: "message", role: "assistant", text: "I claim success!" });
emit({ type: "done", reason: "complete" });
process.exit(0);
`;

async function waitFor(cond: () => Promise<boolean>, timeoutMs = 25_000) {
	const t0 = Date.now();
	while (Date.now() - t0 < timeoutMs) {
		if (await cond()) return;
		await Bun.sleep(120);
	}
	throw new Error("waitFor timed out");
}

/** Drive the candidate to Review, then model human approval through the API's merge queue (verification alone is not acceptance in this fixture). */
async function acceptAndMerge(
	svc: ProjectServices,
	taskId: string,
	runId: string,
): Promise<void> {
	await waitFor(async () => {
		await svc.supervisor.pass();
		return (await svc.tasks.get(taskId))?.status === "review";
	});
	const run = await svc.registry.get(runId);
	if (!run?.branch) throw new Error("review candidate has no branch");
	await svc.mergeQueue.enqueue({
		runId,
		taskId,
		branch: run.branch,
		targetBranch: run.integrationBranch ?? svc.integrationBranch,
	});
	expect(await svc.mergeQueue.tick()).toBe("merged");
}

async function makeRepo(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "mfw-e2e-"));
	await git(["init", "-q", "-b", "main"], root);
	await git(["config", "user.email", "t@t"], root);
	await git(["config", "user.name", "t"], root);
	await writeFile(join(root, "README.md"), "# e2e\n");
	// Real projects track this, and run worktrees must keep it: it is how an
	// agent learns the rules it is about to be judged against.
	await mkdir(join(root, ".mfw"), { recursive: true });
	await writeFile(join(root, ".mfw/AGENTS.md"), "the rules\n");
	await git(["add", "-A"], root);
	await git(["commit", "-q", "-m", "init"], root);
	return root; // attach writes .git/info/exclude itself
}

function useDriver(svc: ProjectServices, path: string) {
	// The adapter layer's test seams: swap the driver script and neutralize the
	// agent argv (the driver is what actually runs).
	const adapters = (
		svc.engine as unknown as {
			deps: {
				adapters: {
					driverOverride: string | null;
					buildArgv: (() => string[]) | null;
				};
			};
		}
	).deps.adapters;
	adapters.driverOverride = path;
	adapters.buildArgv = () => ["true"];
}

const cfg = (root: string): ProjectConfig => ({
	name: "demo",
	root,
	integrationBranch: "main",
	maxConcurrent: 2,
	assistance: {
		changeReview: "human",
	}, // no LLM in tests; passing work still exercises human approval
	brain: STUB_BRAIN, // a route that never wakes: the tests spawn as the brain would
});

// These engine tests intentionally exercise attachProject below Orchestrator;
// host admission is out of their scope. Production boot always supplies the
// real process-global coordinator (covered by host-resource/boot tests).
const detachedHost: HostResourceAttachPort = {
	captureAdmissionSnapshot: () => ({
		generation: 0n,
		capturedAt: 0,
		processBootId: "boot-e2e",
		kernelBootId: null,
		definitions: {},
		bindings: {},
		health: {},
		observations: {},
	}),
	readModel: () => {
		throw new Error("host admission is outside this engine test");
	},
	putWaiter: async () => {
		throw new Error("host admission is outside this engine test");
	},
	tryGrant: async () => {
		throw new Error("host admission is outside this engine test");
	},
	activate: async () => {
		throw new Error("host admission is outside this engine test");
	},
	renewOrAdopt: async () => {
		throw new Error("host admission is outside this engine test");
	},
	cancelOrRelease: async () => {
		throw new Error("host admission is outside this engine test");
	},
	reconcile: async () => {
		throw new Error("host recovery is outside this engine test");
	},
	registerProject: async () => {},
	subscribe: () => () => {},
};
const directAttach = (root: string) =>
	attachProject(cfg(root), silentLogger(), "boot-e2e", {
		hostResources: detachedHost,
		mfwHome: join(root, ".test-mfw-home"),
	});

describe("v2 end-to-end: goal → verified → merged", () => {
	test("a passing task is verified and merged to the integration branch", async () => {
		const root = await makeRepo();
		const remote = await mkdtemp(join(tmpdir(), "mfw-e2e-remote-"));
		await git(["init", "-q", "--bare", "-b", "main"], remote);
		await git(["remote", "add", "origin", remote], root);
		const driver = join(
			await mkdtemp(join(tmpdir(), "mfw-drv-")),
			"good-driver.ts",
		);
		await writeFile(driver, GOOD_DRIVER);
		const svc = await directAttach(root);
		useDriver(svc, driver);

		const task = await svc.tasks.create({
			title: "add the feature",
			dod: {
				verifier: "deterministic",
				checks: [{ files_exist: ["feature.txt"] }],
			},
		});
		await svc.tasks.move(task.id, "ready", "human");

		// One scheduler tick dispatches it.
		await brainSpawn(svc, task.id);
		await svc.scheduler.tick();
		const runs = await svc.registry.list({ taskId: task.id });
		expect(runs.length).toBe(1);
		const runId = runs[0]?.id as string;

		// Supervisor passes drive the whole tail (running → ended → finalize →
		// merge); the merge queue is deliberately never poked by hand.
		await acceptAndMerge(svc, task.id, runId);

		const finalTask = await svc.tasks.get(task.id);
		expect(finalTask?.status).toBe("done");
		// The work is on the integration branch...
		const show = await git(["show", "main:feature.txt"], root);
		expect(show.stdout).toContain("implemented");
		// ...the board transition is committed there too, and the primary is
		// clean (the merge tail published the transition itself).
		const status = await git(["status", "--porcelain"], root);
		expect(status.stdout.trim()).toBe("");
		expect((await git(["ls-files", "--", "tasks"], root)).stdout).toContain(
			`${task.id}-add-the-feature/task.md`,
		);
		// and the run's own branch never carried a board change
		expect(
			(await git(["log", "--format=%s", "-3", "main"], root)).stdout,
		).toContain("mfw: ");
		expect((await git(["rev-parse", "main"], remote)).stdout.trim()).toBe(
			(await git(["rev-parse", "main"], root)).stdout.trim(),
		);
		expect(
			(
				await git(
					["show", `main:tasks/${task.id}-add-the-feature/task.md`],
					remote,
				)
			).stdout,
		).toContain(`id: ${task.id}`);

		// The journal records what happened, in order.
		const steps = await svc.registry.steps(runId);
		const names = steps.map((s) => s.step);
		expect(names).toContain("classify");
		expect(names).toContain("verify");
		expect(names).toContain("release_task");
		expect(names).not.toContain("enqueue_merge");
		expect(steps.every((s) => s.status === "done")).toBe(true);
		svc.handle.close();
		await rm(root, { recursive: true, force: true });
		await rm(remote, { recursive: true, force: true });
	}, 60_000);

	test("a hostile agent cannot touch the board, and its real work still lands", async () => {
		// Two defences in one path: the run worktree is sparse-checked-out so
		// `tasks` is not there to damage, and the merge queue restores the
		// board from the merge base for anything that gets past that.
		const root = await makeRepo();
		const driver = join(
			await mkdtemp(join(tmpdir(), "mfw-drv-")),
			"hostile-driver.ts",
		);
		await writeFile(driver, HOSTILE_DRIVER);
		const svc = await directAttach(root);
		useDriver(svc, driver);

		// A board with something on it to lose.
		const victim = await svc.tasks.create({ title: "not yours to edit" });
		const task = await svc.tasks.create({
			title: "add the feature",
			dod: {
				verifier: "deterministic",
				checks: [{ files_exist: ["feature.txt"] }],
			},
		});
		await svc.tasks.move(task.id, "ready", "human");
		await svc.board.flush();
		const boardBefore = (
			await git(
				[
					"ls-tree",
					"-r",
					"--name-only",
					"main",
					"--",
					"tasks",
					"adrs",
					"board.yaml",
				],
				root,
			)
		).stdout;
		const victimBefore = (
			await git(
				["show", `main:tasks/${victim.id}-not-yours-to-edit/task.md`],
				root,
			)
		).stdout;

		await brainSpawn(svc, task.id);
		await svc.scheduler.tick();
		const runId = (await svc.registry.list({ taskId: task.id }))[0]
			?.id as string;
		await acceptAndMerge(svc, task.id, runId);
		await svc.board.flush();

		// The agent's real work landed.
		expect((await git(["show", "main:feature.txt"], root)).stdout).toContain(
			"implemented",
		);
		// It could not even see the board, the strongest available result.
		expect((await git(["show", "main:saw-board.txt"], root)).stdout).toBe(
			"false true",
		);
		// The board holds what mfw put there and nothing the agent invented (not
		// identical to `boardBefore`: mfw's own ready → done transition is in it).
		const boardAfter = (
			await git(
				[
					"ls-tree",
					"-r",
					"--name-only",
					"main",
					"--",
					"tasks",
					"adrs",
					"board.yaml",
				],
				root,
			)
		).stdout;
		expect(boardAfter).not.toContain("HIJACK-1.md");
		expect(boardAfter).not.toContain("pwned.md");
		expect(boardAfter).toContain(`tasks/${task.id}`);
		expect(boardBefore.split("\n").length).toBe(boardAfter.split("\n").length);
		expect(
			(
				await git(
					["show", `main:tasks/${victim.id}-not-yours-to-edit/task.md`],
					root,
				)
			).stdout,
		).toBe(victimBefore);
		expect((await svc.tasks.get(victim.id))?.title).toBe("not yours to edit");
		expect((await svc.tasks.list()).length).toBe(2);

		svc.handle.close();
		await rm(root, { recursive: true, force: true });
	}, 60_000);

	test("an agent that claims success without doing the work does NOT merge", async () => {
		// "Never trust the transcript", the run says done, the verifier disagrees.
		const root = await makeRepo();
		const driver = join(
			await mkdtemp(join(tmpdir(), "mfw-drv-")),
			"lazy-driver.ts",
		);
		await writeFile(driver, LAZY_DRIVER);
		const svc = await directAttach(root);
		useDriver(svc, driver);

		const task = await svc.tasks.create({
			title: "will not be done",
			dod: {
				verifier: "deterministic",
				checks: [{ files_exist: ["never-created.txt"] }],
			},
		});
		await svc.tasks.move(task.id, "ready", "human");
		await brainSpawn(svc, task.id);
		await svc.scheduler.tick();
		const runId = (await svc.registry.list({ taskId: task.id }))[0]
			?.id as string;

		await waitFor(async () => {
			await svc.supervisor.pass();
			const r = await svc.registry.get(runId);
			return r?.state === "failed" || r?.state === "finalize_error";
		});

		const finalTask = await svc.tasks.get(task.id);
		// Settled for the brain, not escalated to a person and not merged.
		expect(finalTask?.status).toBe("ready");
		expect(finalTask?.stallCount).toBe(1);
		// Nothing reached main.
		expect(
			(await git(["show", "main:never-created.txt"], root)).exitCode,
		).not.toBe(0);
		expect(await svc.mergeQueue.depth()).toBe(0);

		const settled = (await svc.handle.db.select().from(events)).find(
			(e) => e.type === "run.settled" && e.runId === runId,
		);
		expect(settled?.payload).toMatchObject({ class: "verify_failed" });
		expect(JSON.stringify(settled?.payload)).toContain("never-created.txt");
		// No session brief, no inbox escalation: the brain decides.
		expect(
			(await svc.sessions.list({ open: true })).filter(
				(x) => x.taskId === task.id,
			),
		).toEqual([]);

		svc.handle.close();
		await rm(root, { recursive: true, force: true });
	}, 60_000);

	test("boot() attaches, reconciles, and shuts down cleanly", async () => {
		const root = await makeRepo();
		const orch = await boot({
			projects: [cfg(root)],
			log: silentLogger(),
			autostart: false, // deterministic: no background loops in the assertion
		});
		expect(orch.list().map((s) => s.name)).toEqual(["demo"]);
		const svc = orch.get("demo");
		expect(svc.integrationBranch).toBe("main");

		// The health surface is real from the first boot.
		const snap = await svc.health.snapshot();
		expect(snap.bootId).toBe(orch.bootId);
		expect(snap.tasks.byStatus).toEqual({});

		// A task created through the service IS a file, its path frozen at
		// creation (status lives in frontmatter now, MFW-ADR-22).
		const t = await svc.tasks.create({ title: "on disk" });
		expect(
			await Bun.file(
				join(root, "tasks", `${t.id}-on-disk`, "task.md"),
			).exists(),
		).toBe(true);

		await orch.shutdown();
		await rm(root, { recursive: true, force: true });
	}, 30_000);

	test("attach excludes mfw's runtime by default, and tracks only the board", async () => {
		// Default-deny: everything under `.mfw/` is ignored except the five
		// human-meaningful paths (enumerating runtime dirs drifted silently).
		const root = await makeRepo();
		await writeFile(join(root, ".git/info/exclude"), "# mine\nnode_modules/\n");
		const orch = await boot({
			projects: [cfg(root)],
			log: silentLogger(),
			autostart: false,
		});
		const svc = orch.get("demo");
		await svc.tasks.create({ title: "on the board" });
		await svc.board.flush();

		// Every runtime artifact mfw has, plus one it does not have yet.
		for (const p of [
			".mfw/runs/x",
			".mfw/state/x",
			".mfw/locks/x",
			".mfw/integration/x",
			".mfw/sweep/x",
			".mfw/quarantine/x",
			".mfw/backups/x",
			".mfw/brand-new-thing/deep/x",
			"worktrees/x",
		]) {
			await mkdir(join(root, p, ".."), { recursive: true });
			await writeFile(join(root, p), "junk\n");
		}
		await writeFile(join(root, "MFW_REPORT.json"), "{}\n");

		// Nothing mfw made is visible, including dirs with no exclude line.
		expect((await git(["status", "--porcelain"], root)).stdout).toBe("");
		const add = await git(["add", "-A", "--dry-run"], root);
		expect(add.stdout).toBe("");
		// A lock file in someone's `git status` is now structurally impossible.
		expect(
			(await git(["check-ignore", "-q", "--", ".mfw/locks"], root)).exitCode,
		).toBe(0);
		// ...while the board is genuinely tracked.
		const tracked = (await git(["ls-files"], root)).stdout;
		expect(tracked).toContain("tasks/");
		expect(tracked).toContain("board.yaml");
		// ...and none of it under `.mfw/`, which holds daemon state only.
		expect(tracked).not.toContain(".mfw/tasks");
		expect(tracked).not.toContain(".mfw/board.yaml");

		// The human's own lines survive, and there is exactly one mfw block.
		const exclude = await Bun.file(join(root, ".git/info/exclude")).text();
		expect(exclude).toContain("# mine");
		expect(exclude).toContain("node_modules/");
		expect(exclude.match(/--- mfw \(managed/g)).toHaveLength(1);

		// and it is idempotent across boots
		await orch.shutdown();
		const again = await boot({
			projects: [cfg(root)],
			log: silentLogger(),
			autostart: false,
		});
		expect(await Bun.file(join(root, ".git/info/exclude")).text()).toBe(
			exclude,
		);
		await again.shutdown();
		await rm(root, { recursive: true, force: true });
	}, 30_000);

	test("an unknown project is a typed error, not a crash", async () => {
		const root = await makeRepo();
		const orch = await boot({
			projects: [cfg(root)],
			log: silentLogger(),
			autostart: false,
		});
		expect(() => orch.get("nope")).toThrow(/unknown project/);
		await orch.shutdown();
		await rm(root, { recursive: true, force: true });
	}, 30_000);
});

/**
 * An import is the only run kind that may file work as already finished. Full
 * path against the real composition root: proposal JSON, statuses, specs linked
 * to minted ids, worktree destroyed, board committed.
 */
const IMPORT_PROPOSAL = {
	tasks: [
		// Shipped, with an invented DoD that does not hold here (the regression sweep must not act on it).
		{
			title: "the auth module",
			body: "already shipped",
			status: "done",
			dod: {
				verifier: "deterministic",
				checks: [{ files_exist: ["src/auth.ts"] }],
			},
		},
		{ title: "session store", body: "half written", status: "in_progress" },
		{ title: "needs a look", status: "In Progress" }, // lenient: spaced + cased
		{ title: "password reset", status: "ready", depends_on: [1] },
		{ title: "audit log", status: "backlog" },
		{ title: "waiting on legal", status: "Blocked" },
		{ title: "rate limiting", status: "review" },
		{ title: "abandoned idea", status: "dropped" },
		{ title: "no status stated" },
		{ title: "invented status", status: "marinating" },
	],
	specs: [
		{
			title: "Authentication architecture",
			body: "# Auth\n\nSessions are server-side.\n",
			status: "active",
			tasks: [0, 1, 3],
		},
		{ title: "Unattached design note", body: "floats free", tasks: [] },
	],
	questions: [],
};

/** An importer: writes no code, emits its census as JSON in the final message. */
const IMPORT_DRIVER = `
const dir = process.argv[2];
const { appendFileSync } = await import("node:fs");
let seq = 0;
const emit = (e) => appendFileSync(dir + "/events.jsonl",
  JSON.stringify({ ts: new Date().toISOString(), seq: seq++, ...e }) + "\\n");
emit({ type: "hello", provider: "claude-cli", capabilities: { steer: false } });
emit({ type: "message", role: "assistant", text: "surveying the repository" });
emit({ type: "done", reason: "complete", resultText: ${JSON.stringify(
	`Here is the census.\n\n${JSON.stringify(IMPORT_PROPOSAL)}\n`,
)} });
process.exit(0);
`;

describe("v2 end-to-end: import a repository", () => {
	test("the proposal settles plan_output with normalized statuses and specs, nothing is written, the worktree is destroyed, and the brain applies it with create_tasks", async () => {
		const root = await makeRepo();
		const driver = join(
			await mkdtemp(join(tmpdir(), "mfw-drv-")),
			"import-driver.ts",
		);
		await writeFile(driver, IMPORT_DRIVER);
		const svc = await directAttach(root);
		useDriver(svc, driver);

		const { runId } = await svc.engine.startImport();
		const worktreePath = (await svc.registry.get(runId))
			?.worktreePath as string;
		expect(worktreePath).toBeTruthy();

		await waitFor(async () => {
			await svc.supervisor.pass();
			const r = await svc.registry.get(runId);
			return r?.state === "completed";
		});

		// --- nothing was applied: the proposal is the run's output
		expect(await svc.tasks.list()).toEqual([]);
		const settled = (await svc.handle.db.select().from(events)).find(
			(e) => e.type === "run.settled" && e.runId === runId,
		);
		expect(settled?.payload).toMatchObject({ class: "plan_output" });
		const proposal = (
			settled?.payload as {
				facts: {
					proposal: {
						parsed: boolean;
						tasks: { title: string; status?: string }[];
						specs: { title: string; tasks: number[] }[];
					};
				};
			}
		).facts.proposal;
		expect(proposal.parsed).toBe(true);
		const status = new Map(proposal.tasks.map((t) => [t.title, t.status]));
		// Statuses come from the report, normalized, and from nowhere else.
		expect(status.get("the auth module")).toBe("done");
		expect(status.get("password reset")).toBe("ready");
		expect(status.get("waiting on legal")).toBe("blocked");
		expect(status.get("abandoned idea")).toBe("archived");
		// in_progress is not importable: with no claiming run nothing would pick it up.
		expect(status.get("session store")).toBe("ready");
		expect(status.get("needs a look")).toBe("ready");
		// Neither a missing status nor one mfw does not know is a guess.
		expect(status.get("no status stated")).toBeUndefined();
		expect(status.get("invented status")).toBeUndefined();
		expect(proposal.specs.map((x) => x.title)).toEqual([
			"Authentication architecture",
			"Unattached design note",
		]);

		// --- an import writes no code, so its worktree is thrown away
		expect(existsSync(worktreePath)).toBe(false);
		expect(
			(await git(["worktree", "list"], root)).stdout.trim().split("\n"),
		).toHaveLength(1);
		expect((await git(["status", "--porcelain"], root)).stdout.trim()).toBe("");

		// --- the brain applies what it chooses, with the board tools
		const turnRunId = await openTurn(svc);
		const applied = await svc.brainRuntime.actions.act({
			turnRunId,
			tool: "create_tasks",
			args: {
				rationale: "the importer's census, minus the abandoned idea",
				tasks: [
					{
						ref: "session",
						title: "session store",
						body: "half written",
						type: "implementation",
						size: "s",
						status: "ready",
					},
					{
						ref: "reset",
						title: "password reset",
						type: "implementation",
						size: "s",
						status: "ready",
						depends_on: ["session"],
					},
				],
			},
		});
		expect(applied.status).toBe("applied");
		const byTitle = new Map(
			(await svc.tasks.list()).map((t) => [t.title, t] as const),
		);
		expect(byTitle.size).toBe(2);
		expect(byTitle.get("password reset")?.dependsOn).toEqual([
			byTitle.get("session store")?.id as string,
		]);
		// The import settled for the task-less run: the board is the brain's.
		await svc.board.flush();
		expect((await git(["status", "--porcelain"], root)).stdout.trim()).toBe("");

		svc.handle.close();
		await rm(root, { recursive: true, force: true });
	}, 60_000);
});

describe("v2 safety defaults", () => {
	test("attaching a project does NOT start dispatching on its own", async () => {
		// Adding a project must never begin spending a subscription by itself.
		// The supervisor still runs, so in-flight runs are adopted and finalized.
		const root = await makeRepo();
		const orch = await boot({
			projects: [cfg(root)], // schedulerAutostart omitted → off
			log: silentLogger(),
			supervisorIntervalMs: 50,
			schedulerIntervalMs: 50,
		});
		const svc = orch.get("demo");
		expect(svc.schedulerAutostart).toBe(false);

		const t = await svc.tasks.create({
			title: "must not run by itself",
			dod: { verifier: "deterministic", checks: [{ files_exist: ["x"] }] },
		});
		await svc.tasks.move(t.id, "ready", "human");
		await Bun.sleep(400); // several would-be scheduler periods

		expect((await svc.registry.list({})).length).toBe(0);
		expect((await svc.tasks.get(t.id))?.status).toBe("ready");
		await orch.shutdown();
		await rm(root, { recursive: true, force: true });
	}, 30_000);

	test("schedulerAutostart:true opts in explicitly", async () => {
		const root = await makeRepo();
		const orch = await boot({
			projects: [{ ...cfg(root), schedulerAutostart: true }],
			log: silentLogger(),
			autostart: false, // don't race the loop; just assert the flag lands
		});
		expect(orch.get("demo").schedulerAutostart).toBe(true);
		await orch.shutdown();
		await rm(root, { recursive: true, force: true });
	}, 30_000);
});

describe("single-daemon safety", () => {
	test("a second daemon on the same project refuses to start", async () => {
		// Boot reconciliation clears every finalize claim not owned by this boot,
		// so two daemons on one project DB would steal each other's claims and
		// finalize the same runs concurrently.
		const root = await makeRepo();
		const first = await boot({
			projects: [cfg(root)],
			log: silentLogger(),
			autostart: false,
		});
		expect(first.list().length).toBe(1);

		// Exclusion lives in mfwHome and is acquired before attachment, so the whole second daemon fails.
		await expect(
			boot({
				projects: [cfg(root)],
				log: silentLogger(),
				autostart: false,
			}),
		).rejects.toThrow("already owns");

		// once the first releases, a new daemon can take over
		await first.shutdown();
		const third = await boot({
			projects: [cfg(root)],
			log: silentLogger(),
			autostart: false,
		});
		expect(third.list().length).toBe(1);
		await third.shutdown();
		await rm(root, { recursive: true, force: true });
	}, 30_000);

	test("a LIVE lock from another daemon blocks the attach", async () => {
		// Stops a second orchestrator (dev server, stray `bun start`) from putting
		// two supervisors on one board. `MFW_DISABLE_ORCHESTRATOR` is not a substitute.
		const root = await makeRepo();
		await mkdir(join(root, ".mfw"), { recursive: true });
		const liveLock = await acquireKernelLock(join(root, ".mfw/daemon.lock"));
		const orch = await boot({
			projects: [cfg(root)],
			log: silentLogger(),
			autostart: false,
		});
		expect(orch.list().length).toBe(0);
		await orch.shutdown();
		await liveLock.release();
		await rm(root, { recursive: true, force: true });
	}, 30_000);

	test("persistent metadata without a live kernel owner does not block startup", async () => {
		const root = await makeRepo();
		await mkdir(join(root, ".mfw"), { recursive: true });
		await writeFile(
			join(root, ".mfw/daemon.lock"),
			`${JSON.stringify({ pid: 1, acquiredAt: 0 })}\n`,
		);
		const orch = await boot({
			projects: [cfg(root)],
			log: silentLogger(),
			autostart: false,
		});
		expect(orch.list().length).toBe(1);
		await orch.shutdown();
		await rm(root, { recursive: true, force: true });
	}, 30_000);
});

describe("the git exclude file is maintained, not just appended to", () => {
	test("the managed block is rewritten in place and the human's lines survive", async () => {
		const root = await makeRepo();
		await writeFile(
			join(root, ".git/info/exclude"),
			[
				"# mine",
				"node_modules/",
				"# --- mfw (managed; rewritten on every attach) ---",
				".mfw/tasks/",
				"# --- end mfw ---",
				"",
			].join("\n"),
		);
		const orch = await boot({
			projects: [cfg(root)],
			log: silentLogger(),
			autostart: false,
		});

		const exclude = await Bun.file(join(root, ".git/info/exclude")).text();
		const lines = exclude.split("\n");
		// a stale managed block must not keep hiding the board, and nothing
		// re-admits board paths under `.mfw/` any more: the board is not there
		expect(lines).not.toContain(".mfw/tasks/");
		expect(lines).not.toContain("!/.mfw/tasks/");
		expect(lines).not.toContain("!/.mfw/adrs/");
		expect(lines).toContain("/.mfw/*");
		expect(lines).toContain("!/.mfw/triggers/");
		expect(lines.filter((l) => l.startsWith("# --- mfw"))).toHaveLength(1);
		// the human's own entries were not disturbed
		expect(lines).toContain("node_modules/");
		expect(lines).toContain("# mine");

		// and the board is genuinely stageable, which is what all of that is for
		const svc = orch.get("demo");
		const t = await svc.tasks.create({ title: "provably tracked" });
		expect(await svc.board.flush()).toContain(t.id);
		expect((await git(["ls-files", "--", "tasks"], root)).stdout).toContain(
			`${t.id}-provably-tracked/task.md`,
		);

		await orch.shutdown();
		await rm(root, { recursive: true, force: true });
	}, 30_000);
});
