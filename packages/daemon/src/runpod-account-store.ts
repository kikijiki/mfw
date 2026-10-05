import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type Client, createClient } from "@libsql/client";
import type { ExecutionOwnership } from "./execution-target.ts";
import type { RunPodPod } from "./runpod-client.ts";
import type {
	EffectiveRunPodPolicy,
	ObservedRunPodShape,
	RunPodMachinePolicy,
	RunPodPlacementRequest,
} from "./runpod-policy.ts";

const ACCOUNT_SCHEMA_VERSION = 8;
const WRITER_WAIT_MS = 5_000;
const MUTATION_LOCK_MS = 120_000;

export type RunPodLeasePhase =
	| "intent"
	| "provisioning"
	| "ready"
	| "staging"
	| "executing"
	| "collecting"
	| "quarantined"
	| "terminating"
	| "absent"
	| "failed";

export interface RunPodLeaseRecord {
	ref: string;
	createOperationId: string;
	owner: ExecutionOwnership;
	request: RunPodPlacementRequest;
	policy: EffectiveRunPodPolicy;
	ownershipEncoded: string;
	sshBootstrapId: string | null;
	sshPrivateKeyPath: string | null;
	sshPublicKey: string | null;
	sshHost: string | null;
	sshPort: number | null;
	sshHostPublicKey: string | null;
	phase: RunPodLeasePhase;
	providerPodId: string | null;
	observedShape: ObservedRunPodShape | null;
	quotedHourlyPrice: number;
	observedHourlyPrice: number | null;
	estimatedSpend: number;
	createdAt: number;
	updatedAt: number;
	lastObservedAt: number | null;
	teardownAttempts: number;
	lastErrorCode: string | null;
}

export type RunPodOperationKind =
	| "create"
	| "adopt"
	| "delete"
	| "inventory"
	| "reconcile";
export type RunPodOperationState =
	| "intent"
	| "submitted"
	| "completed"
	| "ambiguous"
	| "failed";

export interface RunPodInventoryRecord {
	pod: Omit<RunPodPod, "env" | "raw" | "publicIp" | "portMappings">;
	ownershipEncoded: string | null;
	observedAt: number;
}

export interface RunPodInventorySnapshotRecord {
	id: number;
	cause: string;
	podCount: number;
	observedAt: number;
}

export interface RunPodAccountBalanceRecord {
	remainingCredits: number | null;
	observedAt: number | null;
	checkedAt: number;
	errorCode: string | null;
}

export interface RunPodCleanupRecord {
	podId: string;
	observedPod: RunPodInventoryRecord["pod"];
	ownershipEncoded: string;
	projectId: string;
	runId: string;
	taskId: string | null;
	attempt: number;
	ownerKey: string;
	firstSeenAt: number;
	lastSeenAt: number;
	cleanupRequestedAt: number;
	cleanupAttempts: number;
	lastErrorCode: string | null;
	absenceConfirmedAt: number | null;
}

export interface RunPodDetachedProjectRecord {
	projectId: string;
	projectName: string;
	detachedAt: number;
}

export interface RunPodAuditRecord {
	id: number;
	kind: string;
	leaseRef: string | null;
	operationId: string | null;
	detail: Record<string, unknown>;
	createdAt: number;
}

export interface RunPodOperatorSettingsRecord {
	version: number;
	policy: RunPodMachinePolicy;
	dispatchPaused: boolean;
	updatedAt: number;
	updatedBy: string;
	reason: string;
}

export interface RunPodOperationSummary {
	state: RunPodOperationState;
	errorCode: string | null;
	updatedAt: number;
}

function operationState(value: unknown): RunPodOperationState {
	const state = rowString(value);
	if (
		state !== "intent" &&
		state !== "submitted" &&
		state !== "completed" &&
		state !== "ambiguous" &&
		state !== "failed"
	) {
		throw new Error(`RunPod account DB operation state ${state} is invalid`);
	}
	return state;
}

function json(value: unknown): string {
	return JSON.stringify(value);
}

function parseJson<T>(value: unknown): T {
	if (typeof value !== "string")
		throw new Error("RunPod account DB JSON is invalid");
	return JSON.parse(value) as T;
}

function rowNumber(value: unknown): number {
	if (typeof value === "bigint") return Number(value);
	if (typeof value === "number") return value;
	throw new Error("RunPod account DB number is invalid");
}

function rowString(value: unknown): string {
	if (typeof value !== "string")
		throw new Error("RunPod account DB text is invalid");
	return value;
}

function nullableString(value: unknown): string | null {
	return value === null ? null : rowString(value);
}

function nullableNumber(value: unknown): number | null {
	return value === null ? null : rowNumber(value);
}

function policyForStorage(
	policy: EffectiveRunPodPolicy,
): Record<string, unknown> {
	return {
		machine: policy.machine,
		allowedGpuTypes: policy.allowedGpuTypes
			? [...policy.allowedGpuTypes]
			: null,
		allowedCpuFlavors: policy.allowedCpuFlavors
			? [...policy.allowedCpuFlavors]
			: null,
		allowedImages: policy.allowedImages ? [...policy.allowedImages] : null,
		allowedClouds: policy.allowedClouds ? [...policy.allowedClouds] : null,
		maxHourlyPrice: policy.maxHourlyPrice,
		maxGpuCount: policy.maxGpuCount,
		maxConcurrentPods: policy.maxConcurrentPods,
		maxAggregateHourlyPrice: policy.maxAggregateHourlyPrice,
		maxRuntimeMinutes: policy.maxRuntimeMinutes,
		maxRunSpend: policy.maxRunSpend,
	};
}

