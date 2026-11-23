import { createHash } from "node:crypto";
import { z } from "zod";
import type { ResourceStore } from "./resources/store.ts";
import { ResourceError } from "./resources/types.ts";
import type { ProviderHold } from "./routing.ts";

/**
 * Machine-wide holds on provider accounts, as pool holds in the resource core.
 * A quota belongs to an account and one account serves every project here, so
 * a Claude limit hit in project A holds Claude in project B and never Codex.
 *
 * Keys are `routing.holdKeyOf(harness, endpoint)`. Each key is one pool, so a
 * hold parks exactly the work that needs that account. An unreadable hold
 * throws: it never reads as "no hold". The project-level `dispatch_hold`
 * (manual quiet periods, trigger `hold_dispatch`) still holds every provider
 * of that one project.
 *
 * A rate-limit or login message from a run is sandbox-reported: an agent can
 * forge it. {@link ProviderHoldStore.report} therefore holds only the reporting
 * project, for a short time, and becomes machine-wide only when a second
 * project reports the same account within a few minutes.
 */

/** The longest a hold taken from an agent's own report can last unconfirmed. */
export const MAX_REPORTED_HOLD_MS = 60 * 60_000;
/** Used when a report names no usable reset time. */
const REPORTED_HOLD_FALLBACK_MS = 15 * 60_000;
/** How close together two projects' reports must be to confirm each other. */
export const REPORT_CONFIRM_WINDOW_MS = 15 * 60_000;
const MAX_REPORTS_PER_KEY = 32;

/** The hold of one account in one project. Never read as a machine-wide key. */
export function projectHoldKey(key: string, project: string): string {
	return `${key}#project:${project}`;
}

const HoldDetailSchema = z.object({
	key: z.string(),
	reason: z.string(),
	runId: z.string().optional(),
	project: z.string().optional(),
	since: z.number().optional(),
});

export interface StoredProviderHold {
	until: number;
	reason: string;
	runId?: string;
	project?: string;
	since?: number;
}

const POOL_PREFIX = "provider.";

/** One pool per key; a hash keeps two keys that slug alike apart. */
export function providerPoolId(key: string): string {
	const slug = key
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^[^a-z0-9]+/, "")
		.slice(0, 48);
	const hash = createHash("sha256").update(key).digest("hex").slice(0, 8);
	return `${POOL_PREFIX}${slug || "x"}-${hash}`;
}

