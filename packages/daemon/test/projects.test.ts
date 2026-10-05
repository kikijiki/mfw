import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boot } from "../src/boot.ts";
import { configPath, loadConfig, saveConfig } from "../src/config.ts";
import { git } from "../src/git.ts";
import { acquireKernelLock } from "../src/kernel-lock.ts";
import { silentLogger } from "../src/log.ts";
import type { Orchestrator } from "../src/services.ts";

/**
 * Attaching and detaching a project at runtime. Detach means "mfw lets go",
 * not "delete the user's work", so removal tests also assert the repository,
 * history and board survive. Uses a temp MFW_HOME, never the operator's config.
 */

interface Env {
	home: string;
	repos: string[];
	orchestrator: Orchestrator;
}

const envs: Env[] = [];
const savedHome = process.env.MFW_HOME;

async function makeRepo(name: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), `mfw-proj-${name}-`));
	await git(["init", "-q", "-b", "main", "."], root);
	await git(["config", "user.email", "t@t"], root);
	await git(["config", "user.name", "t"], root);
	await writeFile(join(root, "app.ts"), "export const x = 1;\n");
	await git(["add", "-A"], root);
	await git(["commit", "-qm", "init"], root);
	return root;
}

async function freshEnv(): Promise<Env> {
	const home = await mkdtemp(join(tmpdir(), "mfw-home-"));
	process.env.MFW_HOME = home;
	const orchestrator = await boot({
		projects: [],
		log: silentLogger(),
		autostart: false,
	});
	const env: Env = { home, repos: [], orchestrator };
	envs.push(env);
	return env;
}

async function repoIn(env: Env, name: string): Promise<string> {
	const root = await makeRepo(name);
	env.repos.push(root);
	return root;
}

afterEach(async () => {
	for (const env of envs.splice(0)) {
		await env.orchestrator.shutdown().catch(() => {
			// a test may already have detached everything
		});
		await rm(env.home, { recursive: true, force: true });
		for (const root of env.repos) {
			await rm(root, { recursive: true, force: true });
		}
	}
	if (savedHome === undefined) delete process.env.MFW_HOME;
	else process.env.MFW_HOME = savedHome;
});

describe("adding a project", () => {
	test("a git repository attaches and is written to config.json", async () => {
		const env = await freshEnv();
		const root = await repoIn(env, "add");

		const svc = await env.orchestrator.attach({ name: "demo", root });

		expect(svc.name).toBe("demo");
		expect(env.orchestrator.list().map((s) => s.name)).toEqual(["demo"]);
		expect(existsSync(join(root, ".mfw", "mfw.db"))).toBe(true);
		const stored = await loadConfig();
		expect(stored.projects.map((p) => p.name)).toEqual(["demo"]);
		expect(stored.projects[0]?.root).toBe(root);
		expect(await readFile(configPath(), "utf8")).toContain("demo");
	});

	test("a directory that is not a git repository is refused, and nothing is written", async () => {
		const env = await freshEnv();
		const plain = await mkdtemp(join(tmpdir(), "mfw-plain-"));
		env.repos.push(plain);

		expect(
			env.orchestrator.attach({ name: "nope", root: plain }),
		).rejects.toThrow("not a git repository");

		expect(env.orchestrator.list()).toEqual([]);
		expect((await loadConfig()).projects).toEqual([]);
		// Refusing must not leave `.mfw` behind.
		expect(existsSync(join(plain, ".mfw"))).toBe(false);
	});

	test("a path inside a repository but not its root is refused", async () => {
		const env = await freshEnv();
		const root = await repoIn(env, "sub");
		const sub = join(root, "packages", "inner");
		await mkdir(sub, { recursive: true });

		expect(
			env.orchestrator.attach({ name: "inner", root: sub }),
		).rejects.toThrow("is not its root");
	});

	test("a name that is already attached is refused", async () => {
		const env = await freshEnv();
		const a = await repoIn(env, "dup-a");
		const b = await repoIn(env, "dup-b");
		await env.orchestrator.attach({ name: "demo", root: a });

		expect(env.orchestrator.attach({ name: "demo", root: b })).rejects.toThrow(
			"already attached",
		);

		expect((await loadConfig()).projects).toHaveLength(1);
	});

	test("the same root under a second name is refused", async () => {
		const env = await freshEnv();
		const root = await repoIn(env, "same-root");
		await env.orchestrator.attach({ name: "first", root });

		expect(env.orchestrator.attach({ name: "second", root })).rejects.toThrow(
			"already registered",
		);
	});

	/**
	 * Regression: the name check only consulted the in-memory map, so a project
	 * that failed to attach this boot (e.g. lock held by another daemon) left its
	 * name free, and a second config.json entry was appended under it.
	 */
	test("a name that is in config.json but failed to attach cannot be reused", async () => {
		const env = await freshEnv();
		const held = await repoIn(env, "held");
		const other = await repoIn(env, "other");
		await mkdir(join(held, ".mfw"), { recursive: true });
		const heldLock = await acquireKernelLock(join(held, ".mfw", "daemon.lock"));
		await saveConfig({ projects: [{ name: "demo", root: held }] });
		// End the bootstrap daemon (machine-wide home lock) before a fresh boot.
		await env.orchestrator.shutdown();

		const orchestrator = await boot({
			projects: (await loadConfig()).projects,
			log: silentLogger(),
			autostart: false,
		});
		await heldLock.release();
		env.orchestrator = orchestrator;
		expect(orchestrator.list()).toEqual([]); // the lock did its job

		expect(orchestrator.attach({ name: "demo", root: other })).rejects.toThrow(
			"already in config.json",
		);

		const names = (await loadConfig()).projects.map((p) => p.name);
		expect(names).toEqual(["demo"]);
		expect(names.length).toBe(new Set(names).size);
	});
});

