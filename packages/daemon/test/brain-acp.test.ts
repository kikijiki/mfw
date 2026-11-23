import "./support/tmux-test-socket.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brainSessions, decisions } from "@mfw/db/schema";
import { eq } from "drizzle-orm";
import { type BrainFixture, brainFixture } from "./support/brain-fixture.ts";

/**
 * ACP brain turns through the real BrainRuntime, RunEngine, tmux, app-server
 * driver and ACP bridge. The agent is a mock ACP agent (or, env-gated, the
 * real `opencode acp`).
 */

const FAKE_ACP = join(import.meta.dir, "fixtures/fake-acp-agent.ts");

let fx: BrainFixture | undefined;
let stateDir: string | undefined;
afterEach(async () => {
	await fx?.cleanup();
	fx = undefined;
	if (stateDir) await rm(stateDir, { recursive: true, force: true });
	stateDir = undefined;
});

interface AcpRequest {
	method: string;
	sessionId: string | null;
	cwd: string | null;
	mcpServers: string[];
	policy: string | null;
	mode: string;
}

async function requests(dir: string): Promise<AcpRequest[]> {
	try {
		return (await readFile(join(dir, "requests.log"), "utf8"))
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l) as AcpRequest);
	} catch {
		return [];
	}
}

async function session(f: BrainFixture) {
	const [s] = await f.svc.handle.db.select().from(brainSessions);
	if (!s) throw new Error("no brain session");
	return s;
}

async function runEvents(f: BrainFixture, runId: string) {
	const text = await readFile(
		join(f.svc.mfwDir, "runs", runId, "events.jsonl"),
		"utf8",
	);
	return text
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as Record<string, unknown>);
}

async function acpFixture(opts: { fake: boolean; provider?: string }) {
	const provider = opts.provider ?? "opencode";
	const dir = await mkdtemp(join(tmpdir(), "mfw-test-acp-state-"));
	stateDir = dir;
	const f = await brainFixture({
		project: {
			provider: {
				id: provider,
				type: "acp",
				env: opts.fake
					? {
							FAKE_ACP_STATE_DIR: dir,
							FAKE_ACP_UNIQUE_IDS: "1",
							FAKE_ACP_QUIET: "1",
						}
					: {},
			},
		},
		brain: { routes: [{ provider, model: "default" }] },
		providerCommand: opts.fake ? ["bun", "run", FAKE_ACP] : null,
	});
	fx = f;
	return { f, dir };
}

async function twoTurns(f: BrainFixture, timeoutMs: number) {
	await f.humanMessage("first");
	await f.settleTurn({ timeoutMs });
	await f.humanMessage("second");
	await f.until(async () => (await f.turns()).length === 2, {
		what: "second turn",
	});
	await f.settleTurn({ timeoutMs });
}

