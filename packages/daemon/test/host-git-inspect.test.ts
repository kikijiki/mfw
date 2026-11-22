import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fetchRunResult, sandboxBundleArgv } from "../src/host-git/fetch.ts";
import {
	badPathReason,
	badSymlinkReason,
	type Finding,
	type FindingCode,
	inspectResult,
	isDotGit,
	resultValidator,
} from "../src/host-git/inspect.ts";
import { HostGit, HostGitError } from "../src/host-git/runner.ts";
import {
	commitSpec,
	git,
	newBareRepo,
	type TreeSpec,
} from "./fixtures/hostile-tree.ts";
import {
	buildHonestRepo,
	buildTamperedClone,
	makeBundle,
	plainGit,
} from "./fixtures/tampered-clone.ts";

const roots: string[] = [];
afterEach(async () => {
	for (const d of roots.splice(0))
		await rm(d, { recursive: true, force: true });
});

const HEAD = "refs/mfw/run/head";
const BASE_FILES: TreeSpec = { "README.md": "hello\n", "src/a.ts": "a\n" };

async function setup(
	base: TreeSpec,
	head: TreeSpec,
	wip: Record<string, TreeSpec> = {},
) {
	const { root, repo } = await newBareRepo();
	roots.push(root);
	const baseSha = await commitSpec(repo, base);
	await commitSpec(repo, head, { parent: baseSha, ref: HEAD });
	const wipRefs: string[] = [];
	for (const [n, spec] of Object.entries(wip)) {
		const ref = `refs/mfw/run/wip/${n}`;
		await commitSpec(repo, spec, { parent: baseSha, ref });
		wipRefs.push(ref);
	}
	const host = new HostGit({
		workspaceRoot: join(root, "ws"),
		ownedRoots: [root],
	});
	return { root, repo, baseSha, host, wipRefs };
}

async function inspect(
	base: TreeSpec,
	head: TreeSpec,
	wip: Record<string, TreeSpec> = {},
) {
	const s = await setup(base, head, wip);
	return inspectResult({
		host: s.host,
		repo: s.repo,
		baseSha: s.baseSha,
		headRef: HEAD,
		wipRefs: s.wipRefs,
	});
}

const codes = (fs: Finding[], sev?: string): FindingCode[] =>
	fs.filter((f) => !sev || f.severity === sev).map((f) => f.code);

describe("path rules", () => {
	test("pure checks", () => {
		expect(badPathReason("a/b/c.txt")).toBeUndefined();
		expect(badPathReason("a/../b")).toBeDefined();
		expect(badPathReason("../x")).toBeDefined();
		expect(badPathReason("/etc/passwd")).toBeDefined();
		expect(badPathReason("a//b")).toBeDefined();
		expect(badPathReason("a/./b")).toBeDefined();
		expect(badPathReason("a\\b")).toBeDefined();
		expect(badPathReason(".git/config")).toBeDefined();
		expect(badPathReason("sub/.GIT/hooks/pre-commit")).toBeDefined();
		expect(badPathReason(".gitignore")).toBeUndefined();
		expect(badPathReason(".github/x")).toBeUndefined();
		expect(isDotGit("git~1")).toBe(true);
		expect(isDotGit(".git ")).toBe(true);
		expect(isDotGit(".g‌it")).toBe(true);
		expect(isDotGit(".gitmodules")).toBe(false);
	});

	test("symlink targets", () => {
		expect(badSymlinkReason("a/l", "../b")).toBeUndefined();
		expect(badSymlinkReason("a/l", "b/c")).toBeUndefined();
		expect(badSymlinkReason("a/l", "../../b")).toBeDefined();
		expect(badSymlinkReason("l", "..")).toBeDefined();
		expect(badSymlinkReason("l", "/etc/passwd")).toBeDefined();
		expect(badSymlinkReason("l", "")).toBeDefined();
		expect(badSymlinkReason("l", ".git/hooks")).toBeDefined();
		expect(badSymlinkReason("a/l", "../.git")).toBeDefined();
		expect(badSymlinkReason("l", "a/../..")).toBeDefined();
		expect(badSymlinkReason("l", "a/..")).toBeUndefined();
	});

	test("an honest change passes clean", async () => {
		const r = await inspect(BASE_FILES, { ...BASE_FILES, "src/b.ts": "b\n" });
		expect(r.findings).toEqual([]);
		expect(r.refused).toBe(false);
		expect(r.lfs.detected).toBe(false);
	});

	test("refuses `..`, `.git` and absolute paths in the tree", async () => {
		for (const path of [
			"a/../x",
			".git/config",
			"sub/.GIT/hooks/post-checkout",
		]) {
			const r = await inspect(BASE_FILES, { ...BASE_FILES, [path]: "x" });
			expect(codes(r.findings, "refuse")).toContain("bad_path");
			expect(r.refused).toBe(true);
		}
	});

	test("checks the WIP refs too", async () => {
		const r = await inspect(BASE_FILES, BASE_FILES, {
			"1": { ...BASE_FILES, "a/../x": "x" },
		});
		const f = r.findings.find((x) => x.code === "bad_path");
		expect(f?.ref).toBe("refs/mfw/run/wip/1");
		expect(r.refused).toBe(true);
	});
});