/**
 * Regression: `boot()` did not validate roots, and its first writes are
 * `ensureGitExclude` and `mkdir(<root>/.mfw)`, so a moved or unmounted root was
 * silently recreated and reported healthy.
 */
describe("attaching from config at boot", () => {
	test("a configured root that is not a git repository is refused, and nothing is written", async () => {
		const env = await freshEnv();
		await env.orchestrator.shutdown();
		const plain = await mkdtemp(join(tmpdir(), "mfw-plain-boot-"));
		env.repos.push(plain);

		env.orchestrator = await boot({
			projects: [{ name: "phantom", root: plain }],
			log: silentLogger(),
			autostart: false,
		});

		expect(env.orchestrator.list()).toEqual([]);
		expect(existsSync(join(plain, ".mfw"))).toBe(false);
	});

	test("a configured root that no longer exists is not recreated", async () => {
		const env = await freshEnv();
		await env.orchestrator.shutdown();
		const gone = join(tmpdir(), `mfw-gone-${Date.now()}`);

		env.orchestrator = await boot({
			projects: [{ name: "vanished", root: gone }],
			log: silentLogger(),
			autostart: false,
		});

		expect(env.orchestrator.list()).toEqual([]);
		expect(existsSync(gone)).toBe(false);
	});

	/**
	 * Regression: `projects.set` silently dropped the first of two same-name
	 * entries while it still held its lock, db and loops, out of reach of
	 * `shutdown()`.
	 */
	test("a duplicate name in config.json does not orphan the first project", async () => {
		const env = await freshEnv();
		await env.orchestrator.shutdown();
		const first = await repoIn(env, "dup-first");
		const second = await repoIn(env, "dup-second");

		env.orchestrator = await boot({
			// Trailing slash: the repo check must normalize hand-edited paths, or this
			// entry is refused as "not its root" and the test passes for the wrong reason.
			projects: [
				{ name: "demo", root: `${first}/` },
				{ name: "demo", root: second },
			],
			log: silentLogger(),
			autostart: false,
		});

		// The first one wins; the second is refused rather than replacing it.
		expect(env.orchestrator.list().map((s) => s.root)).toEqual([first]);
		expect(existsSync(join(second, ".mfw", "daemon.lock"))).toBe(false);

		// shutdown reaches everything attached.
		await env.orchestrator.shutdown();
		expect(existsSync(join(first, ".mfw", "daemon.lock"))).toBe(true);
	});
});

