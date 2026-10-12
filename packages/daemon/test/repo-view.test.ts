import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import { EventBus } from "@mfw/db/eventlog";
import { ulid } from "@mfw/db/ids";
import { mergeJobs } from "@mfw/db/schema";
import { git, gitOk } from "../src/git.ts";
import {
	InvalidRefError,
	parseDecorations,
	parseNumstat,
	RepoViewService,
	validateRefName,
	validateRepoPath,
} from "../src/repo-view.ts";
import { RunRegistry } from "../src/run-registry.ts";
import { NotFoundError, PathEscapeError } from "../src/workspace.ts";

/**
 * A real temp repo: a feature branch with a rename, a binary file and an
 * edit; a merge commit on main; a run worktree that is dirty; a wip archive;
 * a remote-tracking ref. Nothing here touches a real project.
 */

let parent: string;
let root: string;
let handle: ProjectDbHandle;
let svc: RepoViewService;
let runId: string;
let wipRunId: string;
let featureSha: string;
let renameSha: string;
let renameParent: string;
let mainSha: string;
let mergeSha: string;
let wtPath: string;

const TWENTY = `${Array.from({ length: 20 }, (_, i) => `export const v${i} = ${i};`).join("\n")}\n`;

async function commitAll(msg: string, cwd = root) {
	await gitOk(["add", "-A"], cwd);
	await gitOk(["commit", "-qm", msg], cwd);
	return gitOk(["rev-parse", "HEAD"], cwd);
}

beforeAll(async () => {
	parent = await mkdtemp(join(tmpdir(), "mfw-repo-"));
	root = join(parent, "repo");
	await mkdir(join(root, "src"), { recursive: true });
	await writeFile(join(parent, "outside.txt"), "SECRET\n");
	await writeFile(join(root, ".gitignore"), ".mfw/\nworktrees/\n");
	await writeFile(join(root, "README.md"), "# hello\n");
	await writeFile(join(root, "src", "old.ts"), TWENTY);
	await git(["init", "-q", "-b", "main"], root);
	await git(["config", "user.email", "t@example.com"], root);
	await git(["config", "user.name", "Tess Tester"], root);
	renameParent = await commitAll("init");

	// A feature branch: rename + edit, a binary file, an edit of README.
	await gitOk(["checkout", "-q", "-b", "feature/MFW-7-thing"], root);
	await gitOk(["mv", "src/old.ts", "src/new.ts"], root);
	await writeFile(
		join(root, "src", "new.ts"),
		`${TWENTY}export const extra = 1;\n`,
	);
	await writeFile(join(root, "logo.bin"), Buffer.from([0, 1, 2, 3, 0, 255]));
	renameSha = await commitAll("MFW-7: rename old to new, add logo");
	await writeFile(join(root, "README.md"), "# hello\nmore\n");
	featureSha = await commitAll("tweak readme");

	// main moves on, then merges the feature: a real merge commit.
	await gitOk(["checkout", "-q", "main"], root);
	await writeFile(join(root, "NOTES.md"), "notes\n");
	await commitAll("notes on main");
	await gitOk(
		[
			"merge",
			"--no-ff",
			"-q",
			"-m",
			"Merge feature MFW-7",
			"feature/MFW-7-thing",
		],
		root,
	);
	mergeSha = await gitOk(["rev-parse", "HEAD"], root);
	await writeFile(join(root, "after.md"), "after\n");
	mainSha = await commitAll("after the merge");

	// An unmerged mfw run branch with its own worktree, left dirty.
	runId = ulid();
	await mkdir(join(root, "worktrees"), { recursive: true });
	wtPath = join(root, "worktrees", runId);
	await gitOk(
		["worktree", "add", "-q", "-b", `mfw/${runId}`, wtPath, "main"],
		root,
	);
	await writeFile(join(wtPath, "work.txt"), "committed work\n");
	await commitAll("work in the run", wtPath);
	await writeFile(join(wtPath, "README.md"), "# hello\nedited in worktree\n");
	await writeFile(join(wtPath, "untracked.txt"), "u\n");

	// A wip archive for another (finished) run, a remote-tracking ref, a tag.
	wipRunId = ulid();
	await gitOk(["branch", `wip/MFW-9-${wipRunId}`, featureSha], root);
	await gitOk(
		["update-ref", "refs/remotes/origin/feature/MFW-7-thing", featureSha],
		root,
	);
	await gitOk(["tag", "v1", "main~1"], root);

	handle = await openProjectDb(join(root, ".mfw"));
	const registry = new RunRegistry({
		handle,
		bus: new EventBus(),
		runsDir: join(root, ".mfw", "runs"),
	});
	await registry.create({
		id: runId,
		kind: "task",
		taskId: "MFW-8",
		label: "MFW-8",
		model: "sonnet",
		cwd: wtPath,
		worktreePath: wtPath,
		branch: `mfw/${runId}`,
	});
	await registry.create({
		id: wipRunId,
		kind: "task",
		taskId: "MFW-9",
		label: "MFW-9",
		model: "sonnet",
		cwd: root,
	});
	await handle.db.insert(mergeJobs).values({
		runId,
		taskId: "MFW-8",
		branch: `mfw/${runId}`,
		targetBranch: "main",
		state: "parked",
		error: "conflict",
		enqueuedAt: new Date(),
		updatedAt: new Date(),
	});
	svc = new RepoViewService({
		root,
		integrationBranch: "main",
		registry,
		handle,
	});
});

