import { afterEach, describe, expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	symlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProc } from "../src/proc.ts";
import {
	defaultCacheDeclarations,
	findUnsafeSymlink,
	fixupVenv,
	normalizeCachePath,
	reflinkCopy,
	seedCaches,
} from "../src/run-workspace/caches.ts";

const dirs: string[] = [];
afterEach(async () => {
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
	const d = await mkdtemp(join(tmpdir(), "mfw-caches-"));
	dirs.push(d);
	return d;
}

/** Whether `cp --reflink=always` works between two dirs under tmpdir. */
async function reflinkWorks(): Promise<boolean> {
	const d = await tmp();
	await writeFile(join(d, "a"), "x".repeat(8192));
	return (await reflinkCopy(join(d, "a"), join(d, "b"))).ok;
}
const REFLINK = await reflinkWorks();
if (!REFLINK) console.log("skip: filesystem cannot reflink; copy tests off");
const reflinkTest = REFLINK ? test : test.skip;

async function project(): Promise<{ primary: string; tree: string }> {
	const root = await tmp();
	const primary = join(root, "primary");
	const tree = join(root, "tree");
	await mkdir(primary);
	await mkdir(tree);
	return { primary, tree };
}

describe("normalizeCachePath", () => {
	test("accepts plain relative paths", () => {
		expect(normalizeCachePath("target")).toBe("target");
		expect(normalizeCachePath("packages/a/node_modules/")).toBe(
			"packages/a/node_modules",
		);
	});
	test("refuses escapes, absolutes, .git and the root", () => {
		for (const bad of [
			"",
			".",
			"/etc",
			"../x",
			"a/../../x",
			"a/../b",
			".git",
			"a/.git/x",
			"a\0b",
		]) {
			expect(normalizeCachePath(bad)).toBeUndefined();
		}
	});
});

describe("findUnsafeSymlink", () => {
	test("relative links inside the project and absolute links elsewhere are fine", async () => {
		const { primary } = await project();
		await mkdir(join(primary, "node_modules", "a"), { recursive: true });
		await mkdir(join(primary, "pkg"));
		await symlink("../../pkg", join(primary, "node_modules", "a", "pkg"));
		await symlink("/usr/bin/env", join(primary, "node_modules", "env"));
		expect(
			await findUnsafeSymlink(join(primary, "node_modules"), primary),
		).toBeUndefined();
	});
	test("an absolute link into the project is unsafe", async () => {
		const { primary } = await project();
		await mkdir(join(primary, "node_modules"));
		await symlink(join(primary, "src"), join(primary, "node_modules", "me"));
		expect(
			await findUnsafeSymlink(join(primary, "node_modules"), primary),
		).toContain("me");
	});
	test("a relative link leaving the project is unsafe", async () => {
		const { primary } = await project();
		await mkdir(join(primary, "node_modules"));
		await symlink("../../elsewhere", join(primary, "node_modules", "out"));
		expect(
			await findUnsafeSymlink(join(primary, "node_modules"), primary),
		).toContain("out");
	});
});

describe("defaultCacheDeclarations", () => {
	test("finds recognisable caches and never .direnv", async () => {
		const { primary } = await project();
		await writeFile(join(primary, "Cargo.toml"), "");
		await mkdir(join(primary, "target"));
		await writeFile(join(primary, "package.json"), "{}");
		await mkdir(join(primary, "node_modules"));
		await mkdir(join(primary, "packages", "a", "node_modules"), {
			recursive: true,
		});
		await writeFile(join(primary, "packages", "a", "package.json"), "{}");
		await mkdir(join(primary, ".venv"));
		await writeFile(join(primary, ".venv", "pyvenv.cfg"), "");
		await mkdir(join(primary, ".direnv"));
		const decls = await defaultCacheDeclarations(primary);
		expect(decls).toEqual([
			{ kind: "rust-target", path: "target" },
			{ kind: "node-modules", path: "node_modules" },
			{ kind: "node-modules", path: "packages/a/node_modules" },
			{ kind: "venv", path: ".venv" },
		]);
	});
});

describe("fixupVenv", () => {
	test("rewrites the project path at path boundaries only", async () => {
		const d = await tmp();
		const venv = join(d, "v");
		await mkdir(join(venv, "bin"), { recursive: true });
		await writeFile(join(venv, "pyvenv.cfg"), "command = /p/proj/.venv\n");
		await writeFile(
			join(venv, "bin", "pip"),
			"#!/p/proj/.venv/bin/python3\n# /p/proj2/keep\n",
		);
		await writeFile(join(venv, "bin", "blob"), Buffer.from([0, 1, 2]));
		await symlink("/p/proj/x", join(venv, "bin", "link"));
		const n = await fixupVenv(venv, ["/p/proj"], "/w/tree");
		expect(n).toBe(2);
		expect(await readFile(join(venv, "pyvenv.cfg"), "utf8")).toBe(
			"command = /w/tree/.venv\n",
		);
		expect(await readFile(join(venv, "bin", "pip"), "utf8")).toBe(
			"#!/w/tree/.venv/bin/python3\n# /p/proj2/keep\n",
		);
	});
});

describe("seedCaches", () => {
	reflinkTest(
		"rust target keeps mtimes and the primary untouched",
		async () => {
			const { primary, tree } = await project();
			await mkdir(join(primary, "target", "debug"), { recursive: true });
			const f = join(primary, "target", "debug", "dep.rlib");
			await writeFile(f, "artifact");
			const old = new Date(Date.now() - 86_400_000);
			await utimes(f, old, old);
			const out = await seedCaches({
				primaryRoot: primary,
				treeRoot: tree,
				declarations: [{ kind: "rust-target", path: "target" }],
			});
			expect(out).toEqual([
				{ kind: "rust-target", path: "target", status: "seeded" },
			]);
			const copy = join(tree, "target", "debug", "dep.rlib");
			expect((await stat(copy)).mtimeMs).toBe((await stat(f)).mtimeMs);
			await writeFile(copy, "changed");
			expect(await readFile(f, "utf8")).toBe("artifact");
		},
	);

	reflinkTest("a venv's pip runs from the new path", async () => {
		const { primary, tree } = await project();
		const bin = join(primary, ".venv", "bin");
		await mkdir(bin, { recursive: true });
		const py = `#!/bin/sh\necho "python-from:$(dirname "$0")"\n`;
		await writeFile(join(bin, "python3"), py, { mode: 0o755 });
		await writeFile(join(bin, "pip"), `#!${join(bin, "python3")}\n`, {
			mode: 0o755,
		});
		await writeFile(
			join(bin, "activate"),
			`VIRTUAL_ENV="${join(primary, ".venv")}"\n`,
		);
		await writeFile(
			join(primary, ".venv", "pyvenv.cfg"),
			`home = /usr/bin\ncommand = x ${join(primary, ".venv")}\n`,
		);
		const out = await seedCaches({
			primaryRoot: primary,
			treeRoot: tree,
			declarations: [{ kind: "venv", path: ".venv" }],
		});
		expect(out[0]?.status).toBe("seeded");
		expect(out[0]?.fixedFiles).toBe(3);
		const r = await runProc([join(tree, ".venv", "bin", "pip")]);
		expect(r.stdout.trim()).toBe(`python-from:${join(tree, ".venv", "bin")}`);
		// the primary's copies are untouched
		expect(await readFile(join(bin, "activate"), "utf8")).toContain(primary);
		expect(await readFile(join(tree, ".venv", "bin", "activate"), "utf8")).toBe(
			`VIRTUAL_ENV="${join(tree, ".venv")}"\n`,
		);
	});

	reflinkTest("node_modules with relative links is carried", async () => {
		const { primary, tree } = await project();
		await mkdir(join(primary, "node_modules", ".bun", "x"), {
			recursive: true,
		});
		await writeFile(join(primary, "node_modules", ".bun", "x", "i.js"), "1");
		await symlink(".bun/x", join(primary, "node_modules", "x"));
		const out = await seedCaches({
			primaryRoot: primary,
			treeRoot: tree,
			declarations: [{ kind: "node-modules", path: "node_modules" }],
		});
		expect(out[0]?.status).toBe("seeded");
		expect(
			await readFile(join(tree, "node_modules", "x", "i.js"), "utf8"),
		).toBe("1");
	});

	test("an absolute symlink back into the project skips the cache", async () => {
		const { primary, tree } = await project();
		await mkdir(join(primary, "node_modules"));
		await symlink(primary, join(primary, "node_modules", "self"));
		const out = await seedCaches({
			primaryRoot: primary,
			treeRoot: tree,
			declarations: [{ kind: "node-modules", path: "node_modules" }],
		});
		expect(out[0]).toMatchObject({
			status: "skipped",
			reason: "unsafe_symlink",
		});
		expect(await Bun.file(join(tree, "node_modules")).exists()).toBe(false);
	});

	test(".direnv is never carried, however it is declared", async () => {
		const { primary, tree } = await project();
		await mkdir(join(primary, ".direnv"));
		const out = await seedCaches({
			primaryRoot: primary,
			treeRoot: tree,
			declarations: [
				{ kind: "direnv", path: ".direnv" },
				{ kind: "rust-target", path: ".direnv" },
				{ kind: "node-modules", path: "sub/.direnv" },
			],
		});
		expect(out.map((o) => o.reason)).toEqual([
			"never_carried",
			"never_carried",
			"never_carried",
		]);
	});

	test("bad paths, missing sources, tracked collisions and symlinked sources are skipped", async () => {
		const { primary, tree } = await project();
		await mkdir(join(primary, "real"));
		await symlink("real", join(primary, "link"));
		await mkdir(join(primary, "taken"));
		await mkdir(join(tree, "taken"));
		await writeFile(join(primary, "file"), "");
		const out = await seedCaches({
			primaryRoot: primary,
			treeRoot: tree,
			declarations: [
				{ kind: "rust-target", path: "../x" },
				{ kind: "rust-target", path: "nope" },
				{ kind: "rust-target", path: "link" },
				{ kind: "rust-target", path: "taken" },
				{ kind: "rust-target", path: "file" },
			],
		});
		expect(out.map((o) => o.reason)).toEqual([
			"invalid_path",
			"missing",
			"symlink_path",
			"tracked_content_present",
			"not_a_directory",
		]);
	});
});
