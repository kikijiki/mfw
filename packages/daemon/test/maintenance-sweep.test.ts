import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DefinitionOfDone } from "@mfw/core/taskfile";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import { EventBus } from "@mfw/db/eventlog";
import { engineKv, events as eventsTable } from "@mfw/db/schema";
import { eq } from "drizzle-orm";
import { ClarifyService } from "../src/clarify.ts";
import { git } from "../src/git.ts";
import { silentLogger } from "../src/log.ts";
import { Maintenance } from "../src/maintenance.ts";
import { RunRegistry } from "../src/run-registry.ts";
import { SessionService } from "../src/session.ts";
import type { TaskService } from "../src/task-service.ts";
import { WorktreeManager } from "../src/worktree.ts";
import { MFW_EXCLUDE, makeTasks } from "./fixtures/board.ts";

interface F {
	root: string;
	handle: ProjectDbHandle;
	tasks: TaskService;
	registry: RunRegistry;
	bus: EventBus;
	maint: Maintenance;
	now: { value: number };
	cleanup: () => Promise<void>;
}

async function fixture(mergeChecks?: DefinitionOfDone | null): Promise<F> {
	const root = await mkdtemp(join(tmpdir(), "mfw-maint-"));
	await git(["init", "-q", "-b", "main"], root);
	await git(["config", "user.email", "t@t"], root);
	await git(["config", "user.name", "t"], root);
	await writeFile(join(root, "feature.txt"), "present\n");
	await git(["add", "-A"], root);
	await git(["commit", "-q", "-m", "init"], root);
	await writeFile(join(root, ".git/info/exclude"), MFW_EXCLUDE);

	const mfwDir = join(root, ".mfw");
	const handle = await openProjectDb(mfwDir);
	const bus = new EventBus();
	const tasks = await makeTasks(handle, bus, mfwDir, "MFW", mergeChecks);
	const registry = new RunRegistry({
		handle,
		bus,
		runsDir: join(mfwDir, "runs"),
	});
	// Commit the board dirs so "the primary is left clean" holds.
	await git(["add", "-A", "--", ".mfw"], root);
	await git(["commit", "-q", "-m", "board"], root);

	const now = { value: Date.now() };
	const maint = new Maintenance({
		handle,
		bus,
		tasks,
		registry,
		log: silentLogger(),
		projectRoot: root,
		integrationBranch: "main",
		now: () => now.value,
	});
	return {
		root,
		handle,
		tasks,
		registry,
		bus,
		maint,
		now,
		cleanup: async () => {
			handle.close();
			await rm(root, { recursive: true, force: true });
		},
	};
}

/** Land a task on `done` like the merge queue: completed run row, then release. The sweep requires the run row as evidence of prior verification. */
async function mergeDone(f: F, taskId: string): Promise<void> {
	const run = await f.registry.create({
		kind: "task",
		taskId,
		label: taskId,
		model: "sonnet",
		cwd: f.root,
	});
	await f.registry.finish(run.id, "completed", "merged");
	await f.tasks.move(taskId, "done", "scheduler");
}

