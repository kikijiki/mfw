import { afterEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { worktreeState } from "../src/agent-review.ts";
import { gitComplete, gitOk } from "../src/git.ts";
import {
	fetchRunResult,
	sweepIncomingRefs,
	unsafeNoValidation,
} from "../src/host-git/fetch.ts";
import { HostGit, HostGitError } from "../src/host-git/runner.ts";
import {
	listWorkspacePaths,
	RemoteWorkspaceError,
} from "../src/remote-worktree.ts";
import { validateRunResult } from "../src/run-workspace/clone-impl.ts";
import {
	assessScope,
	branchChangedFiles,
	changedFilesInRef,
	DEFAULT_SCOPE_POLICY,
	finishScope,
	MAX_SCOPE_PATHS,
	scopeKill,
} from "../src/scope-watchdog.ts";

/** Regressions for the security review of the clone result path. */

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const EMPTY_MODE = "100644";

/** A throwaway bare repo with a base commit, and a way to commit crafted trees. */
async function bare() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "mfw-wip-review-")));
	dirs.push(root);
	const scratch = join(root, "scratch");
	const repo = join(scratch, "repo.git");
	mkdirSync(scratch);
	await gitOk(["init", "-q", "--bare", repo], root);
	const host = new HostGit({
		workspaceRoot: join(root, "workspaces"),
		ownedRoots: [scratch],
	});
	const id = { GIT_DIR: repo };
	const raw = async (args: string[], input?: string, env = {}) => {
		const p = Bun.spawn(["git", ...args], {
			env: {
				...process.env,
				...id,
				...env,
				GIT_AUTHOR_NAME: "t",
				GIT_AUTHOR_EMAIL: "t@t",
				GIT_COMMITTER_NAME: "t",
				GIT_COMMITTER_EMAIL: "t@t",
			},
			stdin: input === undefined ? "ignore" : new TextEncoder().encode(input),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [out, err, code] = await Promise.all([
			new Response(p.stdout).text(),
			new Response(p.stderr).text(),
			p.exited,
		]);
		if (code !== 0) throw new Error(`git ${args[0]}: ${err}`);
		return out.trim();
	};
	const blob = (text: string) => raw(["hash-object", "-w", "--stdin"], text);
	/** Commit exactly these `[mode, path, sha]` entries, on `parent`. */
	const commit = async (
		entries: [string, string, string][],
		ref: string,
		parent?: string,
	) => {
		const index = join(root, `index-${ref.replaceAll("/", "-")}`);
		const env = { GIT_INDEX_FILE: index };
		await raw(
			["update-index", "--add", "-z", "--index-info"],
			entries.map(([m, p, s]) => `${m} ${s}\t${p}\0`).join(""),
			env,
		);
		const tree = await raw(["write-tree"], undefined, env);
		const sha = await raw([
			"commit-tree",
			tree,
			...(parent ? ["-p", parent] : []),
			"-m",
			"c",
		]);
		await raw(["update-ref", ref, sha]);
		return sha;
	};
	const one = await blob("one\n");
	const base = await commit([[EMPTY_MODE, "a.txt", one]], "refs/mfw/run/base");
	const ctx = {
		bareRepo: repo,
		runId: "r1",
		headRef: "refs/mfw/run/head",
		wipRefs: [] as string[],
		host,
	};
	return { root, repo, host, blob, commit, base, one, ctx };
}

const fillers = (n: number, sha: string): [string, string, string][] =>
	Array.from({ length: n }, (_, i) => [
		EMPTY_MODE,
		`z/${"f".repeat(240)}-${i}`,
		sha,
	]);

const refusal = async (p: Promise<unknown>) => {
	try {
		await p;
		return null;
	} catch (e) {
		return e instanceof HostGitError ? e.code : `other: ${e}`;
	}
};

describe("B1: a large diff cannot hide an entry from the validator", () => {
	test("protected entries among 22000 fillers are refused", async () => {
		const b = await bare();
		const target = await b.blob("/etc/passwd");
		await b.commit(
			[
				[EMPTY_MODE, "a.txt", b.one],
				[EMPTY_MODE, ".gitattributes", b.one],
				["160000", "a-gitlink", b.base],
				["120000", "a-link", target],
				...fillers(22_000, b.one),
			],
			b.ctx.headRef,
			b.base,
		);
		expect(await refusal(validateRunResult(b.ctx, b.base))).toBe("validation");
	}, 60_000);

	test("under the entry cap, output past the old 4 MiB tail is read in full", async () => {
		const b = await bare();
		await b.commit(
			[
				[EMPTY_MODE, "a.txt", b.one],
				[EMPTY_MODE, ".gitattributes", b.one],
				...fillers(19_000, b.one),
			],
			b.ctx.headRef,
			b.base,
		);
		await expect(validateRunResult(b.ctx, b.base)).rejects.toThrow(
			".gitattributes",
		);
	}, 60_000);

	test("a clean large change under the cap still passes", async () => {
		const b = await bare();
		await b.commit(
			[[EMPTY_MODE, "a.txt", b.one], ...fillers(19_000, b.one)],
			b.ctx.headRef,
			b.base,
		);
		expect(await refusal(validateRunResult(b.ctx, b.base))).toBeNull();
	}, 60_000);

	test("a HostGit read that overflows its output cap is an error, not a tail", async () => {
		const b = await bare();
		const big = await b.blob("x".repeat(64 * 1024));
		await expect(
			b.host.runOk(["cat-file", "-p", big], {
				cwd: b.repo,
				repo: b.repo,
				maxOutputBytes: 1024,
			}),
		).rejects.toMatchObject({ code: "validation" });
	});

	test("the merge firewall's read refuses a listing past the output cap", async () => {
		const b = await bare();
		await b.commit(fillers(19_000, b.one), "refs/heads/big", b.base);
		await expect(
			gitComplete(
				[
					"--git-dir",
					b.repo,
					"ls-tree",
					"-r",
					"-z",
					"--name-only",
					"refs/heads/big",
				],
				b.root,
			),
		).rejects.toThrow("more output than the cap");
	}, 60_000);
});

describe("H1: long paths cannot hide an out-of-scope edit", () => {
	const longPaths = (n: number, sha: string): [string, string, string][] =>
		Array.from({ length: n }, (_, i) => [
			EMPTY_MODE,
			`src/${"d".repeat(200)}/`.repeat(38) + `f-${i}`,
			sha,
		]);

	test("a listing past the old 1 MiB tail still shows the outside file", async () => {
		const b = await bare();
		const head = await b.commit(
			[
				[EMPTY_MODE, "a.txt", b.one],
				[EMPTY_MODE, "a-outside.txt", b.one],
				...longPaths(140, b.one),
			],
			"refs/heads/run",
			b.base,
		);
		const listed = await changedFilesInRef(b.repo, b.base, head);
		expect(listed.truncated).toBe(false);
		expect(listed.files).toContain("a-outside.txt");
		expect(finishScope(["src/"], listed).outsideFiles).toContain(
			"a-outside.txt",
		);
	}, 60_000);

	test("a listing over the path cap is reported as truncated", async () => {
		const b = await bare();
		const head = await b.commit(
			[[EMPTY_MODE, "a.txt", b.one], ...fillers(MAX_SCOPE_PATHS + 5, b.one)],
			"refs/heads/run",
			b.base,
		);
		const listed = await changedFilesInRef(b.repo, b.base, head);
		expect(listed.truncated).toBe(true);
	}, 60_000);

	test("a truncated listing is a violation at finish, whatever it shows", () => {
		const r = finishScope(["src/"], { files: ["src/a.ts"], truncated: true });
		expect(r.outside).toBeGreaterThan(0);
		expect(r.truncated).toBe(true);
	});

	test("an unsampled run goes to review at finish (M4)", () => {
		const r = finishScope(
			["src/"],
			{ files: ["src/a.ts"], truncated: false },
			{ unsampled: true },
		);
		expect(r.outside).toBeGreaterThan(0);
		expect(r.unsampled).toBe(true);
	});

	test("a truncated listing warns live and kills in kill mode", () => {
		const policy = { ...DEFAULT_SCOPE_POLICY, mode: "kill" as const };
		const sample = assessScope(
			["src/a.ts"],
			{ owns: ["src/"], others: [] },
			policy,
			1,
			true,
		);
		expect(sample.level).toBe("violation");
		expect(scopeKill(sample, policy)).toBe("watchdog-files");
		expect(scopeKill(sample, { ...policy, mode: "warn" })).toBeNull();
	});
});

describe("H2: a WIP ref name outside the pattern is refused before the primary", () => {
	async function withBundle(wipName: string) {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "mfw-wip-h2-")));
		dirs.push(root);
		const src = join(root, "src");
		const primary = join(root, "primary");
		const run = join(root, "run");
		const scratch = join(root, "scratch");
		for (const d of [src, primary, join(run, "outbox"), scratch]) {
			mkdirSync(d, { recursive: true });
		}
		for (const d of [src, primary]) {
			await gitOk(["init", "-q", "-b", "main"], d);
			await gitOk(["config", "user.email", "t@t"], d);
			await gitOk(["config", "user.name", "t"], d);
		}
		writeFileSync(join(src, "a.txt"), "x\n");
		await gitOk(["add", "-A"], src);
		await gitOk(["commit", "-q", "-m", "c"], src);
		await gitOk(["update-ref", "refs/heads/mfw/r1", "HEAD"], src);
		await gitOk(
			["update-ref", `refs/heads/mfw-wip/r1/${wipName}`, "HEAD"],
			src,
		);
		await gitOk(
			[
				"bundle",
				"create",
				join(run, "outbox/result.bundle"),
				"refs/heads/mfw/r1",
				"--glob=refs/heads/mfw-wip/r1/*",
			],
			src,
		);
		const host = new HostGit({
			workspaceRoot: join(root, "workspaces"),
			ownedRoots: [scratch],
		});
		const attempt = () =>
			fetchRunResult({
				host,
				primaryRepo: primary,
				outboxRoot: run,
				bundleRel: "outbox/result.bundle",
				runId: "r1",
				scratchRoot: scratch,
				assertProcessesDead: () => {},
				validate: unsafeNoValidation,
			});
		const refs = async () =>
			(
				await gitOk(
					["for-each-ref", "--format=%(refname)", "refs/mfw/"],
					primary,
				)
			)
				.split("\n")
				.filter(Boolean);
		const objects = async () => gitOk(["count-objects"], primary);
		return { primary, attempt, refs, objects };
	}

	test("two attempts are refused as validation and leave no ref or object", async () => {
		const b = await withBundle("a.b");
		const before = await b.objects();
		expect(await refusal(b.attempt())).toBe("validation");
		expect(await refusal(b.attempt())).toBe("validation");
		expect(await b.refs()).toEqual([]);
		expect(await b.objects()).toBe(before);
	});

	test("a normal WIP name still imports", async () => {
		const b = await withBundle("1");
		expect(await refusal(b.attempt())).toBeNull();
		expect(await b.refs()).toContain("refs/mfw/quarantine-wip/r1/1");
		expect((await b.refs()).filter((r) => r.includes("incoming"))).toEqual([]);
	});

	test("the boot sweep removes refs an older import leaked, whatever their name", async () => {
		const b = await withBundle("1");
		await b.attempt();
		const sha = await gitOk(["rev-parse", "refs/mfw/quarantine/r1"], b.primary);
		for (const r of [
			"refs/mfw/incoming/aa/head",
			"refs/mfw/incoming/aa/wip/a.b",
		]) {
			await gitOk(["update-ref", r, sha], b.primary);
		}
		await sweepIncomingRefs(b.primary);
		expect((await b.refs()).filter((r) => r.includes("incoming"))).toEqual([]);
		expect(await b.refs()).toContain("refs/mfw/quarantine/r1");
	});
});