function policyFromStorage(value: unknown): EffectiveRunPodPolicy {
	const stored = parseJson<{
		machine: EffectiveRunPodPolicy["machine"];
		allowedGpuTypes: string[] | null;
		allowedCpuFlavors: string[] | null;
		allowedImages: string[] | null;
		allowedClouds: Array<"SECURE" | "COMMUNITY"> | null;
		maxHourlyPrice: number;
		maxGpuCount: number | null;
		maxConcurrentPods: number | null;
		maxAggregateHourlyPrice: number;
		maxRuntimeMinutes: number;
		maxRunSpend: number;
	}>(value);
	return {
		...stored,
		allowedGpuTypes:
			stored.allowedGpuTypes === null ? null : new Set(stored.allowedGpuTypes),
		allowedCpuFlavors:
			stored.allowedCpuFlavors === null
				? null
				: new Set(stored.allowedCpuFlavors),
		allowedImages:
			stored.allowedImages === null ? null : new Set(stored.allowedImages),
		allowedClouds:
			stored.allowedClouds === null ? null : new Set(stored.allowedClouds),
	};
}

function leaseFromRow(row: Record<string, unknown>): RunPodLeaseRecord {
	return {
		ref: rowString(row.ref),
		createOperationId: rowString(row.create_operation_id),
		owner: {
			projectId: rowString(row.project_id),
			projectName: rowString(row.project_name),
			runId: rowString(row.run_id),
			taskId: nullableString(row.task_id),
			attempt: rowNumber(row.attempt),
			ownerKey: rowString(row.owner_key),
		},
		request: parseJson<RunPodPlacementRequest>(row.request_json),
		policy: policyFromStorage(row.policy_json),
		ownershipEncoded: rowString(row.ownership_json),
		sshBootstrapId: nullableString(row.ssh_bootstrap_id),
		sshPrivateKeyPath: nullableString(row.ssh_private_key_path),
		sshPublicKey: nullableString(row.ssh_public_key),
		sshHost: nullableString(row.ssh_host),
		sshPort: nullableNumber(row.ssh_port),
		sshHostPublicKey: nullableString(row.ssh_host_public_key),
		phase: rowString(row.phase) as RunPodLeasePhase,
		providerPodId: nullableString(row.provider_pod_id),
		observedShape:
			row.observed_shape_json === null
				? null
				: parseJson<ObservedRunPodShape>(row.observed_shape_json),
		quotedHourlyPrice: rowNumber(row.quoted_hourly_price),
		observedHourlyPrice: nullableNumber(row.observed_hourly_price),
		estimatedSpend: rowNumber(row.estimated_spend),
		createdAt: rowNumber(row.created_at),
		updatedAt: rowNumber(row.updated_at),
		lastObservedAt: nullableNumber(row.last_observed_at),
		teardownAttempts: rowNumber(row.teardown_attempts),
		lastErrorCode: nullableString(row.last_error_code),
	};
}

/** Deliberately excludes Pod env and the provider's unbounded raw object. */
function durablePodFact(pod: RunPodPod): Record<string, unknown> {
	return {
		id: pod.id,
		name: pod.name,
		desiredStatus: pod.desiredStatus,
		image: pod.image,
		costPerHr: pod.costPerHr,
		adjustedCostPerHr: pod.adjustedCostPerHr,
		cpuFlavorId: pod.cpuFlavorId,
		vcpuCount: pod.vcpuCount,
		memoryInGb: pod.memoryInGb,
		gpu:
			pod.gpu === null
				? null
				: { id: pod.gpu.id ?? null, count: pod.gpu.count ?? null },
		machine:
			pod.machine === null
				? null
				: {
						gpuTypeId: pod.machine.gpuTypeId ?? null,
						secureCloud: pod.machine.secureCloud ?? null,
					},
	};
}

function inventoryFromRow(row: Record<string, unknown>): RunPodInventoryRecord {
	const pod = parseJson<RunPodInventoryRecord["pod"]>(row.observed_json);
	return {
		pod,
		ownershipEncoded: nullableString(row.ownership_json),
		observedAt: rowNumber(row.observed_at),
	};
}

function cleanupFromRow(row: Record<string, unknown>): RunPodCleanupRecord {
	return {
		podId: rowString(row.pod_id),
		observedPod: parseJson<RunPodInventoryRecord["pod"]>(row.observed_json),
		ownershipEncoded: rowString(row.ownership_json),
		projectId: rowString(row.project_id),
		runId: rowString(row.run_id),
		taskId: nullableString(row.task_id),
		attempt: rowNumber(row.attempt),
		ownerKey: rowString(row.owner_key),
		firstSeenAt: rowNumber(row.first_seen_at),
		lastSeenAt: rowNumber(row.last_seen_at),
		cleanupRequestedAt: rowNumber(row.cleanup_requested_at),
		cleanupAttempts: rowNumber(row.cleanup_attempts),
		lastErrorCode: nullableString(row.last_error_code),
		absenceConfirmedAt: nullableNumber(row.absence_confirmed_at),
	};
}

export class RunPodAccountStore {
	private queue: Promise<unknown> = Promise.resolve();

	private constructor(
		readonly path: string,
		private readonly client: Client,
	) {}

	static path(mfwHome: string, accountId: string): string {
		if (!/^[a-zA-Z0-9_-]{1,64}$/.test(accountId)) {
			throw new Error("RunPod account id is not path-safe");
		}
		return join(mfwHome, "runpod", accountId, "account.db");
	}

