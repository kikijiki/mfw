import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	type Client,
	createClient,
	type InValue,
	type Row,
	type Transaction,
} from "@libsql/client";
import { parsePoolId, parseQuotaRef } from "../../../plugin-api/src/pool-id.ts";
import {
	capacityRaised,
	type Dimension,
	type DimensionObservation,
	DimensionSchema,
	type Observation,
	ObservationSchema,
} from "../../../plugin-api/src/resource.ts";
import {
	type AdmissionSnapshot,
	type DimensionState,
	decide,
	dimensionKey,
	fitsEveryLevel,
	type QueuedWaiter,
	scopeKey,
} from "./admission.ts";
import { fromStored, toStored } from "./amounts.ts";
import type { ObservationHealth, StoredObservation } from "./host-types.ts";
import { RAM_OBSERVATION_MAX_AGE_MS } from "./quantity.ts";
import {
	RESOURCE_CLEANUP_SCHEMA,
	RESOURCE_INCIDENT_SCHEMA,
	RESOURCE_PROBE_SCHEMA,
	RESOURCE_SCHEMA,
	RESOURCE_SCHEMA_VERSION,
} from "./schema.ts";
import {
	type Actual,
	type AdmissionVerdict,
	type Claim,
	type ClaimSetRequest,
	type CleanupRecord,
	type DimensionSummary,
	HOLD_REASONS,
	type HoldActor,
	type HoldReason,
	type LeaseEvidence,
	type LedgerEntry,
	type LedgerState,
	LIVE_LEASE_STATES,
	type PoolDefinition,
	type PoolHold,
	type PoolIncident,
	type PoolIncidentKind,
	type PoolSummary,
	type QuotaScope,
	REMOTE_RUN_SESSION_PREFIX,
	ResourceError,
	type ResourceHeld,
	type ResourceLease,
	type ResourceLeaseState,
	type ResourceReconcileReport,
	type ResourceWaiter,
	type RunIdentity,
} from "./types.ts";
import { assertValidWindow, windowStart } from "./windows.ts";

type Target = Client | Transaction;

const LIVE_SQL = LIVE_LEASE_STATES.map((s) => `'${s}'`).join(",");

async function all(target: Target, sql: string, args: InValue[] = []) {
	return (await target.execute({ sql, args })).rows;
}

async function one(target: Target, sql: string, args: InValue[] = []) {
	return (await all(target, sql, args))[0] ?? null;
}

function str(value: unknown, what: string): string {
	if (typeof value !== "string") {
		throw new ResourceError(`corrupt resource row: ${what}`, "CORRUPT");
	}
	return value;
}

function int(value: unknown, what: string): number {
	const n = typeof value === "bigint" ? Number(value) : value;
	if (typeof n !== "number" || !Number.isSafeInteger(n)) {
		throw new ResourceError(`corrupt resource row: ${what}`, "CORRUPT");
	}
	return n;
}

function intOrNull(value: unknown, what: string): number | null {
	return value === null || value === undefined ? null : int(value, what);
}

function parsed<T>(value: unknown, what: string): T {
	try {
		return JSON.parse(str(value, what)) as T;
	} catch (error) {
		if (error instanceof ResourceError) throw error;
		throw new ResourceError(`corrupt resource row: ${what}`, "CORRUPT");
	}
}

function holdFrom(row: Row): PoolHold {
	const reason = str(row.reason, "hold reason");
	if (!(HOLD_REASONS as readonly string[]).includes(reason)) {
		// A hold we cannot read must not read as "no hold".
		throw new ResourceError(`corrupt hold reason '${reason}'`, "CORRUPT");
	}
	return {
		id: str(row.id, "hold id"),
		poolId: str(row.pool_id, "hold pool"),
		reason: reason as HoldReason,
		actor: str(row.actor, "hold actor") as HoldActor,
		detail: str(row.detail, "hold detail"),
		openedAt: int(row.opened_at, "hold opened_at"),
		until: intOrNull(row.until, "hold until"),
	};
}

function leaseFrom(row: Row): ResourceLease {
	return {
		id: str(row.id, "lease id"),
		waiterId: str(row.waiter_id, "lease waiter"),
		projectId: str(row.project_id, "lease project"),
		state: str(row.state, "lease state") as ResourceLeaseState,
		fence: int(row.fence, "lease fence"),
		runId: row.run_id === null ? null : str(row.run_id, "lease run"),
		run:
			row.run_json === null || row.run_json === undefined
				? null
				: parsed<RunIdentity>(row.run_json, "lease run identity"),
		ownerBootId:
			row.owner_boot_id === null || row.owner_boot_id === undefined
				? null
				: str(row.owner_boot_id, "lease owner boot"),
		grantedAt: int(row.granted_at, "lease granted_at"),
		activatedAt: intOrNull(row.activated_at, "lease activated_at"),
		lastRenewedAt: intOrNull(row.last_renewed_at, "lease last_renewed_at"),
		expiresAt: intOrNull(row.expires_at, "lease expires_at"),
		releaseReason:
			row.release_reason === null
				? null
				: str(row.release_reason, "lease release_reason"),
	};
}

function ledgerFrom(row: Row): LedgerEntry {
	return {
		id: str(row.id, "ledger id"),
		entryKey: str(row.entry_key, "ledger key"),
		projectId: str(row.project_id, "ledger project"),
		poolId: str(row.pool_id, "ledger pool"),
		dimension: str(row.dimension, "ledger dimension"),
		leaseId: row.lease_id === null ? null : str(row.lease_id, "ledger lease"),
		state: str(row.state, "ledger state") as LedgerState,
		amount: int(row.amount, "ledger amount"),
		reservedAmount: intOrNull(row.reserved_amount, "ledger reserved"),
		atMs: int(row.at_ms, "ledger at_ms"),
	};
}

function capacityOf(d: Dimension): number {
	switch (d.kind) {
		case "slot":
			return toStored("slot", d.total);
		case "quantity":
			return toStored("quantity", d.total);
		case "window":
			return toStored("window", d.limit);
		case "meter":
			return 0;
	}
}

function withProjectScope(
	projectId: string,
	scopes: readonly QuotaScope[] = [],
): QuotaScope[] {
	const out = new Map<string, QuotaScope>();
	for (const s of [{ scope: "project", name: projectId }, ...scopes]) {
		out.set(scopeKey(s), { scope: s.scope, name: s.name });
	}
	return [...out.values()].sort((a, b) =>
		scopeKey(a).localeCompare(scopeKey(b)),
	);
}

interface StoredClaim extends Claim {
	amount: number;
}

interface DimensionRow {
	spec: Dimension;
	capacity: number;
}

export interface HostConfigRows {
	hostId: string | null;
	generation: number;
	definitions: string[];
	bindings: string[];
}

export interface ResourceAuditEntry {
	seq: number;
	at: number;
	action: string;
	actor: string;
	poolId: string | null;
	leaseId: string | null;
	detail: Record<string, unknown>;
}

export interface OpenResourceStoreOptions {
	now?: () => number;
	busyTimeoutMs?: number;
	/** This daemon process; a lease from another boot is recovered, not trusted. */
	processBootId?: string;
	kernelBootId?: string | null;
}

function canonicalJson(value: unknown): string {
	return JSON.stringify(value ?? {}, (_key, nested) => {
		if (typeof nested === "bigint") return nested.toString();
		if (nested === null || typeof nested !== "object" || Array.isArray(nested))
			return nested;
		return Object.fromEntries(
			Object.keys(nested as Record<string, unknown>)
				.sort()
				.map((key) => [key, (nested as Record<string, unknown>)[key]]),
		);
	});
}

function probeJson(value: unknown): string {
	return JSON.stringify(value ?? {}, (_key, nested) =>
		typeof nested === "bigint" ? nested.toString() : nested,
	);
}

function probeGeneration(detail: Record<string, unknown> | null | undefined) {
	const generation = detail?.generation as
		| Record<string, unknown>
		| null
		| undefined;
	if (
		typeof generation?.processBootId !== "string" ||
		(generation.kernelBootId !== null &&
			typeof generation.kernelBootId !== "string") ||
		typeof generation.sequence !== "string" ||
		!/^(?:0|[1-9][0-9]*)$/.test(generation.sequence)
	) {
		return null;
	}
	return {
		processBootId: generation.processBootId,
		kernelBootId: generation.kernelBootId as string | null,
		sequence: BigInt(generation.sequence),
	};
}

/** Health detail without the fields that change on every healthy poll. */
function meaningfulProbeDetail(
	detail: Record<string, unknown> | null | undefined,
): string {
	const {
		generation: _generation,
		freshness: _freshness,
		...rest
	} = detail ?? {};
	return canonicalJson(rest);
}

function probeSampleFrom(row: Record<string, unknown>): StoredObservation {
	return {
		bindingId: str(row.binding_id, "probe binding"),
		kind: str(row.kind, "probe kind"),
		sequence: BigInt(row.sequence as bigint),
		result: str(row.result, "probe result") as StoredObservation["result"],
		processBootId: str(row.process_boot_id, "probe boot"),
		kernelBootId:
			row.kernel_boot_id === null
				? null
				: str(row.kernel_boot_id, "probe kernel"),
		observedAt: int(row.observed_at, "probe observed"),
		durationMs: int(row.duration_ms, "probe duration"),
		metrics: parsed<Record<string, unknown>>(row.metrics_json, "probe metrics"),
		occupants: parsed<unknown[]>(row.occupants_json, "probe occupants"),
		warnings: parsed<string[]>(row.warnings_json, "probe warnings"),
		adapterVersion:
			row.adapter_version === null
				? null
				: str(row.adapter_version, "probe adapter"),
	};
}

/** The same observed facts, ignoring when and in which generation. */
function sameProbeContent(a: StoredObservation, b: StoredObservation): boolean {
	return (
		a.kind === b.kind &&
		a.result === b.result &&
		a.processBootId === b.processBootId &&
		a.kernelBootId === b.kernelBootId &&
		(a.adapterVersion ?? null) === (b.adapterVersion ?? null) &&
		canonicalJson(a.metrics) === canonicalJson(b.metrics) &&
		canonicalJson(a.occupants) === canonicalJson(b.occupants) &&
		canonicalJson(a.warnings) === canonicalJson(b.warnings)
	);
}

function sameProbeSample(a: StoredObservation, b: StoredObservation): boolean {
	return (
		a.sequence === b.sequence &&
		a.observedAt === b.observedAt &&
		a.durationMs === b.durationMs &&
		sameProbeContent(a, b)
	);
}

async function writeProbeHealth(
	tx: Transaction,
	health: ObservationHealth,
): Promise<void> {
	await tx.execute({
		sql: `INSERT INTO rp_probe_health(kind,result,checked_at,process_boot_id,kernel_boot_id,detail_json)
		      VALUES(?,?,?,?,?,?) ON CONFLICT(kind) DO UPDATE SET result=excluded.result,
		        checked_at=excluded.checked_at, process_boot_id=excluded.process_boot_id,
		        kernel_boot_id=excluded.kernel_boot_id, detail_json=excluded.detail_json`,
		args: [
			health.kind,
			health.result,
			health.checkedAt,
			health.processBootId,
			health.kernelBootId,
			probeJson(health.detail),
		],
	});
}

async function writeProbeSample(
	tx: Transaction,
	sample: StoredObservation,
): Promise<void> {
	await tx.execute({
		sql: `INSERT INTO rp_probe_samples(binding_id,kind,sequence,result,observed_at,duration_ms,process_boot_id,kernel_boot_id,adapter_version,metrics_json,occupants_json,warnings_json)
		      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
		      ON CONFLICT(binding_id) DO UPDATE SET kind=excluded.kind, sequence=excluded.sequence,
		        result=excluded.result, observed_at=excluded.observed_at, duration_ms=excluded.duration_ms,
		        process_boot_id=excluded.process_boot_id, kernel_boot_id=excluded.kernel_boot_id,
		        adapter_version=excluded.adapter_version, metrics_json=excluded.metrics_json,
		        occupants_json=excluded.occupants_json, warnings_json=excluded.warnings_json`,
		args: [
			sample.bindingId,
			sample.kind,
			sample.sequence,
			sample.result,
			sample.observedAt,
			sample.durationMs,
			sample.processBootId,
			sample.kernelBootId,
			sample.adapterVersion ?? null,
			probeJson(sample.metrics),
			JSON.stringify(sample.occupants, (_key, nested) =>
				typeof nested === "bigint" ? nested.toString() : nested,
			),
			JSON.stringify(sample.warnings),
		],
	});
}

