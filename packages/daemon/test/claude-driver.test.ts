import { describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentEvent, parseAgentEvents } from "../src/agents/events.ts";

const DRIVER = join(import.meta.dir, "../src/agents/drivers/claude-driver.ts");
const FAKE = join(import.meta.dir, "fixtures/fake-claude.ts");

async function runDriver(
	cfg: Partial<{
		initialMessage: string;
		steer: boolean;
	}> = {},
	during?: (dir: string) => Promise<void>,
): Promise<{ events: AgentEvent[]; exitCode: number | null }> {
	const dir = await mkdtemp(join(tmpdir(), "mfw-drv-"));
	await writeFile(
		join(dir, "driver.json"),
		JSON.stringify({
			argv: ["bun", "run", FAKE],
			cwd: dir,
			env: {},
			initialMessage: cfg.initialMessage ?? "hello",
			steer: cfg.steer ?? true,
		}),
	);
	await writeFile(join(dir, "steer.jsonl"), "");
	const proc = Bun.spawn(["bun", "run", DRIVER, dir], {
		stdout: "ignore",
		stderr: "ignore",
	});
	if (during) await during(dir);
	const timeout = setTimeout(() => proc.kill(), 15_000);
	const exitCode = await proc.exited;
	clearTimeout(timeout);
	const events = parseAgentEvents(
		await readFile(join(dir, "events.jsonl"), "utf8"),
	);
	await rm(dir, { recursive: true, force: true });
	return { events, exitCode };
}

describe("claude driver v2", () => {
	test("one-shot: hello → user/assistant messages → usage → done with resultText", async () => {
		const { events, exitCode } = await runDriver({
			initialMessage: "build it",
		});
		expect(exitCode).toBe(0);
		const types = events.map((e) => e.type);
		expect(types[0]).toBe("hello");
		const hello = events[0] as Extract<AgentEvent, { type: "hello" }>;
		expect(hello.provider).toBe("claude-cli");
		expect(hello.capabilities.steer).toBe(true);
		expect(types).toContain("message");
		// The CLI replays the user line we just sent (`--replay-user-messages`);
		// `send()` already recorded it once, so the replay must not double it.
		const userMsgs = events.filter(
			(e) => e.type === "message" && e.role === "user",
		);
		expect(userMsgs).toHaveLength(1);
		const assistant = events.find(
			(e) => e.type === "message" && e.role === "assistant",
		) as Extract<AgentEvent, { type: "message" }>;
		expect(assistant.text).toBe("got: build it");
		const done = events.at(-1) as Extract<AgentEvent, { type: "done" }>;
		expect(done.type).toBe("done");
		expect(done.reason).toBe("complete");
		expect(done.resultText).toBe("ack: build it");
		// seq is strictly monotonic
		const seqs = events.map((e) => e.seq);
		expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
	});

	test("steering: a queued message becomes the next turn before completion", async () => {
		const { events } = await runDriver(
			{ initialMessage: "first" },
			async (dir) => {
				// queue a steer while the driver's grace window is open
				await Bun.sleep(400);
				await appendFile(
					join(dir, "steer.jsonl"),
					`${JSON.stringify("second")}\n`,
				);
			},
		);
		const userMsgs = events
			.filter(
				(e): e is Extract<AgentEvent, { type: "message" }> =>
					e.type === "message" && e.role === "user",
			)
			.map((e) => e.text);
		expect(userMsgs).toEqual(["first", "second"]);
		const acks = events
			.filter(
				(e): e is Extract<AgentEvent, { type: "message" }> =>
					e.type === "message" && e.role === "assistant",
			)
			.map((e) => e.text);
		expect(acks).toEqual(["got: first", "got: second"]);
	}, 20_000);

	/**
	 * MFW-57: `allowed_warning` is a heads-up, not a refusal, the request went
	 * through. The driver is where that vendor vocabulary gets resolved into a
	 * plain boolean; everything downstream (`StepRunner.classify`) trusts
	 * `limited` and never re-reads `status`.
	 */
	test("an allowed_warning resolves to limited:false, with utilization surfaced", async () => {
		const { events } = await runDriver({ initialMessage: "RATE_LIMIT_WARN" });
		const rateLimit = events.find(
			(e): e is Extract<AgentEvent, { type: "rate_limit" }> =>
				e.type === "rate_limit",
		);
		expect(rateLimit?.limited).toBe(false);
		expect(rateLimit?.utilization).toBe(0.78);
	});

	test("steer:false closes after the first result and reports steer=false", async () => {
		const { events } = await runDriver({
			initialMessage: "solo",
			steer: false,
		});
		const hello = events[0] as Extract<AgentEvent, { type: "hello" }>;
		expect(hello.capabilities.steer).toBe(false);
		const done = events.at(-1) as Extract<AgentEvent, { type: "done" }>;
		expect(done.reason).toBe("complete");
	});
});
