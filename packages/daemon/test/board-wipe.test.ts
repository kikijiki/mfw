import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import { EventBus, type StoredEvent } from "@mfw/db/eventlog";
import { git } from "../src/git.ts";
import { silentLogger } from "../src/log.ts";
import {
	MalformedTaskFileError,
	type TaskService,
} from "../src/task-service.ts";
import { BoardRepo } from "../src/tasks/board-git.ts";
import { MFW_EXCLUDE, makeTasks } from "./fixtures/board.ts";

/**
 * Deleting one task and wiping the board. An intentional wipe looks like a
 * `git reset --hard` to the circuit breaker, so these pin both halves: the
 * wipe does not trip it, and the same shape from anything else still does.
 */

interface Env {
	root: string;
	mfwDir: string;
	handle: ProjectDbHandle;
	tasks: TaskService;
	board: BoardRepo;
	seen: StoredEvent[];
}

const envs: Env[] = [];

async function freshEnv(): Promise<Env> {
	const root = await mkdtemp(join(tmpdir(), "mfw-wipe-"));
	await git(["init", "-q", "-b", "main", "."], root);
	await git(["config", "user.email", "t@t"], root);
	await git(["config", "user.name", "t"], root);
	await writeFile(join(root, ".git/info/exclude"), MFW_EXCLUDE);
	await writeFile(join(root, "app.ts"), "export const x = 1;\n");
	await git(["add", "-A"], root);
	await git(["commit", "-qm", "init"], root);

	const mfwDir = join(root, ".mfw");
	await mkdir(mfwDir, { recursive: true });
	const handle = await openProjectDb(mfwDir);
	const bus = new EventBus();
	const seen: StoredEvent[] = [];
	bus.subscribe((e) => seen.push(e));
	const tasks = await makeTasks(handle, bus, mfwDir);
	const board = new BoardRepo({
		projectRoot: root,
		mfwDir,
		integrationBranch: "main",
		log: silentLogger(),
		minIntervalMs: 0,
	});
	await board.ensureTracked();
	tasks.onBoardChanged = () => board.touch();
	tasks.onBoardSuspended = (on) => board.setSuspended(on);
	await tasks.load();

	const env: Env = { root, mfwDir, handle, tasks, board, seen };
	envs.push(env);
	return env;
}

async function seed(env: Env, n: number): Promise<string[]> {
	const ids: string[] = [];
	for (let i = 0; i < n; i++) {
		ids.push((await env.tasks.create({ title: `task ${i}` })).id);
	}
	return ids;
}

/** Every task markdown currently on the board, as absolute paths. */
function fileOf(env: Env, id: string): string {
	const rec = env.tasks.store.get(id);
	if (!rec) throw new Error(`${id} is not indexed`);
	return rec.path;
}

afterEach(async () => {
	for (const env of envs.splice(0)) {
		env.handle.close();
		await rm(env.root, { recursive: true, force: true });
	}
});

describe("deleting one task", () => {
	test("remove() deletes the file and its sidecar state and says so", async () => {
		const env = await freshEnv();
		const [a, b] = await seed(env, 2);
		await env.board.flush(); // both tasks tracked, so the delete is a delete
		const path = fileOf(env, a as string);
		const sidecar = join(env.mfwDir, "state", "tasks", `${a}.json`);
		expect(existsSync(path)).toBe(true);
		expect(existsSync(sidecar)).toBe(true);
		env.seen.length = 0;

		expect(await env.tasks.remove(a as string)).toBe(true);

		expect(existsSync(path)).toBe(false);
		expect(existsSync(sidecar)).toBe(false);
		expect(await env.tasks.get(a as string)).toBeNull();
		expect((await env.tasks.list()).map((t) => t.id)).toEqual([b as string]);
		expect(env.seen.map((e) => e.type)).toEqual(["task.deleted"]);
		expect(await env.board.flush()).toContain("removed");
	});

	test("removing a task that is not there is false, not a throw", async () => {
		const env = await freshEnv();
		expect(await env.tasks.remove("MFW-999")).toBe(false);
	});

	test("a delete is refused while the breaker holds the board", async () => {
		const env = await freshEnv();
		const [a] = await seed(env, 6);
		const path = fileOf(env, a as string);
		const tasksDir = join(env.mfwDir, "tasks");
		const leaf = relative(tasksDir, path);
		// The checkout stops carrying the board (what `git switch` looks like):
		// the whole `tasks/` directory moves out from under the index. Moved
		// aside rather than deleted, so we can prove `remove()` left it alone.
		const movedAside = `${tasksDir}.aside`;
		await rename(tasksDir, movedAside);
		await env.tasks.load();
		expect(env.tasks.isBoardSuspended).toBe(true);

		expect(env.tasks.remove(a as string)).rejects.toThrow("board is suspended");

		// Must refuse: deleting would drop it from the index while the file is
		// untouched, just not where the index currently expects it.
		expect(existsSync(join(movedAside, leaf))).toBe(true);
		expect((await env.tasks.list()).length).toBe(6);
	});

	test("a later scan does not report the deleted task a second time", async () => {
		const env = await freshEnv();
		const [a] = await seed(env, 3);
		await env.tasks.remove(a as string);
		env.seen.length = 0;

		expect(await env.tasks.refresh()).toEqual([]);

		expect(env.seen).toEqual([]);
	});
});

