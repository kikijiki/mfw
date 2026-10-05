import { describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAgentEvents } from "../src/agents/events.ts";

const DRIVER = join(
	import.meta.dir,
	"../src/agents/drivers/app-server-driver.ts",
);
const BRIDGE = join(
	import.meta.dir,
	"../src/agents/bridges/codex-app-server-bridge.ts",
);
const PROVIDER = join(import.meta.dir, "fixtures/fake-codex-app-server.ts");
const CLAUDE_BRIDGE = join(
	import.meta.dir,
	"../src/agents/bridges/claude-app-server.ts",
);
const CLAUDE_PROVIDER = join(
	import.meta.dir,
	"fixtures/fake-claude-app-server.ts",
);

async function waitForEvent(
	dir: string,
	predicate: (events: ReturnType<typeof parseAgentEvents>) => boolean,
): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const events = parseAgentEvents(
			await readFile(join(dir, "events.jsonl"), "utf8"),
		);
		if (predicate(events)) return;
		await Bun.sleep(25);
	}
	throw new Error("timed out waiting for agent event");
}

describe("shared app-server driver", () => {
	test("runs the native Codex bridge and preserves rich events", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mfw-app-server-"));
		try {
			await writeFile(
				join(dir, "driver.json"),
				JSON.stringify({
					bridgeArgv: ["bun", "run", BRIDGE],
					providerArgv: ["bun", "run", PROVIDER],
					cwd: dir,
					env: {},
					initialMessage: "inspect it",
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
			const events = parseAgentEvents(
				await readFile(join(dir, "events.jsonl"), "utf8"),
			);
			expect(events[0]).toMatchObject({
				type: "hello",
				provider: "codex-cli",
			});
			expect(events.some((event) => event.type === "tool_progress")).toBeTrue();
			expect(events.some((event) => event.type === "tool_result")).toBeTrue();
			expect(
				events.filter((event) => event.type === "rate_limit"),
			).toHaveLength(1);
			expect(
				events.some(
					(event) =>
						event.type === "notice" &&
						event.message === "Codex rate-limit state updated",
				),
			).toBeFalse();
			expect(events.some((event) => event.type === "notice")).toBeFalse();
			expect(
				events.some(
					(event) => event.type === "tool_call" && event.name === "userMessage",
				),
			).toBeFalse();
			expect(events.at(-1)).toMatchObject({
				type: "done",
				reason: "complete",
				resultText: "done",
			});
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 15_000);

	test("Claude's replay-user-messages echo does not double the prompt in the transcript", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mfw-claude-app-server-"));
		try {
			await writeFile(
				join(dir, "driver.json"),
				JSON.stringify({
					bridgeArgv: ["bun", "run", CLAUDE_BRIDGE],
					providerArgv: ["bun", "run", CLAUDE_PROVIDER],
					cwd: dir,
					env: {},
					initialMessage: "build it",
					reasoningEffort: "medium",
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
			const events = parseAgentEvents(
				await readFile(join(dir, "events.jsonl"), "utf8"),
			);
			const userMsgs = events.filter(
				(event) => event.type === "message" && event.role === "user",
			);
			expect(userMsgs).toHaveLength(1);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 15_000);

	test("Claude interruption records the terminal turn lifecycle", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mfw-claude-app-server-"));
		try {
			await writeFile(
				join(dir, "driver.json"),
				JSON.stringify({
					bridgeArgv: ["bun", "run", CLAUDE_BRIDGE],
					providerArgv: ["bun", "run", CLAUDE_PROVIDER],
					cwd: dir,
					env: {},
					initialMessage: "WAIT_FOR_INTERRUPT",
					reasoningEffort: "medium",
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

			await waitForEvent(dir, (events) =>
				events.some(
					(event) => event.type === "session" && event.status === "active",
				),
			);
			await appendFile(
				join(dir, "control.jsonl"),
				`${JSON.stringify({ type: "interrupt" })}\n`,
			);

			const code = await proc.exited;
			const stderr = await new Response(proc.stderr).text();
			expect(code, stderr).toBe(0);
			expect(stderr).not.toContain("invalid event");
			const events = parseAgentEvents(
				await readFile(join(dir, "events.jsonl"), "utf8"),
			);
			expect(
				events
					.filter((event) => event.type === "session")
					.map((event) => event.status),
			).toEqual(["started", "active", "interrupted"]);
			expect(events.at(-1)).toMatchObject({
				type: "done",
				reason: "killed",
			});
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 15_000);
});
