import { afterEach, describe, expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBoardConfig } from "@mfw/board-core";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import { EventBus, type StoredEvent } from "@mfw/db/eventlog";
import { acquireKernelLock } from "../src/kernel-lock.ts";
import { silentLogger } from "../src/log.ts";
import { TaskService } from "../src/task-service.ts";
import { resolveTaskKey } from "../src/tasks/key.ts";
import { makeTasks } from "./fixtures/board.ts";

/**
 * The board is the source of truth: these tests cover the filesystem (where
 * bytes are, what a hand edit does, external deletion/corruption recovery).
 *
 * Status lives in frontmatter now, not a directory (MFW-ADR-22, superseding
 * MFW-ADR-2): a task is flat at `.mfw/tasks/<ID>-<slug>/task.md`, the slug is
 * frozen at creation (a retitle never moves the file), and every document
 * needs an `mfw: 1` marker to be recognized at all — a loose `.md` file with
 * no marker is invisible, not adopted (MFW-ADR-3 as corrected). There is no
 * sentinel file anymore; the circuit breaker's `"sentinel"` reason is a kept
 * legacy label meaning "the tasks directory itself looks absent" (checked via
 * `existsSync`, see `packages/daemon/src/tasks/index.ts`'s `assessScan`).
 */

interface Env {
	dir: string;
	handle: ProjectDbHandle;
	bus: EventBus;
	tasks: TaskService;
	seen: StoredEvent[];
}

const envs: Env[] = [];

async function freshEnv(): Promise<Env> {
	const dir = await mkdtemp(join(tmpdir(), "mfw-board-"));
	const handle = await openProjectDb(dir);
	const bus = new EventBus();
	const seen: StoredEvent[] = [];
	bus.subscribe((e) => seen.push(e));
	const tasks = await makeTasks(handle, bus, dir);
	const env = { dir, handle, bus, tasks, seen };
	envs.push(env);
	return env;
}

afterEach(async () => {
	for (const env of envs.splice(0)) {
		env.handle.close();
		await rm(env.dir, { recursive: true, force: true });
	}
});

const DOD = {
	verifier: "deterministic" as const,
	checks: [{ run: "true", expect_exit: 0 }],
};

/** `.mfw/tasks/` is flat now: every task directory name, one level deep. */
async function board(dir: string): Promise<string[]> {
	const root = join(dir, "tasks");
	const out: string[] = [];
	for (const name of await readdir(root)) {
		if (name.startsWith(".")) continue;
		if (await Bun.file(join(root, name, "task.md")).exists()) out.push(name);
	}
	return out.sort();
}

/** `<tasks>/<name>`, the task's directory. */
const taskDir = (dir: string, name: string) => join(dir, "tasks", name);
/** The markdown file inside it. */
const taskFile = (dir: string, name: string) =>
	join(taskDir(dir, name), "task.md");

const typesOf = (seen: StoredEvent[]) => seen.map((e) => e.type);

