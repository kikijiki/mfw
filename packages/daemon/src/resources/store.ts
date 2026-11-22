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
import { RESOURCE_SCHEMA, RESOURCE_SCHEMA_VERSION } from "./schema.ts";
import {
	type Actual,
	type AdmissionVerdict,
	type Claim,
	type ClaimSetRequest,
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
	type PoolSummary,
	type QuotaScope,
	ResourceError,
	type ResourceHeld,
	type ResourceLease,
	type ResourceLeaseState,
	type ResourceReconcileReport,
	type ResourceWaiter,
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

export interface OpenResourceStoreOptions {
	now?: () => number;
	busyTimeoutMs?: number;
}

export class ResourceStore {
	private queue: Promise<unknown> = Promise.resolve();
	private closed = false;

	constructor(
		private readonly client: Client,
		readonly path: string,
		private readonly now: () => number,
		private readonly busyTimeoutMs: number,
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
				"SELECT name, kind FROM rp_dimensions WHERE pool_id=?",
				[definition.id],
			);
			const next = new Map(dimensions.map((d) => [d.name, d]));
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
			await this.audit(tx, "pool.defined", "owner", { poolId: definition.id });
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
				sql: `INSERT INTO rp_leases(id,waiter_id,project_id,scopes_json,state,fence,granted_at,updated_at)
				      VALUES(?,?,?,?,'provisional',?,?,?)`,
				args: [
					leaseId,
					waiterId,
					waiter.projectId,
					scopesJson,
					fence,
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
				"lease.granted",
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
	): Promise<ResourceLease> {
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
				`UPDATE rp_leases SET state='active', run_id=?, activated_at=?, last_renewed_at=?, expires_at=?, updated_at=?
				 WHERE id=? AND fence=? RETURNING *`,
				[runId, now, now, now + leaseMs, now, id, fence],
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
	): Promise<void> {
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
				sql: "UPDATE rp_leases SET state='active', last_renewed_at=?, expires_at=?, updated_at=? WHERE id=? AND fence=?",
				args: [now, now + leaseMs, now, id, fence],
			});
			await this.audit(
				tx,
				lease.state === "uncertain" ? "lease.adopted" : "lease.renewed",
				"owner",
				{ leaseId: id },
			);
		});
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
			await this.closeLease(tx, lease, "force_released", reason, actor);
			return true;
		});
	}

	private async closeLease(
		tx: Transaction,
		lease: ResourceLease,
		to: "released" | "reclaimed" | "force_released",
		reason: string,
		actor: string,
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
		};
		for (const seen of await this.liveLeases()) {
			report.examined++;
			let evidence: LeaseEvidence;
			try {
				evidence = await inspect(seen);
			} catch {
				evidence = "unknown";
			}
			const outcome = await this.withWrite(async (tx) => {
				const lease = await this.fenced(tx, seen.id, seen.fence);
				if (!isLive(lease.state)) return "unchanged" as const;
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
					if (lease.state !== "uncertain") return "unchanged" as const;
					await this.transition(tx, lease, "active");
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
					if (!table) await tx.executeMultiple(RESOURCE_SCHEMA);
					const row = await one(
						tx,
						"SELECT version FROM rp_schema WHERE singleton=1",
					);
					const version = int(row?.version, "schema version");
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
		return new ResourceStore(client, path, options.now ?? Date.now, timeout);
	} catch (error) {
		client.close();
		if (error instanceof ResourceError) throw error;
		throw new ResourceError(
			`cannot open resource store: ${error instanceof Error ? error.message : String(error)}`,
			/busy|locked/i.test(String(error)) ? "BUSY" : "CORRUPT",
		);
	}
}