describe("regression sweep: the red-main safety net", () => {
	test("a done task whose DoD still passes leaves main green", async () => {
		const f = await fixture();
		const t = await f.tasks.create({
			title: "still good",
			dod: {
				verifier: "deterministic",
				checks: [{ files_exist: ["feature.txt"] }],
			},
		});
		await mergeDone(f, t.id);

		const r = await f.maint.regressionSweep();
		expect(r.checked).toBe(1);
		expect(r.broken).toEqual([]);
		expect(r.mainRed).toBe(false);
		expect(await f.maint.isMainRed()).toBe(false);
		await f.cleanup();
	}, 30_000);

	// A bare `git worktree` lacks gitignored installed deps, so re-run checks failed
	// with "Cannot find module" and tripped `main_red` with no way to clear.
	test("the sweep reads a SNAPSHOT, not the live checkout", async () => {
		// Symlinking at the primary made a sweep during an install read a half-written
		// tree. Deleting the primary's copy after the snapshot stands in for that.
		const f = await fixture();
		await mkdir(join(f.root, "node_modules", "left-pad"), { recursive: true });
		await writeFile(
			join(f.root, "node_modules", "left-pad", "index.js"),
			"module.exports = 1;\n",
		);
		await writeFile(join(f.root, "bun.lock"), "{}\n");
		await writeFile(join(f.root, ".gitignore"), "node_modules/\n");
		await git(["add", "-A"], f.root);
		await git(["commit", "-q", "-m", "ignore deps"], f.root);

		const t = await f.tasks.create({
			title: "needs its dependencies",
			dod: {
				verifier: "deterministic",
				checks: [{ files_exist: ["node_modules/left-pad/index.js"] }],
			},
		});
		await mergeDone(f, t.id);

		expect((await f.maint.regressionSweep()).broken).toEqual([]);

		// The snapshot keeps its hard links, so the verdict must not change.
		await rm(join(f.root, "node_modules"), { recursive: true, force: true });

		const r = await f.maint.regressionSweep();
		expect(r.broken).toEqual([]);
		expect(r.mainRed).toBe(false);
		expect((await f.tasks.get(t.id))?.status).toBe("done");
		await f.cleanup();
	}, 60_000);

	test("the sweep sees the dependencies the run was verified with", async () => {
		const f = await fixture();
		await mkdir(join(f.root, "node_modules", "left-pad"), { recursive: true });
		await writeFile(
			join(f.root, "node_modules", "left-pad", "index.js"),
			"module.exports = 1;\n",
		);
		await mkdir(join(f.root, "packages", "a", "node_modules", "dep"), {
			recursive: true,
		});
		await writeFile(join(f.root, ".gitignore"), "node_modules/\n");
		await git(["add", "-A"], f.root);
		await git(["commit", "-q", "-m", "ignore deps"], f.root);

		const t = await f.tasks.create({
			title: "needs its dependencies",
			dod: {
				verifier: "deterministic",
				checks: [
					{ files_exist: ["node_modules/left-pad/index.js"] },
					{ files_exist: ["packages/a/node_modules/dep"] },
				],
			},
		});
		await mergeDone(f, t.id);

		const r = await f.maint.regressionSweep();

		expect(r.broken).toEqual([]);
		expect(r.mainRed).toBe(false);
		expect(await f.maint.isMainRed()).toBe(false);
		expect((await f.tasks.get(t.id))?.status).toBe("done");
		await f.cleanup();
	}, 30_000);

	test("a workspace package resolves to the worktree's own sources, and a broken worktree source makes the sweep red", async () => {
		const f = await fixture();
		// bun installs workspaces as a RELATIVE symlink into the source tree. Copied
		// verbatim into the snapshot it resolved to a dir holding only `node_modules`.
		await writeFile(
			join(f.root, "package.json"),
			JSON.stringify({ name: "root", workspaces: ["packages/*"] }),
		);
		await mkdir(join(f.root, "packages", "a"), { recursive: true });
		await writeFile(
			join(f.root, "packages", "a", "package.json"),
			JSON.stringify({ name: "@t/a" }),
		);
		await writeFile(
			join(f.root, "packages", "a", "index.ts"),
			"export const a=1;\n",
		);
		// Own installed deps, so the snapshot copies that path.
		await mkdir(join(f.root, "packages", "a", "node_modules", "dep"), {
			recursive: true,
		});
		await mkdir(join(f.root, "node_modules", "@t"), { recursive: true });
		await symlink("../../packages/a", join(f.root, "node_modules", "@t", "a"));
		await writeFile(join(f.root, ".gitignore"), "node_modules/\n");
		await git(["add", "-A"], f.root);
		await git(["commit", "-q", "-m", "workspace"], f.root);

		const t = await f.tasks.create({
			title: "imports a workspace package",
			dod: {
				verifier: "deterministic",
				// Reachable only if the link points at real sources.
				checks: [{ files_exist: ["node_modules/@t/a/index.ts"] }],
			},
		});
		await mergeDone(f, t.id);

		const r = await f.maint.regressionSweep();

		expect(r.broken).toEqual([]);
		expect(r.mainRed).toBe(false);
		expect((await f.tasks.get(t.id))?.status).toBe("done");

		// The package in the CHECKED-OUT tree decides the verdict; if shadowLink
		// pointed elsewhere, this committed change could not turn it red.
		await rm(join(f.root, "packages", "a", "index.ts"));
		await git(["add", "-A"], f.root);
		await git(["commit", "-q", "-m", "break workspace source"], f.root);

		const broken = await f.maint.regressionSweep();
		expect(broken.broken).toEqual([t.id]);
		expect(broken.mainRed).toBe(true);
		expect((await f.tasks.get(t.id))?.status).toBe("done");
		await f.cleanup();
	}, 30_000);

	test("a failing integration check trips the breaker without reopening its historical task", async () => {
		const f = await fixture();
		const t = await f.tasks.create({
			title: "will regress",
			dod: {
				verifier: "deterministic",
				checks: [{ files_exist: ["feature.txt"] }],
			},
		});
		await mergeDone(f, t.id);

		const events: string[] = [];
		f.bus.subscribe((e) => events.push(e.type));

		await rm(join(f.root, "feature.txt"));
		await git(["add", "-A"], f.root);
		await git(["commit", "-q", "-m", "break it"], f.root);

		const r = await f.maint.regressionSweep();
		expect(r.broken).toEqual([t.id]);
		expect(r.mainRed).toBe(true);
		expect(await f.maint.isMainRed()).toBe(true);
		expect(events).toContain("main.red");

		// The board is history: the task stays done.
		const after = await f.tasks.get(t.id);
		expect(after?.status).toBe("done");
		const reopened = (await f.handle.db.select().from(eventsTable)).find(
			(e) =>
				e.type === "task.status_changed" &&
				e.taskId === t.id &&
				(e.payload as { to?: string }).to === "ready",
		);
		expect(reopened).toBeUndefined();
		await f.cleanup();
	}, 30_000);

	test("a single recorded merge since green is attributed and starts a board-neutral repair", async () => {
		const f = await fixture();
		const task = await f.tasks.create({
			title: "introducing change",
			dod: {
				verifier: "deterministic",
				checks: [{ files_exist: ["feature.txt"] }],
			},
		});
		await mergeDone(f, task.id);
		expect((await f.maint.regressionSweep()).mainRed).toBe(false);

		await rm(join(f.root, "feature.txt"));
		await git(["add", "-A"], f.root);
		await git(["commit", "-q", "-m", "introduce regression"], f.root);
		const sha = (await git(["rev-parse", "HEAD"], f.root)).stdout.trim();
		await f.handle.db.insert(eventsTable).values({
			ts: new Date(),
			type: "merge.completed",
			taskId: task.id,
			runId: "repair-source",
			payload: { sha, target: "main" },
		});
		const started: string[] = [];
		const maint = new Maintenance({
			handle: f.handle,
			bus: f.bus,
			tasks: f.tasks,
			registry: f.registry,
			log: silentLogger(),
			projectRoot: f.root,
			integrationBranch: "main",
			startRepair: async (taskId) => {
				started.push(taskId);
				return { runId: "repair-1" };
			},
		});

		expect((await maint.regressionSweep()).mainRed).toBe(true);
		expect(started).toEqual([task.id]);
		expect((await f.tasks.get(task.id))?.status).toBe("done");
		const [red] = await f.handle.db
			.select()
			.from(engineKv)
			.where(eq(engineKv.key, "main_red"));
		expect(red?.value).toMatchObject({
			red: true,
			causeTaskId: task.id,
			repairRunId: "repair-1",
		});
		await f.cleanup();
	}, 30_000);

	// A task with no `dod` of its own was invisible to the sweep, so breakage got
	// misattributed to another task. The project default now covers it.
	test("a task merged with no DoD of its own is swept, and blamed, via the project default", async () => {
		const f = await fixture({
			verifier: "deterministic",
			checks: [{ files_exist: ["feature.txt"] }],
		});
		const culprit = await f.tasks.create({ title: "quick-captured, no dod" });
		await mergeDone(f, culprit.id);

		const clean = await f.maint.regressionSweep();
		expect(clean.checked).toBe(1);
		expect(clean.broken).toEqual([]);
		expect(clean.mainRed).toBe(false);

		await rm(join(f.root, "feature.txt"));
		await git(["add", "-A"], f.root);
		await git(["commit", "-q", "-m", "break it"], f.root);

		const r = await f.maint.regressionSweep();
		expect(r.broken).toEqual([culprit.id]);
		expect(r.mainRed).toBe(true);
		expect(await f.maint.isMainRed()).toBe(true);
		expect((await f.tasks.get(culprit.id))?.status).toBe("done");
		await f.cleanup();
	}, 30_000);

	// `diff_against_base` is only true at merge time. In the sweep's shared tip
	// worktree it asks "does the tip differ from itself", always false, which
	// would keep main red forever, so the sweep strips it.
	test("a task whose only check is the project's diff_against_base default cannot block the sweep", async () => {
		const f = await fixture({
			verifier: "deterministic",
			checks: [{ diff_against_base: true }],
		});
		const t = await f.tasks.create({ title: "quick-captured, no dod" });
		await mergeDone(f, t.id);

		const r = await f.maint.regressionSweep();
		expect(r.checked).toBe(1);
		expect(r.broken).toEqual([]);
		expect(r.infra).toEqual([]);
		expect(r.mainRed).toBe(false);
		expect(await f.maint.isMainRed()).toBe(false);
		await f.cleanup();
	}, 30_000);

	test("diff_against_base is stripped from the sweep, but a task's OTHER checks still run", async () => {
		const f = await fixture({
			verifier: "deterministic",
			checks: [{ diff_against_base: true }],
		});
		const t = await f.tasks.create({
			title: "has a real check too",
			dod: {
				verifier: "deterministic",
				checks: [{ files_exist: ["feature.txt"] }],
			},
		});
		await mergeDone(f, t.id);
		expect((await f.maint.regressionSweep()).mainRed).toBe(false);

		await rm(join(f.root, "feature.txt"));
		await git(["add", "-A"], f.root);
		await git(["commit", "-q", "-m", "break the real check"], f.root);

		const r = await f.maint.regressionSweep();
		expect(r.broken).toEqual([t.id]);
		expect(r.mainRed).toBe(true);
		await f.cleanup();
	}, 30_000);

	// A task latched into `sweep_regressions` used to clear only when its check
	// passed again, so a check that can never pass in the sweep kept main red even
	// after later sweeps classified it as not a regression.
	test("a stale regression clears once a later sweep independently diagnoses the same failure as not a regression", async () => {
		const f = await fixture();
		const t = await f.tasks.create({
			title: "looks broken, isn't",
			dod: {
				verifier: "deterministic",
				checks: [{ files_exist: ["feature.txt"] }],
			},
		});
		await mergeDone(f, t.id);

		// No known-green baseline yet, so the first failure is trusted outright.
		await rm(join(f.root, "feature.txt"));
		await git(["add", "-A"], f.root);
		await git(["commit", "-q", "-m", "break it"], f.root);

		let call = 0;
		const maint = new Maintenance({
			handle: f.handle,
			bus: f.bus,
			tasks: f.tasks,
			registry: f.registry,
			log: silentLogger(),
			projectRoot: f.root,
			integrationBranch: "main",
			diagnose: {
				enabled: true,
				diagnose: async () => {
					call++;
					return call === 1
						? { status: "ok", verdict: "regression" }
						: { status: "ok", verdict: "flaky" };
				},
			},
		});

		const first = await maint.regressionSweep();
		expect(first.broken).toEqual([t.id]);
		expect(first.mainRed).toBe(true);

		const second = await maint.regressionSweep();
		expect(second.broken).toEqual([]);
		expect(second.infra).toEqual([t.id]);
		expect(second.mainRed).toBe(false);
		expect(await maint.isMainRed()).toBe(false);
		await f.cleanup();
	}, 30_000);

	test("shared project merge checks run once per sweep while task checks stay focused", async () => {
		const markerRoot = await mkdtemp(join(tmpdir(), "mfw-merge-check-"));
		const counter = join(markerRoot, "count.txt");
		await writeFile(counter, "");
		const f = await fixture({
			verifier: "deterministic",
			checks: [
				{
					run: `printf 'merge-check\\n' >> ${JSON.stringify(counter)}`,
					expect_exit: 0,
				},
			],
		});
		const first = await f.tasks.create({
			title: "first focused task",
			dod: {
				verifier: "deterministic",
				checks: [{ files_exist: ["feature.txt"] }],
			},
		});
		const second = await f.tasks.create({
			title: "second focused task",
			dod: {
				verifier: "deterministic",
				checks: [{ files_exist: ["README.md"] }],
			},
		});
		await writeFile(join(f.root, "README.md"), "present\n");
		await git(["add", "README.md"], f.root);
		await git(["commit", "-q", "-m", "second focused fixture"], f.root);
		await mergeDone(f, first.id);
		await mergeDone(f, second.id);

		const result = await f.maint.regressionSweep();

		expect(result.checked).toBe(2);
		expect(result.broken).toEqual([]);
		expect((await Bun.file(counter).text()).trim().split("\n")).toHaveLength(1);
		await f.cleanup();
		await rm(markerRoot, { recursive: true, force: true });
	}, 30_000);

	test("main goes green again once the regression is fixed", async () => {
		const f = await fixture();
		const t = await f.tasks.create({
			title: "recovers",
			dod: {
				verifier: "deterministic",
				checks: [{ files_exist: ["feature.txt"] }],
			},
		});
		await mergeDone(f, t.id);
		await rm(join(f.root, "feature.txt"));
		await git(["add", "-A"], f.root);
		await git(["commit", "-q", "-m", "break"], f.root);
		await f.maint.regressionSweep();
		expect(await f.maint.isMainRed()).toBe(true);

		await writeFile(join(f.root, "feature.txt"), "restored\n");
		await git(["add", "-A"], f.root);
		await git(["commit", "-q", "-m", "fix"], f.root);
		await mergeDone(f, t.id);

		const events: string[] = [];
		f.bus.subscribe((e) => events.push(e.type));
		const r = await f.maint.regressionSweep();
		expect(r.mainRed).toBe(false);
		expect(events).toContain("main.green");
		await f.cleanup();
	}, 40_000);

	// `isInfrastructural` checks out the green sha in the shared worktree, then
	// back to tip. A check that dirties a tracked file can block that restore,
	// silently verifying later tasks against the wrong commit.
	test("a corroboration checkout that fails to restore does not leave a LATER task in the same pass verified against the wrong commit", async () => {
		const f = await fixture();
		await writeFile(join(f.root, "shared.txt"), "green\n");
		await git(["add", "-A"], f.root);
		await git(["commit", "-q", "-m", "shared: green"], f.root);

		// Establishes a known-green baseline.
		const baseline = await f.tasks.create({
			title: "baseline",
			dod: {
				verifier: "deterministic",
				checks: [{ files_exist: ["feature.txt"] }],
			},
		});
		await mergeDone(f, baseline.id);
		expect((await f.maint.regressionSweep()).mainRed).toBe(false);

		await writeFile(join(f.root, "shared.txt"), "tip\n");
		await git(["add", "-A"], f.root);
		await git(["commit", "-q", "-m", "shared: tip"], f.root);

		// Task A fails at every commit (infra case). Only when run at the green
		// commit (the grep never matches at tip) it also dirties a tracked file,
		// like a formatter would, inside the corroboration run.
		const a = await f.tasks.create({
			title: "structurally broken check that dirties a tracked file",
			dod: {
				verifier: "deterministic",
				checks: [
					{
						run: "grep -q green shared.txt && echo dirty >> shared.txt; test -f never-exists.txt",
						expect_exit: 0,
					},
				],
			},
		});
		await mergeDone(f, a.id);

		// Task B is fine at tip: its check reads the same file's tip content.
		const b = await f.tasks.create({
			title: "reads the real tip content",
			dod: {
				verifier: "deterministic",
				checks: [{ run: "grep -q tip shared.txt", expect_exit: 0 }],
			},
		});
		await mergeDone(f, b.id);

		const r = await f.maint.regressionSweep();
		expect(r.infra).toContain(a.id);
		// B must not be blamed just because A left the worktree on the green commit.
		expect(r.infra).not.toContain(b.id);
		expect(r.broken).not.toContain(b.id);
		expect(r.mainRed).toBe(false);
		await f.cleanup();
	}, 30_000);

	test("the sweep never runs checks in the primary checkout", async () => {
		// Running in the user's working copy races the human and the merge queue.
		const f = await fixture();
		const marker = join(f.root, "sweep-ran-here.txt");
		const t = await f.tasks.create({
			title: "writes a marker",
			dod: {
				verifier: "deterministic",
				checks: [{ run: "touch sweep-ran-here.txt", expect_exit: 0 }],
			},
		});
		await mergeDone(f, t.id);
		await f.maint.regressionSweep();

		expect(await Bun.file(marker).exists()).toBe(false);
		// Clean apart from the board, which no BoardRepo commits here.
		const status = await git(["status", "--porcelain"], f.root);
		expect(
			status.stdout
				.split("\n")
				.filter((l) => l.trim() && !l.includes(".mfw/tasks")),
		).toEqual([]);
		await f.cleanup();
	}, 30_000);

	// Import files shipped features as `done` with an unverified, agent-guessed
	// DoD. Sweeping them would reopen existing work and falsely turn main red.
	test("a task an IMPORT filed as done is not swept: mfw never verified it", async () => {
		const f = await fixture();
		const imported = await f.tasks.create({
			title: "the auth module",
			source: "importer",
			status: "done",
			// A guess about a file the repo does not contain.
			dod: {
				verifier: "deterministic",
				checks: [{ files_exist: ["src/auth.ts"] }],
			},
		});

		const r = await f.maint.regressionSweep();

		expect(r.checked).toBe(0);
		expect(r.broken).toEqual([]);
		expect(await f.maint.isMainRed()).toBe(false);
		expect((await f.tasks.get(imported.id))?.status).toBe("done");
		await f.cleanup();
	}, 30_000);

	test("...but it joins the sweep the moment mfw actually runs it", async () => {
		// The exemption is "no evidence yet": a completed run makes it ordinary work.
		const f = await fixture();
		const imported = await f.tasks.create({
			title: "session store",
			source: "importer",
			status: "done",
			dod: {
				verifier: "deterministic",
				checks: [{ files_exist: ["feature.txt"] }],
			},
		});
		expect((await f.maint.regressionSweep()).checked).toBe(0);

		await mergeDone(f, imported.id);
		await rm(join(f.root, "feature.txt"));
		await git(["add", "-A"], f.root);
		await git(["commit", "-q", "-m", "break it"], f.root);

		const r = await f.maint.regressionSweep();
		expect(r.checked).toBe(1);
		expect(r.broken).toEqual([imported.id]);
		expect((await f.tasks.get(imported.id))?.status).toBe("done");
		await f.cleanup();
	}, 30_000);

	// A failing check may be a sweep-side fault (here the dependency snapshot
	// loses a package with no commit). Corroborating against the last green
	// commit, which is the current tip, shows the code is not the cause.
	test("a sweep-side failure is not blamed on the task, and does not gate main red", async () => {
		const f = await fixture();
		await mkdir(join(f.root, "node_modules", "left-pad"), { recursive: true });
		await writeFile(
			join(f.root, "node_modules", "left-pad", "index.js"),
			"module.exports = 1;\n",
		);
		await writeFile(join(f.root, "bun.lock"), "{}\n");
		await writeFile(join(f.root, ".gitignore"), "node_modules/\n");
		await git(["add", "-A"], f.root);
		await git(["commit", "-q", "-m", "ignore deps"], f.root);

		const t = await f.tasks.create({
			title: "needs its dependencies",
			dod: {
				verifier: "deterministic",
				checks: [{ files_exist: ["node_modules/left-pad/index.js"] }],
			},
		});
		await mergeDone(f, t.id);

		// Clean sweep records this commit as last known-good.
		const first = await f.maint.regressionSweep();
		expect(first.broken).toEqual([]);
		expect(first.infra).toEqual([]);
		expect(first.mainRed).toBe(false);

		// Broken install with no commit; the lockfile size change forces a snapshot rebuild.
		await rm(join(f.root, "node_modules", "left-pad"), { recursive: true });
		await writeFile(join(f.root, "bun.lock"), '{"changed":true}\n');

		const events: string[] = [];
		f.bus.subscribe((e) => events.push(e.type));

		const second = await f.maint.regressionSweep();
		expect(second.broken).toEqual([]);
		expect(second.infra).toEqual([t.id]);
		expect(second.mainRed).toBe(false);
		expect(await f.maint.isMainRed()).toBe(false);
		expect((await f.tasks.get(t.id))?.status).toBe("done");
		expect(events).toContain("sweep.infra_failure");
		expect(events).not.toContain("main.red");
		await f.cleanup();
	}, 60_000);

	test("a sweep that cannot create its verification worktree alarms without blaming or gating a task", async () => {
		const f = await fixture();
		const t = await f.tasks.create({
			title: "innocent when the sweep cannot start",
			dod: {
				verifier: "deterministic",
				checks: [{ files_exist: ["feature.txt"] }],
			},
		});
		await mergeDone(f, t.id);
		const maint = new Maintenance({
			handle: f.handle,
			bus: f.bus,
			tasks: f.tasks,
			registry: f.registry,
			log: silentLogger(),
			projectRoot: f.root,
			integrationBranch: "branch-that-does-not-exist",
		});
		const events: string[] = [];
		f.bus.subscribe((event) => events.push(event.type));

		const result = await maint.regressionSweep();

		expect(result.checked).toBe(0);
		expect(result.broken).toEqual([]);
		expect(result.infra).toEqual([t.id]);
		expect(result.mainRed).toBe(false);
		expect(await maint.isMainRed()).toBe(false);
		expect((await f.tasks.get(t.id))?.status).toBe("done");
		expect(events).toContain("sweep.infra_failure");
		expect(events).not.toContain("main.red");
		await f.cleanup();
	}, 30_000);

	// A check killed by a signal (SIGILL/SIGSEGV/SIGKILL/OOM) means the verifier
	// died, not that the task regressed (`exitCode: null` vs a real exit code).
	test("a check killed by a signal is not blamed on the task, and does not gate main red", async () => {
		const f = await fixture();
		const t = await f.tasks.create({
			title: "its check crashes the verifier, not the code",
			dod: {
				verifier: "deterministic",
				// Crashes on the verifier's one retry too: the persistent case must reach `infra`.
				checks: [{ run: "kill -11 $$", expect_exit: 0 }],
			},
		});
		await mergeDone(f, t.id);

		const events: string[] = [];
		f.bus.subscribe((e) => events.push(e.type));

		const result = await f.maint.regressionSweep();
		expect(result.broken).toEqual([]);
		expect(result.infra).toEqual([t.id]);
		expect(result.mainRed).toBe(false);
		expect(await f.maint.isMainRed()).toBe(false);
		expect((await f.tasks.get(t.id))?.status).toBe("done");
		expect(events).toContain("sweep.infra_failure");
		expect(events).not.toContain("main.red");
		await f.cleanup();
	}, 60_000);

	// Unresolved regressions are tracked independently of task status; sampling
	// `done` tasks alone made main flap red, green, red.
	test("a reopened regression keeps main red across sweeps even after it drops out of the done sample", async () => {
		const f = await fixture();
		const t1 = await f.tasks.create({
			title: "will regress",
			dod: {
				verifier: "deterministic",
				checks: [{ files_exist: ["feature.txt"] }],
			},
		});
		await mergeDone(f, t1.id);

		await rm(join(f.root, "feature.txt"));
		await git(["add", "-A"], f.root);
		await git(["commit", "-q", "-m", "break it"], f.root);

		const first = await f.maint.regressionSweep();
		expect(first.broken).toEqual([t1.id]);
		expect(first.mainRed).toBe(true);
		expect((await f.tasks.get(t1.id))?.status).toBe("done");

		const second = await f.maint.regressionSweep();
		expect(second.broken).toEqual([t1.id]);
		expect(second.mainRed).toBe(true);
		expect(await f.maint.isMainRed()).toBe(true);
		await f.cleanup();
	}, 30_000);

	// After `ESCALATE_AFTER_SWEEPS` sweeps `escalated` flips, which turns the
	// self-repair exemption off (see scheduler.test.ts).
	test("main_red escalates once the same regression survives repeated sweeps", async () => {
		const f = await fixture();
		const t = await f.tasks.create({
			title: "never gets fixed",
			dod: {
				verifier: "deterministic",
				checks: [{ files_exist: ["feature.txt"] }],
			},
		});
		await mergeDone(f, t.id);
		await rm(join(f.root, "feature.txt"));
		await git(["add", "-A"], f.root);
		await git(["commit", "-q", "-m", "break it"], f.root);

		expect((await f.maint.regressionSweep()).escalated).toBe(false);
		expect((await f.maint.regressionSweep()).escalated).toBe(false);
		const third = await f.maint.regressionSweep();
		expect(third.escalated).toBe(true);
		expect(third.mainRed).toBe(true);
		await f.cleanup();
	}, 40_000);

	test("MFW-59: escalating raises a session quoting the check's real output", async () => {
		const f = await fixture();
		const t = await f.tasks.create({
			title: "never gets fixed",
			dod: {
				verifier: "deterministic",
				checks: [{ files_exist: ["feature.txt"] }],
			},
		});
		await mergeDone(f, t.id);
		await rm(join(f.root, "feature.txt"));
		await git(["add", "-A"], f.root);
		await git(["commit", "-q", "-m", "break it"], f.root);

		// Real SessionService: its own dedup keeps a still-open escalation from
		// spawning a second session.
		const sessions = new SessionService({
			handle: f.handle,
			bus: f.bus,
			log: silentLogger(),
			project: "demo",
			tasks: f.tasks,
			registry: f.registry,
		});
		const maint = new Maintenance({
			handle: f.handle,
			bus: f.bus,
			tasks: f.tasks,
			registry: f.registry,
			log: silentLogger(),
			projectRoot: f.root,
			integrationBranch: "main",
			sessions,
		});

		expect((await maint.regressionSweep()).escalated).toBe(false);
		expect(await sessions.list()).toEqual([]);
		expect((await maint.regressionSweep()).escalated).toBe(false);
		expect(await sessions.list()).toEqual([]);
		const third = await maint.regressionSweep();
		expect(third.escalated).toBe(true);

		const raised = await sessions.list();
		expect(raised).toHaveLength(1);
		expect(raised[0]).toMatchObject({
			source: "main_red",
			taskId: null,
			title: "main is red: the introducing merge is ambiguous",
		});
		expect(raised[0]?.context).toContain("3 times");
		expect(raised[0]?.context).toContain("feature.txt");

		// No second session while this one is open.
		await maint.regressionSweep();
		expect(await sessions.list()).toHaveLength(1);
		await f.cleanup();
	}, 40_000);

	// Residual case: fails at tip, passes at the last green commit. A brain that
	// calls it flaky clears the task; without one it is blamed as a regression.
	test("MFW-58: a residual failure the brain diagnoses as flaky is not blamed, and does not gate main red", async () => {
		const f = await fixture();
		const t = await f.tasks.create({
			title: "flaky under the sweep",
			dod: {
				verifier: "deterministic",
				checks: [{ files_exist: ["feature.txt"] }],
			},
		});
		await mergeDone(f, t.id);

		// Records this commit as last known-green.
		expect((await f.maint.regressionSweep()).broken).toEqual([]);

		await rm(join(f.root, "feature.txt"));
		await git(["add", "-A"], f.root);
		await git(["commit", "-q", "-m", "break it"], f.root);

		const diagnosed: unknown[] = [];
		const maint = new Maintenance({
			handle: f.handle,
			bus: f.bus,
			tasks: f.tasks,
			registry: f.registry,
			log: silentLogger(),
			projectRoot: f.root,
			integrationBranch: "main",
			diagnose: {
				enabled: true,
				diagnose: async (ctx) => {
					diagnosed.push(ctx);
					return {
						status: "ok",
						verdict: "flaky",
						reason: "non-deterministic",
					};
				},
			},
		});

		const events: string[] = [];
		f.bus.subscribe((e) => events.push(e.type));

		const r = await maint.regressionSweep();
		expect(r.broken).toEqual([]);
		expect(r.infra).toEqual([t.id]);
		expect(r.mainRed).toBe(false);
		expect(await maint.isMainRed()).toBe(false);
		expect((await f.tasks.get(t.id))?.status).toBe("done");
		expect(events).not.toContain("main.red");
		expect(diagnosed.length).toBe(1);
		expect(diagnosed[0]).toMatchObject({
			taskId: t.id,
			passesAtGreenSha: true,
		});
		await f.cleanup();
	}, 30_000);

	test("MFW-58: a diagnosed regression gates main without rewriting the board", async () => {
		const f = await fixture();
		const t = await f.tasks.create({
			title: "genuinely regressed",
			dod: {
				verifier: "deterministic",
				checks: [{ files_exist: ["feature.txt"] }],
			},
		});
		await mergeDone(f, t.id);
		expect((await f.maint.regressionSweep()).broken).toEqual([]);

		await rm(join(f.root, "feature.txt"));
		await git(["add", "-A"], f.root);
		await git(["commit", "-q", "-m", "break it"], f.root);

		const maint = new Maintenance({
			handle: f.handle,
			bus: f.bus,
			tasks: f.tasks,
			registry: f.registry,
			log: silentLogger(),
			projectRoot: f.root,
			integrationBranch: "main",
			diagnose: {
				enabled: true,
				diagnose: async () => ({ status: "ok", verdict: "regression" }),
			},
		});

		const r = await maint.regressionSweep();
		expect(r.broken).toEqual([t.id]);
		expect(r.mainRed).toBe(true);
		expect((await f.tasks.get(t.id))?.status).toBe("done");
		await f.cleanup();
	}, 30_000);

	test("MFW-58: diagnose receives the observed exit code and scrubbed execution environment", async () => {
		const f = await fixture();
		const t = await f.tasks.create({
			title: "fails with useful process facts",
			dod: {
				verifier: "deterministic",
				checks: [
					{
						run: "test -f feature.txt || { echo feature-missing; exit 7; }",
						expect_exit: 0,
					},
				],
			},
		});
		await mergeDone(f, t.id);
		expect((await f.maint.regressionSweep()).broken).toEqual([]);

		await rm(join(f.root, "feature.txt"));
		await git(["add", "-A"], f.root);
		await git(["commit", "-q", "-m", "remove feature"], f.root);

		const diagnosed: unknown[] = [];
		const maint = new Maintenance({
			handle: f.handle,
			bus: f.bus,
			tasks: f.tasks,
			registry: f.registry,
			log: silentLogger(),
			projectRoot: f.root,
			integrationBranch: "main",
			envPolicy: { allow: ["PATH", "CI"] },
			diagnose: {
				enabled: true,
				diagnose: async (ctx) => {
					diagnosed.push(ctx);
					return { status: "ok", verdict: "regression" };
				},
			},
		});

		expect((await maint.regressionSweep()).broken).toEqual([t.id]);
		expect(diagnosed).toHaveLength(1);
		expect(diagnosed[0]).toMatchObject({
			exitCode: 7,
			passesAtGreenSha: true,
		});
		expect((diagnosed[0] as { outputTail: string }).outputTail).toContain(
			"feature-missing",
		);
		expect((diagnosed[0] as { environment: string }).environment).toContain(
			"allowed ambient names: PATH, CI",
		);
		await f.cleanup();
	}, 30_000);

	test("MFW-58: a timeout is deterministically infrastructure and never reaches diagnose", async () => {
		const f = await fixture();
		const t = await f.tasks.create({
			title: "times out under sweep",
			dod: {
				verifier: "deterministic",
				checks: [{ run: "sleep 5", expect_exit: 0, timeout: 1 }],
			},
		});
		await mergeDone(f, t.id);
		let calls = 0;
		const maint = new Maintenance({
			handle: f.handle,
			bus: f.bus,
			tasks: f.tasks,
			registry: f.registry,
			log: silentLogger(),
			projectRoot: f.root,
			integrationBranch: "main",
			diagnose: {
				enabled: true,
				diagnose: async () => {
					calls++;
					return { status: "ok", verdict: "regression" };
				},
			},
		});

		const result = await maint.regressionSweep();
		expect(result.broken).toEqual([]);
		expect(result.infra).toEqual([t.id]);
		expect(calls).toBe(0);
		expect((await f.tasks.get(t.id))?.status).toBe("done");
		await f.cleanup();
	}, 30_000);

	test("the ephemeral sweep worktree is always cleaned up", async () => {
		const f = await fixture();
		const t = await f.tasks.create({
			title: "x",
			dod: {
				verifier: "deterministic",
				checks: [{ files_exist: ["feature.txt"] }],
			},
		});
		await mergeDone(f, t.id);
		await f.maint.regressionSweep();
		expect(
			await Bun.file(join(f.root, ".mfw/sweep/feature.txt")).exists(),
		).toBe(false);
		await f.cleanup();
	}, 30_000);
});

