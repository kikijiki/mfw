import { describe, expect, test } from "bun:test";
import type { Orchestrator, ProjectServices } from "@mfw/daemon/services";

import { createCaller } from "../src/root.ts";

const clarification = {
	runId: "RUN-QUESTIONS",
	kind: "planner",
	goal: "Expand the capture",
	items: [{ question: "Which order?", answer: null }],
	createdAt: new Date("2026-08-19T00:00:00Z"),
	resolvedAt: null,
	continuationRunId: null,
	openCount: 1,
};

const draft = {
	id: "MFW-76",
	status: "draft",
	claimedByRunId: null,
};

function fixture(
	opts: {
		releaseSucceeds?: boolean;
		taskId?: string | null;
		withSibling?: boolean;
	} = {},
) {
	const calls: string[] = [];
	const taskId = opts.taskId === undefined ? draft.id : opts.taskId;
	const svc = {
		name: "demo",
		clarify: {
			get: async () => clarification,
			list: async () => [
				clarification,
				...(opts.withSibling
					? [{ ...clarification, runId: "RUN-QUESTIONS-2" }]
					: []),
			],
			dismiss: async (runId: string) => {
				calls.push(`dismiss:${runId}`);
				return { ...clarification, runId, resolvedAt: new Date() };
			},
		},
		registry: {
			get: async () => (taskId ? { taskId } : null),
		},
		tasks: {
			get: async () => (taskId ? draft : null),
			release: async () => {
				calls.push("archive");
				return opts.releaseSucceeds === false
					? null
					: { ...draft, status: "archived" };
			},
		},
	} as unknown as ProjectServices;
	const orchestrator = {
		list: () => [svc],
		get: () => svc,
	} as unknown as Orchestrator;
	return { api: createCaller({ orchestrator }), calls };
}

describe("clarification Draft coordination", () => {
	test("get identifies only a clarification backed by a Draft", async () => {
		const draftResult = await fixture().api.clarify.get({
			project: "demo",
			runId: clarification.runId,
		});
		const tasklessResult = await fixture({ taskId: null }).api.clarify.get({
			project: "demo",
			runId: clarification.runId,
		});

		expect(draftResult?.draftTaskId).toBe("MFW-76");
		expect(tasklessResult?.draftTaskId).toBeNull();
	});

	test("archives under the claim CAS before closing questions", async () => {
		const { api, calls } = fixture();
		const result = await api.clarify.archiveDraft({
			project: "demo",
			runId: clarification.runId,
		});

		expect(result.task.status).toBe("archived");
		expect(calls).toEqual(["archive", "dismiss:RUN-QUESTIONS"]);
	});

	test("closes every legacy question set linked to the archived Draft", async () => {
		const { api, calls } = fixture({ withSibling: true });

		await api.clarify.archiveDraft({
			project: "demo",
			runId: clarification.runId,
		});

		expect(calls).toEqual([
			"archive",
			"dismiss:RUN-QUESTIONS",
			"dismiss:RUN-QUESTIONS-2",
		]);
	});

	test("does not close questions when a continuation won the claim", async () => {
		const { api, calls } = fixture({ releaseSucceeds: false });

		await expect(
			api.clarify.archiveDraft({
				project: "demo",
				runId: clarification.runId,
			}),
		).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
		expect(calls).toEqual(["archive"]);
	});
});