	static async open(
		mfwHome: string,
		accountId: string,
	): Promise<RunPodAccountStore> {
		const path = RunPodAccountStore.path(mfwHome, accountId);
		await mkdir(dirname(path), { recursive: true, mode: 0o700 });
		const client = createClient({ url: `file:${path}` });
		await client.executeMultiple(
			[
				"PRAGMA journal_mode=WAL;",
				"PRAGMA synchronous=FULL;",
				"PRAGMA foreign_keys=ON;",
				`PRAGMA busy_timeout=${WRITER_WAIT_MS};`,
			].join("\n"),
		);
		const versionResult = await client.execute("PRAGMA user_version");
		const version = rowNumber(versionResult.rows[0]?.user_version ?? 0);
		if (version < 0 || version > ACCOUNT_SCHEMA_VERSION) {
			client.close();
			throw new Error(
				`RunPod account DB schema ${version} is not supported (expected ${ACCOUNT_SCHEMA_VERSION})`,
			);
		}
		if (version === 0) {
			await client.executeMultiple(`
				BEGIN IMMEDIATE;
				CREATE TABLE IF NOT EXISTS leases (
					ref TEXT PRIMARY KEY,
					create_operation_id TEXT NOT NULL UNIQUE,
					owner_key TEXT NOT NULL UNIQUE,
					project_id TEXT NOT NULL,
					project_name TEXT NOT NULL,
					run_id TEXT NOT NULL,
					task_id TEXT,
					attempt INTEGER NOT NULL CHECK (attempt > 0),
					request_json TEXT NOT NULL,
					policy_json TEXT NOT NULL,
					ownership_json TEXT NOT NULL UNIQUE,
					ssh_bootstrap_id TEXT UNIQUE,
					ssh_private_key_path TEXT,
					ssh_public_key TEXT,
					ssh_host TEXT,
					ssh_port INTEGER,
					ssh_host_public_key TEXT,
					phase TEXT NOT NULL,
					provider_pod_id TEXT UNIQUE,
					observed_shape_json TEXT,
					quoted_hourly_price REAL NOT NULL,
					observed_hourly_price REAL,
					estimated_spend REAL NOT NULL,
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL,
					last_observed_at INTEGER,
					teardown_attempts INTEGER NOT NULL DEFAULT 0,
					last_error_code TEXT
				);
				CREATE TABLE IF NOT EXISTS operations (
					operation_id TEXT PRIMARY KEY,
					lease_ref TEXT,
					kind TEXT NOT NULL,
					state TEXT NOT NULL,
					request_json TEXT NOT NULL,
					result_json TEXT,
					error_code TEXT,
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL,
					FOREIGN KEY (lease_ref) REFERENCES leases(ref)
				);
				CREATE TABLE IF NOT EXISTS inventory (
					pod_id TEXT PRIMARY KEY,
					observed_json TEXT NOT NULL,
					ownership_json TEXT,
					observed_at INTEGER NOT NULL
				);
				CREATE TABLE IF NOT EXISTS inventory_snapshots (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					cause TEXT NOT NULL,
					pod_count INTEGER NOT NULL,
					observed_at INTEGER NOT NULL
				);
				CREATE TABLE IF NOT EXISTS account_balance (
					id INTEGER PRIMARY KEY CHECK (id = 1),
					last_confirmed_credits REAL,
					last_confirmed_at INTEGER,
					checked_at INTEGER NOT NULL,
					error_code TEXT
				);
				CREATE TABLE IF NOT EXISTS audit (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					kind TEXT NOT NULL,
					lease_ref TEXT,
					operation_id TEXT,
					detail_json TEXT NOT NULL,
					created_at INTEGER NOT NULL
				);
				CREATE TABLE IF NOT EXISTS mutation_lock (
					id INTEGER PRIMARY KEY CHECK (id = 1),
					token TEXT,
					expires_at INTEGER NOT NULL DEFAULT 0
				);
				INSERT OR IGNORE INTO mutation_lock(id, token, expires_at) VALUES (1, NULL, 0);
				CREATE TABLE IF NOT EXISTS cleanup_queue (
					pod_id TEXT PRIMARY KEY,
					observed_json TEXT NOT NULL,
					ownership_json TEXT NOT NULL,
					project_id TEXT NOT NULL,
					run_id TEXT NOT NULL,
					task_id TEXT,
					attempt INTEGER NOT NULL CHECK (attempt > 0),
					owner_key TEXT NOT NULL,
					first_seen_at INTEGER NOT NULL,
					last_seen_at INTEGER NOT NULL,
					cleanup_requested_at INTEGER NOT NULL,
					cleanup_attempts INTEGER NOT NULL DEFAULT 0,
					last_error_code TEXT,
					absence_confirmed_at INTEGER
				);
				CREATE TABLE IF NOT EXISTS detached_projects (
					project_id TEXT PRIMARY KEY,
					project_name TEXT NOT NULL,
					detached_at INTEGER NOT NULL
				);
				PRAGMA user_version=${ACCOUNT_SCHEMA_VERSION};
				COMMIT;
			`);
		}
		if (version === 1) {
			await client.executeMultiple(`
				BEGIN IMMEDIATE;
				ALTER TABLE leases ADD COLUMN ssh_bootstrap_id TEXT;
				ALTER TABLE leases ADD COLUMN ssh_private_key_path TEXT;
				ALTER TABLE leases ADD COLUMN ssh_public_key TEXT;
				CREATE UNIQUE INDEX IF NOT EXISTS uq_runpod_ssh_bootstrap
					ON leases(ssh_bootstrap_id) WHERE ssh_bootstrap_id IS NOT NULL;
				PRAGMA user_version=${ACCOUNT_SCHEMA_VERSION};
				COMMIT;
			`);
		}
		if (version <= 2) {
			await client.executeMultiple(`
				BEGIN IMMEDIATE;
				CREATE TABLE IF NOT EXISTS cleanup_queue (
					pod_id TEXT PRIMARY KEY,
					observed_json TEXT NOT NULL,
					ownership_json TEXT NOT NULL,
					project_id TEXT NOT NULL,
					run_id TEXT NOT NULL,
					task_id TEXT,
					attempt INTEGER NOT NULL CHECK (attempt > 0),
					owner_key TEXT NOT NULL,
					first_seen_at INTEGER NOT NULL,
					last_seen_at INTEGER NOT NULL,
					cleanup_requested_at INTEGER NOT NULL,
					cleanup_attempts INTEGER NOT NULL DEFAULT 0,
					last_error_code TEXT,
					absence_confirmed_at INTEGER
				);
				PRAGMA user_version=${ACCOUNT_SCHEMA_VERSION};
				COMMIT;
			`);
		}
		if (version <= 3) {
			await client.executeMultiple(`
				BEGIN IMMEDIATE;
				CREATE TABLE IF NOT EXISTS operator_settings (
					id INTEGER PRIMARY KEY CHECK (id = 1),
					version INTEGER NOT NULL CHECK (version > 0),
					policy_json TEXT NOT NULL,
					dispatch_paused INTEGER NOT NULL CHECK (dispatch_paused IN (0, 1)),
					updated_at INTEGER NOT NULL,
					updated_by TEXT NOT NULL,
					reason TEXT NOT NULL
				);
				PRAGMA user_version=${ACCOUNT_SCHEMA_VERSION};
				COMMIT;
			`);
		}
		if (version > 0 && version <= 4) {
			const leaseColumns = new Set(
				(await client.execute("PRAGMA table_info(leases)")).rows.map((row) =>
					rowString(row.name),
				),
			);
			const additions = [
				["ssh_host", "TEXT"],
				["ssh_port", "INTEGER"],
				["ssh_host_public_key", "TEXT"],
			] as const;
			const migration = [
				"BEGIN IMMEDIATE;",
				...additions
					.filter(([column]) => !leaseColumns.has(column))
					.map(
						([column, type]) =>
							`ALTER TABLE leases ADD COLUMN ${column} ${type};`,
					),
				`PRAGMA user_version=${ACCOUNT_SCHEMA_VERSION};`,
				"COMMIT;",
			];
			await client.executeMultiple(migration.join("\n"));
		}
		if (version > 0 && version <= 5) {
			await client.executeMultiple(`
				BEGIN IMMEDIATE;
				CREATE TABLE IF NOT EXISTS account_balance (
					id INTEGER PRIMARY KEY CHECK (id = 1),
					remaining_credits REAL,
					observed_at INTEGER,
					checked_at INTEGER NOT NULL,
					error_code TEXT
				);
				PRAGMA user_version=${ACCOUNT_SCHEMA_VERSION};
				COMMIT;
			`);
		}
		if (version > 0 && version <= 6) {
			await client.executeMultiple(`
				BEGIN IMMEDIATE;
				ALTER TABLE account_balance RENAME COLUMN remaining_credits TO last_confirmed_credits;
				ALTER TABLE account_balance RENAME COLUMN observed_at TO last_confirmed_at;
				PRAGMA user_version=${ACCOUNT_SCHEMA_VERSION};
				COMMIT;
			`);
		}
		if (version > 0 && version <= 7) {
			await client.executeMultiple(`
				BEGIN IMMEDIATE;
				CREATE TABLE IF NOT EXISTS detached_projects (
					project_id TEXT PRIMARY KEY,
					project_name TEXT NOT NULL,
					detached_at INTEGER NOT NULL
				);
				PRAGMA user_version=${ACCOUNT_SCHEMA_VERSION};
				COMMIT;
			`);
		}
		const requiredColumns: ReadonlyArray<readonly [string, readonly string[]]> =
			[
				[
					"leases",
					[
						"ref",
						"create_operation_id",
						"ownership_json",
						"ssh_bootstrap_id",
						"ssh_private_key_path",
						"ssh_public_key",
						"ssh_host",
						"ssh_port",
						"ssh_host_public_key",
						"phase",
						"estimated_spend",
					],
				],
				[
					"operations",
					[
						"operation_id",
						"lease_ref",
						"kind",
						"state",
						"request_json",
						"updated_at",
					],
				],
				[
					"inventory",
					["pod_id", "observed_json", "ownership_json", "observed_at"],
				],
				[
					"account_balance",
					[
						"id",
						"last_confirmed_credits",
						"last_confirmed_at",
						"checked_at",
						"error_code",
					],
				],
				["mutation_lock", ["id", "token", "expires_at"]],
				[
					"operator_settings",
					[
						"id",
						"version",
						"policy_json",
						"dispatch_paused",
						"updated_at",
						"updated_by",
						"reason",
					],
				],
				[
					"cleanup_queue",
					[
						"pod_id",
						"observed_json",
						"ownership_json",
						"owner_key",
						"cleanup_requested_at",
						"absence_confirmed_at",
					],
				],
				["detached_projects", ["project_id", "project_name", "detached_at"]],
			];
		for (const [table, required] of requiredColumns) {
			const columns = await client.execute(`PRAGMA table_info(${table})`);
			const names = new Set(columns.rows.map((row) => row.name));
			for (const column of required) {
				if (!names.has(column)) {
					client.close();
					throw new Error(
						`RunPod account DB schema ${ACCOUNT_SCHEMA_VERSION} is missing ${table}.${column}`,
					);
				}
			}
		}
		return new RunPodAccountStore(path, client);
	}

