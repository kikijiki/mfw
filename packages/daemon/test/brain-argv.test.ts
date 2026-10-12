import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AdapterRegistry,
	claudeAdapter,
	codexAdapter,
} from "../src/agents/adapter.ts";
import { parseAgentEvents } from "../src/agents/events.ts";
import type { BrainTurnLaunch } from "../src/brain-runtime/turn-run.ts";

const mcp = {
	name: "mfw_brain",
	command: "bun",
	args: ["run", "/x/mcp/main.ts", "--brain", "S1"],
	env: { MFW_URL: "http://localhost:7777/mfw/api/trpc", MFW_BRAIN_TURN: "R1" },
};
const first: BrainTurnLaunch = {
	sessionId: "11111111-1111-5111-8111-111111111111",
	mcpConfigPath: "/runs/R1/mcp.json",
	mcp,
};
const later: BrainTurnLaunch = {
	resumeSessionId: "11111111-1111-5111-8111-111111111111",
	mcpConfigPath: "/runs/R2/mcp.json",
	mcp,
};

const DRIVER = join(
	import.meta.dir,
	"../src/agents/drivers/app-server-driver.ts",
);
const EXEC_BRIDGE = join(
	import.meta.dir,
	"../src/agents/bridges/codex-exec-bridge.ts",
);
const FAKE_CODEX = join(import.meta.dir, "fixtures/fake-codex-exec.ts");
const cfg = (type: "claude-cli" | "codex-cli") => ({
	id: type,
	type,
});

describe("brain turn argv", () => {
	test("Claude: --session-id first, --resume after, and the per-wake flags on both", () => {
		const a = claudeAdapter.invocation(cfg("claude-cli"), "opus", "", {
			steer: false,
			brain: first,
		}).providerArgv;
		const b = claudeAdapter.invocation(cfg("claude-cli"), "opus", "", {
			steer: false,
			brain: later,
		}).providerArgv;
		expect(a).toContain("--session-id");
		expect(a).not.toContain("--resume");
		expect(b).toContain("--resume");
		expect(b).not.toContain("--session-id");
		for (const argv of [a, b]) {
			expect(argv[argv.indexOf("--mcp-config") + 1]).toMatch(/mcp\.json$/);
			expect(argv).toContain("--strict-mcp-config");
			expect(argv[argv.indexOf("--allowedTools") + 1]).toBe(
				"mcp__mfw_brain__*,Read,Grep,Glob",
			);
			expect(argv[argv.indexOf("--disallowedTools") + 1]).toContain("Bash");
			expect(argv).not.toContain("--dangerously-skip-permissions");
		}
	});

	test("Codex: exec first, exec resume <thread> after, read-only with the MCP server registered", () => {
		const a = codexAdapter.invocation(cfg("codex-cli"), "gpt-5", "", {
			steer: false,
			brain: { ...first, sessionId: undefined },
		}).providerArgv;
		const b = codexAdapter.invocation(cfg("codex-cli"), "gpt-5", "", {
			steer: false,
			brain: { ...later, resumeSessionId: "thread-9" },
		}).providerArgv;
		expect(a.slice(0, 2)).toEqual(["codex", "exec"]);
		expect(a).not.toContain("resume");
		expect(b.slice(0, 4)).toEqual(["codex", "exec", "resume", "thread-9"]);
		for (const argv of [a, b]) {
			expect(argv).toContain("--json");
			expect(argv).toContain('sandbox_mode="read-only"');
			expect(argv).toContain('mcp_servers.mfw_brain.command="bun"');
			expect(
				argv.some((x) => x.startsWith("mcp_servers.mfw_brain.args=")),
			).toBe(true);
			expect(argv.some((x) => x.includes("MFW_BRAIN_TURN"))).toBe(true);
		}
	});

	test("a provider-command seam swaps the CLI and keeps every real flag", () => {
		const reg = new AdapterRegistry();
		reg.providerCommand = ["bun", "run", "/fake.ts"];
		const inv = reg.invocation(cfg("claude-cli"), "opus", "", {
			steer: false,
			brain: later,
		});
		expect(inv.providerArgv.slice(0, 3)).toEqual(["bun", "run", "/fake.ts"]);
		expect(inv.providerArgv).toContain("--resume");
	});

	test("the codex exec bridge reads the prompt from stdin, resumes the thread and reports the thread id and usage", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mfw-test-codex-exec-"));
		try {
			const log = join(dir, "codex.log");
			for (const resume of [undefined, "thread-77"]) {
				const providerArgv = [
					"bun",
					"run",
					FAKE_CODEX,
					"exec",
					...(resume ? ["resume", resume] : []),
					"--json",
				];
				await writeFile(
					join(dir, "driver.json"),
					JSON.stringify({
						bridgeArgv: ["bun", "run", EXEC_BRIDGE],
						providerArgv,
						cwd: dir,
						env: { FAKE_CODEX_LOG: log },
						initialMessage: "wake digest text",
						reasoningEffort: "high",
						model: "gpt-5",
						steer: false,
						approvalMode: "autonomous",
					}),
				);
				await writeFile(join(dir, "events.jsonl"), "");
				await writeFile(join(dir, "control.jsonl"), "");
				const proc = Bun.spawn(["bun", "run", DRIVER, dir], {
					stdout: "ignore",
					stderr: "pipe",
				});
				const code = await proc.exited;
				expect(code, await new Response(proc.stderr).text()).toBe(0);
				const evs = parseAgentEvents(
					await readFile(join(dir, "events.jsonl"), "utf8"),
				);
				const sessions = evs.filter((e) => e.type === "session");
				// The last session event carries the real thread id.
				expect(
					(sessions.at(-1) as { sessionId?: string } | undefined)?.sessionId,
				).toBe(resume ?? "thread-fresh-1");
				const usage = evs.find((e) => e.type === "usage") as
					| { inputTokens?: number; cachedInputTokens?: number }
					| undefined;
				expect(usage).toMatchObject({
					inputTokens: 700,
					cachedInputTokens: 200,
				});
				expect(evs.some((e) => e.type === "done")).toBe(true);
			}
			const seen = (await readFile(log, "utf8"))
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l) as { argv: string[]; prompt: string });
			expect(seen[0]?.prompt).toBe("wake digest text");
			expect(seen[0]?.argv).toContain("-");
			expect(seen[0]?.argv).toContain("-m");
			expect(seen[1]?.argv.slice(0, 3)).toEqual([
				"exec",
				"resume",
				"thread-77",
			]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);
});
