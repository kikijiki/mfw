import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, gitOk } from "../src/git.ts";
import { rebaseQuarantineInScratch } from "../src/run-workspace/rebase-clone.ts";

const dirs: string[] = [];
afterEach(async () => {
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function setup() {
	const root = await mkdtemp(join(tmpdir(), "mfw-rebase-"));
	dirs.push(root);
	const primary = join(root, "primary");
	await mkdir(primary);
	await git(["init", "-q", "-b", "main", "."], primary);
	await git(["config", "user.email", "t@t"], primary);
	await git(["config", "user.name", "t"], primary);
	await writeFile(join(primary, "a.txt"), "one\n");
	await writeFile(join(primary, "b.txt"), "base\n");
	await git(["add", "-A"], primary);
	await git(["commit", "-q", "-m", "init"], primary);
	const base = await gitOk(["rev-parse", "HEAD"], primary);
	const workspaceRoot = join(root, "home", "workspaces");
	const scratchRoot = join(root, "home", "workspace-scratch");
	/** A run commit on `base`, held only as the quarantine ref. */
	const quarantine = async (runId: string, file: string, content: string) => {
		await git(["checkout", "-q", "--detach", base], primary);
		await writeFile(join(primary, file), content);
		await git(["add", "-A"], primary);
		await git(["commit", "-q", "-m", `run ${runId}`], primary);
		const tip = await gitOk(["rev-parse", "HEAD"], primary);
		await gitOk(["update-ref", `refs/mfw/quarantine/${runId}`, tip], primary);
		await git(["checkout", "-q", "main"], primary);
		return tip;
	};
	/** Move main forward by one commit. */
	const advance = async (file: string, content: string) => {
		await writeFile(join(primary, file), content);
		await git(["add", "-A"], primary);
		await git(["commit", "-q", "-m", `main ${file}`], primary);
		return gitOk(["rev-parse", "HEAD"], primary);
	};
	const opts = { workspaceRoot, primaryRoot: primary, scratchRoot };
	return { root, primary, base, scratchRoot, quarantine, advance, opts };
}

describe("rebaseQuarantineInScratch", () => {
	test("a clean rebase moves the quarantine ref onto the target and leaves the primary alone", async () => {
		const t = await setup();
		const old = await t.quarantine("r1", "c.txt", "mine\n");
		const onto = await t.advance("a.txt", "two\n");
		const headBefore = await gitOk(["rev-parse", "HEAD"], t.primary);
		const res = await rebaseQuarantineInScratch(t.opts, {
			runId: "r1",
			targetBranch: "main",
			onto,
		});
		expect(res.ok).toBe(true);
		const tip = await gitOk(["rev-parse", "refs/mfw/quarantine/r1"], t.primary);
		expect(tip).not.toBe(old);
		expect(res.ok && res.tip).toBe(tip);
		expect(await gitOk(["rev-parse", `${tip}^`], t.primary)).toBe(onto);
		expect(await gitOk(["show", `${tip}:c.txt`], t.primary)).toBe("mine");
		expect(await gitOk(["show", `${tip}:a.txt`], t.primary)).toBe("two");
		// primary checkout and branch untouched; scratch clone deleted
		expect(await gitOk(["rev-parse", "HEAD"], t.primary)).toBe(headBefore);
		expect((await git(["status", "--porcelain"], t.primary)).stdout).toBe("");
		expect(existsSync(t.scratchRoot)).toBe(true);
		expect(
			(await Array.fromAsync(new Bun.Glob("*").scan(t.scratchRoot))).length,
		).toBe(0);
	});

	test("each rebase keeps the tip it replaced under refs/mfw/pre-rebase, numbered from 1", async () => {
		const t = await setup();
		const first = await t.quarantine("r6", "c.txt", "mine\n");
		const o1 = await t.advance("a.txt", "two\n");
		await rebaseQuarantineInScratch(t.opts, {
			runId: "r6",
			targetBranch: "main",
			onto: o1,
		});
		const second = await gitOk(
			["rev-parse", "refs/mfw/quarantine/r6"],
			t.primary,
		);
		const o2 = await t.advance("a.txt", "three\n");
		await rebaseQuarantineInScratch(t.opts, {
			runId: "r6",
			targetBranch: "main",
			onto: o2,
		});
		expect(
			await gitOk(["rev-parse", "refs/mfw/pre-rebase/r6/1"], t.primary),
		).toBe(first);
		expect(
			await gitOk(["rev-parse", "refs/mfw/pre-rebase/r6/2"], t.primary),
		).toBe(second);
	});

	test("a conflict keeps no pre-rebase ref", async () => {
		const t = await setup();
		await t.quarantine("r7", "b.txt", "base\nfrom run\n");
		const onto = await t.advance("b.txt", "from main\n");
		await rebaseQuarantineInScratch(t.opts, {
			runId: "r7",
			targetBranch: "main",
			onto,
		});
		expect(
			await gitOk(["for-each-ref", "refs/mfw/pre-rebase/"], t.primary),
		).toBe("");
	});

	test("a conflict reports the paths and does not move the quarantine ref", async () => {
		const t = await setup();
		const old = await t.quarantine("r2", "b.txt", "base\nfrom run\n");
		const onto = await t.advance("b.txt", "from main\n");
		const res = await rebaseQuarantineInScratch(t.opts, {
			runId: "r2",
			targetBranch: "main",
			onto,
		});
		expect(res).toMatchObject({
			ok: false,
			kind: "conflict",
			paths: ["b.txt"],
		});
		expect(
			await gitOk(["rev-parse", "refs/mfw/quarantine/r2"], t.primary),
		).toBe(old);
		expect(
			(await Array.fromAsync(new Bun.Glob("*").scan(t.scratchRoot))).length,
		).toBe(0);
	});

	test("a target that moved since `onto` was read is an error, not a rebase", async () => {
		const t = await setup();
		await t.quarantine("r3", "c.txt", "mine\n");
		await t.advance("a.txt", "two\n");
		const res = await rebaseQuarantineInScratch(t.opts, {
			runId: "r3",
			targetBranch: "main",
			onto: t.base,
		});
		expect(res).toMatchObject({ ok: false, kind: "error" });
	});

	test("hooks and attribute filters in the run's tree do not run", async () => {
		const t = await setup();
		const marker = join(t.root, "ran");
		// A tracked .gitattributes naming a filter and merge driver; no config defines them.
		await git(["checkout", "-q", "--detach", t.base], t.primary);
		await writeFile(
			join(t.primary, ".gitattributes"),
			"*.txt filter=evil merge=evil\n",
		);
		await writeFile(join(t.primary, "c.txt"), "mine\n");
		await git(["add", "-A"], t.primary);
		await git(["commit", "-q", "-m", "run"], t.primary);
		await gitOk(
			[
				"update-ref",
				"refs/mfw/quarantine/r4",
				await gitOk(["rev-parse", "HEAD"], t.primary),
			],
			t.primary,
		);
		await git(["checkout", "-q", "main"], t.primary);
		// A primary hook that would run if the scratch clone inherited hooks.
		await mkdir(join(t.primary, ".git/hooks"), { recursive: true });
		await writeFile(
			join(t.primary, ".git/hooks/post-checkout"),
			`#!/bin/sh\ntouch ${marker}\n`,
			{ mode: 0o755 },
		);
		const onto = await t.advance("a.txt", "two\n");
		const res = await rebaseQuarantineInScratch(t.opts, {
			runId: "r4",
			targetBranch: "main",
			onto,
		});
		expect(res.ok).toBe(true);
		expect(existsSync(marker)).toBe(false);
		expect(await readFile(join(t.primary, "a.txt"), "utf8")).toBe("two\n");
	});

	test("a scratch root under the workspace root is refused", async () => {
		const t = await setup();
		const res = await rebaseQuarantineInScratch(
			{ ...t.opts, scratchRoot: join(t.opts.workspaceRoot, "scratch") },
			{ runId: "r5", targetBranch: "main", onto: t.base },
		);
		expect(res).toMatchObject({ ok: false, kind: "error" });
	});
});
