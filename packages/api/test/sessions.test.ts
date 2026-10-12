import { describe, expect, test } from "bun:test";
import type { Orchestrator, ProjectServices } from "@mfw/daemon/services";
import { createCaller } from "../src/root.ts";

/** The procedures NOW's escalation cards call (features/sessions/SessionCard). */

const brief = (id: string, createdAt: string) => ({
	id,
	source: "blocked" as const,
	sourceKey: id,
	taskId: "MFW-1",
	runId: "01RUN",
	mergeJobId: null,
	title: `brief ${id}`,
	context: "what failed",
	createdAt: new Date(createdAt),
	openedRunId: null,
	openedAt: null,
	resolvedAt: null,
	resolution: null,
	resolutionReason: null,
});

function project(name: string, rows: ReturnType<typeof brief>[]) {
	const calls: unknown[][] = [];
	const svc = {
		name,
		sessions: {
			list: async (opts: { open?: boolean }) => {
				calls.push(["list", opts]);
				return rows;
			},
			open: async (id: string) => {
				calls.push(["open", id]);
				return { runId: `run-for-${id}` };
			},
			resolve: async (id: string, resolution: string, reason?: string) => {
				calls.push(["resolve", id, resolution, reason]);
			},
		},
	} as unknown as ProjectServices;
	return { svc, calls };
}

function callerFor(...services: ProjectServices[]) {
	const orchestrator = {
		list: () => services,
		get: (name: string) => {
			const svc = services.find((s) => s.name === name);
			if (!svc) throw new Error("unknown project");
			return svc;
		},
	} as unknown as Orchestrator;
	return createCaller({ orchestrator });
}

describe("sessions router", () => {
	test("open merges every project's unresolved briefs, newest first", async () => {
		const a = project("alpha", [brief("a1", "2026-10-01T00:00:00Z")]);
		const b = project("beta", [brief("b1", "2026-10-02T00:00:00Z")]);
		const open = await callerFor(a.svc, b.svc).sessions.open();
		expect(open.map((s) => [s.project, s.id])).toEqual([
			["beta", "b1"],
			["alpha", "a1"],
		]);
		expect(a.calls).toEqual([["list", { open: true }]]);
	});

	test("start and resolve reach the named project's service", async () => {
		const a = project("alpha", []);
		const b = project("beta", []);
		const api = callerFor(a.svc, b.svc);
		expect(await api.sessions.start({ project: "beta", id: "b1" })).toEqual({
			runId: "run-for-b1",
		});
		await api.sessions.resolve({
			project: "beta",
			id: "b1",
			resolution: "dismissed",
			reason: "duplicate",
		});
		expect(b.calls).toEqual([
			["open", "b1"],
			["resolve", "b1", "dismissed", "duplicate"],
		]);
		expect(a.calls).toEqual([]);
	});
});
