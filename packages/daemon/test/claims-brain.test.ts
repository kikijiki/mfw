import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { appendEvent } from "@mfw/db/eventlog";
import { decisions } from "@mfw/db/schema";
import { eq } from "drizzle-orm";
import type { InferenceClient } from "../src/brain.ts";
import { ChatBudget } from "../src/brain-runtime/chat-budget.ts";
import type { ChatAnswer } from "../src/brain-runtime/chat-thread.ts";
import { CLAIM_INSTRUCTION } from "../src/claims.ts";
import { type BrainUnit, brainUnit } from "./support/brain-unit.ts";

let u: BrainUnit;
afterEach(async () => {
	await u?.runtime.chat.stop();
	await u?.cleanup();
});

const MARK = "(brain's claim, no host record)";

const hostPass = (taskId: string) =>
	u.handle.withTx((tx) =>
		appendEvent(tx, {
			type: "verify.check",
			taskId,
			runId: "run-pass",
			payload: { check: "test", passed: true },
		}),
	);

async function chatSays(text: string, before?: () => Promise<unknown>) {
	const prompts: string[] = [];
	const client: InferenceClient = {
		async complete(prompt: string) {
			prompts.push(prompt);
			return {
				text: JSON.stringify({
					answer: { text, citations: [], wants_action: false },
				}),
				usage: { inputTokens: 10, outputTokens: 10 },
			};
		},
	};
	let budget: ChatBudget | null = null;
	u = await brainUnit({
		chat: {
			inference: () => client,
			budget: {
				admit: (id: string, p: string) => budget?.admit(id, p),
				charge: (id: string, t: number, d: number) => budget?.charge(id, t, d),
				settle: (id: string) => budget?.settle(id),
				usage: () => budget?.usage(),
			} as unknown as ChatBudget,
			inbox: async () => [],
		},
	});
	budget = new ChatBudget(join(u.root, "chat-budget.json"), () => u.clock.t);
	await u.runtime.tick();
	await before?.();
	await u.runtime.chat.ask({ text: "how is it going", key: "k1" });
	await u.runtime.chat.settled();
	const answer = (await u.runtime.chat.thread.entries()).find(
		(e): e is ChatAnswer => e.kind === "answer",
	);
	if (!answer) throw new Error("no answer");
	return { answer, prompts };
}

describe("chat answers", () => {
	test("an unbacked verified is marked and the original is kept", async () => {
		const { answer, prompts } = await chatSays("MFW-1 is verified.");
		expect(answer.source).toBe("brain");
		expect(answer.text).toBe(`MFW-1 is verified ${MARK}.`);
		expect(answer.originalText).toBe("MFW-1 is verified.");
		expect(answer.unbackedClaims).toBe(1);
		expect(prompts[0]).toContain(CLAIM_INSTRUCTION);
	});

	test("a host record lets the same sentence through", async () => {
		const { answer } = await chatSays("MFW-1 is verified.", () =>
			hostPass("MFW-1"),
		);
		expect(answer.text).toBe("MFW-1 is verified.");
		expect(answer.originalText).toBeUndefined();
		expect(answer.unbackedClaims).toBeUndefined();
	});

	test("a negation is stored exactly as written", async () => {
		const { answer } = await chatSays("MFW-1 is not verified yet.");
		expect(answer.text).toBe("MFW-1 is not verified yet.");
		expect(answer.originalText).toBeUndefined();
	});
});

describe("stored brain text", () => {
	async function turn() {
		u = await brainUnit({ maxConcurrent: 2 });
		await u.runtime.tick();
		await u.human("plan something");
		await u.runtime.tick();
		return u.launched[0]?.runId ?? "";
	}
	const row = async (id: number | null | undefined) => {
		const [d] = await u.handle.db
			.select()
			.from(decisions)
			.where(eq(decisions.id, id ?? -1));
		return d;
	};

	test("a plan is marked in `reason` and whole in `input`", async () => {
		const turnRunId = await turn();
		const markdown = "MFW-9 is deployed and healthy.";
		const r = await u.runtime.actions.act({
			turnRunId,
			tool: "set_plan",
			args: { markdown },
		});
		const d = await row(r.decisionId);
		expect(d?.reason).toBe(`MFW-9 is deployed ${MARK} and healthy ${MARK}.`);
		expect((d?.input as { markdown: string }).markdown).toBe(markdown);
		expect((d?.output as { claimGuard: unknown }).claimGuard).toEqual({
			unbacked: ["deployed", "healthy"],
		});
	});

	test("a clean note gets no guard record", async () => {
		const turnRunId = await turn();
		const r = await u.runtime.actions.act({
			turnRunId,
			tool: "note",
			args: { text: "MFW-9 is not deployed." },
		});
		const d = await row(r.decisionId);
		expect(d?.reason).toBe("MFW-9 is not deployed.");
		expect(d?.output).not.toHaveProperty("claimGuard");
	});

	test("a page to the owner is guarded, its args are not", async () => {
		const turnRunId = await turn();
		const title = "MFW-9 is fixed";
		const r = await u.runtime.actions.act({
			turnRunId,
			tool: "notify_human",
			args: {
				rationale: "tell the owner",
				kind: "fyi",
				title,
				body: "It was merged.",
			},
		});
		expect(r.status).toBe("applied");
		const sent = u.effects.find((e) => e.tool === "notify_human")?.args[0] as {
			title: string;
			body: string;
		};
		expect(sent.title).toBe(`MFW-9 is fixed ${MARK}`);
		expect(sent.body).toBe(`It was merged ${MARK}.`);
		const d = await row(r.decisionId);
		expect((d?.input as { title: string }).title).toBe(title);
	});
});
