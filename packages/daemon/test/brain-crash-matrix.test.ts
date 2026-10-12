import "./support/tmux-test-socket.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
	brainActions,
	brainSessions,
	decisions,
	mergeJobs,
	runs,
} from "@mfw/db/schema";
import { eq } from "drizzle-orm";
import { boot } from "../src/boot.ts";
import { InjectedExecutorCrash } from "../src/brain-runtime/executor.ts";
import { silentLogger } from "../src/log.ts";
import { type BrainFixture, brainFixture } from "./support/brain-fixture.ts";
import { type GroupFixture, groupFixture } from "./support/group-fixture.ts";
import { TEST_TMUX_SOCKET } from "./support/tmux-test-socket.ts";

/**
 * Design §6.3 rows 1, 2, 3, 7, 8 and 10, driven through a real boot, real tmux
 * sessions and a fake `claude` CLI. A "crash" is `shutdown()` (loops stop, tmux
 * sessions stay) followed by a fresh boot over the same state, which is what
 * the process-death recovery sees: durable rows and whatever is still alive.
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

/** Skip the retry backoff so a test need not wait it out in real time. */
async function clearBackoff(f: BrainFixture) {
	await f.svc.handle.db.update(brainSessions).set({ retryAfter: null });
}

describe("brain crash matrix", () => {
	test("row 1: daemon down with events pending: one wake with all of them after boot", async () => {
		fx = await brainFixture();
		const startCursor = (await session(fx)).cursor;
		await fx.humanMessage("one");
		await fx.humanMessage("two");
		await fx.humanMessage("three");
		// Down before any pass could start a turn.
		await fx.restart();

		await fx.settleTurn();
		const turns = await fx.turns();
		expect(turns).toHaveLength(1);
		expect(turns[0]).toMatchObject({
			status: "ok",
			eventsFrom: startCursor + 1,
		});
		const digest = await readFile(
			join(fx.svc.mfwDir, "runs", turns[0]?.runId ?? "", "digest.md"),
			"utf8",
		);
		for (const t of ["one", "two", "three"]) {
			expect(digest).toContain(`text=${t}`);
		}
		expect((await fx.argv()).length).toBe(1);
		expect((await session(fx)).cursor).toBe(turns[0]?.eventsTo ?? -1);
	}, 90_000);

	test("row 2: daemon crash mid-turn: the live turn is adopted, finishes once, and retried tool calls are not duplicated", async () => {
		fx = await brainFixture();
		await fx.plan("hold");
		await fx.humanMessage("long thinking");
		await fx.until(async () => (await fx?.argv())?.length === 1, {
			what: "the CLI to start",
		});
		const [live] = await fx.turns();
		const runId = live?.runId ?? "";
		expect(live?.status).toBe("running");

		const call = { turnRunId: runId, tool: "note", args: { text: "halfway" } };
		const first = await fx.svc.brainRuntime.actions.act(call);

		const before = fx.orchestrator.bootId;
		await fx.restart();
		expect(fx.orchestrator.bootId).not.toBe(before);

		// Adopted, not restarted: still one turn, still one CLI, lease re-owned.
		let s = await session(fx);
		expect((await fx.turns()).map((t) => t.status)).toEqual(["running"]);
		expect(s.leaseOwner).toBe(fx.orchestrator.bootId);
		expect((await fx.argv()).length).toBe(1);

		// The model's retried call after the daemon came back is the same action.
		const again = await fx.svc.brainRuntime.actions.act(call);
		expect(again.actionId).toBe(first.actionId);
		expect(again.duplicate).toBe(true);
		expect(await fx.svc.handle.db.select().from(brainActions)).toHaveLength(1);

		await fx.release();
		await fx.settleTurn();
		const turns = await fx.turns();
		expect(turns).toHaveLength(1);
		expect(turns[0]?.status).toBe("ok");
		s = await session(fx);
		expect(s.cursor).toBe(turns[0]?.eventsTo ?? -1);
		expect((await fx.argv()).length).toBe(1);
	}, 90_000);

	test("row 3: the brain process dies mid-turn: turn failed, cursor stays, the next wake resends the same events with the applied actions listed", async () => {
		fx = await brainFixture();
		await fx.plan("hold");
		await fx.humanMessage("important");
		await fx.until(async () => (await fx?.argv())?.length === 1, {
			what: "the CLI to start",
		});
		const [t1] = await fx.turns();
		const runId = t1?.runId ?? "";
		const cursorBefore = (await session(fx)).cursor;
		await fx.svc.brainRuntime.actions.act({
			turnRunId: runId,
			tool: "note",
			args: { text: "noticed something before dying" },
		});

		// The whole brain process tree is gone: no tmux session, no exit record.
		const kill = Bun.spawn(
			["tmux", "-L", TEST_TMUX_SOCKET, "kill-session", "-t", `mfw_${runId}`],
			{ stdout: "ignore", stderr: "ignore" },
		);
		await kill.exited;
		await fx.settleTurn();

		const [failed] = await fx.turns();
		expect(failed?.status).toBe("failed");
		let s = await session(fx);
		expect(s.cursor).toBe(cursorBefore);
		expect(s.consecutiveFailures).toBe(1);

		await clearBackoff(fx);
		await fx.plan(); // the next CLI invocation behaves
		await fx.until(async () => (await fx?.turns())?.length === 2, {
			what: "the retry turn",
		});
		await fx.settleTurn();

		const [retry, first] = await fx.turns();
		expect(retry?.status).toBe("ok");
		expect(retry?.eventsFrom).toBe(first?.eventsFrom ?? -1);
		expect(retry?.eventsTo).toBe(first?.eventsTo ?? -1);
		// The conversation up to the last persisted message is resumed.
		expect(retry?.resumed).toBe(true);
		const argv = await fx.argv();
		expect(flag(argv[1]?.argv ?? [], "--resume")).toBe(
			flag(argv[0]?.argv ?? [], "--session-id") ?? "none",
		);
		const digest = await readFile(
			join(fx.svc.mfwDir, "runs", retry?.runId ?? "", "digest.md"),
			"utf8",
		);
		expect(digest).toContain("## Applied since your last turn");
		expect(digest).toContain("note: applied");
		s = await session(fx);
		expect(s.consecutiveFailures).toBe(0);
		expect(s.cursor).toBe(retry?.eventsTo ?? -1);
	}, 120_000);

	test("row 7: native session file missing: rollover from durable state, audited", async () => {
		fx = await brainFixture();
		await fx.humanMessage("one");
		await fx.settleTurn();
		await fx.svc.brainRuntime.actions
			.act({
				turnRunId: (await fx.turns())[0]?.runId ?? "",
				tool: "set_plan",
				args: { markdown: "# Standing plan\n- keep the frontier small" },
			})
			.catch(() => {
				// the turn already ended; the plan is written below instead
			});
		await Bun.$`rm -f ${join(fx.store, "sessions")}/*.json`.quiet();
		await fx.humanMessage("two");
		await fx.until(async () => (await fx?.turns())?.length === 3, {
			what: "rollover turn",
			timeoutMs: 60_000,
		});
		await fx.settleTurn();

		const s = await session(fx);
		expect(s.generation).toBe(1);
		const argv = await fx.argv();
		expect(argv[2]?.argv).not.toContain("--resume");
		const [r] = await fx.svc.handle.db
			.select()
			.from(decisions)
			.where(eq(decisions.kind, "rollover"));
		expect(r?.reason).toBe("resume_failed");
	}, 120_000);

	test("row 8: the daemon moved machines: the session file is host-local, so roll over before resuming", async () => {
		fx = await brainFixture();
		await fx.humanMessage("one");
		await fx.settleTurn();
		await fx.svc.handle.db
			.update(brainSessions)
			.set({ nativeHost: "some-other-machine" });
		await fx.humanMessage("two");
		await fx.until(async () => (await fx?.turns())?.length === 2, {
			what: "second turn",
		});
		await fx.settleTurn();

		const argv = await fx.argv();
		// One CLI call only: it was never asked to resume a session that is not here.
		expect(argv).toHaveLength(2);
		expect(argv[1]?.argv).not.toContain("--resume");
		const [r] = await fx.svc.handle.db
			.select()
			.from(decisions)
			.where(eq(decisions.kind, "rollover"));
		expect(r?.reason).toBe("host_changed");
		expect((await session(fx)).generation).toBe(1);
		expect((await session(fx)).nativeHost).not.toBe("some-other-machine");
	}, 90_000);

	test("row 10: repeated failures open the circuit: one page, no more turns, the rest keeps running, a human reset resumes", async () => {
		const notified = "notified.log";
		fx = await brainFixture();
		// Notifications go to a file through the project's command sink.
		await fx.cleanup();
		fx = await brainFixture({
			project: {
				notify: {
					command: `printf '%s\\n' "$MFW_NOTIFY_TYPE" >> "${join(
						// the fixture's store dir is only known after creation
						"/tmp",
						notified,
					)}"`,
				},
			},
		});
		await rm(join("/tmp", notified), { force: true });
		await fx.plan("fail", "fail", "fail");

		for (let i = 0; i < 3; i++) {
			await fx.humanMessage(`attempt ${i}`);
			await fx.until(async () => (await fx?.turns())?.length === i + 1, {
				what: `turn ${i + 1}`,
			});
			await fx.settleTurn();
			await clearBackoff(fx);
		}
		const s = await session(fx);
		expect(s.status).toBe("failed");
		expect(s.consecutiveFailures).toBe(3);
		expect((await fx.turns()).every((t) => t.status === "failed")).toBe(true);

		const log = await readFile(join("/tmp", notified), "utf8").catch(() => "");
		expect(log.split("\n").filter((l) => l === "brain_stuck")).toHaveLength(1);

		// Open circuit: new events start nothing, but everything else keeps going.
		await fx.humanMessage("anyone there?");
		for (let i = 0; i < 3; i++) await fx.svc.supervisor.pass();
		expect((await fx.turns()).length).toBe(3);
		expect((await fx.svc.brainRuntime.tick()).state).toBe("failed");
		await expect(fx.svc.mergeQueue.tick()).resolves.toBeDefined();

		await fx.svc.brainRuntime.resetCircuit();
		await fx.plan();
		await fx.until(async () => (await fx?.turns())?.length === 4, {
			what: "turn after the reset",
		});
		await fx.settleTurn();
		expect((await fx.turns())[0]?.status).toBe("ok");
		await rm(join("/tmp", notified), { force: true });
	}, 180_000);
});

