import { describe, expect, test } from "bun:test";
import type { Orchestrator, ProjectServices } from "@mfw/daemon/services";
import { createCaller } from "../src/root.ts";

function setup() {
	const calls: unknown[][] = [];
	const svc = {
		name: "alpha",
		budgets: {
			list: async () => [{ id: "resource:runpod:main", used: 5, limit: 100 }],
			get: async (id: string) => {
				calls.push(["get", id]);
				return { id };
			},
			set: async (input: unknown) => {
				calls.push(["set", input]);
				return [];
			},
		},
	} as unknown as ProjectServices;
	const orchestrator = {
		list: () => [svc],
		get: () => svc,
	} as unknown as Orchestrator;
	return { api: createCaller({ orchestrator }), calls };
}

describe("budgets router", () => {
	test("list and get read the budget service", async () => {
		const { api, calls } = setup();
		expect(await api.budgets.list({ project: "alpha" })).toHaveLength(1);
		await api.budgets.get({ project: "alpha", id: "resource:runpod:main" });
		expect(calls).toEqual([["get", "resource:runpod:main"]]);
	});

	test("set validates the entry and pins the brain key", async () => {
		const { api, calls } = setup();
		await api.budgets.set({
			project: "alpha",
			scope: "machine",
			kind: "brain",
			key: "whatever",
			entry: { window: "day", limitUsd: 10 },
		});
		expect(calls[0]).toEqual([
			"set",
			{
				scope: "machine",
				kind: "brain",
				key: "brain",
				entry: { window: "day", limitUsd: 10 },
			},
		]);
		await expect(
			api.budgets.set({
				project: "alpha",
				scope: "project",
				kind: "agent",
				key: "claude-cli",
				entry: { window: "day", limitUsd: 1, limitTokens: 5 },
			}),
		).rejects.toThrow();
		await expect(
			api.budgets.set({
				project: "alpha",
				scope: "project",
				kind: "agent",
				key: "claude-cli",
				entry: { window: "sometime", limitUsd: 1 },
			}),
		).rejects.toThrow();
	});
});
