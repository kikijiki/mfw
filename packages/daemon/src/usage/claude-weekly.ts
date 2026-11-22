import type { UsageProbe, UsageProbeResult, UsageWindow } from "./types.ts";

/**
 * Claude's weekly meter, with no token read and no vendor endpoint. Claude has
 * one limit, the weekly window; the only honest source for it is what the CLI
 * itself reported in a `rate_limit_event` (see `agents/rate-limit-claude.ts`).
 * Until one has been observed the meter is unknown, never 0. The spend ledger
 * records absolute usage but not the plan's limit, so it cannot turn into a
 * percentage by itself.
 */

export const CLAUDE_WEEKLY_SOURCE = "claude-rate-limit-event";
export const CLAUDE_WEEKLY_LABEL = "7d";
const WEEK_MINUTES = 7 * 24 * 60;

/** One `rate_limit` agent event, as the drivers emit it. */
export interface RateLimitObservation {
	/** The vendor status string (`allowed`, `allowed_warning`, `rejected`). */
	status: string;
	/** Already resolved by the driver: a refusal, not a heads-up. */
	limited: boolean;
	/** Epoch ms or seconds the window resets; null when not reported. */
	resetsAt: number | null;
	/** Fraction of the quota used, 0-1, on an allowed event; null when not reported. */
	utilization: number | null;
}

/** The latest observed weekly state, fed by whoever sees the events. */
export class RateLimitObserver {
	private last: { obs: RateLimitObservation; at: number } | null = null;

	constructor(private readonly now: () => number = Date.now) {}

	observe(obs: RateLimitObservation): void {
		// An allowed event with no number says nothing new about the window.
		if (!obs.limited && obs.utilization === null) return;
		this.last = { obs, at: this.now() };
	}

	/** The weekly window as last observed, or null (nothing seen, or it already reset). */
	window(): UsageWindow | null {
		if (!this.last) return null;
		const { obs } = this.last;
		const resetsAt =
			obs.resetsAt === null
				? null
				: obs.resetsAt < 1e12
					? obs.resetsAt * 1000
					: obs.resetsAt;
		if (resetsAt !== null && resetsAt <= this.now()) return null;
		const usedPercent = obs.limited
			? 100
			: Math.min(100, Math.max(0, (obs.utilization ?? 0) * 100));
		return {
			label: CLAUDE_WEEKLY_LABEL,
			usedPercent,
			resetsAt,
			windowMinutes: WEEK_MINUTES,
			source: CLAUDE_WEEKLY_SOURCE,
		};
	}
}

export interface ClaudeWeeklyDeps {
	observer?: RateLimitObserver;
}

/** Never fails: no observation is an empty window list, which the monitor reports as unknown. */
export function claudeWeeklyProbe(deps: ClaudeWeeklyDeps = {}): UsageProbe {
	return {
		provider: "claude-cli",
		name: "Claude Code",
		available: async () => true,
		async run(): Promise<UsageProbeResult> {
			const w = deps.observer?.window() ?? null;
			return { accountLabel: null, windows: w ? [w] : [] };
		},
	};
}
