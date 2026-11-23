import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitComplete, gitOk } from "../src/git.ts";
import { HostGit, HostGitError } from "../src/host-git/runner.ts";
import { validateRunResult } from "../src/run-workspace/clone-impl.ts";
import {
	assessScope,
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
