import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBoardConfig } from "@mfw/board-core";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import { EventBus, type StoredEvent } from "@mfw/db/eventlog";
import { ulid } from "@mfw/db/ids";
import { silentLogger } from "../src/log.ts";
import {
	ConflictError,
	DraftStatusError,
	HumanInProgressError,
	MalformedTaskFileError,
	TaskClaimedError,
	TaskService,
} from "../src/task-service.ts";
import type { DefinitionOfDone } from "../src/tasks/types.ts";
import { makeTasks } from "./fixtures/board.ts";

interface Env {
	dir: string;
	handle: ProjectDbHandle;
	bus: EventBus;
	svc: TaskService;
	seen: StoredEvent[];
}

const envs: Env[] = [];

async function freshEnv(mergeChecks?: DefinitionOfDone | null): Promise<Env> {
	const dir = await mkdtemp(join(tmpdir(), "mfw-v2-svc-"));
	const handle = await openProjectDb(dir);
	const bus = new EventBus();
	const seen: StoredEvent[] = [];
	bus.subscribe((e) => seen.push(e));
	const svc = await makeTasks(handle, bus, dir, "MFW", mergeChecks);
	const env = { dir, handle, bus, svc, seen };
	envs.push(env);
	return env;
}

const DOD = {
	verifier: "deterministic" as const,
	checks: [{ run: "bun test", expect_exit: 0 }],
};

afterEach(async () => {
	for (const env of envs.splice(0)) {
		env.handle.close();
		await rm(env.dir, { recursive: true, force: true });
	}
});

