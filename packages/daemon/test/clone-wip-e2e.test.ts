import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import { EventBus } from "@mfw/db/eventlog";
import { mergeJobs, runs } from "@mfw/db/schema";
import { eq } from "drizzle-orm";
import {
	type AgentLaunchRequest,
	launchAgentSandbox,
} from "../src/containment/agent-launch.ts";
import {
	AGENT_BASE_TOOLS,
	TEMPORARY_FLEET_WRITABLE,
} from "../src/containment/agent-profile.ts";
import { ensureRunDirLayout } from "../src/containment/run-dir.ts";
import {
	assertRunDead,
	liveRunProcesses,
} from "../src/containment/run-liveness.ts";
import { git } from "../src/git.ts";
import { quarantineRef } from "../src/host-git/fetch.ts";
import { silentLogger } from "../src/log.ts";
import { type MergeJobView, MergeQueue } from "../src/merge-queue.ts";
import {
	CloneRunWorkspace,
	type ResultImportEvent,
} from "../src/run-workspace/clone-impl.ts";
import type { RunWorkspaceHandle } from "../src/run-workspace/run-workspace.ts";
import { cloneScopeFiles } from "../src/run-workspace/scope-files.ts";
import { VerifierClones } from "../src/run-workspace/verifier-clone.ts";
import { installWipHelper } from "../src/run-workspace/wip-helper-install.ts";
import {
	sandboxFinalSnapshot,
	wipLaunchRequestPath,
	writeWipLaunchRequest,
} from "../src/run-workspace/wip-snapshot.ts";
import { MFW_EXCLUDE } from "./fixtures/board.ts";
import { type CageConfig, cagedSteps } from "./support/caged-launch.ts";

/**
 * The clone result path end to end: a fake agent CLI under real bwrap, the real
 * launcher, probe and gate, the real helper, HostGit import and merge queue.
 * Only the systemd scope is a stand-in (see `caged-launch.ts`). Every agent
 * script starts with a positive containment check and exits 99 without acting
 * if it is not plainly inside the sandbox. Fixture repositories only.
 */

const BWRAP = Bun.which("bwrap");
const GIT = Bun.which("git");
const BUN = realpathSync(process.execPath);
const FIXTURES = resolve(import.meta.dir, "../../../.live-sandbox");
const CAGED = resolve(import.meta.dir, "support/caged-launcher.ts");

