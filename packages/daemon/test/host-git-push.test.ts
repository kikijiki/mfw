import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDangerousGitKey } from "../src/containment/git-config-scan.ts";
import { git, gitOk } from "../src/git.ts";
import {
	hardenedPush,
	pushEnv,
	repoControlledExecKeys,
} from "../src/host-git/push.ts";

let base: string;
let root: string;
let remote: string;
let home: string;
let canary: string;
let environment: NodeJS.ProcessEnv;

/** A program that proves it ran by creating the canary. */
async function plantProgram(): Promise<string> {
	const path = join(base, "evil.sh");
	await writeFile(path, `#!/bin/sh\ntouch "${canary}"\nexit 1\n`, {
		mode: 0o755,
	});
	return path;
}

const push = () =>
	hardenedPush({
		projectRoot: root,
		remote: "origin",
		branch: "main",
		environment,
	});

beforeEach(async () => {
	base = await realpath(await mkdtemp(join(tmpdir(), "mfw-push-")));
	root = join(base, "repo");
	remote = join(base, "remote.git");
	home = join(base, "home");
	canary = join(base, "canary");
	await mkdir(root);
	await mkdir(home);
	environment = { PATH: process.env.PATH, HOME: home };
	await gitOk(["init", "-q", "--bare", "-b", "main", remote], base);
	await gitOk(["init", "-q", "-b", "main"], root);
	await gitOk(["config", "user.email", "t@t"], root);
	await gitOk(["config", "user.name", "t"], root);
	await writeFile(join(root, "a.txt"), "a\n");
	await gitOk(["add", "-A"], root);
	await gitOk(["commit", "-q", "-m", "init"], root);
	await gitOk(["remote", "add", "origin", remote], root);
});

afterEach(async () => {
	await rm(base, { recursive: true, force: true });
});

describe("hardenedPush", () => {
	test("pushes the branch when the config is clean", async () => {
		expect(await push()).toEqual({ status: "pushed" });
		expect(await gitOk(["rev-parse", "main"], remote)).toBe(
			await gitOk(["rev-parse", "main"], root),
		);
	});

	test("pushes only the named branch", async () => {
		await gitOk(["branch", "other"], root);
		expect((await push()).status).toBe("pushed");
		expect(
			(await git(["rev-parse", "--verify", "-q", "other"], remote)).exitCode,
		).not.toBe(0);
	});

	test("a planted pre-push hook does not run", async () => {
		await writeFile(
			join(root, ".git/hooks/pre-push"),
			`#!/bin/sh\ntouch "${canary}"\nexit 1\n`,
			{ mode: 0o755 },
		);
		expect((await push()).status).toBe("pushed");
		expect(existsSync(canary)).toBe(false);
	});

	test("a hooks directory set through core.hooksPath does not run", async () => {
		const hooks = join(base, "hooks");
		await mkdir(hooks);
		await writeFile(
			join(hooks, "pre-push"),
			`#!/bin/sh\ntouch "${canary}"\nexit 1\n`,
			{ mode: 0o755 },
		);
		await gitOk(["config", "core.hooksPath", hooks], root);
		expect((await push()).status).toBe("pushed");
		expect(existsSync(canary)).toBe(false);
	});

	for (const key of [
		"core.sshCommand",
		"credential.helper",
		"remote.origin.receivepack",
		"core.gitProxy",
		"gpg.program",
	]) {
		test(`a repository-level ${key} refuses the push and does not run`, async () => {
			await gitOk(["config", key, await plantProgram()], root);
			const r = await push();
			expect(r.status).toBe("refused");
			expect(r.status === "refused" && r.reason).toContain(key.toLowerCase());
			expect(r.status === "refused" && r.reason).toContain("Fix:");
			expect(existsSync(canary)).toBe(false);
			expect(
				(await git(["rev-parse", "--verify", "-q", "main"], remote)).exitCode,
			).not.toBe(0);
		});
	}

	test("an include in the repository config refuses the push", async () => {
		const included = join(base, "included");
		await writeFile(
			included,
			`[core]\n\tsshCommand = ${await plantProgram()}\n`,
		);
		await gitOk(["config", "include.path", included], root);
		expect((await push()).status).toBe("refused");
		expect(existsSync(canary)).toBe(false);
	});

	test("a global includeIf reaching a file inside the project refuses the push", async () => {
		const planted = join(root, "planted.gitconfig");
		await writeFile(
			planted,
			`[core]\n\tsshCommand = ${await plantProgram()}\n`,
		);
		await writeFile(
			join(home, ".gitconfig"),
			`[includeIf "gitdir:${root}/"]\n\tpath = ${planted}\n`,
		);
		const r = await push();
		expect(r.status).toBe("refused");
		expect(r.status === "refused" && r.reason).toContain("core.sshcommand");
		expect(existsSync(canary)).toBe(false);
	});

	test("the operator's global credential helper is still allowed", async () => {
		await writeFile(
			join(home, ".gitconfig"),
			"[credential]\n\thelper = store\n",
		);
		expect((await push()).status).toBe("pushed");
	});

	test("an ext:: remote url is not executed", async () => {
		await gitOk(
			["remote", "set-url", "origin", `ext::sh -c "touch ${canary}"`],
			root,
		);
		expect((await push()).status).toBe("error");
		expect(existsSync(canary)).toBe(false);
	});

	test("a remote or branch that parses as an option is refused", async () => {
		const r = await hardenedPush({
			projectRoot: root,
			remote: "--receive-pack=/bin/false",
			branch: "main",
			environment,
		});
		expect(r.status).toBe("refused");
	});

	test("GIT_* variables in the daemon env do not reach the push", () => {
		const env = pushEnv({
			PATH: "/bin",
			GIT_SSH_COMMAND: "/evil",
			GIT_CONFIG_COUNT: "1",
			GIT_DIR: "/evil",
			GIT_ASKPASS: "/evil",
		});
		expect(Object.keys(env).sort()).toEqual(["GIT_TERMINAL_PROMPT", "PATH"]);
	});
});

describe("repoControlledExecKeys", () => {
	const row = (scope: string, origin: string, kv: string) =>
		`${scope}\0${origin}\0${kv}\0`;

	test("ignores inert keys and neutralized hook settings", () => {
		const listing =
			row("local", "file:.git/config", "remote.origin.url\n/x") +
			row("local", "file:.git/config", "core.hookspath\n/x") +
			row("local", "file:.git/config", "core.fsmonitor\n/x");
		expect(repoControlledExecKeys(listing, "/p")).toEqual([]);
	});

	test("reports local keys, and keeps global ones outside the project", () => {
		const listing =
			row("local", "file:.git/config", "core.sshcommand\n/x") +
			row("global", "file:/h/.gitconfig", "credential.helper\nstore");
		expect(repoControlledExecKeys(listing, "/p")).toEqual(["core.sshcommand"]);
	});

	test("an unreadable listing throws instead of reading as clean", () => {
		expect(() => repoControlledExecKeys("local\0oops\0", "/p")).toThrow();
	});

	test("isDangerousGitKey handles subsections with dots", () => {
		expect(isDangerousGitKey("credential.https://a.b/c.helper")).toBe(true);
		expect(isDangerousGitKey("remote.origin.url")).toBe(false);
	});
});
