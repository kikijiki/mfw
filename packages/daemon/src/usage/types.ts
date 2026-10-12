/**
 * Subscription usage: the shapes the `UsageMonitor`, its probes, the API and
 * the UI share. A window is one rolling quota (5 hour session, 7 day week).
 */

export interface UsageWindow {
	/** "5h", "7d", "30d", or a scoped one such as "7d Sonnet". */
	label: string;
	/** 0..100, as the vendor reports it. */
	usedPercent: number;
	/** Epoch ms the window resets, or null when the vendor does not say. */
	resetsAt: number | null;
	/** Window length in minutes, or null when unknown. */
	windowMinutes: number | null;
	/** Which adapter produced it: `claude-oauth-usage`, `codex-app-server`. */
	source: string;
}

export type UsageStatus = "ok" | "stale" | "unavailable";

export interface UsageSubscription {
	/** The provider hold key / harness id: `claude-cli`, `codex-cli`. */
	provider: string;
	/** Display name: "Claude Code". */
	name: string;
	/** Plan or tier when the vendor says (`max`, `free`); never an email or id. */
	accountLabel: string | null;
	windows: UsageWindow[];
	/** When the windows were last read successfully; null when never. */
	fetchedAt: number | null;
	status: UsageStatus;
	/** Why the numbers are stale or missing. Never contains credentials. */
	error?: string;
}

export interface UsageProbeResult {
	accountLabel?: string | null;
	windows: UsageWindow[];
}

/**
 * One data source for one provider. `run` throws `UsageProbeError` for an
 * expected failure (not signed in, token expired, rate limited, bad shape);
 * its message is shown to the human, so it must not carry secrets.
 */
export interface UsageProbe {
	provider: string;
	name: string;
	/** Cheap local check: installed and signed in. False hides the provider. */
	available(): Promise<boolean>;
	run(signal: AbortSignal): Promise<UsageProbeResult>;
}

export class UsageProbeError extends Error {
	constructor(
		message: string,
		/** True when retrying soon will not help (signed out, token expired). */
		readonly permanent = false,
	) {
		super(message);
		this.name = "UsageProbeError";
	}
}

/** "5h", "7d", "30d", "90m" from a window length in minutes. */
export function windowLabel(minutes: number): string {
	if (!Number.isFinite(minutes) || minutes <= 0) return "?";
	if (minutes < 60) return `${Math.round(minutes)}m`;
	const hours = minutes / 60;
	if (hours < 48) return `${Math.round(hours)}h`;
	return `${Math.round(hours / 24)}d`;
}

export function clampPercent(n: number): number {
	return Math.min(100, Math.max(0, n));
}