	async getOperatorSettings(): Promise<RunPodOperatorSettingsRecord | null> {
		const result = await this.client.execute(
			"SELECT * FROM operator_settings WHERE id = 1",
		);
		const row = result.rows[0];
		if (!row) return null;
		return {
			version: rowNumber(row.version),
			policy: parseJson<RunPodMachinePolicy>(row.policy_json),
			dispatchPaused: rowNumber(row.dispatch_paused) === 1,
			updatedAt: rowNumber(row.updated_at),
			updatedBy: rowString(row.updated_by),
			reason: rowString(row.reason),
		};
	}

	async initializeOperatorSettings(
		policy: RunPodMachinePolicy,
	): Promise<RunPodOperatorSettingsRecord> {
		return this.serialize(() =>
			this.immediate(async () => {
				const now = Date.now();
				await this.client.execute({
					sql: `INSERT OR IGNORE INTO operator_settings (
						id, version, policy_json, dispatch_paused, updated_at, updated_by, reason
					) VALUES (1, 1, ?, 0, ?, 'daemon-config', 'initial machine policy')`,
					args: [json(policy), now],
				});
				const settings = await this.getOperatorSettings();
				if (!settings)
					throw new Error("RunPod operator settings were not initialized");
				return settings;
			}),
		);
	}

