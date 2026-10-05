import { afterEach, describe, expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitOk } from "../src/git.ts";
import {
	applyRemoteCollection,
	createRemoteCollection,
	createRemoteStage,
	materializeRemoteStage,
	RemoteCollectionConflictError,
	RemoteWorkspaceError,
} from "../src/remote-worktree.ts";
import { WorktreeManager } from "../src/worktree.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "mfw-remote-wt-"));
	roots.push(root);
	await gitOk(["init", "-b", "main"], root);
	await gitOk(["config", "user.name", "test"], root);
	await gitOk(["config", "user.email", "test@example.invalid"], root);
	await mkdir(join(root, ".mfw", "tasks", "backlog"), { recursive: true });
	await mkdir(join(root, ".mfw", "triggers"), { recursive: true });
	await writeFile(join(root, "tracked.txt"), "base\n");
	await writeFile(join(root, ".gitignore"), ".env\n*.cache\n");
	await writeFile(join(root, ".mfw", "AGENTS.md"), "DELIVERED RULES\n");
	await writeFile(
		join(root, ".mfw", "tasks", "backlog", "private.md"),
		"BOARD_CANARY\n",
	);
	await writeFile(join(root, ".mfw", "triggers", "allowed.md"), "trigger\n");
	await gitOk(["add", "-A"], root);
	await gitOk(["commit", "-m", "base"], root);
	const baseSha = await gitOk(["rev-parse", "HEAD"], root);
	const manager = new WorktreeManager(root);
	const worktree = await manager.create("run-97", "main");
	const runDir = join(root, "run-dir");
	await mkdir(runDir, { recursive: true });
	return { root, baseSha, worktree, runDir };
}