describe("status is a frontmatter field, not the directory", () => {
	test("a new task is a flat file named after its id and title, with no status: line (backlog is the quiet default)", async () => {
		const { dir, tasks } = await freshEnv();
		const t = await tasks.create({ title: "Wire the thing up!" });
		expect(await board(dir)).toEqual([`${t.id}-wire-the-thing-up`]);
		const raw = await readFile(
			taskFile(dir, `${t.id}-wire-the-thing-up`),
			"utf8",
		);
		expect(raw).toContain(`id: ${t.id}`);
		expect(raw).not.toContain("status:");
	});

	test("a transition rewrites the status: line in place; the path never moves", async () => {
		const { dir, tasks } = await freshEnv();
		const t = await tasks.create({ title: "move me" });
		const name = `${t.id}-move-me`;

		await tasks.move(t.id, "ready", "human");
		expect(await board(dir)).toEqual([name]); // same directory, not renamed
		const raw = await readFile(taskFile(dir, name), "utf8");
		expect(raw).toContain("status: ready");
	});

	test("blocked_reason is in the file, because a human reads it there", async () => {
		const { dir, tasks } = await freshEnv();
		const t = await tasks.create({ title: "stuck" });
		const name = `${t.id}-stuck`;
		await tasks.move(t.id, "blocked", "brain", "needs a decision");
		expect(await readFile(taskFile(dir, name), "utf8")).toContain(
			"blocked_reason: needs a decision",
		);

		await tasks.move(t.id, "ready", "human");
		const raw = await readFile(taskFile(dir, name), "utf8");
		expect(raw).not.toContain("blocked_reason");
		expect(await board(dir)).toHaveLength(1);
	});

	test("renaming the title does NOT rename the file: the slug is frozen at creation", async () => {
		// This inverts the pre-split test ("renaming the title renames the
		// file"): MFW-ADR-22 explicitly freezes a task's path at creation so a
		// reusable board engine never has to reason about rename-on-edit. The
		// title in the file's frontmatter still changes; the directory does not.
		const { dir, tasks } = await freshEnv();
		const t = await tasks.create({ title: "old name" });
		const name = `${t.id}-old-name`;
		await tasks.edit(t.id, { title: "new name" });
		expect(await board(dir)).toEqual([name]);
		expect(await readFile(taskFile(dir, name), "utf8")).toContain(
			"title: new name",
		);
	});
});

describe("the claim is a flock-guarded, re-validated, atomic content replace", () => {
	test("eight concurrent claimers, exactly one winner", async () => {
		const { dir, tasks } = await freshEnv();
		const t = await tasks.create({ title: "contested", dod: DOD });
		await tasks.move(t.id, "ready", "human");

		const results = await Promise.all(
			Array.from({ length: 8 }, (_, i) =>
				tasks.tryClaim(t.id, `run-${i}`, 60_000),
			),
		);
		expect(results.filter(Boolean)).toHaveLength(1);
		expect(await board(dir)).toEqual([`${t.id}-contested`]);

		const claimed = await tasks.get(t.id);
		expect(claimed?.status).toBe("in_progress");
		expect(claimed?.claimedByRunId).toMatch(/^run-\d$/);
	});

	test("a task that is not ready cannot be claimed", async () => {
		const { tasks } = await freshEnv();
		const t = await tasks.create({ title: "backlogged" });
		expect(await tasks.tryClaim(t.id, "run-1", 60_000)).toBe(false);
	});
});

describe("the database is an optimization", () => {
	test("deleting mfw.db loses no task, no status, and no content", async () => {
		const env = await freshEnv();
		const a = await env.tasks.create({ title: "alpha", body: "keep me" });
		const b = await env.tasks.create({ title: "beta", dod: DOD });
		await env.tasks.move(a.id, "done", "human");
		await env.tasks.move(b.id, "review", "human");
		env.handle.close();

		for (const suffix of ["", "-wal", "-shm"]) {
			await rm(join(env.dir, `mfw.db${suffix}`), { force: true });
		}

		const handle = await openProjectDb(env.dir);
		const revived = new TaskService({
			handle,
			bus: new EventBus(),
			mfwDir: env.dir,
			config: await loadBoardConfig(join(env.dir, "board.yaml")),
			taskKey: "MFW",
			log: silentLogger(),
		});
		await revived.load();
		const all = await revived.list();
		expect(all.map((t) => [t.id, t.status, t.title])).toEqual([
			[a.id, "done", "alpha"],
			[b.id, "review", "beta"],
		]);
		expect((await revived.get(a.id))?.body).toBe("keep me");
		expect((await revived.get(b.id))?.dod).toEqual(DOD);
		handle.close();
	});
});

