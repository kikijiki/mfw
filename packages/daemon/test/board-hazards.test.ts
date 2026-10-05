import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
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
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import { EventBus, type StoredEvent } from "@mfw/db/eventlog";
import { ulid } from "@mfw/db/ids";
import { runs } from "@mfw/db/schema";
import { git } from "../src/git.ts";
import { silentLogger } from "../src/log.ts";
import { MergeQueue } from "../src/merge-queue.ts";
import type { TaskService } from "../src/task-service.ts";
import { BoardRepo } from "../src/tasks/board-git.ts";
import { MFW_EXCLUDE, makeTasks } from "./fixtures/board.ts";

/**
 * Ordinary git commands and concurrent writers both reach the board. Each test
 * is one way to damage it and counts tasks before and after (no exception is
 * not evidence nothing was lost; cf. Backlog.md #843, concurrent writes losing
 * data with both callers exiting 0).
 */

interface Env {
	root: string;
	mfwDir: string;
	handle: ProjectDbHandle;
	tasks: TaskService;
	board: BoardRepo;
	errors: string[];
	seen: StoredEvent[];
}

const envs: Env[] = [];

async function env(): Promise<Env> {
	const root = await mkdtemp(join(tmpdir(), "mfw-hazard-"));
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
	const errors: string[] = [];
	const board = new BoardRepo({
		projectRoot: root,
		mfwDir,
		integrationBranch: "main",
		log: {
			...silentLogger(),
			error: (_o: unknown, m: string) => errors.push(m),
		} as unknown as ReturnType<typeof silentLogger>,
		minIntervalMs: 0,
	});
	await board.ensureTracked();
	tasks.onBoardChanged = () => board.touch();
	tasks.onBoardSuspended = (on) => board.setSuspended(on);
	const e = { root, mfwDir, handle, tasks, board, errors, seen };
	envs.push(e);
	return e;
}

afterEach(async () => {
	for (const e of envs.splice(0)) {
		e.handle.close();
		await rm(e.root, { recursive: true, force: true });
	}
});

/** Seed n tasks and commit them. */
async function seed(e: Env, n: number): Promise<string[]> {
	const ids: string[] = [];
	for (let i = 0; i < n; i++) {
		ids.push((await e.tasks.create({ title: `task ${i}` })).id);
	}
	await e.board.flush();
	return ids;
}

const idsOnDisk = async (e: Env): Promise<string[]> => {
	const root = join(e.mfwDir, "tasks");
	const out: string[] = [];
	for (const name of await readdir(root).catch(() => [] as string[])) {
		if (name.startsWith(".")) continue;
		// A task is a directory holding `task.md`; report the directory names.
		if (await Bun.file(join(root, name, "task.md")).exists()) {
			out.push(name);
		}
	}
	return out.sort();
};

