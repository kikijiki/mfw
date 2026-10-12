import { describe, expect, test } from "bun:test";
import { OpenAICompatibleInference } from "../src/openai-compatible-inference.ts";

function fakeFetch(
	reply: { status?: number; body: unknown },
	seen: { url: string; init: RequestInit }[],
): typeof fetch {
	return (async (url: string | URL | Request, init?: RequestInit) => {
		seen.push({ url: String(url), init: init ?? {} });
		return new Response(JSON.stringify(reply.body), {
			status: reply.status ?? 200,
		});
	}) as typeof fetch;
}

describe("OpenAICompatibleInference", () => {
	test("one chat completion: bearer key per call, text and usage (cost when the server reports it)", async () => {
		const seen: { url: string; init: RequestInit }[] = [];
		const client = new OpenAICompatibleInference({
			baseUrl: "https://openrouter.ai/api/v1/",
			apiKey: async () => "sk-test",
			fetch: fakeFetch(
				{
					body: {
						choices: [{ message: { content: '{"ok":true}' } }],
						usage: {
							prompt_tokens: 12,
							completion_tokens: 3,
							prompt_tokens_details: { cached_tokens: 4 },
							cost: 0.0021,
						},
					},
				},
				seen,
			),
		});
		const reply = await client.complete("judge this", {
			model: "qwen/qwen3-coder",
			timeoutMs: 5_000,
			reasoningEffort: "xhigh",
		});
		expect(reply).toEqual({
			text: '{"ok":true}',
			usage: {
				inputTokens: 12,
				outputTokens: 3,
				cachedInputTokens: 4,
				costUsd: 0.0021,
			},
		});
		expect(seen[0]?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
		const headers = seen[0]?.init.headers as Record<string, string>;
		expect(headers.authorization).toBe("Bearer sk-test");
		const body = JSON.parse(String(seen[0]?.init.body));
		expect(body).toMatchObject({
			model: "qwen/qwen3-coder",
			messages: [{ role: "user", content: "judge this" }],
			reasoning_effort: "high",
		});
	});

	test("a local server needs no key; errors never carry the key", async () => {
		const seen: { url: string; init: RequestInit }[] = [];
		const client = new OpenAICompatibleInference({
			baseUrl: "http://127.0.0.1:8080/v1",
			fetch: fakeFetch({ status: 500, body: { error: "boom" } }, seen),
		});
		const err = await client
			.complete("p", { model: "m", timeoutMs: 5_000 })
			.catch((e: Error) => e);
		expect(String(err)).toContain("answered 500");
		expect(
			(seen[0]?.init.headers as Record<string, string>).authorization,
		).toBeUndefined();
	});

	test("honours the call's timeout", async () => {
		const client = new OpenAICompatibleInference({
			baseUrl: "http://127.0.0.1:1/v1",
			fetch: ((_: unknown, init?: RequestInit) =>
				new Promise((_, reject) =>
					init?.signal?.addEventListener("abort", () =>
						reject(new Error("aborted")),
					),
				)) as typeof fetch,
		});
		await expect(
			client.complete("p", { model: "m", timeoutMs: 20 }),
		).rejects.toThrow(/timed out/);
	});
});
