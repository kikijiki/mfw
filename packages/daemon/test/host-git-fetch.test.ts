import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	fetchRunResult,
	quarantineRef,
	sandboxBundleArgv,
} from "../src/host-git/fetch.ts";
import { HostGit, HostGitError } from "../src/host-git/runner.ts";
import { deltaBombBundle } from "./fixtures/delta-bomb.ts";
import {
	buildHonestRepo,
	buildTamperedClone,
	type GitdirBypass,
	makeBundle,
	plainGit,
	plantAlternates,
	plantGitdirBypass,
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
		bundlePath: t.bundle,
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

	test("--upload-pack= paths are refused before git runs", async () => {
		const t = await fixture();
		const marker = join(t.root, "pwned");
		for (const extra of [
			{ bundlePath: `--upload-pack=touch ${marker}` },
			{ primaryRepo: "--upload-pack=x" },
		]) {
			expect(await codeOf(fetchRunResult(fetchOpts(t, extra)))).toBe(
				"option_injection",
			);
		}
		expect(
			await codeOf(fetchRunResult(fetchOpts(t, { bundlePath: "rel.bundle" }))),
		).toBe("bad_argument");
		expect(await Bun.file(marker).exists()).toBe(false);
	});

	test("dash and malformed run ids are refused", async () => {
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
});

describe("gitdir redirection bypasses (security review H1)", () => {
	// The host no longer reads the clone's gitdir at all, so no tamper of it can
	// redirect the import: the bundle written before the tamper is what lands.
	const kinds: (GitdirBypass | "alternates" | "http-alternates")[] = [
		"commondir",
		"pack-symlink",
		"pack-and-ref-symlink",
		"decoy-dotgit",
		"alternates",
		"http-alternates",
	];
	for (const kind of kinds) {
		test(`${kind}: the secret from another repo never reaches the primary`, async () => {
			const t = await fixture();
			const tip = await plainGit(
				["rev-parse", `mfw/${t.runId}`],
				t.primary,
			).catch(() => "");
			expect(tip).toBe("");
			if (kind === "alternates" || kind === "http-alternates") {
				await plantAlternates(t, kind);
			} else {
				await plantGitdirBypass(t, kind);
			}
			const res = await fetchRunResult(fetchOpts(t));
			const leaked = await plainGit(
				["cat-file", "-e", t.secretSha],
				t.primary,
			).then(
				() => true,
				() => false,
			);
			expect(leaked).toBe(false);
			expect(await readFile(t.canaryLog, "utf8")).toBe("");
			expect(res.tip).not.toBe(t.secretSha);
			expect(await plainGit(["show", `${res.tip}:work.txt`], t.primary)).toBe(
				"agent work",
			);
		});
	}
});

describe("hostile bundles", () => {
	test("a symlinked bundle is refused, even to a valid bundle", async () => {
		const t = await fixture();
		const link = join(t.workspaceRoot, "outbox", "link.bundle");
		await symlink(t.bundle, link);
		expect(
			await codeOf(fetchRunResult(fetchOpts(t, { bundlePath: link }))),
		).toBe("bad_bundle");
	});

	test("a directory, a gitdir or a fifo is not a bundle", async () => {
		const t = await fixture();
		for (const p of [t.clone, join(t.clone, ".git"), t.secret]) {
			expect(
				await codeOf(fetchRunResult(fetchOpts(t, { bundlePath: p }))),
			).toBe("bad_bundle");
		}
		const fifo = join(t.workspaceRoot, "outbox", "fifo.bundle");
		const mk = Bun.spawnSync(["mkfifo", fifo]);
		if (mk.exitCode === 0) {
			expect(
				await codeOf(fetchRunResult(fetchOpts(t, { bundlePath: fifo }))),
			).toBe("bad_bundle");
		}
		expect(readdirSync(t.scratchRoot)).toEqual([]);
	});

	test("garbage and truncated headers are refused", async () => {
		const t = await fixture();
		const bad = join(t.workspaceRoot, "outbox", "bad.bundle");
		for (const body of [
			"hello\n\n",
			"# v2 git bundle\n" + "0".repeat(40) + " refs/heads/x",
			"# v2 git bundle\nnot-a-ref-line\n\n",
			"# v3 git bundle\n@filter=blob:none\n\n",
		]) {
			await writeFile(bad, body);
			expect(
				await codeOf(fetchRunResult(fetchOpts(t, { bundlePath: bad }))),
			).toBe("bad_bundle");
		}
	});

	test("a header that lies about its pack fails the fsck fetch and imports nothing", async () => {
		const t = await fixture();
		const real = await readFile(t.bundle);
		const bad = join(t.workspaceRoot, "outbox", "trunc.bundle");
		await writeFile(bad, real.subarray(0, real.length - 20));
		const before = await refs(t.primary);
		expect(
			await codeOf(fetchRunResult(fetchOpts(t, { bundlePath: bad }))),
		).toBe("bad_bundle");
		expect(await refs(t.primary)).toEqual(before);
		expect(readdirSync(t.scratchRoot)).toEqual([]);
	});

	test("size and ref-count caps", async () => {
		const t = await fixture();
		expect(
			await codeOf(fetchRunResult(fetchOpts(t, { maxBundleBytes: 10 }))),
		).toBe("bad_bundle");
		expect(await codeOf(fetchRunResult(fetchOpts(t, { maxRefs: 1 })))).toBe(
			"bad_bundle",
		);
	});

	test("a bundle with prerequisites is refused", async () => {
		const t = await fixture();
		const honest = await buildHonestRepo(t);
		const out = join(t.workspaceRoot, "outbox", "thin.bundle");
		await makeBundle(honest, out, [
			`refs/heads/mfw/${t.runId}`,
			"^refs/heads/main",
		]);
		expect(
			await codeOf(fetchRunResult(fetchOpts(t, { bundlePath: out }))),
		).toBe("bad_bundle");
	});

	test("foreign refs and tags in a bundle are ignored", async () => {
		const t = await fixture();
		const honest = await buildHonestRepo(t);
		const out = join(t.workspaceRoot, "outbox", "all.bundle");
		await makeBundle(honest, out, ["--all"]);
		const before = await refs(t.primary);
		await fetchRunResult(fetchOpts(t, { bundlePath: out }));
		const added = (await refs(t.primary)).filter((r) => !before.includes(r));
		expect(added).toEqual([
			"refs/mfw/quarantine-wip/run1/1",
			"refs/mfw/quarantine/run1",
		]);
	});

	test("a bundle without the run branch is reported", async () => {
		const t = await fixture();
		const honest = await buildHonestRepo(t);
		const out = join(t.workspaceRoot, "outbox", "nohead.bundle");
		await makeBundle(honest, out, ["refs/heads/foreign-branch"]);
		expect(
			await codeOf(fetchRunResult(fetchOpts(t, { bundlePath: out }))),
		).toBe("no_branch");
	});

	test("the sandbox helper command produces what the host accepts", async () => {
		const t = await fixture();
		const honest = await buildHonestRepo(t);
		const out = join(t.workspaceRoot, "outbox", "helper.bundle");
		await mkdir(join(t.workspaceRoot, "outbox"), { recursive: true });
		await plainGit(sandboxBundleArgv(t.runId, out).slice(1), honest);
		const res = await fetchRunResult(fetchOpts(t, { bundlePath: out }));
		expect(res.wipRefs).toHaveLength(1);
	});
});

describe("host memory bound (security review B1)", () => {
	test("a small delta-bomb bundle is refused under the memory cap and imports nothing", async () => {
		const t = await fixture();
		// 64 x 16 MiB = 1 GiB inflated from a bundle of a few KiB.
		const bomb = deltaBombBundle(`refs/heads/mfw/${t.runId}`, 64);
		expect(bomb.length).toBeLessThan(64 * 1024);
		const out = join(t.workspaceRoot, "outbox", "bomb.bundle");
		await writeFile(out, bomb);
		const before = await refs(t.primary);
		expect(
			await codeOf(
				fetchRunResult(
					fetchOpts(t, {
						bundlePath: out,
						host: new HostGit({
							workspaceRoot: t.workspaceRoot,
							ownedRoots: [t.scratchRoot],
							maxMemoryBytes: 512 * 1024 * 1024,
						}),
					}),
				),
			),
		).toBe("bad_bundle");
		expect(await refs(t.primary)).toEqual(before);
		expect(readdirSync(t.scratchRoot)).toEqual([]);
	}, 60_000);

	test("a normal bundle still imports under the same cap", async () => {
		const t = await fixture();
		const res = await fetchRunResult(
			fetchOpts(t, {
				host: new HostGit({
					workspaceRoot: t.workspaceRoot,
					ownedRoots: [t.scratchRoot],
					maxMemoryBytes: 512 * 1024 * 1024,
				}),
			}),
		);
		expect(res.tip).toMatch(/^[0-9a-f]{40}$/);
	});
});
