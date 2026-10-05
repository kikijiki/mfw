import { describe, expect, test } from "bun:test";
import type { Logger } from "../src/log.ts";
import { OpenRouterAccountService } from "../src/openrouter-account-service.ts";
import type {
	OpenRouterClientPort,
	OpenRouterKeyUsage,
} from "../src/openrouter-client.ts";

const key = (management: boolean): OpenRouterKeyUsage => ({
	label: "test key",
	usage: 12,
	usageDaily: 1,
	usageWeekly: 4,
	usageMonthly: 8,
	byokUsage: 0,
	byokUsageDaily: 0,
	byokUsageWeekly: 0,
	byokUsageMonthly: 0,
	limit: 25,
	limitRemaining: 13,
	limitReset: "monthly",
	includeByokInLimit: false,
	isFreeTier: false,
	isManagementKey: management,
	expiresAt: null,
});

const log = { warn: () => {} } as unknown as Logger;

describe("OpenRouter account service", () => {
	test("keeps a standard key useful without calling management-only APIs", async () => {
		const calls: string[] = [];
		const client: OpenRouterClientPort = {
			credentialReady: async () => true,
			getCurrentKey: async () => {
				calls.push("key");
				return key(false);
			},
			getCredits: async () => {
				calls.push("credits");
				return { totalCredits: 0, totalUsage: 0 };
			},
			getActivity: async () => {
				calls.push("activity");
				return [];
			},
			listKeys: async () => [],
		};
		const service = new OpenRouterAccountService({ client, log });
		const model = await service.refresh();
		expect(calls).toEqual(["key", "credits"]);
		expect(model).toMatchObject({
			fresh: true,
			key: { usageDaily: 1, limitRemaining: 13 },
			credits: {
				available: true,
				remainingCredits: 0,
			},
			activity: { available: false, reason: "management_key_required" },
		});
	});

	test("refreshes automatically on its bounded account polling interval", async () => {
		let keyChecks = 0;
		const client: OpenRouterClientPort = {
			credentialReady: async () => true,
			getCurrentKey: async () => {
				keyChecks++;
				return key(false);
			},
			getCredits: async () => ({ totalCredits: 100, totalUsage: keyChecks }),
			getActivity: async () => [],
			listKeys: async () => [],
		};
		const service = new OpenRouterAccountService({
			client,
			log,
			refreshIntervalMs: 5,
		});
		await service.start();
		await Bun.sleep(18);
		service.stop();
		expect(keyChecks).toBeGreaterThanOrEqual(3);
		const stoppedAt = keyChecks;
		await Bun.sleep(10);
		expect(keyChecks).toBe(stoppedAt);
	});

	test("fetches management credits and aggregates the 30-day activity", async () => {
		const client: OpenRouterClientPort = {
			credentialReady: async () => true,
			getCurrentKey: async () => key(false),
			getCredits: async () => ({ totalCredits: 100, totalUsage: 40 }),
			getActivity: async () => [],
			listKeys: async () => [],
		};
		const managementClient: OpenRouterClientPort = {
			credentialReady: async () => true,
			getCurrentKey: async () => key(true),
			getCredits: async () => ({ totalCredits: 100, totalUsage: 40 }),
			getActivity: async () => [
				{
					date: "2026-08-24",
					model: "openai/gpt-5",
					providerName: "OpenAI",
					requests: 2,
					promptTokens: 100,
					completionTokens: 20,
					reasoningTokens: 10,
					usage: 0.2,
					byokUsageInference: 0,
				},
				{
					date: "2026-08-24",
					model: "openai/gpt-5",
					providerName: "Azure",
					requests: 1,
					promptTokens: 50,
					completionTokens: 10,
					reasoningTokens: 0,
					usage: 0.1,
					byokUsageInference: 0.05,
				},
			],
			listKeys: async () => [
				{
					usage: 40,
					usageDaily: 2,
					usageWeekly: 8,
					usageMonthly: 30,
				},
			],
		};
		const model = await new OpenRouterAccountService({
			client,
			managementClient,
			log,
		}).refresh();
		expect(model.credits).toMatchObject({
			available: true,
			remainingCredits: 60,
		});
		expect(model.activity.days).toEqual([
			{
				date: "2026-08-24",
				usage: 0.30000000000000004,
				byokUsage: 0.05,
				requests: 3,
				promptTokens: 150,
				completionTokens: 30,
				reasoningTokens: 10,
			},
		]);
		expect(model.accountUsage).toMatchObject({
			available: true,
			daily: 2,
			weekly: 8,
			monthly: 30,
			keyCount: 1,
		});
		expect(model.activity.models[0]).toMatchObject({
			name: "openai/gpt-5",
			requests: 3,
			tokens: 190,
		});
	});

	test("validates a candidate before persistence and clears cached data on removal", async () => {
		let validated = false;
		let ready = true;
		const client: OpenRouterClientPort = {
			credentialReady: async () => ready,
			getCurrentKey: async () => {
				validated = true;
				return key(false);
			},
			getCredits: async () => ({ totalCredits: 0, totalUsage: 0 }),
			getActivity: async () => [],
			listKeys: async () => [],
		};
		const service = new OpenRouterAccountService({ client, log });
		await service.setCredential(async (validate) => {
			expect(validated).toBe(false);
			await validate();
			expect(validated).toBe(true);
		});
		await service.removeCredential(async () => {
			ready = false;
		});
		expect(service.readModel()).toMatchObject({
			credential: { ready: false },
			fresh: false,
			key: null,
		});
	});

	test("accepts only a management key for the analytics credential", async () => {
		const client: OpenRouterClientPort = {
			credentialReady: async () => false,
			getCurrentKey: async () => key(false),
			getCredits: async () => ({ totalCredits: 0, totalUsage: 0 }),
			getActivity: async () => [],
			listKeys: async () => [],
		};
		let management = false;
		const managementClient: OpenRouterClientPort = {
			...client,
			credentialReady: async () => management,
			getCurrentKey: async () => key(management),
		};
		const service = new OpenRouterAccountService({
			client,
			managementClient,
			log,
		});
		await expect(
			service.setManagementCredential(async (validate) => validate()),
		).rejects.toThrow("management key required");
		management = true;
		await service.setManagementCredential(async (validate) => validate());
		expect(service.readModel().managementCredential).toMatchObject({
			ready: true,
			validationError: null,
		});
	});
});
