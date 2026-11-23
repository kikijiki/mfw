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
import type { DefinitionOfDone } from "../src/tasks/types.ts";
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
	}) as unknown as DefinitionOfDone;

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

	test("without a gate the verifier behaves as before", async () => {
		await writeFile(
			join(candidate, "scripts/check.sh"),
			"#!/bin/sh\nexit 0\n# x\n",
		);
		const r = await verify(candidate, dod("./scripts/check.sh"), baseSha);
		expect(r.passed).toBe(true);
	});
});
