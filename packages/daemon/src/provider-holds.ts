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
 * throws: it never reads as "no hold".
 */

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

	/** Hold `key` until `until`, keeping the furthest existing `until`. */
	hold(
		key: string,
		hold: { until: number; reason: string; runId?: string; project?: string },
	): Promise<StoredProviderHold> {
		return this.serialized(async () => {
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
		});
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
