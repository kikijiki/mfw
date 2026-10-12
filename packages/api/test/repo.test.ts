import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, gitOk } from "@mfw/daemon/git";
import { RepoViewService } from "@mfw/daemon/repo-view";
import { RunRegistry } from "@mfw/daemon/run-registry";
import type { Orchestrator, ProjectServices } from "@mfw/daemon/services";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import { EventBus } from "@mfw/db/eventlog";
import { createCaller } from "../src/root.ts";

/** The repo router over a real service and a real temp repo. */

let dir: string;
let handle: ProjectDbHandle;
let api: ReturnType<typeof createCaller>;
let sha: string;

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "mfw-api-repo-"));
	await git(["init", "-q", "-b", "main"], dir);
	await git(["config", "user.email", "t@example.com"], dir);
	await git(["config", "user.name", "T"], dir);
	await writeFile(join(dir, "a.txt"), "one\n");
	await gitOk(["add", "-A"], dir);
	await gitOk(["commit", "-qm", "MFW-1: first"], dir);
	await writeFile(join(dir, "a.txt"), "one\ntwo\n");
	await gitOk(["commit", "-qam", "second"], dir);
	sha = await gitOk(["rev-parse", "HEAD"], dir);
	handle = await openProjectDb(join(dir, ".mfw"));
	const registry = new RunRegistry({
		handle,
		bus: new EventBus(),
		runsDir: join(dir, ".mfw", "runs"),
	});
	const svc = {
		name: "p",
		repoView: new RepoViewService({
			root: dir,
			integrationBranch: "main",
			registry,
			handle,
		}),
	} as unknown as ProjectServices;
	api = createCaller({
		orchestrator: {
			list: () => [svc],
			get: (n: string) => {
				if (n !== "p") throw new Error("unknown");
				return svc;
			},
		} as unknown as Orchestrator,
	});
});

afterAll(async () => {
	handle.close();
	await rm(dir, { recursive: true, force: true });
});

describe("repo router", () => {
	test("summary, branches and worktrees have the shapes the screen reads", async () => {
		const s = await api.repo.summary({ project: "p" });
		expect(s).toMatchObject({
			integrationBranch: "main",
			branches: 1,
			worktrees: 1,
		});
		const b = await api.repo.branches({ project: "p" });
		expect(b.branches[0]).toMatchObject({
			name: "main",
			kind: "local",
			isIntegration: true,
			sha,
		});
		const w = await api.repo.worktrees({ project: "p" });
		expect(w.worktrees[0]).toMatchObject({ id: "root", primary: true });
	});

	test("commits, commit, diffFile and compare", async () => {
		const log = await api.repo.commits({ project: "p", ref: "main" });
		expect(log.commits.map((c) => c.subject)).toEqual([
			"second",
			"MFW-1: first",
		]);
		expect(log.commits[1]?.taskIds).toEqual(["MFW-1"]);

		const c = await api.repo.commit({ project: "p", sha });
		expect(c.diff.files).toMatchObject([
			{ path: "a.txt", status: "modified", added: 1, deleted: 0 },
		]);
		const d = await api.repo.diffFile({
			project: "p",
			from: c.base ?? undefined,
			to: sha,
			path: "a.txt",
		});
		expect(d.newText).toBe("one\ntwo\n");

		const cmp = await api.repo.compare({
			project: "p",
			a: c.base as string,
			b: "main",
		});
		expect(cmp).toMatchObject({ mode: "three-dot", ahead: 1, behind: 0 });
	});

	test("a hostile ref is BAD_REQUEST, an unknown one NOT_FOUND", async () => {
		const bad = await api.repo
			.commits({ project: "p", ref: "--output=/tmp/x" })
			.catch((e: { code: string }) => e);
		expect(bad).toMatchObject({ code: "BAD_REQUEST" });
		const missing = await api.repo
			.commit({ project: "p", sha: "nope" })
			.catch((e: { code: string }) => e);
		expect(missing).toMatchObject({ code: "NOT_FOUND" });
		const tree = await api.repo
			.tree({ project: "p", ref: "main", path: "../x" })
			.catch((e: { code: string }) => e);
		expect(tree).toMatchObject({ code: "BAD_REQUEST" });
	});
});
