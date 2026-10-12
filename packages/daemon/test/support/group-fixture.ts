import "./tmux-test-socket.ts";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boot, type ProjectConfig } from "../../src/boot.ts";
import type { ActResult } from "../../src/brain-runtime/actions.ts";
import { git } from "../../src/git.ts";
import { silentLogger } from "../../src/log.ts";
import type { Orchestrator, ProjectServices } from "../../src/services.ts";
import { brainSpawn, openTurn, STUB_BRAIN } from "./brain-spawn.ts";
import { TEST_TMUX_SOCKET } from "./tmux-test-socket.ts";

/**
 * A real boot (git, tmux on the private socket, SQLite, finalize, merge queue)
 * with a scripted worker driver and a brain route that never wakes: the tests
 * act as the brain through the action service. A "crash" is `shutdown()`
 * (loops stop, tmux sessions stay) followed by a fresh boot over the same
 * state, which is what process-death recovery sees.
 *
 * The driver commits `feature.txt` (carrying its run id) unless its run id is
 * listed in the control file, in which case it commits nothing and the DoD
 * check fails. `slowMs` keeps a run alive long enough to crash around.
 */

const driverSource = (controlPath: string) => `
const dir = process.argv[2];
const cfg = JSON.parse(await Bun.file(dir + "/driver.json").text());
const { appendFileSync, readFileSync } = await import("node:fs");
let seq = 0;
const emit = (e) => appendFileSync(dir + "/events.jsonl",
  JSON.stringify({ ts: new Date().toISOString(), seq: seq++, ...e }) + "\\n");
emit({ type: "hello", provider: "claude-cli", capabilities: { steer: true } });
const control = JSON.parse(readFileSync(${JSON.stringify(controlPath)}, "utf8").toString() || "{}");
const runId = cfg.cwd.split("/").pop();
const slow = Number(control.slowMs ?? 0);
if (slow > 0) await Bun.sleep(slow);
if ((control.dirty ?? []).some((id) => cfg.cwd.includes(id))) {
  // Work in progress that never satisfies the DoD: left uncommitted, so the
  // worktree survives finalization for a continue: spawn.
  await Bun.write(cfg.cwd + "/scratch.txt", "half done by " + runId + "\\n");
} else if (!(control.fail ?? []).some((id) => cfg.cwd.includes(id))) {
  await Bun.write(cfg.cwd + "/feature.txt", "implemented by " + runId + "\\n");
  const run = (args) => Bun.spawnSync(["git", ...args], { cwd: cfg.cwd });
  run(["add", "-A"]);
  run(["-c", "user.email=a@a", "-c", "user.name=agent", "commit", "-q", "-m", "feat: " + runId]);
}
emit({ type: "message", role: "assistant", text: "done" });
emit({ type: "done", reason: "complete" });
process.exit(0);
`;

export interface GroupFixture {
	root: string;
	home: string;
	orchestrator: Orchestrator;
	svc: ProjectServices;
	/** Shut the daemon down (tmux sessions stay) and boot over the same state. */
	restart(): Promise<ProjectServices>;
	/** Shape what the driver does for the runs that start next. */
	control(c: {
		fail?: string[];
		/** Runs that leave uncommitted work and fail the DoD. */
		dirty?: string[];
		slowMs?: number;
	}): Promise<void>;
	/** A ready task whose DoD needs feature.txt. */
	task(title: string, over?: Record<string, unknown>): Promise<string>;
	/** One act tool call in the (single, long-lived) test turn. */
	act(tool: string, args: Record<string, unknown>): Promise<ActResult>;
	/** `spawn` for a task; throws unless it was accepted. */
	spawn(taskId: string, over?: Record<string, unknown>): Promise<ActResult>;
	/** Run supervisor passes until `cond` holds. */
	until(
		cond: () => Promise<boolean>,
		o?: { timeoutMs?: number; what?: string },
	): Promise<void>;
	cleanup(): Promise<void>;
}

export async function groupFixture(
	over: Partial<ProjectConfig> = {},
): Promise<GroupFixture> {
	const base = await mkdtemp(join(tmpdir(), "mfw-test-group-"));
	const root = join(base, "project");
	const home = join(base, "home");
	const driverDir = join(base, "driver");
	const controlPath = join(base, "control.json");
	await mkdir(join(root, ".mfw"), { recursive: true });
	await mkdir(driverDir, { recursive: true });
	await git(["init", "-q", "-b", "main"], root);
	await git(["config", "user.email", "group@test.invalid"], root);
	await git(["config", "user.name", "group test"], root);
	await writeFile(join(root, "README.md"), "# group\n");
	await writeFile(join(root, ".mfw", "AGENTS.md"), "group test\n");
	await git(["add", "-A"], root);
	await git(["commit", "-q", "-m", "init"], root);
	const driver = join(driverDir, "driver.ts");
	await writeFile(driver, driverSource(controlPath));
	await writeFile(controlPath, "{}");

	const config: ProjectConfig = {
		name: "grp",
		root,
		integrationBranch: "main",
		maxConcurrent: 4,
		assistance: {
			// Verified work merges through the queue without a person.
			changeReview: "off",
		},
		brain: STUB_BRAIN,
		...over,
	};

	let orchestrator!: Orchestrator;
	let svc!: ProjectServices;
	const start = async () => {
		orchestrator = await boot({
			projects: [config],
			mfwHome: home,
			autostart: false,
			log: silentLogger(),
		});
		svc = orchestrator.get(config.name);
		const adapters = (
			svc.engine as unknown as {
				deps: {
					adapters: {
						driverOverride: string | null;
						buildArgv: (() => string[]) | null;
					};
				};
			}
		).deps.adapters;
		adapters.driverOverride = driver;
		adapters.buildArgv = () => ["true"];
		return svc;
	};
	await start();

	const fx: GroupFixture = {
		root,
		home,
		get orchestrator() {
			return orchestrator;
		},
		get svc() {
			return svc;
		},
		async restart() {
			await orchestrator.shutdown();
			return start();
		},
		async control(c) {
			await writeFile(controlPath, JSON.stringify(c));
		},
		async task(title, extra = {}) {
			const t = await svc.tasks.create({
				title,
				dod: {
					verifier: "deterministic",
					checks: [{ files_exist: ["feature.txt"] }],
				},
				...extra,
			});
			await svc.tasks.move(t.id, "ready", "human");
			return t.id;
		},
		async act(tool, args) {
			const turnRunId = await openTurn(svc);
			return svc.brainRuntime.actions.act({
				turnRunId,
				tool,
				args: { rationale: "test", ...args },
			});
		},
		spawn: (taskId, extra) => brainSpawn(svc, taskId, extra),
		async until(cond, o = {}) {
			const deadline = Date.now() + (o.timeoutMs ?? 40_000);
			for (;;) {
				await svc.supervisor.pass();
				if (await cond()) return;
				if (Date.now() > deadline) {
					throw new Error(`timed out waiting for ${o.what ?? "condition"}`);
				}
				await Bun.sleep(150);
			}
		},
		async cleanup() {
			await orchestrator.shutdown().catch(() => {});
			const killer = Bun.spawn(
				["tmux", "-L", TEST_TMUX_SOCKET, "kill-server"],
				{ stdout: "ignore", stderr: "ignore" },
			);
			await killer.exited;
			await rm(base, { recursive: true, force: true });
		},
	};
	return fx;
}