describe("create", () => {
	test("allocates sequential ids, stores deps + criteria, emits task.created", async () => {
		const { svc, seen } = await freshEnv();
		const a = await svc.create({ title: "first" });
		const b = await svc.create({
			title: "second",
			dependsOn: [a.id],
			criteria: [{ text: "does the thing" }, { text: "tested", checked: true }],
			labels: ["x"],
			priority: "high",
		});
		expect(a.id).toBe("MFW-1");
		expect(b.id).toBe("MFW-2");
		expect(b.status).toBe("backlog");
		expect(b.contentRev).toBe(1);

		const got = await svc.get(b.id);
		expect(got?.dependsOn).toEqual([a.id]);
		expect(got?.criteria).toEqual([
			{ text: "does the thing", checked: false },
			{ text: "tested", checked: true },
		]);
		expect(seen.map((e) => e.type)).toEqual(["task.created", "task.created"]);
	});

	test("rejects a dependency cycle (self-dep via edit, two-node loop)", async () => {
		const { svc } = await freshEnv();
		const a = await svc.create({ title: "a" });
		const b = await svc.create({ title: "b", dependsOn: [a.id] });
		await expect(svc.edit(a.id, { dependsOn: [b.id] })).rejects.toThrow(
			/cycle/,
		);
		await expect(svc.edit(a.id, { dependsOn: [a.id] })).rejects.toThrow(
			/cycle/,
		);
		// nothing committed: a's deps unchanged, rev unchanged
		const got = await svc.get(a.id);
		expect(got?.dependsOn).toEqual([]);
		expect(got?.contentRev).toBe(1);
	});

	test("concurrent reciprocal edits commit at most one edge", async () => {
		const { svc, handle, bus, dir } = await freshEnv();
		const a = await svc.create({ title: "a" });
		const b = await svc.create({ title: "b" });
		const peer = new TaskService({
			handle,
			bus,
			mfwDir: dir,
			config: await loadBoardConfig(`${dir}/board.yaml`),
			taskKey: "MFW",
			log: silentLogger(),
		});
		await peer.load();

		// Both stores start from the same acyclic snapshot; the board lock plus locked disk
		// snapshot must make the second writer see the first despite its stale in-memory index.
		const results = await Promise.allSettled([
			svc.edit(a.id, { dependsOn: [b.id] }),
			peer.edit(b.id, { dependsOn: [a.id] }),
		]);

		expect(
			results.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		const rejected = results.find((result) => result.status === "rejected");
		expect(rejected).toMatchObject({ status: "rejected" });
		if (rejected?.status === "rejected") {
			expect(String(rejected.reason)).toMatch(/cycle/);
		}
		await svc.refresh();
		const [afterA, afterB] = await Promise.all([svc.get(a.id), svc.get(b.id)]);
		expect(
			afterA?.dependsOn.includes(b.id) && afterB?.dependsOn.includes(a.id),
		).toBe(false);
	});

	test("concurrent reciprocal creates commit at most one task", async () => {
		const { svc } = await freshEnv();
		const results = await Promise.allSettled([
			svc.create({ id: "MFW-20", title: "a", dependsOn: ["MFW-21"] }),
			svc.create({ id: "MFW-21", title: "b", dependsOn: ["MFW-20"] }),
		]);

		expect(
			results.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		const rejected = results.find((result) => result.status === "rejected");
		if (rejected?.status === "rejected") {
			expect(String(rejected.reason)).toMatch(/cycle/);
		} else {
			throw new Error("expected one reciprocal create to be rejected");
		}
		expect((await svc.list()).map((task) => task.id)).toHaveLength(1);
	});
});

describe("edit", () => {
	test("bumps contentRev, records fields, replaces criteria/deps", async () => {
		const { svc, seen } = await freshEnv();
		const a = await svc.create({ title: "a" });
		const t = await svc.create({
			title: "t",
			criteria: [{ text: "old" }],
		});
		const out = await svc.edit(t.id, {
			title: "t2",
			dependsOn: [a.id],
			criteria: [{ text: "new", checked: true }],
			dod: DOD,
		});
		expect(out.contentRev).toBe(2);
		expect(out.dependsOn).toEqual([a.id]);
		expect(out.criteria).toEqual([{ text: "new", checked: true }]);
		const edited = seen.find((e) => e.type === "task.edited");
		expect(edited?.payload).toMatchObject({ source: "api", rev: 2 });
		expect((edited?.payload as { fields: string[] }).fields.sort()).toEqual([
			"criteria",
			"depends_on",
			"title",
			"verification",
		]);
	});

	test("no-op patch does not bump the rev or emit events", async () => {
		const { svc, seen } = await freshEnv();
		const t = await svc.create({ title: "t", body: "b" });
		const before = seen.length;
		const out = await svc.edit(t.id, { title: "t", body: "b" });
		expect(out.contentRev).toBe(1);
		expect(seen.length).toBe(before);
	});

	test("stale baseRev throws ConflictError carrying the current row", async () => {
		const { svc } = await freshEnv();
		const t = await svc.create({ title: "t" });
		await svc.edit(t.id, { title: "t2" }, { baseRev: 1 }); // rev → 2
		try {
			await svc.edit(t.id, { title: "t3" }, { baseRev: 1 });
			throw new Error("expected ConflictError");
		} catch (e) {
			expect(e).toBeInstanceOf(ConflictError);
			expect((e as ConflictError).current.contentRev).toBe(2);
			expect((e as ConflictError).current.title).toBe("t2");
		}
		// the conflicting edit did not commit
		expect((await svc.get(t.id))?.title).toBe("t2");
	});

	test("a hand edit that keeps `rev:` unchanged still fails a same baseRev save (MFW-hand-edit-race)", async () => {
		// baseRev is checked against the rev re-read under the lock, not a cached row.
		// `edit()` never calls `load`/`refresh` (it goes `store.update()` → `reread()`), so a
		// hand edit made between polls, which no editor bumps `rev` for, must still be caught.
		const { svc } = await freshEnv();
		const t = await svc.create({ title: "original title" });
		const path = svc.store.get(t.id)?.path;
		if (!path) throw new Error("task path missing");
		const raw = await readFile(path, "utf8");
		// A human edits the file directly and does not bump `rev:`.
		await writeFile(path, raw.replace("original title", "hand-edited title"));

		// No refresh()/load() in between: this save races the hand edit.
		await expect(
			svc.edit(t.id, { title: "UI overwrite" }, { baseRev: t.contentRev }),
		).rejects.toThrow(/was modified/);

		// The hand edit must survive the save that still saw rev 1.
		const after = await svc.get(t.id);
		expect(after?.title).toBe("hand-edited title");
	});

	test("malformed on-disk bytes block mutations until the file is repaired", async () => {
		const { svc } = await freshEnv();
		const task = await svc.create({ title: "repair me", status: "ready" });
		const path = svc.store.get(task.id)?.path;
		if (!path) throw new Error("task path missing");
		const good = await readFile(path, "utf8");
		const malformed = `---\nid: ${task.id}\ntitle: [unterminated\n---\n\nkeep these exact bytes\n`;
		await writeFile(path, malformed);

		for (const mutate of [
			() => svc.edit(task.id, { title: "overwritten" }),
			() => svc.move(task.id, "backlog", "human"),
			() => svc.tryClaim(task.id, ulid(), 60_000),
			() => svc.remove(task.id),
		]) {
			try {
				await mutate();
				throw new Error("expected malformed task mutation to fail");
			} catch (error) {
				expect(error).toBeInstanceOf(MalformedTaskFileError);
				expect(error).toMatchObject({ id: task.id, path });
				expect((error as Error).message).toContain("Repair the task file");
			}
			expect(await readFile(path, "utf8")).toBe(malformed);
		}

		await writeFile(path, good);
		const recovered = await svc.edit(task.id, { title: "repaired" });
		expect(recovered.title).toBe("repaired");
	});
});

describe("claim / release / lease", () => {
	test("tryClaim admits exactly one winner under concurrency", async () => {
		const { svc, seen } = await freshEnv();
		const t = await svc.create({ title: "t", status: "ready" });
		const runs = Array.from({ length: 8 }, () => ulid());
		const results = await Promise.all(
			runs.map((runId) => svc.tryClaim(t.id, runId, 60_000)),
		);
		expect(results.filter(Boolean).length).toBe(1);
		const row = await svc.get(t.id);
		expect(row?.status).toBe("in_progress");
		expect(runs).toContain(row?.claimedByRunId ?? "");
		expect(seen.filter((e) => e.type === "task.claimed").length).toBe(1);
	});

	test("tryClaim defaults the status_changed actor to scheduler, but a caller can name itself (MFW-35)", async () => {
		const { svc, seen } = await freshEnv();
		const t = await svc.create({ title: "t", status: "ready" });
		expect(await svc.tryClaim(t.id, ulid(), 60_000)).toBe(true);
		const defaulted = seen.find((e) => e.type === "task.status_changed");
		expect((defaulted?.payload as { actor?: string } | undefined)?.actor).toBe(
			"scheduler",
		);

		const t2 = await svc.create({ title: "t2", status: "ready" });
		seen.length = 0;
		expect(await svc.tryClaim(t2.id, ulid(), 60_000, "human")).toBe(true);
		const named = seen.find((e) => e.type === "task.status_changed");
		expect((named?.payload as { actor?: string } | undefined)?.actor).toBe(
			"human",
		);
	});

	test("release clears the lease and is idempotent", async () => {
		const { svc, seen } = await freshEnv();
		const t = await svc.create({ title: "t", status: "ready" });
		const runId = ulid();
		expect(await svc.tryClaim(t.id, runId, 60_000)).toBe(true);
		const released = await svc.release(t.id, runId, "ready", "scheduler");
		expect(released?.status).toBe("ready");
		expect(released?.claimedByRunId).toBeNull();
		expect(released?.leaseExpiresAt).toBeNull();
		const statusEvents = () =>
			seen.filter((e) => e.type === "task.status_changed").length;
		const releaseEvents = () =>
			seen.filter((e) => e.type === "task.claim_released").length;
		expect(releaseEvents()).toBe(1);
		const before = statusEvents();
		const releasesBefore = releaseEvents();
		// Releasing again with the same runId changes nothing and emits nothing (already
		// unclaimed and in `ready`). It is not refused: an unclaimed task has no owner to
		// protect. Only a claim held by a different run refuses (next test).
		const again = await svc.release(t.id, runId, "ready", "scheduler");
		expect(again?.status).toBe("ready");
		expect(again?.claimedByRunId).toBeNull();
		expect(statusEvents()).toBe(before);
		expect(releaseEvents()).toBe(releasesBefore);
	});

	test("a Draft-to-Draft release emits claim observability without a fake status change", async () => {
		const { svc, seen } = await freshEnv();
		const draft = await svc.captureQuick("expand me");
		const runId = ulid();
		expect(await svc.tryClaimDraftExpansion(draft.id, runId, 60_000)).toBe(
			true,
		);
		seen.length = 0;

		await svc.release(draft.id, runId, "draft", "boot", "claiming run is gone");

		expect(seen.map((event) => event.type)).toEqual(["task.claim_released"]);
		const released = seen[0];
		expect(released?.payload).toEqual({
			runId,
			purpose: "draft_expansion",
			reason: "claiming run is gone",
		});
	});

	test("release no-ops instead of clobbering a claim reassigned to another run", async () => {
		// A stale release decision (orphan sweep) must not drop the claim of a run the lease
		// was since moved to (`moveLease`), nor move the file to `ready`.
		const { svc, seen } = await freshEnv();
		const t = await svc.create({ title: "t", status: "ready" });
		const staleRunId = ulid();
		const newRunId = ulid();
		expect(await svc.tryClaim(t.id, staleRunId, 60_000)).toBe(true);
		await svc.moveLease(t.id, newRunId);
		const statusEvents = () =>
			seen.filter((e) => e.type === "task.status_changed").length;
		const before = statusEvents();
		const result = await svc.release(
			t.id,
			staleRunId,
			"ready",
			"boot",
			"claiming run is gone",
		);
		expect(result).toBeNull();
		expect(statusEvents()).toBe(before);
		const row = await svc.get(t.id);
		expect(row?.status).toBe("in_progress");
		expect(row?.claimedByRunId).toBe(newRunId);
	});

	/**
	 * Approve-a-review path: a task in `review` has had its claim dropped by the
	 * finalize machine, so `onMerged` calls `release(taskId, job.runId, "done", …)`
	 * with `claimedByRunId` null. That must succeed; an exact-match CAS returned null
	 * silently and left merged tasks in `review`. Only a claim held by a different run conflicts.
	 */
	test("release() moves an UNCLAIMED task: an approved review still lands in done", async () => {
		const { svc, seen } = await freshEnv();
		const t = await svc.create({ title: "t", status: "ready" });
		const runId = ulid();
		expect(await svc.tryClaim(t.id, runId, 60_000)).toBe(true);
		// The critic gate: released to review, claim dropped.
		await svc.release(t.id, runId, "review", "scheduler", "critic gate");
		expect((await svc.get(t.id))?.claimedByRunId).toBeNull();

		const before = seen.filter((e) => e.type === "task.status_changed").length;
		const done = await svc.release(t.id, runId, "done", "scheduler", "merged");

		expect(done).not.toBeNull();
		expect((await svc.get(t.id))?.status).toBe("done");
		expect(seen.filter((e) => e.type === "task.status_changed").length).toBe(
			before + 1,
		);
	});

	test("reclaimForRetry restores a claim release() cleared, so a second release() by that runId succeeds again (MFW-51)", async () => {
		// A parked merge job's retry needs this: onParked already released the claim, and the
		// retry's outcome is reported through another `release(taskId, runId, ...)` gated on that runId.
		const { svc, seen } = await freshEnv();
		const t = await svc.create({ title: "t", status: "ready" });
		const runId = ulid();
		await svc.tryClaim(t.id, runId, 60_000);
		await svc.release(t.id, runId, "blocked", "scheduler", "merge parked");
		expect((await svc.get(t.id))?.claimedByRunId).toBeNull();

		await svc.reclaimForRetry(t.id, runId);
		const reclaimed = await svc.get(t.id);
		expect(reclaimed?.claimedByRunId).toBe(runId);
		expect(reclaimed?.leaseExpiresAt).toBeNull();
		// Reclaiming is neither a status change nor an audited event.
		expect(seen.filter((e) => e.type === "task.status_changed").length).toBe(
			2, // ready -> in_progress (claim), in_progress -> blocked (release)
		);

		const released = await svc.release(
			t.id,
			runId,
			"done",
			"scheduler",
			"merged",
		);
		expect(released?.status).toBe("done");
		expect(released?.claimedByRunId).toBeNull();
	});

	test("release() on a task that no longer exists is a no-op, not a throw", async () => {
		// A finalize step releases from an earlier snapshot; if the task was deleted since
		// (by a human or a scan noticing `rm`), release is a no-op, not an `unknown task` error.
		const { svc } = await freshEnv();
		const t = await svc.create({ title: "t", status: "ready" });
		const runId = ulid();
		// A negative lease is already expired, so `isClaimLive` does not block `remove()`
		// (like a lapsed lease `groom` has not reclaimed yet).
		await svc.tryClaim(t.id, runId, -1_000);
		await svc.remove(t.id);
		expect(await svc.get(t.id)).toBeNull();

		const result = await svc.release(
			t.id,
			runId,
			"ready",
			"scheduler",
			"draft expansion completed",
		);
		expect(result).toBeNull();
	});

	test("release() refuses to move an ARCHIVED task anywhere else, no resurrection", async () => {
		// `groom` can release a draft's expansion claim while the run is still in its finalize
		// journal, and a human can then archive the draft. When the stale run reaches its
		// `release` (draft_expand_failed, or a questions release_task), the task is unclaimed,
		// which release() lets through unconditionally; without this guard it would move the
		// archived task back to `draft`.
		const { svc, seen } = await freshEnv();
		const draft = await svc.captureQuick("do the thing");
		const runId = ulid();
		expect(await svc.tryClaimDraftExpansion(draft.id, runId, 60_000)).toBe(
			true,
		);
		// Simulate `groom` reclaiming an orphaned claim (run died) before its finalize journal releases.
		await svc.release(
			draft.id,
			runId,
			"draft",
			"boot",
			"draft expansion run is no longer active",
		);
		expect((await svc.get(draft.id))?.claimedByRunId).toBeNull();

		const archived = await svc.release(
			draft.id,
			null,
			"archived",
			"human",
			"archived while awaiting clarification answers",
		);
		expect(archived?.status).toBe("archived");

		seen.length = 0;
		// The stale run's finalize still calls release() with its runId on a task now unclaimed and archived.
		const stale = await svc.release(
			draft.id,
			runId,
			"draft",
			"brain",
			"draft expansion will retry",
		);
		expect(stale).toBeNull();
		const after = await svc.get(draft.id);
		expect(after?.status).toBe("archived");
		expect(seen.filter((e) => e.type === "task.status_changed")).toHaveLength(
			0,
		);
	});

	test("reclaimForRetry no-ops when the task is already claimed by someone else", async () => {
		const { svc } = await freshEnv();
		const t = await svc.create({ title: "t", status: "ready" });
		const liveRunId = ulid();
		await svc.tryClaim(t.id, liveRunId, 60_000);
		await svc.reclaimForRetry(t.id, ulid());
		expect((await svc.get(t.id))?.claimedByRunId).toBe(liveRunId);
	});

	test("renewLease extends only the claimer's lease", async () => {
		const { svc } = await freshEnv();
		const t = await svc.create({ title: "t", status: "ready" });
		const runId = ulid();
		await svc.tryClaim(t.id, runId, 1_000);
		const before = (await svc.get(t.id))?.leaseExpiresAt?.getTime() ?? 0;
		expect(await svc.renewLease(runId, 120_000)).toBe(true);
		const after = (await svc.get(t.id))?.leaseExpiresAt?.getTime() ?? 0;
		expect(after).toBeGreaterThan(before);
		expect(await svc.renewLease(ulid(), 120_000)).toBe(false);
	});

	test("expireStaleLeases releases to ready with task.lease_expired", async () => {
		const { svc, seen } = await freshEnv();
		const t = await svc.create({ title: "t", status: "ready" });
		const runId = ulid();
		await svc.tryClaim(t.id, runId, 50);
		expect(await svc.expireStaleLeases(Date.now() + 60_000)).toEqual([t.id]);
		const row = await svc.get(t.id);
		expect(row?.status).toBe("ready");
		expect(row?.claimedByRunId).toBeNull();
		const expired = seen.find((e) => e.type === "task.lease_expired");
		expect(expired?.payload).toEqual({ runId });
		// nothing left to expire
		expect(await svc.expireStaleLeases(Date.now() + 60_000)).toEqual([]);
	});

	test("an expired lease on a finished or blocked task is cleared, status untouched", async () => {
		const { svc, seen } = await freshEnv();
		for (const status of ["done", "blocked"] as const) {
			const t = await svc.create({ title: status, status: "ready" });
			const runId = ulid();
			await svc.tryClaim(t.id, runId, 50);
			// a CLI-style transition: status moves on, the lease binding stays
			await svc.move(t.id, status, "verifier");
			expect((await svc.get(t.id))?.claimedByRunId).toBe(runId);
			expect(await svc.expireStaleLeases(Date.now() + 60_000)).toEqual([t.id]);
			const row = await svc.get(t.id);
			expect(row?.status).toBe(status);
			expect(row?.claimedByRunId).toBeNull();
			expect(
				seen.some(
					(e) =>
						e.type === "task.status_changed" &&
						e.taskId === t.id &&
						(e.payload as { actor?: string }).actor === "watchdog",
				),
			).toBe(false);
		}
	});

	test("an expired draft-expansion claim returns to draft", async () => {
		const { svc } = await freshEnv();
		const task = await svc.create({ title: "raw capture", status: "draft" });
		expect(await svc.tryClaimDraftExpansion(task.id, "expand-1", 1)).toBe(true);

		expect(await svc.expireStaleLeases(Date.now() + 60_000)).toEqual([task.id]);
		const after = await svc.get(task.id);
		expect(after?.status).toBe("draft");
		expect(after?.draftPhase).toBe("queued");
		expect(after?.claimedByRunId).toBeNull();
	});
});

describe("DoR promotion + ready set", () => {
	test("promoteReady gates on specification and done deps, not checks", async () => {
		const { svc } = await freshEnv();
		const withDod = await svc.create({
			title: "has dod",
			body: "goal",
			dod: DOD,
		});
		const noDod = await svc.create({ title: "no dod", body: "goal" });
		const gated = await svc.create({
			title: "gated",
			body: "goal",
			dod: DOD,
			dependsOn: [withDod.id],
		});

		expect(new Set(await svc.promoteReady())).toEqual(
			new Set([withDod.id, noDod.id]),
		);
		expect((await svc.get(noDod.id))?.status).toBe("ready");
		expect((await svc.get(gated.id))?.status).toBe("backlog");

		await svc.move(withDod.id, "done", "verifier");
		expect(await svc.promoteReady()).toEqual([gated.id]);
	});

	test("an explicit backlog choice survives automatic readiness sweeps", async () => {
		const { svc } = await freshEnv();
		const held = await svc.create({
			title: "not yet",
			body: "Specified, but deliberately held.",
			status: "backlog",
			readyMode: "manual",
		});
		expect(held.readyMode).toBe("manual");
		expect(await svc.promoteReady()).toEqual([]);
		expect((await svc.get(held.id))?.status).toBe("backlog");

		const ready = await svc.move(held.id, "ready", "human");
		expect(ready.status).toBe("ready");
		expect(ready.readyMode).toBe("automatic");
	});

	test("project merge checks always apply and task checks only augment them", async () => {
		const { svc } = await freshEnv(DOD);
		const noDod = await svc.create({
			title: "quick-captured, no dod",
			body: "goal",
		});
		const own = await svc.create({
			title: "carries its own",
			body: "goal",
			dod: {
				verifier: "deterministic",
				checks: [{ run: "lint", expect_exit: 0 }],
			},
		});

		expect(new Set(await svc.promoteReady())).toEqual(
			new Set([noDod.id, own.id]),
		);
		// The file itself is untouched: the default is resolved, never written.
		expect((await svc.get(noDod.id))?.dod).toBeNull();
		expect(svc.effectiveVerification(null)).toEqual(DOD);
		const ownDod = (await svc.get(own.id))?.dod ?? null;
		expect(ownDod).not.toBeNull();
		expect(svc.effectiveVerification(ownDod)).toEqual({
			verifier: "deterministic",
			checks: [...DOD.checks, ...(ownDod?.checks ?? [])],
		});
	});

	test("readySet excludes ready tasks with unfinished deps", async () => {
		const { svc } = await freshEnv();
		const dep = await svc.create({ title: "dep" });
		const free = await svc.create({ title: "free", status: "ready" });
		const held = await svc.create({
			title: "held",
			status: "ready",
			dependsOn: [dep.id],
		});
		expect((await svc.readySet()).map((t) => t.id)).toEqual([free.id]);
		await svc.move(dep.id, "done", "verifier");
		expect((await svc.readySet()).map((t) => t.id)).toEqual([free.id, held.id]);
	});

	test("final claim refuses a task blocked after a stale ready scan", async () => {
		const { svc } = await freshEnv();
		const dependency = await svc.create({
			title: "dependency",
			status: "done",
		});
		const task = await svc.create({
			title: "candidate",
			status: "ready",
			dependsOn: [dependency.id],
		});

		expect((await svc.readySet()).map((row) => row.id)).toContain(task.id);
		await svc.move(dependency.id, "backlog", "verifier");

		expect(await svc.tryClaim(task.id, ulid(), 60_000)).toBe(false);
		expect((await svc.get(task.id))?.status).toBe("ready");
	});

	test("readySet excludes a ready task stuck holding a live claim", async () => {
		// A task can be `ready` with a non-null `claimedByRunId` if moved without `release`
		// (`move` leaves the claim). `TaskStore.claim` refuses it, so the scheduler must skip
		// it or hot-loop until the lease expires.
		const { svc } = await freshEnv();
		const free = await svc.create({ title: "free", status: "ready" });
		const stuck = await svc.create({ title: "stuck", status: "ready" });
		expect(await svc.tryClaim(stuck.id, ulid(), 60_000)).toBe(true);
		// Humans are refused this move; use a non-human actor (disk reconciliation is exempt).
		await svc.move(stuck.id, "ready", "boot");
		expect((await svc.get(stuck.id))?.claimedByRunId).not.toBeNull();
		expect((await svc.readySet()).map((t) => t.id)).toEqual([free.id]);
	});
});

describe("MFW-49: draft capture + expansion", () => {
	test("captureQuick files a draft instantly, title truncated, raw text preserved", async () => {
		const { svc } = await freshEnv();
		const long = `${"x".repeat(90)} rest of the line`;
		const t = await svc.captureQuick(`  ${long}\nsecond line  `);
		expect(t.status).toBe("draft");
		expect(t.draftPhase).toBe("queued");
		expect(t.draftPrompt).toBe(`${long}\nsecond line`);
		expect(t.body).toBe(`${long}\nsecond line`);
		expect(t.title.length).toBeLessThanOrEqual(80);
		expect(t.title.endsWith("…")).toBe(true);
		expect(t.afterExpansion).toBe("ready");
		expect(t.requireReview).toBe(false);
		expect(t.dod).toBeNull();
	});

	test("captureQuick persists its post-expansion status and review choices", async () => {
		const { svc } = await freshEnv();
		const held = await svc.captureQuick(
			"do this later",
			"capture-held",
			"backlog",
			true,
		);
		expect(held.status).toBe("draft");
		expect(held.afterExpansion).toBe("backlog");
		expect(held.readyMode).toBe("manual");
		expect(held.requireReview).toBe(true);
	});

	test("captureQuick rejects empty text", async () => {
		const { svc } = await freshEnv();
		await expect(svc.captureQuick("   ")).rejects.toThrow(/empty/);
	});

	test("captureQuick wakes the expansion worker after persistence", async () => {
		const { svc } = await freshEnv();
		let observed: string[] = [];
		svc.onDraftCaptured = () => {
			observed = svc.store
				.list()
				.filter((task) => task.status === "draft")
				.map((task) => task.id);
		};
		const task = await svc.captureQuick("wake immediately");
		expect(observed).toEqual([task.id]);
	});

	test("captureQuick is idempotent for a mobile retry request id", async () => {
		const { svc } = await freshEnv();
		const first = await svc.captureQuick("do the thing", "capture-123");
		const retry = await svc.captureQuick("do the thing", "capture-123");
		expect(retry.id).toBe(first.id);
		expect(
			(await svc.list()).filter((task) => task.status === "draft"),
		).toHaveLength(1);
	});

	test("an expansion claim makes draft work visible and protects it from mutation", async () => {
		const { svc, seen } = await freshEnv();
		const draft = await svc.captureQuick("do the thing");
		expect(
			await svc.tryClaimDraftExpansion(draft.id, "expand-run", 60_000),
		).toBe(true);
		expect((await svc.get(draft.id))?.claimedByRunId).toBe("expand-run");
		expect((await svc.get(draft.id))?.status).toBe("draft");
		expect((await svc.get(draft.id))?.draftPhase).toBe("expanding");
		expect(
			await svc.tryClaimDraftExpansion(draft.id, "expand-run", 120_000),
		).toBe(true);
		expect(
			await svc.tryClaimDraftExpansion(draft.id, "another-run", 120_000),
		).toBe(false);
		expect(seen.filter((event) => event.type === "task.claimed")).toHaveLength(
			1,
		);
		await expect(
			svc.edit(draft.id, { body: "changed underneath it" }, { source: "api" }),
		).rejects.toBeInstanceOf(TaskClaimedError);
		await expect(
			svc.move(draft.id, "archived", "human"),
		).rejects.toBeInstanceOf(TaskClaimedError);
		await expect(svc.remove(draft.id)).rejects.toBeInstanceOf(TaskClaimedError);
		await svc.release(
			draft.id,
			"expand-run",
			"backlog",
			"brain",
			"expansion complete",
		);
		expect((await svc.get(draft.id))?.claimedByRunId).toBeNull();
	});

	test("queued draft edits refresh the expansion prompt and status stays safe", async () => {
		const { svc } = await freshEnv();
		const draft = await svc.captureQuick("original prompt");
		await svc.recordDraftExpandFailure(draft.id, 3);
		const edited = await svc.edit(
			draft.id,
			{ body: "corrected prompt" },
			{ source: "api" },
		);
		expect(edited.draftPrompt).toBe("corrected prompt");
		expect(edited.draftAttempts).toBe(0);
		await expect(svc.move(draft.id, "ready", "human")).rejects.toBeInstanceOf(
			DraftStatusError,
		);
		expect((await svc.move(draft.id, "archived", "human")).status).toBe(
			"archived",
		);
	});

	test("promoteReady never promotes a draft, DoD or not", async () => {
		const { svc } = await freshEnv();
		const draft = await svc.captureQuick("do the thing");
		await svc.edit(draft.id, { dod: DOD });
		expect(await svc.promoteReady()).toEqual([]);
		expect((await svc.get(draft.id))?.status).toBe("draft");
	});

	test("readySet excludes draft workflow state", async () => {
		const { svc } = await freshEnv();
		const draft = await svc.create({
			title: "sneaky",
			status: "draft",
		});
		expect((await svc.readySet()).map((t) => t.id)).not.toContain(draft.id);
	});

	test("recordDraftExpandFailure counts up, then marks the draft failed", async () => {
		const { svc } = await freshEnv();
		const draft = await svc.captureQuick("do the thing");
		const fallback = {
			verifier: "deterministic" as const,
			checks: [{ diff_against_base: true }],
		};

		expect(await svc.recordDraftExpandFailure(draft.id, 3, fallback)).toEqual({
			exhausted: false,
			attempts: 1,
		});
		expect((await svc.get(draft.id))?.draftPhase).toBe("retrying");

		expect(await svc.recordDraftExpandFailure(draft.id, 3, fallback)).toEqual({
			exhausted: false,
			attempts: 2,
		});
		expect(await svc.recordDraftExpandFailure(draft.id, 3, fallback)).toEqual({
			exhausted: true,
			attempts: 3,
		});

		const got = await svc.get(draft.id);
		expect(got?.status).toBe("draft");
		expect(got?.draftPhase).toBe("failed");
		expect(got?.verification).toBeNull();
	});

	test("recordDraftExpandFailure never overwrites a DoD the task already has", async () => {
		const { svc } = await freshEnv();
		const draft = await svc.captureQuick("do the thing");
		await svc.edit(draft.id, { dod: DOD });
		const fallback = {
			verifier: "deterministic" as const,
			checks: [{ diff_against_base: true }],
		};
		await svc.recordDraftExpandFailure(draft.id, 1, fallback);
		expect((await svc.get(draft.id))?.dod).toEqual(DOD);
	});

	test("recordDraftExpandFailure is a no-op for a task that is not a draft", async () => {
		const { svc } = await freshEnv();
		const t = await svc.create({ title: "not a draft" });
		expect(await svc.recordDraftExpandFailure(t.id, 3, DOD)).toBeNull();
	});

	test("applyDraftExpansion edits the SAME task in place and clears draft", async () => {
		const { svc, seen } = await freshEnv();
		const draft = await svc.captureQuick("build the thing");
		const before = draft.id;
		const fallback = {
			verifier: "deterministic" as const,
			checks: [{ diff_against_base: true }],
		};

		const got = await svc.applyDraftExpansion(
			draft.id,
			{
				title: "Build the thing properly",
				body: "A fleshed-out description.",
				dod: DOD,
				criteria: [{ text: "it works" }],
				owns: ["src/only/**"],
				modelTier: "strong",
			},
			fallback,
		);

		expect(got.id).toBe(before); // same task, not a new one
		expect(got.status).toBe("draft");
		expect(got.title).toBe("Build the thing properly");
		expect(got.owns).toEqual(["src/only/**"]);
		expect(got.modelTier).toBe("strong");
		expect(got.body).toBe("A fleshed-out description.");
		expect(got.dod).toEqual(DOD);
		expect(got.criteria).toEqual([{ text: "it works", checked: false }]);
		// draftPrompt survives: a bad expansion must stay diagnosable.
		expect(got.draftPrompt).toBe("build the thing");
		expect(seen.some((e) => e.type === "task.edited")).toBe(true);
	});

	test("draft expansion preserves explicit human ownership and model tier", async () => {
		const { svc } = await freshEnv();
		const draft = await svc.captureQuick("build the thing");
		await svc.edit(draft.id, { owns: ["src/human/**"], modelTier: "light" });
		const got = await svc.applyDraftExpansion(draft.id, {
			title: "Expanded",
			body: "Specified",
			owns: ["src/planner/**"],
			modelTier: "strong",
		});
		expect(got.owns).toEqual(["src/human/**"]);
		expect(got.modelTier).toBe("light");
	});

	test("applyDraftExpansion leaves task checks empty when the entry gave none", async () => {
		const { svc } = await freshEnv();
		const draft = await svc.captureQuick("build the thing");
		const fallback = {
			verifier: "deterministic" as const,
			checks: [{ diff_against_base: true }],
		};
		const got = await svc.applyDraftExpansion(
			draft.id,
			{ title: "Build the thing", dod: null },
			fallback,
		);
		expect(got.verification).toBeNull();
	});

	test("editing a failed draft prompt resets its retry budget", async () => {
		const { svc } = await freshEnv();
		const draft = await svc.captureQuick("do the thing");
		let wakes = 0;
		svc.onDraftCaptured = () => {
			wakes++;
		};
		const fallback = {
			verifier: "deterministic" as const,
			checks: [{ diff_against_base: true }],
		};
		await svc.recordDraftExpandFailure(draft.id, 5, fallback);
		await svc.recordDraftExpandFailure(draft.id, 5, fallback);
		expect((await svc.get(draft.id))?.draftAttempts).toBe(2);

		await svc.edit(draft.id, { body: "do the corrected thing" });
		expect((await svc.get(draft.id))?.draftAttempts).toBe(0);
		expect((await svc.get(draft.id))?.draftPhase).toBe("queued");
		expect(wakes).toBe(1);
	});
});

describe("move", () => {
	test("a human cannot manufacture In progress without a run claim", async () => {
		const { svc, seen } = await freshEnv();
		const task = await svc.create({ title: "ordinary", status: "ready" });
		const before = seen.length;

		await expect(
			svc.move(task.id, "in_progress", "human"),
		).rejects.toBeInstanceOf(HumanInProgressError);
		expect((await svc.get(task.id))?.status).toBe("ready");
		expect((await svc.get(task.id))?.claimedByRunId).toBeNull();
		expect(seen.length).toBe(before);
	});

	test("Draft can only be entered through capture", async () => {
		const { svc } = await freshEnv();
		const task = await svc.create({ title: "ordinary" });
		await expect(svc.move(task.id, "draft", "human")).rejects.toBeInstanceOf(
			DraftStatusError,
		);
	});

	test("status transition emits task.status_changed with actor + reason", async () => {
		const { svc, seen } = await freshEnv();
		const t = await svc.create({ title: "t" });
		const row = await svc.move(t.id, "blocked", "brain", "waiting on API key");
		expect(row.status).toBe("blocked");
		expect(row.blockedReason).toBe("waiting on API key");
		const ev = seen.find((e) => e.type === "task.status_changed");
		expect(ev?.payload).toEqual({
			from: "backlog",
			to: "blocked",
			actor: "brain",
			reason: "waiting on API key",
		});
		// same-status move: no extra event
		const before = seen.length;
		await svc.move(t.id, "blocked", "brain");
		expect(seen.length).toBe(before);
		// unblocking clears the reason
		expect((await svc.move(t.id, "ready", "human")).blockedReason).toBeNull();
	});

	test("bulk move uses guarded transitions and leaves stale cards alone", async () => {
		const { svc } = await freshEnv();
		const first = await svc.create({ title: "first" });
		const second = await svc.create({ title: "second" });
		const changed = await svc.create({ title: "changed", status: "ready" });

		const result = await svc.moveMany(
			[first.id, second.id, changed.id, "MFW-404", first.id],
			"backlog",
			"ready",
			"human",
		);

		expect(result).toEqual({
			moved: [first.id, second.id],
			skipped: [
				{ id: changed.id, reason: "changed" },
				{ id: "MFW-404", reason: "missing" },
			],
		});
		expect((await svc.get(first.id))?.readyMode).toBe("automatic");
		expect((await svc.get(second.id))?.status).toBe("ready");
	});
});

describe("move refuses a human hand on a live claim (MFW-44)", () => {
	test("a human move is refused while the lease is live, and carries the runId", async () => {
		const { svc, seen } = await freshEnv();
		const t = await svc.create({ title: "t", status: "ready" });
		const runId = ulid();
		expect(await svc.tryClaim(t.id, runId, 60_000)).toBe(true);
		const before = seen.length;
		try {
			await svc.move(t.id, "backlog", "human");
			throw new Error("expected TaskClaimedError");
		} catch (e) {
			expect(e).toBeInstanceOf(TaskClaimedError);
			expect((e as TaskClaimedError).taskId).toBe(t.id);
			expect((e as TaskClaimedError).runId).toBe(runId);
		}
		// refused: nothing moved, nothing emitted
		const row = await svc.get(t.id);
		expect(row?.status).toBe("in_progress");
		expect(row?.claimedByRunId).toBe(runId);
		expect(seen.length).toBe(before);
	});

	test("scheduler, verifier and other internal actors move a claimed task unblocked", async () => {
		const { svc } = await freshEnv();
		const t = await svc.create({ title: "t", status: "ready" });
		const runId = ulid();
		expect(await svc.tryClaim(t.id, runId, 60_000)).toBe(true);
		const row = await svc.move(t.id, "ready", "scheduler", "regression");
		expect(row.status).toBe("ready");
		// the claim itself is untouched by move(): only release() clears it
		expect((await svc.get(t.id))?.claimedByRunId).toBe(runId);
	});

	test("a human move is allowed once the lease has lapsed", async () => {
		const { svc } = await freshEnv();
		const t = await svc.create({ title: "t", status: "ready" });
		const runId = ulid();
		expect(await svc.tryClaim(t.id, runId, 10)).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 40));
		const row = await svc.move(t.id, "backlog", "human");
		expect(row.status).toBe("backlog");
	});
});

