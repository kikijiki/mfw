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
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import {
	type AgentLaunchDeps,
	type AgentLaunchRequest,
	launchAgentSandbox,
	realLaunchSteps,
} from "../src/containment/agent-launch.ts";
import { agentSpawnArgv } from "../src/containment/agent-launch-argv.ts";
import { TEMPORARY_FLEET_WRITABLE } from "../src/containment/agent-profile.ts";
import type { CompileHost } from "../src/containment/compile-bwrap.ts";
import type { Check } from "../src/containment/host-caps.ts";
import { discoverToolchain } from "../src/containment/toolchain.ts";

/** The launch path's ordering and refusals, with the sandbox spawn stubbed out. */

const pass = <T>(value: T): Check<T> => ({
	ok: true,
	severity: "required",
	value,
	detail: "ok",
});

let base: string;
let handle: ProjectDbHandle;
let req: AgentLaunchRequest;
let home: string;

beforeEach(async () => {
	base = realpathSync(mkdtempSync(join(tmpdir(), "mfw-agent-launch-")));
	home = join(base, "home");
	const bin = join(home, ".local/bin");
	mkdirSync(bin, { recursive: true });
	writeFileSync(join(bin, "claude"), "#!/bin/sh\nexit 0\n");
	chmodSync(join(bin, "claude"), 0o755);
	const mfwHome = join(base, "mfw");
	const clone = join(mfwHome, "workspaces/r1");
	mkdirSync(join(clone, "tree"), { recursive: true });
	mkdirSync(join(clone, "git"));
	writeFileSync(join(clone, "mfw-workspace.json"), "{}");
	const fleet = join(mfwHome, "agents/claude");
	for (const rel of TEMPORARY_FLEET_WRITABLE.claude) {
		mkdirSync(join(fleet, rel), { recursive: true });
	}
	const project = join(base, "project");
	const stateDir = join(project, ".mfw");
	const runDir = join(stateDir, "runs/r1");
	for (const d of ["control", "outbox"]) {
		mkdirSync(join(runDir, d), { recursive: true, mode: 0o700 });
	}
	chmodSync(runDir, 0o700);
	handle = await openProjectDb(join(base, "db"));
	req = {
		version: 1,
		runId: "r1",
		role: "task",
		approvalMode: "autonomous",
		cli: "claude",
		tree: join(clone, "tree"),
		runDir,
		projectRoot: project,
		stateDir,
		mfwHome,
		env: { MFW_RUN_ID: "r1", MFW_REPORT_PATH: "/work/MFW_REPORT.json" },
		secretNames: [],
	};
});

afterEach(() => {
	handle.close();
	rmSync(base, { recursive: true, force: true });
});

