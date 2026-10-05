import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import { EventBus } from "@mfw/db/eventlog";
import { git } from "../src/git.ts";
import { RunRegistry } from "../src/run-registry.ts";
import {
	NotFoundError,
	PathEscapeError,
	WorkspaceService,
} from "../src/workspace.ts";

/**
 * Real temp git repo, symlinks and worktree directory. Containment (`..` and
 * symlinks out of the tree) is asserted against the filesystem, not a mock.
 */

interface Env {
	/** Holds the repo; the "outside" the tests try to reach. */
	parent: string;
	root: string;
	handle: ProjectDbHandle;
	registry: RunRegistry;
	ws: WorkspaceService;
}

const envs: Env[] = [];

async function freshEnv(): Promise<Env> {
	const parent = await mkdtemp(join(tmpdir(), "mfw-ws-"));
	const root = join(parent, "repo");
	await mkdir(join(root, "src"), { recursive: true });
	await writeFile(join(parent, "outside-secret.txt"), "SECRET\n");
	await writeFile(join(root, "README.md"), "# hello\n");
	await writeFile(join(root, "src", "index.ts"), "export const x = 1;\n");
	// Keep mfw runtime files out of `gitStatus` assertions.
	await writeFile(join(root, ".gitignore"), ".mfw/\nworktrees/\n");

	await git(["init", "-q"], root);
	await git(["config", "user.email", "t@example.com"], root);
	await git(["config", "user.name", "t"], root);
	await git(["add", "-A"], root);
	await git(["commit", "-qm", "init"], root);

	const handle = await openProjectDb(join(root, ".mfw"));
	const registry = new RunRegistry({
		handle,
		bus: new EventBus(),
		runsDir: join(root, ".mfw", "runs"),
	});
	const env: Env = {
		parent,
		root,
		handle,
		registry,
		ws: new WorkspaceService({ root, registry }),
	};
	envs.push(env);
	return env;
}

afterEach(async () => {
	for (const env of envs.splice(0)) {
		env.handle.close();
		await rm(env.parent, { recursive: true, force: true });
	}
});

describe("containment", () => {
	test("`..` traversal out of the root is refused", async () => {
		const env = await freshEnv();
		// The target exists, so a NotFound cannot mask a missing containment check.
		expect(
			await env.ws
				.readFile({ path: "../outside-secret.txt" })
				.catch((e: Error) => e),
		).toBeInstanceOf(PathEscapeError);
		expect(
			await env.ws
				.readFile({ path: "src/../../outside-secret.txt" })
				.catch((e: Error) => e),
		).toBeInstanceOf(PathEscapeError);
		expect(
			await env.ws.listDir({ path: ".." }).catch((e: Error) => e),
		).toBeInstanceOf(PathEscapeError);

		// Absolute paths are root-relative.
		expect(
			await env.ws.readFile({ path: "/etc/passwd" }).catch((e: Error) => e),
		).toBeInstanceOf(NotFoundError);
	});

	test("a SYMLINK out of the tree is refused, and never followed when listing", async () => {
		const env = await freshEnv();
		// The shape an agent can commit: a link to /etc inside the repo.
		await symlink("/etc", join(env.root, "etc-link"));
		await symlink(
			join(env.parent, "outside-secret.txt"),
			join(env.root, "secret-link"),
		);

		// A lexical startsWith check would have opened /etc/hostname here.
		expect(
			await env.ws
				.readFile({ path: "etc-link/hostname" })
				.catch((e: Error) => e),
		).toBeInstanceOf(PathEscapeError);
		expect(
			await env.ws.readFile({ path: "secret-link" }).catch((e: Error) => e),
		).toBeInstanceOf(PathEscapeError);
		expect(
			await env.ws.listDir({ path: "etc-link" }).catch((e: Error) => e),
		).toBeInstanceOf(PathEscapeError);

		// Listing reports links as flagged symlinks, with no stat through them.
		const listing = await env.ws.listDir({});
		const etcLink = listing.entries.find((e) => e.name === "etc-link");
		expect(etcLink).toMatchObject({
			kind: "symlink",
			escapes: true,
			size: null,
		});
		expect(listing.entries.find((e) => e.name === "secret-link")).toMatchObject(
			{ kind: "symlink", escapes: true },
		);

		// Internal symlinks are not flagged.
		await symlink(join(env.root, "README.md"), join(env.root, "readme-link"));
		const again = await env.ws.listDir({});
		expect(again.entries.find((e) => e.name === "readme-link")).toMatchObject({
			kind: "symlink",
			escapes: false,
		});
		expect((await env.ws.readFile({ path: "readme-link" })).text).toBe(
			"# hello\n",
		);
	});

	test("a run's worktree is its own root: `..` cannot climb back to the repo", async () => {
		const env = await freshEnv();
		const worktree = join(env.root, "worktrees", "run-1");
		await mkdir(worktree, { recursive: true });
		await writeFile(join(worktree, "work.txt"), "wip\n");
		const run = await env.registry.create({
			kind: "task",
			label: "MFW-1",
			model: "sonnet",
			cwd: worktree,
			worktreePath: worktree,
		});

		const listing = await env.ws.listDir({ runId: run.id });
		expect(listing.base).toBe(run.id);
		expect(listing.entries.map((e) => e.name)).toEqual(["work.txt"]);
		expect(
			(await env.ws.readFile({ path: "work.txt", runId: run.id })).text,
		).toBe("wip\n");

		expect(
			await env.ws
				.readFile({ path: "../../README.md", runId: run.id })
				.catch((e: Error) => e),
		).toBeInstanceOf(PathEscapeError);
		expect(
			await env.ws
				.listDir({ path: "..", runId: run.id })
				.catch((e: Error) => e),
		).toBeInstanceOf(PathEscapeError);

		// No worktree or unknown run: NOT_FOUND, not a fallback to the root.
		const bare = await env.registry.create({
			kind: "action",
			label: "bare",
			model: "sonnet",
			cwd: env.root,
		});
		expect(
			await env.ws.listDir({ runId: bare.id }).catch((e: Error) => e),
		).toBeInstanceOf(NotFoundError);
		expect(
			await env.ws.listDir({ runId: "nope" }).catch((e: Error) => e),
		).toBeInstanceOf(NotFoundError);
	});
});