describe("git commands that move the board underneath the daemon", () => {
	test("`git switch` away and back loses nothing, and reports nothing", async () => {
		const e = await env();
		const ids = await seed(e, 8);
		const before = await idsOnDisk(e);

		// A branch cut before the board existed.
		const rootCommit = (
			await git(["rev-list", "--max-parents=0", "HEAD"], e.root)
		).stdout;
		await git(["checkout", "-q", "-b", "old", rootCommit], e.root);
		// git removed every tracked board file; since `tasks/` never held any
		// untracked content, it (empty now) is pruned along with them. An empty
		// `tasks/` dir is the signal the board exists at all (MFW-ADR-22).
		expect(existsSync(join(e.mfwDir, "tasks"))).toBe(false);
		expect(await idsOnDisk(e)).toEqual([]);

		// Reading is branch-pinned, so the daemon does not even look, but if it
		// did, the breaker would catch it. Assert the inner defence directly.
		e.seen.length = 0;
		expect(await e.tasks.refresh()).toEqual([]);
		expect(e.tasks.isBoardSuspended).toBe(true);
		expect(e.seen.map((x) => x.type)).toEqual(["board.suspended"]);
		expect((await e.tasks.list()).length).toBe(8);

		// It will not commit onto the wrong branch. The file is still written
		// (untracked, so it survives the switch back); only the commit is refused.
		const away = await e.tasks.create({ title: "made while away" });
		expect(await e.board.flush()).toBeNull();

		await git(["checkout", "-q", "main"], e.root);
		e.seen.length = 0;
		await e.tasks.refresh();
		expect(e.tasks.isBoardSuspended).toBe(false);
		expect(e.seen.map((x) => x.type)).toEqual(["board.resumed"]);
		// Every task is back byte for byte, plus the one written while away.
		for (const name of before) expect(await idsOnDisk(e)).toContain(name);
		for (const id of ids) expect(await e.tasks.get(id)).not.toBeNull();
		expect(await e.tasks.get(away.id)).not.toBeNull();
		expect((await e.tasks.list()).length).toBe(9);
	});

	test("`git reset --hard` to before the board is caught, not processed", async () => {
		const e = await env();
		await seed(e, 8);
		const preBoard = (
			await git(["rev-list", "--max-parents=0", "HEAD"], e.root)
		).stdout;

		await git(["reset", "--hard", "-q", preBoard], e.root);
		// `reset --hard` removes tracked files; the directory itself may survive.
		e.seen.length = 0;
		expect(await e.tasks.refresh()).toEqual([]);
		expect(e.tasks.isBoardSuspended).toBe(true);
		expect((await e.tasks.list()).length).toBe(8);
		// The daemon must not commit the emptied board (that would make it permanent).
		expect(await e.board.flush()).toBeNull();
	});

	test("`git checkout .` over a live board is caught the same way", async () => {
		const e = await env();
		const ids = await seed(e, 8);
		// Move most of the board, do not commit it, then have git undo it.
		for (const id of ids.slice(0, 6)) {
			await e.tasks.move(id, "ready", "human");
		}
		await git(["checkout", "--", ".mfw/tasks"], e.root);
		// Files are back where the last commit had them; the loader sees six moves, not a loss.
		const changes = await e.tasks.refresh();
		expect(changes.filter((c) => c.kind === "moved")).toHaveLength(6);
		expect(e.tasks.isBoardSuspended).toBe(false);
		expect((await e.tasks.list()).length).toBe(8);
	});

	test("`git clean -xdf` leaves a committed board alone", async () => {
		// `clean` never removes tracked files.
		const e = await env();
		await seed(e, 4);
		const before = await idsOnDisk(e);
		await git(["clean", "-xdf", "-q"], e.root);
		expect(await idsOnDisk(e)).toEqual(before);
		expect(await e.tasks.refresh()).toEqual([]);
		expect(e.tasks.isBoardSuspended).toBe(false);
	});

	test("a daemon that stopped mid-debounce commits the delta on the next attach", async () => {
		const e = await env();
		await seed(e, 3);
		// Writes hit disk immediately; only the COMMIT is debounced. So a crash
		// in the window loses a commit, never a task.
		const t = await e.tasks.create({ title: "written just before the crash" });
		const uncommitted = await git(["status", "--porcelain"], e.root);
		expect(uncommitted.stdout).toContain(t.id);

		// "Restart": a fresh BoardRepo and index over the same directory.
		const fresh = new BoardRepo({
			projectRoot: e.root,
			mfwDir: e.mfwDir,
			integrationBranch: "main",
			log: silentLogger(),
			minIntervalMs: 0,
		});
		await fresh.ensureTracked();
		const reread = await makeTasks(e.handle, new EventBus(), e.mfwDir);
		expect((await reread.get(t.id))?.title).toBe(
			"written just before the crash",
		);
		expect(await fresh.flush()).toContain(t.id);
		expect((await git(["status", "--porcelain"], e.root)).stdout).toBe("");
	});
});

