import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import { EventBus } from "@mfw/db/eventlog";
import { createCheckSandbox } from "../src/containment/check-sandbox.ts";
import { git } from "../src/git.ts";
import { silentLogger } from "../src/log.ts";
import { Maintenance } from "../src/maintenance.ts";
import { reopenDefinitionHash, setReopenPolicy } from "../src/reopen-policy.ts";
import { RunRegistry } from "../src/run-registry.ts";
import {
	clearRunWorkspace,
	configureRunWorkspace,
} from "../src/run-workspace/factory.ts";
import type { TaskService } from "../src/task-service.ts";
import {
	verify,
	verifyInClone,
	worktreeHostExecution,
} from "../src/verifier.ts";
import { MFW_EXCLUDE, makeTasks } from "./fixtures/board.ts";
import { cagedSteps } from "./support/caged-launch.ts";

/**
 * Security review P7, B1 (X1b). The owner's command is the harmless
 * `sh check.sh`, and the candidate's `check.sh` acts only where it can see the
 * fixture home, so it stays quiet in the verifier and fires on the host.
 */

const FIXTURES = resolve(import.meta.dir, "../../../.work/live-sandbox");
const BWRAP = Bun.which("bwrap");

function skipReason(): string | null {
	if (process.arch !== "x64") return "seccomp is x86_64 only";
	if (!BWRAP) return "no bwrap";
	const r = Bun.spawnSync([
		BWRAP,
		"--unshare-all",
		"--unshare-user",
		"--disable-userns",
		"--ro-bind",
		"/",
		"/",
		"--proc",
		"/proc",
		"--dev",
		"/dev",
		"--",
		"true",
	]);
	return r.exitCode === 0 ? null : "bwrap cannot run here";
}
const skip = skipReason();
if (skip) console.log(`[sweep-no-host-exec] skipped: ${skip}`);

const dod = {
	verifier: "deterministic" as const,
	checks: [{ run: "sh check.sh", expect_exit: 0 }],
};

describe("host execution of a check", () => {
	test("only an interactive worktree run may ask for it", () => {
		expect(worktreeHostExecution("interactive")).toEqual({
			hostExecution: "interactive-worktree",
		});
		expect(worktreeHostExecution("autonomous")).toEqual({});
		expect(worktreeHostExecution(undefined)).toEqual({});
	});

	test("a clone is never host-executed, even if a caller asks", async () => {
		let hostRan = false;
		const r = await verifyInClone(
			{
				checkRunner: null,
				with: (_rev, _label, fn) =>
					fn({
						id: "x",
						path: "/nonexistent",
						sha: "s",
						dispose: async () => {},
					}),
			},
			"s",
			"l",
			{
				verifier: "deterministic",
				checks: [{ run: "exit 0", expect_exit: 0 }],
			},
			"b",
			{ hostExecution: "interactive-worktree" },
		);
		hostRan = r.passed;
		expect(hostRan).toBe(false);
		expect(r.checks[0]?.detail).toContain("no_verifier_sandbox");
	});
});