describe("M2: symlink targets resolve against the result tree", () => {
	const LINK = "120000";
	async function verdict(links: Record<string, string>) {
		const b = await bare();
		const entries: [string, string, string][] = [
			[EMPTY_MODE, "a.txt", b.one],
			[EMPTY_MODE, "d/file.txt", b.one],
		];
		for (const [path, target] of Object.entries(links)) {
			entries.push([LINK, path, await b.blob(target)]);
		}
		await b.commit(entries, b.ctx.headRef, b.base);
		return refusal(validateRunResult(b.ctx, b.base));
	}

	test("a chain through a symlink cannot climb out", async () => {
		expect(
			await verdict({ "d/l1": "..", "d/l2": "l1/../../outside-secret" }),
		).toBe("validation");
	});

	test("a target through a symlinked directory cannot climb out", async () => {
		expect(await verdict({ "e/f/up": "../..", "e/f/out": "up/../x" })).toBe(
			"validation",
		);
	});

	test.each([
		".git/config",
		"d/.git/hooks/pre-commit",
		"../.GIT/config",
	])("a target inside %s is refused", async (target) => {
		expect(await verdict({ "d/l": target })).toBe("validation");
	});

	test("a symlink loop is refused", async () => {
		expect(await verdict({ "d/x": "y", "d/y": "x" })).toBe("validation");
	});

	test("ordinary relative links and chains still pass", async () => {
		expect(
			await verdict({
				"d/up": "../a.txt",
				"d/near": "file.txt",
				"chain-a": "chain-b",
				"chain-b": "d/file.txt",
				"dir-link": "d",
				through: "dir-link/file.txt",
			}),
		).toBeNull();
	});
});