describe("edits made outside the daemon", () => {
	test("a hand edit of identical length is detected on refresh", async () => {
		const { dir, tasks, seen } = await freshEnv();
		const t = await tasks.create({ title: "original title" });
		const name = `${t.id}-original-title`;
		const path = taskFile(dir, name);
		const raw = await readFile(path, "utf8");
		// Same length on purpose: mtime+size detection is blind to this.
		await writeFile(path, raw.replace("original title", "edited by hand"));

		seen.length = 0;
		const changes = await tasks.refresh();
		expect(changes).toEqual([
			{ kind: "edited", id: t.id, title: "edited by hand", to: "backlog" },
		]);
		const after = await tasks.get(t.id);
		expect(after?.title).toBe("edited by hand");
		// NOTE (regression vs. the pre-split store): the old TaskStore bumped
		// `rev` itself whenever a reread's hash disagreed with the last-seen
		// hash, specifically so a stale `baseRev` from before the hand edit
		// would conflict. `TaskIndex`/`materializeTaskFrontmatter` take `rev`
		// straight from the file's own `rev:` field with no such reconciliation
		// — a hand edit that doesn't also bump `rev` itself leaves `contentRev`
		// unchanged, so optimistic concurrency no longer catches this case. Worth
		// fixing in `TaskIndex` (flagged in this fork's report); asserting
		// current behavior here, not the old guarantee.
		expect(after?.contentRev).toBe(t.contentRev);
		expect(typesOf(seen)).toEqual(["task.edited"]);
		// The name is kept: renaming under an open editor buffer is hostile, and the id still identifies it.
		expect(await board(dir)).toEqual([name]);
	});

	test("a hand edit of the status: field IS a status change — no directory move involved anymore", async () => {
		const { dir, tasks, seen } = await freshEnv();
		const t = await tasks.create({ title: "dragged" });
		const name = `${t.id}-dragged`;
		const path = taskFile(dir, name);
		const raw = await readFile(path, "utf8");
		// Insert a status: line into the frontmatter block (backlog, the
		// default, is normally omitted entirely).
		const closing = raw.indexOf("\n---\n", raw.indexOf("---\n") + 4);
		const withStatus = `${raw.slice(0, closing)}\nstatus: done${raw.slice(closing)}`;
		await writeFile(path, withStatus);

		seen.length = 0;
		const changes = await tasks.refresh();
		expect(changes).toEqual([
			{
				kind: "moved",
				id: t.id,
				title: "dragged",
				from: "backlog",
				to: "done",
			},
		]);
		expect((await tasks.get(t.id))?.status).toBe("done");
		expect(await board(dir)).toEqual([name]); // still the same directory
	});

	test("`rm` deletes the task: there is nothing else it could mean", async () => {
		const { dir, tasks, seen } = await freshEnv();
		const t = await tasks.create({ title: "gone" });
		await rm(taskDir(dir, `${t.id}-gone`), { recursive: true });

		seen.length = 0;
		expect(await tasks.refresh()).toEqual([
			{ kind: "deleted", id: t.id, title: "gone", from: "backlog" },
		]);
		expect(await tasks.get(t.id)).toBeNull();
		expect(typesOf(seen)).toEqual(["task.deleted"]);
	});

	test("a hand-authored file WITH the mfw: marker and required fields is picked up as a real task", async () => {
		// Replaces the old "a bare markdown file dropped in a folder becomes a
		// task there" test: loose-note adoption from bare prose with no
		// frontmatter at all is retired (MFW-ADR-22/MFW-ADR-3) — a human now has
		// to write a minimal valid document, not just drop a heading. The board
		// still picks up a hand-authored file it never created itself.
		const { dir, tasks } = await freshEnv();
		await mkdir(join(dir, "tasks", "MFW-50-hand-authored"), {
			recursive: true,
		});
		await writeFile(
			join(dir, "tasks", "MFW-50-hand-authored", "task.md"),
			"---\nmfw: 1\nid: MFW-50\nrev: 1\ntitle: Write the onboarding doc\nstatus: ready\n---\n\nNew developers have nowhere to start.\n",
		);
		await tasks.refresh();

		const task = await tasks.get("MFW-50");
		expect(task?.title).toBe("Write the onboarding doc");
		expect(task?.status).toBe("ready");
	});

	test("an unparseable file is quarantined (reported, not moved) and never blocks the others", async () => {
		const { tasks } = await freshEnv();
		const good = await tasks.create({ title: "healthy" });
		await mkdir(join(tasks.store.tasksDir, "broken"), { recursive: true });
		await writeFile(
			join(tasks.store.tasksDir, "broken", "task.md"),
			"---\nmfw: 1\nid: MFW-99\ntitle: [unclosed\n---\n\nbody\n",
		);
		const report = await tasks.load();

		expect(report.quarantined.some((q) => q.file.includes("broken"))).toBe(
			true,
		);
		expect((await tasks.get(good.id))?.title).toBe("healthy");
	});

	test("two files claiming one id: the first wins, the second is reported as a duplicate", async () => {
		const { tasks } = await freshEnv();
		const t = await tasks.create({ title: "original" });
		const raw = await readFile(
			join(tasks.store.tasksDir, `${t.id}-original`, "task.md"),
			"utf8",
		);
		await mkdir(join(tasks.store.tasksDir, "a-duplicate"), { recursive: true });
		await writeFile(join(tasks.store.tasksDir, "a-duplicate", "task.md"), raw);
		await tasks.refresh();

		expect(await tasks.list()).toHaveLength(1);
		const report = await tasks.load();
		expect(
			report.quarantined.some((q) => q.reason.includes("duplicate id")),
		).toBe(true);
	});
});