export class ProviderHoldStore {
	private chain: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly store: ResourceStore,
		private readonly now: () => number = () => Date.now(),
	) {}

	private serialized<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.chain.then(fn, fn);
		this.chain = run.catch(() => {});
		return run;
	}

	private async read(): Promise<
		Map<
			string,
			StoredProviderHold & { pool: string; kind: "budget" | "rate_limit" }
		>
	> {
		const out = new Map<
			string,
			StoredProviderHold & { pool: string; kind: "budget" | "rate_limit" }
		>();
		for (const hold of await this.store.holds()) {
			if (!hold.poolId.startsWith(POOL_PREFIX)) continue;
			if (hold.reason !== "budget" && hold.reason !== "rate_limit") continue;
			let detail: z.infer<typeof HoldDetailSchema>;
			try {
				detail = HoldDetailSchema.parse(JSON.parse(hold.detail));
			} catch {
				throw new ResourceError(
					`unreadable provider hold on ${hold.poolId}`,
					"CORRUPT",
				);
			}
			if (hold.until === null) {
				throw new ResourceError(
					`provider hold on ${hold.poolId} has no expiry`,
					"CORRUPT",
				);
			}
			const current = out.get(detail.key);
			if (current && current.until >= hold.until) continue;
			out.set(detail.key, {
				until: hold.until,
				reason: detail.reason,
				pool: hold.poolId,
				kind: hold.reason,
				...(detail.runId ? { runId: detail.runId } : {}),
				...(detail.project ? { project: detail.project } : {}),
				...(detail.since === undefined ? {} : { since: detail.since }),
			});
		}
		return out;
	}

	private public(hold: StoredProviderHold): StoredProviderHold {
		return {
			until: hold.until,
			reason: hold.reason,
			...(hold.runId ? { runId: hold.runId } : {}),
			...(hold.project ? { project: hold.project } : {}),
			...(hold.since === undefined ? {} : { since: hold.since }),
		};
	}

	private async place(
		key: string,
		hold: { until: number; reason: string; runId?: string; project?: string },
	): Promise<StoredProviderHold> {
		const current = (await this.read()).get(key);
		if (current && current.until >= hold.until) return this.public(current);
		const poolId = providerPoolId(key);
		await this.store.definePool({
			id: poolId,
			title: key,
			dimensions: [{ kind: "meter", name: "usage" }],
		});
		const kind = hold.reason === "budget" ? "budget" : "rate_limit";
		if (current && current.kind !== kind) {
			await this.store.clearHold(poolId, current.kind, "core");
		}
		const since = current?.since ?? this.now();
		await this.store.placeHold({
			poolId,
			reason: kind,
			actor: "core",
			until: hold.until,
			detail: JSON.stringify({
				key,
				reason: hold.reason,
				since,
				...(hold.runId ? { runId: hold.runId } : {}),
				...(hold.project ? { project: hold.project } : {}),
			}),
		});
		return this.public({ ...hold, since });
	}

	/**
	 * Hold `key` machine-wide until `until`, keeping the furthest existing
	 * `until`. For host-observed facts only; an agent's claim goes to `report`.
	 */
	hold(
		key: string,
		hold: { until: number; reason: string; runId?: string; project?: string },
	): Promise<StoredProviderHold> {
		return this.serialized(() => this.place(key, hold));
	}

	/**
	 * Record an agent's rate-limit or login report. The hold is clamped and
	 * covers the reporting project, unless another project reported the same
	 * account recently. `confirmedUntil` applies only to that confirmed case.
	 */
	report(
		key: string,
		report: {
			project: string;
			until: number;
			reason: string;
			runId?: string;
			confirmedUntil?: number;
		},
	): Promise<{ scope: "project" | "machine"; key: string; until: number }> {
		return this.serialized(async () => {
			const now = this.now();
			const projects = await this.store.recordProviderReport({
				key,
				project: report.project,
				windowMs: REPORT_CONFIRM_WINDOW_MS,
				maxPerKey: MAX_REPORTS_PER_KEY,
			});
			const confirmed = projects.length >= 2;
			const usable = Number.isFinite(report.until) && report.until > now;
			const clamped = usable
				? Math.min(report.until, now + MAX_REPORTED_HOLD_MS)
				: now + REPORTED_HOLD_FALLBACK_MS;
			const until = confirmed ? (report.confirmedUntil ?? clamped) : clamped;
			const holdKey = confirmed ? key : projectHoldKey(key, report.project);
			const next = await this.place(holdKey, {
				until,
				reason: report.reason,
				project: report.project,
				...(report.runId ? { runId: report.runId } : {}),
			});
			return {
				scope: confirmed ? "machine" : "project",
				key: holdKey,
				until: next.until,
			};
		});
	}

	/** The routing view of one project: machine holds plus its own. */
	forProject(project: string): {
		snapshot(): Promise<(key: string) => ProviderHold | null>;
	} {
		return {
			snapshot: async () => {
				const holds = await this.active();
				return (key) => {
					const candidates = [
						holds[key],
						holds[projectHoldKey(key, project)],
					].filter((h): h is StoredProviderHold => h !== undefined);
					if (candidates.length === 0) return null;
					const h = candidates.reduce((a, b) => (b.until > a.until ? b : a));
					return { until: h.until, reason: h.reason };
				};
			},
		};
	}

	clear(key: string): Promise<void> {
		return this.serialized(async () => {
			const poolId = providerPoolId(key);
			await this.store.clearHold(poolId, "rate_limit", "core");
			await this.store.clearHold(poolId, "budget", "core");
		});
	}

	/** Every hold still in force. */
	async active(): Promise<Record<string, StoredProviderHold>> {
		const held = await this.read();
		return Object.fromEntries(
			[...held].map(([key, hold]) => [key, this.public(hold)]),
		);
	}

	/** A synchronous lookup over one snapshot, the shape `routeRun` takes. */
	async snapshot(): Promise<(key: string) => ProviderHold | null> {
		const holds = await this.active();
		return (key) => {
			const h = holds[key];
			return h ? { until: h.until, reason: h.reason } : null;
		};
	}
}
