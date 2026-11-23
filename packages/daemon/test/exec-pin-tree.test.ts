import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	buildExecPin,
	type ExecPin,
	pathMayChange,
	verifyExecPin,
} from "../src/containment/exec-pin.ts";
import { gitOk } from "../src/git.ts";
import { sealCheckout } from "../src/host-git/landing.ts";

let base: string;
let root: string;

async function put(files: Record<string, string>): Promise<void> {
	for (const [path, content] of Object.entries(files)) {
		const abs = join(root, path);
		await mkdir(dirname(abs), { recursive: true });
		await writeFile(abs, content);
		if (content.startsWith("#!")) await chmod(abs, 0o755);
	}
}

async function commit(files: Record<string, string>): Promise<void> {
	await put(files);
	await gitOk(["add", "-A", "-f"], root);
	await gitOk(["commit", "-q", "-m", "change"], root);
}

async function pinOf(run: string, mayChange?: string[]): Promise<ExecPin> {
	const built = await buildExecPin({
		root,
		run,
		...(mayChange ? { mayChange } : {}),
	});
	if (!built.ok) throw new Error(`arming refused: ${built.reason}`);
	return built.pin;
}

const verifyAtHead = (pin: ExecPin) =>
	verifyExecPin(pin, { root, gitCwd: root, rev: "HEAD" });

beforeEach(async () => {
	base = await realpath(await mkdtemp(join(tmpdir(), "mfw-tree-")));
	root = join(base, "repo");
	await mkdir(root);
	await gitOk(["init", "-q", "-b", "main"], root);
	await gitOk(["config", "user.email", "t@t"], root);
	await gitOk(["config", "user.name", "t"], root);
	await commit({ "README.md": "x\n", "docs/a.md": "a\n" });
});

afterEach(async () => {
	await rm(base, { recursive: true, force: true });
});

describe("the whole tree is pinned at the armed commit", () => {
	const routes: [
		string,
		string,
		Record<string, string>,
		Record<string, string>,
	][] = [
		[
			"a Makefile recipe target",
			"make deploy",
			{ Makefile: "deploy:\n\t./step.sh\n", "step.sh": "#!/bin/sh\nexit 0\n" },
			{ "step.sh": "#!/bin/sh\nevil\n" },
		],
		[
			"a Makefile include",
			"make deploy",
			{ Makefile: "include extra.mk\ndeploy:\n\ttrue\n", "extra.mk": "A=1\n" },
			{ "extra.mk": "A=2\n" },
		],
		[
			"a new bunfig.toml preload",
			"./run.sh",
			{ "run.sh": "#!/bin/sh\nexit 0\n" },
			{ "bunfig.toml": 'preload = ["./evil.ts"]\n', "evil.ts": "evil\n" },
		],
		[
			"a predeploy script's target",
			"bun run deploy",
			{
				"package.json": JSON.stringify({
					scripts: { predeploy: "./pre.sh", deploy: "true" },
				}),
				"pre.sh": "#!/bin/sh\nexit 0\n",
			},
			{ "pre.sh": "#!/bin/sh\nevil\n" },
		],
		[
			"a committed node_modules/.bin tool",
			"./run.sh",
			{ "run.sh": "#!/bin/sh\nexit 0\n" },
			{ "node_modules/.bin/uname": "#!/bin/sh\nevil\n" },
		],
		[
			"a new lib.tsx beside a pinned lib.ts",
			"bun main.ts",
			{ "main.ts": 'import "./lib";\n', "lib.ts": "export {};\n" },
			{ "lib.tsx": "evil();\n" },
		],
		[
			"a Python sibling import",
			"python3 main.py",
			{ "main.py": "import helper\n", "helper.py": "x = 1\n" },
			{ "helper.py": "evil()\n" },
		],
	];

	for (const [name, run, before, after] of routes) {
		test(`${name} refuses after an agent commit`, async () => {
			await commit(before);
			const pin = await pinOf(run);
			expect((await verifyAtHead(pin)).ok).toBe(true);
			await commit(after);
			const verified = await verifyAtHead(pin);
			expect(verified.ok).toBe(false);
			expect(!verified.ok && verified.code).toBe("tree_changed");
		});
	}

	test("a path on the owner's list may change", async () => {
		await commit({ "run.sh": "#!/bin/sh\nexit 0\n" });
		const pin = await pinOf("./run.sh", ["docs/", "CHANGELOG.md"]);
		await commit({ "docs/a.md": "b\n", "CHANGELOG.md": "1\n" });
		expect((await verifyAtHead(pin)).ok).toBe(true);
		await commit({ "docs2/a.md": "b\n" });
		expect((await verifyAtHead(pin)).ok).toBe(false);
	});

	test("the owner's list cannot cover a file the command executes", async () => {
		await commit({ "run.sh": "#!/bin/sh\nexit 0\n" });
		const built = await buildExecPin({
			root,
			run: "./run.sh",
			mayChange: ["run.sh"],
		});
		expect(built.ok).toBe(false);
	});

	test("the list matches exact paths and directory prefixes only", () => {
		expect(pathMayChange("docs/a.md", ["docs/"])).toBe(true);
		expect(pathMayChange("docs", ["docs/"])).toBe(false);
		expect(pathMayChange("docsx/a", ["docs/"])).toBe(false);
		expect(pathMayChange("a.md", ["a.md"])).toBe(true);
		expect(pathMayChange("b/a.md", ["a.md"])).toBe(false);
	});
});