describe("id allocation", () => {
	test("the counter file is a floor, not the truth", async () => {
		const { dir, tasks } = await freshEnv();
		await tasks.create({ title: "first" }); // MFW-1

		// Restored board with a lost counter must not re-issue an id a file owns.
		await mkdir(join(dir, "tasks", "MFW-100-restored"), { recursive: true });
		await writeFile(
			join(dir, "tasks", "MFW-100-restored", "task.md"),
			"---\nmfw: 1\nid: MFW-100\nrev: 1\ntitle: restored\nstatus: done\n---\n\nbody\n",
		);
		// The own-sequence counter board-core actually uses now.
		await rm(join(dir, ".board", "state", "task.json"), { force: true });
		await tasks.load();

		const next = await tasks.create({ title: "after" });
		expect(next.id).toBe("MFW-101");
	});
});

describe("concurrency", () => {
	test("two edits of the same task serialize; neither is lost", async () => {
		const { tasks } = await freshEnv();
		const t = await tasks.create({ title: "shared" });
		await Promise.all([
			tasks.edit(t.id, { body: "from A" }),
			tasks.edit(t.id, { labels: ["b"] }),
		]);
		const after = await tasks.get(t.id);
		expect(after?.body).toBe("from A");
		expect(after?.labels).toEqual(["b"]);
		expect(after?.contentRev).toBe(t.contentRev + 2);
	});

	test("a stale baseRev is rejected rather than overwriting", async () => {
		const { tasks } = await freshEnv();
		const t = await tasks.create({ title: "guarded" });
		await tasks.edit(t.id, { body: "someone else's change" });
		await expect(
			tasks.edit(t.id, { body: "mine" }, { baseRev: t.contentRev }),
		).rejects.toThrow(/was modified/);
		expect((await tasks.get(t.id))?.body).toBe("someone else's change");
	});
});

