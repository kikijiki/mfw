import { describe, expect, test } from "bun:test";
import type { Orchestrator } from "@mfw/daemon/services";
import { createCaller } from "../src/root.ts";

function model() {
	return {
		enabled: false,
		accountId: "default",
		credential: {
			ready: false,
			checkedAt: 1,
			validatedAt: null,
			validationError: null,
		},
		balance: {
			remainingCredits: 19.75,
			currency: "USD" as const,
			source: "RunPod clientBalance" as const,
			inferredFromSpend: false as const,
			observedAt: 1,
			checkedAt: 1,
			fresh: true,
			error: null,
		},
		gate: { open: false, reason: "RunPod disabled", changedAt: 1 },
		settings: {
			version: 1,
			dispatchPaused: false,
			updatedAt: 1,
			updatedBy: "daemon-config",
			reason: "initial machine policy",
			policy: { enabled: false as const },
		},
		inventory: {
			observedAt: null,
			cause: null,
			fresh: false,
			error: null,
			podCount: 0,
		},
		reconcile: {
			lastAttemptAt: null,
			lastError: null,
			cleanupPending: 0,
		},
		policy: { hard: null },
		pods: [],
		costs: {
			providerInfrastructure: {
				label: "RunPod infrastructure" as const,
				costPerHr: 0,
				adjustedCostPerHr: 0,
				hourlyBurn: 0,
				estimatedCost: 0,
			},
			agentTokens: {
				label: "Agent tokens" as const,
				includedInInfrastructureCost: false as const,
				cost: null,
			},
		},
		audit: [],
	};
}

describe("global RunPod account API", () => {
	test("works with zero projects and exposes the global read model", async () => {
		const orchestrator = {
			list: () => [],
			runpod: { readModel: async () => model() },
		} as unknown as Orchestrator;
		const caller = createCaller({ orchestrator });

		const result = await caller.runpod.get();
		expect(result).toMatchObject({
			enabled: false,
			credential: { ready: false },
			balance: {
				remainingCredits: 19.75,
				source: "RunPod clientBalance",
				inferredFromSpend: false,
			},
			inventory: { podCount: 0 },
		});
	});

	test("refresh and cleanup delegate to the account reconciler instead of mutating providers", async () => {
		const calls: unknown[] = [];
		const orchestrator = {
			list: () => [],
			runpod: {
				readModel: async () => model(),
				refresh: async (reason: string) => {
					calls.push(["refresh", reason]);
					return model();
				},
				requestCleanup: async (input: unknown) => {
					calls.push(["cleanup", input]);
					return model();
				},
			},
		} as unknown as Orchestrator;
		const caller = createCaller({ orchestrator });

		await caller.runpod.refresh({ reason: "operator audit" });
		const cleanup = {
			podId: "pod-99",
			reason: "owned orphan",
			actor: "operator",
			confirmed: true as const,
			expectedOwnershipFingerprint: "a".repeat(64),
			expectedObservedAt: 1,
		};
		await caller.runpod.cleanup(cleanup);
		expect(calls).toEqual([
			["refresh", "operator audit"],
			["cleanup", cleanup],
		]);
	});

	test("rejects cleanup without a concrete Pod identity and audit reason", async () => {
		const orchestrator = {
			list: () => [],
			runpod: {
				requestCleanup: async () => model(),
			},
		} as unknown as Orchestrator;
		const caller = createCaller({ orchestrator });

		await expect(
			caller.runpod.cleanup({
				podId: "",
				reason: "",
				actor: "",
				confirmed: true,
				expectedOwnershipFingerprint: "bad",
				expectedObservedAt: 0,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	test("delegates simple safety and routine pause changes without an audit reason", async () => {
		const calls: unknown[] = [];
		const orchestrator = {
			list: () => [],
			runpod: {
				updateMachineSafety: async (input: unknown) => {
					calls.push(["safety", input]);
					return model();
				},
				updateMachinePolicy: async (input: unknown) => {
					calls.push(["policy", input]);
					return model();
				},
				setDispatchPaused: async (input: unknown) => {
					calls.push(["pause", input]);
					return model();
				},
			},
		} as unknown as Orchestrator;
		const caller = createCaller({ orchestrator });
		const command = {
			expectedVersion: 1,
			actor: "operator",
		};
		const safety = {
			enabled: true as const,
			maxHourlyPrice: 1,
			maxAggregateHourlyPrice: 2,
			maxRuntimeMinutes: 60,
			maxRunSpend: 2,
		};
		await caller.runpod.updateSafety({ ...command, safety });
		await caller.runpod.updatePolicy({
			...command,
			policy: { enabled: false },
		});
		await caller.runpod.setPaused({ ...command, paused: true });
		expect(calls).toEqual([
			["safety", { ...command, safety }],
			["policy", { ...command, policy: { enabled: false } }],
			["pause", { ...command, paused: true }],
		]);
	});
});
