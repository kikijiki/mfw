import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	checkEntries,
	checkGateRefusal,
} from "../src/containment/check-gate.ts";
import { gitOk } from "../src/git.ts";
import type { VerificationPlan } from "../src/tasks/types.ts";
import { verify } from "../src/verifier.ts";

let base: string;
let root: string;
let candidate: string;
let baseSha: string;
let canary: string;

const gate = () => ({ primaryRoot: root, baseRev: baseSha });
const dod = (run: string) =>
	({
		verifier: "deterministic",
		checks: [{ run }],
	}) as unknown as VerificationPlan;

beforeEach(async () => {
	base = await realpath(await mkdtemp(join(tmpdir(), "mfw-gate-")));
	root = join(base, "repo");
	candidate = join(base, "candidate");
	canary = join(base, "canary");
	await mkdir(join(root, "scripts"), { recursive: true });
	await gitOk(["init", "-q", "-b", "main"], root);
	await gitOk(["config", "user.email", "t@t"], root);
	await gitOk(["config", "user.name", "t"], root);
	await writeFile(join(root, "scripts/check.sh"), "#!/bin/sh\nexit 0\n", {
		mode: 0o755,
	});
	await writeFile(join(root, "a.test.txt"), "one\n");
	await writeFile(join(root, ".envrc"), "use flake\n");
	await writeFile(
		join(root, "package.json"),
		JSON.stringify({ scripts: { check: "./scripts/check.sh" }, version: "1" }),
	);
	await gitOk(["add", "-A"], root);
	await gitOk(["commit", "-q", "-m", "base"], root);
	baseSha = await gitOk(["rev-parse", "HEAD"], root);
	await gitOk(["clone", "-q", root, candidate], base);
});

afterEach(async () => {
	await rm(base, { recursive: true, force: true });
});

describe("checkEntries", () => {
	test("names the script, not its arguments", () => {
		const e = checkEntries("./scripts/check.sh tests/a.test.ts");
		expect([...e.files]).toEqual(["scripts/check.sh"]);
	});

	test("follows cd, sh and source", () => {
		const e = checkEntries("cd sub && sh run.sh; . ./env.sh");
		expect([...e.files].sort()).toEqual(["sub/env.sh", "sub/run.sh"]);
	});

	test("a test runner's file arguments are not entry points", () => {
		const e = checkEntries("bun test packages/a.test.ts");
		expect([...e.files]).toEqual([]);
		expect([...e.packageScripts]).toEqual([".\0test"]);
	});
});