describe("the daemon and a human sharing one index", () => {
	const lockPath = (e: Env) => join(e.root, ".git", "index.lock");

	test("a blocked commit is an error, never a silent skip", async () => {
		// The danger is a failure quiet enough to look like success.
		const e = await env();
		await seed(e, 2);
		const t = await e.tasks.create({ title: "written during contention" });

		// A human's git holds the index lock for the whole attempt.
		await writeFile(lockPath(e), "");
		// `tick()`, not `flush()`: the bug cleared the dirty flag before committing,
		// so a failure dropped the signal and the change was silently lost.
		expect(await e.board.tick()).toBeNull();
		expect(e.errors.join("\n")).toContain("NOT committed");

		// No new `touch()`: the pending change must still be known.
		await rm(lockPath(e));
		expect(await e.board.tick()).toContain(t.id);
		expect((await git(["status", "--porcelain"], e.root)).stdout).toBe("");
		expect(
			(await git(["ls-files", "--", ".mfw/tasks"], e.root)).stdout,
		).toContain(t.id);
	});

	test("a lock that clears during the backoff is retried, not reported", async () => {
		const e = await env();
		await seed(e, 2);
		const t = await e.tasks.create({ title: "briefly contended" });

		await writeFile(lockPath(e), "");
		const release = setTimeout(() => {
			void rm(lockPath(e)).catch(() => {});
		}, 120);
		const summary = await e.board.flush();
		clearTimeout(release);

		expect(summary).toContain(t.id);
		expect(e.errors).toEqual([]);
	});

	test("the human's own commits interleave with the daemon's, losing neither", async () => {
		const e = await env();
		await seed(e, 2);
		const humanFiles: string[] = [];
		const boardIds: string[] = [];

		for (let i = 0; i < 6; i++) {
			const name = `human-${i}.txt`;
			humanFiles.push(name);
			const t = await e.tasks.create({ title: `interleaved ${i}` });
			boardIds.push(t.id);
			await writeFile(join(e.root, name), `${i}\n`);
			// Deliberately concurrent: two writers, one index.
			const human = async () => {
				// A loser retries (human reruns, daemon's next tick); neither may lose the change.
				for (let attempt = 0; attempt < 5; attempt++) {
					await git(["add", "--", name], e.root);
					const c = await git(
						["commit", "-q", "-m", `human ${i}`, "--", name],
						e.root,
					);
					if (c.exitCode === 0) return;
					await Bun.sleep(60);
				}
				throw new Error(`human commit ${i} never landed`);
			};
			const [, summary] = await Promise.all([human(), e.board.flush()]);
			if (summary === null) {
				expect(await e.board.flush()).toContain(t.id);
			}
		}

		// Everything from both writers is in the tree, and the working copy is
		// clean, no half-staged board, no orphaned human file.
		const tracked = (await git(["ls-files"], e.root)).stdout;
		for (const f of humanFiles) expect(tracked).toContain(f);
		for (const id of boardIds) expect(tracked).toContain(id);
		expect((await git(["status", "--porcelain"], e.root)).stdout).toBe("");
		expect((await e.tasks.list()).length).toBe(8);
	});
});

describe("board writes and merges at the same time", () => {
	test("several runs land while the daemon is committing transitions", async () => {
		const e = await env();
		const ids = await seed(e, 6);
		const boardBefore = await idsOnDisk(e);

		const queue = new MergeQueue({
			handle: e.handle,
			bus: new EventBus(),
			projectRoot: e.root,
			log: silentLogger(),
			reverify: async () => ({ passed: true }),
			onMerged: async () => {},
			onParked: async () => {},
		});

		// Four runs, each touching its own file, all queued at once.
		for (let i = 0; i < 4; i++) {
			const branch = `mfw/run-${i}`;
			const wt = join(e.root, "worktrees", `run-${i}`);
			await git(["worktree", "add", "-q", "-b", branch, wt, "main"], e.root);
			await writeFile(join(wt, `f-${i}.txt`), `work ${i}\n`);
			await git(["add", "-A"], wt);
			await git(["commit", "-q", "-m", `work ${i}`], wt);
			const runId = ulid();
			await e.handle.db.insert(runs).values({
				id: runId,
				kind: "task",
				label: branch,
				model: "sonnet",
				cwd: wt,
				worktreePath: wt,
				branch,
				integrationBranch: "main",
				startedAt: new Date(),
			});
			await queue.enqueue({
				runId,
				taskId: ids[i] as string,
				branch,
				targetBranch: "main",
			});
		}

		// Drain the queue while the board keeps moving, in the same repo.
		const drain = (async () => {
			while ((await queue.tick()) !== "idle") {
				/* keep going */
			}
		})();
		const churn = (async () => {
			for (const id of ids) {
				await e.tasks.move(id, "ready", "human");
				await e.board.flush();
			}
		})();
		await Promise.all([drain, churn]);
		await e.board.flush();

		// Every merge landed...
		for (let i = 0; i < 4; i++) {
			expect((await git(["show", `main:f-${i}.txt`], e.root)).exitCode).toBe(0);
		}
		// ...every task is still here, and moved...
		expect(await idsOnDisk(e)).toEqual(boardBefore);
		expect((await e.tasks.list()).length).toBe(6);
		expect((await e.tasks.list()).every((t) => t.status === "ready")).toBe(
			true,
		);
		// ...and the checkout is clean, with the board's final state committed.
		expect((await git(["status", "--porcelain"], e.root)).stdout).toBe("");
		const tracked = (await git(["ls-files", "--", ".mfw/tasks"], e.root))
			.stdout;
		for (const id of ids) expect(tracked).toContain(id);
	}, 30_000);

	test("a transition made mid-merge is committed once the merge finishes", async () => {
		const e = await env();
		const ids = await seed(e, 3);

		// A human can sit in a conflicted merge for a long time; the daemon must neither commit into it nor forget.
		await writeFile(join(e.root, "c.txt"), "base\n");
		await git(["add", "-A"], e.root);
		await git(["commit", "-qm", "base"], e.root);
		await git(["checkout", "-q", "-b", "other"], e.root);
		await writeFile(join(e.root, "c.txt"), "theirs\n");
		await git(["commit", "-qam", "theirs"], e.root);
		await git(["checkout", "-q", "main"], e.root);
		await writeFile(join(e.root, "c.txt"), "ours\n");
		await git(["commit", "-qam", "ours"], e.root);
		expect((await git(["merge", "other"], e.root)).exitCode).not.toBe(0);

		await e.tasks.move(ids[0] as string, "ready", "human");
		expect(await e.board.flush()).toBeNull();

		await git(["merge", "--abort"], e.root);
		expect(await e.board.tick()).toContain(ids[0] as string);
		expect((await e.tasks.list()).length).toBe(3);
		expect(
			(await git(["ls-files", "--", ".mfw/tasks"], e.root)).stdout,
		).toContain(ids[0] as string);
	});
});