/** Incident contexts carry exact byte counts, which JSON numbers cannot. */
function encodeIncidentContext(context: Record<string, unknown>): string {
	return JSON.stringify(context, (_key, value) =>
		typeof value === "bigint" ? { $bigint: value.toString() } : value,
	);
}

function decodeIncidentContext(text: string): Record<string, unknown> {
	return JSON.parse(text, (_key, value) =>
		value !== null &&
		typeof value === "object" &&
		typeof value.$bigint === "string"
			? BigInt(value.$bigint)
			: value,
	);
}

export class ResourceStore {
	private queue: Promise<unknown> = Promise.resolve();
	private closed = false;

	constructor(
		private readonly client: Client,
		readonly path: string,
		private readonly now: () => number,
		private readonly busyTimeoutMs: number,
		readonly processBootId: string = randomUUID(),
		readonly kernelBootId: string | null = null,
	) {}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.client.close();
	}

	private withWrite<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
		if (this.closed) {
			return Promise.reject(new ResourceError("store is closed", "CONFLICT"));
		}
		const next = this.queue.then(
			() => this.writeNow(fn),
			() => this.writeNow(fn),
		);
		this.queue = next.catch(() => {});
		return next;
	}

	private async writeNow<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
		const started = performance.now();
		for (;;) {
			let tx: Transaction | null = null;
			try {
				tx = await this.client.transaction("write"); // BEGIN IMMEDIATE
				const result = await fn(tx);
				await tx.commit();
				return result;
			} catch (error) {
				if (tx && !tx.closed) await tx.rollback().catch(() => {});
				const busy =
					!(error instanceof ResourceError) &&
					/busy|locked/i.test(
						error instanceof Error ? error.message : String(error),
					);
				if (!busy) throw error;
				if (performance.now() - started >= this.busyTimeoutMs) {
					throw new ResourceError("resource store lock unavailable", "BUSY");
				}
				await new Promise((resolve) => setTimeout(resolve, 5));
			} finally {
				tx?.close();
			}
		}
	}

	private async audit(
		tx: Transaction,
		action: string,
		actor: string,
		refs: { poolId?: string; leaseId?: string },
		detail: Record<string, unknown> = {},
	): Promise<void> {
		await tx.execute({
			sql: "INSERT INTO rp_audit(at_ms,action,actor,pool_id,lease_id,detail_json) VALUES(?,?,?,?,?,?)",
			args: [
				this.now(),
				action,
				actor,
				refs.poolId ?? null,
				refs.leaseId ?? null,
				JSON.stringify(detail),
			],
		});
	}

	// Definitions

	/** Creates or updates a pool the owner confirmed. Unknown shapes refuse. */
	async definePool(definition: PoolDefinition): Promise<void> {
		if (!parsePoolId(definition.id)) {
			throw new ResourceError(`invalid pool id '${definition.id}'`, "REFUSED");
		}
		const dimensions = definition.dimensions.map((d) =>
			DimensionSchema.parse(d),
		);
		if (dimensions.length === 0) {
			throw new ResourceError("a pool needs a dimension", "REFUSED");
		}
		if (new Set(dimensions.map((d) => d.name)).size !== dimensions.length) {
			throw new ResourceError("duplicate dimension name", "REFUSED");
		}
		for (const d of dimensions) {
			if (d.kind === "window") assertValidWindow(d.window);
			if (d.kind === "slot" && d.units && d.units.length !== d.total) {
				throw new ResourceError(
					`slot '${d.name}' names ${d.units.length} units for a total of ${d.total}`,
					"REFUSED",
				);
			}
		}
		await this.withWrite(async (tx) => {
			const now = this.now();
			await tx.execute({
				sql: `INSERT INTO rp_pools(id,title,provider_hard_limit,max_observation_age_ms,created_at,updated_at)
				      VALUES(?,?,?,?,?,?)
				      ON CONFLICT(id) DO UPDATE SET title=excluded.title,
				        provider_hard_limit=excluded.provider_hard_limit,
				        max_observation_age_ms=excluded.max_observation_age_ms,
				        version=version+1, updated_at=excluded.updated_at`,
				args: [
					definition.id,
					definition.title,
					definition.providerHardLimit ? 1 : 0,
					definition.maxObservationAgeMs ?? null,
					now,
					now,
				],
			});
			const existing = await all(
				tx,
				"SELECT name, kind, spec_json FROM rp_dimensions WHERE pool_id=?",
				[definition.id],
			);
			const next = new Map(dimensions.map((d) => [d.name, d]));
			const unchanged =
				existing.length === dimensions.length &&
				existing.every(
					(row) =>
						row.spec_json ===
						JSON.stringify(next.get(str(row.name, "dimension name"))),
				);
			for (const row of existing) {
				const name = str(row.name, "dimension name");
				const replacement = next.get(name);
				if (!replacement || replacement.kind !== row.kind) {
					// Claims, leases and ledger rows refer to dimensions by name.
					throw new ResourceError(
						`dimension '${name}' of '${definition.id}' cannot be removed or change kind`,
						"CONFLICT",
					);
				}
			}
			for (const d of dimensions) {
				await tx.execute({
					sql: `INSERT INTO rp_dimensions(pool_id,name,kind,capacity,spec_json) VALUES(?,?,?,?,?)
					      ON CONFLICT(pool_id,name) DO UPDATE SET capacity=excluded.capacity, spec_json=excluded.spec_json`,
					args: [
						definition.id,
						d.name,
						d.kind,
						capacityOf(d),
						JSON.stringify(d),
					],
				});
			}
			// Re-registering the same shape at boot is not an event.
			if (!unchanged) {
				await this.audit(tx, "pool.defined", "owner", {
					poolId: definition.id,
				});
			}
		});
	}

	/**
	 * Sets a child quota, addressed `<pool>/<scope>:<name>`. A child can only
	 * narrow its parent; siblings may together overcommit it.
	 */
	async setQuota(ref: string, dimension: string, limit: number): Promise<void> {
		const parsedRef = parseQuotaRef(ref);
		if (!parsedRef?.scope || !parsedRef.name) {
			throw new ResourceError(`invalid quota ref '${ref}'`, "REFUSED");
		}
		const { pool, scope, name } = parsedRef;
		await this.withWrite(async (tx) => {
			const dim = await this.dimensionRow(tx, pool, dimension);
			if (dim.spec.kind === "meter") {
				throw new ResourceError("a meter has no quota", "REFUSED");
			}
			const stored = toStored(dim.spec.kind, limit);
			if (stored > dim.capacity) {
				throw new ResourceError(
					`quota ${ref} exceeds its pool's limit`,
					"REFUSED",
				);
			}
			await tx.execute({
				sql: `INSERT INTO rp_quotas(pool_id,dimension,scope,name,limit_amount,updated_at) VALUES(?,?,?,?,?,?)
				      ON CONFLICT(pool_id,dimension,scope,name) DO UPDATE SET limit_amount=excluded.limit_amount, updated_at=excluded.updated_at`,
				args: [pool, dimension, scope, name, stored, this.now()],
			});
			await this.audit(
				tx,
				"quota.set",
				"owner",
				{ poolId: pool },
				{
					dimension,
					scope,
					name,
					limit: stored,
				},
			);
		});
	}

	private async dimensionRow(
		target: Target,
		poolId: string,
		dimension: string,
	): Promise<DimensionRow> {
		const row = await one(
			target,
			"SELECT capacity, spec_json FROM rp_dimensions WHERE pool_id=? AND name=?",
			[poolId, dimension],
		);
		if (!row) {
			throw new ResourceError(
				`unknown resource '${poolId}' dimension '${dimension}'`,
				"REFUSED",
				"define the pool or correct the claim",
			);
		}
		return {
			spec: parsed<Dimension>(row.spec_json, "dimension spec"),
			capacity: int(row.capacity, "dimension capacity"),
		};
	}

	// Holds

	/** The brain may add an operator hold, and nothing else. */
	async placeHold(input: {
		poolId: string;
		reason: HoldReason;
		actor: HoldActor;
		detail?: string;
		until?: number | null;
	}): Promise<PoolHold> {
		if (input.actor === "brain" && input.reason !== "operator") {
			throw new ResourceError(
				"the brain may only add operator holds",
				"FORBIDDEN",
			);
		}
		return this.withWrite(async (tx) => {
			const pool = await one(tx, "SELECT id FROM rp_pools WHERE id=?", [
				input.poolId,
			]);
			if (!pool) {
				throw new ResourceError(`unknown pool '${input.poolId}'`, "NOT_FOUND");
			}
			const now = this.now();
			const open = await one(
				tx,
				"SELECT * FROM rp_holds WHERE pool_id=? AND reason=? AND cleared_at IS NULL",
				[input.poolId, input.reason],
			);
			if (open) {
				// Re-placing keeps the longer of the two: an indefinite hold stays so.
				const current = intOrNull(open.until, "hold until");
				const requested = input.until ?? null;
				const expired = current !== null && current <= now;
				const until = expired
					? requested
					: current === null || requested === null
						? null
						: Math.max(current, requested);
				const row = await one(
					tx,
					"UPDATE rp_holds SET until=?, detail=?, actor=? WHERE id=? RETURNING *",
					[until, input.detail ?? "", input.actor, str(open.id, "hold id")],
				);
				await this.audit(
					tx,
					"hold.extended",
					input.actor,
					{
						poolId: input.poolId,
					},
					{ reason: input.reason, until },
				);
				return holdFrom(row as Row);
			}
			const row = await one(
				tx,
				`INSERT INTO rp_holds(id,pool_id,reason,actor,detail,opened_at,until)
				 VALUES(?,?,?,?,?,?,?) RETURNING *`,
				[
					randomUUID(),
					input.poolId,
					input.reason,
					input.actor,
					input.detail ?? "",
					now,
					input.until ?? null,
				],
			);
			await this.audit(
				tx,
				"hold.placed",
				input.actor,
				{
					poolId: input.poolId,
				},
				{ reason: input.reason, until: input.until ?? null },
			);
			return holdFrom(row as Row);
		});
	}

	/** The brain never clears a hold; the core never clears an operator's. */
	async clearHold(
		poolId: string,
		reason: HoldReason,
		actor: HoldActor,
	): Promise<boolean> {
		if (actor === "brain") {
			throw new ResourceError("the brain may not clear holds", "FORBIDDEN");
		}
		if (actor === "core" && reason === "operator") {
			throw new ResourceError(
				"only the owner clears an operator hold",
				"FORBIDDEN",
			);
		}
		return this.withWrite(async (tx) => {
			const now = this.now();
			const row = await one(
				tx,
				"UPDATE rp_holds SET cleared_at=?, cleared_by=? WHERE pool_id=? AND reason=? AND cleared_at IS NULL RETURNING id",
				[now, actor, poolId, reason],
			);
			if (!row) return false;
			await this.audit(tx, "hold.cleared", actor, { poolId }, { reason });
			return true;
		});
	}

	async holds(poolId?: string): Promise<PoolHold[]> {
		const now = this.now();
		const rows = await all(
			this.client,
			`SELECT * FROM rp_holds WHERE cleared_at IS NULL AND (until IS NULL OR until > ?)
			 ${poolId ? "AND pool_id=?" : ""} ORDER BY opened_at, id`,
			poolId ? [now, poolId] : [now],
		);
		return rows.map(holdFrom);
	}

	// Observations

	/**
	 * Records a plugin's observation. It is untrusted: it can only narrow
	 * capacity, cannot clear a hold, and its clock is not believed past ours.
	 */
	async recordObservation(input: unknown): Promise<{ violations: string[] }> {
		const observation: Observation = ObservationSchema.parse(input);
		return this.withWrite(async (tx) => {
			const rows = await all(
				tx,
				"SELECT spec_json FROM rp_dimensions WHERE pool_id=?",
				[observation.poolId],
			);
			if (rows.length === 0) {
				throw new ResourceError(
					`unknown pool '${observation.poolId}'`,
					"NOT_FOUND",
				);
			}
			const declared = rows.map((r) =>
				parsed<Dimension>(r.spec_json, "dimension spec"),
			);
			const violations = capacityRaised(declared, observation.dimensions);
			const now = this.now();
			await tx.execute({
				sql: `INSERT INTO rp_observations(pool_id,observed_at,received_at,health,dimensions_json,violations_json)
				      VALUES(?,?,?,?,?,?)
				      ON CONFLICT(pool_id) DO UPDATE SET observed_at=excluded.observed_at, received_at=excluded.received_at,
				        health=excluded.health, dimensions_json=excluded.dimensions_json, violations_json=excluded.violations_json`,
				args: [
					observation.poolId,
					Math.min(observation.observedAt, now),
					now,
					observation.health,
					JSON.stringify(observation.dimensions),
					JSON.stringify(violations),
				],
			});
			if (violations.length > 0) {
				await this.audit(
					tx,
					"observation.violation",
					"core",
					{
						poolId: observation.poolId,
					},
					{ violations },
				);
			}
			return { violations };
		});
	}

	// Admission

	private async snapshot(target: Target): Promise<AdmissionSnapshot> {
		const now = this.now();
		const snapshot: AdmissionSnapshot = new Map();
		const pools = await all(target, "SELECT * FROM rp_pools");
		const maxAge = new Map<string, number | null>();
		for (const row of pools) {
			const id = str(row.id, "pool id");
			maxAge.set(id, intOrNull(row.max_observation_age_ms, "pool max age"));
			snapshot.set(id, { holds: [], dimensions: new Map() });
		}

		for (const row of await all(
			target,
			"SELECT * FROM rp_holds WHERE cleared_at IS NULL",
		)) {
			const hold = holdFrom(row);
			if (hold.until !== null && hold.until <= now) continue;
			snapshot.get(hold.poolId)?.holds.push(hold.reason);
		}

		const observed = new Map<
			string,
			{ observedAt: number; health: string; dims: DimensionObservation[] }
		>();
		for (const row of await all(target, "SELECT * FROM rp_observations")) {
			observed.set(str(row.pool_id, "observation pool"), {
				observedAt: int(row.observed_at, "observed_at"),
				health: str(row.health, "observation health"),
				dims: parsed<DimensionObservation[]>(
					row.dimensions_json,
					"observation dimensions",
				),
			});
		}
		for (const [id, pool] of snapshot) {
			const obs = observed.get(id);
			const limit = maxAge.get(id) ?? null;
			if (limit !== null && (!obs || now - obs.observedAt > limit)) {
				pool.holds.push("observation-stale");
			}
			if (obs?.health === "down") pool.holds.push("observation-failed");
		}

		const allocations = await all(
			target,
			`SELECT a.pool_id, a.dimension, a.amount, a.units_json, l.scopes_json
			 FROM rp_allocations a JOIN rp_leases l ON l.id=a.lease_id
			 WHERE l.state IN (${LIVE_SQL})`,
		);
		const quotas = await all(target, "SELECT * FROM rp_quotas");

		for (const row of await all(target, "SELECT * FROM rp_dimensions")) {
			const poolId = str(row.pool_id, "dimension pool");
			const pool = snapshot.get(poolId);
			if (!pool) continue;
			const spec = parsed<Dimension>(row.spec_json, "dimension spec");
			const seen = observed
				.get(poolId)
				?.dims.find((d) => d.name === spec.name && d.kind === spec.kind);
			let capacity = int(row.capacity, "dimension capacity");
			if (seen?.kind === "slot" || seen?.kind === "quantity") {
				capacity = Math.min(capacity, toStored(seen.kind, seen.total));
			}
			const state: DimensionState = {
				kind: spec.kind,
				capacity,
				used: 0,
				settled: 0,
				quotas: new Map(),
			};
			for (const q of quotas) {
				if (q.pool_id !== poolId || q.dimension !== spec.name) continue;
				state.quotas.set(
					`${str(q.scope, "quota scope")}:${str(q.name, "quota name")}`,
					{ limit: int(q.limit_amount, "quota limit"), used: 0, settled: 0 },
				);
			}
			if (seen?.kind === "meter") {
				state.meterFraction = seen.fraction;
				state.meterResetsAt = seen.resetsAt;
			}
			const leasedUnits = new Set<string>();
			for (const a of allocations) {
				if (a.pool_id !== poolId || a.dimension !== spec.name) continue;
				const amount = int(a.amount, "allocation amount");
				state.used += amount;
				for (const s of parsed<QuotaScope[]>(a.scopes_json, "lease scopes")) {
					const quota = state.quotas.get(scopeKey(s));
					if (quota) quota.used += amount;
				}
				for (const u of parsed<string[]>(a.units_json, "allocation units")) {
					leasedUnits.add(u);
				}
			}
			if (spec.kind === "slot" && spec.units) {
				const occupied = new Set(seen?.kind === "slot" ? seen.occupied : []);
				state.units = spec.units;
				state.freeUnits = spec.units.filter(
					(u) => !leasedUnits.has(u) && !occupied.has(u),
				);
			}
			if (spec.kind === "window") {
				const start = windowStart(spec.window, now);
				const ledger = await all(
					target,
					`SELECT state, amount, scopes_json FROM rp_ledger
					 WHERE pool_id=? AND dimension=? AND
					   (state='reserved' OR (state IN ('settled','estimated') AND at_ms>=?))`,
					[poolId, spec.name, start],
				);
				for (const entry of ledger) {
					const amount = int(entry.amount, "ledger amount");
					const isSettled = entry.state !== "reserved";
					state.used += amount;
					if (isSettled) state.settled += amount;
					for (const s of parsed<QuotaScope[]>(
						entry.scopes_json,
						"ledger scopes",
					)) {
						const quota = state.quotas.get(scopeKey(s));
						if (!quota) continue;
						quota.used += amount;
						if (isSettled) quota.settled += amount;
					}
				}
			}
			pool.dimensions.set(spec.name, state);
		}
		return snapshot;
	}

	private async queue_(target: Target): Promise<QueuedWaiter[]> {
		const rows = await all(
			target,
			"SELECT id, sequence, scopes_json FROM rp_waiters WHERE state='waiting' ORDER BY sequence",
		);
		const claims = await all(
			target,
			`SELECT c.* FROM rp_waiter_claims c JOIN rp_waiters w ON w.id=c.waiter_id WHERE w.state='waiting'`,
		);
		const byWaiter = new Map<string, StoredClaim[]>();
		for (const c of claims) {
			const id = str(c.waiter_id, "claim waiter");
			const list = byWaiter.get(id) ?? [];
			list.push(claimFrom(c));
			byWaiter.set(id, list);
		}
		return rows.map((row) => ({
			id: str(row.id, "waiter id"),
			sequence: int(row.sequence, "waiter sequence"),
			scopes: parsed<QuotaScope[]>(row.scopes_json, "waiter scopes"),
			claims: byWaiter.get(str(row.id, "waiter id")) ?? [],
		}));
	}

	/** Validates a claim set and converts it to stored units. Refuses, never guesses. */
	private async storedClaims(
		target: Target,
		claims: readonly Claim[],
	): Promise<StoredClaim[]> {
		if (claims.length === 0) {
			throw new ResourceError("a claim set needs a claim", "REFUSED");
		}
		const seen = new Set<string>();
		const out: StoredClaim[] = [];
		for (const claim of claims) {
			const key = dimensionKey(claim.poolId, claim.dimension);
			if (seen.has(key)) {
				throw new ResourceError(
					`duplicate claim on ${claim.poolId} '${claim.dimension}'`,
					"REFUSED",
				);
			}
			seen.add(key);
			const { spec } = await this.dimensionRow(
				target,
				claim.poolId,
				claim.dimension,
			);
			if (spec.kind === "meter") {
				if (claim.amount != null && claim.amount !== 0) {
					throw new ResourceError("a meter cannot be leased", "REFUSED");
				}
				out.push({ ...claim, amount: 0 });
				continue;
			}
			if (claim.amount === null || claim.amount === undefined) {
				throw new ResourceError(
					`no cost estimate for ${claim.poolId} '${claim.dimension}'`,
					"REFUSED",
					"set a per-run cap so a reservation can be derived",
				);
			}
			if (claim.unit !== undefined && spec.kind !== "slot") {
				throw new ResourceError("only slots have named units", "REFUSED");
			}
			if (claim.unit !== undefined && claim.amount !== 1) {
				throw new ResourceError("a named unit is one slot", "REFUSED");
			}
			const amount = toStored(spec.kind, claim.amount);
			if (amount <= 0) {
				throw new ResourceError("a claim amount must be positive", "REFUSED");
			}
			out.push({ ...claim, amount });
		}
		return out;
	}

	/** Would this claim set be granted now, behind everyone already queued? */
	async canAdmit(
		request: Pick<ClaimSetRequest, "projectId" | "claims" | "scopes">,
	): Promise<AdmissionVerdict> {
		const tx = await this.client.transaction("read");
		try {
			const claims = await this.storedClaims(tx, request.claims);
			const scopes = withProjectScope(request.projectId, request.scopes);
			const [snapshot, queue] = [
				await this.snapshot(tx),
				await this.queue_(tx),
			];
			return decide(
				snapshot,
				queue,
				{ sequence: Number.MAX_SAFE_INTEGER, claims, scopes },
				this.now(),
			);
		} finally {
			tx.close();
		}
	}

	async putWaiter(request: ClaimSetRequest): Promise<ResourceWaiter> {
		if (!request.requestKey.trim() || !request.projectId.trim()) {
			throw new ResourceError(
				"requestKey and projectId are required",
				"REFUSED",
			);
		}
		const scopes = withProjectScope(request.projectId, request.scopes);
		return this.withWrite(async (tx) => {
			const claims = await this.storedClaims(tx, request.claims);
			const hash = createHash("sha256")
				.update(
					JSON.stringify({
						projectId: request.projectId,
						scopes,
						claims: [...claims]
							.map((c) => [c.poolId, c.dimension, c.amount, c.unit ?? null])
							.sort((a, b) => String(a).localeCompare(String(b))),
					}),
				)
				.digest("hex");
			const existing = await one(
				tx,
				"SELECT * FROM rp_waiters WHERE request_key=?",
				[request.requestKey],
			);
			if (existing) {
				if (existing.request_hash !== hash) {
					throw new ResourceError(
						`requestKey '${request.requestKey}' already names a different request`,
						"CONFLICT",
					);
				}
				return this.waiterFrom(tx, existing);
			}
			const counter = await one(
				tx,
				"UPDATE rp_schema SET next_sequence=next_sequence+1 WHERE singleton=1 RETURNING next_sequence-1 AS sequence",
			);
			const sequence = int(counter?.sequence, "waiter sequence");
			const id = randomUUID();
			const now = this.now();
			await tx.execute({
				sql: `INSERT INTO rp_waiters(id,request_key,request_hash,project_id,scopes_json,sequence,state,created_at,updated_at)
				      VALUES(?,?,?,?,?,?,'waiting',?,?)`,
				args: [
					id,
					request.requestKey,
					hash,
					request.projectId,
					JSON.stringify(scopes),
					sequence,
					now,
					now,
				],
			});
			for (const c of claims) {
				await tx.execute({
					sql: "INSERT INTO rp_waiter_claims(waiter_id,pool_id,dimension,amount,unit) VALUES(?,?,?,?,?)",
					args: [id, c.poolId, c.dimension, c.amount, c.unit ?? null],
				});
			}
			await this.audit(
				tx,
				"waiter.created",
				"core",
				{},
				{
					waiterId: id,
					sequence,
				},
			);
			return {
				id,
				requestKey: request.requestKey,
				projectId: request.projectId,
				sequence,
				state: "waiting" as const,
				scopes,
				claims,
			};
		});
	}

	private async waiterFrom(target: Target, row: Row): Promise<ResourceWaiter> {
		const id = str(row.id, "waiter id");
		const claims = await all(
			target,
			"SELECT * FROM rp_waiter_claims WHERE waiter_id=?",
			[id],
		);
		return {
			id,
			requestKey: str(row.request_key, "waiter key"),
			projectId: str(row.project_id, "waiter project"),
			sequence: int(row.sequence, "waiter sequence"),
			state: str(row.state, "waiter state") as ResourceWaiter["state"],
			scopes: parsed<QuotaScope[]>(row.scopes_json, "waiter scopes"),
			claims: claims.map(claimFrom),
		};
	}

	/**
	 * All-or-nothing grant in one BEGIN IMMEDIATE: allocations, reservations and
	 * the lease commit together or not at all.
	 */
	async tryGrant(waiterId: string): Promise<ResourceLease | ResourceHeld> {
		return this.withWrite(async (tx) => {
			const row = await one(tx, "SELECT * FROM rp_waiters WHERE id=?", [
				waiterId,
			]);
			if (!row) {
				throw new ResourceError(`unknown waiter '${waiterId}'`, "NOT_FOUND");
			}
			const waiter = await this.waiterFrom(tx, row);
			if (waiter.state === "granted") {
				const lease = await one(
					tx,
					"SELECT * FROM rp_leases WHERE waiter_id=?",
					[waiterId],
				);
				if (!lease) {
					throw new ResourceError("granted waiter has no lease", "CORRUPT");
				}
				return leaseFrom(lease);
			}
			if (waiter.state !== "waiting") {
				throw new ResourceError(
					`waiter is ${waiter.state}`,
					"INVALID_TRANSITION",
				);
			}
			const snapshot = await this.snapshot(tx);
			const queue = await this.queue_(tx);
			const verdict = decide(snapshot, queue, waiter, this.now());
			if (verdict.status !== "grantable") {
				return {
					kind: "held" as const,
					waiterId,
					status: verdict.status,
					blockers: verdict.blockers,
				};
			}
			const counter = await one(
				tx,
				"UPDATE rp_schema SET next_fence=next_fence+1 WHERE singleton=1 RETURNING next_fence-1 AS fence",
			);
			const fence = int(counter?.fence, "fence");
			const leaseId = randomUUID();
			const now = this.now();
			const scopesJson = JSON.stringify(waiter.scopes);
			await tx.execute({
				sql: `INSERT INTO rp_leases(id,waiter_id,project_id,scopes_json,state,fence,owner_boot_id,granted_at,updated_at)
				      VALUES(?,?,?,?,'provisional',?,?,?,?)`,
				args: [
					leaseId,
					waiterId,
					waiter.projectId,
					scopesJson,
					fence,
					this.processBootId,
					now,
					now,
				],
			});
			for (const claim of waiter.claims) {
				const kind = snapshot
					.get(claim.poolId)
					?.dimensions.get(claim.dimension)?.kind;
				const amount = claim.amount ?? 0;
				if (kind === "window") {
					await tx.execute({
						sql: `INSERT INTO rp_ledger(id,entry_key,project_id,pool_id,dimension,lease_id,scopes_json,state,amount,reserved_amount,at_ms)
						      VALUES(?,?,?,?,?,?,?,'reserved',?,?,?)`,
						args: [
							randomUUID(),
							entryKey(leaseId, claim.poolId, claim.dimension),
							waiter.projectId,
							claim.poolId,
							claim.dimension,
							leaseId,
							scopesJson,
							amount,
							amount,
							now,
						],
					});
				} else if (kind === "slot" || kind === "quantity") {
					const units =
						verdict.units.get(dimensionKey(claim.poolId, claim.dimension)) ??
						[];
					await tx.execute({
						sql: "INSERT INTO rp_allocations(lease_id,pool_id,dimension,amount,units_json) VALUES(?,?,?,?,?)",
						args: [
							leaseId,
							claim.poolId,
							claim.dimension,
							amount,
							JSON.stringify(units),
						],
					});
				}
			}
			await tx.execute({
				sql: "UPDATE rp_waiters SET state='granted', updated_at=? WHERE id=?",
				args: [now, waiterId],
			});
			await this.audit(
				tx,
				"lease.provisional",
				"core",
				{ leaseId },
				{
					waiterId,
					fence,
				},
			);
			return leaseFrom(
				(await one(tx, "SELECT * FROM rp_leases WHERE id=?", [leaseId])) as Row,
			);
		});
	}

	async cancelWaiter(waiterId: string, reason: string): Promise<boolean> {
		return this.withWrite(async (tx) => {
			const row = await one(
				tx,
				"UPDATE rp_waiters SET state='cancelled', updated_at=? WHERE id=? AND state='waiting' RETURNING id",
				[this.now(), waiterId],
			);
			if (!row) return false;
			await this.audit(
				tx,
				"waiter.cancelled",
				"core",
				{},
				{ waiterId, reason },
			);
			return true;
		});
	}

	// Lease lifecycle

	private async fenced(
		tx: Transaction,
		id: string,
		fence: number,
	): Promise<ResourceLease> {
		const row = await one(tx, "SELECT * FROM rp_leases WHERE id=?", [id]);
		if (!row) throw new ResourceError(`unknown lease '${id}'`, "NOT_FOUND");
		const lease = leaseFrom(row);
		if (lease.fence !== fence) {
			throw new ResourceError(
				`stale fence ${fence} for lease ${id}`,
				"STALE_FENCE",
			);
		}
		return lease;
	}

	async lease(id: string): Promise<ResourceLease | null> {
		const row = await one(this.client, "SELECT * FROM rp_leases WHERE id=?", [
			id,
		]);
		return row ? leaseFrom(row) : null;
	}

	/** Live allocations on one pool, with the units each lease holds. */
	async allocations(
		poolId: string,
	): Promise<{ lease: ResourceLease; units: string[] }[]> {
		const rows = await all(
			this.client,
			`SELECT l.*, a.units_json FROM rp_allocations a JOIN rp_leases l ON l.id=a.lease_id
			 WHERE a.pool_id=? AND l.state IN (${LIVE_SQL}) ORDER BY l.fence`,
			[poolId],
		);
		return rows.map((row) => ({
			lease: leaseFrom(row),
			units: parsed<string[]>(row.units_json, "allocation units"),
		}));
	}

	/** Which units each lease holds, by pool. */
	async leaseUnits(): Promise<Map<string, Map<string, string[]>>> {
		const out = new Map<string, Map<string, string[]>>();
		for (const row of await all(
			this.client,
			"SELECT lease_id,pool_id,units_json FROM rp_allocations",
		)) {
			const leaseId = str(row.lease_id, "allocation lease");
			const byPool = out.get(leaseId) ?? new Map<string, string[]>();
			byPool.set(
				str(row.pool_id, "allocation pool"),
				parsed<string[]>(row.units_json, "allocation units"),
			);
			out.set(leaseId, byPool);
		}
		return out;
	}

	/** Every waiter and lease, so a caller can prove a terminal state. */
	async readLedger(): Promise<{
		waiters: ResourceWaiter[];
		leases: ResourceLease[];
	}> {
		const tx = await this.client.transaction("read");
		try {
			const waiters: ResourceWaiter[] = [];
			for (const row of await all(
				tx,
				"SELECT * FROM rp_waiters ORDER BY sequence",
			)) {
				waiters.push(await this.waiterFrom(tx, row));
			}
			const leases = (
				await all(tx, "SELECT * FROM rp_leases ORDER BY fence")
			).map(leaseFrom);
			return { waiters, leases };
		} finally {
			tx.close();
		}
	}

	async liveLeases(): Promise<ResourceLease[]> {
		const rows = await all(
			this.client,
			`SELECT * FROM rp_leases WHERE state IN (${LIVE_SQL}) ORDER BY fence`,
		);
		return rows.map(leaseFrom);
	}

	async activate(
		id: string,
		fence: number,
		runId: string,
		leaseMs: number,
		run?: RunIdentity,
	): Promise<ResourceLease> {
		if (run && run.runId !== runId) {
			throw new ResourceError("run identity names another run", "REFUSED");
		}
		if (!runId.trim()) throw new ResourceError("run id is required", "REFUSED");
		return this.withWrite(async (tx) => {
			const lease = await this.fenced(tx, id, fence);
			if (lease.state === "active") {
				if (lease.runId !== runId) {
					throw new ResourceError(
						"lease belongs to another run",
						"INVALID_TRANSITION",
					);
				}
				return lease;
			}
			if (lease.state !== "provisional") {
				throw new ResourceError(
					`cannot activate a ${lease.state} lease`,
					"INVALID_TRANSITION",
				);
			}
			const now = this.now();
			const row = await one(
				tx,
				`UPDATE rp_leases SET state='active', run_id=?, run_json=?, owner_boot_id=?, activated_at=?, last_renewed_at=?, expires_at=?, updated_at=?
				 WHERE id=? AND fence=? RETURNING *`,
				[
					runId,
					JSON.stringify(run ?? { runId }),
					this.processBootId,
					now,
					now,
					now + leaseMs,
					now,
					id,
					fence,
				],
			);
			await this.audit(
				tx,
				"lease.activated",
				"owner",
				{ leaseId: id },
				{
					runId,
				},
			);
			return leaseFrom(row as Row);
		});
	}

	/** Renews a live lease, or adopts an `uncertain` one its owner proved. */
	async renewOrAdopt(
		id: string,
		fence: number,
		runId: string,
		leaseMs: number,
		run?: RunIdentity,
	): Promise<void> {
		if (run && run.runId !== runId) {
			throw new ResourceError("run identity names another run", "REFUSED");
		}
		await this.withWrite(async (tx) => {
			const lease = await this.fenced(tx, id, fence);
			if (lease.state !== "active" && lease.state !== "uncertain") {
				throw new ResourceError(
					`cannot renew a ${lease.state} lease`,
					"INVALID_TRANSITION",
				);
			}
			if (lease.runId !== runId) {
				throw new ResourceError(
					"owner proof does not match the persisted run",
					"INVALID_TRANSITION",
				);
			}
			const now = this.now();
			await tx.execute({
				sql: `UPDATE rp_leases SET state='active', run_json=COALESCE(?, run_json), owner_boot_id=?,
				      last_renewed_at=?, expires_at=?, updated_at=? WHERE id=? AND fence=?`,
				args: [
					run ? JSON.stringify(run) : null,
					this.processBootId,
					now,
					now + leaseMs,
					now,
					id,
					fence,
				],
			});
			// A heartbeat with an unchanged owner proof adds nothing to the trail.
			const detail = { run: run ?? lease.run };
			const repeated =
				lease.state === "active" &&
				(await one(
					tx,
					"SELECT 1 AS seen FROM rp_audit WHERE lease_id=? AND action='lease.renewed' AND detail_json=? LIMIT 1",
					[id, JSON.stringify(detail)],
				));
			if (!repeated) {
				await this.audit(
					tx,
					lease.state === "uncertain" ? "lease.adopted" : "lease.renewed",
					"owner",
					{ leaseId: id },
					detail,
				);
			}
		});
	}

	/**
	 * A pool that stopped being observed: its last reading and observation
	 * holds no longer apply. The owner chose this, and the definition audits it.
	 */
	async forgetObservation(poolId: string): Promise<void> {
		await this.withWrite(async (tx) => {
			await tx.execute({
				sql: "DELETE FROM rp_observations WHERE pool_id=?",
				args: [poolId],
			});
			await tx.execute({
				sql: "UPDATE rp_holds SET cleared_at=?, cleared_by='core' WHERE pool_id=? AND cleared_at IS NULL AND reason LIKE 'observation-%'",
				args: [this.now(), poolId],
			});
		});
	}

	/** Records that a resource stopped or resumed taking work, and why. */
	async auditHoldTransition(
		poolId: string,
		action: "resource.hold.opened" | "resource.hold.resolved",
		detail: Record<string, unknown>,
	): Promise<void> {
		await this.withWrite((tx) =>
			this.audit(tx, action, "core", { poolId }, detail),
		);
	}

	async markReleasing(
		id: string,
		fence: number,
		reason: string,
	): Promise<ResourceLease> {
		if (!reason.trim()) {
			throw new ResourceError("release reason is required", "REFUSED");
		}
		return this.withWrite(async (tx) => {
			const lease = await this.fenced(tx, id, fence);
			if (!isLive(lease.state) || lease.state === "releasing") return lease;
			const row = await one(
				tx,
				"UPDATE rp_leases SET state='releasing', release_reason=?, updated_at=? WHERE id=? AND fence=? RETURNING *",
				[reason, this.now(), id, fence],
			);
			await this.audit(
				tx,
				"lease.releasing",
				"owner",
				{ leaseId: id },
				{
					reason,
				},
			);
			return leaseFrom(row as Row);
		});
	}

	/**
	 * Closes a lease and settles its reservations in one transaction. A
	 * reservation with no known actual stands as an estimated charge: unknown
	 * never becomes 0.
	 */
	async finishRelease(
		id: string,
		fence: number,
		actuals: readonly Actual[] = [],
		actor = "owner",
	): Promise<boolean> {
		return this.withWrite(async (tx) => {
			const lease = await this.fenced(tx, id, fence);
			if (lease.state === "released") return false;
			if (!isLive(lease.state)) {
				throw new ResourceError(
					`lease is already ${lease.state}`,
					"INVALID_TRANSITION",
				);
			}
			await this.assertNoOpenCleanup(tx, id);
			await this.settleReservations(tx, id, actuals);
			await this.closeLease(tx, lease, "released", "release completed", actor);
			return true;
		});
	}

	/**
	 * Closes a lease whose work provably never started. This is the only path
	 * that voids a reservation, so the caller must hold that proof.
	 */
	async releaseUnlaunched(
		id: string,
		fence: number,
		reason: string,
	): Promise<boolean> {
		return this.withWrite(async (tx) => {
			const lease = await this.fenced(tx, id, fence);
			if (lease.state === "released") return false;
			if (lease.state !== "provisional") {
				throw new ResourceError(
					`cannot void a ${lease.state} lease`,
					"INVALID_TRANSITION",
				);
			}
			await this.assertNoOpenCleanup(tx, id);
			await this.assertNoOpenCleanup(tx, id);
			await tx.execute({
				sql: "UPDATE rp_ledger SET state='void', amount=0, at_ms=? WHERE lease_id=? AND state='reserved'",
				args: [this.now(), id],
			});
			await this.closeLease(tx, lease, "released", reason, "owner");
			return true;
		});
	}

	/** The owner's override; reservations stand as estimated charges. */
	async forceRelease(
		id: string,
		fence: number,
		actor: string,
		reason: string,
		evidence: Record<string, unknown> = {},
	): Promise<boolean> {
		if (!actor.trim() || !reason.trim()) {
			throw new ResourceError(
				"force release needs actor and reason",
				"REFUSED",
			);
		}
		return this.withWrite(async (tx) => {
			const lease = await this.fenced(tx, id, fence);
			if (lease.state === "force_released") return false;
			if (!isLive(lease.state)) {
				throw new ResourceError(
					`lease is already ${lease.state}`,
					"INVALID_TRANSITION",
				);
			}
			await this.settleReservations(tx, id, []);
			await this.closeLease(
				tx,
				lease,
				"force_released",
				reason,
				actor,
				evidence,
			);
			return true;
		});
	}

	/**
	 * The owner's override for one claim of a live lease: the rest of the lease
	 * keeps its capacity, because the run may still be using it.
	 */
	async forceReleaseClaim(
		id: string,
		fence: number,
		poolId: string,
		actor: string,
		reason: string,
	): Promise<boolean> {
		if (!actor.trim() || !reason.trim()) {
			throw new ResourceError(
				"force release needs actor and reason",
				"REFUSED",
			);
		}
		return this.withWrite(async (tx) => {
			const lease = await this.fenced(tx, id, fence);
			if (!isLive(lease.state)) return false;
			const removed = await tx.execute({
				sql: "DELETE FROM rp_allocations WHERE lease_id=? AND pool_id=?",
				args: [id, poolId],
			});
			if (removed.rowsAffected === 0) return false;
			await this.audit(
				tx,
				"lease.claim_force_released",
				actor,
				{ poolId, leaseId: id },
				{ reason, fence },
			);
			const left = await one(
				tx,
				"SELECT 1 AS present FROM rp_allocations WHERE lease_id=? LIMIT 1",
				[id],
			);
			if (!left) {
				await this.settleReservations(tx, id, []);
				await this.closeLease(tx, lease, "force_released", reason, actor);
			}
			return true;
		});
	}

	private async closeLease(
		tx: Transaction,
		lease: ResourceLease,
		to: "released" | "reclaimed" | "force_released",
		reason: string,
		actor: string,
		evidence: Record<string, unknown> = {},
	): Promise<void> {
		const now = this.now();
		await tx.execute({
			sql: "UPDATE rp_leases SET state=?, release_reason=?, released_at=?, updated_at=? WHERE id=? AND fence=?",
			args: [to, reason, now, now, lease.id, lease.fence],
		});
		await this.audit(
			tx,
			`lease.${to}`,
			actor,
			{ leaseId: lease.id },
			{
				from: lease.state,
				reason,
				fence: lease.fence,
				...evidence,
			},
		);
	}

	private async settleReservations(
		tx: Transaction,
		leaseId: string,
		actuals: readonly Actual[],
	): Promise<void> {
		const now = this.now();
		const open = await all(
			tx,
			"SELECT * FROM rp_ledger WHERE lease_id=? AND state='reserved'",
			[leaseId],
		);
		const known = new Set(
			open.map((e) =>
				dimensionKey(str(e.pool_id, "pool"), str(e.dimension, "dim")),
			),
		);
		for (const actual of actuals) {
			if (!known.has(dimensionKey(actual.poolId, actual.dimension))) {
				throw new ResourceError(
					`no open reservation on ${actual.poolId} '${actual.dimension}'`,
					"CONFLICT",
				);
			}
		}
		for (const entry of open) {
			const actual = actuals.find(
				(a) => a.poolId === entry.pool_id && a.dimension === entry.dimension,
			);
			const id = str(entry.id, "ledger id");
			if (actual?.amount === null || actual?.amount === undefined) {
				await tx.execute({
					sql: "UPDATE rp_ledger SET state='estimated', at_ms=? WHERE id=?",
					args: [now, id],
				});
			} else {
				await tx.execute({
					sql: "UPDATE rp_ledger SET state='settled', amount=?, at_ms=? WHERE id=?",
					args: [toStored("window", actual.amount), now, id],
				});
			}
		}
	}

	/**
	 * Replaces an estimated charge with a late actual. Repeating the same actual
	 * is a no-op; a different one is a conflict.
	 */
	async settleLate(
		leaseId: string,
		poolId: string,
		dimension: string,
		amount: number,
	): Promise<boolean> {
		const stored = toStored("window", amount);
		return this.withWrite(async (tx) => {
			const row = await one(tx, "SELECT * FROM rp_ledger WHERE entry_key=?", [
				entryKey(leaseId, poolId, dimension),
			]);
			if (!row) throw new ResourceError("no ledger entry", "NOT_FOUND");
			const entry = ledgerFrom(row);
			if (entry.state === "settled") {
				if (entry.amount === stored) return false;
				throw new ResourceError("already settled differently", "CONFLICT");
			}
			if (entry.state !== "estimated") {
				throw new ResourceError(
					`cannot settle a ${entry.state} entry`,
					"INVALID_TRANSITION",
				);
			}
			// at_ms stays: the charge remains in the window it was booked to.
			await tx.execute({
				sql: "UPDATE rp_ledger SET state='settled', amount=? WHERE id=?",
				args: [stored, entry.id],
			});
			await this.audit(
				tx,
				"ledger.settled-late",
				"core",
				{ poolId, leaseId },
				{
					dimension,
				},
			);
			return true;
		});
	}

	/**
	 * Grows a running lease's reservation if it still fits at every level. On
	 * `false` the caller stops the run with a budget reason.
	 */
	async topUp(
		leaseId: string,
		fence: number,
		poolId: string,
		dimension: string,
		additional: number,
	): Promise<boolean> {
		const stored = toStored("window", additional);
		if (stored <= 0) {
			throw new ResourceError("a top-up must be positive", "REFUSED");
		}
		return this.withWrite(async (tx) => {
			const lease = await this.fenced(tx, leaseId, fence);
			if (lease.state !== "active") {
				throw new ResourceError(
					`cannot top up a ${lease.state} lease`,
					"INVALID_TRANSITION",
				);
			}
			const row = await one(tx, "SELECT * FROM rp_ledger WHERE entry_key=?", [
				entryKey(leaseId, poolId, dimension),
			]);
			if (row?.state !== "reserved") {
				throw new ResourceError("no open reservation", "NOT_FOUND");
			}
			const snapshot = await this.snapshot(tx);
			const pool = snapshot.get(poolId);
			const state = pool?.dimensions.get(dimension);
			const scopes = parsed<QuotaScope[]>(row.scopes_json, "ledger scopes");
			if (
				!state ||
				pool?.holds.length ||
				!fitsEveryLevel(state, scopes, stored)
			) {
				await this.audit(
					tx,
					"ledger.topup-refused",
					"core",
					{
						poolId,
						leaseId,
					},
					{ dimension, additional: stored },
				);
				return false;
			}
			await tx.execute({
				sql: "UPDATE rp_ledger SET amount=amount+?, reserved_amount=reserved_amount+? WHERE id=?",
				args: [stored, stored, str(row.id, "ledger id")],
			});
			await this.audit(
				tx,
				"ledger.topup",
				"core",
				{ poolId, leaseId },
				{
					dimension,
					additional: stored,
				},
			);
			return true;
		});
	}

	/** Records spend outside a lease; idempotent under `entryKey`. */
	async recordCharge(input: {
		entryKey: string;
		projectId: string;
		poolId: string;
		dimension: string;
		amount: number;
		scopes?: readonly QuotaScope[];
	}): Promise<boolean> {
		if (input.entryKey.startsWith("lease:")) {
			throw new ResourceError("reserved ledger key prefix", "REFUSED");
		}
		const stored = toStored("window", input.amount);
		return this.withWrite(async (tx) => {
			const { spec } = await this.dimensionRow(
				tx,
				input.poolId,
				input.dimension,
			);
			if (spec.kind !== "window") {
				throw new ResourceError("charges apply to windows", "REFUSED");
			}
			const existing = await one(
				tx,
				"SELECT amount FROM rp_ledger WHERE entry_key=?",
				[input.entryKey],
			);
			if (existing) {
				if (int(existing.amount, "ledger amount") === stored) return false;
				throw new ResourceError("charge key reused differently", "CONFLICT");
			}
			await tx.execute({
				sql: `INSERT INTO rp_ledger(id,entry_key,project_id,pool_id,dimension,lease_id,scopes_json,state,amount,at_ms)
				      VALUES(?,?,?,?,?,NULL,?,'settled',?,?)`,
				args: [
					randomUUID(),
					input.entryKey,
					input.projectId,
					input.poolId,
					input.dimension,
					JSON.stringify(withProjectScope(input.projectId, input.scopes)),
					stored,
					this.now(),
				],
			});
			return true;
		});
	}

	/**
	 * Copies after-the-fact charges into a window in one transaction. A source
	 * row can be corrected later, so a repeated key takes the newer amount.
	 */
	async syncCharges(input: {
		poolId: string;
		dimension: string;
		projectId: string;
		charges: readonly { entryKey: string; amount: number; atMs: number }[];
	}): Promise<void> {
		const scopes = JSON.stringify(withProjectScope(input.projectId));
		await this.withWrite(async (tx) => {
			const { spec } = await this.dimensionRow(
				tx,
				input.poolId,
				input.dimension,
			);
			if (spec.kind !== "window") {
				throw new ResourceError("charges apply to windows", "REFUSED");
			}
			for (const charge of input.charges) {
				if (charge.entryKey.startsWith("lease:")) {
					throw new ResourceError("reserved ledger key prefix", "REFUSED");
				}
				await tx.execute({
					sql: `INSERT INTO rp_ledger(id,entry_key,project_id,pool_id,dimension,lease_id,scopes_json,state,amount,at_ms)
					      VALUES(?,?,?,?,?,NULL,?,'settled',?,?)
					      ON CONFLICT(entry_key) DO UPDATE SET amount=excluded.amount, at_ms=excluded.at_ms`,
					args: [
						randomUUID(),
						charge.entryKey,
						input.projectId,
						input.poolId,
						input.dimension,
						scopes,
						toStored("window", charge.amount),
						charge.atMs,
					],
				});
			}
		});
	}

	/** Everything charged or still reserved to a window between two instants. */
	async windowTotal(
		poolId: string,
		dimension: string,
		startMs: number,
		endMs: number,
	): Promise<number> {
		const row = await one(
			this.client,
			`SELECT COALESCE(SUM(amount), 0) AS total FROM rp_ledger
			 WHERE pool_id=? AND dimension=? AND state IN ('reserved','settled','estimated')
			   AND at_ms>=? AND at_ms<?`,
			[poolId, dimension, startMs, endMs],
		);
		return fromStored("window", Number(row?.total ?? 0));
	}

	async ledger(
		filter: { projectId?: string; leaseId?: string } = {},
	): Promise<LedgerEntry[]> {
		const where: string[] = [];
		const args: InValue[] = [];
		if (filter.projectId) {
			where.push("project_id=?");
			args.push(filter.projectId);
		}
		if (filter.leaseId) {
			where.push("lease_id=?");
			args.push(filter.leaseId);
		}
		const rows = await all(
			this.client,
			`SELECT * FROM rp_ledger ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY at_ms, id`,
			args,
		);
		return rows.map(ledgerFrom).map((e) => ({
			...e,
			amount: fromStored("window", e.amount),
			reservedAmount:
				e.reservedAmount === null
					? null
					: fromStored("window", e.reservedAmount),
		}));
	}

	// Recovery

	/**
	 * Walks live leases against liveness evidence. TTL plays no part: only proof
	 * of absence frees capacity, and its reservations stand as estimated.
	 */
	async reconcile(
		inspect: (lease: ResourceLease) => Promise<LeaseEvidence>,
	): Promise<ResourceReconcileReport> {
		const report: ResourceReconcileReport = {
			examined: 0,
			adopted: 0,
			reclaimed: 0,
			uncertain: 0,
			unchanged: 0,
			released: 0,
		};
		for (const seen of await this.liveLeases()) {
			report.examined++;
			const recovered = await this.recoverWithoutEvidence(seen);
			if (recovered) {
				report[recovered]++;
				continue;
			}
			// A remote run cannot be judged from here. Once this process activated
			// or adopted it the project renews it; only a lease from an earlier
			// boot goes to project recovery, as uncertain.
			if (
				seen.state === "active" &&
				seen.ownerBootId === this.processBootId &&
				seen.run?.sessionId?.startsWith(REMOTE_RUN_SESSION_PREFIX)
			) {
				report.unchanged++;
				continue;
			}
			let evidence: LeaseEvidence;
			try {
				evidence =
					seen.run?.kernelBootId &&
					this.kernelBootId &&
					seen.run.kernelBootId !== this.kernelBootId
						? "absent"
						: await inspect(seen);
			} catch {
				evidence = "unknown";
			}
			const outcome = await this.withWrite(async (tx) => {
				const lease = await this.fenced(tx, seen.id, seen.fence);
				if (!isLive(lease.state)) return "unchanged" as const;
				// A machine that may still exist keeps its capacity and its bill.
				if (
					evidence === "absent" &&
					(await this.hasOpenCleanup(tx, lease.id))
				) {
					evidence = "unknown";
				}
				if (evidence === "absent") {
					await this.settleReservations(tx, lease.id, []);
					await this.closeLease(
						tx,
						lease,
						"reclaimed",
						"owner proven absent",
						"reconcile",
					);
					return "reclaimed" as const;
				}
				if (evidence === "live") {
					if (
						lease.state === "active" &&
						lease.ownerBootId === this.processBootId
					) {
						return "unchanged" as const;
					}
					// This process now owns the proven-live run.
					await tx.execute({
						sql: "UPDATE rp_leases SET state='active', owner_boot_id=?, updated_at=? WHERE id=? AND fence=?",
						args: [this.processBootId, this.now(), lease.id, lease.fence],
					});
					await this.audit(
						tx,
						"lease.adopted",
						"reconcile",
						{ leaseId: lease.id },
						{ from: lease.state },
					);
					return "adopted" as const;
				}
				if (lease.state === "active") {
					await this.transition(tx, lease, "uncertain");
					return "uncertain" as const;
				}
				return "unchanged" as const;
			});
			report[outcome]++;
		}
		return report;
	}

	/**
	 * The two states recovery settles from the ledger alone: a release that was
	 * interrupted, and a grant from an earlier boot that never launched anything.
	 * An open cleanup record blocks both, since a machine may still exist.
	 */
	private async recoverWithoutEvidence(
		seen: ResourceLease,
	): Promise<"released" | "reclaimed" | "unchanged" | null> {
		const unlaunched =
			seen.state === "provisional" &&
			seen.run === null &&
			seen.ownerBootId !== this.processBootId;
		if (seen.state !== "releasing" && !unlaunched) return null;
		return this.withWrite(async (tx) => {
			const lease = await this.fenced(tx, seen.id, seen.fence);
			if (lease.state !== seen.state) return "unchanged" as const;
			if (await this.hasOpenCleanup(tx, lease.id)) return "unchanged" as const;
			if (lease.state === "releasing") {
				await this.settleReservations(tx, lease.id, []);
				await this.closeLease(
					tx,
					lease,
					"released",
					lease.releaseReason ?? "release completed by recovery",
					"reconcile",
				);
				return "released" as const;
			}
			await tx.execute({
				sql: "UPDATE rp_ledger SET state='void', amount=0, at_ms=? WHERE lease_id=? AND state='reserved'",
				args: [this.now(), lease.id],
			});
			await this.closeLease(
				tx,
				lease,
				"reclaimed",
				"unactivated grant from an earlier process boot",
				"reconcile",
			);
			return "reclaimed" as const;
		});
	}

	private async transition(
		tx: Transaction,
		lease: ResourceLease,
		to: "active" | "uncertain",
	): Promise<void> {
		await tx.execute({
			sql: "UPDATE rp_leases SET state=?, updated_at=? WHERE id=? AND fence=?",
			args: [to, this.now(), lease.id, lease.fence],
		});
		await this.audit(
			tx,
			`lease.${to}`,
			"reconcile",
			{ leaseId: lease.id },
			{
				from: lease.state,
			},
		);
	}

	// Cleanup records

	private async hasOpenCleanup(tx: Transaction, leaseId: string) {
		return (
			(await one(
				tx,
				"SELECT 1 AS open FROM rp_cleanup WHERE lease_id=? AND state='open' LIMIT 1",
				[leaseId],
			)) !== null
		);
	}

	private async assertNoOpenCleanup(tx: Transaction, leaseId: string) {
		if (await this.hasOpenCleanup(tx, leaseId)) {
			throw new ResourceError(
				`lease ${leaseId} still has an open cleanup record`,
				"CONFLICT",
				"tear the machine down and prove its absence by inventory first",
			);
		}
	}

	/** Must commit before `provision`: at any kill point the machine is findable. */
	async openCleanup(input: {
		leaseId: string;
		fence: number;
		poolId: string;
		ownershipToken: string;
	}): Promise<CleanupRecord> {
		return this.withWrite(async (tx) => {
			const lease = await this.fenced(tx, input.leaseId, input.fence);
			if (!isLive(lease.state) || lease.state === "releasing") {
				throw new ResourceError(
					`cannot provision under a ${lease.state} lease`,
					"INVALID_TRANSITION",
				);
			}
			const now = this.now();
			await tx.execute({
				sql: `INSERT INTO rp_cleanup(ownership_token,lease_id,pool_id,project_id,state,created_at,updated_at)
				      VALUES(?,?,?,?,'open',?,?) ON CONFLICT(ownership_token) DO NOTHING`,
				args: [
					input.ownershipToken,
					lease.id,
					input.poolId,
					lease.projectId,
					now,
					now,
				],
			});
			const row = await one(
				tx,
				"SELECT * FROM rp_cleanup WHERE ownership_token=?",
				[input.ownershipToken],
			);
			const record = cleanupFrom(row as Row);
			if (record.leaseId !== lease.id || record.poolId !== input.poolId) {
				throw new ResourceError(
					"ownership token already names another lease",
					"CONFLICT",
				);
			}
			await this.audit(
				tx,
				"cleanup.opened",
				"core",
				{ poolId: input.poolId, leaseId: lease.id },
				{ ownershipToken: input.ownershipToken },
			);
			return record;
		});
	}

	async bindCleanup(ownershipToken: string, externalId: string): Promise<void> {
		await this.withWrite(async (tx) => {
			const row = await one(
				tx,
				"SELECT * FROM rp_cleanup WHERE ownership_token=?",
				[ownershipToken],
			);
			if (!row) throw new ResourceError("no cleanup record", "NOT_FOUND");
			const record = cleanupFrom(row);
			if (record.externalId && record.externalId !== externalId) {
				throw new ResourceError(
					"cleanup record is bound to another machine",
					"CONFLICT",
				);
			}
			await tx.execute({
				sql: "UPDATE rp_cleanup SET external_id=?, updated_at=? WHERE ownership_token=?",
				args: [externalId, this.now(), ownershipToken],
			});
		});
	}

	async noteTeardown(ownershipToken: string, error: string | null) {
		await this.withWrite(async (tx) => {
			await tx.execute({
				sql: `UPDATE rp_cleanup SET teardown_attempts=teardown_attempts+1, last_error=?, updated_at=?
				      WHERE ownership_token=? AND state='open'`,
				args: [error, this.now(), ownershipToken],
			});
		});
	}

	/**
	 * Closes a record against a fresh inventory. Refuses while the inventory
	 * still lists the token or the bound machine: a teardown reply is no proof.
	 */
	async closeCleanup(
		ownershipToken: string,
		inventory: readonly { externalId: string; ownershipToken: string | null }[],
	): Promise<boolean> {
		return this.withWrite(async (tx) => {
			const row = await one(
				tx,
				"SELECT * FROM rp_cleanup WHERE ownership_token=?",
				[ownershipToken],
			);
			if (!row) throw new ResourceError("no cleanup record", "NOT_FOUND");
			const record = cleanupFrom(row);
			if (record.state === "closed") return false;
			if (
				inventory.some(
					(o) =>
						o.ownershipToken === ownershipToken ||
						(record.externalId !== null && o.externalId === record.externalId),
				)
			) {
				throw new ResourceError(
					"inventory still lists this machine",
					"CONFLICT",
				);
			}
			const now = this.now();
			await tx.execute({
				sql: "UPDATE rp_cleanup SET state='closed', closed_at=?, updated_at=? WHERE ownership_token=?",
				args: [now, now, ownershipToken],
			});
			await this.audit(
				tx,
				"cleanup.closed",
				"core",
				{ poolId: record.poolId, leaseId: record.leaseId },
				{ ownershipToken },
			);
			return true;
		});
	}

	async openCleanups(poolId?: string): Promise<CleanupRecord[]> {
		const rows = await all(
			this.client,
			`SELECT * FROM rp_cleanup WHERE state='open' ${poolId ? "AND pool_id=?" : ""} ORDER BY created_at, ownership_token`,
			poolId ? [poolId] : [],
		);
		return rows.map(cleanupFrom);
	}

	// Attached projects

	async registerProject(input: {
		id: string;
		createdAt: number;
		root: string;
		displayName: string;
		metadata?: Record<string, unknown>;
	}): Promise<void> {
		await this.withWrite(async (tx) => {
			const now = this.now();
			await tx.execute({
				sql: `INSERT INTO rp_projects(id,root,display_name,attached,metadata_json,created_at,last_attached_at)
				      VALUES(?,?,?,1,?,?,?)
				      ON CONFLICT(id) DO UPDATE SET root=excluded.root, display_name=excluded.display_name,
				        attached=1, metadata_json=excluded.metadata_json, last_attached_at=excluded.last_attached_at`,
				args: [
					input.id,
					input.root,
					input.displayName,
					JSON.stringify(input.metadata ?? {}),
					input.createdAt,
					now,
				],
			});
			await this.audit(
				tx,
				"project.attached",
				"orchestrator",
				{},
				{
					projectId: input.id,
				},
			);
		});
	}

	async detachProject(projectId: string): Promise<void> {
		await this.withWrite(async (tx) => {
			const row = await one(
				tx,
				"UPDATE rp_projects SET attached=0, last_detached_at=? WHERE id=? RETURNING id",
				[this.now(), projectId],
			);
			if (!row) return;
			await this.audit(
				tx,
				"project.detached",
				"orchestrator",
				{},
				{
					projectId,
				},
			);
		});
	}

	async projects(): Promise<
		{ id: string; root: string; displayName: string; attached: boolean }[]
	> {
		const rows = await all(
			this.client,
			"SELECT id,root,display_name,attached FROM rp_projects ORDER BY display_name",
		);
		return rows.map((row) => ({
			id: str(row.id, "project id"),
			root: str(row.root, "project root"),
			displayName: str(row.display_name, "project name"),
			attached: int(row.attached, "project attached") === 1,
		}));
	}

	/** The stable identity of this host's ledger, created once. */
	async ensureHostId(): Promise<string> {
		return this.withWrite(async (tx) => {
			await tx.execute({
				sql: "INSERT INTO rp_host_meta(singleton,host_id) VALUES(1,?) ON CONFLICT(singleton) DO NOTHING",
				args: [randomUUID()],
			});
			const row = await one(tx, "SELECT host_id FROM rp_host_meta");
			return str(row?.host_id, "host id");
		});
	}

	// Host resource definitions (the owner's confirmed configuration)

	async readHostConfig(): Promise<HostConfigRows> {
		const tx = await this.client.transaction("read");
		try {
			return await this.hostConfigRows(tx);
		} finally {
			tx.close();
		}
	}

	private async hostConfigRows(target: Target): Promise<HostConfigRows> {
		const meta = await one(
			target,
			"SELECT * FROM rp_host_meta WHERE singleton=1",
		);
		return {
			hostId: meta ? str(meta.host_id, "host id") : null,
			generation: meta ? int(meta.generation, "host generation") : 0,
			definitions: (
				await all(target, "SELECT * FROM rp_host_definitions ORDER BY id")
			).map((row) => str(row.definition_json, "host definition")),
			bindings: (
				await all(target, "SELECT * FROM rp_host_bindings ORDER BY id")
			).map((row) => str(row.binding_json, "host binding")),
		};
	}

	/**
	 * Applies one configuration change atomically and bumps the generation. The
	 * callback sees the rows inside the write lock, so its checks cannot race.
	 */
	async writeHostConfig<T>(
		actor: string,
		action: string,
		change: (
			rows: HostConfigRows,
			write: {
				definition(id: string, version: number, json: string): Promise<void>;
				binding(
					id: string,
					resourceId: string,
					stableKey: string,
					version: number,
					json: string,
				): Promise<void>;
			},
		) => Promise<T>,
		detail: Record<string, unknown> = {},
	): Promise<T> {
		return this.withWrite(async (tx) => {
			await tx.execute({
				sql: "INSERT INTO rp_host_meta(singleton,host_id) VALUES(1,?) ON CONFLICT(singleton) DO NOTHING",
				args: [randomUUID()],
			});
			const rows = await this.hostConfigRows(tx);
			const result = await change(rows, {
				definition: async (id, version, json) => {
					await tx.execute({
						sql: `INSERT INTO rp_host_definitions(id,version,definition_json) VALUES(?,?,?)
						      ON CONFLICT(id) DO UPDATE SET version=excluded.version, definition_json=excluded.definition_json`,
						args: [id, version, json],
					});
				},
				binding: async (id, resourceId, stableKey, version, json) => {
					await tx.execute({
						sql: `INSERT INTO rp_host_bindings(id,resource_id,stable_key,version,binding_json) VALUES(?,?,?,?,?)
						      ON CONFLICT(id) DO UPDATE SET stable_key=excluded.stable_key, version=excluded.version, binding_json=excluded.binding_json`,
						args: [id, resourceId, stableKey, version, json],
					});
				},
			});
			await tx.execute("UPDATE rp_host_meta SET generation=generation+1");
			await this.audit(tx, action, actor, {}, detail);
			return result;
		});
	}

	async auditEntries(
		input: { after?: number; limit?: number } = {},
	): Promise<ResourceAuditEntry[]> {
		const limit = Math.max(1, Math.min(input.limit ?? 200, 1_000));
		const rows =
			input.after === undefined
				? (
						await all(
							this.client,
							"SELECT * FROM rp_audit ORDER BY seq DESC LIMIT ?",
							[limit],
						)
					).reverse()
				: await all(
						this.client,
						"SELECT * FROM rp_audit WHERE seq>? ORDER BY seq LIMIT ?",
						[input.after, limit],
					);
		return rows.map((row) => ({
			seq: int(row.seq, "audit seq"),
			at: int(row.at_ms, "audit at"),
			action: str(row.action, "audit action"),
			actor: str(row.actor, "audit actor"),
			poolId: row.pool_id === null ? null : str(row.pool_id, "audit pool"),
			leaseId: row.lease_id === null ? null : str(row.lease_id, "audit lease"),
			detail: parsed<Record<string, unknown>>(row.detail_json, "audit detail"),
		}));
	}

	// Probe evidence

	/** The last persisted evidence, whichever process wrote it. */
	async readProbeEvidence(): Promise<{
		health: ObservationHealth[];
		samples: StoredObservation[];
	}> {
		const [health, samples] = await Promise.all([
			all(this.client, "SELECT * FROM rp_probe_health ORDER BY kind"),
			all(this.client, "SELECT * FROM rp_probe_samples ORDER BY binding_id"),
		]);
		return {
			health: health.map((row) => ({
				kind: str(row.kind, "probe kind"),
				result: str(row.result, "probe result") as ObservationHealth["result"],
				checkedAt: int(row.checked_at, "probe checked"),
				processBootId: str(row.process_boot_id, "probe boot"),
				kernelBootId:
					row.kernel_boot_id === null
						? null
						: str(row.kernel_boot_id, "probe kernel"),
				detail: parsed<Record<string, unknown>>(
					row.detail_json,
					"probe detail",
				),
			})),
			samples: samples.map(probeSampleFrom),
		};
	}

	async recordProbeHealth(health: ObservationHealth): Promise<void> {
		await this.withWrite(async (tx) => {
			await writeProbeHealth(tx, health);
			await this.audit(
				tx,
				"observation.health",
				"observation-service",
				{},
				{
					kind: health.kind,
					result: health.result,
				},
			);
		});
	}

	async recordProbeSample(sample: StoredObservation): Promise<void> {
		await this.withWrite(async (tx) => {
			const current = await one(
				tx,
				"SELECT sequence,process_boot_id FROM rp_probe_samples WHERE binding_id=?",
				[sample.bindingId],
			);
			if (
				current &&
				current.process_boot_id === sample.processBootId &&
				BigInt(current.sequence as bigint) >= sample.sequence
			) {
				return;
			}
			await writeProbeSample(tx, sample);
			await this.audit(
				tx,
				"observation.recorded",
				"observation-service",
				{},
				{
					kind: sample.kind,
					result: sample.result,
				},
			);
		});
	}

	/**
	 * One adapter's health and samples in one transaction, so a reader never
	 * sees a mix. A retry of the same batch is a no-op, an older one is
	 * ignored, and different content under one sequence is refused.
	 */
	async recordProbeBatch(
		health: ObservationHealth,
		samples: readonly StoredObservation[],
	): Promise<{ meaningfulChange: boolean }> {
		const generation = probeGeneration(health.detail);
		if (
			!generation ||
			generation.processBootId !== health.processBootId ||
			generation.kernelBootId !== health.kernelBootId
		) {
			throw new ResourceError(
				"observation batch health has an invalid generation envelope",
				"REFUSED",
			);
		}
		return this.withWrite(async (tx) => {
			const previous = await one(
				tx,
				"SELECT * FROM rp_probe_health WHERE kind=?",
				[health.kind],
			);
			const previousDetail = previous
				? parsed<Record<string, unknown>>(previous.detail_json, "probe detail")
				: null;
			const healthExact =
				previous !== null &&
				previous !== undefined &&
				previous.result === health.result &&
				int(previous.checked_at, "probe checked") === health.checkedAt &&
				previous.process_boot_id === health.processBootId &&
				(previous.kernel_boot_id ?? null) === health.kernelBootId &&
				canonicalJson(previousDetail) === canonicalJson(health.detail ?? {});
			const previousGeneration = probeGeneration(previousDetail);
			if (
				previousGeneration?.processBootId === generation.processBootId &&
				previousGeneration.sequence > generation.sequence
			) {
				return { meaningfulChange: false };
			}

			const seen = new Set<string>();
			const pending: {
				sample: StoredObservation;
				exact: boolean;
				changed: boolean;
			}[] = [];
			for (const sample of samples) {
				if (
					sample.kind !== health.kind ||
					sample.sequence !== generation.sequence ||
					sample.result !== health.result ||
					sample.processBootId !== generation.processBootId ||
					sample.kernelBootId !== generation.kernelBootId ||
					seen.has(sample.bindingId)
				) {
					throw new ResourceError(
						"observation batch contains a duplicate binding or mixed generation",
						"REFUSED",
					);
				}
				seen.add(sample.bindingId);
				const row = await one(
					tx,
					"SELECT * FROM rp_probe_samples WHERE binding_id=?",
					[sample.bindingId],
				);
				const current = row ? probeSampleFrom(row) : null;
				const sameBoot = current?.processBootId === sample.processBootId;
				if (current && sameBoot && current.sequence > sample.sequence) {
					return { meaningfulChange: false };
				}
				const exact = current !== null && sameProbeSample(current, sample);
				if (
					current &&
					sameBoot &&
					current.sequence === sample.sequence &&
					!exact
				) {
					throw new ResourceError(
						`observation sequence conflict for binding '${sample.bindingId}'`,
						"REFUSED",
					);
				}
				pending.push({
					sample,
					exact,
					changed: !current || !sameProbeContent(current, sample),
				});
			}
			if (
				previous &&
				int(previous.checked_at, "probe checked") === health.checkedAt &&
				previousGeneration?.sequence === generation.sequence &&
				previous.process_boot_id === generation.processBootId &&
				!healthExact
			) {
				throw new ResourceError(
					`observation health timestamp conflict for kind '${health.kind}'`,
					"REFUSED",
				);
			}
			if (healthExact && pending.every((item) => item.exact)) {
				return { meaningfulChange: false };
			}

			const meaningfulChange =
				!previous ||
				this.now() - int(previous.checked_at, "probe checked") >
					RAM_OBSERVATION_MAX_AGE_MS ||
				previous.result !== health.result ||
				previous.process_boot_id !== health.processBootId ||
				(previous.kernel_boot_id ?? null) !== health.kernelBootId ||
				meaningfulProbeDetail(previousDetail) !==
					meaningfulProbeDetail(health.detail) ||
				pending.some((item) => item.changed);
			await writeProbeHealth(tx, health);
			for (const { sample, exact } of pending) {
				if (!exact) await writeProbeSample(tx, sample);
			}
			if (meaningfulChange) {
				await this.audit(
					tx,
					"observation.batch",
					"observation-service",
					{},
					{
						kind: health.kind,
						result: health.result,
						samples: samples.length,
					},
				);
			}
			return { meaningfulChange };
		});
	}

	// Incidents

	/**
	 * Opens, updates or resolves one incident; a null context means the
	 * condition is proven gone. Callers skip this when evidence is uncertain,
	 * because uncertainty never proves recovery.
	 */
	async setIncident(input: {
		key: string;
		kind: PoolIncidentKind;
		poolId: string;
		context: Record<string, unknown> | null;
	}): Promise<"opened" | "updated" | "resolved" | "unchanged"> {
		return this.withWrite(async (tx) => {
			const now = this.now();
			const current = await one(
				tx,
				"SELECT state FROM rp_incidents WHERE incident_key=?",
				[input.key],
			);
			const wasOpen = current?.state === "open";
			const refs = { poolId: input.poolId };
			if (input.context === null) {
				if (!wasOpen) return "unchanged";
				await tx.execute({
					sql: "UPDATE rp_incidents SET state='resolved',updated_at=?,resolved_at=? WHERE incident_key=?",
					args: [now, now, input.key],
				});
				await this.audit(tx, "incident.resolved", "core", refs, {
					key: input.key,
					kind: input.kind,
				});
				return "resolved";
			}
			const context = encodeIncidentContext(input.context);
			await tx.execute({
				sql: `INSERT INTO rp_incidents(incident_key,kind,pool_id,state,opened_at,updated_at,resolved_at,context_json)
				      VALUES(?,?,?,'open',?,?,NULL,?)
				      ON CONFLICT(incident_key) DO UPDATE SET state='open',
				        opened_at=CASE WHEN rp_incidents.state='resolved' THEN excluded.opened_at ELSE rp_incidents.opened_at END,
				        updated_at=excluded.updated_at, resolved_at=NULL,
				        context_json=excluded.context_json`,
				args: [input.key, input.kind, input.poolId, now, now, context],
			});
			if (wasOpen) return "updated";
			await this.audit(tx, "incident.opened", "core", refs, {
				key: input.key,
				kind: input.kind,
				context: JSON.parse(context),
			});
			return "opened";
		});
	}

	async incidents(): Promise<PoolIncident[]> {
		const rows = await all(
			this.client,
			"SELECT * FROM rp_incidents ORDER BY incident_key",
		);
		return rows.map((row) => ({
			key: str(row.incident_key, "incident key"),
			kind: str(row.kind, "incident kind") as PoolIncidentKind,
			poolId: str(row.pool_id, "incident pool"),
			state: str(row.state, "incident state") as PoolIncident["state"],
			openedAt: int(row.opened_at, "incident opened"),
			updatedAt: int(row.updated_at, "incident updated"),
			resolvedAt:
				row.resolved_at === null
					? null
					: int(row.resolved_at, "incident resolved"),
			context: decodeIncidentContext(str(row.context_json, "incident context")),
		}));
	}

	// Read model

	async summaries(): Promise<PoolSummary[]> {
		const tx = await this.client.transaction("read");
		try {
			const now = this.now();
			const snapshot = await this.snapshot(tx);
			const queue = await this.queue_(tx);
			const pools = await all(tx, "SELECT * FROM rp_pools ORDER BY id");
			const created = new Map(
				(
					await all(
						tx,
						"SELECT id, created_at FROM rp_waiters WHERE state='waiting'",
					)
				).map((r) => [
					str(r.id, "waiter id"),
					int(r.created_at, "waiter created"),
				]),
			);
			const holds = (
				await all(
					tx,
					"SELECT * FROM rp_holds WHERE cleared_at IS NULL AND (until IS NULL OR until > ?) ORDER BY opened_at, id",
					[now],
				)
			).map(holdFrom);
			const out: PoolSummary[] = [];
			for (const row of pools) {
				const poolId = str(row.id, "pool id");
				const pool = snapshot.get(poolId);
				if (!pool) continue;
				const specs = await all(
					tx,
					"SELECT spec_json FROM rp_dimensions WHERE pool_id=? ORDER BY name",
					[poolId],
				);
				const dimensions: DimensionSummary[] = [];
				for (const specRow of specs) {
					const spec = parsed<Dimension>(specRow.spec_json, "dimension spec");
					const s = pool.dimensions.get(spec.name);
					if (!s) continue;
					let estimated = 0;
					if (spec.kind === "window") {
						const value = await one(
							tx,
							"SELECT COALESCE(SUM(amount),0) AS v FROM rp_ledger WHERE pool_id=? AND dimension=? AND state='estimated' AND at_ms>=?",
							[poolId, spec.name, windowStart(spec.window, now)],
						);
						estimated = int(value?.v, "estimated sum");
					}
					dimensions.push({
						name: spec.name,
						kind: spec.kind,
						capacity:
							s.kind === "meter" ? null : fromStored(s.kind, s.capacity),
						used: fromStored(s.kind, s.used),
						settled: fromStored(s.kind, s.settled),
						reserved: fromStored(s.kind, s.used - s.settled),
						estimated: fromStored(s.kind, estimated),
						fraction: s.kind === "meter" ? (s.meterFraction ?? null) : null,
					});
				}
				const waiting = queue.filter((w) =>
					w.claims.some((c) => c.poolId === poolId),
				);
				const parked = waiting.filter(
					(w) => decide(snapshot, queue, w, now).status === "parked",
				).length;
				const oldest = waiting.reduce<number | null>((min, w) => {
					const at = created.get(w.id) ?? now;
					return min === null || at < min ? at : min;
				}, null);
				const observed = await one(
					tx,
					"SELECT observed_at FROM rp_observations WHERE pool_id=?",
					[poolId],
				);
				out.push({
					poolId,
					title: str(row.title, "pool title"),
					providerHardLimit: int(row.provider_hard_limit, "hard limit") === 1,
					holds: holds.filter((h) => h.poolId === poolId),
					dimensions,
					queueDepth: waiting.length,
					parked,
					oldestWaitMs: oldest === null ? null : now - oldest,
					observedAt: observed
						? int(observed.observed_at, "observed_at")
						: null,
				});
			}
			return out;
		} finally {
			tx.close();
		}
	}
}