function skipReason(): string | null {
	if (process.arch !== "x64") return "seccomp is x86_64 only";
	if (!BWRAP || !GIT) return "no bwrap or git";
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
if (skip && process.env.MFW_REQUIRE_LIVE_SANDBOX === "1") {
	throw new Error(`MFW_REQUIRE_LIVE_SANDBOX is set, but ${skip}`);
}
if (skip) console.log(`[clone-wip-e2e] skipped: ${skip}`);

function toolDirs(): string[] {
	const dirs = AGENT_BASE_TOOLS.flatMap((tool) => {
		const found = Bun.which(tool);
		return found ? [dirname(realpathSync(found))] : [];
	});
	return [...new Set(dirs)];
}

interface Fixture {
	base: string;
	home: string;
	bin: string;
	project: string;
	stateDir: string;
	mfwHome: string;
	runId: string;
	runDir: string;
	control: string;
	outbox: string;
	cage: CageConfig;
	handle: ProjectDbHandle;
	ws: CloneRunWorkspace;
	seeded: RunWorkspaceHandle;
	req: AgentLaunchRequest;
	state: { alive: boolean };
	imports: ResultImportEvent[];
	pwn: string;
	canary: string;
}

let f: Fixture;

async function makeFixture(): Promise<Fixture> {
	mkdirSync(FIXTURES, { recursive: true });
	const base = realpathSync(mkdtempSync(join(FIXTURES, "wip-e2e-")));
	const home = join(base, "home");
	const bin = join(home, ".local/bin");
	mkdirSync(bin, { recursive: true });
	mkdirSync(join(home, ".ssh"));
	writeFileSync(join(home, ".ssh/id_canary"), "not a real key\n");
	const mfwHome = join(base, "mfw");
	mkdirSync(mfwHome);
	writeFileSync(join(mfwHome, "credentials.json"), "{}\n");
	for (const rel of TEMPORARY_FLEET_WRITABLE.claude) {
		mkdirSync(join(mfwHome, "agents/claude", rel), { recursive: true });
	}
	writeFileSync(join(mfwHome, "agents/claude/settings.json"), "{}\n");
	const project = join(base, "project");
	mkdirSync(project);
	const g = (...args: string[]) => git(args, project);
	await g("init", "-q", "-b", "main");
	await g("config", "user.email", "t@t");
	await g("config", "user.name", "t");
	writeFileSync(join(project, "a.txt"), "one\n");
	await g("add", "-A");
	await g("commit", "-q", "-m", "init");
	writeFileSync(join(project, ".git/info/exclude"), MFW_EXCLUDE);
	const stateDir = join(project, ".mfw");
	const handle = await openProjectDb(stateDir);
	const runId = `e2e-${randomUUID().slice(0, 12)}`;
	const runDir = join(stateDir, "runs", runId);
	const layout = ensureRunDirLayout(runDir);
	const control = join(layout.control, "control.jsonl");
	writeFileSync(control, "");
	installWipHelper(layout.control);

	// Host-only: the sandbox cannot see it, so it fires only if the host runs it.
	const canary = join(base, "HOST_EXECUTED");
	const pwn = join(base, "pwn.sh");
	writeFileSync(pwn, `#!/bin/sh\necho ran >> '${canary}'\n`);
	chmodSync(pwn, 0o755);

	const shim = join(base, "systemd-run-shim");
	writeFileSync(
		shim,
		'#!/bin/sh\nwhile [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n',
	);
	chmodSync(shim, 0o755);
	const cage: CageConfig = {
		home,
		path: [
			bin,
			dirname(BUN),
			dirname(realpathSync(GIT as string)),
			...toolDirs(),
		].join(":"),
		shim,
	};
	const state = { alive: false };
	const imports: ResultImportEvent[] = [];
	const ws = new CloneRunWorkspace(project, {
		workspaceRoot: join(mfwHome, "workspaces"),
		scratchRoot: join(mfwHome, "workspace-scratch"),
		runDirOf: () => runDir,
		controlPath: () => control,
		assertProcessesDead: () => {
			if (state.alive) throw new Error("the fake agent is running");
		},
		finalSnapshot: sandboxFinalSnapshot({
			runDirOf: () => runDir,
			timeoutMs: 20_000,
			launcher: (requestPath) => ({
				argv: [
					BUN,
					"--config=/dev/null",
					"--no-env-file",
					"run",
					CAGED,
					requestPath,
					"--",
					"bun",
				],
				env: {
					PATH: process.env.PATH,
					HOME: home,
					MFW_CAGE_CONFIG: JSON.stringify(cage),
				},
			}),
		}),
		onResultImport: (_id, event) => {
			imports.push(event);
		},
	});
	const seeded = await ws.seed(runId);
	const req: AgentLaunchRequest = {
		version: 1,
		runId,
		role: "task",
		approvalMode: "autonomous",
		cli: "claude",
		tree: seeded.path,
		runDir,
		projectRoot: project,
		stateDir,
		mfwHome,
		env: { MFW_RUN_ID: runId },
		secretNames: [],
	};
	writeWipLaunchRequest(req);
	await handle.db.insert(runs).values({
		id: runId,
		kind: "task",
		label: "e2e",
		model: "sonnet",
		cwd: seeded.path,
		worktreePath: seeded.path,
		branch: seeded.branch,
		integrationBranch: "main",
		startedAt: new Date(),
	});
	return {
		base,
		home,
		bin,
		project,
		stateDir,
		mfwHome,
		runId,
		runDir,
		control,
		outbox: layout.outbox,
		cage,
		handle,
		ws,
		seeded,
		req,
		state,
		imports,
		pwn,
		canary,
	};
}

/** Exit 99, doing nothing, unless this is plainly the sandbox. */
const guard = (x: Fixture) => `
[ "$HOME" = /sandbox/agent ] || exit 99
[ "$(pwd)" = /work ] || exit 99
[ "$GIT_DIR" = /git ] || exit 99
for p in '${x.project}' '${x.mfwHome}/credentials.json' '${x.home}/.ssh' '${x.pwn}'; do
  [ ! -e "$p" ] || exit 99
done
if touch /mfw-not-contained 2>/dev/null; then exit 99; fi
gc() { git -c user.name=agent -c user.email=a@a -c core.hooksPath=/dev/null "$@"; }
`;

/** Wait for the host's go-ahead, so a live sample sees a known state. */
const WAIT_GO = `
i=0
while [ ! -e /mfw-run/outbox/go ]; do
  i=$((i+1)); [ "$i" -lt 600 ] || exit 98
  sleep 0.05
done
`;

async function runAgent(
	x: Fixture,
	body: string,
	whileRunning?: () => Promise<void>,
): Promise<number> {
	const script = join(x.bin, "claude");
	writeFileSync(script, `#!/bin/sh\n${guard(x)}\n${body}\nexit 0\n`);
	chmodSync(script, 0o755);
	const launched = await launchAgentSandbox(x.req, ["claude"], {
		...cagedSteps(x.cage),
		db: x.handle.db,
		secretValue: () => undefined,
		warn: () => {},
	});
	if (!launched.ok) {
		throw new Error(`refused: ${launched.code}: ${launched.reason}`);
	}
	x.state.alive = true;
	const { child } = launched;
	(child.stdin as unknown as { end(): void }).end();
	const output = Promise.all([
		new Response(child.stdout as never).text(),
		new Response(child.stderr as never).text(),
	]);
	try {
		await whileRunning?.();
	} finally {
		writeFileSync(join(x.outbox, "go"), "");
	}
	const code = await child.exited;
	await output;
	x.state.alive = false;
	return code;
}

function queueFor(x: Fixture) {
	const merged: string[] = [];
	const parked: { reason: string; kind: string }[] = [];
	const clones = new VerifierClones({
		workspaceRoot: join(x.mfwHome, "workspaces"),
		primaryRoot: x.project,
	});
	const queue = new MergeQueue({
		handle: x.handle,
		bus: new EventBus(),
		projectRoot: x.project,
		log: silentLogger(),
		reverify: async () => ({ passed: true }),
		// The project's check, run in a disposable host-owned clone of the merge.
		verifyMerge: (_job: MergeJobView, sha: string) =>
			clones.with(sha, "e2e", async (clone) => {
				const text = readFileSync(join(clone.path, "a.txt"), "utf8");
				return text.includes("HOSTILE")
					? { passed: false, detail: "the check failed" }
					: { passed: true };
			}),
		onMerged: async (_job, sha) => {
			merged.push(sha);
		},
		onParked: async (_job, reason, kind) => {
			parked.push({ reason, kind });
		},
	});
	return { queue, merged, parked };
}

const mainFile = async (x: Fixture, file: string) =>
	(await git(["show", `main:${file}`], x.project)).stdout;
const refsOf = async (x: Fixture, prefix: string) =>
	(await git(["for-each-ref", "--format=%(refname)", prefix], x.project)).stdout
		.split("\n")
		.filter(Boolean);

/** The canary is absent, and the positive control proves it would have fired. */
function expectHostRanNothing(x: Fixture): void {
	expect(existsSync(x.canary)).toBe(false);
	expect(Bun.spawnSync([x.pwn]).exitCode).toBe(0);
	expect(existsSync(x.canary)).toBe(true);
}

describe.skipIf(skip !== null)("a clone run end to end", () => {
	beforeEach(async () => {
		f = await makeFixture();
	});
	afterEach(() => {
		f.handle.close();
		rmSync(f.base, { recursive: true, force: true });
	});

	test("a good change is sampled live, imported, verified and merged", async () => {
		let liveFiles: string[] = [];
		const code = await runAgent(
			f,
			`
echo good > a.txt
gc add -A
gc commit -q -m "good change"
echo pending > uncommitted.txt
: > /mfw-run/outbox/ready
${WAIT_GO}
`,
			async () => {
				for (let i = 0; i < 400; i++) {
					if (existsSync(join(f.outbox, "ready"))) break;
					await Bun.sleep(25);
				}
				liveFiles = (
					await cloneScopeFiles(
						f.ws,
						f.project,
						f.seeded.path,
						f.seeded.baseSha,
						{ timeoutMs: 20_000 },
					)
				).files;
				// A live sample is not a result.
				expect(await refsOf(f, quarantineRef(f.runId))).toEqual([]);
			},
		);
		expect(code).toBe(0);
		expect(liveFiles).toEqual(["a.txt", "uncommitted.txt"]);

		const result = await f.ws.fetchResult(f.seeded);
		expect(result.failure).toBeUndefined();
		expect(result.sha).not.toBeNull();
		expect(f.imports).toHaveLength(1);
		expect(f.imports[0]).toMatchObject({
			outcome: "imported",
			tip: result.sha,
		});
		expect((f.imports[0] as { claim?: { id: string } }).claim?.id).toBe(
			"final",
		);

		const { queue, merged, parked } = queueFor(f);
		await queue.enqueue({
			runId: f.runId,
			taskId: "T-1",
			branch: f.seeded.branch,
			targetBranch: "main",
		});
		expect(await queue.tick()).toBe("merged");
		expect(parked).toEqual([]);
		expect(merged).toHaveLength(1);
		expect(await mainFile(f, "a.txt")).toBe("good");
	}, 120_000);

	test("hostile refs, hooks, config and a forged reply change nothing on the host, and the check refuses the merge", async () => {
		// Another run's result, which this run must not be able to move.
		const base = f.seeded.baseSha;
		const other = "refs/mfw/quarantine/other-run";
		expect((await git(["update-ref", other, base], f.project)).exitCode).toBe(
			0,
		);
		const mainBefore = (await git(["rev-parse", "main"], f.project)).stdout;

		const code = await runAgent(
			f,
			`
echo HOSTILE > a.txt
gc add -A
gc commit -q -m "hostile change"
tip=$(git rev-parse HEAD)
gc update-ref refs/heads/mfw/other-run "$tip"
gc update-ref refs/heads/main "$tip"
gc update-ref refs/mfw/quarantine/other-run "$tip"
gc update-ref refs/heads/mfw-wip/other-run/1 "$tip"
mkdir -p /git/hooks
for h in pre-commit post-commit post-checkout post-merge pre-push reference-transaction fsmonitor-watchman; do
  printf '#!/bin/sh\\n${f.pwn}\\n' > "/git/hooks/$h"
  chmod +x "/git/hooks/$h"
done
git config core.fsmonitor '${f.pwn}'
git config core.sshCommand '${f.pwn}'
git config core.pager '${f.pwn}'
git config core.gitProxy '${f.pwn}'
git config core.askPass '${f.pwn}'
git config diff.external '${f.pwn}'
git config uploadpack.packObjectsHook '${f.pwn}'
git config credential.helper '!${f.pwn}'
git config alias.status '!${f.pwn}'
echo '{"id":"final","ok":true,"sha":"0000000000000000000000000000000000000000"}' > /mfw-run/outbox/wip-ack.json
echo forged > /mfw-run/outbox/result.bundle
`,
		);
		expect(code).toBe(0);

		const result = await f.ws.fetchResult(f.seeded);
		expect(result.failure).toBeUndefined();
		expect(result.sha).toMatch(/^[0-9a-f]{40}$/);
		expect(result.sha).not.toBe("0".repeat(40));
		// The strict refspecs: only this run's refs arrived.
		expect((await git(["rev-parse", other], f.project)).stdout).toBe(base);
		expect((await git(["rev-parse", "main"], f.project)).stdout).toBe(
			mainBefore,
		);
		expect(await refsOf(f, "refs/heads/mfw/other-run")).toEqual([]);
		expect(await refsOf(f, "refs/heads/mfw-wip/")).toEqual([]);
		expect(await refsOf(f, "refs/mfw/quarantine-wip/other-run/")).toEqual([]);

		const { queue, merged } = queueFor(f);
		await queue.enqueue({
			runId: f.runId,
			taskId: "T-2",
			branch: f.seeded.branch,
			targetBranch: "main",
		});
		expect(await queue.tick()).toBe("parked");
		expect(merged).toEqual([]);
		// Parked below the retry budget: the job row is the record.
		const [job] = await f.handle.db
			.select({ state: mergeJobs.state, error: mergeJobs.error })
			.from(mergeJobs)
			.where(eq(mergeJobs.runId, f.runId));
		expect(job?.state).toBe("parked");
		expect(job?.error).toContain("failed verification");
		expect((await git(["rev-parse", "main"], f.project)).stdout).toBe(
			mainBefore,
		);
		expect(await mainFile(f, "a.txt")).toBe("one");
		expectHostRanNothing(f);
	}, 120_000);

	test("a change to a protected file is refused at import and never reaches the quarantine", async () => {
		const code = await runAgent(
			f,
			`
printf '* filter=pwn\\n' > .gitattributes
gc add -A
gc commit -q -m "plant a filter"
`,
		);
		expect(code).toBe(0);
		const result = await f.ws.fetchResult(f.seeded);
		expect(result).toMatchObject({ sha: null, failure: "validation" });
		expect(await refsOf(f, quarantineRef(f.runId))).toEqual([]);
		expect(f.imports).toEqual([{ outcome: "refused", failure: "validation" }]);
	}, 120_000);

	test("work survives the agent killing the helper", async () => {
		const code = await runAgent(
			f,
			`
found=0
for p in /proc/[0-9]*; do
  if tr '\\0' ' ' < "$p/cmdline" 2>/dev/null | grep -q 'wip-helper.js watch'; then
    kill -KILL "\${p#/proc/}" && found=1
  fi
done
[ "$found" = 1 ] || exit 97
echo recovered > a.txt
gc add -A
gc commit -q -m "after the helper died"
`,
		);
		expect(code).toBe(0);
		const result = await f.ws.fetchResult(f.seeded);
		expect(result.failure).toBeUndefined();
		expect((await git(["show", `${result.sha}:a.txt`], f.project)).stdout).toBe(
			"recovered",
		);
	}, 120_000);

	test("a request to a dead helper times out and the live state stays empty", async () => {
		const code = await runAgent(
			f,
			`
for p in /proc/[0-9]*; do
  if tr '\\0' ' ' < "$p/cmdline" 2>/dev/null | grep -q 'wip-helper.js watch'; then
    kill -KILL "\${p#/proc/}"
  fi
done
: > /mfw-run/outbox/ready
${WAIT_GO}
`,
			async () => {
				for (let i = 0; i < 400; i++) {
					if (existsSync(join(f.outbox, "ready"))) break;
					await Bun.sleep(25);
				}
				await expect(
					f.ws.requestWip(f.seeded, { timeoutMs: 600, pollMs: 25 }),
				).rejects.toThrow(/did not answer/);
				expect(await refsOf(f, "refs/mfw/quarantine-live/")).toEqual([]);
			},
		);
		expect(code).toBe(0);
	}, 120_000);

	test("an agent that deletes its gitdir fails closed with a clear class", async () => {
		const code = await runAgent(
			f,
			`
mkdir /work/.gone
mv /git/objects /git/refs /git/HEAD /work/.gone/
`,
		);
		expect(code).toBe(0);
		const result = await f.ws.fetchResult(f.seeded);
		expect(result).toMatchObject({ sha: null, failure: "snapshot_failed" });
		expect(await refsOf(f, "refs/mfw/quarantine/")).toEqual([]);
		expect(await f.ws.hasLocalChanges(f.seeded)).toBe(true);
	}, 120_000);

	test("a planted commondir cannot bring the agent's config into the final snapshot (H3)", async () => {
		const code = await runAgent(
			f,
			`
command -v cp >/dev/null || exit 94
echo work > a.txt
gc add -A
gc commit -q -m "work"
cp -r /git /work/evil
printf '[core]\\n\\trepositoryformatversion = 0\\n[filter "x"]\\n\\tclean = "touch /mfw-run/outbox/FILTER_RAN; cat"\\n\\trequired = true\\n' > /work/evil/config
mkdir -p /work/evil/info /git/info
printf '* filter=x\\n' > /work/evil/info/attributes
printf '* filter=x\\n' > /git/info/attributes
echo /work/evil > /git/commondir
echo pending > pending.txt
`,
		);
		expect(code).toBe(0);
		const result = await f.ws.fetchResult(f.seeded);
		expect(existsSync(join(f.outbox, "FILTER_RAN"))).toBe(false);
		expect(result.failure).toBeUndefined();
		expect((await git(["show", `${result.sha}:a.txt`], f.project)).stdout).toBe(
			"work",
		);
		const left = readdirSync(join(dirname(f.seeded.path), "git")).sort();
		for (const name of left) {
			expect(["HEAD", "config", "objects", "packed-refs", "refs"]).toContain(
				name,
			);
		}
	}, 120_000);

	test("a gone tmux session is not proof: death comes from the launcher and sandbox (M1)", async () => {
		const script = join(f.bin, "claude");
		writeFileSync(
			script,
			`#!/bin/sh\n${guard(f)}\n: > /mfw-run/outbox/ready\nsleep 60\n`,
		);
		chmodSync(script, 0o755);
		const requestPath = join(f.runDir, "agent-request.json");
		writeFileSync(requestPath, JSON.stringify(f.req), { mode: 0o600 });
		const launcher = Bun.spawn(
			[
				BUN,
				"--config=/dev/null",
				"--no-env-file",
				"run",
				CAGED,
				requestPath,
				"--",
				"claude",
			],
			{
				cwd: f.runDir,
				env: {
					PATH: process.env.PATH,
					HOME: f.home,
					MFW_CAGE_CONFIG: JSON.stringify(f.cage),
				},
				stdin: "pipe",
				stdout: "ignore",
				stderr: "ignore",
			},
		);
		try {
			for (let i = 0; i < 800 && !existsSync(join(f.outbox, "ready")); i++) {
				await Bun.sleep(25);
			}
			expect(existsSync(join(f.outbox, "ready"))).toBe(true);
			const proof = (waitMs: number) =>
				assertRunDead({
					runId: f.runId,
					runDir: f.runDir,
					sessionLiveness: async () => false,
					waitMs,
				});
			expect(liveRunProcesses(f.runDir).length).toBeGreaterThanOrEqual(2);
			await expect(proof(100)).rejects.toThrow("still has running processes");
			launcher.kill("SIGKILL");
			await launcher.exited;
			await proof(10_000);
			expect(liveRunProcesses(f.runDir)).toEqual([]);
		} finally {
			launcher.kill("SIGKILL");
		}
	}, 120_000);

	test("a committed symlink out of the tree is refused at import", async () => {
		const code = await runAgent(
			f,
			`
ln -s /etc/passwd leak.txt
gc add -A
gc commit -q -m "symlink out of the tree"
`,
		);
		expect(code).toBe(0);
		const result = await f.ws.fetchResult(f.seeded);
		expect(result).toMatchObject({ sha: null, failure: "validation" });
		expect(await refsOf(f, quarantineRef(f.runId))).toEqual([]);
	}, 120_000);

	test("symlinked hooks, config and bundle are moved or refused without being followed", async () => {
		const victim = join(f.base, "victim");
		mkdirSync(victim);
		writeFileSync(join(victim, "keep"), "host file\n");
		const code = await runAgent(
			f,
			`
echo linked > a.txt
ln a.txt hardlink.txt
gc add -A
gc commit -q -m "hardlinked content"
[ ! -e /git/hooks ] || mv /git/hooks /work/.old-hooks
ln -s '${victim}' /git/hooks
mv /git/config /git/config.real
ln -s '${join(victim, "keep")}' /git/config
ln -sf '${join(victim, "keep")}' /mfw-run/outbox/result.bundle
`,
		);
		expect(code).toBe(0);
		const result = await f.ws.fetchResult(f.seeded);
		expect(result.failure).toBeUndefined();
		expect(
			(await git(["show", `${result.sha}:hardlink.txt`], f.project)).stdout,
		).toBe("linked");
		// The links moved; what they pointed at did not.
		expect(readFileSync(join(victim, "keep"), "utf8")).toBe("host file\n");
		expectHostRanNothing(f);
	}, 120_000);

	test("a socket planted in the clone is a final refusal, not an endless retry", async () => {
		const code = await runAgent(
			f,
			`
bun --config=/dev/null --no-env-file -e 'require("node:net").createServer().listen("/work/planted.sock", () => process.exit(0))'
[ -S /work/planted.sock ] || exit 95
`,
		);
		expect(code).toBe(0);
		const result = await f.ws.fetchResult(f.seeded);
		expect(result).toMatchObject({ sha: null, failure: "snapshot_refused" });
		expect(await refsOf(f, quarantineRef(f.runId))).toEqual([]);
		await f.ws.fetchResult(f.seeded);
		expect(f.imports).toHaveLength(1);
	}, 120_000);

	test("a hanging filter in the agent's config cannot hold the final snapshot", async () => {
		const code = await runAgent(
			f,
			`
command -v sleep >/dev/null || exit 96
git config filter.hang.clean 'sleep 600'
git config filter.hang.required true
printf '*.txt filter=hang\\n' > /git/info/attributes 2>/dev/null || { mkdir -p /git/info; printf '*.txt filter=hang\\n' > /git/info/attributes; }
echo changed > a.txt
`,
		);
		expect(code).toBe(0);
		const started = Date.now();
		const result = await f.ws.fetchResult(f.seeded);
		// The agent's config is out of the clone before the snapshot runs.
		expect(result.failure).toBeUndefined();
		expect(result.sha).toBe(f.seeded.baseSha);
		expect(Date.now() - started).toBeLessThan(15_000);
		const wip = await refsOf(f, `refs/mfw/quarantine-wip/${f.runId}/`);
		expect(wip).toHaveLength(1);
		expect((await git(["show", `${wip[0]}:a.txt`], f.project)).stdout).toBe(
			"changed",
		);
	}, 120_000);

	test("the stored snapshot request carries no agent env or secret", () => {
		const stored = JSON.parse(
			readFileSync(wipLaunchRequestPath(f.runDir), "utf8"),
		) as AgentLaunchRequest;
		expect(stored.purpose).toBe("wip-snapshot");
		expect(stored.env).toEqual({});
		expect(stored.secretNames).toEqual([]);
		expect(stored.egressSocketDir).toBeUndefined();
	});
});
