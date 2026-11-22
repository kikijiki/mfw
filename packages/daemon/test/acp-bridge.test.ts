import { describe, expect, test } from "bun:test";
import {
	appendFile,
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentEvent, parseAgentEvents } from "../src/agents/events.ts";

const DRIVER = join(
	import.meta.dir,
	"../src/agents/drivers/app-server-driver.ts",
);
const BRIDGE = join(import.meta.dir, "../src/agents/bridges/acp-bridge.ts");
const AGENT = join(import.meta.dir, "fixtures/fake-acp-agent.ts");

type RunOptions = {
	message: string;
	model?: string;
	reasoningEffort?: string;
	approvalMode?: "autonomous" | "interactive";
	env?: Record<string, string> | ((dir: string) => Record<string, string>);
	/** The agent argv; defaults to the mock agent under bun. */
	providerArgv?: (dir: string) => string[];
	/** Runs before the driver starts. */
	setup?: (dir: string) => Promise<void>;
	/** Runs after the driver exits, before the run dir is removed. */
	after?: (dir: string) => Promise<void>;
};

async function readEvents(dir: string): Promise<AgentEvent[]> {
	return parseAgentEvents(await readFile(join(dir, "events.jsonl"), "utf8"));
}

async function waitForEvent(
	dir: string,
	predicate: (events: AgentEvent[]) => boolean,
): Promise<AgentEvent[]> {
	const deadline = Date.now() + 8_000;
	while (Date.now() < deadline) {
		const events = await readEvents(dir);
		if (predicate(events)) return events;
		await Bun.sleep(25);
	}
	throw new Error("timed out waiting for agent event");
}

