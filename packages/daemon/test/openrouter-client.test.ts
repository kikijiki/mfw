import { describe, expect, test } from "bun:test";
import {
	OpenRouterApiError,
	OpenRouterClient,
	parseOpenRouterActivity,
	parseOpenRouterCredits,
	parseOpenRouterKeyUsage,
	parseOpenRouterListedKeys,
} from "../src/openrouter-client.ts";

const keyData = {
	data: {
		label: "sk-or-v1-…9z",
		usage: 12.5,
		usage_daily: 0.75,
		usage_weekly: 3.5,
		usage_monthly: 8.25,
		byok_usage: 0,
		byok_usage_daily: 0,
		byok_usage_weekly: 0,
		byok_usage_monthly: 0,
		limit: 50,
		limit_remaining: 37.5,
		limit_reset: "monthly",
		include_byok_in_limit: false,
		is_free_tier: false,
		is_management_key: true,
		expires_at: null,
	},
};

describe("OpenRouter account client", () => {
	test("parses current-key, credits, and activity responses into bounded types", () => {
		expect(parseOpenRouterKeyUsage(keyData)).toMatchObject({
			usageDaily: 0.75,
			limitRemaining: 37.5,
			isManagementKey: true,
		});
		expect(
			parseOpenRouterCredits({ data: { total_credits: 100, total_usage: 42 } }),
		).toEqual({ totalCredits: 100, totalUsage: 42 });
		expect(
			parseOpenRouterActivity({
				data: [
					{
						date: "2026-08-24",
						model: "openai/gpt-5",
						provider_name: "OpenAI",
						requests: 2,
						prompt_tokens: 100,
						completion_tokens: 20,
						reasoning_tokens: 10,
						usage: 0.25,
						byok_usage_inference: 0,
					},
				],
			}),
		).toEqual([
			{
				date: "2026-08-24",
				model: "openai/gpt-5",
				providerName: "OpenAI",
				requests: 2,
				promptTokens: 100,
				completionTokens: 20,
				reasoningTokens: 10,
				usage: 0.25,
				byokUsageInference: 0,
			},
		]);
		expect(
			parseOpenRouterListedKeys({
				data: [
					{
						usage: 12.5,
						usage_daily: 0.75,
						usage_weekly: 3.5,
						usage_monthly: 8.25,
					},
				],
			}),
		).toEqual([
			{
				usage: 12.5,
				usageDaily: 0.75,
				usageWeekly: 3.5,
				usageMonthly: 8.25,
			},
		]);
	});

	test("rejects malformed money and excessive activity instead of trusting provider JSON", () => {
		expect(() =>
			parseOpenRouterCredits({
				data: { total_credits: Number.NaN, total_usage: 1 },
			}),
		).toThrow(OpenRouterApiError);
		expect(() =>
			parseOpenRouterActivity({ data: Array(10_001).fill({}) }),
		).toThrow(/excessive/);
	});

	test("authenticates with the write-only key and returns safe HTTP errors", async () => {
		const secret = "sk-or-v1-write-only-canary";
		const calls: Array<{ url: string; authorization: string | null }> = [];
		const client = new OpenRouterClient({
			credentials: { apiKey: async () => secret },
			fetch: (async (input, init) => {
				calls.push({
					url: String(input),
					authorization: new Headers(init?.headers).get("authorization"),
				});
				return new Response(JSON.stringify(keyData), {
					headers: { "content-type": "application/json" },
				});
			}) as typeof fetch,
		});
		expect((await client.getCurrentKey()).usage).toBe(12.5);
		expect(calls).toEqual([
			{
				url: "https://openrouter.ai/api/v1/key",
				authorization: `Bearer ${secret}`,
			},
		]);

		const rejected = new OpenRouterClient({
			credentials: { apiKey: async () => secret },
			fetch: (async () =>
				new Response("secret-bearing body", {
					status: 401,
				})) as unknown as typeof fetch,
		});
		await expect(rejected.getCurrentKey()).rejects.toMatchObject({
			code: "http_error",
			status: 401,
		});
		try {
			await rejected.getCurrentKey();
		} catch (error) {
			expect(String(error)).not.toContain(secret);
			expect(String(error)).not.toContain("secret-bearing body");
		}
	});

	test("lists account keys through the management endpoint", async () => {
		const calls: string[] = [];
		const client = new OpenRouterClient({
			credentials: { apiKey: async () => "sk-or-management-canary" },
			fetch: (async (input) => {
				calls.push(String(input));
				return new Response(
					JSON.stringify({
						data: [
							{
								usage: 10,
								usage_daily: 1,
								usage_weekly: 4,
								usage_monthly: 8,
							},
						],
					}),
				);
			}) as typeof fetch,
		});

		expect(await client.listKeys()).toEqual([
			{
				usage: 10,
				usageDaily: 1,
				usageWeekly: 4,
				usageMonthly: 8,
			},
		]);
		expect(calls).toEqual([
			"https://openrouter.ai/api/v1/keys?include_disabled=true&offset=0",
		]);
	});
});