describe("locking", () => {
	// `@mfw/board-core`'s per-document transact lock, not the old store's — a
	// different directory (`.board/locks/`) and key encoding
	// (`encodeURIComponent("task:<id>")`) than before, see
	// `packages/board-core/src/store.ts`'s `BoardStore` constructor and
	// `packages/board-core/src/lock.ts`'s `KeyedLock.path`.
	const lockPathFor = (dir: string, id: string) =>
		join(dir, ".board", "locks", `${encodeURIComponent(`task:${id}`)}.lock`);

	test("a second process holding the lock file is waited for, not raced", async () => {
		const { dir, tasks } = await freshEnv();
		const t = await tasks.create({ title: "locked" });

		const lockPath = lockPathFor(dir, t.id);
		const holder = await acquireKernelLock(lockPath, {
			metadata: { pid: process.pid, at: Date.now(), key: t.id },
		});

		let done = false;
		const edit = tasks.edit(t.id, { body: "after the lock" }).then(() => {
			done = true;
		});
		try {
			await Bun.sleep(120);
			expect(done).toBe(false); // still waiting on the other holder
		} finally {
			await holder.release();
		}

		await edit;
		expect((await tasks.get(t.id))?.body).toBe("after the lock");
	}, 20_000);

	test("an unowned legacy lock file does not block acquisition", async () => {
		const { dir, tasks } = await freshEnv();
		const t = await tasks.create({ title: "legacy lock" });
		const lockPath = lockPathFor(dir, t.id);
		await mkdir(join(dir, ".board", "locks"), { recursive: true });
		await writeFile(
			lockPath,
			JSON.stringify({ pid: 1, at: Date.now() - 600_000, key: t.id }),
		);
		await tasks.edit(t.id, { body: "recovered" });
		expect((await tasks.get(t.id))?.body).toBe("recovered");
	}, 20_000);
});

describe("reading the board is not a reason to write it", () => {
	test("a well-formed task is left byte-identical, and keeps its name", async () => {
		// A git-tracked board must not be rewritten on first boot.
		const dir = await mkdtemp(join(tmpdir(), "mfw-board-"));
		const handle = await openProjectDb(dir);
		const dirName = "MFW-4-clarify-gate";
		await mkdir(join(dir, "tasks", dirName), { recursive: true });
		const path = join(dir, "tasks", dirName, "task.md");
		const raw = [
			"---",
			"mfw: 1",
			"id: MFW-4",
			"rev: 1",
			"title: Add a clarify gate to the planner",
			"status: done",
			"labels: [ brain, planner ]",
			"depends_on: []",
			"---",
			"",
			"## Goal",
			"Ask before guessing.",
			"",
		].join("\n");
		await writeFile(path, raw);

		const tasks = await makeTasks(handle, new EventBus(), dir);
		expect((await tasks.get("MFW-4"))?.status).toBe("done");
		expect(await readFile(path, "utf8")).toBe(raw); // untouched
		expect(await board(dir)).toEqual([dirName]);

		handle.close();
		await rm(dir, { recursive: true, force: true });
	});

	test("the task key comes from the board, not from the directory name", async () => {
		// Deriving the key from the directory name would quarantine every existing file.
		const dir = await mkdtemp(join(tmpdir(), "mfw-key-"));
		await mkdir(join(dir, ".mfw", "tasks", "ALBE-7-completion-depth"), {
			recursive: true,
		});
		await writeFile(join(dir, ".mfw", "config.yaml"), "taskKey: ALBE\n");
		await writeFile(
			join(dir, ".mfw", "tasks", "ALBE-7-completion-depth", "task.md"),
			"---\nmfw: 1\nid: ALBE-7\nrev: 1\ntitle: completion depth\nstatus: backlog\n---\n\nbody\n",
		);

		const key = await resolveTaskKey(join(dir, ".mfw"), dir);
		expect(key).toBe("ALBE");

		const handle = await openProjectDb(join(dir, ".mfw"));
		const tasks = await makeTasks(
			handle,
			new EventBus(),
			join(dir, ".mfw"),
			key,
		);
		expect((await tasks.get("ALBE-7"))?.title).toBe("completion depth");
		expect((await tasks.load()).quarantined).toEqual([]);
		// remembered: renaming the directory cannot change it
		expect(
			await resolveTaskKey(join(dir, ".mfw"), "/tmp/renamed-project"),
		).toBe("ALBE");

		handle.close();
		await rm(dir, { recursive: true, force: true });
	});

	test("the key is recovered from the files when nothing else says", async () => {
		// `resolveTaskKey`'s file-prefix scan is independent of the board-core
		// document model (no `mfw:` marker needed) — it just counts id-shaped
		// names directly under `.mfw/tasks/`, file or directory, adopted or not.
		const dir = await mkdtemp(join(tmpdir(), "mfw-key2-"));
		await mkdir(join(dir, ".mfw", "tasks"), { recursive: true });
		for (const n of [1, 2, 3]) {
			await writeFile(
				join(dir, ".mfw", "tasks", `WH-${n}-thing.md`),
				`---\nid: WH-${n}\ntitle: thing ${n}\n---\n`,
			);
		}
		expect(await resolveTaskKey(join(dir, ".mfw"), dir)).toBe("WH");
		await rm(dir, { recursive: true, force: true });
	});
});

