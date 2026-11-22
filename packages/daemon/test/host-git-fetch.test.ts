import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { readFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import {
	assertNoAlternates,
	fetchRunResult,
	quarantineRef,
} from "../src/host-git/fetch.ts";
import { HostGit, HostGitError } from "../src/host-git/runner.ts";
import {
	buildTamperedClone,
	plainGit,
	plantAlternates,
	type TamperedClone,
} from "./fixtures/tampered-clone.ts";

const roots: string[] = [];
afterEach(async () => {
	for (const d of roots.splice(0))
		await rm(d, { recursive: true, force: true });
});

async function fixture(runId = "run1"): Promise<TamperedClone> {
	const t = await buildTamperedClone(runId);
	roots.push(t.root);
	return t;
}

const host = (t: TamperedClone) =>
	new HostGit({ workspaceRoot: t.workspaceRoot, ownedRoots: [t.scratchRoot] });

const dead = () => {};

function fetchOpts(t: TamperedClone, extra: Record<string, unknown> = {}) {
	return {
		host: host(t),
		primaryRepo: t.primary,
		clonePath: t.clone,
		runId: t.runId,
		scratchRoot: t.scratchRoot,
		assertProcessesDead: dead,
		...extra,
	};
}

async function refs(repo: string): Promise<string[]> {
	const out = await plainGit(["for-each-ref", "--format=%(refname)"], repo);
	return out.split("\n").filter(Boolean).sort();
}

async function codeOf(p: Promise<unknown>): Promise<string> {
	try {
		await p;
	} catch (e) {
		if (e instanceof HostGitError) return e.code;
		throw e;
	}
	return "none";
}

describe("control: the tampered clone is armed", () => {
	test("a bare git status in the clone fires the canary", async () => {
		const t = await fixture();
		await plainGit(["status"], t.clone).catch(() => {});
		expect((await readFile(t.canaryLog, "utf8")).length).toBeGreaterThan(0);
	});
});

describe("fetchRunResult", () => {
	test("imports only the quarantine refs and runs nothing", async () => {
		const t = await fixture();
		const before = await refs(t.primary);
		const res = await fetchRunResult(fetchOpts(t));

		expect(await readFile(t.canaryLog, "utf8")).toBe("");
		const after = await refs(t.primary);
		const added = after.filter((r) => !before.includes(r));
		expect(added).toEqual([
			"refs/mfw/quarantine-wip/run1/1",
			quarantineRef("run1"),
		]);
		expect(after.filter((r) => before.includes(r))).toEqual(before);
		expect(res.quarantineRef).toBe("refs/mfw/quarantine/run1");
		expect(res.tip).toBe(
			await plainGit(["rev-parse", "refs/mfw/quarantine/run1"], t.primary),
		);
		expect(res.wipRefs.map((w) => w.ref)).toEqual([
			"refs/mfw/quarantine-wip/run1/1",
		]);
		// objects arrived intact and the primary is still consistent
		await plainGit(["fsck", "--no-dangling"], t.primary);
		expect(await plainGit(["show", `${res.tip}:work.txt`], t.primary)).toBe(
			"agent work",
		);
	});

	test("foreign refs, tags and the clone's config never reach the primary", async () => {
		const t = await fixture();
		await fetchRunResult(fetchOpts(t));
		const all = (await refs(t.primary)).join("\n");
		for (const bad of ["foreign-branch", "foreign-tag", "other", "evil"]) {
			expect(all).not.toContain(bad);
		}
		const cfg = await plainGit(["config", "--local", "--list"], t.primary);
		expect(cfg).not.toContain("canary");
	});

	test("no throwaway repo is left behind after a success", async () => {
		const t = await fixture();
		await fetchRunResult(fetchOpts(t));
		expect(readdirSync(t.scratchRoot)).toEqual([]);
	});

	test("a missing run branch is reported, with nothing imported", async () => {
		const t = await fixture();
		const before = await refs(t.primary);
		expect(
			await codeOf(fetchRunResult(fetchOpts(t, { runId: "nothere" }))),
		).toBe("no_branch");
		expect(await refs(t.primary)).toEqual(before);
		expect(readdirSync(t.scratchRoot)).toEqual([]);
	});

	test("the validation hook runs on the bare repo before the primary changes", async () => {
		const t = await fixture();
		const before = await refs(t.primary);
		let seenBare = "";
		let seenBefore: string[] = [];
		expect(
			await codeOf(
				fetchRunResult(
					fetchOpts(t, {
						validate: async (ctx: { bareRepo: string; wipRefs: string[] }) => {
							seenBare = ctx.bareRepo;
							seenBefore = await refs(t.primary);
							expect(ctx.wipRefs).toEqual(["refs/mfw/run/wip/1"]);
							throw new Error("nope");
						},
					}),
				),
			),
		).toBe("validation");
		expect(seenBare.startsWith(t.scratchRoot)).toBe(true);
		expect(seenBefore).toEqual(before);
		expect(await refs(t.primary)).toEqual(before);
		expect(readdirSync(t.scratchRoot)).toEqual([]);
	});
});

describe("fetchRunResult refusals", () => {
	for (const kind of ["alternates", "http-alternates"] as const) {
		test(`${kind} (the exfiltration case) is refused`, async () => {
			const t = await fixture();
			await plantAlternates(t, kind);
			const before = await refs(t.primary);
			expect(await codeOf(fetchRunResult(fetchOpts(t)))).toBe("alternates");
			expect(await refs(t.primary)).toEqual(before);
			const has = await plainGit(
				["cat-file", "-e", t.secretSha],
				t.primary,
			).then(
				() => true,
				() => false,
			);
			expect(has).toBe(false);
			expect(await readFile(t.canaryLog, "utf8")).toBe("");
		});
	}

	test("a symlinked objects dir or .git is refused", async () => {
		const t = await fixture();
		await rm(join(t.clone, ".git", "objects"), { recursive: true });
		await symlink(
			join(t.secret, ".git", "objects"),
			join(t.clone, ".git", "objects"),
		);
		expect(() => assertNoAlternates(t.clone)).toThrow(HostGitError);
	});

	test("the precondition runs first and its failure aborts everything", async () => {
		const t = await fixture();
		const before = await refs(t.primary);
		let ran = false;
		expect(
			await codeOf(
				fetchRunResult(
					fetchOpts(t, {
						assertProcessesDead: () => {
							ran = true;
							throw new Error("cgroup still has 2 pids");
						},
					}),
				),
			),
		).toBe("precondition");
		expect(ran).toBe(true);
		expect(await refs(t.primary)).toEqual(before);
		expect(readdirSync(t.scratchRoot)).toEqual([]);
	});

	test("--upload-pack= urls are refused before git runs", async () => {
		const t = await fixture();
		const marker = join(t.root, "pwned");
		expect(
			await codeOf(
				fetchRunResult(
					fetchOpts(t, { clonePath: `--upload-pack=touch ${marker}` }),
				),
			),
		).toBe("option_injection");
		expect(
			await codeOf(
				fetchRunResult(fetchOpts(t, { primaryRepo: "--upload-pack=x" })),
			),
		).toBe("option_injection");
		expect(
			await codeOf(
				fetchRunResult(fetchOpts(t, { clonePath: "relative/clone" })),
			),
		).toBe("bad_argument");
		expect(await Bun.file(marker).exists()).toBe(false);
	});

	test("dash and malformed run ids and wip prefixes are refused", async () => {
		const t = await fixture();
		for (const runId of [
			"--upload-pack=x",
			"-x",
			"a/b",
			"a..b",
			"a b",
			"",
			"x:y",
			"a*",
		]) {
			expect(await codeOf(fetchRunResult(fetchOpts(t, { runId })))).toBe(
				"bad_run_id",
			);
		}
		for (const wipSourcePrefix of [
			"--x/",
			"refs/heads/../x/",
			"refs/heads/x",
		]) {
			expect(
				await codeOf(fetchRunResult(fetchOpts(t, { wipSourcePrefix }))),
			).toBe("bad_argument");
		}
	});

	test("a primary or scratch root under the workspace root is refused", async () => {
		const t = await fixture();
		expect(
			await codeOf(fetchRunResult(fetchOpts(t, { primaryRepo: t.clone }))),
		).toBe("path_under_workspace");
		expect(
			await codeOf(
				fetchRunResult(
					fetchOpts(t, { scratchRoot: join(t.workspaceRoot, "scratch") }),
				),
			),
		).toBe("path_under_workspace");
		expect(await readFile(t.canaryLog, "utf8")).toBe("");
	});

	test("a clone outside the owned roots is refused", async () => {
		const t = await fixture();
		expect(
			await codeOf(fetchRunResult(fetchOpts(t, { clonePath: t.secret }))),
		).toBe("bad_argument");
	});
});
