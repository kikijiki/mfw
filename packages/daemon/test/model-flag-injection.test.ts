import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseTaskFile } from "@mfw/core/taskfile";
import { renderHarnessArgv } from "@mfw/plugin-api/harness";
import { builtinHarnessRegistry } from "@mfw/plugin-api/harness-registry";
import { AdapterRegistry, claudeBrainArgv } from "../src/agents/adapter.ts";
import type { BrainTurnLaunch } from "../src/brain-runtime/turn-run.ts";
import { brainSchema, routingSchema } from "../src/config.ts";

/** Security review F1: a model that reads as a flag must never reach an argv. */
const FLAG_MODELS = ["-f", "-y", "--force", "--yolo", " -f", "-"];

const brain = {
	sessionId: "11111111-1111-4111-8111-111111111111",
	mcpConfigPath: "/fixture/mcp.json",
	projectDirName: "fixture-project",
	mcp: {
		name: "mfw-brain",
		command: "/fixture/bun",
		args: ["run", "/fixture/mcp.ts"],
		env: { MFW_FIXTURE: "1" },
	},
} as unknown as BrainTurnLaunch;

const claude = { id: "claude-cli", type: "claude-cli" } as const;
const codex = { id: "codex-cli", type: "codex-cli" } as const;
const gemini = { id: "gemini-cli", type: "acp" } as const;

const task = (model: string) =>
	`---\nid: MFW-1\nrev: 1\ntitle: a task\ntype: implementation\npriority: medium\nmodel: ${JSON.stringify(model)}\n---\n\nBody\n`;

describe("a flag-like model is refused", () => {
	for (const model of FLAG_MODELS) {
		const shown = JSON.stringify(model);

		test(`${shown}: the Claude task adapter`, () => {
			expect(() =>
				new AdapterRegistry().invocation(claude, model, "p", {
					steer: true,
					runId: "run-1",
					disallowBackgroundAgents: true,
				}),
			).toThrow("cannot start with");
		});

		test(`${shown}: the Claude brain argv`, () => {
			expect(() => claudeBrainArgv(model, brain)).toThrow("cannot start with");
		});

		test(`${shown}: the Codex and ACP adapters`, () => {
			for (const cfg of [codex, gemini])
				expect(() =>
					new AdapterRegistry().invocation(cfg, model, "p", { steer: false }),
				).toThrow("cannot start with");
		});

		test(`${shown}: argv rendering`, () => {
			const m = builtinHarnessRegistry().require("claude-cli");
			expect(() => renderHarnessArgv(m.modes.task, m, { model })).toThrow(
				"cannot start with",
			);
		});

		test(`${shown}: task frontmatter`, () => {
			const parsed = parseTaskFile(task(model));
			expect(parsed.ok).toBe(false);
		});

		test(`${shown}: routing and brain config`, () => {
			expect(
				routingSchema.safeParse({
					fallbacks: { default: [{ provider: "codex-cli", model }] },
				}).success,
			).toBe(false);
			expect(brainSchema.safeParse({ model }).success).toBe(false);
		});
	}

	test("an ordinary model still works everywhere", () => {
		expect(parseTaskFile(task("claude-opus-5")).ok).toBe(true);
		const argv = new AdapterRegistry().invocation(claude, "opus", "p", {
			steer: true,
		}).providerArgv;
		expect(
			argv.slice(argv.indexOf("--model"), argv.indexOf("--model") + 2),
		).toEqual(["--model", "opus"]);
	});

	test("the brain argv keeps its tool denylist and MCP config", () => {
		const argv = claudeBrainArgv("opus", brain);
		const at = argv.indexOf("--model");
		expect(argv[at + 1]).toBe("opus");
		expect(argv[argv.indexOf("--mcp-config") + 1]).toBe("/fixture/mcp.json");
		expect(argv[argv.indexOf("--disallowedTools") + 1]).toContain("Bash");
	});

	test.each([
		"packages/api/src/router/groups.ts",
		"packages/api/src/router/runs.ts",
		"packages/api/src/router/settings.ts",
		"packages/api/src/router/system.ts",
		"packages/daemon/src/config.ts",
	])("%s has no unchecked model input", (file) => {
		const source = readFileSync(
			join(import.meta.dir, "../../..", file),
			"utf8",
		);
		const unchecked = source
			.split("\n")
			.filter((l) =>
				/\b(model|reviewModel|light|standard|strong):\s*z\.string\(\)/.test(l),
			)
			.concat(
				source
					.split("\n")
					.filter((l) => /fallbackModels:\s*z\.array\(z\.string\(\)/.test(l)),
			);
		expect(unchecked).toEqual([]);
	});
});