describe("concurrent claimers, across processes", () => {
	test("eight processes racing for one task produce exactly one winner", async () => {
		// In-process version is in `board.test.ts`. The claim (rename out of
		// `ready/` under an `O_CREAT|O_EXCL` lock) is a filesystem guarantee, so race it across processes.
		const e = await env();
		const t = await e.tasks.create({ title: "contended" });
		await e.tasks.move(t.id, "ready", "human");
		await e.board.flush();

		const script = join(import.meta.dir, "fixtures", "claim-process.ts");
		const verdicts = await Promise.all(
			Array.from({ length: 8 }, async (_, i) => {
				const p = Bun.spawn(
					["bun", "run", script, e.mfwDir, t.id, `run-${i}`],
					{ cwd: e.root, stdout: "pipe", stderr: "pipe" },
				);
				const text = await new Response(p.stdout).text();
				await p.exited;
				return text.trim();
			}),
		);

		// Exactly one winner, and the seven losers said so rather than crashing.
		expect(verdicts.filter((v) => v === "won")).toHaveLength(1);
		expect(verdicts.filter((v) => v === "lost")).toHaveLength(7);

		// And the board says one thing: the task exists exactly once, in
		// `in-progress`, with one claimant.
		await e.tasks.load();
		expect((await idsOnDisk(e)).filter((f) => f.startsWith(t.id))).toHaveLength(
			1,
		);
		const after = await e.tasks.get(t.id);
		expect(after?.status).toBe("in_progress");
		expect(after?.claimedByRunId).toMatch(/^run-\d$/);
	}, 60_000);
});

describe("the scheduler will not dispatch from a board nobody believes", () => {
	test("a suspended board holds dispatch, and releasing it resumes", async () => {
		const e = await env();
		const ids = await seed(e, 8);
		for (const id of ids) await e.tasks.move(id, "ready", "human");
		await e.board.flush();

		await rm(join(e.mfwDir, "tasks"), { recursive: true, force: true });
		await e.tasks.refresh();
		expect(e.tasks.isBoardSuspended).toBe(true);
		// Dispatching now would claim tasks whose files are not in the checkout,
		// and the claim could not be committed.
		expect((await e.tasks.readySet()).length).toBe(8); // the index still knows
	});
});

describe("a board file the project genuinely ignores", () => {
	test("disables committing without breaking the board", async () => {
		const e = await env();
		await seed(e, 3);
		await writeFile(join(e.root, ".gitignore"), ".mfw/\n");
		await git(["add", ".gitignore"], e.root);
		await git(["commit", "-qm", "ignore mfw"], e.root);

		const fresh = new BoardRepo({
			projectRoot: e.root,
			mfwDir: e.mfwDir,
			integrationBranch: "main",
			log: silentLogger(),
			minIntervalMs: 0,
		});
		expect((await fresh.ensureTracked()).enabled).toBe(false);
		expect(await fresh.flush()).toBeNull();

		// The board is plain files and keeps working.
		const t = await e.tasks.create({ title: "still fine" });
		expect((await e.tasks.get(t.id))?.title).toBe("still fine");
		expect((await e.tasks.list()).length).toBe(4);
		expect(await readFile(join(e.root, ".gitignore"), "utf8")).toBe(".mfw/\n");
	});
});
