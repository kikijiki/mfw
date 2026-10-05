import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import { EventBus, type StoredEvent } from "@mfw/db/eventlog";
import { git } from "../src/git.ts";
import { silentLogger } from "../src/log.ts";
import { Maintenance, REOPEN_CHECK_INTERVAL_MS } from "../src/maintenance.ts";
import {
	loadReopenPolicies,
	reopenDefinitionHash,
	setReopenPolicy,
} from "../src/reopen-policy.ts";
import { RunRegistry } from "../src/run-registry.ts";
import type { TaskService } from "../src/task-service.ts";
import { makeTasks } from "./fixtures/board.ts";

interface Env {
	root: string;
	handle: ProjectDbHandle;
	svc: TaskService;
	maint: Maintenance;
	now: { value: number };
	seen: StoredEvent[];
}

const envs: Env[] = [];

async function freshEnv(): Promise<Env> {
	const root = await mkdtemp(join(tmpdir(), "mfw-reopen-"));
	const mfwDir = join(root, ".mfw");
	const handle = await openProjectDb(mfwDir);
	const bus = new EventBus();
	const seen: StoredEvent[] = [];
	bus.subscribe((e) => seen.push(e));
	const svc = await makeTasks(handle, bus, mfwDir);
	const now = { value: Date.now() };
	const maint = new Maintenance({
		handle,
		bus,
		tasks: svc,
		registry: new RunRegistry({ handle, bus, runsDir: join(mfwDir, "runs") }),
		log: silentLogger(),
		projectRoot: root,
		integrationBranch: "main",
		now: () => now.value,
	});
	const env = { root, handle, svc, maint, now, seen };
	envs.push(env);
	return env;
}

afterEach(async () => {
	for (const env of envs.splice(0)) {
		env.handle.close();
		await rm(env.root, { recursive: true, force: true });
	}
});

async function parked(
	svc: TaskService,
	reopenWhen: Parameters<TaskService["create"]>[0]["reopenWhen"],
): Promise<string> {
	const t = await svc.create({ title: "parked", body: "spec", reopenWhen });
	await svc.move(t.id, "blocked", "human", "waiting on upstream");
	return t.id;
}