function claimFrom(row: Row): StoredClaim {
	const unit = row.unit;
	return {
		poolId: str(row.pool_id, "claim pool"),
		dimension: str(row.dimension, "claim dimension"),
		amount: int(row.amount, "claim amount"),
		...(unit === null || unit === undefined
			? {}
			: { unit: str(unit, "claim unit") }),
	};
}

function cleanupFrom(row: Row): CleanupRecord {
	return {
		ownershipToken: str(row.ownership_token, "cleanup token"),
		leaseId: str(row.lease_id, "cleanup lease"),
		poolId: str(row.pool_id, "cleanup pool"),
		projectId: str(row.project_id, "cleanup project"),
		externalId:
			row.external_id === null
				? null
				: str(row.external_id, "cleanup external"),
		state: str(row.state, "cleanup state") as CleanupRecord["state"],
		teardownAttempts: int(row.teardown_attempts, "cleanup attempts"),
		lastError:
			row.last_error === null ? null : str(row.last_error, "cleanup error"),
		createdAt: int(row.created_at, "cleanup created"),
	};
}

function entryKey(leaseId: string, poolId: string, dimension: string): string {
	return `lease:${leaseId}:${poolId}:${dimension}`;
}

function isLive(state: ResourceLeaseState): boolean {
	return (LIVE_LEASE_STATES as readonly string[]).includes(state);
}