describe("groom", () => {
	test("a task stranded by a vanished run is released back to ready", async () => {
		const f = await fixture();
		const t = await f.tasks.create({ title: "stranded" });
		await f.tasks.move(t.id, "ready", "human");
		await f.tasks.tryClaim(t.id, "01RUNTHATNEVEREXISTED000000", 60_000);
		expect((await f.tasks.get(t.id))?.status).toBe("in_progress");

		const r = await f.maint.groom();
		expect(r.staleClaimsReleased).toBe(1);
		expect((await f.tasks.get(t.id))?.status).toBe("ready");
		await f.cleanup();
	});

	test("a task moved into in_progress by hand with no claim is released back to ready", async () => {
		// A card dragged straight into in_progress (or a raw `mv`) is never claimed,
		// so there is no run to check.
		const f = await fixture();
		const t = await f.tasks.create({ title: "dragged in by hand" });
		await f.tasks.move(t.id, "ready", "human");
		// Simulates a disk/import inconsistency; the human API refuses this transition.
		await f.tasks.move(t.id, "in_progress", "boot");
		expect((await f.tasks.get(t.id))?.claimedByRunId).toBeNull();

		const r = await f.maint.groom();
		expect(r.staleClaimsReleased).toBe(1);
		expect((await f.tasks.get(t.id))?.status).toBe("ready");
		await f.cleanup();
	});

	test("a LIVE run keeps its task even if the lease lapsed: it is renewed", async () => {
		// Lease age alone must not release the task: the run row is authoritative,
		// and stale rows are fixed by the supervisor or boot reconciliation.
		const f = await fixture();
		const t = await f.tasks.create({ title: "long running" });
		await f.tasks.move(t.id, "ready", "human");
		const run = await f.registry.create({
			kind: "task",
			taskId: t.id,
			label: t.id,
			model: "sonnet",
			cwd: f.root,
		});
		await f.registry.transition(run.id, "running");
		await f.tasks.tryClaim(t.id, run.id, 1000);

		f.now.value += 60_000; // lease long past, run still live
		const r = await f.maint.groom();
		expect(r.staleClaimsReleased).toBe(0);
		const after = await f.tasks.get(t.id);
		expect(after?.status).toBe("in_progress");
		expect(after?.claimedByRunId).toBe(run.id);
		// lease pushed forward
		expect((after?.leaseExpiresAt?.getTime() ?? 0) > Date.now()).toBe(true);
		await f.cleanup();
	});

	test("a lapsed lease on a TERMINAL run is reclaimed", async () => {
		const f = await fixture();
		const t = await f.tasks.create({ title: "owner died" });
		await f.tasks.move(t.id, "ready", "human");
		const run = await f.registry.create({
			kind: "task",
			taskId: t.id,
			label: t.id,
			model: "sonnet",
			cwd: f.root,
		});
		await f.registry.transition(run.id, "running");
		await f.tasks.tryClaim(t.id, run.id, 1000);
		await f.registry.finish(run.id, "failed", "crashed");

		const r = await f.maint.groom();
		expect(r.staleClaimsReleased).toBe(1);
		expect((await f.tasks.get(t.id))?.status).toBe("ready");
		await f.cleanup();
	});

	test("a healthy in-flight claim is left alone", async () => {
		const f = await fixture();
		const t = await f.tasks.create({ title: "working" });
		await f.tasks.move(t.id, "ready", "human");
		const run = await f.registry.create({
			kind: "task",
			taskId: t.id,
			label: t.id,
			model: "sonnet",
			cwd: f.root,
		});
		await f.registry.transition(run.id, "running");
		await f.tasks.tryClaim(t.id, run.id, 600_000);

		const r = await f.maint.groom();
		expect(r.staleClaimsReleased).toBe(0);
		expect((await f.tasks.get(t.id))?.status).toBe("in_progress");
		await f.cleanup();
	});

	// A draft mid-expansion stays in `draft` status while claimed, so the
	// `in_progress` scan never sees it and `expandDrafts` skips it. Groom must
	// audit drafts too, or an orphaned claim leaves `draftPhase` "expanding" forever.
	test("a draft claimed by a run that never got a row is reclaimed", async () => {
		const f = await fixture();
		const draft = await f.tasks.captureQuick("do the thing");
		// No `registry.create`: simulates a crash after the claim, before the run row.
		expect(
			await f.tasks.tryClaimDraftExpansion(
				draft.id,
				"01RUNTHATNEVEREXISTED000000",
				60_000,
			),
		).toBe(true);
		expect((await f.tasks.get(draft.id))?.draftPhase).toBe("expanding");

		const r = await f.maint.groom();
		expect(r.staleClaimsReleased).toBe(1);
		const after = await f.tasks.get(draft.id);
		expect(after?.status).toBe("draft");
		expect(after?.claimedByRunId).toBeNull();
		expect(after?.draftPhase).toBe("queued");
		await f.cleanup();
	});

	test("a draft claimed by a run that finalized to a TERMINAL state is reclaimed", async () => {
		const f = await fixture();
		const draft = await f.tasks.captureQuick("do the thing");
		const run = await f.registry.create({
			kind: "plan",
			taskId: draft.id,
			label: "plan#expand",
			model: "sonnet",
			cwd: f.root,
		});
		await f.registry.transition(run.id, "running");
		expect(await f.tasks.tryClaimDraftExpansion(draft.id, run.id, 60_000)).toBe(
			true,
		);
		// The run died before `draft_expand_failed` / `create_tasks`: its row is
		// terminal but its claim is still on the draft.
		await f.registry.finish(run.id, "failed", "crashed");

		const r = await f.maint.groom();
		expect(r.staleClaimsReleased).toBe(1);
		const after = await f.tasks.get(draft.id);
		expect(after?.status).toBe("draft");
		expect(after?.claimedByRunId).toBeNull();
		expect(after?.draftPhase).toBe("queued");
		await f.cleanup();
	});

	test("a draft claim held by a LIVE run is left alone, and its lease is renewed", async () => {
		const f = await fixture();
		const draft = await f.tasks.captureQuick("do the thing");
		const run = await f.registry.create({
			kind: "plan",
			taskId: draft.id,
			label: "plan#expand",
			model: "sonnet",
			cwd: f.root,
		});
		await f.registry.transition(run.id, "running");
		expect(await f.tasks.tryClaimDraftExpansion(draft.id, run.id, 1000)).toBe(
			true,
		);

		f.now.value += 60_000; // lease long past, run still live
		const r = await f.maint.groom();
		expect(r.staleClaimsReleased).toBe(0);
		const after = await f.tasks.get(draft.id);
		expect(after?.status).toBe("draft");
		expect(after?.claimedByRunId).toBe(run.id);
		expect(after?.draftPhase).toBe("expanding");
		expect((after?.leaseExpiresAt?.getTime() ?? 0) > Date.now()).toBe(true);
		await f.cleanup();
	});
});

