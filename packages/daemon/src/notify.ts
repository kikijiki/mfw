import type { Logger } from "./log.ts";
import { runProc } from "./proc.ts";

/**
 * Notifications. Every attempt yields a `DeliveryResult`; failures (including
 * non-2xx) are logged, counted, and exposed on the Health surface so a broken
 * notifier is noticed before it is needed.
 */

export interface Notification {
	type: "blocked" | "review" | "clarify" | "main_red" | "merge_parked";
	project: string;
	taskId?: string | null;
	runId?: string | null;
	message: string;
}

export interface DeliveryResult {
	sink: "webhook" | "command";
	ok: boolean;
	detail?: string;
	durationMs: number;
}

export interface NotifyConfig {
	/** POST the notification JSON here. Non-2xx counts as a FAILURE. */
	webhook?: string;
	/** Run this shell command with MFW_NOTIFY_* env vars. Nonzero exit fails. */
	command?: string;
	/** Per-sink timeout; a hung sink must not wedge finalization. */
	timeoutMs?: number;
}

export interface Notifier {
	notify(
		kind: string,
		detail: Record<string, unknown>,
	): Promise<DeliveryResult[]>;
	send(n: Notification): Promise<DeliveryResult[]>;
	stats(): NotifierStats;
}

export interface NotifierStats {
	sent: number;
	delivered: number;
	failed: number;
	lastFailure: { at: number; sink: string; detail: string } | null;
	configured: boolean;
}

export function hasNotifySink(cfg?: NotifyConfig): boolean {
	return !!(cfg?.webhook || cfg?.command);
}

export class ConfigNotifier implements Notifier {
	private counters = { sent: 0, delivered: 0, failed: 0 };
	private lastFailure: NotifierStats["lastFailure"] = null;

	constructor(
		private readonly cfg: NotifyConfig,
		private readonly log: Logger,
	) {}

	/** Convenience shape used by the finalization steps. */
	async notify(
		kind: string,
		detail: Record<string, unknown>,
	): Promise<DeliveryResult[]> {
		return this.send({
			type: (kind as Notification["type"]) ?? "blocked",
			project: String(detail.project ?? ""),
			taskId: detail.taskId as string | undefined,
			runId: detail.runId as string | undefined,
			message: String(detail.message ?? kind),
		});
	}

	async send(n: Notification): Promise<DeliveryResult[]> {
		const timeoutMs = this.cfg.timeoutMs ?? 15_000;
		const jobs: Promise<DeliveryResult>[] = [];

		if (this.cfg.webhook) jobs.push(this.postWebhook(n, timeoutMs));
		if (this.cfg.command) jobs.push(this.runCommand(n, timeoutMs));

		const results = await Promise.all(jobs);
		this.counters.sent += results.length;
		for (const r of results) {
			if (r.ok) {
				this.counters.delivered++;
				continue;
			}
			this.counters.failed++;
			this.lastFailure = {
				at: Date.now(),
				sink: r.sink,
				detail: r.detail ?? "unknown",
			};
			this.log.error(
				{ sink: r.sink, detail: r.detail, notification: n },
				"notification delivery FAILED",
			);
		}
		return results;
	}

	private async postWebhook(
		n: Notification,
		timeoutMs: number,
	): Promise<DeliveryResult> {
		const t0 = Date.now();
		try {
			const res = await fetch(this.cfg.webhook as string, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(n),
				signal: AbortSignal.timeout(timeoutMs),
			});
			return {
				sink: "webhook",
				// A non-2xx from the sink is not a delivery.
				ok: res.ok,
				detail: res.ok ? undefined : `HTTP ${res.status}`,
				durationMs: Date.now() - t0,
			};
		} catch (e) {
			return {
				sink: "webhook",
				ok: false,
				detail: e instanceof Error ? e.message : String(e),
				durationMs: Date.now() - t0,
			};
		}
	}

	private async runCommand(
		n: Notification,
		timeoutMs: number,
	): Promise<DeliveryResult> {
		const t0 = Date.now();
		try {
			const r = await runProc(["sh", "-c", this.cfg.command as string], {
				timeoutMs,
				env: {
					...process.env,
					MFW_NOTIFY_TYPE: n.type,
					MFW_NOTIFY_PROJECT: n.project,
					MFW_NOTIFY_TASK: n.taskId ?? "",
					MFW_NOTIFY_RUN: n.runId ?? "",
					MFW_NOTIFY_MESSAGE: n.message,
				},
			});
			return {
				sink: "command",
				ok: r.exitCode === 0 && !r.timedOut,
				detail:
					r.exitCode === 0 && !r.timedOut
						? undefined
						: r.timedOut
							? `timed out after ${timeoutMs}ms`
							: `exit ${r.exitCode}: ${r.stderr.slice(-200)}`,
				durationMs: Date.now() - t0,
			};
		} catch (e) {
			return {
				sink: "command",
				ok: false,
				detail: e instanceof Error ? e.message : String(e),
				durationMs: Date.now() - t0,
			};
		}
	}

	stats(): NotifierStats {
		return {
			...this.counters,
			lastFailure: this.lastFailure,
			configured: true,
		};
	}
}

/** No sink configured; `configured: false` tells Health there is no escalation channel (distinct from a failing one). */
export class NoopNotifier implements Notifier {
	private sent = 0;
	async notify(): Promise<DeliveryResult[]> {
		this.sent++;
		return [];
	}
	async send(): Promise<DeliveryResult[]> {
		this.sent++;
		return [];
	}
	stats(): NotifierStats {
		return {
			sent: this.sent,
			delivered: 0,
			failed: 0,
			lastFailure: null,
			configured: false,
		};
	}
}

export function makeNotifier(
	cfg: NotifyConfig | undefined,
	log: Logger,
): Notifier {
	return hasNotifySink(cfg)
		? new ConfigNotifier(cfg as NotifyConfig, log)
		: new NoopNotifier();
}
