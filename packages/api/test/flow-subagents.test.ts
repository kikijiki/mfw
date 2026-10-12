import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Orchestrator, ProjectServices } from "@mfw/daemon/services";
import { openProjectDb } from "@mfw/db/client";
import { runSubagents, runs } from "@mfw/db/schema";
import { createCaller } from "../src/root.ts";

/** U7-02: subagents are `sub:` nodes in flow.tree / flow.at / flow.spans / node.get. */

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
	for (const c of cleanups) await c();
});

const NOW = Date.UTC(2026, 9, 12, 12, 0, 0);
const T0 = NOW - 3600_000;
const m = (n: number) => T0 + n * 60_000;

async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), "mfw-flow-sub-"));
	const handle = await openProjectDb(dir);
	cleanups.push(async () => {
		handle.close();
		await rm(dir, { recursive: true, force: true });
	});
	const run = (id: string, startedMin: number, over = {}) => ({
		id,
		kind: "plan" as const,
		taskId: "T-1",
		label: id,
		model: "sonnet",
		cwd: "/w",
		state: "completed" as const,
		startedAt: new Date(m(startedMin)),
		finishedAt: new Date(m(startedMin + 30)),
		relation: "fresh" as const,
		...over,
	});
	await handle.db.insert(runs).values([
		run("r1", 0),
		// ended long ago: folded away from the default tree
		run("old", -60 * 24 * 10, { taskId: "T-1" }),
	]);
	const sub = (
		runId: string,
		toolUseId: string,
		startMin: number,
		endMin: number | null,
		over: Partial<typeof runSubagents.$inferInsert> = {},
	) => ({
		runId,
		toolUseId,
		parentToolUseId: null,
		agentType: "Explore",
		description: `desc ${toolUseId}`,
		startedAt: new Date(m(startMin)),
		endedAt: endMin === null ? null : new Date(m(endMin)),
		status: endMin === null ? "running" : "ok",
		tools: { Read: 2, Grep: 1 },
		entryFromSeq: 3,
		entryToSeq: 9,
		...over,
	});
	await handle.db
		.insert(runSubagents)
		.values([
			sub("r1", "a1", 5, 10),
			sub("r1", "a2", 6, 20, { parentToolUseId: "a1", status: "error" }),
			sub("r1", "a3", 25, null),
			sub("old", "z1", -60 * 24 * 10 + 1, -60 * 24 * 10 + 2),
		]);
	const taskRows = [
		{
			id: "T-1",
			title: "T-1",
			status: "in_progress",
			type: "feature",
			parentId: null,
			updatedAt: new Date(NOW),
		},
	];
	const svc = {
		name: "demo",
		handle,
		tasks: {
			list: async () => taskRows,
			get: async (id: string) => taskRows.find((t) => t.id === id) ?? null,
		},
		registry: { get: async () => null, runDir: () => join(dir, "no-run") },
	} as unknown as ProjectServices;
	const orchestrator = {
		list: () => [svc],
		get: () => svc,
	} as unknown as Orchestrator;
	return createCaller({ orchestrator });
}

describe("subagents in the flow", () => {
	test("tree: sub nodes hang under their run, nested ones under the subagent; folded runs carry none", async () => {
		const api = await fixture();
		const tree = await api.flow.tree({ project: "demo" });
		const subs = tree.nodes.filter((n) => n.kind === "sub");
		expect(subs.map((n) => [n.ref, n.parent])).toEqual([
			["sub:r1/a1", "run:r1"],
			["sub:r1/a2", "sub:r1/a1"],
			["sub:r1/a3", "run:r1"],
		]);
		const a1 = subs[0];
		expect(a1?.title).toBe("desc a1");
		expect(a1?.sub).toMatchObject({
			agentType: "Explore",
			status: "ok",
			tools: { Read: 2, Grep: 1 },
			entryFromSeq: 3,
			entryToSeq: 9,
		});
		expect(subs[2]?.sub?.status).toBe("running");
		// Subagents are not runs: the task's rollup counts the run only.
		const task = tree.nodes.find((n) => n.ref === "task:T-1");
		expect(task?.rollup?.total).toBe(2);
		// ended: "all" brings the old run's subagent in.
		const all = await api.flow.tree({
			project: "demo",
			include: { ended: "all" },
		});
		expect(all.nodes.some((n) => n.ref === "sub:old/z1")).toBeTrue();
	});

	test("at: a subagent is absent before it started and running while it had not ended", async () => {
		const api = await fixture();
		const refs = async (min: number) =>
			(await api.flow.at({ project: "demo", t: new Date(m(min)) })).nodes
				.filter((n) => n.kind === "sub")
				.map((n) => `${n.ref}:${n.sub?.status}`);
		expect(await refs(2)).toEqual([]);
		expect(await refs(7)).toEqual(["sub:r1/a1:running", "sub:r1/a2:running"]);
		expect(await refs(12)).toEqual(["sub:r1/a1:ok", "sub:r1/a2:running"]);
		expect(await refs(26)).toEqual([
			"sub:r1/a1:ok",
			"sub:r1/a2:error",
			"sub:r1/a3:running",
		]);
	});

	test("spans: one state span per subagent on its own subject, found by subtree", async () => {
		const api = await fixture();
		const res = await api.flow.spans({
			project: "demo",
			from: new Date(m(0)),
			to: new Date(m(60)),
			subtree: "run:r1",
		});
		const subSpans = res.spans.filter((s) => s.subject.startsWith("sub:"));
		expect(subSpans.map((s) => [s.subject, s.value, s.end === null])).toEqual([
			["sub:r1/a1", "ok", false],
			["sub:r1/a2", "error", false],
			["sub:r1/a3", "running", true],
		]);
		expect(subSpans[0]?.detail).toMatchObject({ agentType: "Explore" });
		// A window the subagent finished before does not include it.
		const later = await api.flow.spans({
			project: "demo",
			from: new Date(m(21)),
			to: new Date(m(22)),
			subtree: "run:r1",
		});
		expect(later.spans.filter((s) => s.subject === "sub:r1/a1")).toEqual([]);
	});

	test("the task Story's run entry lists its subagents; a run without any has no field", async () => {
		const api = await fixture();
		const page = await api.node.story({ project: "demo", ref: "task:T-1" });
		const runEntries = page.entries.filter((e) => e.kind === "run");
		const r1 = runEntries.find((e) => e.ref === "run:r1");
		expect(
			r1?.subagents?.map((s) => [s.ref, s.parentRef, s.status, s.toolCalls]),
		).toEqual([
			["sub:r1/a1", null, "ok", 3],
			["sub:r1/a2", "sub:r1/a1", "error", 3],
			["sub:r1/a3", null, "running", 3],
		]);
		const old = runEntries.find((e) => e.ref === "run:old");
		expect(old?.subagents?.[0]?.ref).toBe("sub:old/z1");
	});

	test("node.get serves a sub ref with its row, and 404s an unknown one", async () => {
		const api = await fixture();
		const node = await api.node.get({ project: "demo", ref: "sub:r1/a2" });
		expect(node).toMatchObject({
			ref: "sub:r1/a2",
			kind: "sub",
			parent: "sub:r1/a1",
			title: "desc a2",
			detail: { runId: "r1", toolUseId: "a2", status: "error" },
		});
		await expect(
			api.node.get({ project: "demo", ref: "sub:r1/nope" }),
		).rejects.toThrow(/no node/);
	});
});