describe("wiping the board", () => {
	test("wipe() empties the board and reports every id it deleted", async () => {
		const env = await freshEnv();
		const ids = await seed(env, 6);
		env.seen.length = 0;

		const { deleted } = await env.tasks.wipe();

		expect(deleted.sort()).toEqual([...ids].sort());
		expect(await env.tasks.list()).toEqual([]);
		for (const id of ids) {
			expect(existsSync(join(env.mfwDir, "state", "tasks", `${id}.json`))).toBe(
				false,
			);
		}
		expect(env.seen.map((e) => e.type)).toEqual(ids.map(() => "task.deleted"));
	});

	test("the scan AFTER a wipe is not a mass-delete: the board is simply empty", async () => {
		const env = await freshEnv();
		await seed(env, 8);

		await env.tasks.wipe();
		const report = await env.tasks.load();

		expect(report.suspended).toBeUndefined();
		expect(env.tasks.isBoardSuspended).toBe(false);
		expect(report.loaded).toBe(0);
		// The directory itself survives a wipe (only its contents are removed), so
		// an empty board differs from a checkout that never had one.
		expect(existsSync(join(env.mfwDir, "tasks"))).toBe(true);
	});

	test("ids are never reused: the next task after a wipe keeps counting", async () => {
		const env = await freshEnv();
		const ids = await seed(env, 3);
		await env.tasks.wipe();

		const next = await env.tasks.create({ title: "after the wipe" });

		expect(ids).not.toContain(next.id);
		expect(next.id).toBe("MFW-4");
	});

	test("a wipe is refused while the breaker holds the board", async () => {
		const env = await freshEnv();
		await seed(env, 6);
		// The checkout stops carrying the board (what `git switch` looks like):
		// the whole `tasks/` directory is gone, not just emptied.
		await rm(join(env.mfwDir, "tasks"), { recursive: true, force: true });
		await env.tasks.load();
		expect(env.tasks.isBoardSuspended).toBe(true);

		expect(env.tasks.wipe()).rejects.toThrow("board is suspended");

		expect((await env.tasks.list()).length).toBe(6);
	});

	test("a malformed task refuses the whole wipe without deleting valid files", async () => {
		const env = await freshEnv();
		const ids = await seed(env, 2);
		const first = ids[0] as string;
		const second = ids[1] as string;
		const malformedPath = fileOf(env, second);
		const good = await readFile(malformedPath, "utf8");
		const malformed = `---\nid: ${second}\ntitle: [unterminated\n---\n`;
		await writeFile(malformedPath, malformed);

		await expect(env.tasks.wipe()).rejects.toBeInstanceOf(
			MalformedTaskFileError,
		);
		expect(existsSync(fileOf(env, first))).toBe(true);
		expect(await readFile(malformedPath, "utf8")).toBe(malformed);

		await writeFile(malformedPath, good);
		expect((await env.tasks.wipe()).deleted.sort()).toEqual(ids.sort());
	});
});

describe("the wipe and the circuit breaker", () => {
	/**
	 * A scan snapshots the index, then reads the directory (two awaits). A wipe
	 * landing between them looks exactly like `git reset --hard`. Files are
	 * removed behind the store's back to reproduce that window, with and without
	 * a declared wipe.
	 */
	async function deleteFilesBehindTheStore(env: Env): Promise<void> {
		for (const rec of env.tasks.store.list()) {
			await rm(rec.path, { force: true });
		}
	}

	test("the same shape, with no wipe in flight, still trips the breaker", async () => {
		const env = await freshEnv();
		await seed(env, 8);

		await deleteFilesBehindTheStore(env);
		const report = await env.tasks.load();

		expect(report.suspended?.reason).toBe("mass-delete");
		expect(env.tasks.isBoardSuspended).toBe(true);
		// Held at the last good state, not reported as eight deletions.
		expect((await env.tasks.list()).length).toBe(8);
	});

	test("a scan queued mid-wipe waits and does not suspend the board", async () => {
		const env = await freshEnv();
		await seed(env, 8);
		const store = env.tasks.store;
		const internals = store as unknown as {
			removeLocked(id: string): Promise<boolean>;
			boardLock: { chains: Map<string, Promise<unknown>> };
		};
		const realRemove = internals.removeLocked.bind(store);
		let paused!: () => void;
		const atPause = new Promise<void>((r) => {
			paused = r;
		});
		let go!: () => void;
		const gate = new Promise<void>((r) => {
			go = r;
		});
		let first = true;
		internals.removeLocked = async (id: string) => {
			const ok = await realRemove(id);
			if (first) {
				first = false;
				paused();
				await gate;
			}
			return ok;
		};

		const wiping = env.tasks.wipe();
		await atPause;
		const wipeChain = internals.boardLock.chains.get("::board");
		let scanSettled = false;
		const scanning = env.tasks.load().then((report) => {
			scanSettled = true;
			return report;
		});
		// Wait for load to join the board-lock queue so its scan skips the half-removed board.
		while (internals.boardLock.chains.get("::board") === wipeChain) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		expect(scanSettled).toBe(false);

		go();
		const [, afterScan] = await Promise.all([wiping, scanning]);
		expect(afterScan.suspended).toBeUndefined();
		expect(env.tasks.isBoardSuspended).toBe(false);
		expect(await env.tasks.list()).toEqual([]);
		// The breaker stays armed; it was only told this emptying was intentional.
		await seed(env, 8);
		await deleteFilesBehindTheStore(env);
		expect((await env.tasks.load()).suspended?.reason).toBe("mass-delete");
	});
});