describe("ACP brain turns (mock agent)", () => {
	test("turn 2 resumes turn 1's session with the brain MCP server, under read-only policy", async () => {
		const { f, dir } = await acpFixture({ fake: true });
		await twoTurns(f, 60_000);

		const [t1, t2] = (await f.turns()).reverse();
		expect(t1?.status).toBe("ok");
		expect(t2?.status).toBe("ok");
		expect(t1?.resumed).toBe(false);
		expect(t2?.resumed).toBe(true);

		const reqs = await requests(dir);
		expect(reqs.map((r) => r.method)).toEqual([
			"session/new",
			"session/resume",
		]);
		const [created, resumed] = reqs as [AcpRequest, AcpRequest];
		expect(created.sessionId).toMatch(/^acp-session-/);
		expect(resumed.sessionId).toBe(created.sessionId);
		expect(created.mcpServers).toContain("mfw_brain");
		expect(resumed.mcpServers).toContain("mfw_brain");
		// Both turns ran under the read-only policy, in the brain scratch dir.
		expect(created.policy).toBe("read-only");
		expect(resumed.policy).toBe("read-only");
		const s = await session(f);
		expect(created.cwd).toEndWith(join(".mfw", "brain", s.id));
		expect(resumed.cwd).toBe(created.cwd);

		expect(s.nativeSessionId).toBe(created.sessionId ?? "");
		expect(s.generation).toBe(0);

		// The runtime's mcp.json names the same server the agent was given.
		const cfg = JSON.parse(
			await readFile(
				join(f.svc.mfwDir, "runs", t2?.runId ?? "", "control", "mcp.json"),
				"utf8",
			),
		);
		expect(Object.keys(cfg.mcpServers)).toContain("mfw_brain");

		// The second run's event stream carries the same native session id.
		const sess = (await runEvents(f, t2?.runId ?? "")).filter(
			(e) => e.type === "session",
		);
		expect(sess.length).toBeGreaterThan(0);
		expect(sess.every((e) => e.sessionId === created.sessionId)).toBe(true);
	}, 120_000);

	test("a resume the agent cannot honour rolls the brain over to a fresh session", async () => {
		const { f, dir } = await acpFixture({ fake: true });
		await f.humanMessage("first");
		await f.settleTurn({ timeoutMs: 60_000 });
		const before = await session(f);
		expect(before.nativeSessionId).toMatch(/^acp-session-/);

		// The agent lost its session store (pruned, or a new machine).
		for (const name of await readdir(dir)) {
			if (name.endsWith(".json")) await rm(join(dir, name));
		}
		await f.humanMessage("second");
		await f.until(async () => (await f.turns()).length === 3, {
			what: "failed turn, then the rollover turn",
			timeoutMs: 90_000,
		});
		await f.settleTurn({ timeoutMs: 60_000 });

		const turns = (await f.turns()).reverse();
		expect(turns.map((t) => t.status)).toEqual(["ok", "failed", "ok"]);
		expect(turns[1]?.resumed).toBe(true);
		expect(turns[1]?.generation).toBe(0);
		expect(turns[2]?.generation).toBe(1);
		expect(turns[2]?.resumed).toBe(false);
		expect(turns[2]?.eventsFrom).toBe(turns[1]?.eventsFrom ?? -1);
		expect(turns[2]?.eventsTo).toBe(turns[1]?.eventsTo ?? -1);

		const after = await session(f);
		expect(after.generation).toBe(1);
		expect(after.consecutiveFailures).toBe(0);
		expect(after.nativeSessionId).toMatch(/^acp-session-/);
		expect(after.nativeSessionId).not.toBe(before.nativeSessionId);

		const reqs = await requests(dir);
		expect(reqs.map((r) => r.method)).toEqual([
			"session/new",
			"session/resume",
			"session/new",
		]);
		expect(reqs[1]?.sessionId).toBe(before.nativeSessionId ?? "");
		expect(reqs[2]?.mcpServers).toContain("mfw_brain");

		const [rollover] = await f.svc.handle.db
			.select()
			.from(decisions)
			.where(eq(decisions.kind, "rollover"));
		expect(rollover?.reason).toBe("resume_failed");
	}, 180_000);
});

/** Two real brain turns on an installed agent; the second must resume the first's native session. */
async function realTwoTurns(provider: string): Promise<void> {
	const { f } = await acpFixture({ fake: false, provider });
	await twoTurns(f, 600_000);

	const turns = (await f.turns()).reverse();
	console.log(
		`real ${provider} turns:`,
		JSON.stringify(
			turns.map((t) => ({
				seq: t.seq,
				status: t.status,
				resumed: t.resumed,
				runId: t.runId,
			})),
		),
	);
	const s = await session(f);
	console.log("native session id:", s.nativeSessionId);
	for (const t of turns) {
		const evs = await runEvents(f, t.runId ?? "");
		console.log(
			`run ${t.runId} event types:`,
			[...new Set(evs.map((e) => String(e.type)))].join(","),
			"errors:",
			JSON.stringify(
				evs.filter((e) => e.type === "error").map((e) => e.message),
			),
		);
	}

	expect(turns.map((t) => t.status)).toEqual(["ok", "ok"]);
	expect(turns[1]?.resumed).toBe(true);
	expect(s.nativeSessionId).toBeTruthy();
	expect(s.generation).toBe(0);
	const sess = (await runEvents(f, turns[1]?.runId ?? "")).filter(
		(e) => e.type === "session",
	);
	expect(sess.length).toBeGreaterThan(0);
	expect(sess.every((e) => e.sessionId === s.nativeSessionId)).toBe(true);
}

describe.skipIf(process.env.MFW_REAL_OPENCODE !== "1")(
	"ACP brain turns (real opencode)",
	() => {
		test("real opencode: two turns end ok and the second resumes the same native session", async () => {
			await realTwoTurns("opencode");
		}, 400_000);
	},
);

// pi through pi-acp (bunx pi-acp@<pinned>): needs pi with a usable model configured.
describe.skipIf(process.env.MFW_REAL_PI !== "1")(
	"ACP brain turns (real pi)",
	() => {
		test("real pi: two turns end ok and the second resumes the same native session", async () => {
			await realTwoTurns("pi");
		}, 1_500_000);
	},
);
