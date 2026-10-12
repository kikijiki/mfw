import { describe, expect, test } from "bun:test";
import type { Orchestrator } from "@mfw/daemon/services";
import { UsageMonitor } from "@mfw/daemon/usage-monitor";
import { createCaller } from "../src/root.ts";

function monitor() {
	let pct = 20;
	const m = new UsageMonitor({
		probes: [
			{
				provider: "claude-cli",
				name: "Claude Code",
				available: async () => true,
				run: async () => ({
					accountLabel: "max",
					windows: [
						{
							label: "5h",
							usedPercent: pct,
							resetsAt: Date.now() + 3_600_000,
							windowMinutes: 300,
							source: "test",
						},
					],
				}),
			},
		],
		schedule: () => () => {},
	});
	return {
		m,
		setPct: (n: number) => {
			pct = n;
		},
	};
}

describe("usage API", () => {
	test("subscriptions reads the cache, refresh probes, no project needed", async () => {
		const { m, setPct } = monitor();
		const orchestrator = {
			list: () => [],
			usage: m,
		} as unknown as Orchestrator;
		const caller = createCaller({ orchestrator });

		// Nothing probed yet: the query never probes by itself.
		expect((await caller.usage.subscriptions()).subscriptions).toEqual([]);

		await m.tick();
		const first = await caller.usage.subscriptions();
		expect(first.subscriptions).toHaveLength(1);
		expect(first.subscriptions[0]).toMatchObject({
			provider: "claude-cli",
			name: "Claude Code",
			accountLabel: "max",
			status: "ok",
		});
		expect(first.subscriptions[0]?.windows[0]).toMatchObject({
			label: "5h",
			usedPercent: 20,
			windowMinutes: 300,
		});

		setPct(55);
		const refreshed = await caller.usage.refresh();
		expect(refreshed.subscriptions[0]?.windows[0]?.usedPercent).toBe(55);
	});

	test("changes yields a first frame and one per change", async () => {
		const { m, setPct } = monitor();
		const orchestrator = {
			list: () => [],
			usage: m,
		} as unknown as Orchestrator;
		const caller = createCaller({ orchestrator });
		const abort = new AbortController();
		// The in-process caller's types omit the call options a subscription takes.
		const open = caller.usage.changes as unknown as (
			input: undefined,
			opts: { signal: AbortSignal },
		) => Promise<AsyncIterable<{ kind: string }>>;
		const stream = await open(undefined, { signal: abort.signal });
		const it = stream[Symbol.asyncIterator]();
		expect((await it.next()).value).toMatchObject({ kind: "usage" });
		await m.tick(); // the first snapshot is a change
		expect((await it.next()).value).toMatchObject({ kind: "usage" });
		setPct(70);
		await m.tick(true);
		expect((await it.next()).value).toMatchObject({ kind: "usage" });
		abort.abort();
		await it.return?.(undefined);
	});
});
