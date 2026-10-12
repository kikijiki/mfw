import {
	type ActivityFold,
	emptyFold,
	foldActivity,
	type SubagentFold,
} from "./agents/activity.ts";
import { parseAgentEvents } from "./agents/events.ts";

/**
 * Per-run incremental reader of `events.jsonl`. Each `fold` reads only the
 * bytes appended since the previous call and folds the complete lines into
 * the run's `ActivityFold`, so the supervisor's every-pass checks (approvals,
 * turns, activity) and `respondApproval` never re-read a long transcript, and
 * nothing past the first MiB is missed.
 *
 * Byte offsets, so multi-byte text is safe. A line still being written is left
 * for the next call; a single line over the read cap is skipped.
 */

export type ReadChunk = (
	runId: string,
	offset: number,
) => Promise<{ chunk: string; size: number; complete: boolean }>;

/** A live run's usage is sampled at most this often (`run.usage_sampled`). */
export const USAGE_SAMPLE_MS = 30_000;

export interface UsageSample {
	tokensIn: number;
	tokensOut: number;
	costUsd?: number;
}

/** A subagent's changed tool counts are handed out at most this often. */
export const SUBAGENT_SAMPLE_MS = 10_000;

/** Runs whose folds are kept; the least recently created is dropped past this. */
const DEFAULT_MAX_RUNS = 128;

export class RunEventTail {
	private readonly tails = new Map<
		string,
		{
			offset: number;
			fold: ActivityFold;
			/** When the run's usage was last handed out, and what it was. */
			usageAt: number;
			usageSig: string | null;
			/** The subagents last handed out: their shape, counts and when. */
			subShape: string | null;
			subCounts: string | null;
			subAt: number;
		}
	>();

	constructor(
		private readonly read: ReadChunk,
		private readonly maxRuns = DEFAULT_MAX_RUNS,
	) {}

	/** Fold whatever was appended since the last call and return the run's fold. */
	async fold(runId: string): Promise<ActivityFold> {
		let tail = this.tails.get(runId);
		if (!tail) {
			tail = {
				offset: 0,
				fold: emptyFold(),
				usageAt: 0,
				usageSig: null,
				subShape: null,
				subCounts: null,
				subAt: 0,
			};
			this.tails.set(runId, tail);
			for (const stale of this.tails.keys()) {
				if (this.tails.size <= this.maxRuns) break;
				if (stale !== runId) this.tails.delete(stale);
			}
		}
		for (;;) {
			const start = tail.offset;
			const { chunk, size, complete } = await this.read(runId, start);
			// A concurrent call advanced the cursor while this read was in flight.
			if (tail.offset !== start) continue;
			const end = chunk.lastIndexOf("\n");
			if (end < 0) {
				if (complete) break;
				tail.offset = size;
				continue;
			}
			const lines = chunk.slice(0, end + 1);
			foldActivity(tail.fold, parseAgentEvents(lines));
			tail.offset = start + Buffer.byteLength(lines, "utf8");
			if (complete) break;
		}
		return tail.fold;
	}

	/**
	 * The run's usage totals when they changed since the last sample and at
	 * least `USAGE_SAMPLE_MS` has passed; otherwise null. Reads the fold the
	 * last `fold()` produced, so it costs no I/O.
	 */
	takeUsageSample(runId: string, now: number): UsageSample | null {
		const tail = this.tails.get(runId);
		const usage = tail?.fold.usage;
		if (!tail || !usage) return null;
		if (tail.usageAt > 0 && now - tail.usageAt < USAGE_SAMPLE_MS) return null;
		const sig = `${usage.tokensIn}/${usage.tokensOut}/${usage.costUsd ?? ""}`;
		if (sig === tail.usageSig) return null;
		tail.usageAt = now;
		tail.usageSig = sig;
		return { ...usage };
	}

	/**
	 * The run's subagents when they changed since the last take, else null.
	 * A subagent starting or finishing is handed out at once; a tool count
	 * alone at most every `SUBAGENT_SAMPLE_MS`. Reads the fold the last
	 * `fold()` produced, so it costs no I/O.
	 */
	takeSubagents(runId: string, now: number): SubagentFold[] | null {
		const tail = this.tails.get(runId);
		const subs = tail ? [...tail.fold.subagents.values()] : [];
		if (!tail || subs.length === 0) return null;
		const shape = subs.map((s) => `${s.toolUseId}:${s.status}`).join(",");
		const counts = JSON.stringify(
			subs.map((s) => [s.tools, s.entryToSeq, s.description]),
		);
		const shapeChanged = shape !== tail.subShape;
		if (
			!shapeChanged &&
			(counts === tail.subCounts || now - tail.subAt < SUBAGENT_SAMPLE_MS)
		)
			return null;
		tail.subShape = shape;
		tail.subCounts = counts;
		tail.subAt = now;
		return subs.map((s) => ({ ...s, tools: { ...s.tools } }));
	}

	/** Drop a run's fold (it ended; a later read starts from the beginning). */
	forget(runId: string): void {
		this.tails.delete(runId);
	}
}