describe("runtime counters", () => {
	test("stall + preserved-worktree columns", async () => {
		const { svc } = await freshEnv();
		const t = await svc.create({ title: "t" });
		expect(await svc.bumpStall(t.id)).toBe(1);
		expect(await svc.bumpStall(t.id)).toBe(2);
		expect(await svc.bumpResume(t.id)).toBe(1);
		await svc.clearStall(t.id);
		expect((await svc.get(t.id))?.stallCount).toBe(0);
		// Verification is not yet a terminal acceptance boundary.
		expect((await svc.get(t.id))?.resumeCount).toBe(1);
		await svc.setResumeOrdinal(t.id, 2);
		await svc.setResumeOrdinal(t.id, 2);
		expect((await svc.get(t.id))?.resumeCount).toBe(2);
		await svc.release(t.id, null, "done", "verifier");
		expect((await svc.get(t.id))?.resumeCount).toBe(0);

		await svc.recordPreservedWorktree(t.id, "/wt/MFW-1", "mfw/MFW-1");
		let row = await svc.get(t.id);
		expect(row?.preservedWorktree).toBe("/wt/MFW-1");
		expect(row?.preservedBranch).toBe("mfw/MFW-1");
		await svc.clearPreservedWorktree(t.id);
		row = await svc.get(t.id);
		expect(row?.preservedWorktree).toBeNull();
		expect(row?.preservedBranch).toBeNull();
	});
});

