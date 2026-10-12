import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import { EventBus } from "@mfw/db/eventlog";
import { engineKv, runGroups } from "@mfw/db/schema";
import { eq } from "drizzle-orm";
import { RunRegistry } from "../src/run-registry.ts";
import { foreignClaims } from "../src/scope-watchdog.ts";
import type { TaskService } from "../src/task-service.ts";
import {
	CLAIM_GROUPS_MIGRATION_KEY,
	revertClaimGroups,
} from "../src/tasks/claim-groups.ts";
import { makeTasks } from "./fixtures/board.ts";

/**
 * The claim sidecar names an attempt group, not a run (`claimedByGroupId`).
 * A group of one is named after its run, so the migration only renames the
 * key; it runs once per board under the claim lock, with a marker and a
 * revert tool.
 */

let dir: string | undefined;
let handle: ProjectDbHandle | undefined;
afterEach(async () => {
	handle?.close();
	handle = undefined;
	if (dir) await rm(dir, { recursive: true, force: true });
	dir = undefined;
});

async function env() {
	dir = await mkdtemp(join(tmpdir(), "mfw-test-claimgroups-"));
	handle = await openProjectDb(dir);
	const bus = new EventBus();
	const tasks = await makeTasks(handle, bus, dir);
	const registry = new RunRegistry({
		handle,
		bus,
		runsDir: join(dir, "runs"),
	});
	return { dir, handle, tasks, registry };
}

const sidecar = (root: string, id: string) =>
	join(root, "state", "tasks", `${id}.json`);

async function legacyClaim(
	root: string,
	id: string,
	runId: string,
): Promise<void> {
	await mkdir(join(root, "state", "tasks"), { recursive: true });
	await writeFile(
		sidecar(root, id),
		`${JSON.stringify({
			claimedByRunId: runId,
			claimedAt: Date.now(),
			leaseExpiresAt: Date.now() + 600_000,
			statusChangedAt: Date.now(),
			worktree: null,
		})}\n`,
	);
}

describe("claim sidecar migration", () => {
	test("renames claimedByRunId to claimedByGroupId once, keeps the claim, records the marker", async () => {
		const e = await env();
		const t = await e.tasks.create({ title: "claimed", status: "ready" });
		const run = await e.registry.create({
			kind: "task",
			taskId: t.id,
			label: "x",
			model: "sonnet",
			cwd: e.dir,
		});
		await legacyClaim(e.dir, t.id, run.id);
		await e.tasks.load();

		const report = await e.tasks.migrateClaimGroups();
		expect(report?.rewritten).toEqual([t.id]);

		const onDisk = JSON.parse(await readFile(sidecar(e.dir, t.id), "utf8"));
		expect(onDisk.claimedByGroupId).toBe(run.id);
		expect("claimedByRunId" in onDisk).toBe(false);
		const claimed = await e.tasks.get(t.id);
		expect(claimed?.claimedByGroupId).toBe(run.id);
		expect(claimed?.claimedByRunId).toBe(run.id);

		// the claimed run's group row exists, named after the run
		const [group] = await e.handle.db
			.select()
			.from(runGroups)
			.where(eq(runGroups.id, run.id));
		expect(group).toMatchObject({ kind: "single", taskId: t.id });

		// marker: a second attach does nothing
		const [marker] = await e.handle.db
			.select()
			.from(engineKv)
			.where(eq(engineKv.key, CLAIM_GROUPS_MIGRATION_KEY));
		expect(marker).toBeDefined();
		expect(await e.tasks.migrateClaimGroups()).toBeNull();
	});

	test("a sidecar not yet migrated still reads as a held claim", async () => {
		const e = await env();
		const t = await e.tasks.create({ title: "legacy", status: "ready" });
		await legacyClaim(e.dir, t.id, "run-legacy");
		await e.tasks.load();
		const row = await e.tasks.get(t.id);
		expect(row?.claimedByGroupId).toBe("run-legacy");
	});

	test("a competing group's claim reverts to its lead run", async () => {
		const root = await mkdtemp(join(tmpdir(), "mfw-test-claimrevert-"));
		dir = root;
		const mfw = join(root, ".mfw");
		await mkdir(join(mfw, "state", "tasks"), { recursive: true });
		await writeFile(
			sidecar(mfw, "MFW-9"),
			`${JSON.stringify({
				claimedByGroupId: "GROUP1",
				leadRunId: "run-a",
				claimedAt: 1,
				leaseExpiresAt: null,
				statusChangedAt: 1,
				worktree: null,
			})}\n`,
		);
		const report = await revertClaimGroups({ root });
		expect(report.rewritten).toEqual(["MFW-9"]);
		expect(report.flattened).toEqual(["MFW-9"]);
		const back = JSON.parse(await readFile(sidecar(mfw, "MFW-9"), "utf8"));
		expect(back.claimedByRunId).toBe("run-a");
		expect("claimedByGroupId" in back).toBe(false);
	});
});

describe("scope watchdog sibling rule", () => {
	const claimed = [
		{ id: "T-1", claimedByGroupId: "G1", owns: ["src/a/**"] },
		{ id: "T-2", claimedByGroupId: "G2", owns: ["src/b/**"] },
		{ id: "T-3", claimedByGroupId: null, owns: ["src/c/**"] },
	];

	test("a claim held by the run's own group is never foreign", () => {
		// attempt B of group G1: its sibling A leads the claim
		const foreign = foreignClaims({ id: "run-B", groupId: "G1" }, claimed);
		expect(foreign.map((f) => f.taskId)).toEqual(["T-2"]);
	});

	test("a group of one is named after its run", () => {
		const foreign = foreignClaims({ id: "G2", groupId: null }, claimed);
		expect(foreign.map((f) => f.taskId)).toEqual(["T-1"]);
	});

	test("unclaimed tasks and tasks without owns are not foreign", () => {
		const foreign = foreignClaims({ id: "x", groupId: "G9" }, [
			{ id: "T-4", claimedByGroupId: "G4", owns: [] },
			{ id: "T-5", claimedByGroupId: null, owns: ["a"] },
		]);
		expect(foreign).toEqual([]);
	});
});

describe("group claim lifecycle", () => {
	test("a sibling of the claiming group releases the claim as the group; moveLease follows the lead", async () => {
		const e = await env();
		const t = await e.tasks.create({ title: "group", status: "ready" });
		const a = await e.registry.create({
			kind: "task",
			taskId: t.id,
			label: "a",
			model: "sonnet",
			cwd: e.dir,
			groupId: "G-1",
			role: "attempt",
		});
		const b = await e.registry.create({
			kind: "task",
			taskId: t.id,
			label: "b",
			model: "sonnet",
			cwd: e.dir,
			groupId: "G-1",
			role: "attempt",
		});
		expect(
			await (e.tasks as TaskService).tryClaim(
				t.id,
				"G-1",
				60_000,
				"scheduler",
				"ready",
				{ leadRunId: a.id },
			),
		).toBe(true);
		const row = await e.tasks.get(t.id);
		expect(row?.claimedByGroupId).toBe("G-1");
		expect(row?.claimedByRunId).toBe(a.id);

		// the sibling's lease renewal keeps the group's claim alive
		expect(await e.tasks.renewLease(b.id, 120_000)).toBe(true);
		expect(await e.tasks.siblingsLive(a.id)).toBe(true);

		// releasing by a member run releases the group's claim
		const released = await e.tasks.release(t.id, b.id, "ready", "scheduler");
		expect(released?.claimedByGroupId).toBeNull();
	});
});