describe.skipIf(skip !== null)("X1b: merged candidate code", () => {
	let base: string;
	let root: string;
	let marker: string;
	let handle: ProjectDbHandle;
	let bus: EventBus;
	let tasks: TaskService;
	let registry: RunRegistry;
	let maint: Maintenance;

	const commitCheck = async (body: string) => {
		writeFileSync(join(root, "check.sh"), body);
		await git(["add", "check.sh"], root);
		await git(["commit", "-q", "-m", "check"], root);
	};
	const hostile = () =>
		`if [ -e '${base}/home/.ssh/id_canary' ]; then echo fired > '${marker}'; fi\nexit 0\n`;

	beforeEach(async () => {
		mkdirSync(FIXTURES, { recursive: true });
		base = realpathSync(mkdtempSync(join(FIXTURES, "sweep-")));
		mkdirSync(join(base, "home/.ssh"), { recursive: true });
		writeFileSync(join(base, "home/.ssh/id_canary"), "canary\n");
		marker = join(base, "fired-on-host");
		root = join(base, "project");
		mkdirSync(root);
		await git(["init", "-q", "-b", "main"], root);
		await git(["config", "user.email", "t@t"], root);
		await git(["config", "user.name", "t"], root);
		writeFileSync(join(root, "a.txt"), "a\n");
		await git(["add", "-A"], root);
		await git(["commit", "-q", "-m", "init"], root);
		writeFileSync(join(root, ".git/info/exclude"), MFW_EXCLUDE);
		const mfwDir = join(root, ".mfw");
		handle = await openProjectDb(mfwDir);
		bus = new EventBus();
		tasks = await makeTasks(handle, bus, mfwDir, "MFW");
		registry = new RunRegistry({
			handle,
			bus,
			runsDir: join(mfwDir, "runs"),
		});
		const mfwHome = join(base, "mfw");
		mkdirSync(mfwHome);
		const shim = join(base, "systemd-run-shim");
		writeFileSync(
			shim,
			'#!/bin/sh\nwhile [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n',
		);
		chmodSync(shim, 0o755);
		configureRunWorkspace(root, {
			kind: "worktree",
			clone: {
				workspaceRoot: join(mfwHome, "workspaces"),
				checkRunner: createCheckSandbox({
					db: handle.db,
					mfwHome,
					projectRoot: root,
					stateDir: mfwDir,
					steps: cagedSteps({
						home: join(base, "home"),
						path: process.env.PATH ?? "",
						shim,
					}),
				}),
			},
		});
		maint = new Maintenance({
			handle,
			bus,
			tasks,
			registry,
			log: silentLogger(),
			projectRoot: root,
			integrationBranch: "main",
		});
	});

	afterEach(() => {
		clearRunWorkspace(root);
		handle.close();
		rmSync(base, { recursive: true, force: true });
	});

	const doneTask = async () => {
		const t = await tasks.create({ title: "checked", dod });
		const run = await registry.create({
			kind: "task",
			taskId: t.id,
			label: t.id,
			model: "m",
			cwd: root,
		});
		await registry.finish(run.id, "completed", "merged");
		await tasks.move(t.id, "done", "scheduler");
		return t;
	};

	test("positive control: the script fires when it really runs on the host", async () => {
		await commitCheck(hostile());
		const r = Bun.spawnSync(["sh", join(root, "check.sh")]);
		expect(r.exitCode).toBe(0);
		expect(existsSync(marker)).toBe(true);
		rmSync(marker);
	});

	test("the regression sweep does not run it on the host", async () => {
		await commitCheck(hostile());
		await doneTask();
		const r = await maint.regressionSweep();
		expect(r.checked).toBe(1);
		expect(r.broken).toEqual([]);
		expect(existsSync(marker)).toBe(false);
	}, 60_000);

	test("the corroboration rerun does not run it on the host", async () => {
		// Green here, then the tip fails, so the sweep reruns the check at green.
		await commitCheck(hostile());
		await doneTask();
		expect((await maint.regressionSweep()).broken).toEqual([]);
		await commitCheck("exit 1\n");
		await maint.regressionSweep();
		expect(existsSync(marker)).toBe(false);
	}, 90_000);

	test("an armed reopen check does not run it on the host", async () => {
		await commitCheck(hostile());
		const when = [{ run: "sh check.sh", expect_exit: 0 }];
		const t = await tasks.create({ title: "parked", reopenWhen: when });
		await tasks.move(t.id, "blocked", "human", "waiting");
		await setReopenPolicy(root, t.id, {
			hash: reopenDefinitionHash(
				(await tasks.get(t.id))?.reopenWhen ?? [],
				undefined,
				"main",
			),
			checkout: "primary",
			armedAt: Date.now(),
		});
		expect((await maint.reopenByCommand()).checked).toEqual([t.id]);
		expect(existsSync(marker)).toBe(false);
	}, 60_000);

	test("with no verifier sandbox the sweep runs nothing and blames nothing", async () => {
		await commitCheck(hostile());
		const t = await doneTask();
		clearRunWorkspace(root);
		const r = await maint.regressionSweep();
		expect(r.infra).toEqual([t.id]);
		expect(r.broken).toEqual([]);
		expect(r.mainRed).toBe(false);
		expect(existsSync(marker)).toBe(false);
	}, 30_000);

	test("verify() refuses host execution unless explicitly asked", async () => {
		await commitCheck(hostile());
		const r = await verify(root, dod, "x");
		expect(r.passed).toBe(false);
		expect(r.crashed).toBe(true);
		expect(r.checks[0]?.detail).toContain("host_execution_refused");
		expect(existsSync(marker)).toBe(false);
	});
});