describe("worktrees", () => {
	test("lists runs whose worktree still exists on disk, newest first", async () => {
		const env = await freshEnv();

		const older = await env.registry.create({
			kind: "task",
			taskId: "MFW-1",
			label: "MFW-1",
			model: "sonnet",
			cwd: env.root,
		});
		const olderDir = join(env.root, "worktrees", older.id);
		await mkdir(olderDir, { recursive: true });
		await env.registry.transition(older.id, "running", {
			worktreePath: olderDir,
			branch: `mfw/${older.id}`,
		});

		const newer = await env.registry.create({
			kind: "task",
			taskId: "MFW-2",
			label: "MFW-2",
			model: "sonnet",
			cwd: env.root,
		});
		const newerDir = join(env.root, "worktrees", newer.id);
		await mkdir(newerDir, { recursive: true });
		await env.registry.transition(newer.id, "running", {
			worktreePath: newerDir,
			branch: `mfw/${newer.id}`,
		});

		// Never left "starting" (no worktree): must not appear.
		await env.registry.create({
			kind: "action",
			label: "bare",
			model: "sonnet",
			cwd: env.root,
		});

		const bases = await env.ws.worktrees();
		expect(bases.map((b) => b.runId)).toEqual([newer.id, older.id]);
		expect(bases[0]).toMatchObject({
			runId: newer.id,
			taskId: "MFW-2",
			branch: `mfw/${newer.id}`,
			path: newerDir,
			state: "running",
		});
	});

	test("a run whose worktree directory was since cleaned up drops out", async () => {
		const env = await freshEnv();
		const run = await env.registry.create({
			kind: "task",
			taskId: "MFW-1",
			label: "MFW-1",
			model: "sonnet",
			cwd: env.root,
		});
		const dir = join(env.root, "worktrees", run.id);
		await mkdir(dir, { recursive: true });
		await env.registry.transition(run.id, "running", {
			worktreePath: dir,
			branch: `mfw/${run.id}`,
		});

		expect((await env.ws.worktrees()).map((b) => b.runId)).toEqual([run.id]);

		// The row keeps its worktreePath after cleanup; the picker follows the disk.
		await rm(dir, { recursive: true, force: true });
		await env.registry.transition(run.id, "completed");

		expect(await env.ws.worktrees()).toEqual([]);
	});
});