describe("symlinks", () => {
	const link = (target: string): TreeSpec => ({
		...BASE_FILES,
		"src/l": { mode: "120000", content: target },
	});

	test("a link inside the tree is fine", async () => {
		const r = await inspect(BASE_FILES, link("a.ts"));
		expect(r.refused).toBe(false);
	});

	test("refuses absolute, escaping and .git targets", async () => {
		for (const t of ["/etc/passwd", "../../x", "../.git/config"]) {
			const r = await inspect(BASE_FILES, link(t));
			expect(codes(r.findings, "refuse")).toContain("bad_symlink");
		}
	});

	test("refuses an oversize target", async () => {
		const r = await inspect(BASE_FILES, link("a".repeat(5000)));
		expect(codes(r.findings, "refuse")).toContain("bad_symlink");
	});
});

describe("modes against the base", () => {
	test("flags a type change and an exec bit change", async () => {
		const r = await inspect(
			{ ...BASE_FILES, run: { mode: "100644", content: "r" } },
			{
				...BASE_FILES,
				run: { mode: "100755", content: "r" },
				"src/a.ts": { mode: "120000", content: "../README.md" },
			},
		);
		expect(codes(r.findings, "flag").sort()).toEqual([
			"mode_change",
			"type_change",
		]);
		expect(r.refused).toBe(false);
	});
});

describe("gitlinks and .gitmodules", () => {
	const SHA_A = "a".repeat(40);
	const SHA_B = "b".repeat(40);
	const mods = (url: string) =>
		`[submodule "lib"]\n\tpath = lib\n\turl = ${url}\n`;
	const withSub = (sha: string, url: string): TreeSpec => ({
		...BASE_FILES,
		".gitmodules": mods(url),
		lib: { mode: "160000", sha },
	});

	test("unchanged submodules pass", async () => {
		const s = withSub(SHA_A, "https://example.invalid/lib.git");
		const r = await inspect(s, { ...s, "src/b.ts": "b" });
		expect(r.findings).toEqual([]);
	});

	test("refuses a changed gitlink sha", async () => {
		const r = await inspect(
			withSub(SHA_A, "https://example.invalid/lib.git"),
			withSub(SHA_B, "https://example.invalid/lib.git"),
		);
		expect(codes(r.findings, "refuse")).toEqual(["gitlink_changed"]);
	});

	test("refuses a new gitlink and a removed one", async () => {
		const added = await inspect(BASE_FILES, {
			...BASE_FILES,
			lib: { mode: "160000", sha: SHA_A },
		});
		expect(codes(added.findings, "refuse")).toContain("gitlink_changed");
		const removed = await inspect(
			withSub(SHA_A, "https://example.invalid/lib.git"),
			{ ...BASE_FILES, ".gitmodules": mods("https://example.invalid/lib.git") },
		);
		expect(codes(removed.findings, "refuse")).toContain("gitlink_changed");
	});

	test("refuses every hostile .gitmodules url", async () => {
		const base = withSub(SHA_A, "https://example.invalid/lib.git");
		for (const url of [
			"ext::sh -c 'touch /tmp/pwn'",
			"file:///etc",
			"ssh://attacker.invalid/x",
			"../../other",
			"-u./payload",
		]) {
			const r = await inspect(base, { ...base, ".gitmodules": mods(url) });
			expect(codes(r.findings, "refuse")).toContain("gitmodules_changed");
		}
	});

	test("refuses `update = !cmd` and any other .gitmodules text", async () => {
		const base = withSub(SHA_A, "https://example.invalid/lib.git");
		const r = await inspect(base, {
			...base,
			".gitmodules": `${mods("https://example.invalid/lib.git")}\tupdate = !touch pwn\n`,
		});
		expect(codes(r.findings, "refuse")).toContain("gitmodules_changed");
	});

	test("refuses a .gitmodules added where the base had none", async () => {
		const r = await inspect(BASE_FILES, {
			...BASE_FILES,
			".gitmodules": mods("https://example.invalid/lib.git"),
		});
		expect(codes(r.findings, "refuse")).toContain("gitmodules_changed");
	});

	test("refuses a nested .gitmodules and a symlinked one", async () => {
		const nested = await inspect(BASE_FILES, {
			...BASE_FILES,
			"sub/.gitmodules": mods("ext::x"),
		});
		expect(codes(nested.findings, "refuse")).toContain("gitmodules_changed");
		const sym = await inspect(BASE_FILES, {
			...BASE_FILES,
			".gitmodules": { mode: "120000", content: "src/a.ts" },
		});
		expect(codes(sym.findings, "refuse")).toContain("special_file_symlink");
	});
});