afterAll(async () => {
	handle?.close();
	await rm(parent, { recursive: true, force: true });
});

describe("ref and path validation", () => {
	test("rejects option-shaped, control-char and range refs", () => {
		for (const bad of [
			"--upload-pack=touch /tmp/x",
			"-n",
			"-",
			"main\n--output=/tmp/x",
			"a\0b",
			"a b",
			"a..b",
			"main^",
			"main~1",
			"HEAD@{1}",
			"x:y",
			"$(id)",
			"a;b",
			"",
			"/abs",
			"trail/",
			"x.lock",
			".hidden/x",
		]) {
			expect(() => validateRefName(bad)).toThrow(InvalidRefError);
		}
		for (const ok of [
			"main",
			"origin/main",
			"feature/MFW-7-thing",
			"v1.2.3",
			"HEAD",
			"a".repeat(40),
		]) {
			expect(validateRefName(ok)).toBe(ok);
		}
	});

	test("paths: no traversal, no control characters", () => {
		expect(validateRepoPath("src/a.ts")).toBe("src/a.ts");
		expect(validateRepoPath("/src/")).toBe("src");
		expect(validateRepoPath("")).toBe("");
		for (const bad of ["../x", "a/../b", "a/./b", "a\nb", "a//b", "a\0b"]) {
			expect(() => validateRepoPath(bad)).toThrow(InvalidRefError);
		}
	});

	test("every entry point refuses an injected ref before running git", async () => {
		const evil = "--output=/tmp/mfw-pwned";
		const calls = [
			() => svc.commits({ ref: evil }),
			() => svc.commits({ ref: "main", exclude: evil }),
			() => svc.commit({ sha: evil }),
			() => svc.compare({ a: "main", b: evil }),
			() => svc.fileDiff({ to: evil, path: "README.md" }),
			() => svc.tree({ ref: evil }),
			() => svc.blob({ ref: evil, path: "README.md" }),
			() => svc.commits({ ref: "main", search: "a\nb" }),
			() => svc.commits({ ref: "main", cursor: "-5" }),
			() => svc.commits({ ref: "main", path: "../etc" }),
		];
		for (const call of calls) {
			expect(await call().catch((e: Error) => e)).toBeInstanceOf(
				InvalidRefError,
			);
		}
		expect(await Bun.file("/tmp/mfw-pwned").exists()).toBe(false);
	});

	test("an unknown but well-formed ref is NOT_FOUND, not a git error", async () => {
		expect(
			await svc.commit({ sha: "no-such-branch" }).catch((e: Error) => e),
		).toBeInstanceOf(NotFoundError);
	});
});

describe("parsers", () => {
	test("numstat handles binary, plain and rename records", () => {
		const m = parseNumstat(
			"1\t2\ta.ts\0-\t-\tlogo.bin\0" + "3\t0\t\0old.ts\0new.ts\0",
		);
		expect(m.get("a.ts")).toEqual({ added: 1, deleted: 2 });
		expect(m.get("logo.bin")).toEqual({ added: null, deleted: null });
		expect(m.get("new.ts")).toEqual({ added: 3, deleted: 0 });
	});

	test("decorations", () => {
		expect(
			parseDecorations(
				"HEAD -> refs/heads/main, tag: refs/tags/v1, refs/remotes/origin/main, refs/remotes/origin/HEAD, refs/heads/mfw/x",
			),
		).toEqual([
			{ name: "HEAD", kind: "head" },
			{ name: "main", kind: "local" },
			{ name: "v1", kind: "tag" },
			{ name: "origin/main", kind: "remote" },
			{ name: "mfw/x", kind: "local" },
		]);
	});
});