	async updateOperatorSettings(input: {
		expectedVersion: number;
		policy: RunPodMachinePolicy;
		dispatchPaused: boolean;
		actor: string;
		reason: string;
	}): Promise<RunPodOperatorSettingsRecord> {
		return this.serialize(() =>
			this.immediate(async () => {
				const now = Date.now();
				const updated = await this.client.execute({
					sql: `UPDATE operator_settings
						SET version = version + 1, policy_json = ?, dispatch_paused = ?,
							updated_at = ?, updated_by = ?, reason = ?
						WHERE id = 1 AND version = ?`,
					args: [
						json(input.policy),
						input.dispatchPaused ? 1 : 0,
						now,
						input.actor,
						input.reason,
						input.expectedVersion,
					],
				});
				if (updated.rowsAffected !== 1) {
					throw new Error("RunPod operator settings version conflict");
				}
				const settings = await this.getOperatorSettings();
				if (!settings) throw new Error("RunPod operator settings disappeared");
				return settings;
			}),
		);
	}

	close(): void {
		this.client.close();
	}

	private serialize<T>(fn: () => Promise<T>): Promise<T> {
		const next = this.queue.then(fn, fn);
		this.queue = next.catch(() => {});
		return next;
	}

	private async immediate<T>(fn: () => Promise<T>): Promise<T> {
		await this.client.execute("BEGIN IMMEDIATE");
		try {
			const result = await fn();
			await this.client.execute("COMMIT");
			return result;
		} catch (error) {
			await this.client.execute("ROLLBACK").catch(() => {});
			throw error;
		}
	}

	/**
	 * A committed logical mutex serializes provider mutations across daemon
	 * processes without holding an uncommitted intent over a network call.
	 */
	async withMutationLock<T>(fn: () => Promise<T>): Promise<T> {
		const token = randomUUID();
		const deadline = Date.now() + WRITER_WAIT_MS;
		for (;;) {
			const now = Date.now();
			const acquired = await this.client.execute({
				sql: `UPDATE mutation_lock SET token = ?, expires_at = ?
					WHERE id = 1 AND (token IS NULL OR expires_at <= ?)`,
				args: [token, now + MUTATION_LOCK_MS, now],
			});
			if (acquired.rowsAffected === 1) break;
			if (Date.now() >= deadline) {
				throw new Error("RunPod mutation writer wait exceeded 5000ms");
			}
			await Bun.sleep(25);
		}
		let stopped = false;
		let renewal: ReturnType<typeof setTimeout> | null = null;
		const renew = async (): Promise<void> => {
			if (stopped) return;
			await this.client
				.execute({
					sql: "UPDATE mutation_lock SET expires_at = ? WHERE id = 1 AND token = ?",
					args: [Date.now() + MUTATION_LOCK_MS, token],
				})
				.catch(() => {
					// The original lease remains valid; the next renewal retries.
				});
			if (!stopped)
				renewal = setTimeout(() => void renew(), MUTATION_LOCK_MS / 4);
		};
		renewal = setTimeout(() => void renew(), MUTATION_LOCK_MS / 4);
		try {
			return await fn();
		} finally {
			stopped = true;
			if (renewal) clearTimeout(renewal);
			await this.client
				.execute({
					sql: "UPDATE mutation_lock SET token = NULL, expires_at = 0 WHERE id = 1 AND token = ?",
					args: [token],
				})
				.catch(() => {
					// A stale bounded lock expires and is recoverable on the next mutation.
				});
		}
	}

	async putLeaseIntent(input: {
		ref: string;
		createOperationId: string;
		owner: ExecutionOwnership;
		request: RunPodPlacementRequest;
		policy: EffectiveRunPodPolicy;
		ownershipEncoded: string;
		sshBootstrapId: string;
		sshPrivateKeyPath: string;
		sshPublicKey: string;
	}): Promise<RunPodLeaseRecord> {
		return this.serialize(() =>
			this.immediate(async () => {
				const prior = await this.getLease(input.ref);
				if (prior) {
					if (
						prior.createOperationId !== input.createOperationId ||
						prior.owner.ownerKey !== input.owner.ownerKey ||
						prior.sshBootstrapId !== input.sshBootstrapId ||
						prior.sshPrivateKeyPath !== input.sshPrivateKeyPath ||
						prior.sshPublicKey !== input.sshPublicKey ||
						json(prior.request) !== json(input.request)
					) {
						throw new Error(`RunPod lease ${input.ref} idempotency conflict`);
					}
					return prior;
				}
				const now = Date.now();
				await this.client.execute({
					sql: `INSERT INTO leases (
						ref, create_operation_id, owner_key, project_id, project_name,
						run_id, task_id, attempt, request_json, policy_json, ownership_json,
						ssh_bootstrap_id, ssh_private_key_path, ssh_public_key,
						phase, quoted_hourly_price, estimated_spend, created_at, updated_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'intent', ?, ?, ?, ?)`,
					args: [
						input.ref,
						input.createOperationId,
						input.owner.ownerKey,
						input.owner.projectId,
						input.owner.projectName,
						input.owner.runId,
						input.owner.taskId,
						input.owner.attempt,
						json(input.request),
						json(policyForStorage(input.policy)),
						input.ownershipEncoded,
						input.sshBootstrapId,
						input.sshPrivateKeyPath,
						input.sshPublicKey,
						input.request.maxHourlyPrice,
						Math.min(
							input.request.maxSpend,
							input.request.maxHourlyPrice *
								(input.request.maxRuntimeMinutes / 60),
						),
						now,
						now,
					],
				});
				return (await this.getLease(input.ref)) as RunPodLeaseRecord;
			}),
		);
	}

