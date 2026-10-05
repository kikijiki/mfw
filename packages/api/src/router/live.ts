import type { StoredEvent } from "@mfw/daemon/services";
import { z } from "zod";
import { createTRPCRouter, projectProcedure } from "../trpc.ts";

/**
 * The push channel. Two subscriptions:
 *   live.events     audit events since a client-tracked seq, with a `gap`
 *                   sentinel when the client is too far behind to backfill
 *   live.runOutput  run transcript deltas by (runId, offset)
 */

/** Bounded backfill: past this the client refetches instead of replaying. */
const MAX_BACKFILL = 500;

/**
 * SSE keepalive interval. Must stay well under the shortest idle timeout on the
 * path: `Bun.serve` defaults to `idleTimeout: 10` (seconds) and Nitro's bun
 * preset cannot raise it. The margin also covers proxies (tailscale serve, nginx).
 */
const KEEPALIVE_MS = 5_000;

type LiveEvent =
	| { kind: "event"; event: StoredEvent }
	| { kind: "gap"; fromSeq: number; lastSeq: number }
	| { kind: "ping"; ts: number };

export const liveRouter = createTRPCRouter({
	/** Audit stream. `sinceSeq` lets a reconnecting client resume exactly. */
	events: projectProcedure
		.input(z.object({ sinceSeq: z.number().int().nonnegative().default(0) }))
		.subscription(async function* ({ ctx, input, signal }) {
			const { events: eventStore, bus } = ctx.svc;

			// Subscribe BEFORE backfilling: otherwise an event committed in between
			// lands in neither stream and the client goes silently stale. Overlap is
			// fine; `emit` dedupes by seq.
			const queue: StoredEvent[] = [];
			let wake: (() => void) | null = null;
			let overflowed = false;
			const unsubscribe = bus.subscribe((event) => {
				if (queue.length >= MAX_BACKFILL) {
					overflowed = true;
				} else {
					queue.push(event);
				}
				wake?.();
			});

			let lastSent = input.sinceSeq;
			const emit = (event: StoredEvent): LiveEvent | null => {
				if (event.seq <= lastSent) return null; // already delivered
				lastSent = event.seq;
				return { kind: "event", event };
			};
			/**
			 * Move a gap to a durable boundary without losing commits racing the head
			 * read. Clearing first makes already-published rows part of the head; rows
			 * arriving during the read are at/below it (covered by the client's
			 * refresh) or above it (kept, delivered after the gap). If the queue
			 * overflows again, resample: never claim a cursor with unaccounted rows.
			 */
			const recoverGap = async (): Promise<number> => {
				while (true) {
					queue.length = 0;
					overflowed = false;
					const head = await eventStore.latestSeq();
					if (overflowed) continue;

					let retained = 0;
					for (const event of queue) {
						if (event.seq > head) queue[retained++] = event;
					}
					queue.length = retained;
					lastSent = head;
					return head;
				}
			};

			try {
				const backfill = await eventStore.since(
					input.sinceSeq,
					MAX_BACKFILL + 1,
				);
				if (backfill.length > MAX_BACKFILL) {
					const head = await recoverGap();
					yield {
						kind: "gap",
						fromSeq: input.sinceSeq,
						lastSeq: head,
					} satisfies LiveEvent;
				} else {
					for (const event of backfill) {
						const framed = emit(event);
						if (framed) yield framed;
					}
				}
			} catch (e) {
				unsubscribe();
				throw e;
			}
			const abort = new Promise<void>((resolve) => {
				signal?.addEventListener("abort", () => resolve(), { once: true });
			});

			try {
				while (!signal?.aborted) {
					if (overflowed) {
						const fromSeq = lastSent;
						const head = await recoverGap();
						yield {
							kind: "gap",
							fromSeq,
							lastSeq: head,
						} satisfies LiveEvent;
						continue;
					}
					const next = queue.shift();
					if (next) {
						const framed = emit(next);
						if (framed) yield framed;
						continue;
					}
					// Idle: wait for an event, the abort, or a keepalive tick.
					await Promise.race([
						new Promise<void>((resolve) => {
							wake = resolve;
						}),
						abort,
						Bun.sleep(KEEPALIVE_MS),
					]);
					wake = null;
					if (!signal?.aborted && queue.length === 0 && !overflowed) {
						yield { kind: "ping", ts: Date.now() } satisfies LiveEvent;
					}
				}
			} finally {
				unsubscribe();
			}
		}),

	/**
	 * Transcript deltas for one run. Emits only the bytes past `offset`, then
	 * follows the file until the run reaches a terminal state.
	 */
	runOutput: projectProcedure
		.input(
			z.object({
				runId: z.string(),
				offset: z.number().int().nonnegative().default(0),
				file: z.enum(["events.jsonl", "raw.log"]).default("events.jsonl"),
			}),
		)
		.subscription(async function* ({ ctx, input, signal }) {
			const { registry } = ctx.svc;
			let offset = input.offset;
			const TERMINAL = new Set([
				"completed",
				"failed",
				"killed",
				"interrupted",
				"rate_limited",
				"needs_review",
				"finalize_error",
			]);

			// A quiet run writes nothing for minutes and Bun closes idle responses (see KEEPALIVE_MS).
			let lastWriteAt = Date.now();
			while (!signal?.aborted) {
				const { chunk, size, complete } = await registry.readOutput(
					input.runId,
					input.file,
					offset,
				);
				if (chunk.length > 0) {
					offset = size;
					lastWriteAt = Date.now();
					yield { kind: "delta" as const, chunk, offset };
				}
				// Drain a capped backlog before checking terminal state, or a large completed run stops after 1 MiB.
				if (!complete) continue;
				const run = await registry.get(input.runId);
				if (!run || TERMINAL.has(run.state)) {
					yield {
						kind: "end" as const,
						state: run?.state ?? "unknown",
						offset,
					};
					return;
				}
				if (Date.now() - lastWriteAt >= KEEPALIVE_MS) {
					lastWriteAt = Date.now();
					yield { kind: "ping" as const, ts: lastWriteAt };
				}
				await Bun.sleep(500);
			}
		}),
});