describe("gc", () => {
	test("prunes old terminal run dirs but keeps live ones", async () => {
		const f = await fixture();
		const live = await f.registry.create({
			kind: "task",
			label: "live",
			model: "s",
			cwd: f.root,
		});
		await f.registry.transition(live.id, "running");
		const dead = [];
		for (let i = 0; i < 4; i++) {
			const r = await f.registry.create({
				kind: "task",
				label: `dead-${i}`,
				model: "s",
				cwd: f.root,
			});
			await f.registry.finish(r.id, "completed");
			dead.push(r);
		}

		const res = await f.maint.gc({ keepRuns: 2 });
		expect(res.runDirsPruned).toBe(2);
		// the live run's dir survives regardless of the cap
		expect(
			await Bun.file(join(f.registry.runDir(live.id), "meta.json")).exists(),
		).toBe(true);
		await f.cleanup();
	});

	test("failed writer cleanup retains the expired claim, run evidence and owned worktree", async () => {
		const f = await fixture();
		try {
			const task = await f.tasks.create({
				title: "writer still live",
				status: "ready",
			});
			const wm = new WorktreeManager(f.root);
			const owned = await wm.create("pending-cleanup", "main");
			const run = await f.registry.create({
				id: "pending-cleanup",
				kind: "task",
				taskId: task.id,
				label: "cleanup",
				model: "test",
				cwd: owned.path,
				worktreePath: owned.path,
				branch: owned.branch,
				baseSha: owned.baseSha,
			});
			await f.tasks.tryClaim(task.id, run.id, 1);
			await f.registry.beginStep(run.id, "reap_leftovers");
			await f.registry.failStep(
				run.id,
				"reap_leftovers",
				"writer identity unknown",
			);
			await f.registry.finish(run.id, "finalize_error");
			expect(await f.tasks.expireStaleLeases(Date.now() + 60_000)).toEqual([]);
			expect((await f.maint.groom()).staleClaimsReleased).toBe(0);
			expect((await f.tasks.get(task.id))?.claimedByRunId).toBe(run.id);
			expect(await f.maint.gc({ keepRuns: 0 })).toEqual({
				runDirsPruned: 0,
				worktreesRemoved: 0,
			});
			expect(
				await Bun.file(join(f.registry.runDir(run.id), "meta.json")).exists(),
			).toBe(true);
			expect(await Bun.file(join(owned.path, "feature.txt")).exists()).toBe(
				true,
			);
		} finally {
			await f.cleanup();
		}
	});

	test("maintenance tick logs failures instead of hiding them", async () => {
		const f = await fixture();
		// A broken registry makes groom throw; tick must still complete.
		const broken = new Maintenance({
			handle: f.handle,
			bus: f.bus,
			tasks: {
				list: async () => {
					throw new Error("boom");
				},
			} as never,
			registry: f.registry,
			log: silentLogger(),
			projectRoot: f.root,
			integrationBranch: "main",
		});
		await broken.tick(); // must not reject
		await f.cleanup();
	}, 30_000);
});