describe("remote worktree staging and collection", () => {
	test("stages a fresh protected mirror from a clean shell and collects repeatably", async () => {
		const { root, baseSha, worktree, runDir } = await fixture();
		const secret = "MFW97_SECRET_CANARY_4x9";
		await writeFile(join(worktree.path, "tracked.txt"), "canonical edit\n");
		await writeFile(join(worktree.path, "untracked.txt"), "payload\n");
		await writeFile(join(worktree.path, ".env"), `${secret}\n`);

		const stage = await createRemoteStage({
			canonicalPath: worktree.path,
			runDir,
			branch: worktree.branch,
			baseSha,
		});
		const stageRaw = await readFile(stage.stagePath, "utf8");
		expect(stageRaw).not.toContain(secret);
		expect(stageRaw).not.toContain("BOARD_CANARY");
		expect(stageRaw).toContain(".mfw/AGENTS.md");
		const stagedPayload = JSON.parse(stageRaw) as {
			baseline: { content: string }[];
			snapshot: { content: string }[];
		};
		const decodedPayload = [
			...stagedPayload.baseline,
			...stagedPayload.snapshot,
		]
			.map((entry) => Buffer.from(entry.content, "base64").toString("utf8"))
			.join("\n");
		expect(decodedPayload).not.toContain(secret);
		expect(decodedPayload).not.toContain("BOARD_CANARY");
		expect(decodedPayload).toContain("DELIVERED RULES");

		const remote = join(root, "remote");
		process.env.MFW97_AMBIENT_CANARY = "must-not-inherit";
		try {
			await materializeRemoteStage({
				stagePath: stage.stagePath,
				executionPath: remote,
				gitPath: Bun.which("git") as string,
				setup: {
					argv: [
						Bun.which("sh") as string,
						"-c",
						'test -z "$MFW97_AMBIENT_CANARY" && test ! -e "$HOME/.profile"',
					],
				},
			});
		} finally {
			delete process.env.MFW97_AMBIENT_CANARY;
		}
		expect(await readFile(join(remote, "tracked.txt"), "utf8")).toBe(
			"canonical edit\n",
		);
		expect(await readFile(join(remote, ".mfw", "AGENTS.md"), "utf8")).toBe(
			"DELIVERED RULES\n",
		);
		await expect(
			readFile(join(remote, ".mfw", "tasks", "backlog", "private.md")),
		).rejects.toThrow();
		expect(await gitOk(["status", "--porcelain"], remote)).toBe("");

		await writeFile(join(remote, "tracked.txt"), "remote edit\n");
		await writeFile(join(remote, "remote-only.txt"), "new\n");
		await writeFile(join(remote, "MFW_REPORT.json"), '{"status":"done"}\n');
		const collection = await createRemoteCollection({
			executionPath: remote,
			runDir,
			stagePath: stage.stagePath,
		});
		const first = await applyRemoteCollection({
			canonicalPath: worktree.path,
			runDir,
			stagePath: stage.stagePath,
			collectionPath: collection.collectionPath,
		});
		expect(first.changed).toEqual([
			"MFW_REPORT.json",
			"remote-only.txt",
			"tracked.txt",
		]);
		expect(await readFile(join(worktree.path, "tracked.txt"), "utf8")).toBe(
			"remote edit\n",
		);
		expect((await stat(first.evidencePath)).isFile()).toBe(true);

		const second = await applyRemoteCollection({
			canonicalPath: worktree.path,
			runDir,
			stagePath: stage.stagePath,
			collectionPath: collection.collectionPath,
		});
		expect(second.changed).toEqual([]);
		expect(await readFile(first.receiptPath, "utf8")).not.toContain(secret);
	});

	test("detects divergent local and remote edits before collection writes", async () => {
		const { root, baseSha, worktree, runDir } = await fixture();
		const stage = await createRemoteStage({
			canonicalPath: worktree.path,
			runDir,
			branch: worktree.branch,
			baseSha,
		});
		const remote = join(root, "remote-conflict");
		await materializeRemoteStage({
			stagePath: stage.stagePath,
			executionPath: remote,
			gitPath: Bun.which("git") as string,
		});
		await writeFile(join(remote, "tracked.txt"), "remote\n");
		const collection = await createRemoteCollection({
			executionPath: remote,
			runDir,
			stagePath: stage.stagePath,
		});
		await writeFile(join(worktree.path, "tracked.txt"), "local review\n");
		const error = await applyRemoteCollection({
			canonicalPath: worktree.path,
			runDir,
			stagePath: stage.stagePath,
			collectionPath: collection.collectionPath,
		}).catch((caught) => caught);
		expect(error).toBeInstanceOf(RemoteCollectionConflictError);
		expect(error.paths).toEqual(["tracked.txt"]);
		expect(await readFile(join(worktree.path, "tracked.txt"), "utf8")).toBe(
			"local review\n",
		);
		expect((await stat(error.evidencePath)).isFile()).toBe(true);
	});

	test("rejects a remote symlink that could collect outside-worktree data", async () => {
		const { root, baseSha, worktree, runDir } = await fixture();
		const stage = await createRemoteStage({
			canonicalPath: worktree.path,
			runDir,
			branch: worktree.branch,
			baseSha,
		});
		const remote = join(root, "remote-attack");
		await materializeRemoteStage({
			stagePath: stage.stagePath,
			executionPath: remote,
			gitPath: Bun.which("git") as string,
		});
		await writeFile(join(root, "outside-secret"), "must stay outside\n");
		await symlink("../outside-secret", join(remote, "escape"));
		const error = await createRemoteCollection({
			executionPath: remote,
			runDir,
			stagePath: stage.stagePath,
		}).catch((caught) => caught);
		expect(error).toBeInstanceOf(RemoteWorkspaceError);
		expect(error.code).toBe("unsafe_entry");
	});

	test("refuses to materialize through a symlink posing as a fresh root", async () => {
		const { root, baseSha, worktree, runDir } = await fixture();
		const stage = await createRemoteStage({
			canonicalPath: worktree.path,
			runDir,
			branch: worktree.branch,
			baseSha,
		});
		const outside = join(root, "outside-empty");
		const remoteLink = join(root, "remote-link");
		await mkdir(outside);
		await symlink(outside, remoteLink);

		const error = await materializeRemoteStage({
			stagePath: stage.stagePath,
			executionPath: remoteLink,
			gitPath: Bun.which("git") as string,
		}).catch((caught) => caught);
		expect(error).toBeInstanceOf(RemoteWorkspaceError);
		expect(error.code).toBe("not_fresh");
		expect(await readdir(outside)).toEqual([]);
	});
});
