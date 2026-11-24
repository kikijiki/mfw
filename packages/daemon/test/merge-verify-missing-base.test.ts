import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "@mfw/db/ids";
import { runs } from "@mfw/db/schema";
import { boot } from "../src/boot.ts";
import { loadConfig, toBootProjects } from "../src/config.ts";
import { git, gitOk } from "../src/git.ts";
import { silentLogger } from "../src/log.ts";

/**
 * Wave 2 exit review, m1: verifying the merge commit answered "passed" when
 * the run row had no base commit, where re-verify refuses the same case.
 */

const dirs: string[] = [];
afterEach(async () => {
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

test("a merge whose run has no base commit is not verified, so it does not land", async () => {
	const root = await mkdtemp(join(tmpdir(), "mfw-m1-"));
	const home = await mkdtemp(join(tmpdir(), "mfw-m1-home-"));
	dirs.push(root, home);
	await git(["init", "-q", "-b", "main", "."], root);
	await git(["config", "user.email", "t@test"], root);
	await git(["config", "user.name", "t"], root);
	await writeFile(join(root, "a.txt"), "x\n");
	await git(["add", "-A"], root);
	await git(["commit", "-qm", "init"], root);
	await git(["checkout", "-q", "-b", "work"], root);
	await writeFile(join(root, "b.txt"), "y\n");
	await git(["add", "-A"], root);
	await git(["commit", "-qm", "work"], root);
	await git(["checkout", "-q", "main"], root);
	await writeFile(
		join(home, "config.json"),
		JSON.stringify({ projects: [{ name: "p", root }] }),
	);
	const orch = await boot({
		projects: toBootProjects(await loadConfig(home)),
		mfwHome: home,
		autostart: false,
		log: silentLogger(),
	});
	try {
		const svc = orch.list()[0];
		if (!svc) throw new Error("no project");
		const before = await gitOk(["rev-parse", "refs/heads/main"], root);
		const task = await svc.tasks.create({
			title: "t",
			status: "ready",
			verification: {
				verifier: "deterministic",
				checks: [{ run: "true", expect_exit: 0 }],
			},
		});
		const runId = ulid();
		await svc.handle.db.insert(runs).values({
			id: runId,
			kind: "task",
			taskId: task.id,
			label: "t",
			model: "sonnet",
			cwd: root,
			branch: "work",
			integrationBranch: "main",
			startedAt: new Date(),
		});
		await svc.mergeQueue.enqueue({
			runId,
			taskId: task.id,
			branch: "work",
			targetBranch: "main",
		});
		expect(await svc.mergeQueue.tick()).toBe("parked");
		expect(await gitOk(["rev-parse", "refs/heads/main"], root)).toBe(before);
		expect((await svc.mergeQueue.byRun(runId))?.error).toContain("base commit");
	} finally {
		await orch.shutdown();
	}
}, 30_000);