describe("branches", () => {
	test("local and remote branches with ahead/behind against main", async () => {
		const { branches, integrationBranch } = await svc.branches();
		expect(integrationBranch).toBe("main");
		const by = new Map(branches.map((b) => [`${b.kind}:${b.name}`, b]));

		const main = by.get("local:main");
		expect(main).toMatchObject({
			isIntegration: true,
			isHead: true,
			ahead: 0,
			behind: 0,
			merged: true,
		});
		expect(main?.lastCommit).toMatchObject({
			author: "Tess Tester",
			subject: "after the merge",
		});

		const feature = by.get("local:feature/MFW-7-thing");
		expect(feature).toMatchObject({ merged: true, ahead: 0, mfw: null });
		expect(feature?.behind).toBeGreaterThan(0);

		const remote = by.get("remote:origin/feature/MFW-7-thing");
		expect(remote?.kind).toBe("remote");
		expect(remote?.sha).toBe(featureSha);
	});

	test("mfw run and wip branches are joined to their run, task and merge job", async () => {
		const { branches } = await svc.branches();
		const run = branches.find((b) => b.name === `mfw/${runId}`);
		expect(run).toMatchObject({
			mfw: "run",
			ahead: 1,
			merged: false,
			worktreeId: runId,
		});
		expect(run?.run).toMatchObject({ runId, taskId: "MFW-8", live: true });
		expect(run?.mergeJob).toMatchObject({ state: "parked", error: "conflict" });

		const wip = branches.find((b) => b.name === `wip/MFW-9-${wipRunId}`);
		expect(wip).toMatchObject({ mfw: "wip" });
		expect(wip?.run?.taskId).toBe("MFW-9");
	});

	test("refs and summary", async () => {
		const refs = await svc.refs();
		expect(refs.head.branch).toBe("main");
		expect(refs.tags.map((t) => t.name)).toContain("v1");
		const s = await svc.summary();
		expect(s).toMatchObject({
			branches: 4, // main, feature, mfw/<run>, wip/...
			remoteBranches: 1,
			mfwBranches: 1,
			wipBranches: 1,
			tags: 1,
			worktrees: 2,
		});
	});
});

describe("worktrees", () => {
	test("primary plus the run worktree, joined to the run, dirty and ahead", async () => {
		const { worktrees } = await svc.worktrees();
		expect(worktrees).toHaveLength(2);
		const primary = worktrees.find((w) => w.primary);
		expect(primary).toMatchObject({
			id: "root",
			branch: "main",
			displayPath: ".",
			exists: true,
		});
		// worktrees/ is ignored, so the primary checkout is clean.
		expect(primary?.dirty?.changed).toBe(0);

		const wt = worktrees.find((w) => w.id === runId);
		expect(wt).toMatchObject({
			branch: `mfw/${runId}`,
			displayPath: `worktrees/${runId}`,
			ahead: 1,
			behind: 0,
		});
		expect(wt?.run).toMatchObject({ taskId: "MFW-8", live: true });
		expect(wt?.mergeJob?.state).toBe("parked");
		expect(wt?.dirty?.changed).toBe(2); // README edit + untracked.txt
	});

	test("uncommitted changes: modified file, untracked listing, line counts", async () => {
		const r = await svc.worktreeChanges({ id: runId });
		expect(r.branch).toBe(`mfw/${runId}`);
		const readme = r.files.find((f) => f.path === "README.md");
		expect(readme).toMatchObject({ worktree: "M", added: 1, deleted: 1 });
		const un = r.files.find((f) => f.path === "untracked.txt");
		expect(un).toMatchObject({ untracked: true, added: null });

		const d = await svc.worktreeFileDiff({ id: runId, path: "README.md" });
		expect(d).toMatchObject({ status: "modified", binary: false });
		expect(d.newText).toContain("edited in worktree");
		expect(d.oldText).toBe("# hello\nmore\n");

		const u = await svc.worktreeFileDiff({ id: runId, path: "untracked.txt" });
		expect(u).toMatchObject({ status: "added", newText: "u\n" });
	});

	test("oversize files are summarised, not shipped", async () => {
		const big = join(wtPath, "big.txt");
		await writeFile(big, "x\n".repeat(400_000));
		const d = await svc.worktreeFileDiff({ id: runId, path: "big.txt" });
		expect(d).toMatchObject({ binary: true, reason: "oversize", newText: "" });
		await rm(big);
	});

	test("an unknown worktree id is NOT_FOUND; a symlink out of the tree is refused", async () => {
		expect(
			await svc.worktreeChanges({ id: "nope" }).catch((e: Error) => e),
		).toBeInstanceOf(NotFoundError);
		await symlink(join(parent, "outside.txt"), join(wtPath, "leak.txt"));
		expect(
			await svc
				.worktreeFileDiff({ id: runId, path: "leak.txt" })
				.catch((e: Error) => e),
		).toBeInstanceOf(PathEscapeError);
		await rm(join(wtPath, "leak.txt"));
	});
});