describe("the check gate", () => {
	test("an unchanged entry point passes", async () => {
		expect(
			await checkGateRefusal(
				candidate,
				"./scripts/check.sh",
				undefined,
				gate(),
			),
		).toBeNull();
	});

	test("a change to a test file the check reads is allowed", async () => {
		await writeFile(join(candidate, "a.test.txt"), "two\n");
		expect(
			await checkGateRefusal(
				candidate,
				"./scripts/check.sh",
				undefined,
				gate(),
			),
		).toBeNull();
	});

	test("a modified entry script is refused and does not run", async () => {
		await writeFile(
			join(candidate, "scripts/check.sh"),
			`#!/bin/sh\ntouch "${canary}"\n`,
		);
		const r = await verify(candidate, dod("./scripts/check.sh"), baseSha, {
			gate: gate(),
		});
		expect(r.passed).toBe(false);
		expect(r.checks[0]?.classification).toBe("refused");
		expect(r.checks[0]?.detail).toContain("Fix:");
		expect(existsSync(canary)).toBe(false);
	});

	test("a new entry script is refused", async () => {
		await writeFile(
			join(candidate, "new.sh"),
			`#!/bin/sh\ntouch "${canary}"\n`,
			{
				mode: 0o755,
			},
		);
		const r = await verify(candidate, dod("sh new.sh"), baseSha, {
			gate: gate(),
		});
		expect(r.checks[0]?.classification).toBe("refused");
		expect(existsSync(canary)).toBe(false);
	});

	test("an entry swapped for a symlink is refused", async () => {
		await writeFile(join(base, "evil.sh"), `#!/bin/sh\ntouch "${canary}"\n`, {
			mode: 0o755,
		});
		await rm(join(candidate, "scripts/check.sh"));
		await symlink(join(base, "evil.sh"), join(candidate, "scripts/check.sh"));
		const r = await verify(candidate, dod("./scripts/check.sh"), baseSha, {
			gate: gate(),
		});
		expect(r.checks[0]?.classification).toBe("refused");
		expect(existsSync(canary)).toBe(false);
	});

	test("a changed package script is refused", async () => {
		await writeFile(
			join(candidate, "package.json"),
			JSON.stringify({ scripts: { check: `touch ${canary}` }, version: "1" }),
		);
		const refused = await checkGateRefusal(
			candidate,
			"bun run check",
			undefined,
			gate(),
		);
		expect(refused?.path).toBe("package.json");
	});

	test("an unrelated package.json change is allowed", async () => {
		await writeFile(
			join(candidate, "package.json"),
			JSON.stringify({
				scripts: { check: "./scripts/check.sh" },
				version: "2",
			}),
		);
		expect(
			await checkGateRefusal(candidate, "bun run check", undefined, gate()),
		).toBeNull();
	});

	test("a package script's own entry point is checked too", async () => {
		await writeFile(join(candidate, "scripts/check.sh"), "#!/bin/sh\nevil\n");
		const refused = await checkGateRefusal(
			candidate,
			"bun run check",
			undefined,
			gate(),
		);
		expect(refused?.path).toBe("scripts/check.sh");
	});

	test("a package script in a subdirectory resolves against the repo root", async () => {
		await mkdir(join(root, "pkg"));
		await writeFile(join(root, "pkg/run.sh"), "#!/bin/sh\nexit 0\n", {
			mode: 0o755,
		});
		await writeFile(
			join(root, "pkg/package.json"),
			JSON.stringify({ scripts: { t: "./run.sh" } }),
		);
		await gitOk(["add", "-A"], root);
		await gitOk(["commit", "-q", "-m", "pkg"], root);
		baseSha = await gitOk(["rev-parse", "HEAD"], root);
		await gitOk(["pull", "-q", "origin", "main"], candidate);
		const run = "cd pkg && bun run t";
		expect(
			await checkGateRefusal(candidate, run, undefined, gate()),
		).toBeNull();
		await writeFile(join(candidate, "pkg/run.sh"), "#!/bin/sh\nevil\n");
		const refused = await checkGateRefusal(candidate, run, undefined, gate());
		expect(refused?.path).toBe("pkg/run.sh");
	});

	test("a changed .envrc is refused when the prefix loads it", async () => {
		await writeFile(join(candidate, ".envrc"), `touch ${canary}\n`);
		const refused = await checkGateRefusal(
			candidate,
			"true",
			"direnv exec .",
			gate(),
		);
		expect(refused?.path).toBe(".envrc");
	});

	test("a planted flake is refused when the prefix loads it", async () => {
		await writeFile(join(candidate, "flake.nix"), "{ }\n");
		const refused = await checkGateRefusal(
			candidate,
			"true",
			"nix develop -c",
			gate(),
		);
		expect(refused?.path).toBe("flake.nix");
	});

	test("a changed .envrc is irrelevant without a loading prefix", async () => {
		await writeFile(join(candidate, ".envrc"), "changed\n");
		expect(
			await checkGateRefusal(candidate, "true", undefined, gate()),
		).toBeNull();
	});

	test("an unreadable base revision refuses instead of passing", async () => {
		const refused = await checkGateRefusal(
			candidate,
			"./scripts/check.sh",
			undefined,
			{
				primaryRoot: root,
				baseRev: "0000000000000000000000000000000000000000",
			},
		);
		expect(refused).not.toBeNull();
	});

	const refusedPath = async (run: string, prefix?: string) =>
		(await checkGateRefusal(candidate, run, prefix, gate()))?.path;

	test("an added pre-script is refused", async () => {
		await writeFile(
			join(candidate, "package.json"),
			JSON.stringify({
				scripts: { check: "./scripts/check.sh", precheck: `touch ${canary}` },
				version: "1",
			}),
		);
		expect(await refusedPath("bun run check")).toBe("package.json");
	});

	test("an added post-script is refused", async () => {
		await writeFile(
			join(candidate, "package.json"),
			JSON.stringify({
				scripts: { check: "./scripts/check.sh", postcheck: `touch ${canary}` },
				version: "1",
			}),
		);
		expect(await refusedPath("bun run check")).toBe("package.json");
	});

	test("removing the script so a new check.ts runs instead is refused", async () => {
		await writeFile(
			join(candidate, "package.json"),
			JSON.stringify({ scripts: {}, version: "1" }),
		);
		await writeFile(join(candidate, "check.ts"), "evil();\n");
		expect(await refusedPath("bun run check")).toBe("package.json");
	});

	test("a new file named like an undefined script is refused", async () => {
		await writeFile(join(candidate, "lint.ts"), "evil();\n");
		expect(await refusedPath("bun run lint")).toBe("lint.ts");
	});

	for (const file of [
		"bunfig.toml",
		".npmrc",
		"bun.lock",
		"package-lock.json",
	]) {
		test(`a new ${file} is refused for a package-runner check`, async () => {
			await writeFile(join(candidate, file), 'preload = ["./evil.ts"]\n');
			expect(await refusedPath("bun test")).toBe(file);
		});
	}

	test("a changed Make include is refused", async () => {
		await writeFile(
			join(root, "Makefile"),
			"include extra.mk\ncheck:\n\ttrue\n",
		);
		await writeFile(join(root, "extra.mk"), "A=1\n");
		await gitOk(["add", "-A"], root);
		await gitOk(["commit", "-q", "-m", "make"], root);
		baseSha = await gitOk(["rev-parse", "HEAD"], root);
		await gitOk(["pull", "-q", "origin", "main"], candidate);
		expect(await refusedPath("make check")).toBeUndefined();
		await writeFile(join(candidate, "extra.mk"), "A=2\n");
		expect(await refusedPath("make check")).toBe("extra.mk");
	});

	test("bun test is not confused by a test directory or test.ts", async () => {
		await mkdir(join(candidate, "test"));
		await writeFile(join(candidate, "test/a.test.ts"), "changed\n");
		await writeFile(join(candidate, "test.ts"), "changed\n");
		expect(await refusedPath("bun test")).toBeUndefined();
	});

	test("a directory named like a script is not a refusal", async () => {
		await mkdir(join(candidate, "lint"));
		expect(await refusedPath("bun run lint")).toBeUndefined();
	});

	test("a computed Make include is refused", async () => {
		await writeFile(
			join(root, "Makefile"),
			"include $(X).mk\ncheck:\n\ttrue\n",
		);
		await gitOk(["add", "-A"], root);
		await gitOk(["commit", "-q", "-m", "make"], root);
		baseSha = await gitOk(["rev-parse", "HEAD"], root);
		await gitOk(["pull", "-q", "origin", "main"], candidate);
		expect(await refusedPath("make check")).toBe("Makefile");
	});

	for (const run of [
		'sh -c "$(cat evil)"',
		"./scripts/check.sh $(cat evil)",
		"for f in a; do ./x; done",
		"export PATH=./bin:$PATH; check",
	]) {
		test(`an unanalyzable check is refused: ${run}`, async () => {
			const refused = await checkGateRefusal(candidate, run, undefined, gate());
			expect(refused?.reason).toContain("cannot be checked");
			expect(refused?.fix).toBeTruthy();
		});
	}

	test("refs/replace cannot forge the trusted base", async () => {
		// The reviewer's exploit: replace the base with a commit holding the
		// candidate's script, so the "base" reads back as the candidate.
		const evilScript = `#!/bin/sh\ntouch "${canary}"\n`;
		await gitOk(["checkout", "-q", "-b", "forged"], root);
		await writeFile(join(root, "scripts/check.sh"), evilScript);
		await gitOk(["add", "-A"], root);
		await gitOk(["commit", "-q", "-m", "forged"], root);
		const forged = await gitOk(["rev-parse", "HEAD"], root);
		await gitOk(["checkout", "-q", "main"], root);
		await gitOk(["replace", baseSha, forged], root);
		await writeFile(join(candidate, "scripts/check.sh"), evilScript);
		const r = await verify(candidate, dod("./scripts/check.sh"), baseSha, {
			gate: gate(),
		});
		expect(r.checks[0]?.classification).toBe("refused");
		expect(existsSync(canary)).toBe(false);
	});

	test("the gate refuses before the verifier sandbox is entered", async () => {
		await writeFile(join(candidate, "scripts/check.sh"), "#!/bin/sh\nevil\n");
		let entered = false;
		const r = await verify(candidate, dod("./scripts/check.sh"), baseSha, {
			gate: gate(),
			sandbox: {
				role: "verifier",
				run: async () => {
					entered = true;
					throw new Error("the sandbox must not be reached");
				},
			},
		});
		expect(r.checks[0]?.classification).toBe("refused");
		expect(entered).toBe(false);
	});
});