describe("gc retention for work awaiting a human", () => {
	test("a worktree whose task is in review is NOT deleted", async () => {
		// T14/T15 release to `review` with no gc step and no preserved pointer; gc
		// must still see that a human is judging that worktree.
		const f = await fixture();
		const t = await f.tasks.create({ title: "awaiting judgement" });
		const wt = join(f.root, "worktrees", "review-wt");
		await git(
			["worktree", "add", "-q", "-b", "mfw/review", wt, "main"],
			f.root,
		);
		const run = await f.registry.create({
			kind: "task",
			taskId: t.id,
			label: t.id,
			model: "sonnet",
			cwd: wt,
			worktreePath: wt,
			branch: "mfw/review",
		});
		await f.registry.finish(run.id, "completed");
		await f.tasks.move(t.id, "review", "verifier");

		await f.maint.gc({ keepRuns: 0 });
		expect(await Bun.file(join(wt, "feature.txt")).exists()).toBe(true);
		await f.cleanup();
	}, 30_000);

	test("foreign worktrees survive direct and periodic GC whether clean or dirty", async () => {
		const f = await fixture();
		const cleanWt = join(f.root, "worktrees", "manual-clean");
		const dirtyWt = join(f.root, "worktrees", "manual-dirty");
		await git(
			["worktree", "add", "-q", "-b", "review/manual-clean", cleanWt, "main"],
			f.root,
		);
		await git(
			["worktree", "add", "-q", "-b", "review/manual-dirty", dirtyWt, "main"],
			f.root,
		);
		await writeFile(join(dirtyWt, "uncommitted-review.txt"), "must survive\n");
		await f.maint.gc({ keepRuns: 0 });
		await f.maint.tick();
		expect(await Bun.file(join(cleanWt, "feature.txt")).exists()).toBe(true);
		expect(await Bun.file(join(dirtyWt, "uncommitted-review.txt")).text()).toBe(
			"must survive\n",
		);
		const listed = await git(["worktree", "list", "--porcelain"], f.root);
		expect(listed.stdout).toContain(`worktree ${cleanWt}`);
		expect(listed.stdout).toContain(`worktree ${dirtyWt}`);
		await f.cleanup();
	}, 30_000);

	test("owned worktrees survive until both clean and integrated", async () => {
		const f = await fixture();
		const createOwned = async (runId: string) => {
			const owned = await new WorktreeManager(f.root).create(runId, "main");
			const run = await f.registry.create({
				id: runId,
				kind: "task",
				label: runId,
				model: "test",
				cwd: owned.path,
				worktreePath: owned.path,
				branch: owned.branch,
				integrationBranch: "main",
				baseSha: owned.baseSha,
			});
			await f.registry.finish(run.id, "completed");
			return owned;
		};

		const dirty = await createOwned("owned-dirty");
		await writeFile(join(dirty.path, "uncommitted.txt"), "must survive\n");
		const unintegrated = await createOwned("owned-unintegrated");
		await writeFile(join(unintegrated.path, "new.txt"), "not merged\n");
		await git(["add", "new.txt"], unintegrated.path);
		await git(["commit", "-qm", "unintegrated"], unintegrated.path);

		await f.maint.gc({ keepRuns: 0 });

		expect(await Bun.file(join(dirty.path, "uncommitted.txt")).exists()).toBe(
			true,
		);
		expect(await Bun.file(join(unintegrated.path, "new.txt")).exists()).toBe(
			true,
		);
		const listed = await git(["worktree", "list", "--porcelain"], f.root);
		expect(listed.stdout).toContain(`worktree ${dirty.path}`);
		expect(listed.stdout).toContain(`worktree ${unintegrated.path}`);
		await f.cleanup();
	}, 30_000);

	test("ignored files in an owned worktree are data and survive GC", async () => {
		const f = await fixture();
		await writeFile(join(f.root, ".gitignore"), "*.secret\n");
		await git(["add", ".gitignore"], f.root);
		await git(["commit", "-qm", "ignore secrets"], f.root);
		const owned = await new WorktreeManager(f.root).create(
			"owned-ignored",
			"main",
		);
		const run = await f.registry.create({
			id: "owned-ignored",
			kind: "task",
			label: "owned ignored",
			model: "test",
			cwd: owned.path,
			worktreePath: owned.path,
			branch: owned.branch,
			integrationBranch: "main",
			baseSha: owned.baseSha,
		});
		await f.registry.finish(run.id, "completed");
		await writeFile(join(owned.path, "credential.secret"), "must survive\n");

		await f.maint.gc({ keepRuns: 0 });

		expect(await Bun.file(join(owned.path, "credential.secret")).text()).toBe(
			"must survive\n",
		);
		await f.cleanup();
	}, 30_000);

	test("a replayed path and branch without the ownership marker survive GC", async () => {
		const f = await fixture();
		const runId = "replayed-run";
		const path = join(f.root, "worktrees", runId);
		const branch = `mfw/${runId}`;
		const baseSha = (await git(["rev-parse", "main"], f.root)).stdout.trim();
		await git(["worktree", "add", "-q", "-b", branch, path, "main"], f.root);
		const run = await f.registry.create({
			id: runId,
			kind: "task",
			label: runId,
			model: "test",
			cwd: path,
			worktreePath: path,
			branch,
			integrationBranch: "main",
			baseSha,
		});
		await f.registry.finish(run.id, "completed");

		await f.maint.gc({ keepRuns: 0 });

		expect(await Bun.file(join(path, "feature.txt")).exists()).toBe(true);
		await f.cleanup();
	}, 30_000);

	test("historical rows never authorize branch deletion", async () => {
		const f = await fixture();
		const owned = await new WorktreeManager(f.root).create(
			"old-branch",
			"main",
		);
		await writeFile(join(owned.path, "unmerged.txt"), "keep the commit\n");
		await git(["add", "unmerged.txt"], owned.path);
		await git(["commit", "-qm", "unmerged work"], owned.path);
		const run = await f.registry.create({
			id: "old-branch",
			kind: "task",
			label: "old branch",
			model: "test",
			cwd: owned.path,
			worktreePath: owned.path,
			branch: owned.branch,
			integrationBranch: "main",
			baseSha: owned.baseSha,
		});
		await f.registry.finish(run.id, "failed");
		await git(["worktree", "remove", "--force", owned.path], f.root);
		f.now.value += 30 * 86_400_000;

		await f.maint.gc({ keepRuns: 0 });

		expect((await git(["rev-parse", owned.branch], f.root)).exitCode).toBe(0);
		await f.cleanup();
	}, 30_000);

	test("a clean integrated worktree with exact durable MFW ownership is removed", async () => {
		const f = await fixture();
		const runId = "owned-run";
		const owned = await new WorktreeManager(f.root).create(runId, "main");
		const run = await f.registry.create({
			id: runId,
			kind: "task",
			label: runId,
			model: "test",
			cwd: owned.path,
			worktreePath: owned.path,
			branch: owned.branch,
			integrationBranch: "main",
			baseSha: owned.baseSha,
		});
		await f.registry.finish(run.id, "completed");

		await f.maint.gc({ keepRuns: 0 });

		expect(await Bun.file(join(owned.path, "feature.txt")).exists()).toBe(
			false,
		);
		const listed = await git(["worktree", "list", "--porcelain"], f.root);
		expect(listed.stdout).not.toContain(`worktree ${owned.path}`);
		await f.cleanup();
	}, 30_000);
});

