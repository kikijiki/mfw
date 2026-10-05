import { describe, expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import { EventBus, type StoredEvent } from "@mfw/db/eventlog";
import { ulid } from "@mfw/db/ids";
import { events } from "@mfw/db/schema";
import { eq } from "drizzle-orm";
import { type NewRunSpec, RunRegistry } from "../src/run-registry.ts";

interface Fixture {
	h: ProjectDbHandle;
	dir: string;
	registry: RunRegistry;
	bus: EventBus;
	published: StoredEvent[];
}

async function fresh(): Promise<Fixture> {
	const dir = await mkdtemp(join(tmpdir(), "mfw-runreg-"));
	const h = await openProjectDb(dir);
	const bus = new EventBus();
	const published: StoredEvent[] = [];
	bus.subscribe((e) => published.push(e));
	const registry = new RunRegistry({
		handle: h,
		bus,
		runsDir: join(dir, "runs"),
	});
	return { h, dir, registry, bus, published };
}

async function cleanup(f: Fixture) {
	f.h.close();
	await rm(f.dir, { recursive: true, force: true });
}

const spec = (over: Partial<NewRunSpec> = {}): NewRunSpec => ({
	kind: "task",
	label: "MFW-1 demo run",
	model: "sonnet",
	cwd: "/tmp/wt",
	branch: "mfw/task/MFW-1/x",
	...over,
});

const NO_CAPABILITIES = {
	steer: false,
	verified: false,
	interrupt: false,
	approvals: false,
	plan: false,
	fileChanges: false,
	commandProgress: false,
	mcp: false,
};

describe("RunRegistry.create", () => {
	test("writes the row, run dir, meta.json, and run.started in one motion", async () => {
		const f = await fresh();
		const row = await f.registry.create(spec());
		expect(row.state).toBe("starting");
		expect(row.attempt).toBe(1);
		expect(row.capabilities).toEqual(NO_CAPABILITIES);

		// run dir + write-once meta
		expect((await stat(f.registry.runDir(row.id))).isDirectory()).toBe(true);
		const meta = JSON.parse(
			await readFile(join(f.registry.runDir(row.id), "meta.json"), "utf8"),
		);
		expect(meta.id).toBe(row.id);
		expect(meta.kind).toBe("task");
		expect(meta.branch).toBe("mfw/task/MFW-1/x");
		expect(typeof meta.startedAt).toBe("number");

		// run.started appended in the same tx and fanned out post-commit
		const rows = await f.h.db
			.select()
			.from(events)
			.where(eq(events.runId, row.id));
		expect(rows.map((r) => r.type)).toEqual(["run.started"]);
		expect(rows[0]?.payload).toEqual({
			kind: "task",
			model: "sonnet",
			branch: "mfw/task/MFW-1/x",
		});
		expect(f.published.map((e) => e.type)).toEqual(["run.started"]);

		expect(await f.registry.get(row.id)).toEqual(row);
		expect(await f.registry.get("01NOTAREALRUNIDXXXXXXXXXXX")).toBeNull();
		await cleanup(f);
	});

	test("persists launch identity and normalizes legacy capability JSON", async () => {
		const f = await fresh();
		const row = await f.registry.create(
			spec({
				providerId: "codex-cli",
				reasoningEffort: "high",
				capabilities: {
					steer: true,
					verified: true,
					interrupt: true,
				},
			}),
		);
		expect(row.providerId).toBe("codex-cli");
		expect(row.reasoningEffort).toBe("high");
		expect(row.capabilities).toEqual({
			...NO_CAPABILITIES,
			steer: true,
			verified: true,
			interrupt: true,
		});

		// Simulate a pre-rich-harness row. SQLite's JSON column is text, and old
		// rows legitimately lack every capability added after steer.
		await f.h.client.execute({
			sql: "UPDATE runs SET reasoning_effort = NULL, capabilities = ? WHERE id = ?",
			args: [JSON.stringify({ steer: true, verified: true }), row.id],
		});
		const legacy = await f.registry.get(row.id);
		expect(legacy?.reasoningEffort).toBeNull();
		expect(legacy?.capabilities).toEqual({
			...NO_CAPABILITIES,
			steer: true,
			verified: true,
		});
		await cleanup(f);
	});

	test("list filters by state, kind, and taskId", async () => {
		const f = await fresh();
		const a = await f.registry.create(spec());
		const b = await f.registry.create(spec({ kind: "plan", label: "plan" }));
		await f.registry.transition(b.id, "running");
		expect((await f.registry.list()).length).toBe(2);
		expect(
			(await f.registry.list({ states: ["starting"] })).map((r) => r.id),
		).toEqual([a.id]);
		expect(
			(await f.registry.list({ kinds: ["plan"] })).map((r) => r.id),
		).toEqual([b.id]);
		expect(await f.registry.list({ taskId: "MFW-404" })).toEqual([]);
		await cleanup(f);
	});
});

describe("RunRegistry.transition", () => {
	test("guard mismatch returns null and writes no event", async () => {
		const f = await fresh();
		const row = await f.registry.create(spec());

		const ok = await f.registry.transition(row.id, "running", {
			from: "starting",
		});
		expect(ok?.state).toBe("running");

		const miss = await f.registry.transition(row.id, "ended", {
			from: "starting", // stale expectation, the row is "running" now
		});
		expect(miss).toBeNull();

		const evs = await f.h.db
			.select()
			.from(events)
			.where(eq(events.runId, row.id));
		const changes = evs.filter((e) => e.type === "run.state_changed");
		expect(changes.length).toBe(1); // only the successful transition
		expect(changes[0]?.payload).toMatchObject({
			from: "starting",
			to: "running",
		});
		expect((await f.registry.get(row.id))?.state).toBe("running");
		await cleanup(f);
	});

	test("recordExit and finish set exit facts and finishedAt", async () => {
		const f = await fresh();
		const row = await f.registry.create(spec());
		await f.registry.transition(row.id, "running");
		const ended = await f.registry.recordExit(row.id, {
			exitCode: 0,
			outcome: "completed",
		});
		expect(ended?.state).toBe("ended");
		expect(ended?.exitCode).toBe(0);
		expect(ended?.outcome).toBe("completed");

		await f.registry.setCapabilities(row.id, { steer: true, verified: true });
		expect((await f.registry.get(row.id))?.capabilities).toEqual({
			...NO_CAPABILITIES,
			steer: true,
			verified: true,
		});

		const done = await f.registry.finish(row.id, "completed", "merged");
		expect(done?.state).toBe("completed");
		expect(done?.note).toBe("merged");
		expect(done?.finishedAt).not.toBeNull();
		await cleanup(f);
	});
});

describe("RunRegistry.claimFinalize", () => {
	test("exactly one winner under contention; same boot re-claims; stale owners cleared", async () => {
		const f = await fresh();
		const row = await f.registry.create(spec());

		const boots = ["b1", "b2", "b3", "b4", "b5", "b6"];
		const results = await Promise.all(
			boots.map((b) => f.registry.claimFinalize(row.id, b)),
		);
		expect(results.filter(Boolean).length).toBe(1);
		const winner = boots[results.indexOf(true)] as string;
		expect((await f.registry.get(row.id))?.finalizeOwner).toBe(winner);

		// same bootId re-claims (crash-resume within one process lifetime)
		expect(await f.registry.claimFinalize(row.id, winner)).toBe(true);
		// a different live boot cannot steal it
		expect(await f.registry.claimFinalize(row.id, "intruder")).toBe(false);

		// reboot: the winner's process is dead, reconcile frees its claim
		const freed = await f.registry.clearStaleFinalizeOwners("live-boot");
		expect(freed).toBe(1);
		expect((await f.registry.get(row.id))?.finalizeOwner).toBeNull();
		expect(await f.registry.claimFinalize(row.id, "live-boot")).toBe(true);
		// its own claim is not stale
		expect(await f.registry.clearStaleFinalizeOwners("live-boot")).toBe(0);
		await cleanup(f);
	});
});

describe("RunRegistry journal", () => {
	test("target lifecycle operations are idempotent and persist cleanup/absence facts", async () => {
		const f = await fresh();
		const row = await f.registry.create(
			spec({ targetProjectId: "project-1", targetLeaseRef: "lease-1" }),
		);
		const dispose = {
			runId: row.id,
			operationId: `${row.id}/dispose/intent`,
			phase: "dispose" as const,
			status: "intent" as const,
			lifecycleState: "disposing" as const,
			targetKind: "local",
			targetLeaseRef: "lease-1",
		};
		await f.registry.recordTargetLifecycle(dispose);
		await f.registry.recordTargetLifecycle(dispose);
		await f.registry.recordTargetLifecycle({
			...dispose,
			operationId: `${row.id}/dispose/absent`,
			status: "completed",
			lifecycleState: "absent",
		});
		const current = await f.registry.get(row.id);
		expect(current?.targetCleanupRequestedAt).not.toBeNull();
		expect(current?.targetAbsenceConfirmedAt).not.toBeNull();
		expect((await f.registry.targetJournal(row.id)).length).toBe(3);
		await cleanup(f);
	});

	test("begin/finish/resume semantics", async () => {
		const f = await fresh();
		const row = await f.registry.create(spec());

		const first = await f.registry.beginStep(row.id, "classify");
		expect(first.resumed).toBeNull();
		expect(first.row.status).toBe("running");
		expect(first.row.seq).toBe(1);

		await f.registry.finishStep(row.id, "classify", {
			outcome: "completed",
		});

		// done step short-circuits with its journaled result
		const again = await f.registry.beginStep(row.id, "classify");
		expect(again.resumed).toBe("done");
		expect(again.result).toEqual({ outcome: "completed" });

		// failed step re-runs
		const v1 = await f.registry.beginStep(row.id, "verify");
		expect(v1.row.seq).toBe(2);
		await f.registry.failStep(row.id, "verify", "checks exploded");
		const v2 = await f.registry.beginStep(row.id, "verify");
		expect(v2.resumed).toBe("restarted");
		expect(v2.row.status).toBe("running");
		expect(v2.row.error).toBeNull();

		// a crash mid-step (row left "running") also re-runs
		const s1 = await f.registry.beginStep(row.id, "spawn_repair");
		expect(s1.resumed).toBeNull();
		const s2 = await f.registry.beginStep(row.id, "spawn_repair");
		expect(s2.resumed).toBe("restarted");

		const steps = await f.registry.steps(row.id);
		expect(steps.map((s) => s.step)).toEqual([
			"classify",
			"verify",
			"spawn_repair",
		]);
		expect(steps.map((s) => s.seq)).toEqual([1, 2, 3]);
		await cleanup(f);
	});

	test("journalGuard returns pre-effect key material across a crash", async () => {
		const f = await fresh();
		const row = await f.registry.create(spec());

		await f.registry.beginStep(row.id, "spawn_repair");
		// guarded step journals the child id BEFORE spawning it …
		const childId = ulid();
		await f.registry.finishStep(row.id, "spawn_repair", { childId });
		expect(await f.registry.journalGuard(row.id, "spawn_repair")).toEqual({
			childId,
		});
		// … and an unstarted step has nothing journaled
		expect(await f.registry.journalGuard(row.id, "notify")).toBeNull();
		await cleanup(f);
	});
});

describe("RunRegistry.readOutput", () => {
	test("byte-offset reads of raw.log; missing files read as empty", async () => {
		const f = await fresh();
		const row = await f.registry.create(spec());
		const dir = f.registry.runDir(row.id);
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "raw.log"), "hello world");

		const full = await f.registry.readOutput(row.id, "raw.log");
		expect(full).toEqual({ chunk: "hello world", size: 11, complete: true });

		const tail = await f.registry.readOutput(row.id, "raw.log", 6);
		expect(tail).toEqual({ chunk: "world", size: 11, complete: true });

		// offset at/past EOF: empty chunk, size still reported for the poller
		expect(await f.registry.readOutput(row.id, "raw.log", 11)).toEqual({
			chunk: "",
			size: 11,
			complete: true,
		});
		expect(await f.registry.readOutput(row.id, "raw.log", 99)).toEqual({
			chunk: "",
			size: 11,
			complete: true,
		});

		expect(await f.registry.readOutput(row.id, "events.jsonl")).toEqual({
			chunk: "",
			size: 0,
			complete: true,
		});
		await cleanup(f);
	});

	test("rejects unknown ids before constructing a path", async () => {
		const f = await fresh();
		await expect(
			f.registry.readOutput("../../outside", "raw.log"),
		).rejects.toThrow(/unknown run/);
		await cleanup(f);
	});

	test("caps each output delta and returns a resumable byte cursor", async () => {
		const f = await fresh();
		const row = await f.registry.create(spec());
		const contents = "x".repeat(1024 * 1024 + 17);
		await writeFile(join(f.registry.runDir(row.id), "raw.log"), contents);

		const first = await f.registry.readOutput(row.id, "raw.log");
		expect(first.chunk.length).toBe(1024 * 1024);
		expect(first.size).toBe(1024 * 1024);
		expect(first.complete).toBe(false);
		const second = await f.registry.readOutput(row.id, "raw.log", first.size);
		expect(second).toEqual({
			chunk: "x".repeat(17),
			size: contents.length,
			complete: true,
		});
		await cleanup(f);
	});

	test("a capped events cursor stops on a JSONL boundary", async () => {
		const f = await fresh();
		const row = await f.registry.create(spec());
		const firstLine = `${"a".repeat(600_000)}\n`;
		const secondLine = `${"b".repeat(600_000)}\n`;
		await writeFile(
			join(f.registry.runDir(row.id), "events.jsonl"),
			firstLine + secondLine,
		);

		const first = await f.registry.readOutput(row.id, "events.jsonl");
		expect(first.chunk).toBe(firstLine);
		expect(first.size).toBe(firstLine.length);
		expect(first.complete).toBe(false);
		const second = await f.registry.readOutput(
			row.id,
			"events.jsonl",
			first.size,
		);
		expect(second.chunk).toBe(secondLine);
		expect(second.complete).toBe(true);
		await cleanup(f);
	});
});
