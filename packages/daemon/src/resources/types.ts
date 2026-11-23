import type { Dimension } from "../../../plugin-api/src/resource.ts";

/**
 * The unified resource model: one pool and lease model for locks, slots,
 * quantities, usage windows and meters. Plugins describe and observe; this
 * core decides and enforces.
 */

export const HOLD_REASONS = [
	"rate_limit",
	"auth",
	"budget",
	"observation-stale",
	"observation-failed",
	"observation-uncertain",
	"definition",
	"draining",
	"operator",
] as const;
export type HoldReason = (typeof HOLD_REASONS)[number];

/** Who acts on a hold. A plugin is never an actor: it can only report. */
export type HoldActor = "owner" | "core" | "brain";

export const LIVE_LEASE_STATES = [
	"provisional",
	"active",
	"uncertain",
	"releasing",
] as const;
export type ResourceLeaseState =
	| (typeof LIVE_LEASE_STATES)[number]
	| "released"
	| "reclaimed"
	| "force_released";

export interface PoolDefinition {
	id: string;
	title: string;
	dimensions: Dimension[];
	providerHardLimit?: boolean;
	/** When set, an older or missing observation holds the pool. */
	maxObservationAgeMs?: number | null;
}

/**
 * One requirement of a claim set. `amount` is in the dimension's natural unit;
 * a meter claim has no amount, and a window claim with `null` has no derivable
 * estimate and is refused.
 */
export interface Claim {
	poolId: string;
	dimension: string;
	amount?: number | null;
	/** A specific named unit of a slot dimension. */
	unit?: string;
}

export interface QuotaScope {
	scope: string;
	name: string;
}

export interface ClaimSetRequest {
	requestKey: string;
	projectId: string;
	claims: readonly Claim[];
	/** Extra quota levels; `project:<projectId>` is always included. */
	scopes?: readonly QuotaScope[];
}

export type BlockerCode =
	| "unknown-pool"
	| "unknown-dimension"
	| "held"
	| "exhausted"
	| "capacity"
	| "unit-unavailable"
	| "fifo";

export interface Blocker {
	code: BlockerCode;
	poolId: string;
	dimension?: string;
	/** Hold reason, or the quota level (`machine`, `project:x`) that refused. */
	detail?: string;
}

/**
 * `grantable` fits now. `blocked` waits its turn and holds its FIFO position.
 * `parked` cannot be served until a hold or exhausted limit changes, so it
 * keeps its sequence but does not block other waiters.
 */
export type AdmissionStatus = "grantable" | "blocked" | "parked";

export interface AdmissionVerdict {
	status: AdmissionStatus;
	blockers: Blocker[];
	/** Units chosen per `pool\0dimension` for named slots. */
	units: Map<string, string[]>;
}

export interface ResourceWaiter {
	id: string;
	requestKey: string;
	projectId: string;
	sequence: number;
	state: "waiting" | "granted" | "cancelled";
	scopes: QuotaScope[];
	claims: Claim[];
}

export interface ResourceLease {
	id: string;
	waiterId: string;
	projectId: string;
	state: ResourceLeaseState;
	fence: number;
	runId: string | null;
	grantedAt: number;
	activatedAt: number | null;
	lastRenewedAt: number | null;
	/** An inspection signal only: expiry never proves capacity is free. */
	expiresAt: number | null;
	releaseReason: string | null;
}

export interface ResourceHeld {
	kind: "held";
	waiterId: string;
	status: "blocked" | "parked";
	blockers: Blocker[];
}

export type LedgerState = "reserved" | "settled" | "estimated" | "void";

export interface LedgerEntry {
	id: string;
	entryKey: string;
	projectId: string;
	poolId: string;
	dimension: string;
	leaseId: string | null;
	state: LedgerState;
	amount: number;
	reservedAmount: number | null;
	atMs: number;
}

export interface PoolHold {
	id: string;
	poolId: string;
	reason: HoldReason;
	actor: HoldActor;
	detail: string;
	openedAt: number;
	until: number | null;
}

export interface Actual {
	poolId: string;
	dimension: string;
	/** `null` is unknown: the reservation stands as an estimated charge. */
	amount: number | null;
}

export type LeaseEvidence = "live" | "absent" | "unknown";

export interface ResourceReconcileReport {
	examined: number;
	adopted: number;
	reclaimed: number;
	uncertain: number;
	unchanged: number;
}

export interface DimensionSummary {
	name: string;
	kind: Dimension["kind"];
	capacity: number | null;
	used: number;
	settled: number;
	reserved: number;
	estimated: number;
	/** Meters only; `null` is unknown, never 0. */
	fraction: number | null;
}

export interface PoolSummary {
	poolId: string;
	title: string;
	providerHardLimit: boolean;
	holds: PoolHold[];
	dimensions: DimensionSummary[];
	queueDepth: number;
	parked: number;
	oldestWaitMs: number | null;
	observedAt: number | null;
}

/** Written before `provision`; closed only when an inventory proves absence. */
export interface CleanupRecord {
	ownershipToken: string;
	leaseId: string;
	poolId: string;
	projectId: string;
	externalId: string | null;
	state: "open" | "closed";
	teardownAttempts: number;
	lastError: string | null;
	createdAt: number;
}

export type ResourceErrorCode =
	| "REFUSED"
	| "NOT_FOUND"
	| "STALE_FENCE"
	| "INVALID_TRANSITION"
	| "CONFLICT"
	| "FORBIDDEN"
	| "CORRUPT"
	| "INCOMPATIBLE_SCHEMA"
	| "BUSY";

export class ResourceError extends Error {
	constructor(
		message: string,
		readonly code: ResourceErrorCode,
		/** What the owner can do about a refusal. */
		readonly fix?: string,
	) {
		super(message);
		this.name = "ResourceError";
	}
}