/** Run the real driver against the bridge and fake agent in a temp run dir. */
async function withRun(
	options: RunOptions,
	during: ((dir: string) => Promise<void>) | undefined,
): Promise<{ events: AgentEvent[]; stderr: string; code: number }> {
	const dir = await mkdtemp(join(tmpdir(), "mfw-acp-bridge-"));
	try {
		await options.setup?.(dir);
		const env =
			typeof options.env === "function"
				? options.env(dir)
				: (options.env ?? {});
		await writeFile(
			join(dir, "driver.json"),
			JSON.stringify({
				bridgeArgv: ["bun", "run", BRIDGE],
				providerArgv: options.providerArgv?.(dir) ?? ["bun", "run", AGENT],
				cwd: dir,
				env,
				model: options.model,
				reasoningEffort: options.reasoningEffort,
				initialMessage: options.message,
				steer: false,
				approvalMode: options.approvalMode ?? "autonomous",
				// The pause after a finished turn for a queued follow-up; none is
				// ever queued here, so do not sit out the 1.5 s default.
				steerGraceMs: 50,
			}),
		);
		await writeFile(join(dir, "events.jsonl"), "");
		await writeFile(join(dir, "control.jsonl"), "");
		const proc = Bun.spawn(["bun", "run", DRIVER, dir], {
			stdout: "ignore",
			stderr: "pipe",
		});
		await during?.(dir);
		const code = await proc.exited;
		const stderr = await new Response(proc.stderr).text();
		await options.after?.(dir);
		return { events: await readEvents(dir), stderr, code };
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function assistantTexts(events: AgentEvent[]): string[] {
	return events.flatMap((e) =>
		e.type === "message" && e.role === "assistant" ? [e.text] : [],
	);
}

describe("ACP bridge through the shared driver", () => {
	test("happy path translates a rich turn", async () => {
		const { events, stderr, code } = await withRun(
			{ message: "do it", env: { MFW_ACP_AGENT: "gemini-cli" } },
			undefined,
		);
		expect(code, stderr).toBe(0);
		expect(stderr).not.toContain("invalid event");
		expect(events[0]).toMatchObject({
			type: "hello",
			provider: "gemini-cli",
			capabilities: {
				steer: false,
				interrupt: true,
				approvals: true,
				plan: true,
				fileChanges: true,
				commandProgress: true,
				mcp: false,
			},
		});
		expect(events.filter((e) => e.type === "session")).toEqual([
			expect.objectContaining({
				provider: "gemini-cli",
				sessionId: "acp-session-1",
				status: "started",
			}),
			expect.objectContaining({ status: "active", turnId: "turn-1" }),
			expect.objectContaining({ status: "completed", turnId: "turn-1" }),
		]);
		expect(events.find((e) => e.type === "thinking")).toMatchObject({
			text: "thinking it over",
		});
		const texts = assistantTexts(events);
		expect(texts[0]).toBe("Working on it. ");
		const final = texts.at(-1) ?? "";
		expect(final).toStartWith("Done. model=mock-fast");
		// No fs or terminal was advertised.
		expect(final).toContain("fs=false");
		expect(events.find((e) => e.type === "tool_call")).toMatchObject({
			id: "tool-1",
			name: "execute",
			input: { command: "ls", token: "[REDACTED]" },
		});
		expect(events.find((e) => e.type === "tool_result")).toMatchObject({
			id: "tool-1",
			ok: true,
			output: "a.txt\nb.txt",
		});
		const change = events.find((e) => e.type === "file_change");
		expect(change).toMatchObject({
			id: "tool-2",
			changes: [{ path: "/work/a.txt", kind: "update" }],
		});
		expect(events.find((e) => e.type === "plan")).toMatchObject({
			steps: [
				{ step: "Look around", status: "completed" },
				{ step: "Edit file", status: "in_progress" },
			],
		});
		expect(events.filter((e) => e.type === "usage")).toEqual([
			expect.objectContaining({ cumulative: true, costUsd: 0.25 }),
			expect.objectContaining({ inputTokens: 10, outputTokens: 5 }),
		]);
		expect(events.at(-1)).toMatchObject({
			type: "done",
			reason: "complete",
			resultText: final,
		});
	}, 20_000);

	test("an absent agent profile reports the generic provider", async () => {
		const { events } = await withRun({ message: "hi" }, undefined);
		expect(events[0]).toMatchObject({ type: "hello", provider: "acp" });
	}, 20_000);

	test("applies a requested model and reasoning level via config options", async () => {
		const { events, stderr, code } = await withRun(
			{ message: "hi", model: "mock-smart", reasoningEffort: "high" },
			undefined,
		);
		expect(code, stderr).toBe(0);
		const final = assistantTexts(events).at(-1) ?? "";
		expect(final).toContain("model=mock-smart");
		expect(final).toContain("thought=high");
		expect(final).toContain("sets=model=mock-smart,thought=high");
	}, 20_000);

	test('model "default" is left to the agent', async () => {
		const { events } = await withRun(
			{ message: "hi", model: "default" },
			undefined,
		);
		const final = assistantTexts(events).at(-1) ?? "";
		expect(final).toContain("model=mock-fast");
		expect(final).toContain("sets=none");
	}, 20_000);

	test("an unoffered model fails closed and names offered values", async () => {
		const { events, code } = await withRun(
			{ message: "hi", model: "gpt-nope" },
			undefined,
		);
		expect(code).toBe(1);
		const error = events.find((e) => e.type === "error");
		expect(error).toMatchObject({ fatal: true });
		expect(error?.type === "error" ? error.message : "").toContain("gpt-nope");
		expect(error?.type === "error" ? error.message : "").toContain(
			"mock-smart",
		);
		expect(events.some((e) => e.type === "session")).toBeFalse();
		expect(events.at(-1)).toMatchObject({ type: "done", reason: "error" });
	}, 20_000);

	test("only the cursor profile asks for the parameterized model picker", async () => {
		const cursor = await withRun(
			{ message: "hi", env: { MFW_ACP_AGENT: "cursor-agent" } },
			undefined,
		);
		expect(assistantTexts(cursor.events).at(-1)).toContain("picker=true");
		const generic = await withRun({ message: "hi" }, undefined);
		expect(assistantTexts(generic.events).at(-1)).toContain("picker=false");
	}, 30_000);

	test("an interrupt ends the turn as killed", async () => {
		const { events, code, stderr } = await withRun(
			{ message: "WAIT_FOR_CANCEL" },
			async (dir) => {
				await waitForEvent(dir, (es) =>
					es.some((e) => e.type === "session" && e.status === "active"),
				);
				await appendFile(
					join(dir, "control.jsonl"),
					`${JSON.stringify({ type: "interrupt" })}\n`,
				);
			},
		);
		expect(code, stderr).toBe(0);
		expect(
			events.filter((e) => e.type === "session").map((e) => e.status),
		).toEqual(["started", "active", "interrupted"]);
		expect(events.at(-1)).toMatchObject({ type: "done", reason: "killed" });
	}, 20_000);

	test("an agent that ignores cancel is cut off after the grace period", async () => {
		const { events, code, stderr } = await withRun(
			{
				message: "IGNORE_CANCEL",
				env: { MFW_ACP_CANCEL_GRACE_MS: "300" },
			},
			async (dir) => {
				await waitForEvent(dir, (es) =>
					es.some((e) => e.type === "session" && e.status === "active"),
				);
				await appendFile(
					join(dir, "control.jsonl"),
					`${JSON.stringify({ type: "interrupt" })}\n`,
				);
			},
		);
		expect(code, stderr).toBe(0);
		expect(
			events.some(
				(e) =>
					e.type === "notice" && e.message.includes("did not end the turn"),
			),
		).toBeTrue();
		expect(events.at(-1)).toMatchObject({ type: "done", reason: "killed" });
	}, 20_000);

	test("an agent crash mid-turn is one fatal error", async () => {
		const { events, code } = await withRun({ message: "CRASH" }, undefined);
		expect(code).toBe(1);
		const errors = events.filter((e) => e.type === "error");
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatchObject({
			fatal: true,
			message: expect.stringContaining("exited unexpectedly"),
		});
		expect(events.at(-1)).toMatchObject({ type: "done", reason: "error" });
	}, 20_000);

	test("a rejected prompt becomes a fatal error and an error done", async () => {
		const { events, code } = await withRun({ message: "FAIL" }, undefined);
		expect(code).toBe(1);
		expect(
			events.filter((e) => e.type === "session").map((e) => e.status),
		).toEqual(["started", "active", "failed"]);
		expect(events.find((e) => e.type === "error")).toMatchObject({
			fatal: true,
			message: expect.stringContaining("mock agent exploded"),
		});
		expect(events.at(-1)).toMatchObject({ type: "done", reason: "error" });
	}, 20_000);

	test("autonomous mode auto-approves with allow_once", async () => {
		const { events, code, stderr } = await withRun(
			{ message: "PERMISSION" },
			undefined,
		);
		expect(code, stderr).toBe(0);
		const approvals = events.filter((e) => e.type === "approval");
		expect(approvals).toEqual([
			expect.objectContaining({
				kind: "command",
				status: "accepted",
				summary: "Auto-approved: Run rm -rf build",
			}),
		]);
		expect(assistantTexts(events).at(-1)).toBe("permission:once");
	}, 20_000);

	test.each([
		["accept", "permission:once"],
		["acceptForSession", "permission:always"],
		["decline", "permission:no"],
	] as const)(
		"interactive mode round-trips a %s decision",
		async (decision, reply) => {
			const { events, code, stderr } = await withRun(
				{ message: "PERMISSION", approvalMode: "interactive" },
				async (dir) => {
					const seen = await waitForEvent(dir, (es) =>
						es.some((e) => e.type === "approval" && e.status === "pending"),
					);
					const pending = seen.find(
						(e) => e.type === "approval" && e.status === "pending",
					);
					if (pending?.type !== "approval") throw new Error("no pending");
					expect(pending.kind).toBe("command");
					await appendFile(
						join(dir, "control.jsonl"),
						`${JSON.stringify({ type: "approval", requestId: pending.requestId, decision })}\n`,
					);
				},
			);
			expect(code, stderr).toBe(0);
			const approvals = events.filter((e) => e.type === "approval");
			expect(approvals.map((e) => e.status)).toEqual([
				"pending",
				decision === "decline" ? "declined" : "accepted",
			]);
			expect(assistantTexts(events).at(-1)).toBe(reply);
		},
		20_000,
	);

	test("Cursor extension methods: todos, a skipped question, an auto-accepted plan", async () => {
		const { events, code, stderr } = await withRun(
			{ message: "CURSOR_EXT", env: { MFW_ACP_AGENT: "cursor-agent" } },
			undefined,
		);
		expect(code, stderr).toBe(0);
		expect(events.find((e) => e.type === "plan")).toMatchObject({
			steps: [
				{ step: "inspect", status: "completed" },
				{ step: "fix", status: "in_progress" },
			],
		});
		const approvals = events.filter((e) => e.type === "approval");
		expect(approvals).toEqual([
			expect.objectContaining({
				kind: "user_input",
				status: "pending",
				summary: "Which mode?",
			}),
			expect.objectContaining({ kind: "user_input", status: "cancelled" }),
			expect.objectContaining({
				kind: "other",
				status: "accepted",
				summary: "Auto-approved: Plan approval: Refactor",
			}),
		]);
		expect(assistantTexts(events).at(-1)).toBe(
			"question:skipped plan:accepted",
		);
	}, 20_000);

	test("an interactive Cursor plan approval round-trips through the driver", async () => {
		const { events, code, stderr } = await withRun(
			{
				message: "CURSOR_EXT",
				approvalMode: "interactive",
				env: { MFW_ACP_AGENT: "cursor-agent" },
			},
			async (dir) => {
				const seen = await waitForEvent(dir, (es) =>
					es.some(
						(e) =>
							e.type === "approval" &&
							e.kind === "other" &&
							e.status === "pending",
					),
				);
				const pending = seen.find(
					(e) => e.type === "approval" && e.kind === "other",
				);
				if (pending?.type !== "approval") throw new Error("no pending");
				await appendFile(
					join(dir, "control.jsonl"),
					`${JSON.stringify({ type: "approval", requestId: pending.requestId, decision: "decline" })}\n`,
				);
			},
		);
		expect(code, stderr).toBe(0);
		expect(assistantTexts(events).at(-1)).toBe(
			"question:skipped plan:rejected",
		);
	}, 20_000);

	test("auth_required tells the user to sign in through the agent CLI", async () => {
		const { events, code } = await withRun(
			{ message: "hi", env: { FAKE_ACP_AUTH_REQUIRED: "1" } },
			undefined,
		);
		expect(code).toBe(1);
		const error = events.find((e) => e.type === "error");
		const message = error?.type === "error" ? error.message : "";
		expect(message).toContain("needs authentication");
		expect(message).toContain("sign in through the agent's own CLI");
		expect(message).toContain("Mock Login");
		expect(events.at(-1)).toMatchObject({ type: "done", reason: "error" });
	}, 20_000);
});

function fatalMessage(events: AgentEvent[]): string {
	const error = events.find((e) => e.type === "error");
	return error?.type === "error" ? error.message : "";
}

/** The part of the final assistant text after `key=` (the rest of the text). */
function reported(events: AgentEvent[], key: string): string {
	const text = assistantTexts(events).at(-1) ?? "";
	const at = text.indexOf(`${key}=`);
	return at < 0 ? "" : text.slice(at + key.length + 1);
}

async function writeMcpConfig(dir: string, names: string[]): Promise<void> {
	const mcpServers = Object.fromEntries(
		names.map((n) => [
			n,
			{ command: "bun", args: ["run", "x.ts"], env: { SECRET: "s3cr3t" } },
		]),
	);
	await writeFile(join(dir, "mcp.json"), JSON.stringify({ mcpServers }));
}
const mcpEnv = (dir: string) => ({ MFW_ACP_MCP_CONFIG: join(dir, "mcp.json") });

describe("MCP servers, resume and load", () => {
	test("MCP servers from the config reach session/new", async () => {
		const { events, code, stderr } = await withRun(
			{
				message: "MCP_ECHO",
				setup: (dir) => writeMcpConfig(dir, ["mfw_brain", "other"]),
				env: mcpEnv,
			},
			undefined,
		);
		expect(code, stderr).toBe(0);
		expect(assistantTexts(events).at(-1)).toBe("mcp=mfw_brain,other");
	}, 20_000);

	test("a missing MCP config fails session/start naming the path", async () => {
		const { events, code } = await withRun(
			{
				message: "hi",
				env: (dir) => ({ MFW_ACP_MCP_CONFIG: join(dir, "nope.json") }),
			},
			undefined,
		);
		expect(code).toBe(1);
		expect(fatalMessage(events)).toContain("MFW_ACP_MCP_CONFIG");
		expect(fatalMessage(events)).toContain("nope.json");
	}, 20_000);

	test("an invalid MCP config fails without echoing its contents", async () => {
		const { events, code } = await withRun(
			{
				message: "hi",
				setup: (dir) => writeFile(join(dir, "mcp.json"), "{ SECRET=hunter2"),
				env: mcpEnv,
			},
			undefined,
		);
		expect(code).toBe(1);
		expect(fatalMessage(events)).toContain("is invalid");
		expect(fatalMessage(events)).not.toContain("hunter2");
	}, 20_000);

	/** A first run mints the session, the second continues it in a new process. */
	async function twoRuns(second: RunOptions) {
		const state = await mkdtemp(join(tmpdir(), "mfw-acp-state-"));
		try {
			const base = { FAKE_ACP_STATE_DIR: state };
			await withRun({ message: "hi", env: base }, undefined);
			const env = (dir: string) =>
				typeof second.env === "function" ? second.env(dir) : (second.env ?? {});
			return await withRun(
				{
					...second,
					env: (dir) => ({
						...base,
						MFW_ACP_RESUME_SESSION: "acp-session-1",
						...env(dir),
					}),
				},
				undefined,
			);
		} finally {
			await rm(state, { recursive: true, force: true });
		}
	}

	test("resumes through the resume capability with MCP servers and the same id", async () => {
		const { events, code, stderr } = await twoRuns({
			message: "MCP_ECHO",
			setup: (dir) => writeMcpConfig(dir, ["mfw_brain"]),
			env: mcpEnv,
		});
		expect(code, stderr).toBe(0);
		expect(events.find((e) => e.type === "session")).toMatchObject({
			sessionId: "acp-session-1",
			status: "started",
		});
		expect(assistantTexts(events)).toEqual(["mcp=mfw_brain"]);
		expect(JSON.stringify(events)).not.toContain("REPLAYED");
	}, 40_000);

	test("loads when resume is not offered and drops the replayed history", async () => {
		const { events, code, stderr } = await twoRuns({
			message: "MCP_ECHO",
			setup: (dir) => writeMcpConfig(dir, ["mfw_brain"]),
			env: (dir) => ({ ...mcpEnv(dir), FAKE_ACP_NO_RESUME: "1" }),
		});
		expect(code, stderr).toBe(0);
		expect(assistantTexts(events)).toEqual(["mcp=mfw_brain"]);
		// Neither the agent_message_chunk nor the user_message_chunk replay.
		expect(JSON.stringify(events)).not.toContain("REPLAYED");
		expect(assistantTexts(events)).toHaveLength(1);
	}, 40_000);

	test("an unknown session fails with the rollover phrase", async () => {
		const { events, code } = await withRun(
			{ message: "hi", env: { MFW_ACP_RESUME_SESSION: "ghost-1" } },
			undefined,
		);
		expect(code).toBe(1);
		const message = fatalMessage(events);
		expect(message).toContain(
			"session ghost-1 not found or could not be resumed:",
		);
		expect(message).toMatch(/session .*not found/i);
	}, 20_000);

	test("an agent that can neither resume nor load fails the same way", async () => {
		const { events, code } = await withRun(
			{
				message: "hi",
				env: {
					MFW_ACP_RESUME_SESSION: "acp-session-1",
					FAKE_ACP_NO_RESUME: "1",
					FAKE_ACP_NO_LOAD: "1",
				},
			},
			undefined,
		);
		expect(code).toBe(1);
		expect(fatalMessage(events)).toMatch(/session .*not found/i);
	}, 20_000);
});

describe("read-only policy", () => {
	const ro = (extra: Record<string, string> = {}) => ({
		MFW_ACP_AGENT: "opencode",
		MFW_ACP_POLICY: "read-only",
		OPENCODE_CONFIG_CONTENT: "",
		...extra,
	});

	test("selects plan through the modes surface", async () => {
		const { events, code, stderr } = await withRun(
			{ message: "MODE?", env: ro() },
			undefined,
		);
		expect(code, stderr).toBe(0);
		expect(assistantTexts(events).at(-1)).toBe("mode=plan");
	}, 20_000);

	test("selects plan through a mode config option", async () => {
		const { events, code, stderr } = await withRun(
			{ message: "MODE?", env: ro({ FAKE_ACP_MODE_AS_OPTION: "1" }) },
			undefined,
		);
		expect(code, stderr).toBe(0);
		expect(assistantTexts(events).at(-1)).toBe("mode=plan");
	}, 20_000);

	test("warns when the agent offers no mode surface; full policy leaves the mode", async () => {
		const none = await withRun(
			{ message: "MODE?", env: ro({ FAKE_ACP_NO_MODES: "1" }) },
			undefined,
		);
		expect(none.code, none.stderr).toBe(0);
		expect(
			none.events.some(
				(e) => e.type === "notice" && e.message.includes('no "plan" mode'),
			),
		).toBeTrue();
		const full = await withRun(
			{ message: "MODE?", env: { MFW_ACP_AGENT: "opencode" } },
			undefined,
		);
		expect(assistantTexts(full.events).at(-1)).toBe("mode=default");
	}, 40_000);

	test.each([
		"autonomous",
		"interactive",
	] as const)("allows the brain MCP tool and denies an edit (%s approvals, never forwarded)", async (approvalMode) => {
		const env = (dir: string) => ro(mcpEnv(dir));
		const setup = (dir: string) => writeMcpConfig(dir, ["mfw_brain"]);
		const tool = await withRun(
			{ message: "MCP_TOOL", approvalMode, setup, env },
			undefined,
		);
		expect(tool.code, tool.stderr).toBe(0);
		expect(assistantTexts(tool.events).at(-1)).toBe("mcp:once");
		const write = await withRun(
			{ message: "TRY_WRITE", approvalMode, setup, env },
			undefined,
		);
		expect(write.code, write.stderr).toBe(0);
		expect(assistantTexts(write.events).at(-1)).toBe("write:no");
		expect(write.events.at(-1)).toMatchObject({
			type: "done",
			reason: "complete",
		});
		const approvals = [...tool.events, ...write.events].flatMap((e) =>
			e.type === "approval" ? [e] : [],
		);
		expect(approvals.map((e) => e.status)).toEqual(["accepted", "declined"]);
		expect(approvals.map((e) => e.summary)).toEqual([
			"Read-only policy: allowed: mfw_brain_board_read",
			"Read-only policy: denied: Write notes.txt",
		]);
	}, 40_000);

	test("policy none denies even the brain MCP tool", async () => {
		const { events, code, stderr } = await withRun(
			{
				message: "MCP_TOOL",
				setup: (dir) => writeMcpConfig(dir, ["mfw_brain"]),
				env: (dir) => ro({ ...mcpEnv(dir), MFW_ACP_POLICY: "none" }),
			},
			undefined,
		);
		expect(code, stderr).toBe(0);
		expect(assistantTexts(events).at(-1)).toBe("mcp:no");
	}, 20_000);

	test("an edit that completes without asking is a fatal violation", async () => {
		const { events, code } = await withRun(
			{ message: "SNEAKY_WRITE", env: ro() },
			undefined,
		);
		expect(code).toBe(1);
		expect(fatalMessage(events)).toBe(
			"read-only policy violated: edit tool 'Write secrets.txt' ran without permission",
		);
		expect(
			events.filter((e) => e.type === "session").map((e) => e.status),
		).toEqual(["started", "active", "failed"]);
		expect(events.at(-1)).toMatchObject({ type: "done", reason: "error" });
	}, 20_000);

	test("the generic profile is refused under read-only and none", async () => {
		for (const policy of ["read-only", "none"]) {
			const { events, code } = await withRun(
				{ message: "hi", env: { MFW_ACP_POLICY: policy } },
				undefined,
			);
			expect(code).toBe(1);
			expect(fatalMessage(events)).toContain(
				"no way to restrict its own tools",
			);
		}
	}, 40_000);
});

describe("agent-side enforcement (layer 1)", () => {
	test("opencode gets deny permissions merged over the inherited config", async () => {
		const inherited = JSON.stringify({
			model: "x/y",
			permission: { read: "allow", edit: "allow" },
		});
		const { events, code, stderr } = await withRun(
			{
				message: "ENV?",
				env: {
					MFW_ACP_AGENT: "opencode",
					MFW_ACP_POLICY: "read-only",
					OPENCODE_CONFIG_CONTENT: inherited,
				},
			},
			undefined,
		);
		expect(code, stderr).toBe(0);
		expect(
			JSON.parse(reported(events, "env").replace(/^.*? env=/, "")),
		).toEqual({
			model: "x/y",
			permission: {
				read: "allow",
				edit: "deny",
				bash: "deny",
				webfetch: "deny",
				task: "deny",
				external_directory: "deny",
				websearch: "deny",
				codesearch: "deny",
			},
		});
	}, 20_000);

	test("cursor-agent gets .cursor/mcp.json and cli.json, merged with the user's", async () => {
		let mcp = "";
		let cli = "";
		const { events, code, stderr } = await withRun(
			{
				message: "MODE?",
				setup: async (dir) => {
					await writeMcpConfig(dir, ["mfw_brain"]);
					await mkdir(join(dir, ".cursor"));
					await writeFile(
						join(dir, ".cursor/mcp.json"),
						JSON.stringify({
							mcpServers: {
								mine: { command: "x" },
								mfw_brain: { command: "stale" },
							},
						}),
					);
					await writeFile(
						join(dir, ".cursor/cli.json"),
						JSON.stringify({
							editor: { vimMode: true },
							permissions: { allow: ["Shell(ls)"], deny: ["Read(.env)"] },
						}),
					);
				},
				env: (dir) => ({
					MFW_ACP_AGENT: "cursor-agent",
					MFW_ACP_POLICY: "read-only",
					...mcpEnv(dir),
				}),
				after: async (dir) => {
					mcp = await readFile(join(dir, ".cursor/mcp.json"), "utf8");
					cli = await readFile(join(dir, ".cursor/cli.json"), "utf8");
				},
			},
			undefined,
		);
		expect(fatalMessage(events)).toBe("");
		expect(code, stderr).toBe(0);
		expect(JSON.parse(mcp)).toEqual({
			mcpServers: {
				mine: { command: "x" },
				mfw_brain: {
					command: "bun",
					args: ["run", "x.ts"],
					env: { SECRET: "s3cr3t" },
				},
			},
		});
		expect(JSON.parse(cli)).toEqual({
			editor: { vimMode: true },
			permissions: {
				allow: ["Shell(ls)", "Read(**)", "Mcp(mfw_brain:*)"],
				deny: ["Read(.env)", "Shell(*)", "Write(**)", "WebFetch(*)"],
			},
		});
	}, 20_000);

	test("cursor-agent config is never written into a git checkout", async () => {
		let wrote = true;
		const { events, code } = await withRun(
			{
				message: "hi",
				setup: (dir) => mkdir(join(dir, ".git")),
				env: { MFW_ACP_AGENT: "cursor-agent", MFW_ACP_POLICY: "read-only" },
				after: async (dir) => {
					wrote = await Bun.file(join(dir, ".cursor/cli.json")).exists();
				},
			},
			undefined,
		);
		expect(code).toBe(1);
		expect(fatalMessage(events)).toContain("git checkout");
		expect(wrote).toBeFalse();
	}, 20_000);
});

describe("routing endpoints", () => {
	const endpoint = JSON.stringify({
		id: "ep",
		baseUrl: "http://127.0.0.1:9/v1",
		envKey: "MFW_TEST_ENDPOINT_KEY",
	});

	test("providers/set carries the base URL and bearer header", async () => {
		const { events, code, stderr } = await withRun(
			{
				message: "PROVIDERS?",
				env: {
					MFW_ACP_AGENT: "gemini-cli",
					MFW_ACP_ENDPOINT: endpoint,
					MFW_TEST_ENDPOINT_KEY: "test-key-123",
					FAKE_ACP_PROVIDERS: "1",
				},
			},
			undefined,
		);
		expect(code, stderr).toBe(0);
		expect(JSON.parse(reported(events, "providers"))).toEqual([
			{
				id: "alt",
				apiType: "openai",
				baseUrl: "http://127.0.0.1:9/v1",
				headers: { Authorization: "Bearer test-key-123" },
			},
		]);
	}, 20_000);

	test("opencode takes the endpoint as a config provider and selects its model", async () => {
		const { events, code, stderr } = await withRun(
			{
				message: "ENV?",
				env: {
					MFW_ACP_AGENT: "opencode",
					MFW_ACP_ENDPOINT: endpoint,
					MFW_ACP_MODEL: "mock-smart",
					OPENCODE_CONFIG_CONTENT: JSON.stringify({ theme: "dark" }),
					FAKE_ACP_EXTRA_MODEL: "mfw-ep/mock-smart",
				},
			},
			undefined,
		);
		expect(code, stderr).toBe(0);
		const text = assistantTexts(events).at(-1) ?? "";
		expect(text).toStartWith("model=mfw-ep/mock-smart env=");
		expect(JSON.parse(text.replace(/^.*? env=/, ""))).toEqual({
			theme: "dark",
			provider: {
				"mfw-ep": {
					npm: "@ai-sdk/openai-compatible",
					name: "mfw ep",
					options: {
						baseURL: "http://127.0.0.1:9/v1",
						apiKey: "{env:MFW_TEST_ENDPOINT_KEY}",
					},
					models: { "mock-smart": {} },
				},
			},
		});
	}, 20_000);

	test.each([
		"cursor-agent",
		"gemini-cli",
	])("%s refuses an endpoint", async (agent) => {
		const { events, code } = await withRun(
			{
				message: "hi",
				env: { MFW_ACP_AGENT: agent, MFW_ACP_ENDPOINT: endpoint },
			},
			undefined,
		);
		expect(code).toBe(1);
		expect(fatalMessage(events)).toContain(
			"cannot use OpenAI-compatible endpoint 'ep': it has no provider configuration over ACP",
		);
	}, 20_000);
});

describe("binary identity before spawn", () => {
	const marker = (dir: string) => join(dir, "agent-started");

	/** <dir>/bin/agent -> <dir>/real/<target>, a script that runs the mock agent. */
	async function linkAgent(dir: string, target: string): Promise<void> {
		await mkdir(join(dir, "bin"));
		await mkdir(join(dir, "real"));
		const script = join(dir, "real", target);
		await writeFile(script, `#!/bin/sh\nexec bun run '${AGENT}' "$@"\n`);
		await chmod(script, 0o755);
		await symlink(script, join(dir, "bin/agent"));
	}
	const cursorEnv = (dir: string) => ({
		MFW_ACP_AGENT: "cursor-agent",
		PATH: `${join(dir, "bin")}:${process.env.PATH}`,
		FAKE_ACP_STARTED_MARKER: marker(dir),
	});

	test("cursor: `agent` linked to cursor-agent is launched", async () => {
		const { events, code, stderr } = await withRun(
			{
				message: "hi",
				setup: (dir) => linkAgent(dir, "cursor-agent"),
				env: cursorEnv,
				providerArgv: () => ["agent", "acp"],
			},
			undefined,
		);
		expect(fatalMessage(events)).toBe("");
		expect(code, stderr).toBe(0);
	}, 20_000);

	test("cursor: an unrelated `agent` is refused and never started", async () => {
		let started = true;
		const { events, code } = await withRun(
			{
				message: "hi",
				setup: (dir) => linkAgent(dir, "other-tool"),
				env: cursorEnv,
				providerArgv: () => ["agent", "acp"],
				after: async (dir) => {
					started = await Bun.file(marker(dir)).exists();
				},
			},
			undefined,
		);
		expect(code).toBe(1);
		expect(fatalMessage(events)).toContain(
			"`agent` on PATH is not Cursor's CLI",
		);
		expect(fatalMessage(events)).toContain("other-tool");
		expect(started).toBeFalse();
	}, 20_000);

	test("cursor: no check when argv[0] is not exactly `agent`", async () => {
		const { events, code, stderr } = await withRun(
			{
				message: "hi",
				setup: (dir) => linkAgent(dir, "other-tool"),
				env: cursorEnv,
			},
			undefined,
		);
		expect(fatalMessage(events)).toBe("");
		expect(code, stderr).toBe(0);
	}, 20_000);

	const FAKE_PI = join(import.meta.dir, "fixtures/fake-pi.sh");
	const IMPOSTOR = join(import.meta.dir, "fixtures/fake-pi-impostor.sh");

	test("pi: a binary whose help names pi is accepted", async () => {
		const { events, code, stderr } = await withRun(
			{
				message: "hi",
				env: { MFW_ACP_AGENT: "pi", MFW_ACP_PI_BIN: FAKE_PI },
			},
			undefined,
		);
		expect(fatalMessage(events)).toBe("");
		expect(code, stderr).toBe(0);
		expect(events[0]).toMatchObject({ type: "hello", provider: "pi" });
	}, 20_000);

	test("pi: an impostor is refused and the agent never starts", async () => {
		let started = true;
		const { events, code } = await withRun(
			{
				message: "hi",
				env: (dir) => ({
					MFW_ACP_AGENT: "pi",
					MFW_ACP_PI_BIN: IMPOSTOR,
					FAKE_ACP_STARTED_MARKER: marker(dir),
				}),
				after: async (dir) => {
					started = await Bun.file(marker(dir)).exists();
				},
			},
			undefined,
		);
		expect(code).toBe(1);
		expect(fatalMessage(events)).toContain(
			"`pi` on PATH is not the pi coding agent",
		);
		expect(started).toBeFalse();
	}, 20_000);

	test("pi: a missing binary is reported as not found", async () => {
		let started = true;
		const { events, code } = await withRun(
			{
				message: "hi",
				env: (dir) => ({
					MFW_ACP_AGENT: "pi",
					MFW_ACP_PI_BIN: join(dir, "no-such-pi"),
					FAKE_ACP_STARTED_MARKER: marker(dir),
				}),
				after: async (dir) => {
					started = await Bun.file(marker(dir)).exists();
				},
			},
			undefined,
		);
		expect(code).toBe(1);
		expect(fatalMessage(events)).toBe("PROVIDER_ERROR: `pi` not found on PATH");
		expect(started).toBeFalse();
	}, 20_000);
});

describe("pi profile", () => {
	const FAKE_PI = join(import.meta.dir, "fixtures/fake-pi.sh");
	const pi = (extra: Record<string, string> = {}) => ({
		MFW_ACP_AGENT: "pi",
		MFW_ACP_PI_BIN: FAKE_PI,
		// An inherited override would otherwise look like a wrapper.
		PI_ACP_PI_COMMAND: "",
		...extra,
	});
	type PiReport = {
		model: string;
		wrapper: string | null;
		wrapperMode: string | null;
		dirMode: string | null;
		extension: string | null;
		mcp: string | null;
	};
	const report = (events: AgentEvent[]): PiReport =>
		JSON.parse(assistantTexts(events).at(-1) ?? "{}");
	const wrapperFor = (flags: string) =>
		`#!/bin/sh\nexec '${FAKE_PI}' ${flags} "$@"\n`;

	test("read-only without MCP servers keeps just the read tools", async () => {
		const { events, code, stderr } = await withRun(
			{ message: "PI_ENV?", env: pi({ MFW_ACP_POLICY: "read-only" }) },
			undefined,
		);
		expect(fatalMessage(events)).toBe("");
		expect(code, stderr).toBe(0);
		const r = report(events);
		expect(r.wrapper).toBe(
			wrapperFor(
				"'--approve' '--no-extensions' '-e' 'builtin:mcp' '--tools' 'read,grep,find,ls'",
			),
		);
		expect(r.wrapperMode).toBe("700");
		expect(r.dirMode).toBe("700");
		expect(r.mcp).toBeNull();
	}, 20_000);

	test("read-only with MCP servers allows their tools and writes .pi/mcp.json", async () => {
		const { events, code, stderr } = await withRun(
			{
				message: "PI_ENV?",
				setup: async (dir) => {
					await writeMcpConfig(dir, ["mfw_brain", "other"]);
					await mkdir(join(dir, ".pi"));
					await writeFile(
						join(dir, ".pi/mcp.json"),
						JSON.stringify({
							mcpServers: {
								mine: { command: "x" },
								mfw_brain: { command: "stale" },
							},
						}),
					);
				},
				env: (dir) => pi({ MFW_ACP_POLICY: "read-only", ...mcpEnv(dir) }),
			},
			undefined,
		);
		expect(fatalMessage(events)).toBe("");
		expect(code, stderr).toBe(0);
		const r = report(events);
		expect(r.wrapper).toContain(
			"'--tools' 'read,grep,find,ls,mcp__mfw_brain__*,mcp__other__*'",
		);
		const entry = {
			command: "bun",
			args: ["run", "x.ts"],
			env: { SECRET: "s3cr3t" },
			exposure: "direct",
		};
		expect(JSON.parse(r.mcp ?? "{}")).toEqual({
			mcpServers: { mine: { command: "x" }, mfw_brain: entry, other: entry },
		});
	}, 20_000);

	test(".pi/mcp.json is never written into a git checkout", async () => {
		const { events, code } = await withRun(
			{
				message: "hi",
				setup: async (dir) => {
					await writeMcpConfig(dir, ["mfw_brain"]);
					await mkdir(join(dir, ".git"));
				},
				env: (dir) => pi({ MFW_ACP_POLICY: "read-only", ...mcpEnv(dir) }),
			},
			undefined,
		);
		expect(code).toBe(1);
		expect(fatalMessage(events)).toContain("git checkout");
	}, 20_000);

	test("policy none runs pi with no tools, extensions or MCP", async () => {
		const { events, code, stderr } = await withRun(
			{ message: "PI_ENV?", env: pi({ MFW_ACP_POLICY: "none" }) },
			undefined,
		);
		expect(code, stderr).toBe(0);
		expect(report(events).wrapper).toBe(
			wrapperFor("'--no-approve' '--no-extensions' '--no-tools' '--no-mcp'"),
		);
	}, 20_000);

	test("full policy without an endpoint has no wrapper", async () => {
		const { events, code, stderr } = await withRun(
			{ message: "PI_ENV?", env: pi() },
			undefined,
		);
		expect(code, stderr).toBe(0);
		expect(report(events).wrapper).toBeNull();
	}, 20_000);

	test("the pi profile never calls set_mode for read-only", async () => {
		const { events, code, stderr } = await withRun(
			{ message: "MODE?", env: pi({ MFW_ACP_POLICY: "read-only" }) },
			undefined,
		);
		expect(code, stderr).toBe(0);
		expect(assistantTexts(events).at(-1)).toBe("mode=default");
	}, 20_000);

	test("an endpoint adds a generated provider extension and selects its model", async () => {
		const endpoint = JSON.stringify({
			id: "ep",
			baseUrl: "http://127.0.0.1:9/v1",
			envKey: "MFW_TEST_ENDPOINT_KEY",
		});
		const { events, code, stderr } = await withRun(
			{
				message: "PI_ENV?",
				env: pi({
					MFW_ACP_ENDPOINT: endpoint,
					MFW_ACP_MODEL: "mock-smart",
					MFW_TEST_ENDPOINT_KEY: "test-key-123",
					FAKE_ACP_EXTRA_MODEL: "mfw-ep/mock-smart",
				}),
			},
			undefined,
		);
		expect(fatalMessage(events)).toBe("");
		expect(code, stderr).toBe(0);
		const r = report(events);
		expect(r.model).toBe("mfw-ep/mock-smart");
		expect(r.wrapper).toStartWith(`#!/bin/sh\nexec '${FAKE_PI}' '-e' '`);
		expect(r.wrapper).toMatch(/\/mfw-endpoint\.js' "\$@"\n$/);
		expect(r.extension).toContain('pi.registerProvider("mfw-ep"');
		expect(r.extension).toContain('"apiKey":"$MFW_TEST_ENDPOINT_KEY"');
		expect(r.extension).toContain('"baseUrl":"http://127.0.0.1:9/v1"');
		expect(r.extension).not.toContain("test-key-123");
	}, 20_000);

	test("an endpoint under policy none puts -e after the policy flags", async () => {
		const endpoint = JSON.stringify({
			id: "ep",
			baseUrl: "http://127.0.0.1:9/v1",
		});
		const { events, code, stderr } = await withRun(
			{
				message: "PI_ENV?",
				env: pi({
					MFW_ACP_POLICY: "none",
					MFW_ACP_ENDPOINT: endpoint,
					MFW_ACP_MODEL: "mock-smart",
					FAKE_ACP_EXTRA_MODEL: "mfw-ep/mock-smart",
				}),
			},
			undefined,
		);
		expect(code, stderr).toBe(0);
		const r = report(events);
		expect(r.wrapper).toContain("'--no-tools' '--no-mcp' '-e' '");
		expect(r.extension).not.toContain("apiKey");
	}, 20_000);

	test.each([
		["grep", true],
		["find", true],
		["ls", true],
		["write", false],
		["bash", false],
		["mystery", false],
	])(
		"read-only: an `other` tool titled %s completing unasked (allowed: %p)",
		async (title, allowed) => {
			const { events, code } = await withRun(
				{
					message: `SNEAKY:other:${title}`,
					env: pi({ MFW_ACP_POLICY: "read-only" }),
				},
				undefined,
			);
			if (allowed) {
				expect(code).toBe(0);
				expect(assistantTexts(events).at(-1)).toBe(`ran:${title}`);
			} else {
				expect(code).toBe(1);
				expect(fatalMessage(events)).toBe(
					`read-only policy violated: other tool '${title}' ran without permission`,
				);
			}
		},
		20_000,
	);

	test.each([
		["edit", "write"],
		["execute", "bash"],
	])(
		"read-only: a %s tool completing unasked is a violation",
		async (kind, title) => {
			const { events, code } = await withRun(
				{
					message: `SNEAKY:${kind}:${title}`,
					env: pi({ MFW_ACP_POLICY: "read-only" }),
				},
				undefined,
			);
			expect(code).toBe(1);
			expect(fatalMessage(events)).toContain("read-only policy violated");
		},
		20_000,
	);

	test("effort none selects the thought level named off", async () => {
		const { events, code, stderr } = await withRun(
			{
				message: "hi",
				reasoningEffort: "none",
				env: pi({ FAKE_ACP_THOUGHT_OFF: "1" }),
			},
			undefined,
		);
		expect(code, stderr).toBe(0);
		expect(assistantTexts(events).at(-1)).toContain("thought=off");
	}, 20_000);

	test("with only session/load the pi profile resumes by loading", async () => {
		const state = await mkdtemp(join(tmpdir(), "mfw-acp-state-"));
		try {
			const base = pi({ FAKE_ACP_STATE_DIR: state });
			await withRun({ message: "hi", env: base }, undefined);
			const { events, code, stderr } = await withRun(
				{
					message: "hi",
					env: {
						...base,
						MFW_ACP_RESUME_SESSION: "acp-session-1",
						FAKE_ACP_NO_RESUME: "1",
					},
				},
				undefined,
			);
			expect(code, stderr).toBe(0);
			const log = (await readFile(join(state, "requests.log"), "utf8"))
				.trim()
				.split("\n")
				.map((l) => JSON.parse(l).method);
			expect(log).toEqual(["session/new", "session/load"]);
			expect(events.find((e) => e.type === "session")).toMatchObject({
				sessionId: "acp-session-1",
			});
		} finally {
			await rm(state, { recursive: true, force: true });
		}
	}, 40_000);
});