describe("reads", () => {
	test("caps size and refuses binaries with a marker", async () => {
		const env = await freshEnv();
		await writeFile(join(env.root, "big.txt"), "x".repeat(5000));
		await writeFile(
			join(env.root, "blob.bin"),
			new Uint8Array([0x89, 0x50, 0x00, 0x01, 0x02]),
		);

		const capped = await env.ws.readFile({ path: "big.txt", maxBytes: 100 });
		expect(capped.truncated).toBe(true);
		expect(capped.size).toBe(5000);
		expect(capped.bytes).toBe(100);
		expect(capped.text.length).toBe(100);
		expect(capped.marker).toContain("truncated");

		const binary = await env.ws.readFile({ path: "blob.bin" });
		expect(binary.binary).toBe(true);
		expect(binary.text).toBe("");
		expect(binary.marker).toContain("binary");

		const whole = await env.ws.readFile({ path: "README.md" });
		expect(whole).toMatchObject({
			text: "# hello\n",
			truncated: false,
			binary: false,
			marker: null,
		});

		expect(
			await env.ws.readFile({ path: "src" }).catch((e: Error) => e),
		).toBeInstanceOf(NotFoundError);
		expect(
			await env.ws.readFile({ path: "nope.txt" }).catch((e: Error) => e),
		).toBeInstanceOf(NotFoundError);
	});

	test("listDir sorts dirs first and paths are root-relative", async () => {
		const env = await freshEnv();
		const listing = await env.ws.listDir({});
		expect(listing.base).toBe("root");
		expect(listing.path).toBe("");
		expect(listing.entries[0]?.kind).toBe("dir");
		expect(listing.entries.find((e) => e.name === "README.md")).toMatchObject({
			kind: "file",
			path: "README.md",
		});

		const sub = await env.ws.listDir({ path: "src" });
		expect(sub.path).toBe("src");
		expect(sub.entries.map((e) => e.path)).toEqual(["src/index.ts"]);
	});
});

describe("gitStatus", () => {
	test("reports the branch and the porcelain codes", async () => {
		const env = await freshEnv();
		const clean = await env.ws.gitStatus({});
		expect(clean.clean).toBe(true);
		expect(clean.branch).toBeTruthy();
		expect(clean.files).toEqual([]);

		await writeFile(join(env.root, "README.md"), "# changed\n");
		await writeFile(join(env.root, "new.txt"), "new\n");
		const dirty = await env.ws.gitStatus({});
		expect(dirty.clean).toBe(false);
		expect(dirty.files.find((f) => f.path === "README.md")).toMatchObject({
			worktree: "M",
		});
		expect(dirty.files.find((f) => f.path === "new.txt")).toMatchObject({
			index: "?",
			worktree: "?",
		});
	});
});

describe("diffFile", () => {
	test("both sides of a modified, an untracked, and a deleted file", async () => {
		const env = await freshEnv();
		await writeFile(join(env.root, "README.md"), "# changed\n");
		await writeFile(join(env.root, "new.txt"), "new\n");
		await rm(join(env.root, "src", "index.ts"));

		const modified = await env.ws.diffFile({ path: "README.md" });
		expect(modified).toMatchObject({
			path: "README.md",
			status: "modified",
			oldText: "# hello\n",
			newText: "# changed\n",
			binary: false,
		});

		const added = await env.ws.diffFile({ path: "new.txt" });
		expect(added).toMatchObject({
			path: "new.txt",
			status: "added",
			oldText: "",
			newText: "new\n",
			binary: false,
		});

		const deleted = await env.ws.diffFile({ path: "src/index.ts" });
		expect(deleted).toMatchObject({
			path: "src/index.ts",
			status: "deleted",
			oldText: "export const x = 1;\n",
			newText: "",
			binary: false,
		});
	});

	test("a rename is diffed against its ORIGINAL content when `fromPath` is given", async () => {
		const env = await freshEnv();
		await git(["mv", "README.md", "GUIDE.md"], env.root);
		await writeFile(join(env.root, "GUIDE.md"), "# hello, renamed\n");

		// Without fromPath the new path is absent at HEAD, so it reads as added.
		const naive = await env.ws.diffFile({ path: "GUIDE.md" });
		expect(naive.status).toBe("added");
		expect(naive.oldText).toBe("");

		const withOrigin = await env.ws.diffFile({
			path: "GUIDE.md",
			fromPath: "README.md",
		});
		expect(withOrigin).toMatchObject({
			path: "GUIDE.md",
			status: "modified",
			oldText: "# hello\n",
			newText: "# hello, renamed\n",
		});
	});

	test("neither tracked at HEAD nor present on disk is NOT_FOUND", async () => {
		const env = await freshEnv();
		expect(
			await env.ws.diffFile({ path: "nope.txt" }).catch((e: Error) => e),
		).toBeInstanceOf(NotFoundError);
	});

	test("a path escaping the base is refused even for an existing file", async () => {
		const env = await freshEnv();
		expect(
			await env.ws
				.diffFile({ path: "../outside-secret.txt" })
				.catch((e: Error) => e),
		).toBeInstanceOf(PathEscapeError);
	});
});