describe("commits", () => {
	test("log is paged by cursor, newest first, with refs and task ids", async () => {
		const p1 = await svc.commits({ ref: "main", limit: 3 });
		expect(p1.commits).toHaveLength(3);
		expect(p1.commits[0]).toMatchObject({
			sha: mainSha,
			subject: "after the merge",
			author: "Tess Tester",
		});
		expect(p1.commits[0]?.refs).toContainEqual({ name: "main", kind: "local" });
		expect(p1.nextCursor).toBe("3");

		const p2 = await svc.commits({
			ref: "main",
			limit: 3,
			cursor: p1.nextCursor ?? undefined,
		});
		const all = await svc.commits({ ref: "main", limit: 200 });
		expect([...p1.commits, ...p2.commits].map((c) => c.sha)).toEqual(
			all.commits.slice(0, 6).map((c) => c.sha),
		);
		expect(all.nextCursor).toBeNull();

		const merge = all.commits.find((c) => c.sha === mergeSha);
		expect(merge?.parents).toHaveLength(2);
		expect(merge?.taskIds).toEqual(["MFW-7"]);
	});

	test("exclude gives a branch's own commits; search and path narrow", async () => {
		const own = await svc.commits({ ref: `mfw/${runId}`, exclude: "main" });
		expect(own.commits.map((c) => c.subject)).toEqual(["work in the run"]);

		const hit = await svc.commits({ ref: "main", search: "notes" });
		expect(hit.commits.map((c) => c.subject)).toEqual(["notes on main"]);

		const byPath = await svc.commits({ ref: "main", path: "NOTES.md" });
		expect(byPath.commits).toHaveLength(1);
	});

	test("commit detail: rename detection, binary stat, merge diffs against first parent", async () => {
		const r = await svc.commit({ sha: renameSha });
		expect(r.taskIds).toContain("MFW-7");
		expect(r.message).toContain("rename old to new");
		const renamed = r.diff.files.find((f) => f.path === "src/new.ts");
		expect(renamed).toMatchObject({
			status: "renamed",
			oldPath: "src/old.ts",
			added: 1,
			deleted: 0,
		});
		expect(renamed?.similarity).toBeGreaterThan(80);
		const bin = r.diff.files.find((f) => f.path === "logo.bin");
		expect(bin).toMatchObject({ status: "added", binary: true, added: null });

		const m = await svc.commit({ sha: mergeSha });
		expect(m.isMerge).toBe(true);
		expect(m.base).toBe(m.parents[0] ?? null);
		// Against the main-side parent, the merge brought the whole feature.
		expect(m.diff.files.map((f) => f.path).sort()).toEqual([
			"README.md",
			"logo.bin",
			"src/new.ts",
		]);

		// A root commit diffs against the empty tree.
		const rc = await svc.commit({ sha: renameParent });
		expect(rc.parents).toEqual([]);
		expect(rc.diff.files.map((f) => f.path)).toContain("README.md");
	});
});

