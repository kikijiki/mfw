import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppRouter } from "@mfw/api";
import { QueryClient } from "@tanstack/react-query";
import { createTRPCClient } from "@trpc/client";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import type { LiveFrame } from "./live";
import { applyEvent, nextLiveSeq } from "./live";

test("task creation and ownership/dependency edits invalidate the cached Inbox", () => {
	const queryClient = new QueryClient();
	const trpc = createTRPCOptionsProxy<AppRouter>({
		client: createTRPCClient<AppRouter>({ links: [] }),
		queryClient,
	});
	const inboxKey = trpc.inbox.list.queryKey();
	for (const event of [
		{ type: "task.created", taskId: "MFW-1", payload: { title: "overlap" } },
		{ type: "task.edited", taskId: "MFW-1", payload: { fields: ["owns"] } },
		{
			type: "task.edited",
			taskId: "MFW-1",
			payload: { fields: ["dependsOn"] },
		},
	]) {
		queryClient.setQueryData(inboxKey, {
			items: [],
			counts: { total: 0, critical: 0, attention: 0 },
		});
		expect(queryClient.getQueryState(inboxKey)?.isInvalidated).toBe(false);
		applyEvent(queryClient, trpc, {
			project: "test",
			event: { ...event, seq: 1, ts: Date.now() } as never,
		});
		expect(queryClient.getQueryState(inboxKey)?.isInvalidated).toBe(true);
	}
	queryClient.clear();
});

describe("live task claim release", () => {
	const source = readFileSync(join(import.meta.dir, "live.ts"), "utf8");

	test("clears optimistic ownership and refreshes every dependent view", () => {
		const branch = source.slice(
			source.indexOf('case "task.claim_released"'),
			source.indexOf('case "task.lease_expired"'),
		);
		expect(branch).toContain("claimedByRunId: null");
		expect(branch).toContain("tasksList()");
		expect(branch).toContain("taskGet(event.taskId)");
		expect(branch).toContain("runsActive()");
		expect(branch).toContain("health()");
	});
});

describe("live cursor recovery", () => {
	const frame = (seq: number): LiveFrame =>
		({
			kind: "event",
			event: {
				type: "scheduler.paused",
				payload: { reason: "test" },
				seq,
				ts: seq,
			},
		}) as LiveFrame;

	test("advances a gap to the durable head and accepts only newer events", () => {
		const gap = { kind: "gap", fromSeq: 10, lastSeq: 750 } as LiveFrame;
		const afterGap = nextLiveSeq(10, gap);
		expect(afterGap).toBe(750);
		expect(nextLiveSeq(afterGap as number, frame(750))).toBeNull();
		expect(nextLiveSeq(afterGap as number, frame(751))).toBe(751);
	});

	test("never regresses on a replayed gap or duplicate event", () => {
		const oldGap = { kind: "gap", fromSeq: 0, lastSeq: 500 } as LiveFrame;
		expect(nextLiveSeq(700, oldGap)).toBeNull();
		expect(nextLiveSeq(700, frame(699))).toBeNull();
		expect(nextLiveSeq(700, frame(700))).toBeNull();
		expect(nextLiveSeq(700, frame(701))).toBe(701);
	});
});
