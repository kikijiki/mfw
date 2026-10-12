import type { UsageSubscription } from "@mfw/daemon/usage-monitor";
import { createTRPCRouter, publicProcedure } from "../trpc.ts";

/**
 * Subscription usage meters (`daemon/usage-monitor.ts`): how full each found
 * harness subscription's rolling windows (5h, 7d, ...) are. Machine-wide.
 *
 *  usage.subscriptions   the cached snapshot (never probes)
 *  usage.refresh         probe now (single flight) and return the snapshot
 *  usage.changes         one frame per change, plus keepalives; the UI
 *                        invalidates `usage.subscriptions` on each
 */

/** Same reasoning as `live.ts` KEEPALIVE_MS. */
const KEEPALIVE_MS = 5_000;

export interface UsageSnapshot {
	generatedAt: number;
	subscriptions: UsageSubscription[];
}

export const usageRouter = createTRPCRouter({
	subscriptions: publicProcedure.query(
		({ ctx }): UsageSnapshot => ({
			generatedAt: Date.now(),
			subscriptions: ctx.orchestrator.usage.snapshot(),
		}),
	),
	refresh: publicProcedure.mutation(
		async ({ ctx }): Promise<UsageSnapshot> => ({
			generatedAt: Date.now(),
			subscriptions: await ctx.orchestrator.usage.refresh(),
		}),
	),
	changes: publicProcedure.subscription(async function* ({ ctx, signal }) {
		const monitor = ctx.orchestrator.usage;
		let wake: (() => void) | null = null;
		let pending = false;
		const unsubscribe = monitor.subscribe(() => {
			pending = true;
			wake?.();
		});
		try {
			yield { kind: "usage" as const, ts: Date.now() };
			while (!signal?.aborted) {
				if (pending) {
					pending = false;
					yield { kind: "usage" as const, ts: Date.now() };
					continue;
				}
				await Promise.race([
					new Promise<void>((resolve) => {
						wake = resolve;
					}),
					new Promise<void>((resolve) =>
						signal?.addEventListener("abort", () => resolve(), { once: true }),
					),
					Bun.sleep(KEEPALIVE_MS),
				]);
				wake = null;
				if (!signal?.aborted && !pending)
					yield { kind: "ping" as const, ts: Date.now() };
			}
		} finally {
			unsubscribe();
		}
	}),
});