describe("graph + list", () => {
	test("graph returns nodes and dependency edges", async () => {
		const { svc } = await freshEnv();
		const a = await svc.create({ title: "a" });
		const b = await svc.create({ title: "b", dependsOn: [a.id] });
		const g = await svc.graph();
		expect(g.nodes.map((n) => n.id)).toEqual([a.id, b.id]);
		expect(g.edges).toEqual([{ from: b.id, to: a.id }]);
	});

	test("list filters by status and joins refs", async () => {
		const { svc } = await freshEnv();
		await svc.create({ title: "a" });
		const r = await svc.create({
			title: "r",
			status: "ready",
			criteria: [{ text: "c" }],
		});
		const ready = await svc.list("ready");
		expect(ready.map((t) => t.id)).toEqual([r.id]);
		expect(ready[0]?.criteria).toEqual([{ text: "c", checked: false }]);
		expect((await svc.list()).length).toBe(2);
	});
});

describe("task templates", () => {
	const TEMPLATE = [
		"# Task",
		"",
		"## Context",
		"Why this matters.",
		"",
		"## Notes (optional)",
		"",
		"## Acceptance Criteria",
		"",
	].join("\n");

	async function withTemplate(name = "task.md"): Promise<Env> {
		const env = await freshEnv();
		await mkdir(join(env.dir, "templates"), { recursive: true });
		await writeFile(join(env.dir, "templates", name), TEMPLATE);
		return env;
	}

	test("the DoR gate holds a task with required sections missing, then releases it", async () => {
		const { svc } = await withTemplate();
		const t = await svc.create({ title: "t", body: "just a line" });
		expect(await svc.promoteReady()).toEqual([]);
		expect((await svc.get(t.id))?.templateMissing).toEqual([
			"Context",
			"Acceptance Criteria",
		]);

		// The template's own guidance is a placeholder, not content.
		await svc.edit(t.id, {
			body: "## Context\nWhy this matters.\n",
			criteria: [{ text: "works" }],
		});
		expect(await svc.promoteReady()).toEqual([]);
		expect((await svc.get(t.id))?.templateMissing).toEqual(["Context"]);

		await svc.edit(t.id, { body: "## Context\nUsers hit this daily.\n" });
		expect(await svc.promoteReady()).toEqual([t.id]);
		expect((await svc.get(t.id))?.templateMissing).toEqual([]);
	});

	test("a human can still move an incomplete task to ready", async () => {
		const { svc } = await withTemplate();
		const t = await svc.create({ title: "t", body: "just a line" });
		const moved = await svc.move(t.id, "ready", "human");
		expect(moved.status).toBe("ready");
	});

	test("list rows carry templateMissing; a type template wins over task.md", async () => {
		const { svc, dir } = await withTemplate("spike.md");
		await writeFile(join(dir, "templates", "task.md"), "## Other\nx\n");
		const spike = await svc.create({ title: "s", type: "spike", body: "b" });
		const impl = await svc.create({ title: "i", body: "b" });
		const rows = new Map((await svc.list()).map((r) => [r.id, r]));
		expect(rows.get(spike.id)?.templateMissing).toEqual([
			"Context",
			"Acceptance Criteria",
		]);
		expect(rows.get(impl.id)?.templateMissing).toEqual(["Other"]);
	});

	test("epics are containers and never gated", async () => {
		const { svc } = await withTemplate();
		const e = await svc.create({ title: "e", type: "epic", body: "b" });
		expect((await svc.get(e.id))?.templateMissing).toEqual([]);
		expect(await svc.promoteReady()).toEqual([e.id]);
	});

	test("no template, no gate", async () => {
		const { svc } = await freshEnv();
		const t = await svc.create({ title: "t", body: "b" });
		expect((await svc.get(t.id))?.templateMissing).toEqual([]);
		expect(await svc.promoteReady()).toEqual([t.id]);
	});
});

describe("immutable follow-up replay identity", () => {
	test("a renamed archived discovery is not filed again, including concurrent creation", async () => {
		const { svc } = await freshEnv();
		const input = {
			title: "Original finding",
			discoveryKey: "source-1:discovery-1",
			source: "followup" as const,
		};
		const [first, repeated] = await Promise.all([
			svc.create(input),
			svc.create(input),
		]);
		expect(first.id).toBe(repeated.id);
		await svc.edit(first.id, { title: "Clarified finding" });
		await svc.move(first.id, "archived", "human");
		await svc.load();
		const retry = await svc.create(input);
		expect(retry.id).toBe(first.id);
		expect(retry.title).toBe("Clarified finding");
		expect(retry.status).toBe("archived");
	});
});