/** Opens the resource core's tables inside `$MFW_HOME/host/host.db`. */
export async function openResourceStore(
	mfwHome: string,
	options: OpenResourceStoreOptions = {},
): Promise<ResourceStore> {
	const path = join(mfwHome, "host", "host.db");
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const timeout = options.busyTimeoutMs ?? 2_000;
	const slice = Math.max(1, Math.min(25, timeout));
	const client = createClient({
		url: `file:${path}`,
		intMode: "bigint",
		timeout: slice,
	});
	try {
		const started = performance.now();
		for (;;) {
			try {
				await client.executeMultiple(
					`PRAGMA journal_mode=WAL;
					 PRAGMA synchronous=FULL;
					 PRAGMA foreign_keys=ON;
					 PRAGMA busy_timeout=${slice};`,
				);
				const tx = await client.transaction("write");
				try {
					const table = await one(
						tx,
						"SELECT name FROM sqlite_master WHERE type='table' AND name='rp_schema'",
					);
					if (!table) {
						await tx.executeMultiple(RESOURCE_SCHEMA);
						await tx.executeMultiple(RESOURCE_CLEANUP_SCHEMA);
						await tx.executeMultiple(RESOURCE_INCIDENT_SCHEMA);
						await tx.executeMultiple(RESOURCE_PROBE_SCHEMA);
						await tx.execute({
							sql: "UPDATE rp_schema SET version=? WHERE singleton=1",
							args: [RESOURCE_SCHEMA_VERSION],
						});
					}
					const row = await one(
						tx,
						"SELECT version FROM rp_schema WHERE singleton=1",
					);
					let version = int(row?.version, "schema version");
					if (version === 1) {
						const columns = await all(tx, "PRAGMA table_info(rp_leases)");
						if (!columns.some((c) => c.name === "run_json")) {
							await tx.execute(
								"ALTER TABLE rp_leases ADD COLUMN run_json TEXT",
							);
							await tx.execute(
								"ALTER TABLE rp_leases ADD COLUMN owner_boot_id TEXT",
							);
						}
						const cleanup = await one(
							tx,
							"SELECT name FROM sqlite_master WHERE type='table' AND name='rp_cleanup'",
						);
						if (!cleanup) await tx.executeMultiple(RESOURCE_CLEANUP_SCHEMA);
						await tx.execute(
							"UPDATE rp_schema SET version=2 WHERE singleton=1",
						);
						version = 2;
					}
					if (version === 2) {
						const incidents = await one(
							tx,
							"SELECT name FROM sqlite_master WHERE type='table' AND name='rp_incidents'",
						);
						if (!incidents) await tx.executeMultiple(RESOURCE_INCIDENT_SCHEMA);
						await tx.execute(
							"UPDATE rp_schema SET version=3 WHERE singleton=1",
						);
						version = 3;
					}
					if (version === 3) {
						const probes = await one(
							tx,
							"SELECT name FROM sqlite_master WHERE type='table' AND name='rp_probe_health'",
						);
						if (!probes) await tx.executeMultiple(RESOURCE_PROBE_SCHEMA);
						await tx.execute(
							"UPDATE rp_schema SET version=4 WHERE singleton=1",
						);
						version = 4;
					}
					if (version !== RESOURCE_SCHEMA_VERSION) {
						throw new ResourceError(
							`resource schema ${version} is not the supported ${RESOURCE_SCHEMA_VERSION}`,
							"INCOMPATIBLE_SCHEMA",
						);
					}
					await tx.commit();
				} catch (error) {
					if (!tx.closed) await tx.rollback().catch(() => {});
					throw error;
				} finally {
					tx.close();
				}
				break;
			} catch (error) {
				if (error instanceof ResourceError) throw error;
				if (
					!/busy|locked/i.test(String(error)) ||
					performance.now() - started >= timeout
				) {
					throw error;
				}
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
		}
		return new ResourceStore(
			client,
			path,
			options.now ?? Date.now,
			timeout,
			options.processBootId,
			options.kernelBootId ?? null,
		);
	} catch (error) {
		client.close();
		if (error instanceof ResourceError) throw error;
		throw new ResourceError(
			`cannot open resource store: ${error instanceof Error ? error.message : String(error)}`,
			/busy|locked/i.test(String(error)) ? "BUSY" : "CORRUPT",
		);
	}
}
