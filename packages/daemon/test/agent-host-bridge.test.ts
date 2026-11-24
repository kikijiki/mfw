import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AgentHost,
	type AgentTmuxRunner,
	type LaunchSpec,
} from "../src/agent-host.ts";
import { HOST_BRIDGE_MARKER } from "../src/containment/run-dir.ts";
import { SecretEnvironment } from "../src/execution-environment.ts";
import { wipLaunchRequestPath } from "../src/run-workspace/wip-snapshot.ts";
import { controlRootPath, SandboxUnavailableError } from "../src/sandbox.ts";

/** What the agent host generates for a task or repair run. Nothing is started. */

let base: string;
let runId: string;
let calls: string[][];

const ok = {
	exitCode: 0,
	stdout: "",
	stderr: "",
	timedOut: false,
	truncated: false,
	signalCode: null,
};
const runner: AgentTmuxRunner = async (args) => {
	calls.push(args);
	return ok as never;
};

beforeEach(() => {
	base = realpathSync(mkdtempSync(join(tmpdir(), "mfw-host-bridge-")));
	runId = `bridge-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
	calls = [];
	mkdirSync(join(base, "project/.mfw/runs", runId), { recursive: true });
	writeFileSync(join(base, "project/.mfw/mfw.db"), "");
	mkdirSync(join(base, "mfw/workspaces", runId, "tree"), { recursive: true });
});

afterEach(() => {
	for (const name of [
		`run-${runId}.sh`,
		`agent-launch-${runId}.json`,
		`exit-${runId}`,
	]) {
		rmSync(join(controlRootPath(), name), { force: true });
	}
	rmSync(base, { recursive: true, force: true });
});

const spec = (over: Partial<LaunchSpec> = {}): LaunchSpec => ({
	runId,
	runDir: join(base, "project/.mfw/runs", runId),
	cwd: join(base, "mfw/workspaces", runId, "tree"),
	projectRoot: join(base, "project"),
	driverScript: "/opt/mfw/driver.ts",
	agentArgv: ["claude", "--print", "--dangerously-skip-permissions"],
	bridgeArgv: ["bun", "run", "/opt/mfw/bridge.ts"],
	providerArgv: ["claude", "--print", "--dangerously-skip-permissions"],
	env: { MFW_RUN_ID: runId, MFW_REPORT_PATH: "/host/tree/MFW_REPORT.json" },
	steer: true,
	approvalMode: "autonomous",
	isolation: {
		mode: "bwrap",
		hidePaths: [join(base, "mfw")],
		mfwHome: join(base, "mfw"),
	},
	runKind: "task",
	providerId: "claude-cli",
	...over,
});

const script = () =>
	readFileSync(join(controlRootPath(), `run-${runId}.sh`), "utf8");
const request = () =>
	JSON.parse(
		readFileSync(join(controlRootPath(), `agent-launch-${runId}.json`), "utf8"),
	);
const driver = (s: LaunchSpec) =>
	JSON.parse(readFileSync(join(s.runDir, "control/driver.json"), "utf8"));

describe("a host-bridged launch", () => {
	test.each([
		"task",
		"repair",
	])("%s runs its driver on the host", async (kind) => {
		const s = spec({ runKind: kind });
		await new AgentHost(undefined, { tmuxRunner: runner }).launch(s);
		const text = script();
		expect(text).not.toContain("bwrap");
		expect(text).not.toContain("direnv");
		expect(text).not.toContain(".envrc");
		expect(text).toContain("--config=/dev/null");
		expect(text).toContain("--no-env-file");
		expect(text).toContain("MFW_AGENT_LAUNCH_REQUEST");
		expect(existsSync(join(s.runDir, "control", HOST_BRIDGE_MARKER))).toBe(
			true,
		);
		expect(request().role).toBe(kind);
	});

	test("never runs from the workspace, and sends no output to the pane", async () => {
		const s = spec();
		await new AgentHost(undefined, { tmuxRunner: runner }).launch(s);
		expect(script()).toContain(`cd '${s.runDir}'`);
		expect(script()).not.toContain(`cd '${s.cwd}'`);
		expect(script()).toContain(`>> '${join(s.runDir, "raw.log")}' 2>&1`);
		expect(calls.some((c) => c[0] === "pipe-pane")).toBe(false);
		const started = calls.find((c) => c[0] === "new-session") as string[];
		expect(started[started.indexOf("-c") + 1]).toBe(s.runDir);
	});

	test("the agent sees sandbox paths only", async () => {
		const s = spec();
		await new AgentHost(undefined, { tmuxRunner: runner }).launch(s);
		const d = driver(s);
		expect(d.cwd).toBe("/work");
		expect(d.env.MFW_REPORT_PATH).toBe("/work/MFW_REPORT.json");
		expect(d.bridgeArgv).toContain("--config=/dev/null");
		expect(request().env.MFW_REPORT_PATH).toBe("/work/MFW_REPORT.json");
	});

	test("an interactive run carries no autonomous flag", async () => {
		const s = spec({ approvalMode: "interactive" });
		await new AgentHost(undefined, { tmuxRunner: runner }).launch(s);
		const d = driver(s);
		expect(JSON.stringify([d.argv, d.providerArgv])).not.toContain(
			"dangerously",
		);
		expect(request().approvalMode).toBe("interactive");
	});

	test.each([
		"-f",
		"-y",
		"--force",
		"--yolo",
	])("F1: an interactive run with the model %s is refused, never rewritten", async (model) => {
		const argv = [
			"claude",
			"--print",
			"--dangerously-skip-permissions",
			"--model",
			model,
			"--disallowedTools",
			"Agent,Bash",
		];
		await expect(
			new AgentHost(undefined, { tmuxRunner: runner }).launch(
				spec({
					approvalMode: "interactive",
					agentArgv: argv,
					providerArgv: argv,
				}),
			),
		).rejects.toThrow("refusing");
		expect(calls).toEqual([]);
	});

	test("F1: an interactive run keeps every option after the model", async () => {
		const argv = [
			"claude",
			"--print",
			"--dangerously-skip-permissions",
			"--model",
			"opus",
			"--mcp-config",
			"/fixture/mcp.json",
			"--disallowedTools",
			"Agent,Bash",
		];
		const s = spec({
			approvalMode: "interactive",
			agentArgv: argv,
			providerArgv: argv,
		});
		await new AgentHost(undefined, { tmuxRunner: runner }).launch(s);
		expect(driver(s).providerArgv).toEqual(
			argv.filter((a) => a !== "--dangerously-skip-permissions"),
		);
	});

	test("a secret's value is in neither the request nor the driver config", async () => {
		const canary = "bridge-unit-secret-canary";
		const s = spec({
			secretEnvironment: new SecretEnvironment({ ANTHROPIC_API_KEY: canary }),
		});
		// The FIFO reader never starts here, so the handoff itself fails.
		await new AgentHost(undefined, {
			tmuxRunner: runner,
			secretHandoffTimeoutMs: 20,
		})
			.launch(s)
			.catch(() => {});
		expect(request().secretNames).toEqual(["ANTHROPIC_API_KEY"]);
		expect(JSON.stringify(request())).not.toContain(canary);
		expect(JSON.stringify(driver(s))).not.toContain(canary);
		expect(script()).not.toContain(canary);
	});

	test("the end-of-run snapshot request is stored host-only, with no secret or agent env", async () => {
		const canary = "bridge-snapshot-secret-canary";
		const s = spec({
			secretEnvironment: new SecretEnvironment({ ANTHROPIC_API_KEY: canary }),
		});
		await new AgentHost(undefined, {
			tmuxRunner: runner,
			secretHandoffTimeoutMs: 20,
		})
			.launch(s)
			.catch(() => {});
		const path = wipLaunchRequestPath(realpathSync(s.runDir));
		expect(statSync(path).mode & 0o077).toBe(0);
		const text = readFileSync(path, "utf8");
		expect(text).not.toContain(canary);
		expect(JSON.parse(text)).toMatchObject({
			purpose: "wip-snapshot",
			env: {},
			secretNames: [],
		});
	});

	test("the launcher's env name is reserved", async () => {
		await expect(
			new AgentHost(undefined, { tmuxRunner: runner }).launch(
				spec({ env: { MFW_AGENT_LAUNCH_REQUEST: "/tmp/forged.json" } }),
			),
		).rejects.toThrow("reserved");
	});

	// Security review REL-1 M1: a provider env with a loader name would have
	// run code in the host's driver, bridge and launcher.
	test.each([
		"BUN_OPTIONS",
		"BUN_BE_BUN",
		"NODE_OPTIONS",
		"LD_PRELOAD",
		"GLIBC_TUNABLES",
	])("a launch whose env sets %s is refused", async (name) => {
		await expect(
			new AgentHost(undefined, { tmuxRunner: runner }).launch(
				spec({ env: { [name]: "--preload /tmp/evil.ts" } }),
			),
		).rejects.toThrow(`launch environment sets ${name}`);
		await expect(
			new AgentHost(undefined, { tmuxRunner: runner }).launch(
				spec({ secretEnvironment: new SecretEnvironment({ [name]: "x" }) }),
			),
		).rejects.toThrow(`launch environment sets ${name}`);
		expect(calls.filter((c) => c[0] === "new-session")).toEqual([]);
	});

	test("run.sh starts the driver under env -i with only the allowlist and the declared names", async () => {
		const s = spec({
			secretEnvironment: new SecretEnvironment({ ANTHROPIC_API_KEY: "k" }),
		});
		await new AgentHost(undefined, {
			tmuxRunner: runner,
			secretHandoffTimeoutMs: 20,
		})
			.launch(s)
			.catch(() => {});
		const text = script();
		const driverLine = text
			.split("\n")
			.find((l) => l.includes("/opt/mfw/driver.ts")) as string;
		expect(driverLine).toMatch(/^'[^']*\/env' -i "\$\{mfw_env\[@\]\}" /);
		expect(text).toContain(
			"export MFW_HOST_ENV_NAMES=MFW_RUN_ID,MFW_REPORT_PATH,ANTHROPIC_API_KEY",
		);
		expect(text).toContain("unset BUN_OPTIONS BUN_BE_BUN");
		expect(text).toContain("BUN_*|NODE_*|LD_*|DYLD_*");
	});

	test.each([
		["a provider with no profile", { providerId: "gemini-cli" }],
		["no provider", { providerId: undefined }],
	])("%s is refused, not downgraded", async (_name, over) => {
		await expect(
			new AgentHost(undefined, { tmuxRunner: runner }).launch(spec(over)),
		).rejects.toBeInstanceOf(SandboxUnavailableError);
		expect(calls).toEqual([]);
	});

	test("a missing daemon home is refused, not downgraded", async () => {
		await expect(
			new AgentHost(undefined, { tmuxRunner: runner }).launch(
				spec({ isolation: { mode: "bwrap", hidePaths: [] } }),
			),
		).rejects.toBeInstanceOf(SandboxUnavailableError);
		expect(calls).toEqual([]);
	});

	test.each([
		"project",
		"workspace",
	])("an .envrc in the %s is refused and never evaluated", async (where) => {
		const s = spec();
		writeFileSync(
			join(where === "project" ? s.projectRoot : s.cwd, ".envrc"),
			`touch ${join(base, "evaluated")}\n`,
		);
		await expect(
			new AgentHost(undefined, { tmuxRunner: runner }).launch(s),
		).rejects.toThrow(".envrc");
		expect(calls).toEqual([]);
		expect(existsSync(join(base, "evaluated"))).toBe(false);
	});
});
