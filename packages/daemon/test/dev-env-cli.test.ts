import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEnvCommand } from "../src/containment/dev-env-cli.ts";
import { EnvTrustStore } from "../src/containment/dev-env-trust.ts";
import { git } from "../src/git.ts";

let base: string;
let home: string;
let root: string;
let commit: string;

const run = async (...args: string[]) => {
	const out: string[] = [];
	const err: string[] = [];
	const code = await runEnvCommand(args, {
		home,
		out: (l) => out.push(l),
		err: (l) => err.push(l),
	});
	return { code, out: out.join("\n"), err: err.join("\n") };
};

beforeAll(async () => {
	base = realpathSync(mkdtempSync(join(tmpdir(), "dev-env-cli-")));
	home = join(base, "mfw");
	root = join(base, "proj");
	mkdirSync(home);
	mkdirSync(root);
	await git(["init", "-q", "-b", "main", "."], root);
	await git(["config", "user.email", "t@t"], root);
	await git(["config", "user.name", "t"], root);
	writeFileSync(join(root, ".envrc"), "use flake\n");
	writeFileSync(join(root, "flake.nix"), "{ outputs = _: {}; }\n");
	await git(["add", "-A"], root);
	await git(["commit", "-q", "-m", "one"], root);
	commit = (await git(["rev-parse", "HEAD"], root)).stdout;
	writeFileSync(
		join(home, "config.json"),
		JSON.stringify({
			projects: [
				{
					name: "proj",
					root,
					integrationBranch: "main",
					env: { setup: ["bun install"] },
				},
				{ name: "plain", root: join(base, "nope") },
			],
		}),
	);
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("mfw env", () => {
	test("without a command prints the usage and fails", async () => {
		const r = await run();
		expect(r.code).toBe(2);
		expect(r.err).toContain("mfw env <command>");
	});

	test("status before any approval names the allow command and fails", async () => {
		const r = await run("status", "proj");
		expect(r.code).toBe(1);
		expect(r.out).toContain("env_not_approved");
		expect(r.out).toContain(`mfw env allow proj --rev ${commit}`);
	});

	test("allow prints every file and hash it approves, then records them", async () => {
		const r = await run("allow", "proj");
		expect(r.code).toBe(0);
		expect(r.out).toContain(`direnv environment of proj at ${commit}`);
		expect(r.out).toMatch(
			/\.envrc {2}sha256:[0-9a-f]{64} {2}\(blob [0-9a-f]{40}\)/,
		);
		expect(r.out).toMatch(/flake\.nix {2}sha256:/);
		expect(r.out).toContain('setup: "bun install"');
		const rec = new EnvTrustStore(home).read(root);
		expect(rec?.state).toBe("allowed");
		expect(rec?.commit).toBe(commit);
		expect(rec?.via).toBe("cli");
	});

	test("status after allow: approved, not yet evaluated (a warning, not a failure)", async () => {
		const r = await run("status", "proj");
		expect(r.code).toBe(0);
		expect(r.out).toContain("env_not_built");
		expect(r.out).toContain("mfw env build proj");
	});

	test("--rev takes a commit, and a bad one is refused", async () => {
		expect((await run("allow", "proj", "--rev", commit)).code).toBe(0);
		const bad = await run("allow", "proj", "--rev", "--all");
		expect(bad.code).toBe(1);
		expect((await run("allow", "proj", "--rev")).code).toBe(2);
	});

	test("deny refuses until allowed again", async () => {
		expect((await run("deny", "proj")).code).toBe(0);
		const r = await run("status", "proj");
		expect(r.code).toBe(1);
		expect(r.out).toContain("env_denied");
	});

	test("an unknown project is an error that lists the known ones", async () => {
		const r = await run("allow", "other");
		expect(r.code).toBe(2);
		expect(r.err).toContain("known: proj, plain");
	});

	test("a missing project root is reported, not thrown", async () => {
		const r = await run("status", "plain");
		expect(r.code).toBe(1);
		expect(r.out).toContain("does not exist");
	});
});
