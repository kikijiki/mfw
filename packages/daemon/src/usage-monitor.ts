import type { Logger } from "./log.ts";
import type { StoredProviderHold } from "./provider-holds.ts";
import {
	type UsageProbe,
	UsageProbeError,
	type UsageSubscription,
	type UsageWindow,
} from "./usage/types.ts";

export type {
	UsageProbe,
	UsageStatus,
	UsageSubscription,
	UsageWindow,
} from "./usage/types.ts";

/**
 * `UsageMonitor`: how full each found subscription's rolling windows are
 * (Claude Code 5h and 7d, Codex's primary and secondary), for the sidebar
 * meters, the Fleet page and the brain's capacity read.
 *
 * Machine-wide, owned by the orchestrator, never per project: a subscription
 * is an account, and one account serves every project on the machine.
 *
 * Behaviour:
 *  - One loop, one tick at a time: a tick starts only after the previous one
 *    finished, at `intervalMs` with +-10% jitter. A provider is never probed
 *    while its previous probe is still running (single flight).
 *  - A failing provider backs off exponentially (`intervalMs` * 2^n, capped at
 *    `maxBackoffMs`); a permanent failure (signed out, expired login) waits at
 *    least `permanentBackoffMs`. One provider's failure never delays another.
 *  - Numbers are never invented: after a failure the last good windows stay
 *    for `maxStaleMs` as `stale` (expired windows dropped), then the provider
 *    is `unavailable` with no windows.
 *  - A window at 100% with a known reset holds the provider in the shared
 *    `ProviderHoldStore` until that reset (reason prefixed
 *    `USAGE_HOLD_PREFIX`). The monitor clears only holds it placed itself.
 *  - Probes cost no model tokens (see `usage/*`).
 */

export const USAGE_REFRESH_MS = 60_000;
export const USAGE_HOLD_PREFIX = "subscription usage";

export interface UsageHoldPort {
	hold(
		key: string,
		hold: { until: number; reason: string },
	): Promise<StoredProviderHold>;
	clear(key: string): Promise<void>;
	active(): Promise<Record<string, StoredProviderHold>>;
}

export interface UsageMonitorDeps {
	probes: readonly UsageProbe[];
	holds?: UsageHoldPort;
	log?: Pick<Logger, "warn" | "info" | "debug">;
	now?: () => number;
	/** Run `fn` after `ms`; returns a cancel. Defaults to an unref'd `setTimeout`. */
	schedule?: (fn: () => void, ms: number) => () => void;
	/** 0..1, for jitter. */
	random?: () => number;
	intervalMs?: number;
	maxBackoffMs?: number;
	permanentBackoffMs?: number;
	/** How long the last good windows may be shown as stale. */
	maxStaleMs?: number;
	/** Hard cap on one probe. */
	probeTimeoutMs?: number;
}

interface ProviderState {
	probe: UsageProbe;
	inFlight: Promise<void> | null;
	nextDueAt: number;
	failures: number;
	available: boolean;
	accountLabel: string | null;
	/** The last successful read. */
	good: { windows: UsageWindow[]; fetchedAt: number } | null;
	error: string | null;
}

function percentKey(w: UsageWindow): string {
	return `${w.label}:${Math.round(w.usedPercent)}:${w.resetsAt ?? ""}`;
}

export class UsageMonitor {
	private readonly states = new Map<string, ProviderState>();
	private readonly listeners = new Set<(s: UsageSubscription[]) => void>();
	private readonly now: () => number;
	private readonly schedule: (fn: () => void, ms: number) => () => void;
	private readonly random: () => number;
	private readonly intervalMs: number;
	private readonly maxBackoffMs: number;
	private readonly permanentBackoffMs: number;
	private readonly maxStaleMs: number;
	private readonly probeTimeoutMs: number;
	private cancel: (() => void) | null = null;
	private running = false;
	private stopped = true;
	private lastFingerprint = "";
	private tickInFlight: Promise<void> | null = null;

	constructor(private readonly deps: UsageMonitorDeps) {
		this.now = deps.now ?? Date.now;
		this.random = deps.random ?? Math.random;
		this.intervalMs = deps.intervalMs ?? USAGE_REFRESH_MS;
		this.maxBackoffMs = deps.maxBackoffMs ?? 15 * 60_000;
		this.permanentBackoffMs = deps.permanentBackoffMs ?? 5 * 60_000;
		this.maxStaleMs = deps.maxStaleMs ?? 30 * 60_000;
		this.probeTimeoutMs = deps.probeTimeoutMs ?? 30_000;
		this.schedule =
			deps.schedule ??
			((fn, ms) => {
				const t = setTimeout(fn, ms);
				t.unref?.();
				return () => clearTimeout(t);
			});
		for (const probe of deps.probes)
			this.states.set(probe.provider, {
				probe,
				inFlight: null,
				nextDueAt: 0,
				failures: 0,
				available: false,
				accountLabel: null,
				good: null,
				error: null,
			});
	}

	/** Probe once now, then keep going. Resolves after the first tick. */
	async start(): Promise<void> {
		if (!this.stopped) return;
		this.stopped = false;
		await this.runLoopTick();
	}

	stop(): void {
		this.stopped = true;
		this.cancel?.();
		this.cancel = null;
	}

