import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, gitOk } from "../src/git.ts";
import { hardenedPush, pushEnv, pushUrlRefusal } from "../src/host-git/push.ts";

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
		branch: "main",
		target: { url: remote, allowLocal: true },
		landingRoot: join(base, "landing"),
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

	test("a global includeIf aimed at the project is not reached by the push", async () => {
		const planted = join(root, "planted.gitconfig");
		await writeFile(
			planted,
			`[core]\n\tsshCommand = ${await plantProgram()}\n`,
		);
		await writeFile(
			join(home, ".gitconfig"),
			`[includeIf "gitdir:${root}/"]\n\tpath = ${planted}\n`,
		);
		expect((await push()).status).toBe("pushed");
		expect(existsSync(canary)).toBe(false);
	});

	test("the operator's global credential helper is still allowed", async () => {
		await writeFile(
			join(home, ".gitconfig"),
			"[credential]\n\thelper = store\n",
		);
		expect((await push()).status).toBe("pushed");
	});

	test("an ext:: approved url is refused and not executed", async () => {
		const r = await hardenedPush({
			projectRoot: root,
			branch: "main",
			target: { url: `ext::sh -c "touch ${canary}"`, allowLocal: true },
			landingRoot: join(base, "landing"),
			environment,
		});
		expect(r.status).toBe("refused");
		expect(existsSync(canary)).toBe(false);
	});

	test("a branch that parses as an option is refused", async () => {
		const r = await hardenedPush({
			projectRoot: root,
			branch: "--receive-pack=/bin/false",
			target: { url: remote, allowLocal: true },
			landingRoot: join(base, "landing"),
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

describe("the push destination", () => {
	let evil: string;

	beforeEach(async () => {
		evil = join(base, "evil.git");
		await gitOk(["init", "-q", "--bare", "-b", "main", evil], base);
		await writeFile(
			join(evil, "hooks/pre-receive"),
			`#!/bin/sh\ntouch "${canary}"\n`,
			{ mode: 0o755 },
		);
	});

	test("a rewritten remote url is ignored: the approved URL gets the push", async () => {
		await gitOk(["remote", "set-url", "origin", evil], root);
		expect((await push()).status).toBe("pushed");
		expect(existsSync(canary)).toBe(false);
		expect(await gitOk(["rev-parse", "main"], remote)).toBe(
			await gitOk(["rev-parse", "main"], root),
		);
		expect(
			(await git(["rev-parse", "--verify", "-q", "main"], evil)).exitCode,
		).not.toBe(0);
	});

	for (const key of [
		"remote.origin.pushurl",
		"url.EVIL.insteadOf",
		"url.EVIL.pushInsteadOf",
	]) {
		test(`repository ${key} refuses the push and runs no remote hook`, async () => {
			const name = key.replace("EVIL", evil);
			const value = key.startsWith("url.") ? remote : evil;
			await gitOk(["config", name, value], root);
			const r = await push();
			expect(r.status).toBe("refused");
			expect(existsSync(canary)).toBe(false);
			expect(
				(await git(["rev-parse", "--verify", "-q", "main"], evil)).exitCode,
			).not.toBe(0);
		});
	}

	test("no approved URL refuses, with the fix", async () => {
		const r = await hardenedPush({
			projectRoot: root,
			branch: "main",
			target: null,
			landingRoot: join(base, "landing"),
			environment,
		});
		expect(r.status).toBe("refused");
		expect(r.status === "refused" && r.reason).toContain("pushUrl");
	});

	test("a local path needs the owner's explicit approval", async () => {
		const r = await hardenedPush({
			projectRoot: root,
			branch: "main",
			target: { url: evil },
			landingRoot: join(base, "landing"),
			environment,
		});
		expect(r.status).toBe("refused");
		expect(existsSync(canary)).toBe(false);
	});

	test("the URL classifier", () => {
		for (const url of [
			"https://example.test/a.git",
			"ssh://git@example.test/a.git",
			"git@example.test:a/b.git",
		]) {
			expect(pushUrlRefusal({ url })).toBeNull();
		}
		for (const url of [
			"/srv/a.git",
			"file:///srv/a.git",
			"../a.git",
			'ext::sh -c "id"',
			"fd::3",
			"http://example.test/a.git",
			"--upload-pack=/bin/false",
			"https://a\nb",
		]) {
			expect(pushUrlRefusal({ url })).not.toBeNull();
		}
	});

	test("the landing repository's config has no remote, hook or url key", async () => {
		await gitOk(["config", "hook.x.event", "pre-push"], root).catch(() => {});
		await gitOk(["config", "--unset", "hook.x.event"], root);
		expect((await push()).status).toBe("pushed");
		const landing = join(base, "landing");
		const [dir] = await readdir(landing);
		const config = await readFile(
			join(landing, dir as string, "config"),
			"utf8",
		);
		expect(config).not.toMatch(/remote|hook|url|include/i);
	});
});