describe("the parser refuses what it cannot pin", () => {
	test("a tool argument that is missing at arming", async () => {
		const built = await buildExecPin({ root, run: "nice ./later.sh" });
		expect(built.ok).toBe(false);
	});

	test("an unknown tool taking a path argument", async () => {
		await commit({ "later.sh": "#!/bin/sh\nexit 0\n" });
		const built = await buildExecPin({ root, run: "nice ./later.sh" });
		expect(built.ok).toBe(false);
	});

	for (const run of [
		"export PATH=./bin:$PATH; uname",
		"export LD_PRELOAD=./x.so; uname",
		"readonly PATH=./bin; uname",
		"set -a; uname",
		"NODE_PATH=./x node -v",
		"PYTHONHOME=./x python3 -V",
		"PERL5OPT=-Mx perl -v",
		"RUBYOPT=-rx ruby -v",
		"GIT_SSH_COMMAND=./x git status",
	]) {
		test(`refuses: ${run}`, async () => {
			const built = await buildExecPin({ root, run });
			expect(built.ok).toBe(false);
			expect(!built.ok && built.code).toBe("unanalyzable");
		});
	}

	test("a backslash a shell keeps inside double quotes", async () => {
		await commit({ "ab.sh": "#!/bin/sh\nexit 0\n" });
		const built = await buildExecPin({ root, run: '"./a\\b.sh"' });
		expect(built.ok).toBe(false);
	});

	test("set -e stays allowed", async () => {
		await commit({ "run.sh": "#!/bin/sh\nexit 0\n" });
		expect((await buildExecPin({ root, run: "set -e; ./run.sh" })).ok).toBe(
			true,
		);
	});
});

describe("the sealed checkout", () => {
	test("holds the armed bytes, whatever the primary has on disk", async () => {
		await commit({ "run.sh": "#!/bin/sh\necho armed\n" });
		const pin = await pinOf("./run.sh");
		await writeFile(join(root, "run.sh"), "#!/bin/sh\nevil\n");
		const sealed = await sealCheckout(
			root,
			pin.commit as string,
			join(base, "seal"),
			join(base, "landing"),
		);
		expect(await readFile(join(sealed.path, "run.sh"), "utf8")).toContain(
			"armed",
		);
		expect(existsSync(join(sealed.path, ".git"))).toBe(false);
		const verified = await verifyExecPin(pin, {
			root: sealed.path,
			gitCwd: root,
			rev: pin.commit as string,
			sealed: true,
		});
		expect(verified.ok).toBe(true);
		await sealed.dispose();
		expect(existsSync(sealed.path)).toBe(false);
	});

	test("a filter attribute does not rewrite the checkout", async () => {
		await commit({
			".gitattributes": "*.sh filter=evil\n",
			"run.sh": "#!/bin/sh\necho armed\n",
		});
		const pin = await pinOf("./run.sh");
		const sealed = await sealCheckout(
			root,
			pin.commit as string,
			join(base, "seal"),
			join(base, "landing"),
		);
		expect(await readFile(join(sealed.path, "run.sh"), "utf8")).toContain(
			"armed",
		);
		await sealed.dispose();
	});
});