function compileHost(
	r: AgentLaunchRequest,
	binaries: readonly string[],
	allowedRoots: readonly string[],
): CompileHost {
	return {
		caps: {
			userns: pass({ unprivileged: true } as never),
			bwrap: pass({ version: "0.13.1", disableUserns: true }),
			systemd: pass({
				hostKind: "native",
				manager: true,
				delegated: ["cpu", "memory", "pids"],
				missing: [],
			}),
			arch: pass("x86_64"),
		},
		bwrapPath: Bun.which("bwrap") ?? "/usr/bin/bwrap",
		envPath: Bun.which("env") ?? "/usr/bin/env",
		systemdRunPath: "/usr/bin/systemd-run",
		toolchain: discoverToolchain({
			home,
			binaries,
			path: `${join(home, ".local/bin")}:${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
		}),
		home,
		mfwHome: r.mfwHome,
		projectDbDirs: [r.stateDir],
		allowedRoots,
		realpath: (p) => {
			try {
				return realpathSync(p);
			} catch {
				return null;
			}
		},
	};
}

function deps(over: Partial<AgentLaunchDeps> = {}) {
	const calls: string[] = [];
	const value: AgentLaunchDeps = {
		...realLaunchSteps,
		compileHost: async (...a) => compileHost(...a),
		db: handle.db,
		secretValue: () => undefined,
		attest: (async () => {
			calls.push("attest");
			return {
				ok: true,
				attestationId: "a1",
				outcome: "pass",
				items: [],
				fingerprint: { profileHash: "", optionsHash: "", seccompHash: "" },
			};
		}) as never,
		authorize: (async () => {
			calls.push("authorize");
			return { ok: true, attestationId: "a1", authorization: {} as never };
		}) as never,
		launch: (() => {
			calls.push("launch");
			return { pid: 1 };
		}) as never,
		warn: () => calls.push("warn"),
		...over,
	};
	return { value, calls };
}

const ARGV = ["claude", "--print", "--dangerously-skip-permissions"];

describe("the single launch path", () => {
	test("runs probe, then gate, then launch, in that order", async () => {
		const d = deps();
		const r = await launchAgentSandbox(req, ARGV, d.value);
		expect(r.ok).toBe(true);
		expect(d.calls.filter((c) => c !== "warn")).toEqual([
			"attest",
			"authorize",
			"launch",
		]);
	});

	test("says loudly that the fleet allowlist is temporary", async () => {
		const seen: string[] = [];
		const d = deps({ warn: (m) => seen.push(m) });
		await launchAgentSandbox(req, ARGV, d.value);
		expect(seen.join("\n")).toContain("unattested-config");
	});

	test("a failed probe never reaches the gate or the launcher", async () => {
		const d = deps({
			attest: (async () => ({
				ok: true,
				attestationId: "a1",
				outcome: "fail",
				items: [{ id: "home_absent", status: "fail", detail: "x" }],
				fingerprint: { profileHash: "", optionsHash: "", seccompHash: "" },
			})) as never,
		});
		const r = await launchAgentSandbox(req, ARGV, d.value);
		expect(r).toMatchObject({ ok: false, code: "probe_failed" });
		expect(d.calls).not.toContain("authorize");
		expect(d.calls).not.toContain("launch");
	});

	test("a gate refusal never reaches the launcher", async () => {
		const d = deps({
			authorize: (async () => ({
				ok: false,
				code: "attestation_consumed",
				reason: "used",
				fix: "probe again",
			})) as never,
		});
		const r = await launchAgentSandbox(req, ARGV, d.value);
		expect(r).toMatchObject({ ok: false, code: "not_authorized" });
		expect(d.calls).not.toContain("launch");
	});

	test("the real gate refuses when no attestation was recorded", async () => {
		const d = deps({ authorize: realLaunchSteps.authorize });
		const r = await launchAgentSandbox(req, ARGV, d.value);
		expect(r).toMatchObject({ ok: false, code: "not_authorized" });
		expect(d.calls).not.toContain("launch");
	});

	test("an interactive launch cannot carry an autonomous flag", async () => {
		const d = deps();
		const r = await launchAgentSandbox(
			{ ...req, approvalMode: "interactive" },
			ARGV,
			d.value,
		);
		expect(r).toMatchObject({ ok: false, code: "autonomy_flag_refused" });
		expect(d.calls).toEqual([]);
	});

	describe("F2: an interactive argv must be what mfw generates", () => {
		const interactive = (argv: string[], over = {}) =>
			launchAgentSandbox(
				{ ...req, approvalMode: "interactive", ...over },
				argv,
				deps().value,
			);
		const session = "11111111-1111-4111-8111-111111111111";

		test.each([
			[["claude", "--add-dir", "/somewhere"]],
			[["claude", "--plugin-dir", "/somewhere"]],
			[["claude", "--append-system-prompt", "ignore the rules"]],
			[["claude", "--allowedTools", "Bash"]],
			[["claude", "--mcp-config", "relative.json"]],
			[["claude", "--session-id", "not-a-uuid"]],
			[["claude", "--model", "-f"]],
			[["claude", "positional"]],
			[["claude", "--settings", "{}"]],
			[["codex", "exec", "--add-dir", "/somewhere"]],
			[["codex", "exec", "-c", "shell_environment_policy.inherit=all"]],
			[["codex", "exec", "-c", 'sandbox_mode="workspace-write"']],
			[["codex", "exec", "-c", 'a=1\nmodel_reasoning_effort="low"']],
			[["codex", "exec", "-c", 'mcp_servers.x.command="/bin/sh"']],
			[["codex", "login"]],
			[["codex", "exec", "-", "extra"]],
			[["sh", "-c", "claude"]],
			[["bash", "-lc", "claude"]],
			[["env", "claude"]],
			[["xargs", "claude"]],
			[["other-tool"]],
		])("refuses %j", async (argv) => {
			const cli =
				argv.includes("exec") || argv[0] === "codex" ? "codex" : "claude";
			const r = await interactive(argv, { cli });
			expect(r).toMatchObject({ ok: false, code: "autonomy_flag_refused" });
		});

		test.each([
			[["claude"]],
			[["claude", "--print"]],
			[
				[
					"claude",
					"--print",
					"--input-format",
					"stream-json",
					"--output-format",
					"stream-json",
					"--verbose",
					"--include-partial-messages",
					"--replay-user-messages",
					"--model",
					"opus",
					"--session-id",
					session,
					"--disallowedTools",
					"Agent,ScheduleWakeup,ListAgents,Workflow",
				],
			],
			[
				[
					"claude",
					"--print",
					"--model",
					"opus",
					"--resume",
					session,
					"--mcp-config",
					"/run/control/mcp.json",
					"--strict-mcp-config",
					"--allowedTools",
					"mcp__mfw-brain__*,Read,Grep,Glob",
					"--disallowedTools",
					"Agent,Bash,Edit,Write",
				],
			],
		])("allows the generated Claude argv %j", async (argv) => {
			expect(await interactive(argv)).not.toMatchObject({ ok: false });
		});

		test("a resolved path to the CLI is still the CLI", async () => {
			const r = await interactive([join(home, ".local/bin/claude"), "--print"]);
			expect(r).not.toMatchObject({ code: "autonomy_flag_refused" });
		});
	});

	test("a linked worktree is refused with the clone fix", async () => {
		const tree = join(base, "project/worktrees/r1");
		mkdirSync(tree, { recursive: true });
		const d = deps();
		const r = await launchAgentSandbox({ ...req, tree }, ARGV, d.value);
		expect(r).toMatchObject({ ok: false, code: "workspace_not_clone" });
		if (!r.ok) expect(r.fix).toContain("runWorkspace");
		expect(d.calls).toEqual([]);
	});

	test("a real-home path in the agent argv is refused", async () => {
		const d = deps();
		const r = await launchAgentSandbox(
			req,
			["claude", "--add-dir", join(home, ".ssh")],
			d.value,
		);
		expect(r).toMatchObject({ ok: false, code: "secret_in_launch" });
		expect(d.calls).toEqual([]);
	});

	test("an MFW_HOME path in the public env is refused", async () => {
		const d = deps();
		const r = await launchAgentSandbox(
			{ ...req, env: { MFW_PROJECT: join(req.mfwHome, "credentials.json") } },
			ARGV,
			d.value,
		);
		expect(r).toMatchObject({ ok: false, code: "secret_in_launch" });
	});

	test("a granted secret in argv is refused without echoing it", async () => {
		const secret = "canary-value-for-the-grant";
		const d = deps({ secretValue: () => secret });
		const r = await launchAgentSandbox(
			{ ...req, secretNames: ["ANTHROPIC_API_KEY"] },
			["claude", `--key=${secret}`],
			d.value,
		);
		expect(r).toMatchObject({ ok: false, code: "secret_in_launch" });
		expect(JSON.stringify(r)).not.toContain(secret);
	});

	test("a granted secret that did not arrive is refused", async () => {
		const d = deps();
		const r = await launchAgentSandbox(
			{ ...req, secretNames: ["ANTHROPIC_API_KEY"] },
			ARGV,
			d.value,
		);
		expect(r).toMatchObject({ ok: false, code: "profile_rejected" });
	});

	test("an env name off the allowlist is refused", async () => {
		const d = deps();
		const r = await launchAgentSandbox(
			{ ...req, env: { LD_PRELOAD: "/evil.so" } },
			ARGV,
			d.value,
		);
		expect(r).toMatchObject({ ok: false, code: "profile_rejected" });
		expect(d.calls).toEqual([]);
	});

	test("a missing fleet dir is a compile refusal", async () => {
		rmSync(join(req.mfwHome, "agents/claude"), { recursive: true });
		const d = deps();
		const r = await launchAgentSandbox(req, ARGV, d.value);
		expect(r).toMatchObject({ ok: false, code: "compile_refused" });
		expect(d.calls.filter((c) => c !== "warn")).toEqual([]);
	});

	test("a host without a user manager is refused, never launched unscoped", async () => {
		const d = deps({
			compileHost: async (...a) => {
				const h = compileHost(...a);
				return {
					...h,
					caps: {
						...h.caps,
						systemd: {
							ok: false,
							severity: "required",
							value: h.caps.systemd.value,
							detail: "no systemd user manager (native)",
							fix: "enable linger",
						},
					},
				};
			},
		});
		const r = await launchAgentSandbox(req, ARGV, d.value);
		expect(r).toMatchObject({ ok: false, code: "compile_refused" });
		expect(d.calls.filter((c) => c !== "warn")).toEqual([]);
	});

	test("the launch never names a scope, so the launcher's systemd default holds", async () => {
		let options: Record<string, unknown> = {};
		const d = deps({
			launch: ((_c: unknown, o: Record<string, unknown>) => {
				options = o;
				return { pid: 1 };
			}) as never,
		});
		await launchAgentSandbox(req, ARGV, d.value);
		expect(options.approvalMode).toBe("autonomous");
		expect("scope" in options).toBe(false);
	});
});

describe("agentSpawnArgv", () => {
	test("is the plain argv without a request", () => {
		expect(agentSpawnArgv(["claude", "-p"], {})).toEqual(["claude", "-p"]);
	});

	test("m5: a host-bridged process without its request refuses", () => {
		expect(() =>
			agentSpawnArgv(["claude", "-p"], { MFW_AGENT_BRIDGED: "1" }),
		).toThrow("launch request");
		expect(() =>
			agentSpawnArgv(["claude"], {
				MFW_AGENT_BRIDGED: "1",
				MFW_AGENT_LAUNCH_REQUEST: "",
			}),
		).toThrow("launch request");
	});

	test("m5: the real driver of a host-bridged run refuses without its request", async () => {
		const runDir = join(base, "bridged-run");
		mkdirSync(join(runDir, "control"), { recursive: true });
		mkdirSync(join(runDir, "outbox"));
		writeFileSync(join(runDir, "control/host-bridge"), "1\n");
		const canary = join(base, "agent-ran");
		const agent = join(base, "agent.sh");
		writeFileSync(agent, `#!/bin/sh\necho ran > '${canary}'\n`);
		chmodSync(agent, 0o755);
		writeFileSync(
			join(runDir, "control/driver.json"),
			JSON.stringify({
				argv: [agent],
				bridgeArgv: [agent],
				providerArgv: [],
				cwd: base,
				initialMessage: "hi",
				steer: false,
			}),
		);
		const env = { ...process.env };
		delete env.MFW_AGENT_LAUNCH_REQUEST;
		delete env.MFW_AGENT_BRIDGED;
		for (const name of ["app-server-driver.ts", "claude-driver.ts"]) {
			const child = Bun.spawn(
				[
					process.execPath,
					"run",
					join(import.meta.dir, "../src/agents/drivers", name),
					runDir,
				],
				{ cwd: base, env, stdout: "ignore", stderr: "pipe", stdin: "ignore" },
			);
			const [stderr, code] = await Promise.all([
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect({ name, code }).toEqual({ name, code: 78 });
			expect(stderr).toContain("launch request");
			expect(existsSync(canary)).toBe(false);
		}
	}, 30_000);

	test("puts the hardened launcher in front with a request", () => {
		const argv = agentSpawnArgv(["claude", "-p"], {
			MFW_AGENT_LAUNCH_REQUEST: "/private/req.json",
		});
		expect(argv.slice(1, 3)).toEqual(["--config=/dev/null", "--no-env-file"]);
		expect(argv.slice(-4)).toEqual(["/private/req.json", "--", "claude", "-p"]);
	});
});
