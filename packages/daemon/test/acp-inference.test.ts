import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpInference, inferenceForProvider } from "../src/brain.ts";

const MOCK = join(import.meta.dir, "fixtures", "fake-acp-agent.ts");

/** The REAL bridge against the mock ACP agent; opencode is a profile eligible for policy `none`. */
const client = () =>
	new AcpInference("opencode", { providerArgv: ["bun", "run", MOCK] });

const base = { model: "mock-smart", timeoutMs: 30_000 };

const tempDirs = () =>
	readdirSync(tmpdir()).filter((n) => n.startsWith("mfw-brain-acp-"));

let before: string[] = [];
beforeEach(() => {
	before = tempDirs();
});
afterEach(() => {
	// Every call removes its own scratch dir.
	expect(tempDirs().filter((n) => !before.includes(n))).toEqual([]);
});

describe("AcpInference", () => {
	test("inferenceForProvider picks it for an acp provider", () => {
		expect(
			inferenceForProvider({ id: "opencode", type: "acp" }),
		).toBeInstanceOf(AcpInference);
	});

	test("under the critic's policy a tool-less turn returns its text", async () => {
		const r = await client().complete("MODE?", base);
		const reply = typeof r === "string" ? { text: r } : r;
		expect(reply.text).toMatch(/^mode=/);
	}, 60_000);

	test("the final assistant text and usage come back", async () => {
		// The mock's default turn runs a tool, which policy `none` rightly treats
		// as a violation; relax the policy for this call to read usage.
		const full = new AcpInference("opencode", {
			providerArgv: ["bun", "run", MOCK],
			env: { MFW_ACP_POLICY: "full" },
		});
		const r = await full.complete("summarise", {
			...base,
			reasoningEffort: "high",
		});
		const reply = typeof r === "string" ? { text: r } : r;
		expect(reply.text).toContain("Done. model=mock-smart thought=high");
		expect(reply).toHaveProperty("usage");
		expect((reply as { usage: Record<string, number> }).usage).toMatchObject({
			inputTokens: 10,
			outputTokens: 5,
			costUsd: 0.25,
		});
	}, 60_000);

	test("a failed turn throws the agent's message", async () => {
		await expect(client().complete("FAIL please", base)).rejects.toThrow(
			/mock agent exploded/,
		);
	}, 60_000);

	test("the budget kills a turn that never returns", async () => {
		const started = Date.now();
		await expect(
			client().complete("IGNORE_CANCEL", { ...base, timeoutMs: 1_500 }),
		).rejects.toThrow("acp agent timed out");
		expect(Date.now() - started).toBeLessThan(20_000);
	}, 60_000);

	test("an abort signal stops the call", async () => {
		const ac = new AbortController();
		setTimeout(() => ac.abort(), 1_000);
		await expect(
			client().complete("IGNORE_CANCEL", { ...base, signal: ac.signal }),
		).rejects.toThrow("acp agent aborted");
	}, 60_000);
});
