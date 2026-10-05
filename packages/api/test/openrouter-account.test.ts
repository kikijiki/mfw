import { describe, expect, test } from "bun:test";
import type { Orchestrator } from "@mfw/daemon/services";
import { createCaller } from "../src/root.ts";

describe("global OpenRouter account API", () => {
	test("works with zero projects and delegates refresh to the account service", async () => {
		const model = {
			credential: { ready: true, validatedAt: 1, validationError: null },
			checkedAt: 1,
			observedAt: 1,
			fresh: true,
			error: null,
			key: null,
			credits: { available: false },
			activity: { available: false },
		};
		const calls: string[] = [];
		const orchestrator = {
			list: () => [],
			openrouter: {
				readModel: () => model,
				refresh: async (reason: string) => {
					calls.push(reason);
					return model;
				},
			},
		} as unknown as Orchestrator;
		const caller = createCaller({ orchestrator });
		expect(await caller.openrouter.get()).toMatchObject({ fresh: true });
		expect(await caller.openrouter.refresh()).toMatchObject({ fresh: true });
		expect(calls).toEqual(["operator_refresh"]);
	});
});