	async getLease(ref: string): Promise<RunPodLeaseRecord | null> {
		const result = await this.client.execute({
			sql: "SELECT * FROM leases WHERE ref = ?",
			args: [ref],
		});
		const row = result.rows[0];
		return row ? leaseFromRow(row) : null;
	}

	async listLeases(): Promise<RunPodLeaseRecord[]> {
		const result = await this.client.execute(
			"SELECT * FROM leases ORDER BY created_at",
		);
		return result.rows.map(leaseFromRow);
	}

	async firstDeleteAttempts(): Promise<Map<string, number>> {
		const result =
			await this.client.execute(`SELECT lease_ref, MIN(created_at) AS created_at
			FROM operations WHERE kind = 'delete' AND lease_ref IS NOT NULL
			GROUP BY lease_ref`);
		return new Map(
			result.rows.map((row) => [
				rowString(row.lease_ref),
				rowNumber(row.created_at),
			]),
		);
	}

	async recordOperationIntent(input: {
		operationId: string;
		leaseRef: string | null;
		kind: RunPodOperationKind;
		request: Record<string, unknown>;
	}): Promise<RunPodOperationState> {
		return this.serialize(() =>
			this.immediate(async () => {
				const prior = await this.client.execute({
					sql: "SELECT kind, state, lease_ref, request_json FROM operations WHERE operation_id = ?",
					args: [input.operationId],
				});
				if (prior.rows[0]) {
					if (
						prior.rows[0].kind !== input.kind ||
						prior.rows[0].lease_ref !== input.leaseRef ||
						prior.rows[0].request_json !== json(input.request)
					) {
						throw new Error(
							`RunPod operation ${input.operationId} idempotency conflict`,
						);
					}
					return operationState(prior.rows[0].state);
				}
				const now = Date.now();
				await this.client.execute({
					sql: `INSERT INTO operations
						(operation_id, lease_ref, kind, state, request_json, created_at, updated_at)
						VALUES (?, ?, ?, 'intent', ?, ?, ?)`,
					args: [
						input.operationId,
						input.leaseRef,
						input.kind,
						json(input.request),
						now,
						now,
					],
				});
				return "intent";
			}),
		);
	}

	async getOperationState(
		operationId: string,
	): Promise<RunPodOperationState | null> {
		const result = await this.client.execute({
			sql: "SELECT state FROM operations WHERE operation_id = ?",
			args: [operationId],
		});
		return result.rows[0] ? operationState(result.rows[0].state) : null;
	}

	async latestOperation(
		kind: RunPodOperationKind,
	): Promise<RunPodOperationSummary | null> {
		const result = await this.client.execute({
			sql: `SELECT state, error_code, updated_at FROM operations
				WHERE kind = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1`,
			args: [kind],
		});
		const row = result.rows[0];
		return row
			? {
					state: operationState(row.state),
					errorCode: nullableString(row.error_code),
					updatedAt: rowNumber(row.updated_at),
				}
			: null;
	}

	async hasUnsafeCreateBoundary(): Promise<boolean> {
		const result = await this.client.execute(
			`SELECT COUNT(*) AS count FROM operations
			 WHERE kind = 'create' AND state IN ('submitted', 'ambiguous')`,
		);
		return rowNumber(result.rows[0]?.count ?? 0) > 0;
	}

	/**
	 * Commits the one-way provider-call boundary. Only the process that changes
	 * intent to submitted may perform the network call; a submitted operation is
	 * deliberately not retryable after restart.
	 */
	async markOperationSubmitted(operationId: string): Promise<boolean> {
		return this.serialize(() =>
			this.immediate(async () => {
				const submitted = await this.client.execute({
					sql: `UPDATE operations SET state = 'submitted', updated_at = ?
						WHERE operation_id = ? AND kind = 'create' AND state = 'intent'`,
					args: [Date.now(), operationId],
				});
				if (submitted.rowsAffected === 1) return true;
				const prior = await this.client.execute({
					sql: "SELECT state FROM operations WHERE operation_id = ?",
					args: [operationId],
				});
				if (!prior.rows[0]) {
					throw new Error(`unknown RunPod operation ${operationId}`);
				}
				return false;
			}),
		);
	}

	async finishOperation(
		operationId: string,
		state: Exclude<RunPodOperationState, "intent" | "submitted">,
		input: { result?: Record<string, unknown>; errorCode?: string } = {},
	): Promise<void> {
		await this.serialize(() =>
			this.immediate(async () => {
				await this.client.execute({
					sql: `UPDATE operations SET state = ?, result_json = ?, error_code = ?, updated_at = ?
						WHERE operation_id = ?`,
					args: [
						state,
						input.result ? json(input.result) : null,
						input.errorCode ?? null,
						Date.now(),
						operationId,
					],
				});
			}),
		);
	}

	async updateLease(
		ref: string,
		patch: {
			phase?: RunPodLeasePhase;
			providerPodId?: string | null;
			observedShape?: ObservedRunPodShape | null;
			observedHourlyPrice?: number | null;
			lastObservedAt?: number;
			incrementTeardown?: boolean;
			lastErrorCode?: string | null;
		},
	): Promise<RunPodLeaseRecord> {
		return this.serialize(() =>
			this.immediate(async () => {
				const prior = await this.getLease(ref);
				if (!prior) throw new Error(`unknown RunPod lease ${ref}`);
				await this.client.execute({
					sql: `UPDATE leases SET
						phase = ?, provider_pod_id = ?, observed_shape_json = ?,
						observed_hourly_price = ?, last_observed_at = ?,
						teardown_attempts = ?, last_error_code = ?, updated_at = ?
						WHERE ref = ?`,
					args: [
						patch.phase ?? prior.phase,
						patch.providerPodId === undefined
							? prior.providerPodId
							: patch.providerPodId,
						patch.observedShape === undefined
							? prior.observedShape
								? json(prior.observedShape)
								: null
							: patch.observedShape
								? json(patch.observedShape)
								: null,
						patch.observedHourlyPrice === undefined
							? prior.observedHourlyPrice
							: patch.observedHourlyPrice,
						patch.lastObservedAt ?? prior.lastObservedAt,
						prior.teardownAttempts + (patch.incrementTeardown ? 1 : 0),
						patch.lastErrorCode === undefined
							? prior.lastErrorCode
							: patch.lastErrorCode,
						Date.now(),
						ref,
					],
				});
				return (await this.getLease(ref)) as RunPodLeaseRecord;
			}),
		);
	}