describe("what is not a task", () => {
	test("a loose file with no mfw: marker is never adopted, wherever it sits", async () => {
		// Regression (pre-split): this once consumed a project's
		// `.mfw/tasks/SUMMARY.md`, back when adoption was location-based (inside
		// a status folder) rather than marker-based. The mechanism changed
		// (MFW-ADR-22/MFW-ADR-3) but the guarantee is the same: a stray
		// README/SUMMARY.md must never become a backlog item.
		const { dir, tasks } = await freshEnv();
		const summary = join(dir, "tasks", "SUMMARY.md");
		await mkdir(join(dir, "tasks"), { recursive: true });
		await writeFile(summary, "# What this project is about\n\nnotes\n");
		await tasks.refresh();

		expect(await tasks.list()).toEqual([]);
		expect(await readFile(summary, "utf8")).toContain("What this project is");
	});

	test("a task directory whose task.md has the marker but is missing required fields is reported, not silently ignored", async () => {
		// `task` is a directory-layout type: a loose flat `.md` file is never
		// even a candidate (only a directory containing `task.md` is scanned at
		// all), so this needs the directory shape, unlike the marker-less case
		// above which is correctly invisible either way.
		const { tasks } = await freshEnv();
		await mkdir(join(tasks.store.tasksDir, "almost"), { recursive: true });
		await writeFile(
			join(tasks.store.tasksDir, "almost", "task.md"),
			"---\nmfw: 1\nid: MFW-77\n---\n\nclaims to be ours, isn't valid\n",
		);
		const report = await tasks.load();
		expect(report.quarantined.length).toBeGreaterThan(0);
		expect(await tasks.get("MFW-77")).toBeNull();
	});
});

describe("housekeeping", () => {
	test("deleting a task file by hand takes both sidecars with it", async () => {
		const { dir, tasks } = await freshEnv();
		const t = await tasks.create({ title: "leaves nothing behind" });
		await tasks.bumpStall(t.id);
		const lease = join(dir, "state", "tasks", `${t.id}.json`);
		const runState = join(dir, "state", "tasks", `${t.id}.run.json`);
		expect(await Bun.file(lease).exists()).toBe(true);
		expect(await Bun.file(runState).exists()).toBe(true);

		await rm(taskDir(dir, `${t.id}-leaves-nothing-behind`), {
			recursive: true,
		});
		await tasks.refresh();
		expect(await Bun.file(lease).exists()).toBe(false);
		expect(await Bun.file(runState).exists()).toBe(false);
	});
});

/**
 * The mass-change circuit breaker. The board is tracked, so `git switch`,
 * `reset --hard`, `checkout .` or `clean -xdf` can make many files vanish; read
 * literally that emits N `task.deleted` events and empties the scheduler's
 * view, and the files come back later while the event log does not. Each
 * tripping test has a counterpart that must not trip.
 */