describe("reopen_when: task_done", () => {
	test("a blocked task reopens once the named task is done", async () => {
		const { svc, seen } = await freshEnv();
		const dep = await svc.create({ title: "upstream" });
		const id = await parked(svc, [{ task_done: dep.id }]);

		expect(await svc.promoteReady()).not.toContain(id);
		expect((await svc.get(id))?.status).toBe("blocked");

		await svc.move(dep.id, "done", "scheduler");
		expect(await svc.promoteReady()).toContain(id);
		const row = await svc.get(id);
		expect(row?.status).toBe("ready");
		expect(row?.reopenWhen).toEqual([]);
		expect(row?.blockedReason).toBeNull();
		const event = seen.findLast(
			(e) => e.type === "task.status_changed" && e.taskId === id,
		);
		expect(event?.payload).toEqual({
			from: "blocked",
			to: "ready",
			actor: "scheduler",
			reason: `reopen condition met: ${dep.id} is done`,
		});
	});

	test("a manual backlog task reopens too", async () => {
		const { svc } = await freshEnv();
		const dep = await svc.create({ title: "upstream" });
		const t = await svc.create({
			title: "later",
			body: "spec",
			readyMode: "manual",
			reopenWhen: [{ task_done: dep.id }],
		});
		await svc.move(dep.id, "done", "scheduler");
		await svc.promoteReady();
		expect((await svc.get(t.id))?.status).toBe("ready");
	});

	test("not while another condition still fails", async () => {
		const { svc } = await freshEnv();
		const a = await svc.create({ title: "a" });
		const b = await svc.create({ title: "b" });
		const id = await parked(svc, [{ task_done: a.id }, { task_done: b.id }]);
		await svc.move(a.id, "done", "scheduler");
		await svc.promoteReady();
		expect((await svc.get(id))?.status).toBe("blocked");
		await svc.move(b.id, "done", "scheduler");
		await svc.promoteReady();
		expect((await svc.get(id))?.status).toBe("ready");
	});

	test("a pending command condition keeps promoteReady from reopening", async () => {
		const { svc } = await freshEnv();
		const a = await svc.create({ title: "a" });
		const id = await parked(svc, [
			{ task_done: a.id },
			{ run: "true", expect_exit: 0 },
		]);
		await svc.move(a.id, "done", "scheduler");
		await svc.promoteReady();
		expect((await svc.get(id))?.status).toBe("blocked");
	});

	test("one-shot: parking again after a reopen stays parked", async () => {
		const { svc } = await freshEnv();
		const dep = await svc.create({ title: "upstream" });
		const id = await parked(svc, [{ task_done: dep.id }]);
		await svc.move(dep.id, "done", "scheduler");
		await svc.promoteReady();
		expect((await svc.get(id))?.status).toBe("ready");

		await svc.move(id, "blocked", "scheduler", "stalled again");
		await svc.promoteReady();
		const row = await svc.get(id);
		expect(row?.status).toBe("blocked");
		expect(row?.blockedReason).toBe("stalled again");
	});

	test("reopening resets the stall, attempt and resume counters", async () => {
		const { svc } = await freshEnv();
		const dep = await svc.create({ title: "upstream" });
		const id = await parked(svc, [{ task_done: dep.id }]);
		await svc.bumpStall(id);
		await svc.bumpAttempt(id);
		await svc.bumpAttempt(id);
		await svc.bumpResume(id);
		await svc.move(dep.id, "done", "scheduler");
		await svc.promoteReady();
		const row = await svc.get(id);
		expect(row?.stallCount).toBe(0);
		expect(row?.attemptCount).toBe(0);
		expect(row?.resumeCount).toBe(0);
	});

	test("a claimed task is never reopened", async () => {
		const { svc } = await freshEnv();
		const dep = await svc.create({ title: "upstream" });
		const id = await parked(svc, [{ task_done: dep.id }]);
		await svc.store.patchState(id, {
			claimedByRunId: "run-1",
			claimedAt: Date.now(),
			leaseExpiresAt: Date.now() + 60_000,
		});
		await svc.move(dep.id, "done", "scheduler");
		await svc.promoteReady();
		expect((await svc.get(id))?.status).toBe("blocked");
	});

	test("reopen() refuses conditions edited since they were read", async () => {
		const { svc } = await freshEnv();
		const dep = await svc.create({ title: "upstream" });
		const id = await parked(svc, [{ task_done: dep.id }]);
		expect(await svc.reopen(id, [{ task_done: "MFW-99" }])).toBe(false);
		expect((await svc.get(id))?.status).toBe("blocked");
	});
});

describe("reopen_when: run", () => {
	test("commands run only after task_done holds, at most every 10 minutes", async () => {
		const { svc, maint, now, root } = await freshEnv();
		const dep = await svc.create({ title: "upstream" });
		// Relative path: the command runs in the project root.
		const id = await parked(svc, [
			{ task_done: dep.id },
			{ run: "test -f flag", expect_exit: 0 },
		]);

		// task_done does not hold yet: the command is not even run.
		expect((await maint.reopenByCommand()).checked).toEqual([]);

		await svc.move(dep.id, "done", "scheduler");
		await arm(root, svc, id);
		let r = await maint.reopenByCommand();
		expect(r).toEqual({ checked: [id], reopened: [] });

		await writeFile(join(root, "flag"), "");
		now.value += REOPEN_CHECK_INTERVAL_MS - 1;
		r = await maint.reopenByCommand();
		expect(r).toEqual({ checked: [], reopened: [] });
		expect((await svc.get(id))?.status).toBe("blocked");

		now.value += 1;
		r = await maint.reopenByCommand();
		expect(r).toEqual({ checked: [id], reopened: [id] });
		const row = await svc.get(id);
		expect(row?.status).toBe("ready");
		expect(row?.reopenWhen).toEqual([]);
	});

	test("expect_exit is honoured", async () => {
		const { svc, maint, root } = await freshEnv();
		const id = await parked(svc, [{ run: "exit 3", expect_exit: 3 }]);
		await arm(root, svc, id);
		expect((await maint.reopenByCommand()).reopened).toEqual([id]);
	});
});

async function arm(
	root: string,
	svc: TaskService,
	id: string,
	checkout: "primary" | "integration-worktree" = "primary",
) {
	const row = await svc.get(id);
	await setReopenPolicy(root, id, {
		hash: reopenDefinitionHash(row?.reopenWhen ?? [], undefined, "main"),
		checkout,
		armedAt: Date.now(),
	});
}