	async pinLeaseSshEndpoint(
		ref: string,
		endpoint: { host: string; port: number; hostPublicKey: string },
	): Promise<RunPodLeaseRecord> {
		return this.serialize(() =>
			this.immediate(async () => {
				const prior = await this.getLease(ref);
				if (!prior) throw new Error(`unknown RunPod lease ${ref}`);
				const alreadyPinned =
					prior.sshHost !== null ||
					prior.sshPort !== null ||
					prior.sshHostPublicKey !== null;
				if (
					alreadyPinned &&
					(prior.sshHost !== endpoint.host ||
						prior.sshPort !== endpoint.port ||
						prior.sshHostPublicKey !== endpoint.hostPublicKey)
				) {
					throw new Error(`RunPod lease ${ref} SSH endpoint identity changed`);
				}
				if (!alreadyPinned) {
					await this.client.execute({
						sql: `UPDATE leases SET ssh_host=?, ssh_port=?, ssh_host_public_key=?, updated_at=? WHERE ref=?`,
						args: [
							endpoint.host,
							endpoint.port,
							endpoint.hostPublicKey,
							Date.now(),
							ref,
						],
					});
				}
				return (await this.getLease(ref)) as RunPodLeaseRecord;
			}),
		);
	}

	async recordInventory(
		cause: string,
		pods: readonly RunPodPod[],
		ownershipByPod: ReadonlyMap<string, string | null>,
	): Promise<void> {
		await this.serialize(() =>
			this.immediate(async () => {
				const now = Date.now();
				await this.client.execute("DELETE FROM inventory");
				for (const pod of pods) {
					await this.client.execute({
						sql: `INSERT INTO inventory
							(pod_id, observed_json, ownership_json, observed_at)
							VALUES (?, ?, ?, ?)`,
						args: [
							pod.id,
							json(durablePodFact(pod)),
							ownershipByPod.get(pod.id) ?? null,
							now,
						],
					});
				}
				await this.client.execute({
					sql: `INSERT INTO inventory_snapshots(cause, pod_count, observed_at)
						VALUES (?, ?, ?)`,
					args: [cause, pods.length, now],
				});
			}),
		);
	}

	async listInventory(): Promise<RunPodInventoryRecord[]> {
		const result = await this.client.execute(
			"SELECT * FROM inventory ORDER BY pod_id",
		);
		return result.rows.map(inventoryFromRow);
	}

	async latestInventorySnapshot(): Promise<RunPodInventorySnapshotRecord | null> {
		const result = await this.client.execute(
			"SELECT * FROM inventory_snapshots ORDER BY id DESC LIMIT 1",
		);
		const row = result.rows[0];
		return row
			? {
					id: rowNumber(row.id),
					cause: rowString(row.cause),
					podCount: rowNumber(row.pod_count),
					observedAt: rowNumber(row.observed_at),
				}
			: null;
	}

	async recordAccountBalanceSuccess(remainingCredits: number): Promise<void> {
		if (!Number.isFinite(remainingCredits)) {
			throw new Error("RunPod account balance is not finite");
		}
		await this.serialize(() =>
			this.immediate(async () => {
				const now = Date.now();
				await this.client.execute({
					sql: `INSERT INTO account_balance
						(id, last_confirmed_credits, last_confirmed_at, checked_at, error_code)
						VALUES (1, ?, ?, ?, NULL)
						ON CONFLICT(id) DO UPDATE SET
							last_confirmed_credits = excluded.last_confirmed_credits,
							last_confirmed_at = excluded.last_confirmed_at,
							checked_at = excluded.checked_at,
							error_code = NULL`,
					args: [remainingCredits, now, now],
				});
			}),
		);
	}

	async recordAccountBalanceFailure(errorCode: string): Promise<void> {
		await this.serialize(() =>
			this.immediate(async () => {
				await this.client.execute({
					sql: `INSERT INTO account_balance
						(id, last_confirmed_credits, last_confirmed_at, checked_at, error_code)
						VALUES (1, NULL, NULL, ?, ?)
						ON CONFLICT(id) DO UPDATE SET
							checked_at = excluded.checked_at,
							error_code = excluded.error_code`,
					args: [Date.now(), errorCode],
				});
			}),
		);
	}

	async accountBalance(): Promise<RunPodAccountBalanceRecord | null> {
		const result = await this.client.execute(
			"SELECT * FROM account_balance WHERE id = 1",
		);
		const row = result.rows[0];
		return row
			? {
					remainingCredits: nullableNumber(row.last_confirmed_credits),
					observedAt: nullableNumber(row.last_confirmed_at),
					checkedAt: rowNumber(row.checked_at),
					errorCode: nullableString(row.error_code),
				}
			: null;
	}