describe("file diffs, compare, trees", () => {
	test("fileDiff returns both sides; binary is flagged and not shipped", async () => {
		const text = await svc.fileDiff({
			from: renameParent,
			to: renameSha,
			path: "src/new.ts",
			oldPath: "src/old.ts",
		});
		expect(text).toMatchObject({ status: "renamed", binary: false });
		expect(text.newText).toContain("extra");
		expect(text.oldText).not.toContain("extra");

		const bin = await svc.fileDiff({
			from: renameParent,
			to: renameSha,
			path: "logo.bin",
		});
		expect(bin).toMatchObject({
			status: "added",
			binary: true,
			reason: "binary",
			newText: "",
		});

		const readme = await svc.fileDiff({
			from: renameSha,
			to: featureSha,
			path: "README.md",
		});
		expect(readme.status).toBe("modified");

		expect(
			await svc
				.fileDiff({ from: renameSha, to: featureSha, path: "missing.txt" })
				.catch((e: Error) => e),
		).toBeInstanceOf(NotFoundError);
	});

	test("compare is three-dot by default: only what the branch brought", async () => {
		// main has merged the feature, so nothing is ahead.
		const c = await svc.compare({ a: "main", b: "feature/MFW-7-thing" });
		expect(c.mode).toBe("three-dot");
		expect(c.ahead).toBe(0);
		expect(c.behind).toBeGreaterThan(0);
		expect(c.diff.files).toEqual([]);

		const run = await svc.compare({ a: "main", b: `mfw/${runId}` });
		expect(run.ahead).toBe(1);
		expect(run.behind).toBe(0);
		expect(run.diff.files.map((f) => f.path)).toEqual(["work.txt"]);
		expect(run.commits.map((x) => x.subject)).toEqual(["work in the run"]);
		expect(run.mergeBase).toBe(mainSha);

		// Two-dot compares the tips: main added NOTES.md since the feature forked.
		const two = await svc.compare({
			a: "feature/MFW-7-thing",
			b: "main",
			mode: "two-dot",
		});
		expect(two.mode).toBe("two-dot");
		expect(two.diff.files.map((f) => f.path)).toContain("NOTES.md");

		// Three-dot from the feature's side shows only what main brought since the fork.
		const three = await svc.compare({ a: "feature/MFW-7-thing", b: "main" });
		expect(three.base).toBe(featureSha);
		expect(three.diff.files.map((f) => f.path)).not.toContain("README.md");
		expect(three.diff.files.map((f) => f.path)).toContain("NOTES.md");
	});

	test("tree and blob read any ref, not the working copy", async () => {
		const top = await svc.tree({ ref: "feature/MFW-7-thing" });
		expect(top.entries.find((e) => e.name === "src")?.kind).toBe("dir");
		// Directories sort first.
		expect(top.entries[0]?.kind).toBe("dir");
		expect(top.entries.find((e) => e.name === "NOTES.md")).toBeUndefined();

		const src = await svc.tree({ ref: "feature/MFW-7-thing", path: "src" });
		expect(src.entries.map((e) => e.path)).toEqual(["src/new.ts"]);

		const file = await svc.blob({
			ref: "feature/MFW-7-thing",
			path: "src/new.ts",
		});
		expect(file.text).toContain("extra");
		expect(file.binary).toBe(false);

		const bin = await svc.blob({
			ref: "feature/MFW-7-thing",
			path: "logo.bin",
		});
		expect(bin).toMatchObject({ binary: true, text: "" });

		expect(
			await svc
				.blob({ ref: "feature/MFW-7-thing", path: "src/old.ts" })
				.catch((e: Error) => e),
		).toBeInstanceOf(NotFoundError);
		expect(
			await svc.tree({ ref: "main", path: "README.md" }).catch((e: Error) => e),
		).toBeInstanceOf(NotFoundError);
		expect(
			await svc.blob({ ref: "main", path: "src" }).catch((e: Error) => e),
		).toBeInstanceOf(NotFoundError);
	});

	test("blobBytes serves intact image bytes at a ref, nothing else", async () => {
		const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255, 0, 10, 13]);
		const tmp = join(parent, "imgwt");
		await gitOk(["worktree", "add", "-q", "-b", "img-test", tmp, "main"], root);
		await writeFile(join(tmp, "pic.png"), PNG);
		await writeFile(join(tmp, "big.png"), Buffer.alloc(5 * 1024 * 1024 + 1));
		await symlink("pic.png", join(tmp, "link.png"));
		await commitAll("add images", tmp);
		await gitOk(["worktree", "remove", "--force", tmp], root);
		try {
			const ok = await svc.blobBytes({ ref: "img-test", path: "pic.png" });
			expect(ok.mime).toBe("image/png");
			expect(ok.size).toBe(PNG.length);
			expect(Buffer.compare(ok.data, PNG)).toBe(0);
			// Pinned to the ref: main has no such file.
			for (const [ref, path] of [
				["main", "pic.png"],
				["img-test", "README.md"],
				["img-test", "src"],
				["img-test", "big.png"],
				["img-test", "link.png"],
			] as const) {
				expect(
					await svc.blobBytes({ ref, path }).catch((e: Error) => e),
				).toBeInstanceOf(NotFoundError);
			}
			for (const [ref, path] of [
				["img-test", "../pic.png"],
				["img-test", ""],
				["--upload-pack=x", "pic.png"],
			] as const) {
				expect(
					await svc.blobBytes({ ref, path }).catch((e: Error) => e),
				).toBeInstanceOf(InvalidRefError);
			}
		} finally {
			await gitOk(["branch", "-D", "img-test"], root);
		}
	});

	test("never writes: HEAD and the primary checkout are unchanged by all of the above", async () => {
		expect(await gitOk(["rev-parse", "HEAD"], root)).toBe(mainSha);
		expect(await gitOk(["status", "--porcelain"], root)).toBe("");
	});
});