describe("reopen safety and recovery", () => {
	test("operator command arms the attached branch and can disarm it", async () => {
		const { svc, root } = await freshEnv();
		await git(["init", "-b", "release"], root);
		const id = await parked(svc, [{ run: "true", expect_exit: 0 }]);
		const home = await mkdtemp(join(tmpdir(), "mfw-reopen-operator-"));
		try {
			await writeFile(
				join(home, "config.json"),
				JSON.stringify({ projects: [{ name: "test", root }] }),
			);
			const script = resolve(
				import.meta.dir,
				"../../../tools/reopen-policy.ts",
			);
			for (const action of ["arm", "disarm"]) {
				const command = Bun.spawn(
					[process.execPath, script, action, root, id],
					{
						cwd: root,
						env: { ...process.env, MFW_HOME: home },
						stdout: "pipe",
						stderr: "pipe",
					},
				);
				const error = await new Response(command.stderr).text();
				expect(await command.exited, error).toBe(0);
				const policies = await loadReopenPolicies(root, home);
				if (action === "arm") {
					expect(policies[id]?.hash).toBe(
						reopenDefinitionHash(
							(await svc.get(id))?.reopenWhen ?? [],
							undefined,
							"release",
						),
					);
					expect(policies[id]?.checkout).toBe("integration-worktree");
				} else expect(policies).toEqual({});
			}
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("unarmed commands and disabled dispatch cannot write the primary checkout", async () => {
		const env = await freshEnv();
		const id = await parked(env.svc, [
			{ run: "printf ran > proof; exit 1", expect_exit: 0 },
		]);
		expect((await env.maint.reopenByCommand()).checked).toEqual([]);
		await arm(env.root, env.svc, id);
		const held = new Maintenance({
			handle: env.handle,
			bus: new EventBus(),
			tasks: env.svc,
			registry: new RunRegistry({
				handle: env.handle,
				bus: new EventBus(),
				runsDir: join(env.root, ".mfw", "runs"),
			}),
			log: silentLogger(),
			projectRoot: env.root,
			integrationBranch: "main",
			dispatching: async () => false,
		});
		expect((await held.reopenByCommand()).checked).toEqual([]);
		expect(await Bun.file(join(env.root, "proof")).exists()).toBe(false);
	});

	test("definition edits invalidate the operator pin", async () => {
		const { svc, maint, root } = await freshEnv();
		const id = await parked(svc, [{ run: "true", expect_exit: 0 }]);
		await arm(root, svc, id);
		await svc.edit(id, {
			reopenWhen: [{ run: "printf ran > proof", expect_exit: 0 }],
		});
		expect((await maint.reopenByCommand()).checked).toEqual([]);
		expect(await Bun.file(join(root, "proof")).exists()).toBe(false);
	});

	test("attempt audit and cooldown survive a maintenance restart", async () => {
		const env = await freshEnv();
		const id = await parked(env.svc, [{ run: "exit 1", expect_exit: 0 }]);
		await arm(env.root, env.svc, id);
		expect((await env.maint.reopenByCommand()).checked).toEqual([id]);
		const attempts = env.seen.filter(
			(event) => event.type === "task.reopen_check",
		);
		expect(attempts.map((event) => event.payload.phase)).toEqual([
			"started",
			"finished",
		]);
		expect(attempts[1]?.payload.outcome).toBe("failed");
		const restarted = new Maintenance({
			handle: env.handle,
			bus: new EventBus(),
			tasks: env.svc,
			registry: new RunRegistry({
				handle: env.handle,
				bus: new EventBus(),
				runsDir: join(env.root, ".mfw", "runs"),
			}),
			log: silentLogger(),
			projectRoot: env.root,
			integrationBranch: "main",
			now: () => env.now.value,
		});
		expect((await restarted.reopenByCommand()).checked).toEqual([]);
	});

	test("default armed checkout isolates tracked writes from the primary tree", async () => {
		const { svc, maint, root } = await freshEnv();
		await git(["init", "-b", "main"], root);
		await git(
			[
				"-c",
				"user.name=test",
				"-c",
				"user.email=test@example.com",
				"commit",
				"--allow-empty",
				"-m",
				"init",
			],
			root,
		);
		const id = await parked(svc, [
			{ run: "printf ran > proof", expect_exit: 0 },
		]);
		await arm(root, svc, id, "integration-worktree");
		expect((await maint.reopenByCommand()).reopened).toEqual([id]);
		expect(await Bun.file(join(root, "proof")).exists()).toBe(false);
	});

	test("task_done is rechecked when the command completes", async () => {
		const { svc, maint, root } = await freshEnv();
		const dep = await svc.create({ title: "upstream" });
		await svc.move(dep.id, "done", "human");
		const id = await parked(svc, [
			{ task_done: dep.id },
			{
				run: "touch started; while [ ! -f finish ]; do sleep 0.02; done",
				expect_exit: 0,
				timeout: 5,
			},
		]);
		await arm(root, svc, id);
		const check = maint.reopenByCommand();
		try {
			for (
				let n = 0;
				n < 100 && !(await Bun.file(join(root, "started")).exists());
				n++
			)
				await Bun.sleep(10);
			expect(await Bun.file(join(root, "started")).exists()).toBe(true);
			await svc.move(dep.id, "blocked", "human");
		} finally {
			await writeFile(join(root, "finish"), "");
		}
		expect((await check).reopened).toEqual([]);
		expect((await svc.get(id))?.status).toBe("blocked");
		expect((await svc.get(id))?.reopenWhen).toHaveLength(2);
	});

	test("a failed ready transition retains predicates and can retry after reload", async () => {
		const { svc } = await freshEnv();
		const dep = await svc.create({ title: "upstream" });
		const id = await parked(svc, [{ task_done: dep.id }]);
		await svc.bumpResume(id);
		await svc.move(dep.id, "done", "human");
		const current = svc.store.get(id);
		if (!current) throw new Error("missing parked task");
		// A status transition is now a content write at a fixed path, not a
		// rename to a destination that could be obstructed - the equivalent
		// failure injection is making the task's own directory unwritable, so
		// the atomic write's temp file can't even be created.
		const taskDir = dirname(current.path);
		await chmod(taskDir, 0o500);
		try {
			await expect(svc.promoteReady()).rejects.toThrow();
		} finally {
			await chmod(taskDir, 0o700);
		}
		await svc.load();
		expect((await svc.get(id))?.reopenWhen).toEqual([{ task_done: dep.id }]);
		expect(await svc.promoteReady()).toContain(id);
		expect((await svc.get(id))?.resumeCount).toBe(0);
	});

	test("reload completes field cleanup after a committed ready rename", async () => {
		const { svc } = await freshEnv();
		const dep = await svc.create({ title: "upstream" });
		const id = await parked(svc, [{ task_done: dep.id }]);
		await svc.move(dep.id, "done", "human");
		const store = svc.store as unknown as {
			finishReopen(rec: unknown): Promise<void>;
		};
		const finish = store.finishReopen.bind(store);
		store.finishReopen = async () => {
			throw new Error("crash after rename");
		};
		await expect(svc.promoteReady()).rejects.toThrow("crash after rename");
		store.finishReopen = finish;
		await svc.load();
		expect((await svc.get(id))?.status).toBe("ready");
		expect((await svc.get(id))?.reopenWhen).toEqual([]);
		expect((await svc.get(id))?.blockedReason).toBeNull();
	});

	test("automatic reopening requires specification and required template sections", async () => {
		const { svc, maint, root } = await freshEnv();
		const dep = await svc.create({ title: "upstream" });
		await svc.move(dep.id, "done", "human");
		const empty = await svc.create({
			title: "empty",
			readyMode: "manual",
			reopenWhen: [{ task_done: dep.id }],
		});
		await mkdir(join(root, ".mfw", "templates"), { recursive: true });
		await writeFile(
			join(root, ".mfw", "templates", "task.md"),
			"## Goal\nDescribe goal\n\n## Acceptance Criteria\n- [ ] Describe success\n",
		);
		const blocked = await parked(svc, [{ task_done: dep.id }]);
		const commanded = await parked(svc, [{ run: "true", expect_exit: 0 }]);
		await arm(root, svc, commanded);
		expect(await svc.promoteReady()).not.toContain(empty.id);
		expect((await svc.get(blocked))?.status).toBe("blocked");
		expect((await maint.reopenByCommand()).reopened).toEqual([]);
		expect((await svc.get(commanded))?.reopenWhen).toHaveLength(1);
	});
});