describe("L3: protected names are matched as a checkout would see them", () => {
	test.each([
		".GitAttributes",
		".GITMODULES",
		".LfsConfig",
		".gitattributes.",
		".gitattributes ",
		".gitattributes::$DATA",
		"GITATT~1",
		"gitmod~1",
		"sub/.GITATTRIBUTES",
		".git‌attributes",
		".gitmodules/inner.txt",
	])("%j is refused", async (path) => {
		const b = await bare();
		await b.commit(
			[
				[EMPTY_MODE, "a.txt", b.one],
				[EMPTY_MODE, path, b.one],
			],
			b.ctx.headRef,
			b.base,
		);
		expect(await refusal(validateRunResult(b.ctx, b.base))).toBe("validation");
	});

	test.each([
		"gitattributes.md",
		"docs/my.gitmodules",
		"x.lfsconfig",
	])("%j is an ordinary file", async (path) => {
		const b = await bare();
		await b.commit(
			[
				[EMPTY_MODE, "a.txt", b.one],
				[EMPTY_MODE, path, b.one],
			],
			b.ctx.headRef,
			b.base,
		);
		expect(await refusal(validateRunResult(b.ctx, b.base))).toBeNull();
	});
});

describe("B1 audit: other capped reads behind a decision", () => {
	/** A work tree whose index lists many long paths that are not on disk. */
	async function longStatus() {
		const b = await bare();
		const repo = join(b.root, "wt");
		mkdirSync(repo);
		await gitOk(["init", "-q", "-b", "main"], repo);
		await gitOk(["config", "user.email", "t@t"], repo);
		await gitOk(["config", "user.name", "t"], repo);
		writeFileSync(join(repo, "a.txt"), "a\n");
		await gitOk(["add", "-A"], repo);
		await gitOk(["commit", "-q", "-m", "c"], repo);
		const sha = await gitOk(["rev-parse", "HEAD:a.txt"], repo);
		const p = Bun.spawn(
			["git", "update-index", "--add", "-z", "--index-info"],
			{
				cwd: repo,
				stdin: new TextEncoder().encode(
					fillers(19_000, sha)
						.map(([m, path, s]) => `${m} ${s}\t${path}\0`)
						.join(""),
				),
			},
		);
		expect(await p.exited).toBe(0);
		return repo;
	}

	test("the decision-rights listing is whole, or unknown past the cap", async () => {
		const b = await bare();
		const head = await b.commit(
			[
				[EMPTY_MODE, "a.txt", b.one],
				[EMPTY_MODE, "a-first.txt", b.one],
				...fillers(19_000, b.one),
			],
			"refs/heads/run",
			b.base,
		);
		expect(await branchChangedFiles(b.repo, b.base, head)).toContain(
			"a-first.txt",
		);
		const over = await b.commit(
			[[EMPTY_MODE, "a.txt", b.one], ...fillers(MAX_SCOPE_PATHS + 5, b.one)],
			"refs/heads/over",
			b.base,
		);
		expect(await branchChangedFiles(b.repo, b.base, over)).toBeNull();
	}, 60_000);

	test("the agent-review tamper check never matches on a cut status", async () => {
		const repo = await longStatus();
		const before = await worktreeState(repo);
		const after = await worktreeState(repo);
		expect(before).not.toBeNull();
		expect(after).not.toBe(before);
	}, 60_000);

	test("a remote stage refuses a listing past the output cap", async () => {
		const repo = await longStatus();
		await expect(
			listWorkspacePaths(["ls-files", "--cached", "-z"], repo),
		).rejects.toBeInstanceOf(RemoteWorkspaceError);
	}, 60_000);
});