describe("expandDrafts: MFW-49", () => {
	function withExpand(
		f: F,
		opts: {
			startExpand?: (
				taskId: string,
				prompt: string,
			) => Promise<{ runId: string }>;
			maxConcurrentDraftExpansions?: number;
			dispatching?: () => Promise<boolean>;
		} = {},
	): Maintenance {
		return new Maintenance({
			handle: f.handle,
			bus: f.bus,
			tasks: f.tasks,
			registry: f.registry,
			log: silentLogger(),
			projectRoot: f.root,
			integrationBranch: "main",
			startExpand: opts.startExpand,
			maxConcurrentDraftExpansions: opts.maxConcurrentDraftExpansions,
			dispatching: opts.dispatching,
		});
	}

	test("does nothing when no startExpand is wired", async () => {
		const f = await fixture();
		await f.tasks.captureQuick("do the thing");
		const r = await f.maint.expandDrafts(); // f.maint has no startExpand
		expect(r.started).toEqual([]);
		await f.cleanup();
	});

	test("does not start expansion while the project is stopped", async () => {
		const f = await fixture();
		await f.tasks.captureQuick("do the thing");
		const started: string[] = [];
		const maint = withExpand(f, {
			startExpand: async (taskId) => {
				started.push(taskId);
				return { runId: `run-${taskId}` };
			},
			maxConcurrentDraftExpansions: 5,
			dispatching: async () => false,
		});
		const r = await maint.expandDrafts();
		expect(r.started).toEqual([]);
		expect(started).toEqual([]);
		await f.cleanup();
	});

	test("starts expansion when dispatching resolves true", async () => {
		const f = await fixture();
		const a = await f.tasks.captureQuick("do the thing");
		const started: string[] = [];
		const maint = withExpand(f, {
			startExpand: async (taskId) => {
				started.push(taskId);
				return { runId: `run-${taskId}` };
			},
			maxConcurrentDraftExpansions: 5,
			dispatching: async () => true,
		});
		const r = await maint.expandDrafts();
		expect(r.started).toEqual([a.id]);
		await f.cleanup();
	});

	test("starts an expansion for every draft under the concurrency cap", async () => {
		const f = await fixture();
		const a = await f.tasks.captureQuick("first");
		const b = await f.tasks.captureQuick("second");
		const started: string[] = [];
		const maint = withExpand(f, {
			startExpand: async (taskId) => {
				started.push(taskId);
				return { runId: `run-${taskId}` };
			},
			maxConcurrentDraftExpansions: 5,
		});
		const r = await maint.expandDrafts();
		expect(new Set(r.started)).toEqual(new Set([a.id, b.id]));
		expect(new Set(started)).toEqual(new Set([a.id, b.id]));
		await f.cleanup();
	});

	test("never starts a second expansion for a task that already has a live plan run", async () => {
		const f = await fixture();
		const a = await f.tasks.captureQuick("first");
		const run = await f.registry.create({
			kind: "plan",
			taskId: a.id,
			label: "plan#expand",
			model: "sonnet",
			cwd: f.root,
		});
		await f.registry.transition(run.id, "running");

		const started: string[] = [];
		const maint = withExpand(f, {
			startExpand: async (taskId) => {
				started.push(taskId);
				return { runId: "new" };
			},
			maxConcurrentDraftExpansions: 5,
		});
		const r = await maint.expandDrafts();
		expect(r.started).toEqual([]);
		expect(started).toEqual([]);
		await f.cleanup();
	});

	test("an open clarification pauses automatic expansion after its run releases the draft", async () => {
		const f = await fixture();
		const draft = await f.tasks.captureQuick("first");
		const source = await f.registry.create({
			kind: "plan",
			taskId: draft.id,
			label: "plan#expand",
			model: "sonnet",
			cwd: f.root,
		});
		await f.registry.transition(source.id, "running");
		await f.registry.transition(source.id, "ended");
		await f.registry.transition(source.id, "finalizing");
		await f.registry.transition(source.id, "completed");
		const clarify = new ClarifyService({
			handle: f.handle,
			bus: f.bus,
			log: silentLogger(),
		});
		await clarify.raise({
			runId: source.id,
			kind: "planner",
			goal: "first",
			questions: ["Which behavior?"],
		});

		const started: string[] = [];
		const maint = withExpand(f, {
			startExpand: async (taskId) => {
				started.push(taskId);
				return { runId: "unexpected" };
			},
			maxConcurrentDraftExpansions: 5,
		});
		expect((await f.tasks.get(draft.id))?.draftPhase).toBe(
			"waiting_for_answers",
		);
		expect((await maint.expandDrafts()).started).toEqual([]);
		expect(started).toEqual([]);
		await expect(
			f.tasks.edit(draft.id, { title: "changed under stale questions" }),
		).rejects.toThrow("waiting for clarification answers");
		await expect(f.tasks.move(draft.id, "archived", "human")).rejects.toThrow(
			"waiting for clarification answers",
		);
		await f.cleanup();
	});

	test("respects the system-wide concurrency cap across a sweep pass", async () => {
		const f = await fixture();
		await f.tasks.captureQuick("first");
		await f.tasks.captureQuick("second");
		await f.tasks.captureQuick("third");
		const started: string[] = [];
		const maint = withExpand(f, {
			startExpand: async (taskId) => {
				started.push(taskId);
				return { runId: `run-${taskId}` };
			},
			maxConcurrentDraftExpansions: 2,
		});
		const r = await maint.expandDrafts();
		expect(r.started.length).toBe(2);
		expect(started.length).toBe(2);
		await f.cleanup();
	});

	test("a startExpand failure for one draft does not stop the rest", async () => {
		const f = await fixture();
		const a = await f.tasks.captureQuick("first");
		const b = await f.tasks.captureQuick("second");
		const maint = withExpand(f, {
			startExpand: async (taskId) => {
				if (taskId === a.id) throw new Error("boom");
				return { runId: "ok" };
			},
			maxConcurrentDraftExpansions: 5,
		});
		const r = await maint.expandDrafts();
		expect(r.started).toEqual([b.id]);
		await f.cleanup();
	});
});
