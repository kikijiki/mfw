import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
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
import { runProc } from "../src/proc.ts";
import { reflinkCopy } from "../src/run-workspace/caches.ts";
import { SeedError, seedWorkspace } from "../src/run-workspace/seed.ts";
import { plainGit } from "./fixtures/tampered-clone.ts";

const dirs: string[] = [];
afterEach(async () => {
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tmp(base = tmpdir()): Promise<string> {
	const d = await mkdtemp(join(base, "mfw-seed-"));
	dirs.push(d);
	return d;
}

const REFLINK = await (async () => {
	const d = await tmp();
	await writeFile(join(d, "a"), "x".repeat(8192));
	return (await reflinkCopy(join(d, "a"), join(d, "b"))).ok;
})();
if (!REFLINK) console.log("skip: filesystem cannot reflink; reflink tests off");
const reflinkTest = REFLINK ? test : test.skip;
const SHM = existsSync("/dev/shm");
if (!SHM) console.log("skip: no /dev/shm; tmpfs link-count test off");
const tmpfsTest = SHM ? test : test.skip;

let canaryLog = "";

interface Fixture {
	root: string;
	primary: string;
	workspaces: string;
	sha: string;
}

/** A primary with tracked files, ignored files, an untracked file and hostile config and hooks. */
async function fixture(base = tmpdir()): Promise<Fixture> {
	const root = await tmp(base);
	const primary = join(root, "primary");
	const workspaces = join(root, "home", "workspaces");
	await mkdir(primary);
	await plainGit(["init", "-q", "-b", "main"], primary);
	await writeFile(join(primary, ".gitignore"), ".env\ntarget/\n");
	await writeFile(join(primary, "a.txt"), "tracked\n");
	await mkdir(join(primary, "src"));
	await writeFile(join(primary, "src", "b.sh"), "#!/bin/sh\n", { mode: 0o755 });
	await symlink("a.txt", join(primary, "link"));
	await plainGit(["add", "-A"], primary);
	await plainGit(["commit", "-qm", "base"], primary);
	await plainGit(["branch", "other"], primary);
	await writeFile(join(primary, ".env"), "SECRET=1\n");
	await writeFile(join(primary, "untracked.txt"), "u\n");
	await mkdir(join(primary, "target"));
	await writeFile(join(primary, "target", "x"), "x\n");
	// hostile local config and a hook in the primary must not reach the clone
	// hostile local config in the primary must never run during a seed
	const canary = join(root, "canary.sh");
	canaryLog = join(root, "canary.log");
	await writeFile(
		canary,
		`#!/bin/sh
echo ran >> ${canaryLog}
`,
		{ mode: 0o755 },
	);
	await plainGit(["config", "core.fsmonitor", canary], primary);
	await plainGit(["config", "core.hooksPath", join(root, "hooks")], primary);
	await plainGit(
		["remote", "add", "origin", "https://example.invalid/r"],
		primary,
	);
	await writeFile(
		join(primary, ".git", "hooks", "post-checkout"),
		"#!/bin/sh\nexit 1\n",
		{
			mode: 0o755,
		},
	);
	const sha = await plainGit(["rev-parse", "HEAD"], primary);
	return { root, primary, workspaces, sha };
}

async function codeOf(p: Promise<unknown>): Promise<string> {
	try {
		await p;
	} catch (e) {
		if (e instanceof SeedError) return e.code;
		throw e;
	}
	return "none";
}

async function files(dir: string): Promise<string[]> {
	const out: string[] = [];
	for (const e of await readdir(dir, {
		withFileTypes: true,
		recursive: true,
	})) {
		out.push(join(e.parentPath, e.name));
	}
	return out;
}

const modeOf = async (p: string) => (await stat(p)).mode & 0o777;

describe("seedWorkspace", () => {
	for (const strategy of ["auto", "clone"] as const) {
		test(`layout, tracked content only, minimal config (${strategy})`, async () => {
			const f = await fixture();
			const logs: string[] = [];
			const r = await seedWorkspace({
				runId: "run1",
				workspaceRoot: f.workspaces,
				primaryRoot: f.primary,
				baseSha: f.sha,
				strategy,
				log: (m) => logs.push(m),
			});
			expect(r.dir).toBe(join(f.workspaces, "run1"));
			expect(r.gitDir).toBe(join(r.dir, "git"));
			expect(r.treeDir).toBe(join(r.dir, "tree"));
			expect(logs.join("\n")).toContain(`strategy ${r.strategy}`);
			if (strategy === "clone") expect(r.strategy).toBe("clone");
			for (const d of [f.workspaces, r.dir, r.gitDir, r.treeDir]) {
				expect(await modeOf(d)).toBe(0o700);
			}

			// tracked content, modes and links; nothing untracked or ignored
			expect(await readFile(join(r.treeDir, "a.txt"), "utf8")).toBe(
				"tracked\n",
			);
			expect(await modeOf(join(r.treeDir, "src", "b.sh"))).toBe(0o755);
			expect(await Bun.file(join(r.treeDir, "link")).text()).toBe("tracked\n");
			for (const absent of [".env", "untracked.txt", "target", ".git"]) {
				expect(existsSync(join(r.treeDir, absent))).toBe(false);
			}
			expect((await readdir(r.treeDir)).sort()).toEqual([
				".gitignore",
				"a.txt",
				"link",
				"src",
			]);

			// the gitdir is minimal: no primary config, hooks, remote or other branches
			const gitEntries = (await readdir(r.gitDir)).sort();
			expect(gitEntries).toEqual([
				"HEAD",
				"config",
				"index",
				"objects",
				"refs",
			]);
			const cfg = await readFile(join(r.gitDir, "config"), "utf8");
			expect(cfg).not.toMatch(/remote|fsmonitor|hook|url|user/);
			const gd = { GIT_DIR: r.gitDir };
			const refs = (
				await plainGit(
					["for-each-ref", "--format=%(refname) %(objectname)"],
					r.gitDir,
					gd,
				)
			).split("\n");
			expect(refs.sort()).toEqual(
				[`refs/heads/mfw/run1 ${f.sha}`, `refs/mfw/base/run1 ${f.sha}`].sort(),
			);
			expect(await readFile(join(r.gitDir, "HEAD"), "utf8")).toBe(
				"ref: refs/heads/mfw/run1\n",
			);
			expect(existsSync(join(r.gitDir, "objects", "info", "alternates"))).toBe(
				false,
			);
			await plainGit(["fsck", "--full"], r.gitDir, gd);
			// a clean index: git status sees nothing
			expect(
				await plainGit(["status", "--porcelain"], r.treeDir, {
					GIT_DIR: r.gitDir,
					GIT_WORK_TREE: r.treeDir,
				}),
			).toBe("");
		});
	}

	test("git -C tree fails without GIT_DIR", async () => {
		const f = await fixture();
		const r = await seedWorkspace({
			runId: "run1",
			workspaceRoot: f.workspaces,
			primaryRoot: f.primary,
			baseSha: f.sha,
		});
		const env = {
			PATH: process.env.PATH ?? "",
			HOME: "/nonexistent",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CEILING_DIRECTORIES: f.root,
		};
		const bare = await runProc(["git", "-C", r.treeDir, "status"], { env });
		expect(bare.exitCode).not.toBe(0);
		expect(bare.stderr).toContain("not a git repository");
		const withDir = await runProc(["git", "-C", r.treeDir, "status"], {
			env: { ...env, GIT_DIR: r.gitDir, GIT_WORK_TREE: r.treeDir },
		});
		expect(withDir.exitCode).toBe(0);
	});

	reflinkTest(
		"auto picks a reflink copy and shares no inode with the primary",
		async () => {
			const f = await fixture();
			const r = await seedWorkspace({
				runId: "run1",
				workspaceRoot: f.workspaces,
				primaryRoot: f.primary,
				baseSha: f.sha,
			});
			expect(r.strategy).toBe("reflink");
			expect(r.strategyReason).toBe("reflink_ok");
			const inodes = new Set<number>();
			for (const p of await files(join(f.primary, ".git", "objects"))) {
				inodes.add((await stat(p)).ino);
			}
			for (const p of await files(join(r.gitDir, "objects"))) {
				expect(inodes.has((await stat(p)).ino)).toBe(false);
			}
		},
	);

	tmpfsTest(
		"on tmpfs the clone fallback leaves every object at link count 1",
		async () => {
			const f = await fixture("/dev/shm");
			const r = await seedWorkspace({
				runId: "run1",
				workspaceRoot: f.workspaces,
				primaryRoot: f.primary,
				baseSha: f.sha,
			});
			// tmpfs cannot reflink: auto falls back, and says why
			expect(r.strategy).toBe("clone");
			expect(r.strategyReason).toStartWith("reflink_unavailable");
			let count = 0;
			for (const p of await files(join(r.gitDir, "objects"))) {
				const st = await stat(p);
				if (!st.isFile()) continue;
				count++;
				expect(st.nlink).toBe(1);
			}
			expect(count).toBeGreaterThan(0);
			for (const p of await files(join(f.primary, ".git", "objects"))) {
				const st = await stat(p);
				if (st.isFile()) expect(st.nlink).toBe(1);
			}
		},
	);

	test("a primary with alternates is refused and nothing is left behind", async () => {
		const f = await fixture();
		await writeFile(
			join(f.primary, ".git", "objects", "info", "alternates"),
			"/nowhere/objects\n",
		);
		expect(
			await codeOf(
				seedWorkspace({
					runId: "run1",
					workspaceRoot: f.workspaces,
					primaryRoot: f.primary,
					baseSha: f.sha,
				}),
			),
		).toBe("alternates");
		expect(existsSync(join(f.workspaces, "run1"))).toBe(false);
	});

	test("a missing base commit leaves no workspace", async () => {
		const f = await fixture();
		expect(
			await codeOf(
				seedWorkspace({
					runId: "run1",
					workspaceRoot: f.workspaces,
					primaryRoot: f.primary,
					baseSha: "0".repeat(40),
				}),
			),
		).toBe("base_missing");
		expect(existsSync(join(f.workspaces, "run1"))).toBe(false);
	});

	test("an existing workspace is refused and kept", async () => {
		const f = await fixture();
		const args = {
			runId: "run1",
			workspaceRoot: f.workspaces,
			primaryRoot: f.primary,
			baseSha: f.sha,
		};
		const r = await seedWorkspace(args);
		await writeFile(join(r.treeDir, "mine"), "work");
		expect(await codeOf(seedWorkspace(args))).toBe("workspace_exists");
		expect(await readFile(join(r.treeDir, "mine"), "utf8")).toBe("work");
	});

	test("rejects bad run ids, branch names as the base, and a workspace root inside the primary", async () => {
		const f = await fixture();
		const base = {
			workspaceRoot: f.workspaces,
			primaryRoot: f.primary,
			baseSha: f.sha,
		};
		await expect(seedWorkspace({ ...base, runId: "../x" })).rejects.toThrow();
		expect(
			await codeOf(seedWorkspace({ ...base, runId: "r", baseSha: "main" })),
		).toBe("bad_argument");
		expect(
			await codeOf(
				seedWorkspace({
					...base,
					runId: "r",
					workspaceRoot: join(f.primary, "ws"),
				}),
			),
		).toBe("bad_argument");
		expect(
			await codeOf(
				seedWorkspace({
					...base,
					runId: "r",
					primaryRoot: join(f.root, "none"),
				}),
			),
		).toBe("primary_unusable");
	});

	test("the primary is unchanged by a seed", async () => {
		const f = await fixture();
		const snap = async () =>
			[
				await plainGit(["for-each-ref"], f.primary),
				await plainGit(
					["-c", "core.fsmonitor=false", "status", "--porcelain", "--ignored"],
					f.primary,
				),
				await readFile(join(f.primary, ".git", "config"), "utf8"),
			].join("\n");
		const before = await snap();
		await seedWorkspace({
			runId: "run1",
			workspaceRoot: f.workspaces,
			primaryRoot: f.primary,
			baseSha: f.sha,
		});
		expect(await snap()).toBe(before);
		expect(existsSync(canaryLog)).toBe(false);
	});

	test("declared caches are carried; the seed still has no .env", async () => {
		const f = await fixture();
		const r = await seedWorkspace({
			runId: "run1",
			workspaceRoot: f.workspaces,
			primaryRoot: f.primary,
			baseSha: f.sha,
			caches: [{ kind: "rust-target", path: "target" }],
		});
		expect(r.caches).toHaveLength(1);
		expect(existsSync(join(r.treeDir, ".env"))).toBe(false);
		if (REFLINK) {
			expect(r.caches[0]?.status).toBe("seeded");
			expect(await readFile(join(r.treeDir, "target", "x"), "utf8")).toBe(
				"x\n",
			);
		} else {
			expect(r.caches[0]?.reason).toBe("reflink_unsupported");
		}
	});
});
