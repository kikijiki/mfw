import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAgentEvents } from "../src/agents/events.ts";

/** U7-01: subagent entries carry `parent`; a run without subagents is unchanged. */

const DRIVER = join(
	import.meta.dir,
	"../src/agents/drivers/app-server-driver.ts",
);
const CODEX_BRIDGE = join(
	import.meta.dir,
	"../src/agents/bridges/codex-app-server-bridge.ts",
);
const CODEX_PROVIDER = join(
	import.meta.dir,
	"fixtures/fake-codex-app-server.ts",
);
const CLAUDE_BRIDGE = join(
	import.meta.dir,
	"../src/agents/bridges/claude-app-server.ts",
);
const CLAUDE_PROVIDER = join(
	import.meta.dir,
	"fixtures/fake-claude-app-server.ts",
);
const CLAUDE_DRIVER = join(
	import.meta.dir,
	"../src/agents/drivers/claude-driver.ts",
);
const FAKE_CLAUDE = join(import.meta.dir, "fixtures/fake-claude.ts");

async function runBridge(
	bridge: string,
	provider: string,
	initialMessage: string,
) {
	const dir = await mkdtemp(join(tmpdir(), "mfw-subagent-"));
	try {
		await writeFile(
			join(dir, "driver.json"),
			JSON.stringify({
				bridgeArgv: ["bun", "run", bridge],
				providerArgv: ["bun", "run", provider],
				cwd: dir,
				env: {},
				initialMessage,
				reasoningEffort: "high",
				steer: true,
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
		const stderr = await new Response(proc.stderr).text();
		expect(code, stderr).toBe(0);
		expect(stderr).not.toContain("invalid event");
		return parseAgentEvents(await readFile(join(dir, "events.jsonl"), "utf8"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function runLegacyDriver(initialMessage: string) {
	const dir = await mkdtemp(join(tmpdir(), "mfw-subagent-"));
	try {
		await writeFile(
			join(dir, "driver.json"),
			JSON.stringify({
				argv: ["bun", "run", FAKE_CLAUDE],
				cwd: dir,
				env: {},
				initialMessage,
				steer: false,
			}),
		);
		await writeFile(join(dir, "steer.jsonl"), "");
		const proc = Bun.spawn(["bun", "run", CLAUDE_DRIVER, dir], {
			stdout: "ignore",
			stderr: "ignore",
		});
		await proc.exited;
		return parseAgentEvents(await readFile(join(dir, "events.jsonl"), "utf8"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

describe("subagent traffic carries a parent (U7-01)", () => {
	test("Claude bridge: the subagent's entries name the Agent call, the run's own do not", async () => {
		const events = await runBridge(CLAUDE_BRIDGE, CLAUDE_PROVIDER, "SUBAGENT");
		const call = events.find(
			(e) => e.type === "tool_call" && e.name === "Agent",
		);
		expect(call).toBeDefined();
		expect(call?.parent).toBeUndefined();
		const children = events.filter((e) => e.parent?.toolUseId === "ag1");
		expect(children.map((e) => e.type)).toEqual([
			"message", // the subagent's prompt
			"tool_call",
			"tool_result",
			"message",
		]);
		expect(children[0]).toMatchObject({ role: "user", text: "look around" });
		expect(children[1]).toMatchObject({ name: "Read", id: "s1" });
		const agentResult = events.find(
			(e) => e.type === "tool_result" && e.id === "ag1",
		);
		expect(agentResult).toBeDefined();
		expect(agentResult?.parent).toBeUndefined();
		// The run's own prompt is still recorded once.
		expect(
			events.filter(
				(e) => e.type === "message" && e.role === "user" && !e.parent,
			),
		).toHaveLength(1);
	}, 15_000);

	test("Claude bridge: a run without subagents has no parent on any entry", async () => {
		const events = await runBridge(CLAUDE_BRIDGE, CLAUDE_PROVIDER, "build it");
		expect(events.some((e) => e.parent !== undefined)).toBeFalse();
	}, 15_000);

	test("Claude stream-json driver: same parent on the subagent's entries", async () => {
		const events = await runLegacyDriver("SUBAGENT");
		expect(
			events.filter((e) => e.parent?.toolUseId === "ag1").map((e) => e.type),
		).toEqual(["message", "tool_call", "tool_result", "message"]);
		expect(
			events.filter(
				(e) => e.type === "message" && e.role === "user" && !e.parent,
			),
		).toHaveLength(1);
		const plain = await runLegacyDriver("build it");
		expect(plain.some((e) => e.parent !== undefined)).toBeFalse();
	}, 20_000);

	test("Codex: a sub-thread's notifications carry its thread id and do not end the run's turn", async () => {
		const events = await runBridge(
			CODEX_BRIDGE,
			CODEX_PROVIDER,
			"SUBTHREAD please",
		);
		const sub = events.filter((e) => e.parent?.threadId === "thread-2");
		expect(sub.map((e) => e.type)).toEqual(["tool_call", "tool_result"]);
		expect(sub[0]).toMatchObject({ id: "sub-cmd" });
		const completed = events.filter(
			(e) => e.type === "session" && e.status === "completed",
		);
		expect(completed).toHaveLength(1);
		expect(completed[0]?.parent).toBeUndefined();
		expect(events.at(-1)).toMatchObject({ type: "done", reason: "complete" });
	}, 15_000);

	test("Codex: a run without sub-threads has no parent on any entry", async () => {
		const events = await runBridge(CODEX_BRIDGE, CODEX_PROVIDER, "inspect it");
		expect(events.some((e) => e.parent !== undefined)).toBeFalse();
	}, 15_000);
});