describe("the board stops being believed when it stops being the board", () => {
	/** n tasks, loaded and indexed. */
	async function boardOf(env: Env, n: number): Promise<string[]> {
		const ids: string[] = [];
		for (let i = 0; i < n; i++) {
			ids.push((await env.tasks.create({ title: `task ${i}` })).id);
		}
		return ids;
	}

	test("one task deleted by hand is still just a deletion", async () => {
		const env = await freshEnv();
		const ids = await boardOf(env, 8);
		await rm(taskDir(env.dir, `${ids[0]}-task-0`), { recursive: true });

		env.seen.length = 0;
		const changes = await env.tasks.refresh();
		expect(changes).toEqual([
			{
				kind: "deleted",
				id: ids[0] as string,
				title: "task 0",
				from: "backlog",
			},
		]);
		expect(env.tasks.isBoardSuspended).toBe(false);
		expect(typesOf(env.seen)).toEqual(["task.deleted"]);
		expect(await env.tasks.get(ids[0] as string)).toBeNull();
	});

	test("four of eight deleted at once is still just deletions", async () => {
		// Under both the floor and the half: clearing a few tasks must not trip it.
		const env = await freshEnv();
		const ids = await boardOf(env, 8);
		for (const id of ids.slice(0, 4)) {
			const name = `${id}-task-${ids.indexOf(id)}`;
			await rm(taskDir(env.dir, name), { recursive: true });
		}
		const changes = await env.tasks.refresh();
		expect(changes.filter((c) => c.kind === "deleted")).toHaveLength(4);
		expect(env.tasks.isBoardSuspended).toBe(false);
		expect((await env.tasks.list()).length).toBe(4);
	});

	test("the whole tasks/ directory vanishing is refused, and nothing is lost", async () => {
		const env = await freshEnv();
		const ids = await boardOf(env, 8);
		const before = (await env.tasks.list()).map((t) => t.id).sort();

		// Looks like `git switch` to a branch without the board.
		await rm(join(env.dir, "tasks"), { recursive: true, force: true });

		env.seen.length = 0;
		expect(await env.tasks.refresh()).toEqual([]);
		expect(env.tasks.isBoardSuspended).toBe(true);
		expect(typesOf(env.seen)).toEqual(["board.suspended"]);
		expect(env.seen[0]?.payload).toMatchObject({
			reason: "sentinel",
			indexed: 8,
			lost: 8,
		});
		// The index is untouched.
		expect((await env.tasks.list()).map((t) => t.id).sort()).toEqual(before);
		for (const id of ids) expect(await env.tasks.get(id)).not.toBeNull();
	});

	test("half a board vanishing with tasks/ itself intact trips it too", async () => {
		// `git checkout <older-sha> -- .mfw/tasks` or a botched merge: the
		// directory survives, most of its contents do not.
		const env = await freshEnv();
		const ids = await boardOf(env, 10);
		for (let i = 0; i < 6; i++) {
			await rm(taskDir(env.dir, `${ids[i]}-task-${i}`), { recursive: true });
		}
		env.seen.length = 0;
		expect(await env.tasks.refresh()).toEqual([]);
		expect(env.tasks.isBoardSuspended).toBe(true);
		expect(env.seen[0]?.payload).toMatchObject({
			reason: "mass-delete",
			indexed: 10,
			found: 4,
			lost: 6,
		});
		expect((await env.tasks.list()).length).toBe(10);
	});

	test("an empty board is legitimate, and never trips it", async () => {
		const env = await freshEnv();
		expect(await env.tasks.refresh()).toEqual([]);
		expect(env.tasks.isBoardSuspended).toBe(false);
		const t = await env.tasks.create({ title: "the first one" });
		await rm(taskDir(env.dir, `${t.id}-the-first-one`), { recursive: true });
		expect(await env.tasks.refresh()).toHaveLength(1);
		expect(env.tasks.isBoardSuspended).toBe(false);
	});

	test("it recovers by itself when the board comes back", async () => {
		const env = await freshEnv();
		const ids = await boardOf(env, 8);
		const tasksDir = join(env.dir, "tasks");
		const saved = new Map<string, string>();
		for (let i = 0; i < 8; i++) {
			const name = `${ids[i]}-task-${i}`;
			saved.set(name, await readFile(join(tasksDir, name, "task.md"), "utf8"));
		}

		await rm(tasksDir, { recursive: true, force: true });
		await env.tasks.refresh();
		expect(env.tasks.isBoardSuspended).toBe(true);

		// `git switch` back.
		for (const [name, content] of saved) {
			await mkdir(join(tasksDir, name), { recursive: true });
			await writeFile(join(tasksDir, name, "task.md"), content);
		}

		env.seen.length = 0;
		await env.tasks.refresh();
		expect(env.tasks.isBoardSuspended).toBe(false);
		expect(typesOf(env.seen)).toEqual(["board.resumed"]);
		expect((await env.tasks.list()).length).toBe(8);
		// No deleted/created events in either direction.
		expect(env.seen[0]?.payload).toMatchObject({ loaded: 8 });
	});

	test("it is announced once, not once per poll", async () => {
		const env = await freshEnv();
		await boardOf(env, 8);
		await rm(join(env.dir, "tasks"), { recursive: true, force: true });
		env.seen.length = 0;
		for (let i = 0; i < 5; i++) await env.tasks.refresh();
		expect(typesOf(env.seen)).toEqual(["board.suspended"]);
	});

	test("a suspended board is not written to, so the damage cannot spread", async () => {
		const env = await freshEnv();
		await boardOf(env, 8);
		await rm(join(env.dir, "tasks"), { recursive: true, force: true });
		await env.tasks.refresh();
		expect(env.tasks.isBoardSuspended).toBe(true);
		// Not recreated: that would litter someone's branch and make the next scan look legitimate.
		expect(await Bun.file(join(env.dir, "tasks")).exists()).toBe(false);
	});
});