	/** Subscribe to changes; the listener gets the whole snapshot. */
	subscribe(fn: (s: UsageSubscription[]) => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	/** Probe every provider that is not already being probed, due or not. */
	async refresh(): Promise<UsageSubscription[]> {
		await this.tick(true);
		return this.snapshot();
	}

	private async runLoopTick(): Promise<void> {
		if (this.running) return;
		this.running = true;
		try {
			await this.tick(false);
		} finally {
			this.running = false;
		}
		if (this.stopped) return;
		const jitter = 0.9 + this.random() * 0.2;
		this.cancel = this.schedule(
			() => void this.runLoopTick(),
			Math.round(this.intervalMs * jitter),
		);
	}

	/** One pass over the providers. Concurrent calls share the running pass. */
	tick(force = false): Promise<void> {
		if (this.tickInFlight) return this.tickInFlight;
		const p = this.tickNow(force).finally(() => {
			this.tickInFlight = null;
		});
		this.tickInFlight = p;
		return p;
	}

	private async tickNow(force: boolean): Promise<void> {
		await Promise.all(
			[...this.states.values()].map((s) => this.probeOne(s, force)),
		);
		this.emitIfChanged();
	}

	private probeOne(s: ProviderState, force: boolean): Promise<void> {
		if (s.inFlight) return s.inFlight;
		if (!force && this.now() < s.nextDueAt) return Promise.resolve();
		const p = this.doProbe(s).finally(() => {
			s.inFlight = null;
		});
		s.inFlight = p;
		return p;
	}

	private async doProbe(s: ProviderState): Promise<void> {
		const started = this.now();
		try {
			s.available = await s.probe.available();
		} catch {
			s.available = false;
		}
		if (!s.available) {
			// Not installed or not signed in: hidden, rechecked next pass.
			s.good = null;
			s.error = null;
			s.failures = 0;
			s.nextDueAt = started + this.intervalMs;
			return;
		}
		try {
			const signal = AbortSignal.timeout(this.probeTimeoutMs);
			const result = await s.probe.run(signal);
			const at = this.now();
			s.good = { windows: result.windows, fetchedAt: at };
			s.accountLabel = result.accountLabel ?? null;
			s.error = null;
			s.failures = 0;
			s.nextDueAt = at + this.intervalMs;
			await this.syncHold(s, result.windows, at);
		} catch (error) {
			const at = this.now();
			s.failures += 1;
			s.error =
				error instanceof UsageProbeError ? error.message : "usage probe failed";
			if (!(error instanceof UsageProbeError))
				this.deps.log?.warn(
					{ provider: s.probe.provider },
					"usage probe failed unexpectedly",
				);
			const base = Math.min(
				this.intervalMs * 2 ** s.failures,
				this.maxBackoffMs,
			);
			const permanent = error instanceof UsageProbeError && error.permanent;
			s.nextDueAt =
				at + (permanent ? Math.max(base, this.permanentBackoffMs) : base);
		}
	}

	private async syncHold(
		s: ProviderState,
		windows: readonly UsageWindow[],
		at: number,
	): Promise<void> {
		const holds = this.deps.holds;
		if (!holds) return;
		try {
			const full = windows.filter(
				(w) => w.usedPercent >= 100 && w.resetsAt !== null && w.resetsAt > at,
			);
			if (full.length > 0) {
				const worst = full.reduce((a, b) =>
					(b.resetsAt as number) > (a.resetsAt as number) ? b : a,
				);
				await holds.hold(s.probe.provider, {
					until: worst.resetsAt as number,
					reason: `${USAGE_HOLD_PREFIX}: ${worst.label} window used up`,
				});
				return;
			}
			const current = (await holds.active())[s.probe.provider];
			if (current?.reason.startsWith(USAGE_HOLD_PREFIX))
				await holds.clear(s.probe.provider);
		} catch (error) {
			this.deps.log?.warn(
				{ provider: s.probe.provider, err: String(error) },
				"usage hold sync failed",
			);
		}
	}

	/** What is known now, per found subscription. Never probes. */
	snapshot(): UsageSubscription[] {
		const now = this.now();
		const out: UsageSubscription[] = [];
		for (const s of this.states.values()) {
			if (!s.available && !s.good && s.error === null) {
				// Never found available, or since signed out: not a subscription here.
				continue;
			}
			const base = {
				provider: s.probe.provider,
				name: s.probe.name,
				accountLabel: s.accountLabel,
			};
			if (s.good && s.error === null) {
				out.push({
					...base,
					windows: s.good.windows,
					fetchedAt: s.good.fetchedAt,
					status: "ok",
				});
				continue;
			}
			// Failing: the last good numbers are shown as stale for a while.
			if (s.good && now - s.good.fetchedAt < this.maxStaleMs) {
				const live = s.good.windows.filter(
					(w) => w.resetsAt === null || w.resetsAt > now,
				);
				if (live.length > 0) {
					out.push({
						...base,
						windows: live,
						fetchedAt: s.good.fetchedAt,
						status: "stale",
						...(s.error ? { error: s.error } : {}),
					});
					continue;
				}
			}
			out.push({
				...base,
				windows: [],
				fetchedAt: s.good?.fetchedAt ?? null,
				status: "unavailable",
				error: s.error ?? "no data yet",
			});
		}
		return out;
	}

	private fingerprint(subs: readonly UsageSubscription[]): string {
		return JSON.stringify(
			subs.map((x) => [
				x.provider,
				x.status,
				x.error ?? null,
				x.accountLabel,
				x.windows.map(percentKey),
			]),
		);
	}

	private emitIfChanged(): void {
		const snap = this.snapshot();
		const fp = this.fingerprint(snap);
		if (fp === this.lastFingerprint) return;
		this.lastFingerprint = fp;
		for (const fn of this.listeners) {
			try {
				fn(snap);
			} catch {
				// a listener must not break the monitor
			}
		}
	}
}