describe("attributes and LFS", () => {
	const POINTER = (n: number) =>
		`version https://git-lfs.github.com/spec/v1\noid sha256:${String(n).padStart(64, "0")}\nsize 12345\n`;

	test("flags changed .gitattributes and .lfsconfig, which are not LFS by themselves", async () => {
		const r = await inspect(BASE_FILES, {
			...BASE_FILES,
			".gitattributes": "*.png binary\n",
			".lfsconfig": "[core]\n\tx = y\n",
		});
		expect(codes(r.findings, "flag").sort()).toEqual([
			"gitattributes_changed",
			"lfsconfig_changed",
		]);
		// .lfsconfig alone is LFS evidence by design.
		expect(r.lfs.lfsconfig).toEqual([".lfsconfig"]);
		expect(r.lfs.detected).toBe(true);
		expect(codes(r.findings, "refuse")).toEqual(["lfs"]);
	});

	test("detects filter=lfs in attributes", async () => {
		const r = await inspect(BASE_FILES, {
			...BASE_FILES,
			"sub/.gitattributes": "# c\n*.bin filter=lfs diff=lfs merge=lfs -text\n",
		});
		expect(r.lfs.attributes).toEqual(["sub/.gitattributes"]);
		expect(r.lfs.pointers).toEqual([]);
		expect(r.refused).toBe(true);
	});

	test("does not take lfs in a comment or another attribute for LFS", async () => {
		const r = await inspect(BASE_FILES, {
			...BASE_FILES,
			".gitattributes": "# filter=lfs\n*.x filter=lfsish\n",
		});
		expect(r.lfs.detected).toBe(false);
	});

	test("detects LFS already in the base, from pointer files alone", async () => {
		const files = { ...BASE_FILES, "assets/big.bin": POINTER(1) };
		const r = await inspect(files, { ...files, "src/b.ts": "b" });
		expect(r.lfs.pointers).toEqual(["assets/big.bin"]);
		expect(r.lfs.attributes).toEqual([]);
		expect(codes(r.findings, "refuse")).toEqual(["lfs"]);
	});

	test("a pointer scan is not fooled by non-ASCII neighbours or a forged batch header", async () => {
		const files: TreeSpec = {
			...BASE_FILES,
			// small blobs with multi-byte content break naive length framing
			"a/utf8.txt": `${"é".repeat(60)}\n`,
			"b/bin.dat": `${"\u0080ÿ".repeat(60)}\n`,
			"z/real.bin": POINTER(7),
		};
		const r = await inspect(files, { ...files, "src/b.ts": "b" });
		expect(r.lfs.pointers).toEqual(["z/real.bin"]);
	});

	test("a blob that imitates a cat-file header cannot hide a pointer", async () => {
		const { root, repo } = await newBareRepo();
		roots.push(root);
		const pointer = POINTER(9);
		const pSha = await git(repo, ["hash-object", "-w", "--stdin"], pointer);
		const size = pointer.length;
		const decoy = `x\n${pSha} blob ${size}\n${pointer}\npad ${"p".repeat(60)}`;
		const files: TreeSpec = {
			...BASE_FILES,
			"a/decoy.txt": decoy,
			"b/real.bin": pointer,
		};
		const baseSha = await commitSpec(repo, BASE_FILES);
		await commitSpec(repo, files, { parent: baseSha, ref: HEAD });
		const host = new HostGit({
			workspaceRoot: join(root, "ws"),
			ownedRoots: [root],
		});
		const r = await inspectResult({ host, repo, baseSha, headRef: HEAD });
		expect(r.lfs.pointers).toContain("b/real.bin");
	});

	test("refuses a special file over the size cap instead of skipping it", async () => {
		const s = await setup(BASE_FILES, {
			...BASE_FILES,
			".gitattributes": `${"# pad\n".repeat(200)}*.bin filter=lfs\n`,
		});
		const r = await inspectResult({
			host: s.host,
			repo: s.repo,
			baseSha: s.baseSha,
			headRef: HEAD,
			limits: { maxSpecialBytes: 100 },
		});
		expect(codes(r.findings, "refuse")).toContain("too_large");
	});
});