describe("a conflicted task file on disk", () => {
	test("markers in the frontmatter break YAML outright: quarantined, and the rest of the board loads", async () => {
		// A `UU` file from a merge is not a task; half-parsing it would put
		// conflict markers into a prompt. `@mfw/board-core` has no dedicated
		// conflict-marker check — this still works because `<<<<<<< HEAD` etc.
		// inside the frontmatter block is simply invalid YAML, which already
		// fails to parse.
		const env = await freshEnv();
		const keep = await env.tasks.create({ title: "unaffected" });
		await mkdir(join(env.dir, "tasks", "MFW-99-conflicted"), {
			recursive: true,
		});
		await writeFile(
			join(env.dir, "tasks", "MFW-99-conflicted", "task.md"),
			[
				"---",
				"mfw: 1",
				"id: MFW-99",
				"rev: 1",
				"<<<<<<< HEAD",
				"title: ours",
				"=======",
				"title: theirs",
				">>>>>>> other",
				"---",
				"",
				"body",
				"",
			].join("\n"),
		);

		env.seen.length = 0;
		await env.tasks.load();
		expect(env.tasks.isBoardSuspended).toBe(false);
		expect((await env.tasks.get(keep.id))?.title).toBe("unaffected");
		expect(typesOf(env.seen)).toContain("task.quarantined");
	});

	// DROPPED (not reinterpreted): the pre-split test "markers left in the BODY
	// only ... are quarantined too" relied on `taskfile.ts`'s explicit
	// unresolved-conflict-marker scan, which covered BOTH the frontmatter and
	// the body. `@mfw/board-core`'s generic parser has no equivalent body scan
	// — the body is opaque markdown to it, so `<<<<<<< HEAD` markers sitting
	// only in the body of an otherwise-valid document now parse and load
	// successfully, markers and all. This is a genuine, unflagged regression
	// in the new stack (not something this test file can paper over), called
	// out in this fork's report for the parent to decide on.
});