// ---------------------------------------------------------------------------
// P2: the executor's rows (design §6.3 rows 4, 5, 6 and 11). Real git, tmux and
// finalize with a scripted worker; the brain is the test, through the action
// service. "Crash" = shutdown (tmux stays) + a fresh boot over the same state.
// ---------------------------------------------------------------------------

describe("brain crash matrix: the action executor", () => {
	let gfx: GroupFixture | undefined;
	afterEach(async () => {
		await gfx?.cleanup();
		gfx = undefined;
	});

	/** Arm a crash: the executor throws at `point` the next time it gets there. */
	function armCrash(f: GroupFixture, point: string) {
		const ex = f.svc.brainRuntime.executor as unknown as {
			deps: { crashAt?: (p: string) => void };
		};
		ex.deps.crashAt = (p) => {
			if (p === point) {
				ex.deps.crashAt = undefined;
				throw new InjectedExecutorCrash(p as never);
			}
		};
	}

	const sessions = async (f: GroupFixture) => {
		const out = Bun.spawn(
			[
				"tmux",
				"-L",
				TEST_TMUX_SOCKET,
				"list-sessions",
				"-F",
				"#{session_name}",
			],
			{ stdout: "pipe", stderr: "ignore" },
		);
		const text = await new Response(out.stdout).text();
		await out.exited;
		void f;
		return text.split("\n").filter((n) => n.startsWith("mfw_"));
	};

	const runRows = (f: GroupFixture) =>
		f.svc.handle.db.select().from(runs).where(eq(runs.kind, "task"));

	test("row 4: a crash after the outbox commit and before launch: recovery leaves the action, the next admission launches the pre-minted run once", async () => {
		gfx = await groupFixture();
		const f = gfx;
		// keep the worker alive so its tmux session can be counted
		await f.control({ slowMs: 4_000 });
		const task = await f.task("row four");
		const r = await f.spawn(task);
		const runId = (r.result?.runIds as string[])[0] as string;
		expect(await runRows(f)).toHaveLength(0);

		await f.restart();
		// boot-time recovery adopts nothing (no run exists) and launches nothing:
		// dispatch stays the scheduler's.
		expect(await runRows(f)).toHaveLength(0);
		const [row] = await f.svc.handle.db.select().from(brainActions);
		expect(row?.status).toBe("accepted");

		const stats = await f.svc.scheduler.tick();
		expect(stats.started).toEqual([task]);
		const rows = await runRows(f);
		expect(rows.map((x) => x.id)).toEqual([runId]);
		expect((await sessions(f)).filter((n) => n.includes(runId))).toHaveLength(
			1,
		);
		await f.until(
			async () =>
				(await f.svc.handle.db.select().from(brainActions))[0]?.status ===
				"applied",
		);
		// and a further pass launches nothing
		expect((await f.svc.scheduler.tick()).started).toEqual([]);
		expect(await runRows(f)).toHaveLength(1);
	}, 120_000);

	test("row 4b: a crash inside the launch, before the run row: one run after recovery", async () => {
		gfx = await groupFixture();
		const f = gfx;
		const task = await f.task("row four b");
		await f.spawn(task);
		armCrash(f, "spawn.before_launch");
		const first = await f.svc.scheduler.tick();
		expect(first.started).toEqual([]);
		expect(first.errors).toBeGreaterThan(0);
		expect(await runRows(f)).toHaveLength(0);

		await f.restart();
		const stats = await f.svc.scheduler.tick();
		expect(stats.started).toEqual([task]);
		expect(await runRows(f)).toHaveLength(1);
	}, 120_000);

	test("row 5: a crash after the launch and before `applied`: recovery adopts the pre-minted run, exactly one run and one tmux session", async () => {
		gfx = await groupFixture();
		const f = gfx;
		await f.control({ slowMs: 4_000 });
		const task = await f.task("row five");
		const r = await f.spawn(task);
		const runId = (r.result?.runIds as string[])[0] as string;
		armCrash(f, "spawn.after_launch");
		await f.svc.scheduler.tick();
		// the effect happened, its record did not
		expect(await runRows(f)).toHaveLength(1);
		expect((await f.svc.handle.db.select().from(brainActions))[0]?.status).toBe(
			"accepted",
		);

		await f.restart();
		// The next admission pass finds nothing left to launch: the pre-minted
		// run is the one that exists (a re-mint would make a second run here).
		await f.svc.scheduler.tick();
		const rows = await runRows(f);
		expect(rows.map((x) => x.id)).toEqual([runId]);
		expect((await sessions(f)).filter((n) => n.includes("mfw_"))).toHaveLength(
			1,
		);
		const [row] = await f.svc.handle.db.select().from(brainActions);
		expect(row?.status).toBe("applied");
		expect((row?.effects as { adopted?: boolean }).adopted).toBe(true);
	}, 120_000);

	test("row 6: a crash between the worker ending and its finalize: it resumes from the journal and finishes once", async () => {
		gfx = await groupFixture();
		const f = gfx;
		const task = await f.task("row six");
		const r = await f.spawn(task);
		const runId = (r.result?.runIds as string[])[0] as string;
		await f.svc.scheduler.tick();
		// the worker ends (it exits on its own); the daemon never saw it
		await f
			.until(
				async () => {
					const out = Bun.spawn(
						[
							"tmux",
							"-L",
							TEST_TMUX_SOCKET,
							"has-session",
							"-t",
							`mfw_${runId}`,
						],
						{ stdout: "ignore", stderr: "ignore" },
					);
					const code = await out.exited;
					return (
						code !== 0 || (await f.svc.registry.get(runId))?.state !== "running"
					);
				},
				{ what: "the worker to exit", timeoutMs: 30_000 },
			)
			.catch(() => {});
		await f.restart();

		await f.until(
			async () =>
				(await f.svc.registry.get(runId))?.state === "completed" ||
				(await f.svc.registry.get(runId))?.state === "merging",
			{ what: "finalize to finish", timeoutMs: 60_000 },
		);
		const steps = await f.svc.registry.steps(runId);
		const names = steps.map((s) => s.step);
		expect(new Set(names).size).toBe(names.length); // each step journaled once
		expect(names).toContain("verify");
		// the fast path enqueued the merge exactly once
		expect(names.filter((n) => n === "enqueue_merge")).toHaveLength(1);
		expect(
			(await f.svc.handle.db.select().from(mergeJobs)).map((j) => j.runId),
		).toEqual([runId]);
		expect(await runRows(f)).toHaveLength(1);
	}, 120_000);

	test("row 11: a second daemon on the same project fails on the kernel lock: one brain owner, one run", async () => {
		gfx = await groupFixture();
		const f = gfx;
		const task = await f.task("row eleven");
		await f.spawn(task);

		const second = await boot({
			projects: [
				{
					name: "grp",
					root: f.root,
					integrationBranch: "main",
					brain: { routes: [{ provider: "claude-cli" }], maxTurnsPerDay: 0 },
				},
			],
			mfwHome: `${f.home}-second`,
			autostart: false,
			log: silentLogger(),
		});
		try {
			// the second process never attached the project: it has no executor
			expect(() => second.get("grp")).toThrow();
		} finally {
			await second.shutdown().catch(() => {});
		}
		// the first still owns the outbox and launches exactly once
		const stats = await f.svc.scheduler.tick();
		expect(stats.started).toEqual([task]);
		expect(await runRows(f)).toHaveLength(1);
		expect(await f.svc.handle.db.select().from(brainActions)).toHaveLength(1);
	}, 120_000);
});
