import { describe, expect, test } from "bun:test";
import { DirectionError } from "@mfw/daemon/brain-runtime/directions";
import { OverrideError } from "@mfw/daemon/human-override";
import type { Orchestrator, ProjectServices } from "@mfw/daemon/services";
import { createCaller } from "../src/root.ts";

/** The brain's read procedures (UI) and its MCP transport procedures. */

function setup() {
	const calls: unknown[][] = [];
	const svc = {
		name: "alpha",
		brainRuntime: {
			view: async () => ({
				enabled: true,
				session: { id: "S1", generation: 2 },
			}),
			turnList: async (o: unknown) => {
				calls.push(["turns", o]);
				return [{ runId: "R2", seq: 2 }];
			},
			decisionList: async (o: unknown) => {
				calls.push(["decisions", o]);
				return [{ id: 7, kind: "note" }];
			},
			latestPlan: async () => ({ decisionId: 3, markdown: "# plan" }),
			resetCircuit: async () => {
				calls.push(["reset"]);
			},
			setPaused: async (paused: boolean) => {
				calls.push(["paused", paused]);
			},
			human: {
				preview: async (id: number) => {
					calls.push(["preview", id]);
					return { decisionId: id, state: "ready", steps: [] };
				},
				override: async (id: number, reason: string) => {
					calls.push(["override", id, reason]);
					if (id === 99) {
						throw new OverrideError("already_overridden", "already overridden");
					}
					return { decisionId: 600, applied: [] };
				},
				message: async (m: unknown) => {
					calls.push(["message", m]);
					return { decisionId: 601, about: null };
				},
			},
			directions: {
				give: async (d: { text: string; key: string }) => {
					calls.push(["give", d]);
					if (d.text === "slow down") {
						throw new DirectionError("rate_limited", "Too many");
					}
					if (d.text === "no brain") {
						throw new DirectionError("no_brain", "Not started");
					}
					return { id: "D1", duplicate: false };
				},
				list: async () => [{ id: "D1", status: "drafting" }],
			},
			reads: {
				read: async (tool: string, args: unknown, o: unknown) => {
					calls.push(["read", tool, args, o]);
					return { ok: true };
				},
			},
			actions: {
				act: async (i: unknown) => {
					calls.push(["act", i]);
					return { actionId: "A1", status: "proposed", dryRun: true };
				},
			},
		},
	} as unknown as ProjectServices;
	const orchestrator = {
		list: () => [svc],
		get: () => svc,
	} as unknown as Orchestrator;
	return { api: createCaller({ orchestrator }), calls };
}

describe("brain directions", () => {
	const key = "key-12345";

	test("only the text and key reach the runtime: authorship is not input", async () => {
		const { api, calls } = setup();
		const forged = {
			project: "alpha",
			text: "ship it",
			key,
			author: "agent",
			provenance: "external",
		};
		expect(await api.brain.giveDirection(forged)).toEqual({
			id: "D1",
			duplicate: false,
		});
		expect(calls).toEqual([["give", { text: "ship it", key }]]);
	});

	test("oversized text and a malformed key never reach the runtime", async () => {
		const { api, calls } = setup();
		await expect(
			api.brain.giveDirection({
				project: "alpha",
				text: "x".repeat(2001),
				key,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			api.brain.giveDirection({ project: "alpha", text: "ok", key: "a b" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(calls).toEqual([]);
	});

	test("refusals map to transport codes", async () => {
		const { api } = setup();
		await expect(
			api.brain.giveDirection({ project: "alpha", text: "slow down", key }),
		).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
		await expect(
			api.brain.giveDirection({ project: "alpha", text: "no brain", key }),
		).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
	});

	test("the timeline reads through", async () => {
		const { api } = setup();
		expect(await api.brain.directions({ project: "alpha" })).toEqual([
			{ id: "D1", status: "drafting" },
		] as never);
	});
});

describe("brain router", () => {
	test("the four read procedures reach the runtime", async () => {
		const { api, calls } = setup();
		expect((await api.brain.session({ project: "alpha" })).enabled).toBe(true);
		expect(await api.brain.turns({ project: "alpha", limit: 5 })).toMatchObject(
			[{ runId: "R2", seq: 2 }],
		);
		expect(
			await api.brain.decisions({ project: "alpha", kind: "note" }),
		).toMatchObject([{ id: 7, kind: "note" }]);
		expect((await api.brain.plan({ project: "alpha" }))?.markdown).toBe(
			"# plan",
		);
		expect(calls[0]).toEqual(["turns", { project: "alpha", limit: 5 }]);
	});

	test("read and act carry the turn and the tool through", async () => {
		const { api, calls } = setup();
		await api.brain.read({
			project: "alpha",
			tool: "board",
			args: { filter: { status: "ready" } },
			turnRunId: "R2",
		});
		const r = await api.brain.act({
			project: "alpha",
			turnRunId: "R2",
			tool: "spawn",
			args: { taskId: "MFW-1" },
		});
		expect(r.status).toBe("proposed");
		expect(calls.find((c) => c[0] === "read")).toEqual([
			"read",
			"board",
			{ filter: { status: "ready" } },
			{ turnRunId: "R2" },
		]);
		expect(calls.find((c) => c[0] === "act")?.[1]).toMatchObject({
			turnRunId: "R2",
			tool: "spawn",
		});
	});

	test("a person can retry an open circuit and hold the brain", async () => {
		const { api, calls } = setup();
		await api.brain.resetCircuit({ project: "alpha" });
		await api.brain.setPaused({ project: "alpha", paused: true });
		expect(calls).toEqual([["reset"], ["paused", true]]);
	});

	test("override needs a reason, previews first, and refusals are preconditions", async () => {
		const { api, calls } = setup();
		expect(
			(await api.brain.overridePreview({ project: "alpha", decisionId: 5 }))
				.state,
		).toBe("ready");
		await expect(
			api.brain.override({ project: "alpha", decisionId: 5, reason: "  " }),
		).rejects.toThrow();
		expect(calls.some((c) => c[0] === "override")).toBe(false);
		await api.brain.override({
			project: "alpha",
			decisionId: 5,
			reason: "wrong epic",
		});
		expect(calls.find((c) => c[0] === "override")).toEqual([
			"override",
			5,
			"wrong epic",
		]);
		await expect(
			api.brain.override({ project: "alpha", decisionId: 99, reason: "x" }),
		).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
	});

	test("a message reaches the brain with what it is about", async () => {
		const { api, calls } = setup();
		await api.brain.message({
			project: "alpha",
			text: "hold the auth work",
			about: "task:T-1",
		});
		expect(calls.find((c) => c[0] === "message")?.[1]).toEqual({
			text: "hold the auth work",
			about: "task:T-1",
		});
	});
});
