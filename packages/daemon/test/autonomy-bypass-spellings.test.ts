import { describe, expect, test } from "bun:test";
import {
	launchArgvProblem,
	withoutLaunchFlags,
} from "@mfw/plugin-api/harness-launch";
import { builtinHarnessRegistry } from "@mfw/plugin-api/harness-registry";
import { AdapterRegistry } from "../src/agents/adapter.ts";
import type { BrainTurnLaunch } from "../src/brain-runtime/turn-run.ts";
import { autonomyFlags } from "../src/containment/agent-profile.ts";
import {
	rewriteBrainArgv,
	sandboxMcpServer,
} from "../src/containment/brain-launch.ts";
import {
	BYPASS_CORPUS,
	NOT_BYPASS,
	WRAPPER_ARGV,
} from "./fixtures/autonomy-bypass-corpus.ts";

/** Security review F2: the denylist, which stays as defence in depth. */
describe("the bypass denylist", () => {
	for (const [family, rows] of Object.entries(BYPASS_CORPUS))
		for (const row of rows)
			test(`${family}: ${JSON.stringify(row)}`, () => {
				expect(autonomyFlags(["cli", ...row]).length).toBeGreaterThan(0);
			});

	for (const argv of WRAPPER_ARGV)
		test(`wrapper: ${JSON.stringify(argv)}`, () => {
			expect(autonomyFlags(argv).length).toBeGreaterThan(0);
		});

	for (const row of NOT_BYPASS)
		test(`still asks: ${JSON.stringify(row)}`, () => {
			expect(autonomyFlags(["cli", ...row])).toEqual([]);
		});
});

describe("the positive check accepts everything mfw really generates", () => {
	const session = "11111111-1111-4111-8111-111111111111";
	const server = {
		name: "mfw-brain",
		command: "/fixture/bun",
		args: ["run", "/fixture/mcp.ts"],
		env: { MFW_SOCKET: "/fixture/sock", MFW_BRAIN_SESSION: "s-1" },
	};
	const brain = {
		sessionId: session,
		mcpConfigPath: "/fixture/mcp.json",
		projectDirName: "fixture-project",
		mcp: server,
	} as unknown as BrainTurnLaunch;
	const resumed = {
		...brain,
		sessionId: undefined,
		resumeSessionId: session,
	} as unknown as BrainTurnLaunch;
	const endpoint = {
		id: "fixture",
		baseUrl: "https://endpoint.example/v1",
		envKey: "FIXTURE_KEY",
	};
	const cases = [
		["task", { steer: true, runId: "run-1" }],
		["background-free", { steer: false, disallowBackgroundAgents: true }],
		["brain", { steer: false, brain }],
		["resumed brain", { steer: false, brain: resumed }],
	] as const;

	for (const [id, type, cli] of [
		["claude-cli", "claude-cli", "claude"],
		["codex-cli", "codex-cli", "codex"],
	] as const)
		for (const [name, opts] of cases)
			for (const withEndpoint of id === "codex-cli" ? [false, true] : [false])
				test(`${id} ${name}${withEndpoint ? " on an endpoint" : ""}`, () => {
					const m = builtinHarnessRegistry().byFleetCli(cli);
					const generated = new AdapterRegistry().invocation(
						{ id, type, ...(withEndpoint ? { endpoint } : {}) },
						"opus-1",
						"prompt",
						opts,
					).providerArgv;
					const role = "brain" in opts ? "brain" : "task";
					const launched =
						role === "brain"
							? rewriteBrainArgv(generated, sandboxMcpServer(server))
							: generated;
					const kept = withoutLaunchFlags(m, launched);
					// What the bridges append before they spawn the CLI.
					const final =
						cli === "codex" && role === "brain"
							? [
									...kept,
									"-m",
									"opus-1",
									"-c",
									'model_reasoning_effort="high"',
									"-",
								]
							: kept;
					expect(autonomyFlags(final)).toEqual([]);
					expect(launchArgvProblem(m, final, role)).toBeNull();
				});

	test("an MCP server is a brain's alone", () => {
		const m = builtinHarnessRegistry().byFleetCli("codex");
		const argv = ["codex", "exec", "-c", 'mcp_servers.x.command="bun"'];
		expect(launchArgvProblem(m, argv, "brain")).toBeNull();
		expect(launchArgvProblem(m, argv, "task")).not.toBeNull();
	});
});
