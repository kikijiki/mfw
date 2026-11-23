import { describe, expect, test } from "bun:test";
import { ChatError } from "@mfw/daemon/brain-runtime/chat-thread";
import { DirectionError } from "@mfw/daemon/brain-runtime/directions";
import type { Orchestrator, ProjectServices } from "@mfw/daemon/services";
import { createCaller } from "../src/root.ts";

function setup() {
	const calls: unknown[][] = [];
	const svc = {
		name: "alpha",
		brainRuntime: {
			chat: {
				view: async () => ({ entries: [], pending: 0 }),
				ask: async (i: { text: string; key: string }) => {
					calls.push(["ask", i]);
					if (i.text === "slow")
						throw new ChatError("rate_limited", "Too many");
					if (i.text === "reused") throw new ChatError("key_reused", "Reused");
					return { id: "Q1", duplicate: false };
				},
				giveOffer: async (id: string) => {
					calls.push(["offer", id]);
					if (id === "none") throw new ChatError("no_offer", "No offer");
					if (id === "gone") throw new ChatError("not_found", "Gone");
					if (id === "off") throw new DirectionError("no_brain", "Not started");
					return { directionId: "D1" };
				},
			},
		},
	} as unknown as ProjectServices;
	const orchestrator = {
		get: (name: string) => {
			if (name !== "alpha") throw new Error("unknown");
			return svc;
		},
		list: () => [svc],
	} as unknown as Orchestrator;
	return { api: createCaller({ orchestrator }), calls };
}

const project = "alpha";
const key = "submit-key-1";

describe("brain chat procedures", () => {
	test("the thread is a project query", async () => {
		const { api } = setup();
		expect(await api.brain.chatThread({ project })).toEqual({
			entries: [],
			pending: 0,
		});
		await expect(
			api.brain.chatThread({ project: "nope" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	test("ask passes only the text and the key", async () => {
		const { api, calls } = setup();
		const forged = {
			project,
			text: "what is running",
			key,
			source: "brain",
			offer: "deploy",
			citations: [{ kind: "task", id: "X" }],
		};
		await api.brain.chatAsk(forged);
		expect(calls).toEqual([["ask", { text: "what is running", key }]]);
	});

	test("a malformed key is refused before the service", async () => {
		const { api, calls } = setup();
		await expect(
			api.brain.chatAsk({ project, text: "hi", key: "a b" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(calls).toEqual([]);
	});

	test("refusals keep their codes", async () => {
		const { api } = setup();
		await expect(
			api.brain.chatAsk({ project, text: "slow", key }),
		).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
		await expect(
			api.brain.chatAsk({ project, text: "reused", key }),
		).rejects.toMatchObject({ code: "CONFLICT" });
		for (const [answerId, code] of [
			["none", "PRECONDITION_FAILED"],
			["gone", "NOT_FOUND"],
			["off", "PRECONDITION_FAILED"],
		] as const) {
			await expect(
				api.brain.chatGiveDirection({ project, answerId }),
			).rejects.toMatchObject({ code });
		}
	});

	test("giving an offer names the answer and carries no text", async () => {
		const { api, calls } = setup();
		const forged = { project, answerId: "A1", text: "deploy to production" };
		expect(await api.brain.chatGiveDirection(forged)).toEqual({
			directionId: "D1",
		});
		expect(calls).toEqual([["offer", "A1"]]);
	});
});
