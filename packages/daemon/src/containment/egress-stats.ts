/**
 * Per-run egress counters, kept by the host-side proxy in the run's host-only
 * directory: bytes up and down per destination and denied attempts. These are
 * host-observed, since the sandbox has no way to write them.
 *
 * Bounded whatever the agent does. Allowed destinations come from the
 * allowlist; denied names are the agent's choice, so only the first
 * {@link MAX_DENIED_HOSTS} are named and the rest are counted together.
 */

import { renameSync, writeFileSync } from "node:fs";
import { z } from "zod";
import type { EgressLogEntry } from "./egress-proxy.ts";

export const MAX_DENIED_HOSTS = 64;
export const MAX_ALLOWED_HOSTS = 256;
export const MAX_EGRESS_STATS_BYTES = 128 * 1024;

/** The destination of a refused request that never parsed to a host. */
export const UNPARSED_DESTINATION = "(unparsed)";
/** Where denied attempts past the cap are counted. */
export const OTHER_DESTINATION = "(other)";

const Count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Destination = z
	.string()
	.regex(/^(?:[a-z0-9.-]{1,253}:[0-9]{1,5}|\(unparsed\)|\(other\))$/);
const Reason = z.string().regex(/^[a-z0-9-]{1,64}$/);

const AllowedSchema = z.strictObject({
	bytesUp: Count,
	bytesDown: Count,
	connections: Count,
});
const DeniedSchema = z.strictObject({ count: Count, lastReason: Reason });

export const EgressStatsSchema = z.strictObject({
	version: z.literal(1),
	allowed: z
		.record(Destination, AllowedSchema)
		.refine((r) => Object.keys(r).length <= MAX_ALLOWED_HOSTS),
	denied: z
		.record(Destination, DeniedSchema)
		.refine((r) => Object.keys(r).length <= MAX_DENIED_HOSTS + 2),
	updatedAt: Count,
});

export type EgressStats = z.infer<typeof EgressStatsSchema>;

export const emptyEgressStats = (): EgressStats => ({
	version: 1,
	allowed: {},
	denied: {},
	updatedAt: 0,
});

/** Accumulates what the proxy reports. Byte counts arrive live, per chunk. */
export class EgressCounters {
	private dirty = false;

	constructor(private readonly stats: EgressStats = emptyEgressStats()) {}

	private allowedFor(host: string, port: number) {
		const key = `${host}:${port}`;
		let row = this.stats.allowed[key];
		if (!row) {
			row = { bytesUp: 0, bytesDown: 0, connections: 0 };
			this.stats.allowed[key] = row;
		}
		return row;
	}

	addBytes(host: string, port: number, up: number, down: number): void {
		const row = this.allowedFor(host, port);
		row.bytesUp = Math.min(row.bytesUp + up, Number.MAX_SAFE_INTEGER);
		row.bytesDown = Math.min(row.bytesDown + down, Number.MAX_SAFE_INTEGER);
		this.dirty = true;
	}

	record(entry: EgressLogEntry): void {
		if (entry.decision === "ALLOW") {
			if (entry.phase === "open") {
				this.allowedFor(entry.host, entry.port).connections++;
				this.dirty = true;
			}
			return;
		}
		const named =
			entry.host !== undefined && entry.port !== undefined
				? `${entry.host}:${entry.port}`
				: UNPARSED_DESTINATION;
		const named_known = this.stats.denied[named] !== undefined;
		const distinct = Object.keys(this.stats.denied).filter(
			(k) => k !== UNPARSED_DESTINATION && k !== OTHER_DESTINATION,
		).length;
		const key =
			named === UNPARSED_DESTINATION ||
			named_known ||
			distinct < MAX_DENIED_HOSTS
				? named
				: OTHER_DESTINATION;
		const row = this.stats.denied[key] ?? {
			count: 0,
			lastReason: entry.reason,
		};
		row.count = Math.min(row.count + 1, Number.MAX_SAFE_INTEGER);
		row.lastReason = entry.reason;
		this.stats.denied[key] = row;
		this.dirty = true;
	}

	/** Write the counters if they changed. Atomic, so a reader never sees half a file. */
	flush(path: string, now: number): void {
		if (!this.dirty) return;
		this.dirty = false;
		this.stats.updatedAt = now;
		const tmp = `${path}.tmp`;
		writeFileSync(tmp, JSON.stringify(this.stats), { mode: 0o600 });
		renameSync(tmp, path);
	}

	snapshot(): EgressStats {
		return structuredClone(this.stats);
	}
}

/** Parse a counters file. Null if it is absent, damaged or over the limits. */
export function parseEgressStats(text: string | null): EgressStats | null {
	if (text === null || text.length > MAX_EGRESS_STATS_BYTES) return null;
	try {
		return EgressStatsSchema.parse(JSON.parse(text));
	} catch {
		return null;
	}
}
