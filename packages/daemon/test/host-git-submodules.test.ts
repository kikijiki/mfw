import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { HostGit } from "../src/host-git/runner.ts";
import {
	parseGitmodules,
	planSubmoduleSeeds,
	urlAllowed,
	urlScheme,
} from "../src/host-git/submodules.ts";
import {
	commitSpec,
	newBareRepo,
	type TreeSpec,
} from "./fixtures/hostile-tree.ts";

const roots: string[] = [];
afterEach(async () => {
	for (const d of roots.splice(0))
		await rm(d, { recursive: true, force: true });
});

const SHA = "c".repeat(40);
const mods = (url: string, extra = "") =>
	`[submodule "lib"]\n\tpath = lib\n\turl = ${url}\n${extra}`;

async function plan(spec: TreeSpec, allowlist: string[]) {
	const { root, repo } = await newBareRepo();
	roots.push(root);
	const baseSha = await commitSpec(repo, spec);
	const host = new HostGit({
		workspaceRoot: join(root, "ws"),
		ownedRoots: [root],
	});
	return planSubmoduleSeeds({ host, primaryRepo: repo, baseSha, allowlist });
}

const tree = (url: string, extra = ""): TreeSpec => ({
	"README.md": "x",
	".gitmodules": mods(url, extra),
	lib: { mode: "160000", sha: SHA },
});

describe("urlScheme", () => {
	test("accepts https, ssh, git and scp-like urls", () => {
		expect(urlScheme("https://example.invalid/a.git")).toEqual({
			scheme: "https",
		});
		expect(urlScheme("ssh://git@example.invalid/a.git")).toEqual({
			scheme: "ssh",
		});
		expect(urlScheme("git@example.invalid:a/b.git")).toEqual({ scheme: "ssh" });
		expect(urlScheme("git://example.invalid/a.git")).toEqual({ scheme: "git" });
	});

	test("refuses ext, file, relative, local and dash urls", () => {
		for (const u of [
			"ext::sh -c id",
			"file:///etc",
			"../x",
			"./x",
			"/srv/repo",
			"-u./x",
			"",
			"fd::3",
			"https://a b/c",
		]) {
			expect("code" in urlScheme(u)).toBe(true);
		}
	});
});

describe("urlAllowed", () => {
	test("exact and prefix entries", () => {
		expect(urlAllowed("https://h/a.git", ["https://h/a.git"])).toBe(true);
		expect(urlAllowed("https://h/b.git", ["https://h/a.git"])).toBe(false);
		expect(urlAllowed("https://h/org/b.git", ["https://h/org/*"])).toBe(true);
		expect(urlAllowed("https://h/organ/b.git", ["https://h/org/*"])).toBe(
			false,
		);
		expect(urlAllowed("https://h.evil/org/b", ["https://h/org/*"])).toBe(false);
		expect(urlAllowed("https://h/a.git", [])).toBe(false);
	});
});

describe("parseGitmodules", () => {
	test("parses sections and keys", () => {
		expect(parseGitmodules(mods("https://h/a", "\tupdate = rebase\n"))).toEqual(
			[{ name: "lib", path: "lib", url: "https://h/a", update: "rebase" }],
		);
	});

	test("throws on text it cannot read exactly", () => {
		for (const t of [
			"garbage\n",
			'[submodule "a"]\n\turl = "x"\n',
			'[submodule "a"]\n\turl = x \\\n',
			"[submodule a]\n",
			"path = x\n",
			'[submodule "a"]\n\turl = x # c\n',
		]) {
			expect(() => parseGitmodules(t)).toThrow();
		}
	});
});

describe("planSubmoduleSeeds", () => {
	test("plans an allowlisted https submodule", async () => {
		const p = await plan(tree("https://example.invalid/lib.git"), [
			"https://example.invalid/*",
		]);
		expect(p.refusals).toEqual([]);
		expect(p.seeds).toHaveLength(1);
		expect(p.seeds[0]).toMatchObject({
			scheme: "https",
			protocolOverride: "protocol.https.allow=always",
			entry: { path: "lib", sha: SHA, url: "https://example.invalid/lib.git" },
		});
	});

	test("a repo without submodules plans nothing", async () => {
		const p = await plan({ "README.md": "x" }, []);
		expect(p).toEqual({ seeds: [], refusals: [] });
	});

	test("refuses a url that is not on the allowlist", async () => {
		const p = await plan(tree("https://example.invalid/lib.git"), []);
		expect(p.seeds).toEqual([]);
		expect(p.refusals.map((r) => r.code)).toEqual(["not_allowlisted"]);
	});

	test("refuses dangerous urls even when the allowlist names them", async () => {
		for (const url of ["ext::sh -c id", "file:///etc", "../../x", "-u./x"]) {
			const p = await plan(tree(url), [url]);
			expect(p.seeds).toEqual([]);
			expect(p.refusals).toHaveLength(1);
		}
	});

	test("refuses update = !command", async () => {
		const p = await plan(
			tree("https://example.invalid/lib.git", "\tupdate = !touch x\n"),
			["https://example.invalid/*"],
		);
		expect(p.refusals.map((r) => r.code)).toEqual(["update_command"]);
	});

	test("refuses a gitlink with no .gitmodules entry and the reverse", async () => {
		const orphan = await plan({ lib: { mode: "160000", sha: SHA } }, []);
		expect(orphan.refusals.map((r) => r.code)).toEqual(["no_gitlink"]);
		const noLink = await plan(
			{ ".gitmodules": mods("https://example.invalid/lib.git") },
			["https://example.invalid/*"],
		);
		expect(noLink.refusals.map((r) => r.code)).toEqual(["no_gitlink"]);
	});

	test("refuses an unparseable .gitmodules and a traversing path", async () => {
		const bad = await plan(
			{ ".gitmodules": "[nope\n", lib: { mode: "160000", sha: SHA } },
			[],
		);
		expect(bad.refusals.map((r) => r.code)).toContain("bad_gitmodules");
		const up = await plan(
			{
				".gitmodules":
					'[submodule "x"]\n\tpath = ../x\n\turl = https://example.invalid/a\n',
			},
			["https://example.invalid/*"],
		);
		expect(up.refusals.map((r) => r.code)).toContain("bad_path");
	});
});