describe("removing a project", () => {
	test("attach and detach racing on one name converge without a ghost", async () => {
		const env = await freshEnv();
		const root = await repoIn(env, "attach-detach-race");

		// attach takes the lifecycle domain synchronously; detach queues behind it, then removes that generation.
		const attaching = env.orchestrator.attach({ name: "demo", root });
		const detaching = env.orchestrator.detach("demo");
		const [attached, detached] = await Promise.all([attaching, detaching]);

		expect(attached.name).toBe("demo");
		expect(detached).toMatchObject({ name: "demo", configRemoved: true });
		expect(env.orchestrator.list()).toEqual([]);
		expect((await loadConfig(env.home)).projects).toEqual([]);
		expect(existsSync(join(root, ".mfw", "daemon.lock"))).toBe(true);
	});

	test("settings queued behind detach cannot resurrect the project", async () => {
		const env = await freshEnv();
		const root = await repoIn(env, "settings-detach-race");
		const svc = await env.orchestrator.attach({ name: "demo", root });

		const detaching = env.orchestrator.detach("demo");
		const staleUpdate = svc.settings.update({ maxConcurrent: 9 });
		await detaching;
		await expect(staleUpdate).rejects.toThrow("project 'demo' is detached");

		expect(env.orchestrator.list()).toEqual([]);
		expect((await loadConfig(env.home)).projects).toEqual([]);
	});

	test("detach converges memory and config before reporting windDown failures", async () => {
		const env = await freshEnv();
		const root = await repoIn(env, "detach-winddown-failure");
		const svc = await env.orchestrator.attach({ name: "demo", root });
		svc.board.flush = async () => {
			throw new Error("injected board flush failure");
		};

		await expect(env.orchestrator.detach("demo")).rejects.toThrow(
			/detached with cleanup errors/,
		);

		// Later windDown operations still ran; stale settings are tombstoned.
		expect(env.orchestrator.list()).toEqual([]);
		expect((await loadConfig(env.home)).projects).toEqual([]);
		expect(existsSync(join(root, ".mfw", "daemon.lock"))).toBe(true);
		await expect(svc.settings.update({ maxConcurrent: 8 })).rejects.toThrow(
			"project 'demo' is detached",
		);
	});

	test("detach lets go of the project and leaves the repository alone", async () => {
		const env = await freshEnv();
		const root = await repoIn(env, "detach");
		const svc = await env.orchestrator.attach({ name: "demo", root });
		const task = await svc.tasks.create({ title: "still here afterwards" });
		await svc.board.flush();
		const headBefore = (await git(["rev-parse", "HEAD"], root)).stdout.trim();

		const result = await env.orchestrator.detach("demo");

		expect(result).toMatchObject({
			name: "demo",
			configRemoved: true,
		});
		expect(env.orchestrator.list()).toEqual([]);
		expect((await loadConfig()).projects).toEqual([]);
		// The lock file remains but its kernel lock is released, so the path can be re-attached.
		expect(existsSync(join(root, ".mfw", "daemon.lock"))).toBe(true);

		expect(existsSync(join(root, "app.ts"))).toBe(true);
		expect((await git(["rev-parse", "HEAD"], root)).stdout.trim()).toBe(
			headBefore,
		);
		expect(existsSync(join(root, ".mfw"))).toBe(true);
		const board = join(root, ".mfw", "tasks");
		expect(
			existsSync(join(board, `${task.id}-still-here-afterwards`, "task.md")),
		).toBe(true);
	});

	test("re-attaching after a detach restores the board rather than rebuilding it", async () => {
		const env = await freshEnv();
		const root = await repoIn(env, "reattach");
		const first = await env.orchestrator.attach({ name: "demo", root });
		const task = await first.tasks.create({ title: "survives a detach" });
		await env.orchestrator.detach("demo");

		const again = await env.orchestrator.attach({ name: "demo", root });

		expect((await again.tasks.list()).map((t) => t.title)).toEqual([
			"survives a detach",
		]);
		expect((await again.tasks.get(task.id))?.id).toBe(task.id);
	});

	test("detaching has no repository-data deletion mode", async () => {
		const env = await freshEnv();
		const root = await repoIn(env, "detach-only");
		const svc = await env.orchestrator.attach({ name: "demo", root });
		const task = await svc.tasks.create({ title: "must remain" });
		await svc.board.flush();
		const statusBefore = (await git(["status", "--porcelain"], root)).stdout;

		await env.orchestrator.detach("demo");

		expect(existsSync(join(root, ".mfw", "mfw.db"))).toBe(true);
		expect(
			existsSync(
				join(root, ".mfw", "tasks", `${task.id}-must-remain`, "task.md"),
			),
		).toBe(true);
		expect((await git(["status", "--porcelain"], root)).stdout).toBe(
			statusBefore,
		);
	});

	test("detaching an unknown project is an error, not a silent no-op", async () => {
		const env = await freshEnv();

		expect(env.orchestrator.detach("ghost")).rejects.toThrow(
			"unknown project 'ghost'",
		);
	});

	test("a failed config write leaves the project attached in memory and on disk", async () => {
		const env = await freshEnv();
		const root = await repoIn(env, "detach-write-failure");
		await env.orchestrator.attach({ name: "demo", root });

		await chmod(env.home, 0o500);
		try {
			await expect(env.orchestrator.detach("demo")).rejects.toThrow();
			expect(env.orchestrator.list().map((project) => project.name)).toEqual([
				"demo",
			]);
			expect((await loadConfig(env.home)).projects.map((p) => p.name)).toEqual([
				"demo",
			]);
			expect(existsSync(join(root, ".mfw", "daemon.lock"))).toBe(true);
		} finally {
			await chmod(env.home, 0o700);
		}
	});

	test("custom-home global dispatch and project settings never touch ambient default state", async () => {
		const env = await freshEnv();
		const root = await repoIn(env, "custom-home");
		const project = await env.orchestrator.attach({ name: "demo", root });
		const ambientDefault = join(env.home, "ambient-default");
		process.env.MFW_HOME = ambientDefault;

		await Promise.all([
			env.orchestrator.globalDispatch.setPaused({ reason: "operator" }),
			project.settings.update({ maxConcurrent: 7 }),
		]);

		const custom = await loadConfig(env.home);
		expect(custom.dispatchPaused).toBe(true);
		expect(custom.projects[0]?.maxConcurrent).toBe(7);
		expect(await loadConfig(ambientDefault)).toEqual({ projects: [] });
		expect((await project.settings.get()).configPath).toBe(
			configPath(env.home),
		);
	});
});