	async enqueueCleanup(input: {
		podId: string;
		pod: RunPodPod;
		ownershipEncoded: string;
		projectId: string;
		runId: string;
		taskId: string | null;
		attempt: number;
		ownerKey: string;
	}): Promise<RunPodCleanupRecord> {
		return this.serialize(() =>
			this.immediate(async () => {
				const now = Date.now();
				const prior = await this.getCleanup(input.podId);
				if (prior && prior.ownershipEncoded !== input.ownershipEncoded) {
					throw new Error(
						`RunPod cleanup ${input.podId} ownership changed unexpectedly`,
					);
				}
				await this.client.execute({
					sql: `INSERT INTO cleanup_queue (
						pod_id, observed_json, ownership_json, project_id, run_id, task_id, attempt,
						owner_key, first_seen_at, last_seen_at, cleanup_requested_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					ON CONFLICT(pod_id) DO UPDATE SET
						observed_json = excluded.observed_json,
						last_seen_at = excluded.last_seen_at,
						absence_confirmed_at = NULL`,
					args: [
						input.podId,
						json(durablePodFact(input.pod)),
						input.ownershipEncoded,
						input.projectId,
						input.runId,
						input.taskId,
						input.attempt,
						input.ownerKey,
						prior?.firstSeenAt ?? now,
						now,
						prior?.cleanupRequestedAt ?? now,
					],
				});
				return (await this.getCleanup(input.podId)) as RunPodCleanupRecord;
			}),
		);
	}

	async getCleanup(podId: string): Promise<RunPodCleanupRecord | null> {
		const result = await this.client.execute({
			sql: "SELECT * FROM cleanup_queue WHERE pod_id = ?",
			args: [podId],
		});
		return result.rows[0] ? cleanupFromRow(result.rows[0]) : null;
	}

	async listCleanup(): Promise<RunPodCleanupRecord[]> {
		const result = await this.client.execute(
			"SELECT * FROM cleanup_queue ORDER BY first_seen_at, pod_id",
		);
		return result.rows.map(cleanupFromRow);
	}

	async recordCleanupAttempt(
		podId: string,
		lastErrorCode: string | null,
	): Promise<void> {
		await this.serialize(() =>
			this.immediate(async () => {
				await this.client.execute({
					sql: `UPDATE cleanup_queue SET cleanup_attempts = cleanup_attempts + 1,
						last_error_code = ?, last_seen_at = ? WHERE pod_id = ?`,
					args: [lastErrorCode, Date.now(), podId],
				});
			}),
		);
	}

	async setCleanupError(podId: string, lastErrorCode: string): Promise<void> {
		await this.serialize(() =>
			this.immediate(async () => {
				await this.client.execute({
					sql: "UPDATE cleanup_queue SET last_error_code = ? WHERE pod_id = ?",
					args: [lastErrorCode, podId],
				});
			}),
		);
	}

	async confirmCleanupAbsence(podId: string, at = Date.now()): Promise<void> {
		await this.serialize(() =>
			this.immediate(async () => {
				await this.client.execute({
					sql: `UPDATE cleanup_queue SET absence_confirmed_at = ?,
						last_error_code = NULL, last_seen_at = ? WHERE pod_id = ?`,
					args: [at, at, podId],
				});
			}),
		);
	}

	async markProjectDetached(
		projectId: string,
		projectName: string,
	): Promise<RunPodDetachedProjectRecord> {
		return this.serialize(() =>
			this.immediate(async () => {
				const detachedAt = Date.now();
				await this.client.execute({
					sql: `INSERT INTO detached_projects
						(project_id, project_name, detached_at) VALUES (?, ?, ?)
						ON CONFLICT(project_id) DO UPDATE SET
							project_name = excluded.project_name,
							detached_at = excluded.detached_at`,
					args: [projectId, projectName, detachedAt],
				});
				return { projectId, projectName, detachedAt };
			}),
		);
	}

	async getDetachedProject(
		projectId: string,
	): Promise<RunPodDetachedProjectRecord | null> {
		const result = await this.client.execute({
			sql: "SELECT * FROM detached_projects WHERE project_id = ?",
			args: [projectId],
		});
		const row = result.rows[0];
		return row
			? {
					projectId: rowString(row.project_id),
					projectName: rowString(row.project_name),
					detachedAt: rowNumber(row.detached_at),
				}
			: null;
	}

	async listDetachedProjects(): Promise<RunPodDetachedProjectRecord[]> {
		const result = await this.client.execute(
			"SELECT * FROM detached_projects ORDER BY detached_at, project_id",
		);
		return result.rows.map((row) => ({
			projectId: rowString(row.project_id),
			projectName: rowString(row.project_name),
			detachedAt: rowNumber(row.detached_at),
		}));
	}

	async clearDetachedProject(projectId: string): Promise<void> {
		await this.serialize(() =>
			this.immediate(async () => {
				await this.client.execute({
					sql: "DELETE FROM detached_projects WHERE project_id = ?",
					args: [projectId],
				});
			}),
		);
	}

	async audit(input: {
		kind: string;
		leaseRef?: string;
		operationId?: string;
		detail?: Record<string, unknown>;
	}): Promise<void> {
		await this.serialize(() =>
			this.immediate(async () => {
				await this.client.execute({
					sql: `INSERT INTO audit
						(kind, lease_ref, operation_id, detail_json, created_at)
						VALUES (?, ?, ?, ?, ?)`,
					args: [
						input.kind,
						input.leaseRef ?? null,
						input.operationId ?? null,
						json(input.detail ?? {}),
						Date.now(),
					],
				});
			}),
		);
	}

	async listAudit(limit = 200): Promise<RunPodAuditRecord[]> {
		const result = await this.client.execute({
			sql: "SELECT * FROM audit ORDER BY id DESC LIMIT ?",
			args: [Math.max(1, Math.min(2_000, limit))],
		});
		return result.rows.map((row) => ({
			id: rowNumber(row.id),
			kind: rowString(row.kind),
			leaseRef: nullableString(row.lease_ref),
			operationId: nullableString(row.operation_id),
			detail: parseJson<Record<string, unknown>>(row.detail_json),
			createdAt: rowNumber(row.created_at),
		}));
	}
}
