import { describe, expect, test } from "bun:test";
import { AdapterRegistry, PI_ACP_VERSION } from "../src/agents/adapter.ts";
import type { BrainTurnLaunch } from "../src/brain-runtime/turn-run.ts";

const registry = new AdapterRegistry();
const opts = { steer: true };

const brain: BrainTurnLaunch = {
	sessionId: "11111111-1111-5111-8111-111111111111",
	mcpConfigPath: "/runs/R1/mcp.json",
	mcp: { name: "mfw_brain", command: "bun", args: [], env: {} },
};

describe("ACP adapters", () => {
	const cases: [string, string, string[]][] = [
		["cursor-agent", "default", ["agent", "acp"]],
		["gemini-cli", "default", ["gemini", "--acp"]],
		["gemini-cli", "", ["gemini", "--acp"]],
		[
			"gemini-cli",
			"gemini-2.5-pro",
			["gemini", "--acp", "--model", "gemini-2.5-pro"],
		],
		["opencode", "default", ["opencode", "acp"]],
		["pi", "default", ["bunx", `pi-acp@${PI_ACP_VERSION}`]],
		["pi", "anthropic/claude-sonnet", ["bunx", "pi-acp@0.0.34"]],
	];
	for (const [id, model, argv] of cases) {
		test(`${id} (${model || "empty model"}) launches through the ACP bridge`, () => {
			const inv = registry.invocation(
				{ id, type: "acp", env: { FOO: "1" } },
				model,
				"hi",
				opts,
			);
			expect(inv.providerArgv).toEqual(argv);
			expect(inv.agentArgv).toEqual(argv);
			expect(inv.bridgeArgv.slice(0, 2)).toEqual(["bun", "run"]);
			expect(inv.bridgeArgv[2]?.endsWith("acp-bridge.ts")).toBe(true);
			expect(inv.driverScript.endsWith("app-server-driver.ts")).toBe(true);
			expect(inv.env).toEqual({ FOO: "1", MFW_ACP_AGENT: id });
			// ACP agents are never steerable, whatever the caller asked for.
			expect(inv.declaredCapabilities).toEqual({ steer: false });
		});
	}

	const lab = {
		id: "lab",
		baseUrl: "http://localhost:1/v1",
		envKey: "LAB_KEY",
	};

	test("brain turns run read-only with each agent's own flags", () => {
		const expected: Record<string, string[]> = {
			"cursor-agent": ["agent", "--mode", "plan", "--approve-mcps", "acp"],
			"gemini-cli": [
				"gemini",
				"--acp",
				"--model",
				"gemini-2.5-pro",
				"--approval-mode",
				"plan",
			],
			opencode: ["opencode", "acp"],
			pi: ["bunx", "pi-acp@0.0.34"],
		};
		for (const [id, argv] of Object.entries(expected)) {
			const inv = registry.invocation(
				{ id, type: "acp" },
				"gemini-2.5-pro",
				"",
				{ ...opts, brain },
			);
			expect(inv.providerArgv).toEqual(argv);
			expect(inv.env).toEqual({
				MFW_ACP_AGENT: id,
				MFW_ACP_POLICY: "read-only",
				MFW_ACP_MCP_CONFIG: "/runs/R1/mcp.json",
			});
			expect(inv.declaredCapabilities).toEqual({ steer: false });
		}
	});

	test("agent-minted session ids: the first turn never pins one, a later turn resumes the recorded one", () => {
		// Codex path: runtime.ts mints only for claude-cli, the supervisor records
		// the id from the `session` event and endTurn adopts it. The adapter side
		// of that contract: the first turn carries no resume id, the next does.
		const first = registry.invocation(
			{ id: "opencode", type: "acp" },
			"default",
			"",
			{ ...opts, brain: { mcpConfigPath: "/r/mcp.json", mcp: brain.mcp } },
		);
		expect(first.env).not.toHaveProperty("MFW_ACP_RESUME_SESSION");
		const next = registry.invocation(
			{ id: "opencode", type: "acp" },
			"default",
			"",
			{
				...opts,
				brain: {
					mcpConfigPath: "/r/mcp.json",
					mcp: brain.mcp,
					resumeSessionId: "ses_native1",
				},
			},
		);
		expect(next.env.MFW_ACP_RESUME_SESSION).toBe("ses_native1");
		expect(next.env.MFW_ACP_MCP_CONFIG).toBe("/r/mcp.json");
	});

	test("task runs carry no brain policy env", () => {
		const inv = registry.invocation(
			{ id: "opencode", type: "acp" },
			"default",
			"hi",
			opts,
		);
		expect(inv.env).toEqual({ MFW_ACP_AGENT: "opencode" });
	});

	test("endpoints reach the bridge as names and a URL, with the model", () => {
		for (const id of ["cursor-agent", "gemini-cli", "opencode", "pi"]) {
			const inv = registry.invocation(
				{ id, type: "acp", endpoint: lab },
				"qwen3-coder",
				"hi",
				opts,
			);
			expect(JSON.parse(inv.env.MFW_ACP_ENDPOINT as string)).toEqual(lab);
			expect(inv.env.MFW_ACP_MODEL).toBe("qwen3-coder");
		}
	});
});
