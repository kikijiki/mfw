import type {
	InferenceClient,
	InferenceOpts,
	InferenceReply,
	InferenceUsage,
} from "./brain.ts";

/**
 * Brain inference over an OpenAI-compatible HTTP endpoint: one chat
 * completion, no tools, no files, no process. Reaches local llama.cpp /
 * Ollama / vLLM servers and OpenRouter, which makes an independent reviewer
 * model cheap. `fetch` and the key source are injectable so tests never touch
 * the network; the key is read per call (a rotated key applies at once) and
 * never logged or put in an error.
 *
 * Chat completions, not the Responses API Codex needs: every server above
 * serves `/chat/completions`, and a one-shot JSON answer needs nothing more.
 */
export class OpenAICompatibleInference implements InferenceClient {
	constructor(
		private readonly opts: {
			baseUrl: string;
			apiKey?: () => Promise<string | undefined>;
			fetch?: typeof fetch;
		},
	) {}

	async complete(prompt: string, opts: InferenceOpts): Promise<InferenceReply> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
		const onAbort = () => controller.abort();
		opts.signal?.addEventListener("abort", onAbort, { once: true });
		try {
			const key = await this.opts.apiKey?.();
			const url = `${this.opts.baseUrl.replace(/\/+$/, "")}/chat/completions`;
			const res = await (this.opts.fetch ?? fetch)(url, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					...(key ? { authorization: `Bearer ${key}` } : {}),
				},
				body: JSON.stringify({
					model: opts.model,
					messages: [{ role: "user", content: prompt }],
					stream: false,
					...(opts.reasoningEffort && opts.reasoningEffort !== "none"
						? { reasoning_effort: effortFor(opts.reasoningEffort) }
						: {}),
				}),
				signal: controller.signal,
			});
			const text = await res.text();
			if (!res.ok) {
				throw new Error(
					`openai-compatible endpoint answered ${res.status}: ${text.slice(0, 300)}`,
				);
			}
			let body: Record<string, unknown>;
			try {
				body = JSON.parse(text) as Record<string, unknown>;
			} catch {
				throw new Error("openai-compatible endpoint returned non-JSON");
			}
			const choices = Array.isArray(body.choices) ? body.choices : [];
			const message = (choices[0] as { message?: { content?: unknown } })
				?.message;
			if (typeof message?.content !== "string") {
				throw new Error("openai-compatible endpoint returned no message text");
			}
			const usage = usageOf(body);
			return Object.keys(usage).length > 0
				? { text: message.content, usage }
				: { text: message.content };
		} catch (e) {
			if (opts.signal?.aborted) throw new Error("inference aborted");
			if (controller.signal.aborted) throw new Error("inference timed out");
			throw e;
		} finally {
			clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onAbort);
		}
	}
}

/** The OpenAI scale stops at high; mfw's xhigh/max map onto it. */
function effortFor(effort: string): string {
	return effort === "xhigh" || effort === "max" ? "high" : effort;
}

/** Usage in the run-usage vocabulary; OpenRouter adds `usage.cost` (USD). */
function usageOf(body: Record<string, unknown>): InferenceUsage {
	const u = (
		typeof body.usage === "object" && body.usage !== null ? body.usage : {}
	) as Record<string, unknown>;
	const out: InferenceUsage = {};
	const put = (key: string, v: unknown) => {
		if (typeof v === "number" && Number.isFinite(v)) out[key] = v;
	};
	put("inputTokens", u.prompt_tokens);
	put("outputTokens", u.completion_tokens);
	const prompt = u.prompt_tokens_details as Record<string, unknown> | undefined;
	put("cachedInputTokens", prompt?.cached_tokens);
	const completion = u.completion_tokens_details as
		| Record<string, unknown>
		| undefined;
	put("reasoningOutputTokens", completion?.reasoning_tokens);
	put("costUsd", u.cost);
	return out;
}
