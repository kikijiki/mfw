import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CheckRunner } from "../src/containment/check-runner.ts";
import { git, gitOk } from "../src/git.ts";
import { runProc } from "../src/proc.ts";
import { cloneScopeFiles } from "../src/run-workspace/scope-files.ts";
import { VerifierClones } from "../src/run-workspace/verifier-clone.ts";
import { changedFilesInRef } from "../src/scope-watchdog.ts";
import { verify, verifyInClone } from "../src/verifier.ts";

const dirs: string[] = [];
afterEach(async () => {
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function setup() {
	const root = await mkdtemp(join(tmpdir(), "mfw-vclone-"));
	dirs.push(root);
	const primary = join(root, "primary");
	await mkdir(primary);
	await git(["init", "-q", "-b", "main", "."], primary);
	await git(["config", "user.email", "t@t"], primary);
	await git(["config", "user.name", "t"], primary);
	await writeFile(join(primary, "a.txt"), "one\n");
	await git(["add", "-A"], primary);
	await git(["commit", "-q", "-m", "init"], primary);
	const base = await gitOk(["rev-parse", "HEAD"], primary);
	const wsRoot = join(root, "home", "workspaces");
	// The double for the sandbox; check-sandbox-live.test.ts runs the real one.
	const checkRunner: CheckRunner = (req) =>
		runProc(["sh", "-c", req.command], {
			cwd: req.tree,
			timeoutMs: req.timeoutMs,
		});
	const clones = new VerifierClones({
		workspaceRoot: wsRoot,
		primaryRoot: primary,
		checkRunner,
	});
	return { root, primary, base, wsRoot, clones };
}

/** Rewrite who a clone says owns it (the clone's `mfw-workspace.json`). */
async function rewriteOwner(
	treePath: string,
	owner: { instance: string; pid: number },
) {
	const file = join(dirname(treePath), "mfw-workspace.json");
	const meta = JSON.parse(await readFile(file, "utf8"));
	await writeFile(file, `${JSON.stringify({ ...meta, owner })}\n`);
}

/** What a daemon that died mid-verification leaves: an owner that is gone. */
async function abandonAsCrashed(treePath: string) {
	const dead = Bun.spawn(["true"]);
	await dead.exited;
	await rewriteOwner(treePath, { instance: "gone", pid: dead.pid });
}

const dod = (checks: unknown[]) =>
	({ verifier: "deterministic", checks }) as never;

describe("VerifierClones", () => {
	test("a clone holds exactly the commit, has no .git entry, and is disposed with its pin", async () => {
		const t = await setup();
		const c = await t.clones.create(t.base, "run1");
		expect(c.sha).toBe(t.base);
		expect(existsSync(join(c.path, "a.txt"))).toBe(true);
		expect(existsSync(join(c.path, ".git"))).toBe(false);
		const pins = await gitOk(["for-each-ref", "refs/mfw/verify/"], t.primary);
		expect(pins).toContain(c.id);
		await c.dispose();
		await c.dispose(); // idempotent
		expect(existsSync(c.path)).toBe(false);
		expect(await gitOk(["for-each-ref", "refs/mfw/verify/"], t.primary)).toBe(
			"",
		);
	});

	test("an unreferenced merge commit can be verified, and the primary is untouched", async () => {
		const t = await setup();
		await writeFile(join(t.primary, "b.txt"), "two\n");
		await git(["add", "-A"], t.primary);
		const tree = await gitOk(["write-tree"], t.primary);
		const orphan = await gitOk(
			["commit-tree", tree, "-p", t.base, "-m", "merge"],
			t.primary,
		);
		await git(["reset", "-q", "--hard", t.base], t.primary);
		const before = await gitOk(["status", "--porcelain"], t.primary);
		const out = await t.clones.with(orphan, "merge-x", async (c) => {
			expect(existsSync(join(c.path, "b.txt"))).toBe(true);
			return c.sha;
		});
		expect(out).toBe(orphan);
		expect(await gitOk(["status", "--porcelain"], t.primary)).toBe(before);
	});

	test("with disposes the clone when the callback throws", async () => {
		const t = await setup();
		let path = "";
		await expect(
			t.clones.with(t.base, "boom", async (c) => {
				path = c.path;
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(existsSync(path)).toBe(false);
	});

	test("an unknown commit is refused before anything is created", async () => {
		const t = await setup();
		await expect(t.clones.create("f".repeat(40), "x")).rejects.toThrow(
			"no such commit",
		);
		expect(existsSync(t.wsRoot)).toBe(false);
	});

	test("sweep removes leftovers of a crashed daemon but not run workspaces", async () => {
		const t = await setup();
		const c = await t.clones.create(t.base, "stale");
		await abandonAsCrashed(c.path);
		const keep = join(t.wsRoot, "run-keep");
		await mkdir(keep, { recursive: true });
		expect(await t.clones.sweep()).toBe(1);
		expect(existsSync(c.path)).toBe(false);
		expect(existsSync(keep)).toBe(true);
		expect(await gitOk(["for-each-ref", "refs/mfw/verify/"], t.primary)).toBe(
			"",
		);
	});

	test("sweep spares a verification that is running, even when another project attaches", async () => {
		const t = await setup();
		const secondPrimary = join(t.root, "second");
		await mkdir(secondPrimary);
		await git(["init", "-q", "-b", "main", "."], secondPrimary);
		await git(["config", "user.email", "t@t"], secondPrimary);
		await git(["config", "user.name", "t"], secondPrimary);
		await writeFile(join(secondPrimary, "b.txt"), "b\n");
		await git(["add", "-A"], secondPrimary);
		await git(["commit", "-q", "-m", "init"], secondPrimary);
		// The second project attaches to the same workspace root and sweeps.
		const attaching = new VerifierClones({
			workspaceRoot: t.wsRoot,
			primaryRoot: secondPrimary,
		});
		const live = await t.clones.create(t.base, "in-flight");
		expect(await attaching.sweep()).toBe(0);
		expect(await t.clones.sweep()).toBe(0);
		expect(existsSync(join(live.path, "a.txt"))).toBe(true);
		expect(
			await gitOk(["for-each-ref", "refs/mfw/verify/"], t.primary),
		).toContain(live.id);
		await live.dispose();
		expect(existsSync(live.path)).toBe(false);
	});

	test("sweep spares a clone another live daemon owns, until the age bound", async () => {
		const t = await setup();
		const c = await t.clones.create(t.base, "theirs");
		// Owned by another process that is alive: this test's parent.
		await rewriteOwner(c.path, { instance: "other", pid: process.ppid });
		expect(await t.clones.sweep()).toBe(0);
		expect(existsSync(c.path)).toBe(true);
		const aged = new VerifierClones({
			workspaceRoot: t.wsRoot,
			primaryRoot: t.primary,
			orphanAgeMs: 0,
		});
		expect(await aged.sweep()).toBe(1);
		expect(existsSync(c.path)).toBe(false);
		expect(await gitOk(["for-each-ref", "refs/mfw/verify/"], t.primary)).toBe(
			"",
		);
	});

	test("sweep leaves a half-seeded clone with no owner record for a grace period", async () => {
		const t = await setup();
		const half = join(t.wsRoot, "verify-half-deadbeef");
		await mkdir(join(half, "tree"), { recursive: true });
		expect(await t.clones.sweep()).toBe(0);
		expect(existsSync(half)).toBe(true);
	});
});

// Security review P7, M5 (X4): `files_exist` followed candidate links on the
// host, and could be satisfied by a file an earlier check had just created.
describe("files_exist answers from the commit", () => {
	const exists = (paths: string[]) => dod([{ files_exist: paths }]);

	const withCommitted = async (
		t: Awaited<ReturnType<typeof setup>>,
		make: () => Promise<void>,
	) => {
		await make();
		await git(["add", "-A"], t.primary);
		await git(["commit", "-q", "-m", "more"], t.primary);
		return (await git(["rev-parse", "HEAD"], t.primary)).stdout.trim();
	};

	test("a committed file and directory exist, an absent one does not", async () => {
		const t = await setup();
		const sha = await withCommitted(t, async () => {
			await mkdir(join(t.primary, "src"));
			await writeFile(join(t.primary, "src/b.txt"), "b\n");
		});
		const ok = await verifyInClone(
			t.clones,
			sha,
			"r",
			exists(["a.txt", "src/b.txt", "src", "./a.txt", "src/"]),
			t.base,
		);
		expect(ok.checks[0]?.detail).toBeUndefined();
		expect(ok.passed).toBe(true);
		const missing = await verifyInClone(
			t.clones,
			sha,
			"r",
			exists(["nope.txt"]),
			t.base,
		);
		expect(missing.passed).toBe(false);
		expect(missing.checks[0]?.classification).toBe("missing-file");
	});

	test("a committed link says nothing about what it points at on the host", async () => {
		const t = await setup();
		const present = join(t.root, "host-file");
		await writeFile(present, "x");
		const sha = await withCommitted(t, async () => {
			await symlink(present, join(t.primary, "to-present"));
			await symlink(join(t.root, "absent"), join(t.primary, "to-absent"));
		});
		const a = await verifyInClone(
			t.clones,
			sha,
			"r",
			exists(["to-present"]),
			sha,
		);
		const b = await verifyInClone(
			t.clones,
			sha,
			"r",
			exists(["to-absent"]),
			sha,
		);
		expect(a.passed).toBe(b.passed);
	});

	test.each([
		"../secret",
		"a/../../secret",
		"/etc/passwd",
		"",
	])("the path %j is refused", async (path) => {
		const t = await setup();
		await writeFile(join(t.root, "secret"), "x");
		const r = await verifyInClone(
			t.clones,
			t.base,
			"r",
			exists([path]),
			t.base,
		);
		expect(r.passed).toBe(false);
		expect(r.checks[0]?.classification).toBe("missing-file");
	});

	test("a file an earlier check created does not count", async () => {
		const t = await setup();
		const r = await verifyInClone(
			t.clones,
			t.base,
			"r",
			dod([{ run: "touch made.txt" }, { files_exist: ["made.txt"] }]),
			t.base,
		);
		expect(r.checks[0]?.ok).toBe(true);
		expect(r.checks[1]?.ok).toBe(false);
	});

	test("an installed dependency cannot be answered, so it is infrastructure", async () => {
		const t = await setup();
		const r = await verifyInClone(
			t.clones,
			t.base,
			"r",
			exists(["node_modules/left-pad/index.js"]),
			t.base,
		);
		expect(r.passed).toBe(false);
		expect(r.crashed).toBe(true);
	});
});

describe("verifier in a clone", () => {
	test("without a sandbox the check is refused and nothing runs", async () => {
		const t = await setup();
		const canary = join(t.root, "ran-on-host");
		const bare = new VerifierClones({
			workspaceRoot: t.wsRoot,
			primaryRoot: t.primary,
		});
		const r = await verifyInClone(
			bare,
			t.base,
			"r",
			dod([{ run: `touch ${canary}` }]),
			t.base,
		);
		expect(r.passed).toBe(false);
		expect(r.crashed).toBe(true);
		expect(r.checks[0]?.detail).toContain("no_verifier_sandbox");
		expect(existsSync(canary)).toBe(false);
	});

	test("checks run in the clone, not in the primary", async () => {
		const t = await setup();
		const r = await verifyInClone(
			t.clones,
			t.base,
			"r",
			dod([{ run: "test -f a.txt && echo marker > ran.txt" }]),
			t.base,
		);
		expect(r.passed).toBe(true);
		expect(existsSync(join(t.primary, "ran.txt"))).toBe(false);
	});

	test("diff_against_base is answered from the sha and runs no git in the tree", async () => {
		const t = await setup();
		const notARepo = await mkdtemp(join(tmpdir(), "mfw-nogit-"));
		dirs.push(notARepo);
		const check = dod([{ diff_against_base: true }]);
		const changed = await verify(notARepo, check, t.base, {
			candidateSha: "b".repeat(40),
		});
		expect(changed.passed).toBe(true);
		const same = await verify(notARepo, check, t.base, {
			candidateSha: t.base,
		});
		expect(same.passed).toBe(false);
		expect(same.checks[0]?.classification).toBe("no-change");
	});

	test("a tampered tree cannot make the host run git: the candidate sha decides", async () => {
		const t = await setup();
		const r = await t.clones.with(t.base, "tamper", async (c) => {
			// The checks (agent-influenced code) may do anything to the tree.
			await mkdir(join(c.path, ".git"));
			await writeFile(
				join(c.path, ".git", "config"),
				"[core]\n\tfsmonitor = touch /nonexistent-canary\n",
			);
			return verify(c.path, dod([{ diff_against_base: true }]), t.base, {
				candidateSha: c.sha,
			});
		});
		expect(r.checks[0]?.classification).toBe("no-change");
		expect(existsSync("/nonexistent-canary")).toBe(false);
	});
});

describe("scope watchdog on fetched refs", () => {
	test("changedFilesInRef lists the ref's paths against the base and drops bookkeeping", async () => {
		const t = await setup();
		await mkdir(join(t.primary, "sub"));
		await writeFile(join(t.primary, "sub", "n.txt"), "n\n");
		await writeFile(join(t.primary, "MFW_REPORT.json"), "{}\n");
		await writeFile(join(t.primary, "a.txt"), "changed\n");
		await git(["add", "-A"], t.primary);
		await git(["commit", "-q", "-m", "work"], t.primary);
		const files = await changedFilesInRef(t.primary, t.base, "HEAD");
		expect(files.files).toEqual(["a.txt", "sub/n.txt"]);
	});

	test("cloneScopeFiles diffs the imported work, and gives no sample when nothing was imported", async () => {
		const t = await setup();
		await writeFile(join(t.primary, "x.txt"), "x\n");
		await git(["add", "-A"], t.primary);
		await git(["commit", "-q", "-m", "wip"], t.primary);
		const tip = await gitOk(["rev-parse", "HEAD"], t.primary);
		const ok = {
			requestWip: async () => ({
				ack: { id: "i", ok: true },
				imported: { tip, wip: [] as string[] },
			}),
		};
		const got = await cloneScopeFiles(ok, t.primary, "/w/tree", t.base);
		expect(got.files).toEqual(["x.txt"]);
		await expect(
			cloneScopeFiles(
				{
					requestWip: async () => ({
						ack: { id: "i", ok: true },
						imported: null,
					}),
				},
				t.primary,
				"/w/tree",
				t.base,
			),
		).rejects.toThrow("not quiescent");
	});
});
