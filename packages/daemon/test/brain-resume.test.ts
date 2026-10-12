import "./support/tmux-test-socket.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { brainSessions, decisions, events, spendLedger } from "@mfw/db/schema";
import { and, asc, eq } from "drizzle-orm";
import { type BrainFixture, brainFixture } from "./support/brain-fixture.ts";

/**
 * A fake `claude` records argv and emulates the session store, so these tests
 * see exactly what a real wake would pass: native `--session-id` / `--resume`,
 * and the per-wake flags the CLI does not restore on its own.
 */

let fx: BrainFixture | undefined;
afterEach(async () => {
	await fx?.cleanup();
	fx = undefined;
});

const flag = (argv: string[], name: string) => {
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : undefined;
};

async function session(f: BrainFixture) {
	const [s] = await f.svc.handle.db.select().from(brainSessions);
	if (!s) throw new Error("no brain session");
	return s;
}

describe("native resume", () => {
	test("the second wake resumes the same session id and re-passes --mcp-config and the tool gates", async () => {
		fx = await brainFixture();
		await fx.humanMessage("first");
		await fx.settleTurn();
		await fx.humanMessage("second");
		await fx.until(async () => (await fx?.turns())?.length === 2, {
			what: "second turn",
		});
		await fx.settleTurn();

		const [first, second] = await fx.argv();
		if (!first || !second) throw new Error("expected two invocations");
		const minted = flag(first.argv, "--session-id");
		expect(minted).toMatch(/^[0-9a-f-]{36}$/);
		expect(first.argv).not.toContain("--resume");

		expect(flag(second.argv, "--resume")).toBe(minted);
		expect(second.argv).not.toContain("--session-id");
		for (const run of [first, second]) {
			expect(run.argv).toContain("--mcp-config");
			expect(run.argv).toContain("--strict-mcp-config");
			expect(flag(run.argv, "--allowedTools")).toContain("mcp__mfw_brain__*");
			const denied = flag(run.argv, "--disallowedTools") ?? "";
			for (const t of ["Bash", "Edit", "Write", "Agent"]) {
				expect(denied).toContain(t);
			}
			expect(run.argv).not.toContain("--dangerously-skip-permissions");
		}

		const s = await session(fx);
		expect(s.nativeSessionId).toBe(minted ?? null);
		expect(s.generation).toBe(0);
		// A fixed cwd: the scratch dir, never a worktree.
		expect(first.cwd).toBe(second.cwd);
		expect(first.cwd).toEndWith(join(".mfw", "brain", s.id));
		expect(first.projectDir).toBe(`mfw-brain-${s.id}`);

		const [t1, t2] = (await fx.turns()).reverse();
		expect(t1?.resumed).toBe(false);
		expect(t2?.resumed).toBe(true);
		expect(t1?.status).toBe("ok");
		expect(t2?.status).toBe("ok");
		// Per-turn MCP config is attributed to its turn.
		const cfg = JSON.parse(
			await readFile(
				join(fx.svc.mfwDir, "runs", t2?.runId ?? "", "mcp.json"),
				"utf8",
			),
		);
		expect(cfg.mcpServers.mfw_brain.args).toContain("--brain");
		expect(cfg.mcpServers.mfw_brain.env.MFW_BRAIN_TURN).toBe(t2?.runId);
		// The digest the model saw is kept for the audit view.
		const digest = await readFile(
			join(fx.svc.mfwDir, "runs", t1?.runId ?? "", "digest.md"),
			"utf8",
		);
		expect(digest).toContain("# Wake: human");
		// Live: the acts take effect, there is no shadow notice.
		expect(digest).not.toContain("SHADOW MODE");
		expect(digest).toContain("You decide what runs");
		expect(digest).toContain("human.brain_message");
	}, 90_000);

	test("a missing native session rolls the brain over: generation + 1, a rollover decision, a fresh session, re-delivered events", async () => {
		fx = await brainFixture();
		await fx.humanMessage("first");
		await fx.settleTurn();
		const before = await session(fx);

		// The session file is gone (pruned, or the daemon moved machines).
		await Bun.$`rm -f ${join(fx.store, "sessions")}/*.json`.quiet();
		await fx.humanMessage("second");
		await fx.until(async () => (await fx?.turns())?.length === 3, {
			what: "failed turn, then the rollover turn",
			timeoutMs: 60_000,
		});
		await fx.settleTurn();

		const turns = (await fx.turns()).reverse();
		expect(turns.map((t) => t.status)).toEqual(["ok", "failed", "ok"]);
		// The failed turn's range is re-delivered to the new generation.
		expect(turns[2]?.eventsFrom).toBe(turns[1]?.eventsFrom ?? -1);
		expect(turns[2]?.eventsTo).toBe(turns[1]?.eventsTo ?? -1);
		expect(turns[1]?.generation).toBe(0);
		expect(turns[2]?.generation).toBe(1);
		expect(turns[2]?.resumed).toBe(false);

		const after = await session(fx);
		expect(after.generation).toBe(1);
		expect(after.nativeSessionId).not.toBe(before.nativeSessionId);
		// A broken resume is the session's fault, never the brain's.
		expect(after.consecutiveFailures).toBe(0);

		const argv = await fx.argv();
		expect(flag(argv[1]?.argv ?? [], "--resume")).toBe(
			before.nativeSessionId ?? undefined,
		);
		expect(argv[2]?.argv).not.toContain("--resume");
		expect(flag(argv[2]?.argv ?? [], "--session-id")).toBe(
			after.nativeSessionId ?? undefined,
		);

		const [rollover] = await fx.svc.handle.db
			.select()
			.from(decisions)
			.where(eq(decisions.kind, "rollover"));
		expect(rollover?.reason).toBe("resume_failed");
		expect(rollover?.brainSessionId).toBe(after.id);
		const ev = await fx.svc.handle.db
			.select()
			.from(events)
			.where(eq(events.type, "brain.rollover"));
		expect(ev).toHaveLength(1);
		expect(ev[0]?.payload).toMatchObject({
			fromGeneration: 0,
			toGeneration: 1,
		});

		// The new generation is rehydrated, not just woken.
		const digest = await readFile(
			join(fx.svc.mfwDir, "runs", turns[2]?.runId ?? "", "digest.md"),
			"utf8",
		);
		expect(digest).toContain("# You are this project's brain");
		expect(digest).toContain("Your standing plan");
	}, 120_000);

	test("passing the context-token threshold rolls over before the next wake", async () => {
		fx = await brainFixture({ brain: { rolloverTokens: 5_000 } });
		await fx.plan("tokens:9000");
		await fx.humanMessage("first");
		await fx.settleTurn();
		expect((await session(fx)).contextTokens).toBe(9000);

		await fx.humanMessage("second");
		await fx.until(async () => (await fx?.turns())?.length === 2, {
			what: "second turn",
		});
		await fx.settleTurn();

		const after = await session(fx);
		expect(after.generation).toBe(1);
		const argv = await fx.argv();
		expect(argv[1]?.argv).not.toContain("--resume");
		const [rollover] = await fx.svc.handle.db
			.select()
			.from(decisions)
			.where(eq(decisions.kind, "rollover"));
		expect(rollover?.reason).toBe("context_tokens");
	}, 90_000);

	test("the ledger records each turn's delta of the conversation's running cost", async () => {
		fx = await brainFixture();
		await fx.plan("cost:0.5", "cost:0.7");
		await fx.humanMessage("first");
		await fx.settleTurn();
		await fx.humanMessage("second");
		await fx.until(async () => (await fx?.turns())?.length === 2, {
			what: "second turn",
		});
		await fx.settleTurn();

		const s = await session(fx);
		const rows = await fx.svc.handle.db
			.select()
			.from(spendLedger)
			.where(
				and(
					eq(spendLedger.brainSessionId, s.id),
					eq(spendLedger.source, "brain_usage"),
				),
			)
			.orderBy(asc(spendLedger.ts));
		// The CLI reported 0.50 then a running total of 1.20: 0.50 and 0.70.
		expect(rows.map((r) => r.usd)).toEqual([0.5, 0.7]);
		expect(rows.every((r) => r.kind === "brain")).toBe(true);
		expect(s.lastCostTotal).toBeCloseTo(1.2, 9);
	}, 90_000);
});