describe("limits and base", () => {
	test("refuses when the base commit is not in the result", async () => {
		const s = await setup(BASE_FILES, BASE_FILES);
		const r = await inspectResult({
			host: s.host,
			repo: s.repo,
			baseSha: "0".repeat(40),
			headRef: HEAD,
		});
		expect(codes(r.findings, "refuse")).toEqual(["base_missing"]);
	});

	test("rejects a malformed base id before running git", async () => {
		const s = await setup(BASE_FILES, BASE_FILES);
		await expect(
			inspectResult({
				host: s.host,
				repo: s.repo,
				baseSha: "--upload-pack=x",
				headRef: HEAD,
			}),
		).rejects.toBeInstanceOf(HostGitError);
	});
});

describe("resultValidator", () => {
	test("passes a clean result and reports it", async () => {
		const s = await setup(BASE_FILES, { ...BASE_FILES, "n.txt": "n" });
		let seen = 0;
		await resultValidator({
			baseSha: () => s.baseSha,
			onReport: () => {
				seen++;
			},
		})({
			bareRepo: s.repo,
			runId: "run1",
			headRef: HEAD,
			wipRefs: [],
			host: s.host,
		});
		expect(seen).toBe(1);
	});

	test("throws a validation error naming the refusals", async () => {
		const s = await setup(BASE_FILES, { ...BASE_FILES, ".git/config": "x" });
		const err = await resultValidator({ baseSha: s.baseSha })({
			bareRepo: s.repo,
			runId: "run1",
			headRef: HEAD,
			wipRefs: [],
			host: s.host,
		}).catch((e) => e);
		expect(err).toBeInstanceOf(HostGitError);
		expect((err as HostGitError).code).toBe("validation");
		expect((err as HostGitError).message).toContain("bad_path");
	});
});

describe("through fetchRunResult", () => {
	async function viaFetch(files: Record<string, string>, validate: boolean) {
		const t = await buildTamperedClone("run1");
		roots.push(t.root);
		const honest = await buildHonestRepo(t);
		const baseSha = await plainGit(["rev-parse", "HEAD"], t.primary);
		await plainGit(["checkout", "-q", "mfw/run1"], honest);
		for (const [name, text] of Object.entries(files)) {
			await mkdir(dirname(join(honest, name)), { recursive: true });
			await writeFile(join(honest, name), text);
		}
		await plainGit(["add", "-A"], honest);
		await plainGit(["commit", "-q", "-m", "run: changes"], honest);
		const bundle = join(t.root, "out.bundle");
		await makeBundle(
			honest,
			bundle,
			sandboxBundleArgv("run1", bundle).slice(4),
		);
		const host = new HostGit({
			workspaceRoot: t.workspaceRoot,
			ownedRoots: [t.scratchRoot],
		});
		const before = await plainGit(["for-each-ref"], t.primary);
		const result = fetchRunResult({
			host,
			primaryRepo: t.primary,
			outboxRoot: t.root,
			bundleRel: "out.bundle",
			runId: "run1",
			scratchRoot: t.scratchRoot,
			assertProcessesDead: () => {},
			validate: resultValidator({ baseSha }),
		});
		return { t, result, before, validate };
	}

	test("a clean result lands in quarantine", async () => {
		const { t, result } = await viaFetch({ "new.txt": "n\n" }, true);
		const ok = await result;
		expect(ok.quarantineRef).toBe("refs/mfw/quarantine/run1");
		const refs = await plainGit(
			["for-each-ref", "--format=%(refname)", "refs/mfw/quarantine/"],
			t.primary,
		);
		expect(refs).toContain("refs/mfw/quarantine/run1");
	});

	test("a malicious .gitmodules is refused and nothing reaches the primary", async () => {
		const { t, result, before } = await viaFetch(
			{
				".gitmodules":
					'[submodule "x"]\n\tpath = x\n\turl = ext::sh -c "touch pwn"\n',
			},
			true,
		);
		await expect(result).rejects.toMatchObject({ code: "validation" });
		expect(await plainGit(["for-each-ref"], t.primary)).toBe(before);
	});
});
