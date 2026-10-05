import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
	ExecutionAccountServicePort,
	ProviderLease,
	ProviderLeaseCommand,
	ProviderLeaseIntent,
} from "./execution-target.ts";
import type { Logger } from "./log.ts";
import {
	type EphemeralRunPodSshKey,
	generateEphemeralRunPodSshKey,
	loadEphemeralRunPodSshKey,
	RemoteTransportError,
	type RunPodSshEndpoint,
	scanRunPodDirectSshHostKey,
} from "./remote-agent-host.ts";
import {
	RunPodAccountStore,
	type RunPodCleanupRecord,
	type RunPodLeaseRecord,
	type RunPodOperationState,
	type RunPodOperatorSettingsRecord,
} from "./runpod-account-store.ts";
import {
	type RunPodAccountBalance,
	RunPodApiError,
	type RunPodPod,
} from "./runpod-client.ts";
import {
	decodeRunPodOwnership,
	encodeRunPodOwnership,
	makeRunPodOwnership,
	RUNPOD_OWNERSHIP_ENV,
	type RunPodOwnershipMetadata,
	sameRunPodOwnership,
} from "./runpod-ownership.ts";
import {
	type EnabledRunPodMachinePolicy,
	effectiveRunPodPolicy,
	enforceRunPodAccountCaps,
	enforceRunPodRequest,
	isRunPodShapeVerified,
	type ObservedRunPodShape,
	type RunPodMachinePolicy,
	RunPodMachinePolicySchema,
	type RunPodMachineSafety,
	RunPodMachineSafetySchema,
	RunPodPlacementRequestSchema,
	type RunPodProjectPolicy,
	runPodShapeViolations,
} from "./runpod-policy.ts";

const DEFAULT_RECONCILE_INTERVAL_MS = 60_000;

function sshPublicKeyMaterial(value: string | null | undefined): string | null {
	if (!value) return null;
	const [algorithm, encoded] = value.trim().split(/\s+/);
	if (
		!algorithm ||
		!encoded ||
		!algorithm.startsWith("ssh-") ||
		!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
	) {
		return null;
	}
	return `${algorithm} ${encoded}`;
}

function sameSshPublicKey(
	observed: string | undefined,
	expected: string | null | undefined,
): boolean {
	const observedMaterial = sshPublicKeyMaterial(observed);
	const expectedMaterial = sshPublicKeyMaterial(expected);
	return observedMaterial !== null && observedMaterial === expectedMaterial;
}

export class RunPodControlPlaneError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "RunPodControlPlaneError";
	}
}

export interface RunPodGateStatus {
	open: boolean;
	reason: string | null;
	changedAt: number;
}

/** Independent from the local/global scheduler switch: this gates only remote dispatch. */
export class RunPodDispatchGate {
	private value: RunPodGateStatus = {
		open: false,
		reason: "RunPod inventory has not been reconciled",
		changedAt: Date.now(),
	};

	status(): RunPodGateStatus {
		return { ...this.value };
	}

	readonly gate = (): { reason: string } | null =>
		this.value.open
			? null
			: { reason: this.value.reason ?? "RunPod dispatch closed" };

	close(reason: string): void {
		this.value = { open: false, reason, changedAt: Date.now() };
	}

	open(): void {
		this.value = { open: true, reason: null, changedAt: Date.now() };
	}
}

export interface RunPodAccountServiceOptions {
	mfwHome: string;
	policy: RunPodMachinePolicy;
	client: RunPodProviderClient;
	log: Logger;
	projectPolicy?: (projectId: string) => RunPodProjectPolicy | undefined;
	/** Joins provider ownership to an attached project DB when one is available. */
	resolveOwner?: (
		owner: RunPodOwnershipMetadata,
		leaseRef: string | null,
		projectNameHint?: string,
	) => Promise<RunPodOwnerResolution>;
	absenceAttempts?: number;
	absenceDelayMs?: number;
	sshKeygenPath?: string;
	sshKeyBootstrap?: (
		identifier: string,
		directory: string,
		mode: "create" | "load",
	) => Promise<EphemeralRunPodSshKey>;
	resolveSshHostKey?: (host: string, port: number) => Promise<string>;
}

export type RunPodOwnerResolution =
	| { state: "active"; projectName: string }
	| { state: "ended"; projectName: string; resumeFinalization: () => void }
	| {
			state: "unavailable";
			projectName: string;
			reason: "project_unavailable";
	  }
	| {
			state: "unrecoverable";
			projectName: string | null;
			reason:
				| "project_missing"
				| "run_missing"
				| "identity_mismatch"
				| "terminal";
	  };

export interface RunPodProviderClient {
	credentialReady(): Promise<boolean>;
	getAccountBalance(): Promise<RunPodAccountBalance>;
	listPods(): Promise<RunPodPod[]>;
	createPod(input: {
		name: string;
		request: import("./runpod-policy.ts").RunPodPlacementRequest;
		createEnv: Readonly<Record<string, string>>;
	}): Promise<RunPodPod>;
	deletePod(podId: string): Promise<void>;
}

export interface RunPodLeaseConnection {
	lease: ProviderLease;
	endpoint: RunPodSshEndpoint;
}

export interface RunPodAccountStatus {
	enabled: boolean;
	credentialReady: boolean;
	gate: RunPodGateStatus;
	accountId: string;
	dbPath: string;
	lastInventoryAt: number | null;
	lastInventoryError: string | null;
	livePods: number;
	liveHourlyBurn: number | null;
	lastReconcileAt: number | null;
	lastReconcileError: string | null;
	cleanupPending: number;
}

export type RunPodOwnershipClassification =
	| "owned_tracked"
	| "owned_untracked"
	| "foreign_account"
	| "unknown";

export interface RunPodAccountReadModel {
	enabled: boolean;
	accountId: string;
	credential: {
		ready: boolean;
		checkedAt: number;
		validatedAt: number | null;
		validationError: string | null;
	};
	balance: {
		remainingCredits: number | null;
		currency: "USD";
		source: "RunPod clientBalance";
		inferredFromSpend: false;
		observedAt: number | null;
		checkedAt: number | null;
		fresh: boolean;
		error: string | null;
	};
	gate: RunPodGateStatus;
	settings: {
		version: number;
		dispatchPaused: boolean;
		updatedAt: number;
		updatedBy: string;
		reason: string;
		policy: RunPodMachinePolicy;
	};
	inventory: {
		observedAt: number | null;
		cause: string | null;
		fresh: boolean;
		error: string | null;
		podCount: number;
	};
	reconcile: {
		lastAttemptAt: number | null;
		lastError: string | null;
		cleanupPending: number;
	};
	policy: {
		hard: Record<string, unknown> | null;
	};
	pods: Array<{
		podId: string;
		name: string;
		desiredStatus: string;
		live: boolean;
		ownership: RunPodOwnershipClassification;
		projectId: string | null;
		projectName: string | null;
		taskId: string | null;
		runId: string | null;
		attempt: number | null;
		ownerKey: string | null;
		ownershipFingerprint: string | null;
		leaseRef: string | null;
		phase: string;
		requestedShape: Record<string, unknown> | null;
		actualShape: ObservedRunPodShape;
		ceilings: {
			hard: Record<string, unknown> | null;
			effective: Record<string, unknown> | null;
		};
		costPerHr: number | null;
		adjustedCostPerHr: number | null;
		hourlyBurn: number | null;
		estimatedRuntimeHours: number;
		estimatedInfrastructureCost: number | null;
		lifecycleAttempts: { teardown: number; cleanup: number };
		cleanup: {
			pending: boolean;
			requestedAt: number | null;
			pendingAgeMs: number | null;
			absenceConfirmedAt: number | null;
			lastError: string | null;
		};
	}>;
	costs: {
		providerInfrastructure: {
			label: "RunPod infrastructure";
			costPerHr: number | null;
			adjustedCostPerHr: number | null;
			hourlyBurn: number | null;
			estimatedCost: number | null;
		};
		agentTokens: {
			label: "Agent tokens";
			includedInInfrastructureCost: false;
			cost: null;
		};
	};
	historicalBilling: {
		available: false;
		key: "podId";
		gatesLiveSafety: false;
		records: [];
	};
	audit: Array<{
		id: number;
		kind: string;
		leaseRef: string | null;
		operationId: string | null;
		detail: Record<string, unknown>;
		createdAt: number;
	}>;
}

interface Inventory {
	pods: RunPodPod[];
	metadata: Map<string, RunPodOwnershipMetadata | null>;
	observedAt: number;
	cause: string;
}

interface InventoryInspection {
	untrackedOwned: Array<{
		pod: RunPodPod;
		metadata: RunPodOwnershipMetadata;
		encoded: string;
	}>;
}

function leaseRef(ownerKey: string): string {
	return `runpod_${createHash("sha256").update(ownerKey).digest("hex").slice(0, 32)}`;
}

function podHourlyPrice(pod: RunPodPod): number | null {
	// Nominal price is the conservative cap input. Savings may disappear.
	return pod.costPerHr ?? pod.adjustedCostPerHr;
}

function rawFinite(
	raw: Readonly<Record<string, unknown>> | undefined,
	key: string,
): number | null {
	const value = raw?.[key];
	const number = typeof value === "string" ? Number(value) : value;
	return typeof number === "number" && Number.isFinite(number) ? number : null;
}

export function observedRunPodShape(pod: RunPodPod): ObservedRunPodShape {
	const rawCloud = pod.raw?.cloudType;
	const cloud =
		rawCloud === "SECURE" || rawCloud === "COMMUNITY"
			? rawCloud
			: typeof pod.machine?.secureCloud === "boolean"
				? pod.machine.secureCloud
					? "SECURE"
					: "COMMUNITY"
				: null;
	const gpuType =
		(typeof pod.machine?.gpuTypeId === "string"
			? pod.machine.gpuTypeId
			: null) ?? (typeof pod.gpu?.id === "string" ? pod.gpu.id : null);
	const gpuCount =
		typeof pod.gpu?.count === "number" && Number.isFinite(pod.gpu.count)
			? pod.gpu.count
			: rawFinite(pod.raw, "gpuCount");
	const computeType = pod.cpuFlavorId ? "CPU" : gpuType ? "GPU" : null;
	return {
		computeType,
		offeringId: pod.cpuFlavorId ?? gpuType,
		gpuCount: computeType === "CPU" ? 0 : gpuCount,
		image: pod.image,
		cloud,
		hourlyPrice: podHourlyPrice(pod),
		vcpuCount: pod.vcpuCount,
		memoryInGb: pod.memoryInGb,
	};
}

function isLivePod(pod: RunPodPod): boolean {
	return pod.desiredStatus !== "TERMINATED" && pod.desiredStatus !== "EXITED";
}

function providerLease(lease: RunPodLeaseRecord): ProviderLease {
	return {
		ref: lease.ref,
		targetKind: "runpod",
		ownerKey: lease.owner.ownerKey,
		requestedShape: { ...lease.request },
		observedShape: lease.observedShape
			? {
					...lease.observedShape,
					phase: lease.phase,
					providerPodId: lease.providerPodId,
					verified: ["ready", "staging", "executing", "collecting"].includes(
						lease.phase,
					),
				}
			: {
					phase: lease.phase,
					providerPodId: lease.providerPodId,
					verified: false,
				},
	};
}

function createOperationRequest(
	lease: RunPodLeaseRecord,
): Record<string, unknown> {
	return {
		computeType: lease.request.computeType,
		image: lease.request.image,
		cloud: lease.request.cloud,
		maxHourlyPrice: lease.request.maxHourlyPrice,
	};
}

function isAmbiguousCreateBoundary(
	state: RunPodOperationState | null,
): boolean {
	return state === "submitted" || state === "ambiguous";
}

function safeCode(error: unknown): string {
	if (error instanceof RunPodApiError) return error.code;
	if (error instanceof RunPodControlPlaneError) return error.code;
	return "internal_error";
}

function redactedPodFact(
	pod: RunPodPod,
	metadata: RunPodOwnershipMetadata | null,
): Record<string, unknown> {
	return {
		podId: pod.id,
		desiredStatus: pod.desiredStatus,
		shape: observedRunPodShape(pod),
		costPerHr: pod.costPerHr,
		adjustedCostPerHr: pod.adjustedCostPerHr,
		ownership: metadata
			? {
					projectId: metadata.project,
					runId: metadata.run,
					taskId: metadata.task,
					attempt: metadata.attempt,
					ownerKey: metadata.owner,
				}
			: null,
	};
}

function policyCeilings(
	policy: EnabledRunPodMachinePolicy,
): Record<string, unknown> {
	return {
		maxHourlyPrice: policy.maxHourlyPrice,
		maxGpuCount: policy.maxGpuCount,
		maxConcurrentPods: policy.maxConcurrentPods,
		maxAggregateHourlyPrice: policy.maxAggregateHourlyPrice,
		maxRuntimeMinutes: policy.maxRuntimeMinutes,
		maxRunSpend: policy.maxRunSpend,
	};
}

function effectiveCeilings(
	policy: ReturnType<typeof effectiveRunPodPolicy>,
): Record<string, unknown> {
	return {
		maxHourlyPrice: policy.maxHourlyPrice,
		maxGpuCount: policy.maxGpuCount,
		maxConcurrentPods: policy.maxConcurrentPods,
		maxAggregateHourlyPrice: policy.maxAggregateHourlyPrice,
		maxRuntimeMinutes: policy.maxRuntimeMinutes,
		maxRunSpend: policy.maxRunSpend,
	};
}

export class RunPodAccountService implements ExecutionAccountServicePort {
	readonly gate = new RunPodDispatchGate();
	readonly accountId: string;
	readonly dbPath: string;
	private currentPolicy: RunPodMachinePolicy;
	private operatorSettings: RunPodOperatorSettingsRecord | null = null;
	private store: RunPodAccountStore | null = null;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private started = false;
	private mutationQueue: Promise<unknown> = Promise.resolve();
	private lastInventoryAt: number | null = null;
	private lastInventoryError: string | null = null;
	private lastReconcileAt: number | null = null;
	private lastReconcileError: string | null = null;
	private lastCredentialValidationAt: number | null = null;
	private lastCredentialValidationError: string | null = null;
	private credentialChangeInProgress = false;
	private latestInventory: RunPodPod[] = [];
	private readonly absenceAttempts: number;
	private readonly absenceDelayMs: number;
	private readonly sshKeygenPath: string;

	constructor(private readonly options: RunPodAccountServiceOptions) {
		this.currentPolicy = RunPodMachinePolicySchema.parse(options.policy);
		this.accountId = this.currentPolicy.accountId ?? "default";
		this.dbPath = RunPodAccountStore.path(options.mfwHome, this.accountId);
		this.absenceAttempts = options.absenceAttempts ?? 4;
		this.absenceDelayMs = options.absenceDelayMs ?? 250;
		this.sshKeygenPath =
			options.sshKeygenPath ?? Bun.which("ssh-keygen") ?? "/usr/bin/ssh-keygen";
		if (!this.currentPolicy.enabled)
			this.gate.close("RunPod is disabled by machine policy");
	}

	get policy(): RunPodMachinePolicy {
		return this.currentPolicy;
	}

	private openGate(): void {
		if (this.credentialChangeInProgress) {
			this.gate.close(
				"RunPod credential change is awaiting provider validation and reconciliation",
			);
			return;
		}
		if (this.operatorSettings?.dispatchPaused) {
			this.gate.close("RunPod dispatch is paused by the operator");
			return;
		}
		this.gate.open();
	}

	private async accountStore(): Promise<RunPodAccountStore> {
		this.store ??= await RunPodAccountStore.open(
			this.options.mfwHome,
			this.accountId,
		);
		return this.store;
	}

	/** Persist explicit project intent before its config entry disappears. */
	async markProjectDetached(
		projectId: string,
		projectName: string,
	): Promise<void> {
		await this.serializeMutation(async () => {
			const store = await this.accountStore();
			await store.withMutationLock(async () => {
				await store.markProjectDetached(projectId, projectName);
				await store.audit({
					kind: "project_detached",
					detail: { projectId, projectName },
				});
			});
		});
	}

	/** Exact stable-identity reattachment supersedes an old detach intent. */
	async markProjectReattached(
		projectId: string,
		projectName: string,
	): Promise<void> {
		await this.serializeMutation(async () => {
			const store = await this.accountStore();
			await store.withMutationLock(async () => {
				const detached = await store.getDetachedProject(projectId);
				if (!detached) return;
				await store.clearDetachedProject(projectId);
				await store.audit({
					kind: "project_reattached",
					detail: { projectId, projectName },
				});
			});
		});
	}

	private async resolveOwner(
		metadata: RunPodOwnershipMetadata,
		leaseRef: string | null,
		projectNameHint?: string,
	): Promise<RunPodOwnerResolution | null> {
		const resolution = this.options.resolveOwner
			? await this.options.resolveOwner(metadata, leaseRef, projectNameHint)
			: null;
		// An attached project is authoritative even over a stale tombstone; only the
		// exact stable id in durable detach state turns retention into cleanup.
		if (resolution && resolution.state !== "unavailable") return resolution;
		const detached = await (await this.accountStore()).getDetachedProject(
			metadata.project,
		);
		if (!detached) return resolution;
		return {
			state: "unrecoverable",
			projectName: detached.projectName,
			reason: "project_missing",
		};
	}

	private sshDirectory(identifier: string): string {
		if (!/^runpod_[a-f0-9]{32}$/.test(identifier)) {
			throw new RunPodControlPlaneError(
				"ssh_bootstrap_invalid",
				"RunPod SSH bootstrap identity is invalid",
			);
		}
		return join(dirname(this.dbPath), "ssh", identifier);
	}

	private async keyBootstrap(
		identifier: string,
		mode: "create" | "load",
	): Promise<EphemeralRunPodSshKey> {
		const directory = this.sshDirectory(identifier);
		if (this.options.sshKeyBootstrap) {
			return this.options.sshKeyBootstrap(identifier, directory, mode);
		}
		const opts = {
			identifier,
			directory,
			keygenPath: this.sshKeygenPath,
		};
		return mode === "create"
			? generateEphemeralRunPodSshKey(opts)
			: loadEphemeralRunPodSshKey(opts);
	}

	/** Create is legal only before a durable lease exists; retries always load. */
	private async ensurePreSubmissionBootstrap(
		ref: string,
	): Promise<EphemeralRunPodSshKey> {
		const store = await this.accountStore();
		const lease = await store.getLease(ref);
		// Once a lease references the key bytes, retries load them; replacement is only for an owner with no lease or provider linkage.
		if (lease) return this.loadLeaseBootstrap(lease);
		try {
			return await this.keyBootstrap(ref, "create");
		} catch {
			// No durable lease or submitted provider effect can reference these bytes.
			// rm unlinks a malicious directory symlink itself; it does not traverse it.
			await rm(this.sshDirectory(ref), { recursive: true, force: true });
			return this.keyBootstrap(ref, "create");
		}
	}

	private async loadLeaseBootstrap(
		lease: RunPodLeaseRecord,
	): Promise<EphemeralRunPodSshKey> {
		if (
			lease.sshBootstrapId !== lease.ref ||
			!lease.sshPrivateKeyPath ||
			!lease.sshPublicKey
		) {
			this.gate.close("RunPod SSH bootstrap metadata is incomplete");
			throw new RunPodControlPlaneError(
				"ssh_bootstrap_missing",
				"submitted RunPod lease has no complete durable SSH bootstrap",
			);
		}
		let key: EphemeralRunPodSshKey;
		try {
			key = await this.keyBootstrap(lease.ref, "load");
		} catch {
			this.gate.close("RunPod SSH bootstrap is unavailable or unsafe");
			throw new RunPodControlPlaneError(
				"ssh_bootstrap_invalid",
				"submitted RunPod lease SSH bootstrap is unavailable or unsafe",
			);
		}
		if (
			key.privateKeyPath !== lease.sshPrivateKeyPath ||
			key.publicKey !== lease.sshPublicKey
		) {
			this.gate.close("RunPod SSH bootstrap does not match durable metadata");
			throw new RunPodControlPlaneError(
				"ssh_bootstrap_mismatch",
				"submitted RunPod lease SSH bootstrap does not match durable metadata",
			);
		}
		return key;
	}

	private async removeLeaseBootstrap(lease: RunPodLeaseRecord): Promise<void> {
		if (
			lease.sshBootstrapId === null &&
			lease.sshPrivateKeyPath === null &&
			lease.sshPublicKey === null
		) {
			return;
		}
		const expectedDirectory = this.sshDirectory(lease.ref);
		if (
			lease.sshBootstrapId !== lease.ref ||
			!lease.sshPrivateKeyPath ||
			!lease.sshPrivateKeyPath.startsWith(`${expectedDirectory}/`)
		) {
			throw new RunPodControlPlaneError(
				"ssh_bootstrap_invalid",
				"RunPod SSH bootstrap cleanup target is not proven",
			);
		}
		await rm(expectedDirectory, { recursive: true, force: true });
	}

	private serializeMutation<T>(fn: () => Promise<T>): Promise<T> {
		const next = this.mutationQueue.then(fn, fn);
		this.mutationQueue = next.catch(() => {});
		return next;
	}

	async start(): Promise<void> {
		if (this.started) return;
		this.started = true;
		try {
			const store = await this.accountStore();
			this.operatorSettings = await store.initializeOperatorSettings(
				this.currentPolicy,
			);
			this.currentPolicy = RunPodMachinePolicySchema.parse(
				this.operatorSettings.policy,
			);
			if ((this.currentPolicy.accountId ?? "default") !== this.accountId) {
				throw new Error(
					"persisted RunPod account id does not match its database",
				);
			}
			const sshRoot = join(dirname(this.dbPath), "ssh");
			await mkdir(sshRoot, { recursive: true, mode: 0o700 });
		} catch (error) {
			this.started = false;
			throw error;
		}
		// Local phase is never proof of provider absence. Reconciliation performs
		// fresh inventory first and owns all lease-key cleanup decisions.
		if (this.currentPolicy.enabled) {
			await this.reconcile("startup").catch((error) => {
				this.options.log.warn(
					{ code: safeCode(error) },
					"RunPod startup reconciliation closed remote dispatch",
				);
			});
		} else {
			this.gate.close("RunPod is disabled by machine policy");
			await this.refreshAccountBalance("startup-disabled");
		}
		const schedule = (): void => {
			if (!this.started) return;
			const interval =
				(this.policy.enabled ? this.policy.reconcileIntervalMs : undefined) ??
				DEFAULT_RECONCILE_INTERVAL_MS;
			this.timer = setTimeout(async () => {
				this.timer = null;
				if (this.policy.enabled)
					await this.reconcile("periodic").catch((error) => {
						this.options.log.warn(
							{ code: safeCode(error) },
							"RunPod periodic reconciliation failed",
						);
					});
				else
					await this.serializeMutation(() =>
						this.refreshAccountBalance("periodic-disabled"),
					);
				schedule();
			}, interval);
			this.timer.unref?.();
		};
		schedule();
	}

	async stop(): Promise<void> {
		this.started = false;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		await this.mutationQueue.catch(() => {});
		if (this.store) {
			const pending = (await this.store.listLeases()).filter(
				(lease) => lease.phase !== "absent",
			);
			for (const lease of pending) {
				await this.store.audit({
					kind: "shutdown_cleanup_handoff",
					leaseRef: lease.ref,
					detail: { phase: lease.phase },
				});
			}
		}
		this.store?.close();
		this.store = null;
		this.operatorSettings = null;
	}

	/** Credential write, provider validation and ownership reconciliation share the create/delete queue and cross-process lock. */
	async setCredential(
		mutate: (validate: () => Promise<void>) => Promise<void>,
	): Promise<void> {
		await this.serializeMutation(async () => {
			const store = await this.accountStore();
			await store.withMutationLock(async () => {
				this.credentialChangeInProgress = true;
				this.gate.close(
					"RunPod credential change is awaiting provider validation and reconciliation",
				);
				let restoreGate = false;
				let candidateFailureCode: string | null = null;
				let candidateValidated = false;
				try {
					await mutate(async () => {
						try {
							await this.validateStoredCredential(store);
							await store.audit({
								kind: "credential_validated",
								detail: { result: "provider_account_read_succeeded" },
							});
							if (this.policy.enabled) {
								await this.reconcileWithLock("credential-set", store);
							} else {
								this.gate.close("RunPod is disabled by machine policy");
							}
							candidateValidated = true;
						} catch (error) {
							candidateFailureCode = safeCode(error);
							await store.audit({
								kind: "credential_validation_failed",
								detail: { result: candidateFailureCode },
							});
							throw error;
						}
					});
					if (!candidateValidated) {
						throw new RunPodControlPlaneError(
							"credential_validation_missing",
							"RunPod credential storage skipped candidate validation",
						);
					}
					restoreGate = this.policy.enabled;
				} catch (error) {
					const code = candidateFailureCode ?? safeCode(error);
					await store.audit({
						kind: "credential_change_rolled_back",
						detail: { result: code },
					});

					if (!(await this.options.client.credentialReady())) {
						this.lastCredentialValidationAt = null;
						this.lastCredentialValidationError = "credential_missing";
						await store.recordAccountBalanceFailure("credential_missing");
						this.gate.close(
							"RunPod rejected the new credential; no prior credential is stored",
						);
					} else {
						try {
							await this.validateStoredCredential(store);
							if (this.policy.enabled) {
								await this.reconcileWithLock("credential-rollback", store);
							} else {
								this.gate.close("RunPod is disabled by machine policy");
							}
							await store.audit({
								kind: "credential_rollback_validated",
								detail: { result: "prior_credential_restored" },
							});
							restoreGate = this.policy.enabled;
						} catch (restoreError) {
							const restoreCode = safeCode(restoreError);
							this.gate.close(
								"RunPod restored the prior credential but could not validate account safety",
							);
							await store.audit({
								kind: "credential_rollback_validation_failed",
								detail: { result: restoreCode },
							});
							throw new RunPodControlPlaneError(
								"credential_recovery_failed",
								`The prior RunPod credential was restored but could not be validated (${restoreCode})`,
							);
						}
					}
					throw new RunPodControlPlaneError(
						code === "credential_missing"
							? "credential_missing"
							: "credential_validation_failed",
						code === "credential_missing"
							? "The proposed RunPod credential is unavailable"
							: `RunPod rejected the proposed credential (${code})`,
					);
				} finally {
					this.credentialChangeInProgress = false;
					if (restoreGate) this.openGate();
				}
			});
		});
	}

	private async validateStoredCredential(
		store: RunPodAccountStore,
	): Promise<void> {
		if (!(await this.options.client.credentialReady())) {
			this.lastCredentialValidationAt = null;
			this.lastCredentialValidationError = "credential_missing";
			await store.recordAccountBalanceFailure("credential_missing");
			throw new RunPodControlPlaneError(
				"credential_missing",
				"The stored RunPod credential is unavailable",
			);
		}
		try {
			const balance = await this.options.client.getAccountBalance();
			await store.recordAccountBalanceSuccess(balance.remainingCredits);
			this.lastCredentialValidationAt = Date.now();
			this.lastCredentialValidationError = null;
		} catch (error) {
			const code = safeCode(error);
			this.lastCredentialValidationAt = null;
			this.lastCredentialValidationError = code;
			await store.recordAccountBalanceFailure(code);
			throw error;
		}
	}

	/** Removal is fail-closed before the credential bytes change and stays so. */
	async removeCredential(mutate: () => Promise<void>): Promise<void> {
		await this.serializeMutation(async () => {
			const store = await this.accountStore();
			await store.withMutationLock(async () => {
				this.gate.close("RunPod credential was removed");
				await mutate();
				this.lastCredentialValidationAt = null;
				this.lastCredentialValidationError = "credential_missing";
				await store.recordAccountBalanceFailure("credential_missing");
				await store.audit({
					kind: "credential_removed",
					detail: { result: "remote_dispatch_closed" },
				});
			});
		});
	}

	async status(): Promise<RunPodAccountStatus> {
		const credentialReady = await this.options.client.credentialReady();
		const live = this.latestInventory.filter(isLivePod);
		const prices = live.map(podHourlyPrice);
		const cleanupPending = this.policy.enabled
			? (await (await this.accountStore()).listCleanup()).filter(
					(record) => record.absenceConfirmedAt === null,
				).length
			: 0;
		return {
			enabled: this.policy.enabled,
			credentialReady,
			gate: this.gate.status(),
			accountId: this.accountId,
			dbPath: this.dbPath,
			lastInventoryAt: this.lastInventoryAt,
			lastInventoryError: this.lastInventoryError,
			livePods: live.length,
			liveHourlyBurn: prices.every((price) => price !== null)
				? prices.reduce<number>((sum, price) => sum + (price ?? 0), 0)
				: null,
			lastReconcileAt: this.lastReconcileAt,
			lastReconcileError: this.lastReconcileError,
			cleanupPending,
		};
	}

	private requireEnabled(): EnabledRunPodMachinePolicy {
		if (!this.policy.enabled) {
			throw new RunPodControlPlaneError(
				"account_disabled",
				"RunPod is disabled",
			);
		}
		return this.policy;
	}

	private async refreshAccountBalance(cause: string): Promise<void> {
		const store = await this.accountStore();
		try {
			const balance = await this.options.client.getAccountBalance();
			if (!Number.isFinite(balance.remainingCredits)) {
				throw new RunPodApiError(
					"invalid_response",
					"RunPod account balance was not finite",
				);
			}
			await store.recordAccountBalanceSuccess(balance.remainingCredits);
		} catch (error) {
			const code = safeCode(error);
			await store.recordAccountBalanceFailure(code);
			await store.audit({
				kind: "account_balance_failure",
				detail: { reason: cause, result: code },
			});
		}
	}

	private async fullInventory(cause: string): Promise<Inventory> {
		this.requireEnabled();
		const store = await this.accountStore();
		const operationId = `inventory/${Date.now()}/${randomUUID()}`;
		await store.recordOperationIntent({
			operationId,
			leaseRef: null,
			kind: "inventory",
			request: { cause, fullAccount: true },
		});
		let pods: RunPodPod[];
		try {
			pods = await this.options.client.listPods();
			if (!Array.isArray(pods)) {
				throw new RunPodApiError(
					"invalid_response",
					"RunPod Pod inventory was not an array",
				);
			}
			const ids = new Set<string>();
			for (const pod of pods) {
				const validNumber = (value: unknown): boolean =>
					value === null ||
					(typeof value === "number" && Number.isFinite(value) && value >= 0);
				if (
					!pod ||
					typeof pod !== "object" ||
					typeof pod.id !== "string" ||
					pod.id.length === 0 ||
					typeof pod.desiredStatus !== "string" ||
					typeof pod.name !== "string" ||
					!(pod.image === null || typeof pod.image === "string") ||
					!validNumber(pod.costPerHr) ||
					!validNumber(pod.adjustedCostPerHr) ||
					!validNumber(pod.vcpuCount) ||
					!validNumber(pod.memoryInGb) ||
					!pod.env ||
					typeof pod.env !== "object" ||
					Array.isArray(pod.env) ||
					Object.values(pod.env).some((value) => typeof value !== "string") ||
					ids.has(pod.id)
				) {
					throw new RunPodApiError(
						"invalid_response",
						"RunPod Pod inventory was malformed or contained duplicate ids",
					);
				}
				ids.add(pod.id);
			}
		} catch (error) {
			const code = safeCode(error);
			await store.finishOperation(operationId, "failed", { errorCode: code });
			await store.audit({
				kind: "inventory_failure",
				operationId,
				detail: {
					reason: cause,
					decision: "close_remote_dispatch",
					attempt: 1,
					result: code,
				},
			});
			this.lastInventoryError = code;
			this.gate.close(`RunPod full inventory failed (${code})`);
			throw error;
		}
		const metadata = new Map<string, RunPodOwnershipMetadata | null>();
		const encoded = new Map<string, string | null>();
		for (const pod of pods) {
			const value = pod.env[RUNPOD_OWNERSHIP_ENV];
			const decoded = decodeRunPodOwnership(value);
			metadata.set(pod.id, decoded);
			// Never persist an arbitrary value from provider environment data.
			encoded.set(pod.id, decoded ? (value ?? null) : null);
		}
		await store.recordInventory(cause, pods, encoded);
		await store.finishOperation(operationId, "completed", {
			result: { podCount: pods.length },
		});
		const observedAt = Date.now();
		this.latestInventory = pods;
		this.lastInventoryAt = observedAt;
		this.lastInventoryError = null;
		return { pods, metadata, observedAt, cause };
	}

	private async assertUnambiguousInventory(
		inventory: Inventory,
	): Promise<InventoryInspection> {
		const policy = this.requireEnabled();
		const ownershipCounts = new Map<string, number>();
		const store = await this.accountStore();
		const [leases, cleanup] = await Promise.all([
			store.listLeases(),
			store.listCleanup(),
		]);
		const leaseOwnership = new Set(
			leases.map((lease) => lease.ownershipEncoded),
		);
		const cleanupByOwnership = new Map(
			cleanup.map((record) => [record.ownershipEncoded, record]),
		);
		const knownByOwner = new Map([
			...leases.map(
				(lease) => [lease.owner.ownerKey, lease.ownershipEncoded] as const,
			),
			...cleanup.map(
				(record) => [record.ownerKey, record.ownershipEncoded] as const,
			),
		]);
		const cleanupByPod = new Map(
			cleanup.map((record) => [record.podId, record.ownershipEncoded]),
		);
		const untrackedOwned: InventoryInspection["untrackedOwned"] = [];
		for (const pod of inventory.pods) {
			const raw = pod.env[RUNPOD_OWNERSHIP_ENV];
			const metadata = inventory.metadata.get(pod.id);
			if (raw && !metadata) {
				await this.auditDecision(inventory, {
					kind: "critical_safety_incident",
					reason: "malformed ownership metadata",
					decision: "close_remote_dispatch",
					attempt: 1,
					result: "ambiguous_ownership",
					extra: { podId: pod.id },
				});
				this.gate.close(
					"RunPod inventory contains malformed mfw ownership metadata",
				);
				throw new RunPodControlPlaneError(
					"ambiguous_ownership",
					"RunPod inventory contains malformed mfw ownership metadata",
				);
			}
			if (
				metadata?.ns === policy.ownershipNamespace &&
				metadata.account === policy.accountId
			) {
				if (cleanupByPod.has(pod.id) && cleanupByPod.get(pod.id) !== raw) {
					await this.auditDecision(inventory, {
						kind: "critical_safety_incident",
						reason: "cleanup Pod identity changed ownership",
						decision: "close_remote_dispatch",
						attempt: 1,
						result: "ambiguous_ownership",
						extra: { podId: pod.id },
					});
					this.gate.close("RunPod cleanup ownership changed unexpectedly");
					throw new RunPodControlPlaneError(
						"ambiguous_ownership",
						"RunPod cleanup ownership changed unexpectedly",
					);
				}
				const knownForOwner = knownByOwner.get(metadata.owner);
				if (knownForOwner && knownForOwner !== raw) {
					await this.auditDecision(inventory, {
						kind: "critical_safety_incident",
						reason: "ownership conflicts with durable lease",
						decision: "close_remote_dispatch",
						attempt: 1,
						result: "ambiguous_ownership",
						extra: { podId: pod.id, ownerKey: metadata.owner },
					});
					this.gate.close(
						"RunPod inventory ownership conflicts with a durable lease",
					);
					throw new RunPodControlPlaneError(
						"ambiguous_ownership",
						"RunPod inventory ownership conflicts with a durable lease",
					);
				}
				if (raw && !leaseOwnership.has(raw)) {
					const queued = cleanupByOwnership.get(raw);
					if (!queued || queued.absenceConfirmedAt !== null) {
						untrackedOwned.push({ pod, metadata, encoded: raw });
					}
				}
				ownershipCounts.set(
					metadata.owner,
					(ownershipCounts.get(metadata.owner) ?? 0) + 1,
				);
			}
		}
		if ([...ownershipCounts.values()].some((count) => count > 1)) {
			await this.auditDecision(inventory, {
				kind: "critical_safety_incident",
				reason: "duplicate strong ownership identity",
				decision: "close_remote_dispatch",
				attempt: 1,
				result: "ambiguous_ownership",
			});
			this.gate.close("RunPod inventory contains duplicate ownership claims");
			throw new RunPodControlPlaneError(
				"ambiguous_ownership",
				"RunPod inventory contains duplicate ownership claims",
			);
		}
		if (untrackedOwned.length > 0) {
			this.gate.close(
				"RunPod inventory contains an untracked namespace-owned Pod",
			);
		}
		return { untrackedOwned };
	}

	private async auditDecision(
		inventory: Inventory,
		input: {
			kind: string;
			reason: string;
			decision: string;
			attempt: number;
			result: string;
			leaseRef?: string;
			operationId?: string;
			extra?: Record<string, unknown>;
		},
	): Promise<void> {
		await (await this.accountStore()).audit({
			kind: input.kind,
			leaseRef: input.leaseRef,
			operationId: input.operationId,
			detail: {
				reason: input.reason,
				decision: input.decision,
				attempt: input.attempt,
				result: input.result,
				inventory: {
					cause: inventory.cause,
					observedAt: inventory.observedAt,
					pods: inventory.pods.map((pod) =>
						redactedPodFact(pod, inventory.metadata.get(pod.id) ?? null),
					),
				},
				...(input.extra ?? {}),
			},
		});
	}

	private async assertCleanupDrained(
		inventory: Inventory,
		store: RunPodAccountStore,
	): Promise<void> {
		const [cleanup, leases] = await Promise.all([
			store.listCleanup(),
			store.listLeases(),
		]);
		const pending = cleanup.filter(
			(record) => record.absenceConfirmedAt === null,
		).length;
		const terminating = leases.filter(
			(lease) => lease.phase === "terminating",
		).length;
		if (pending === 0 && terminating === 0) return;
		await this.auditDecision(inventory, {
			kind: "runpod_decision",
			reason: "prior owned cleanup still requires absence confirmation",
			decision: "defer_remote_create",
			attempt: 1,
			result: "cleanup_pending",
			extra: { pending, terminating },
		});
		this.gate.close("RunPod cleanup remains pending absence proof");
		throw new RunPodControlPlaneError(
			"cleanup_pending",
			"RunPod cleanup remains pending absence proof",
		);
	}

	private async openGateIfSafe(store: RunPodAccountStore): Promise<void> {
		const [cleanup, leases, unsafeCreate] = await Promise.all([
			store.listCleanup(),
			store.listLeases(),
			store.hasUnsafeCreateBoundary(),
		]);
		const policy = this.requireEnabled();
		const knownOwnership = new Set([
			...cleanup
				.filter((record) => record.absenceConfirmedAt === null)
				.map((record) => record.ownershipEncoded),
			...leases.map((lease) => lease.ownershipEncoded),
		]);
		const liveUntracked = this.latestInventory.some((pod) => {
			const encoded = pod.env[RUNPOD_OWNERSHIP_ENV];
			const owner = decodeRunPodOwnership(encoded);
			return (
				owner?.ns === policy.ownershipNamespace &&
				owner.account === policy.accountId &&
				!knownOwnership.has(encoded ?? "")
			);
		});
		if (
			cleanup.some((record) => record.absenceConfirmedAt === null) ||
			leases.some((lease) => lease.phase === "terminating") ||
			unsafeCreate ||
			liveUntracked
		) {
			return;
		}
		this.openGate();
	}

	private matchingPods(
		lease: RunPodLeaseRecord,
		inventory: Inventory,
	): RunPodPod[] {
		const expected = decodeRunPodOwnership(lease.ownershipEncoded);
		if (!expected)
			throw new Error(`lease ${lease.ref} ownership record is invalid`);
		return inventory.pods.filter((pod) => {
			const actual = inventory.metadata.get(pod.id);
			return actual ? sameRunPodOwnership(actual, expected) : false;
		});
	}

	private async adopt(
		lease: RunPodLeaseRecord,
		pod: RunPodPod,
		operationId: string,
		inventory?: Inventory,
	): Promise<RunPodLeaseRecord> {
		const store = await this.accountStore();
		const decisionInventory =
			inventory ?? (await this.fullInventory("before-adopt-decision"));
		await this.assertUnambiguousInventory(decisionInventory);
		const current = this.matchingPods(lease, decisionInventory).filter(
			isLivePod,
		);
		if (current.length !== 1 || current[0]?.id !== pod.id) {
			this.gate.close("RunPod adoption lost its fresh ownership proof");
			throw new RunPodControlPlaneError(
				"ownership_not_proven",
				"RunPod adoption lost its fresh ownership proof",
			);
		}
		await store.recordOperationIntent({
			operationId,
			leaseRef: lease.ref,
			kind: "adopt",
			request: { podId: pod.id },
		});
		const observed = observedRunPodShape(pod);
		const violations = runPodShapeViolations(lease.request, observed);
		if (
			!lease.sshPublicKey ||
			pod.env.SSH_PUBLIC_KEY !== lease.sshPublicKey ||
			(pod.env.PUBLIC_KEY !== undefined &&
				!sameSshPublicKey(pod.env.PUBLIC_KEY, lease.sshPublicKey))
		) {
			violations.push("ssh_bootstrap_mismatch");
		}
		try {
			const currentPolicy = effectiveRunPodPolicy(
				this.policy,
				this.options.projectPolicy?.(lease.owner.projectId),
			);
			enforceRunPodRequest(lease.request, currentPolicy);
		} catch {
			violations.push("current_policy_rejects_lease");
		}
		const ageHours = Math.max(0, Date.now() - lease.createdAt) / 3_600_000;
		if (ageHours * 60 >= lease.request.maxRuntimeMinutes) {
			violations.push("runtime_limit_reached");
		}
		if (
			observed.hourlyPrice !== null &&
			observed.hourlyPrice * ageHours >= lease.request.maxSpend
		) {
			violations.push("spend_limit_reached");
		}
		if (violations.length > 0) {
			await this.auditDecision(decisionInventory, {
				kind: "runpod_decision",
				reason: violations.join(","),
				decision: "reject_and_cleanup",
				attempt: lease.teardownAttempts + 1,
				result: "policy_violation",
				leaseRef: lease.ref,
				operationId,
				extra: {
					podId: pod.id,
					sshEvidence: {
						sshPublicKeyPresent: "SSH_PUBLIC_KEY" in pod.env,
						sshPublicKeyMatches:
							Boolean(lease.sshPublicKey) &&
							pod.env.SSH_PUBLIC_KEY === lease.sshPublicKey,
						publicKeyAliasPresent: "PUBLIC_KEY" in pod.env,
						publicKeyAliasMatches:
							pod.env.PUBLIC_KEY !== undefined &&
							sameSshPublicKey(pod.env.PUBLIC_KEY, lease.sshPublicKey),
					},
				},
			});
			await store.finishOperation(operationId, "failed", {
				errorCode: violations[0],
				result: { podId: pod.id, violations },
			});
			await this.deleteAndConfirm(
				lease,
				pod,
				`${operationId}/policy-delete`,
				violations.join(","),
			);
			throw new RunPodControlPlaneError(
				"live_shape_policy_violation",
				"RunPod returned a Pod outside the enforced shape or price policy",
			);
		}
		const verified = isRunPodShapeVerified(lease.request, observed);
		const phase = verified
			? ["staging", "executing", "collecting"].includes(lease.phase)
				? lease.phase
				: "ready"
			: "provisioning";
		await this.auditDecision(decisionInventory, {
			kind: "runpod_decision",
			reason: "strong ownership and current shape policy verified",
			decision: "adopt",
			attempt: 1,
			result: phase,
			leaseRef: lease.ref,
			operationId,
			extra: { podId: pod.id },
		});
		const updated = await store.updateLease(lease.ref, {
			phase,
			providerPodId: pod.id,
			observedShape: observed,
			observedHourlyPrice: observed.hourlyPrice,
			lastObservedAt: Date.now(),
			lastErrorCode: null,
		});
		await store.finishOperation(operationId, "completed", {
			result: { podId: pod.id, phase },
		});
		return updated;
	}

	private async completeRecoveredCreate(
		store: RunPodAccountStore,
		lease: RunPodLeaseRecord,
		pod: RunPodPod,
	): Promise<void> {
		await store.recordOperationIntent({
			operationId: lease.createOperationId,
			leaseRef: lease.ref,
			kind: "create",
			request: createOperationRequest(lease),
		});
		await store.finishOperation(lease.createOperationId, "completed", {
			result: {
				podId: pod.id,
				recoveredFromSubmittedCreate: true,
			},
		});
	}

	private closeAmbiguousCreate(): never {
		this.gate.close("a submitted create has no matching live RunPod Pod");
		throw new RunPodControlPlaneError(
			"ambiguous_create",
			"a prior create operation cannot be retried without its live Pod",
		);
	}

	async putLeaseIntent(intent: ProviderLeaseIntent): Promise<ProviderLease> {
		this.requireEnabled();
		if (intent.targetKind !== "runpod") {
			throw new RunPodControlPlaneError(
				"wrong_target",
				`RunPod service cannot create a ${intent.targetKind} lease`,
			);
		}
		const request = RunPodPlacementRequestSchema.parse(intent.requestedShape);
		const policy = effectiveRunPodPolicy(
			this.policy,
			this.options.projectPolicy?.(intent.owner.projectId),
		);
		enforceRunPodRequest(request, policy);
		const ref = leaseRef(intent.owner.ownerKey);
		const createOperationId = `${intent.operationId}/provider-create`;
		return this.serializeMutation(async () => {
			const store = await this.accountStore();
			return store.withMutationLock(async () => {
				const inventory = await this.fullInventory("before-lease-intent");
				const inspection = await this.assertUnambiguousInventory(inventory);
				if (inspection.untrackedOwned.length > 0) {
					await this.registerUntrackedOwned(inventory, inspection);
					this.gate.close(
						"RunPod inventory contains an untracked namespace-owned Pod",
					);
					throw new RunPodControlPlaneError(
						"untracked_owned_pod",
						"RunPod inventory contains an untracked namespace-owned Pod",
					);
				}
				await this.assertCleanupDrained(inventory, store);
				await this.auditDecision(inventory, {
					kind: "runpod_decision",
					reason:
						"request and effective project policy validated against fresh inventory",
					decision: "record_lease_intent",
					attempt: intent.owner.attempt,
					result: "approved",
					leaseRef: ref,
					operationId: intent.operationId,
					extra: { requestedShape: request },
				});
				const metadata = makeRunPodOwnership(
					policy.machine.ownershipNamespace,
					policy.machine.accountId,
					intent.owner,
					createOperationId,
					randomUUID(),
				);
				const ssh = await this.ensurePreSubmissionBootstrap(ref);
				const lease = await store.putLeaseIntent({
					ref,
					createOperationId,
					owner: intent.owner,
					request,
					policy,
					ownershipEncoded: encodeRunPodOwnership(metadata),
					sshBootstrapId: ref,
					sshPrivateKeyPath: ssh.privateKeyPath,
					sshPublicKey: ssh.publicKey,
				});
				return providerLease(lease);
			});
		});
	}

	async command(
		leaseRefValue: string,
		operationId: string,
		command: ProviderLeaseCommand,
	): Promise<ProviderLease> {
		if (command.type === "provision") {
			return this.provision(leaseRefValue, operationId);
		}
		if (command.type === "dispose") {
			return this.dispose(leaseRefValue, operationId, command.reason);
		}
		if (command.type === "phase") {
			return this.serializeMutation(async () => {
				const store = await this.accountStore();
				return store.withMutationLock(async () => {
					const lease = await store.getLease(leaseRefValue);
					if (!lease) throw new Error(`unknown RunPod lease ${leaseRefValue}`);
					if (
						!["ready", "staging", "executing", "collecting"].includes(
							lease.phase,
						)
					) {
						throw new RunPodControlPlaneError(
							"invalid_phase",
							`RunPod lease cannot enter ${command.phase} from ${lease.phase}`,
						);
					}
					const inventory = await this.fullInventory("before-phase-decision");
					await this.assertUnambiguousInventory(inventory);
					const matching = this.matchingPods(lease, inventory);
					if (matching.length !== 1) {
						throw new RunPodControlPlaneError(
							"ownership_not_proven",
							"RunPod phase transition requires one freshly owned Pod",
						);
					}
					await this.auditDecision(inventory, {
						kind: "runpod_decision",
						reason: "execution adapter lifecycle transition",
						decision: `enter_${command.phase}`,
						attempt: lease.owner.attempt,
						result: "approved",
						leaseRef: lease.ref,
						operationId,
						extra: { podId: matching[0]?.id },
					});
					return providerLease(
						await store.updateLease(leaseRefValue, { phase: command.phase }),
					);
				});
			});
		}
		if (command.type === "collect") {
			const observed = await this.observe(leaseRefValue);
			if (!observed) throw new Error(`unknown RunPod lease ${leaseRefValue}`);
			return observed;
		}
		throw new RunPodControlPlaneError(
			"remote_control_boundary",
			"RunPod process control belongs to the remote execution adapter",
		);
	}

	private async provision(
		ref: string,
		_commandOperationId: string,
	): Promise<ProviderLease> {
		return this.serializeMutation(async () => {
			const store = await this.accountStore();
			return store.withMutationLock(async () => {
				const lease = await store.getLease(ref);
				if (!lease) throw new Error(`unknown RunPod lease ${ref}`);
				if (lease.phase === "absent") {
					throw new RunPodControlPlaneError(
						"lease_absent",
						"an absent RunPod lease cannot be reprovisioned",
					);
				}
				// Post-linkage and every restart are validation-only. Missing, partial,
				// unsafe, or mismatched evidence must fail before any provider decision.
				const ssh = await this.loadLeaseBootstrap(lease);
				const createRequest = createOperationRequest(lease);
				const inventory = await this.fullInventory("before-provision");
				const inspection = await this.assertUnambiguousInventory(inventory);
				if (inspection.untrackedOwned.length > 0) {
					await this.registerUntrackedOwned(inventory, inspection);
					this.gate.close(
						"RunPod inventory contains an untracked namespace-owned Pod",
					);
					throw new RunPodControlPlaneError(
						"untracked_owned_pod",
						"RunPod inventory contains an untracked namespace-owned Pod",
					);
				}
				await this.assertCleanupDrained(inventory, store);
				const matching = this.matchingPods(lease, inventory);
				const liveMatching = matching.filter(isLivePod);
				if (matching.length === 1 && liveMatching.length === 1) {
					await this.completeRecoveredCreate(
						store,
						lease,
						liveMatching[0] as RunPodPod,
					);
					const adopted = await this.adopt(
						lease,
						liveMatching[0] as RunPodPod,
						`${lease.createOperationId}/adopt`,
						inventory,
					);
					await this.openGateIfSafe(store);
					return providerLease(adopted);
				}
				if (matching.length > 1) {
					this.gate.close("multiple Pods match one RunPod create operation");
					throw new RunPodControlPlaneError(
						"ambiguous_create",
						"multiple Pods match one RunPod create operation",
					);
				}
				if (matching.length === 1) {
					this.closeAmbiguousCreate();
				}
				const currentPolicy = effectiveRunPodPolicy(
					this.policy,
					this.options.projectPolicy?.(lease.owner.projectId),
				);
				enforceRunPodRequest(lease.request, currentPolicy);
				const live = inventory.pods.filter(isLivePod).map((pod) => ({
					id: pod.id,
					hourlyPrice: podHourlyPrice(pod),
				}));
				enforceRunPodAccountCaps(live, lease.request, {
					...currentPolicy,
					maxConcurrentPods: currentPolicy.machine.maxConcurrentPods ?? null,
				});
				const projectLive = inventory.pods.filter((pod) => {
					if (!isLivePod(pod)) return false;
					const metadata = inventory.metadata.get(pod.id);
					return (
						metadata?.ns === currentPolicy.machine.ownershipNamespace &&
						metadata.account === currentPolicy.machine.accountId &&
						metadata.project === lease.owner.projectId
					);
				}).length;
				if (
					currentPolicy.maxConcurrentPods !== null &&
					projectLive >= currentPolicy.maxConcurrentPods
				) {
					throw new RunPodControlPlaneError(
						"project_concurrency_cap",
						"RunPod project concurrent Pod ceiling reached",
					);
				}
				const state = await store.recordOperationIntent({
					operationId: lease.createOperationId,
					leaseRef: lease.ref,
					kind: "create",
					request: createRequest,
				});
				if (state !== "intent") {
					this.closeAmbiguousCreate();
				}
				await this.auditDecision(inventory, {
					kind: "runpod_decision",
					reason: "fresh account and project caps admit the requested shape",
					decision: "create_owned_pod",
					attempt: lease.owner.attempt,
					result: "submitted",
					leaseRef: lease.ref,
					operationId: lease.createOperationId,
					extra: { requestedShape: lease.request },
				});
				await store.updateLease(ref, { phase: "provisioning" });
				// Validate the restart bootstrap while replacement is still legally
				// possible. Once `submitted` commits, this evidence is immutable.
				const mayCallProvider = await store.markOperationSubmitted(
					lease.createOperationId,
				);
				if (!mayCallProvider) {
					this.closeAmbiguousCreate();
				}
				let createFailed = false;
				try {
					await this.options.client.createPod({
						name: `mfw-${lease.owner.runId.slice(0, 24)}`,
						request: lease.request,
						createEnv: {
							[RUNPOD_OWNERSHIP_ENV]: lease.ownershipEncoded,
							SSH_PUBLIC_KEY: ssh.publicKey,
							PUBLIC_KEY: ssh.publicKey,
						},
					});
				} catch {
					// A timeout may have happened after RunPod committed the create.
					createFailed = true;
				}
				let after: Inventory;
				try {
					after = await this.fullInventory("after-create");
				} catch (error) {
					await store.finishOperation(lease.createOperationId, "ambiguous", {
						errorCode: "inventory_failed_after_create",
					});
					throw error;
				}
				await this.assertUnambiguousInventory(after);
				const createdMatches = this.matchingPods(lease, after);
				const created = createdMatches.filter(isLivePod);
				if (created.length !== 1 || createdMatches.length !== 1) {
					await this.auditDecision(after, {
						kind: "runpod_decision_result",
						reason: "provider create outcome requires exactly one strong match",
						decision: "create_owned_pod",
						attempt: lease.owner.attempt,
						result: "ambiguous",
						leaseRef: lease.ref,
						operationId: lease.createOperationId,
					});
					await store.finishOperation(lease.createOperationId, "ambiguous", {
						errorCode:
							createdMatches.length > 1
								? "duplicate_create"
								: "create_outcome_unknown",
					});
					this.gate.close(
						"RunPod create outcome is ambiguous; automatic retry is forbidden",
					);
					throw new RunPodControlPlaneError(
						"ambiguous_create",
						"RunPod create outcome is ambiguous; automatic retry is forbidden",
					);
				}
				await store.finishOperation(lease.createOperationId, "completed", {
					result: { podId: created[0]?.id, recoveredAfterError: createFailed },
				});
				const adopted = await this.adopt(
					lease,
					created[0] as RunPodPod,
					`${lease.createOperationId}/post-create-adopt`,
					after,
				);
				await this.openGateIfSafe(store);
				return providerLease(adopted);
			});
		});
	}

	private async deleteAndConfirm(
		lease: RunPodLeaseRecord,
		pod: RunPodPod,
		operationId: string,
		reason: string,
	): Promise<RunPodLeaseRecord> {
		const store = await this.accountStore();
		const decisionInventory = await this.fullInventory(
			"before-delete-decision",
		);
		await this.assertUnambiguousInventory(decisionInventory);
		const freshPod = decisionInventory.pods.find(
			(candidate) => candidate.id === pod.id,
		);
		if (!freshPod) {
			if (this.matchingPods(lease, decisionInventory).length > 0) {
				this.gate.close("RunPod lease ownership moved to a different Pod id");
				throw new RunPodControlPlaneError(
					"ambiguous_ownership",
					"RunPod lease ownership moved to a different Pod id",
				);
			}
			await this.auditDecision(decisionInventory, {
				kind: "runpod_decision",
				reason,
				decision: "confirm_absence",
				attempt: lease.teardownAttempts,
				result: "absent",
				leaseRef: lease.ref,
				operationId,
				extra: { podId: pod.id },
			});
			await this.removeLeaseBootstrap(lease);
			return store.updateLease(lease.ref, {
				phase: "absent",
				lastObservedAt: decisionInventory.observedAt,
				lastErrorCode: null,
			});
		}
		const expected = decodeRunPodOwnership(lease.ownershipEncoded);
		const actual = decodeRunPodOwnership(freshPod.env[RUNPOD_OWNERSHIP_ENV]);
		if (!expected || !actual || !sameRunPodOwnership(expected, actual)) {
			this.gate.close("RunPod delete refused because ownership proof failed");
			throw new RunPodControlPlaneError(
				"ownership_not_proven",
				"RunPod delete refused because ownership proof failed",
			);
		}
		await store.recordOperationIntent({
			operationId,
			leaseRef: lease.ref,
			kind: "delete",
			request: { podId: pod.id, reason },
		});
		await this.auditDecision(decisionInventory, {
			kind: "runpod_decision",
			reason,
			decision: "delete_owned_pod",
			attempt: lease.teardownAttempts + 1,
			result: "submitted",
			leaseRef: lease.ref,
			operationId,
			extra: { podId: freshPod.id },
		});
		await store.updateLease(lease.ref, {
			phase: "terminating",
			providerPodId: pod.id,
			incrementTeardown: true,
		});
		let deleteError: unknown = null;
		try {
			await this.options.client.deletePod(freshPod.id);
		} catch (error) {
			deleteError = error;
		}
		for (let attempt = 0; attempt < this.absenceAttempts; attempt++) {
			const inventory = await this.fullInventory("confirm-absence");
			await this.assertUnambiguousInventory(inventory);
			if (
				!inventory.pods.some((candidate) => candidate.id === freshPod.id) &&
				this.matchingPods(lease, inventory).length === 0
			) {
				try {
					await this.removeLeaseBootstrap(lease);
				} catch {
					await store.finishOperation(operationId, "failed", {
						errorCode: "ssh_key_cleanup_failed",
					});
					await store.updateLease(lease.ref, {
						phase: "terminating",
						lastErrorCode: "ssh_key_cleanup_failed",
					});
					throw new RunPodControlPlaneError(
						"ssh_key_cleanup_failed",
						"RunPod is absent but SSH bootstrap cleanup is incomplete",
					);
				}
				await store.finishOperation(operationId, "completed", {
					result: { podId: freshPod.id, absenceConfirmed: true },
				});
				await this.auditDecision(inventory, {
					kind: "runpod_decision_result",
					reason,
					decision: "delete_owned_pod",
					attempt: lease.teardownAttempts + 1,
					result: "absence_confirmed",
					leaseRef: lease.ref,
					operationId,
					extra: { podId: freshPod.id },
				});
				return store.updateLease(lease.ref, {
					phase: "absent",
					lastObservedAt: Date.now(),
					lastErrorCode: null,
				});
			}
			if (attempt + 1 < this.absenceAttempts)
				await Bun.sleep(this.absenceDelayMs);
		}
		const code = deleteError ? safeCode(deleteError) : "absence_not_confirmed";
		await store.finishOperation(operationId, "ambiguous", { errorCode: code });
		await store.updateLease(lease.ref, {
			phase: "terminating",
			lastErrorCode: code,
		});
		await this.auditDecision(decisionInventory, {
			kind: "runpod_decision_result",
			reason,
			decision: "delete_owned_pod",
			attempt: lease.teardownAttempts + 1,
			result: "cleanup_pending",
			leaseRef: lease.ref,
			operationId,
			extra: { podId: freshPod.id, errorCode: code },
		});
		this.gate.close("RunPod deletion has not been confirmed absent");
		throw new RunPodControlPlaneError(
			"absence_not_confirmed",
			"RunPod deletion has not been confirmed absent",
		);
	}

	private async cleanupUntrackedOwned(
		record: RunPodCleanupRecord,
		reason: string,
	): Promise<void> {
		const store = await this.accountStore();
		const inventory = await this.fullInventory(
			"before-untracked-delete-decision",
		);
		await this.assertUnambiguousInventory(inventory);
		const expected = decodeRunPodOwnership(record.ownershipEncoded);
		if (!expected) {
			throw new RunPodControlPlaneError(
				"ownership_not_proven",
				"RunPod cleanup has invalid durable ownership proof",
			);
		}
		const pod = inventory.pods.find(
			(candidate) => candidate.id === record.podId,
		);
		if (!pod) {
			const movedIdentity = inventory.pods.some((candidate) => {
				const actual = inventory.metadata.get(candidate.id);
				return actual ? sameRunPodOwnership(expected, actual) : false;
			});
			if (movedIdentity) {
				this.gate.close("RunPod cleanup ownership moved to a different Pod id");
				throw new RunPodControlPlaneError(
					"ambiguous_ownership",
					"RunPod cleanup ownership moved to a different Pod id",
				);
			}
			await this.auditDecision(inventory, {
				kind: "runpod_decision_result",
				reason,
				decision: "cleanup_untracked_owned_pod",
				attempt: record.cleanupAttempts,
				result: "absence_confirmed",
				extra: { podId: record.podId },
			});
			await store.confirmCleanupAbsence(record.podId, inventory.observedAt);
			return;
		}
		const actual = decodeRunPodOwnership(pod.env[RUNPOD_OWNERSHIP_ENV]);
		const policy = this.requireEnabled();
		if (
			!expected ||
			!actual ||
			!sameRunPodOwnership(expected, actual) ||
			actual.ns !== policy.ownershipNamespace ||
			actual.account !== policy.accountId
		) {
			this.gate.close(
				"RunPod untracked cleanup refused because ownership proof changed",
			);
			throw new RunPodControlPlaneError(
				"ownership_not_proven",
				"RunPod untracked cleanup refused because ownership proof changed",
			);
		}
		const operationId = `cleanup/${pod.id}/${record.cleanupAttempts + 1}`;
		await store.recordOperationIntent({
			operationId,
			leaseRef: null,
			kind: "delete",
			request: { podId: pod.id, reason, ownership: "strong_token" },
		});
		await this.auditDecision(inventory, {
			kind: "runpod_decision",
			reason,
			decision: "cleanup_untracked_owned_pod",
			attempt: record.cleanupAttempts + 1,
			result: "submitted",
			operationId,
			extra: { podId: pod.id },
		});
		await store.recordCleanupAttempt(pod.id, null);
		let deleteError: unknown = null;
		try {
			await this.options.client.deletePod(pod.id);
		} catch (error) {
			deleteError = error;
		}
		for (let attempt = 0; attempt < this.absenceAttempts; attempt++) {
			const confirmation = await this.fullInventory(
				"confirm-untracked-absence",
			);
			await this.assertUnambiguousInventory(confirmation);
			const ownershipPresent = confirmation.pods.some((candidate) => {
				const actual = confirmation.metadata.get(candidate.id);
				return actual ? sameRunPodOwnership(expected, actual) : false;
			});
			if (
				!confirmation.pods.some((candidate) => candidate.id === pod.id) &&
				!ownershipPresent
			) {
				await this.auditDecision(confirmation, {
					kind: "runpod_decision_result",
					reason,
					decision: "cleanup_untracked_owned_pod",
					attempt: record.cleanupAttempts + 1,
					result: "absence_confirmed",
					operationId,
					extra: { podId: pod.id },
				});
				await store.confirmCleanupAbsence(pod.id, confirmation.observedAt);
				await store.finishOperation(operationId, "completed", {
					result: { podId: pod.id, absenceConfirmed: true },
				});
				return;
			}
			if (attempt + 1 < this.absenceAttempts) {
				await Bun.sleep(this.absenceDelayMs);
			}
		}
		const code = deleteError ? safeCode(deleteError) : "absence_not_confirmed";
		await store.setCleanupError(pod.id, code);
		await store.finishOperation(operationId, "ambiguous", { errorCode: code });
		this.gate.close("RunPod owned cleanup has not been confirmed absent");
		throw new RunPodControlPlaneError(
			"absence_not_confirmed",
			"RunPod owned cleanup has not been confirmed absent",
		);
	}

	private async registerUntrackedOwned(
		inventory: Inventory,
		inspection: InventoryInspection,
	): Promise<{ records: RunPodCleanupRecord[]; ownerUnavailable: boolean }> {
		const store = await this.accountStore();
		const records: RunPodCleanupRecord[] = [];
		let ownerUnavailable = false;
		for (const { pod, metadata, encoded } of inspection.untrackedOwned) {
			const ownerResolution = await this.resolveOwner(metadata, null);
			if (ownerResolution?.state === "unavailable") {
				ownerUnavailable = true;
				this.gate.close(
					`RunPod owner project '${ownerResolution.projectName}' is configured but unavailable`,
				);
				await this.auditDecision(inventory, {
					kind: "owner_unavailable",
					reason:
						"the configured owner project could not attach; ownership is not authoritatively detached",
					decision: "retain_owned_pod_and_close_dispatch",
					attempt: 1,
					result: ownerResolution.reason,
					extra: { podId: pod.id, ownerKey: metadata.owner },
				});
				continue;
			}
			const record = await store.enqueueCleanup({
				podId: pod.id,
				pod,
				ownershipEncoded: encoded,
				projectId: metadata.project,
				runId: metadata.run,
				taskId: metadata.task,
				attempt: metadata.attempt,
				ownerKey: metadata.owner,
			});
			records.push(record);
			await this.auditDecision(inventory, {
				kind: "untracked_owned_pod",
				reason: "namespace ownership is valid but no durable lease exists",
				decision: "enqueue_cleanup",
				attempt: record.cleanupAttempts + 1,
				result: "cleanup_pending",
				extra: { podId: pod.id, ownerKey: metadata.owner },
			});
		}
		return { records, ownerUnavailable };
	}

	private async dispose(
		ref: string,
		operationId: string,
		reason: string,
	): Promise<ProviderLease> {
		return this.serializeMutation(async () => {
			const store = await this.accountStore();
			return store.withMutationLock(async () => {
				const lease = await store.getLease(ref);
				if (!lease) throw new Error(`unknown RunPod lease ${ref}`);
				const inventory = await this.fullInventory("before-delete");
				await this.assertUnambiguousInventory(inventory);
				const matching = this.matchingPods(lease, inventory);
				if (matching.length === 0) {
					await this.auditDecision(inventory, {
						kind: "runpod_decision",
						reason,
						decision: "confirm_absence",
						attempt: lease.teardownAttempts,
						result: "absent",
						leaseRef: lease.ref,
						operationId,
					});
					await this.removeLeaseBootstrap(lease);
					const absent = await store.updateLease(ref, {
						phase: "absent",
						lastObservedAt: Date.now(),
					});
					await this.openGateIfSafe(store);
					return providerLease(absent);
				}
				if (matching.length !== 1) {
					this.gate.close("RunPod delete target ownership is ambiguous");
					throw new RunPodControlPlaneError(
						"ambiguous_ownership",
						"RunPod delete target ownership is ambiguous",
					);
				}
				const absent = await this.deleteAndConfirm(
					lease,
					matching[0] as RunPodPod,
					operationId,
					reason,
				);
				await this.openGateIfSafe(store);
				return providerLease(absent);
			});
		});
	}

	async observe(ref: string): Promise<ProviderLease | null> {
		if (!this.policy.enabled) return null;
		return this.serializeMutation(async () => {
			const store = await this.accountStore();
			return store.withMutationLock(async () => {
				const lease = await store.getLease(ref);
				if (!lease) return null;
				const inventory = await this.fullInventory("observe");
				await this.assertUnambiguousInventory(inventory);
				const matching = this.matchingPods(lease, inventory);
				const liveMatching = matching.filter(isLivePod);
				const createState = await store.getOperationState(
					lease.createOperationId,
				);
				if (matching.length === 0) {
					if (isAmbiguousCreateBoundary(createState)) {
						this.closeAmbiguousCreate();
					}
					if (lease.phase !== "intent") {
						await this.auditDecision(inventory, {
							kind: "runpod_decision",
							reason: "fresh observation contains no matching Pod",
							decision: "confirm_absence",
							attempt: lease.teardownAttempts,
							result: "absent",
							leaseRef: lease.ref,
						});
						await this.removeLeaseBootstrap(lease);
					} else {
						await this.auditDecision(inventory, {
							kind: "runpod_decision",
							reason: "fresh observation contains no submitted Pod",
							decision: "close_unused_intent",
							attempt: lease.owner.attempt,
							result: "absent",
							leaseRef: lease.ref,
						});
					}
					return providerLease(
						await store.updateLease(ref, {
							phase: "absent",
							lastObservedAt: Date.now(),
						}),
					);
				}
				if (matching.length !== 1 || liveMatching.length > 1) {
					this.gate.close("RunPod observation found ambiguous ownership");
					throw new RunPodControlPlaneError(
						"ambiguous_ownership",
						"RunPod observation found ambiguous ownership",
					);
				}
				if (liveMatching.length === 0) {
					if (isAmbiguousCreateBoundary(createState)) {
						this.closeAmbiguousCreate();
					}
					return providerLease(
						await this.deleteAndConfirm(
							lease,
							matching[0] as RunPodPod,
							`${lease.ref}/observe-non-live-delete/${Date.now()}`,
							"owned_non_live_pod",
						),
					);
				}
				const pod = liveMatching[0] as RunPodPod;
				const recoveredCreate = createState !== "completed";
				if (recoveredCreate) {
					await this.completeRecoveredCreate(store, lease, pod);
				}
				if (
					!recoveredCreate &&
					(lease.phase === "absent" || lease.phase === "failed")
				) {
					return providerLease(
						await this.deleteAndConfirm(
							lease,
							pod,
							`${lease.ref}/observe-orphan-delete/${Date.now()}`,
							"owned_orphan",
						),
					);
				}
				return providerLease(
					await this.adopt(
						lease,
						pod,
						`${ref}/observe/${Date.now()}`,
						inventory,
					),
				);
			});
		});
	}

	/** Freshly prove the lease/Pod/key binding before constructing SSH transport. */
	async connection(ref: string): Promise<RunPodLeaseConnection | null> {
		if (!this.policy.enabled) return null;
		this.requireEnabled();
		return this.serializeMutation(async () => {
			const store = await this.accountStore();
			return store.withMutationLock(async () => {
				const lease = await store.getLease(ref);
				if (!lease) throw new Error(`unknown RunPod lease ${ref}`);
				const inventory = await this.fullInventory("ssh-connection");
				await this.assertUnambiguousInventory(inventory);
				const matching = this.matchingPods(lease, inventory).filter(isLivePod);
				if (matching.length === 0) return null;
				if (matching.length !== 1) {
					throw new RunPodControlPlaneError(
						"ambiguous_ownership",
						"RunPod SSH connection ownership is ambiguous",
					);
				}
				const pod = matching[0] as RunPodPod;
				if (
					lease.providerPodId !== pod.id ||
					!["ready", "staging", "executing", "collecting"].includes(
						lease.phase,
					) ||
					pod.desiredStatus !== "RUNNING" ||
					pod.machine === null
				) {
					return null;
				}
				const key = await this.loadLeaseBootstrap(lease);
				if (
					pod.env.SSH_PUBLIC_KEY !== key.publicKey ||
					(pod.env.PUBLIC_KEY !== undefined &&
						!sameSshPublicKey(pod.env.PUBLIC_KEY, key.publicKey))
				) {
					throw new RunPodControlPlaneError(
						"ssh_bootstrap_mismatch",
						"live RunPod Pod does not carry the lease SSH public key",
					);
				}
				const host = pod.publicIp;
				const port = pod.portMappings["22"];
				if (!host || !port) return null;
				let pinned = lease;
				if (
					lease.sshHost === null &&
					lease.sshPort === null &&
					lease.sshHostPublicKey === null
				) {
					let hostPublicKey: string;
					try {
						hostPublicKey = this.options.resolveSshHostKey
							? await this.options.resolveSshHostKey(host, port)
							: await scanRunPodDirectSshHostKey({ host, port });
					} catch (error) {
						// RUNNING and the SSH port can be published before sshd accepts
						// connections: treat that as "not ready yet". Identity failures stay fatal.
						if (
							error instanceof RemoteTransportError &&
							error.failure === "network_lost"
						)
							return null;
						throw error;
					}
					pinned = await store.pinLeaseSshEndpoint(lease.ref, {
						host,
						port,
						hostPublicKey,
					});
				}
				if (
					pinned.sshHost !== host ||
					pinned.sshPort !== port ||
					!pinned.sshHostPublicKey
				) {
					this.gate.close("RunPod SSH endpoint changed after it was pinned");
					throw new RunPodControlPlaneError(
						"ssh_endpoint_mismatch",
						"RunPod SSH endpoint changed after it was pinned",
					);
				}
				return {
					lease: providerLease(lease),
					endpoint: {
						mode: "runpod-direct",
						podId: pod.id,
						principal: "root",
						host,
						port,
						privateKeyPath: key.privateKeyPath,
						hostPublicKey: pinned.sshHostPublicKey,
					},
				};
			});
		});
	}

	async podPresent(podId: string): Promise<boolean> {
		if (!this.policy.enabled) return false;
		return this.serializeMutation(async () =>
			(await this.fullInventory("ssh-failure-presence")).pods.some(
				(pod) => pod.id === podId,
			),
		);
	}

	async inventory(targetKind: string): Promise<readonly ProviderLease[]> {
		if (targetKind !== "runpod" || !this.policy.enabled) return [];
		await this.reconcile("inventory");
		return (await (await this.accountStore()).listLeases()).map(providerLease);
	}

	/** Global API command: refresh uses the always-on reconciler itself. */
	async refresh(reason = "operator_refresh"): Promise<RunPodAccountReadModel> {
		if (this.policy.enabled) await this.reconcile(`api:${reason}`);
		else {
			await this.serializeMutation(() =>
				this.refreshAccountBalance(`api:${reason}`),
			);
		}
		return this.readModel();
	}

	private async settings(): Promise<RunPodOperatorSettingsRecord> {
		if (this.operatorSettings) return this.operatorSettings;
		const store = await this.accountStore();
		this.operatorSettings = await store.initializeOperatorSettings(
			this.currentPolicy,
		);
		this.currentPolicy = RunPodMachinePolicySchema.parse(
			this.operatorSettings.policy,
		);
		return this.operatorSettings;
	}

	private policyWeakening(
		next: RunPodMachinePolicy,
		allowCostLimitChanges = false,
	): string | null {
		if ((next.accountId ?? "default") !== this.accountId) {
			return "RunPod account id cannot be changed in-place";
		}
		if (!this.currentPolicy.enabled) return null;
		if (!next.enabled) {
			return "An enabled RunPod account must be paused instead of discarding its ownership identity";
		}
		for (const field of [
			"ownershipNamespace",
			"sshProxyAccountSuffix",
			"sshHostPublicKey",
		] as const) {
			if (next[field] !== this.currentPolicy[field]) {
				return `RunPod ${field} is immutable after account enablement`;
			}
		}
		for (const field of [
			"allowedGpuTypes",
			"allowedCpuFlavors",
			"allowedImages",
			"allowedClouds",
		] as const) {
			const before = this.currentPolicy[field];
			const after = next[field];
			if (before !== undefined && after === undefined) {
				return `RunPod ${field} cannot become unrestricted after account enablement`;
			}
			const prior = new Set<string>(before ?? []);
			if (after?.some((value) => !prior.has(value))) {
				return `RunPod ${field} cannot be expanded after account enablement`;
			}
		}
		for (const field of [
			"maxHourlyPrice",
			"maxGpuCount",
			"maxConcurrentPods",
			"maxAggregateHourlyPrice",
			"maxRuntimeMinutes",
			"maxRunSpend",
		] as const) {
			if (
				allowCostLimitChanges &&
				(field === "maxHourlyPrice" ||
					field === "maxAggregateHourlyPrice" ||
					field === "maxRuntimeMinutes" ||
					field === "maxRunSpend")
			)
				continue;
			const before = this.currentPolicy[field];
			const after = next[field];
			if (before !== undefined && after === undefined) {
				return `RunPod ${field} cannot become unrestricted after account enablement`;
			}
			if (before !== undefined && after !== undefined && after > before) {
				return `RunPod ${field} cannot be raised after account enablement`;
			}
		}
		const priorInterval =
			this.currentPolicy.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS;
		const nextInterval =
			next.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS;
		if (nextInterval > priorInterval) {
			return "RunPod reconciliation interval cannot be weakened after account enablement";
		}
		return null;
	}

	async updateMachineSafety(input: {
		expectedVersion: number;
		safety: unknown;
		actor: string;
	}): Promise<RunPodAccountReadModel> {
		const safety: RunPodMachineSafety = RunPodMachineSafetySchema.parse(
			input.safety,
		);
		if (!safety.enabled) {
			throw new RunPodControlPlaneError(
				"invalid_operator_change",
				"RunPod is paused from the operations page instead of disabling its ownership identity",
			);
		}
		let next: RunPodMachinePolicy;
		if (this.currentPolicy.enabled) {
			next = { ...this.currentPolicy, ...safety, enabled: true };
		} else {
			next = {
				...safety,
				enabled: true,
				accountId: this.accountId,
				ownershipNamespace: `mfw:${randomUUID()}`,
				reconcileIntervalMs: DEFAULT_RECONCILE_INTERVAL_MS,
			};
		}
		return this.updateMachinePolicy({
			expectedVersion: input.expectedVersion,
			policy: next,
			actor: input.actor,
			allowCostLimitChanges: true,
		});
	}

	async updateMachinePolicy(input: {
		expectedVersion: number;
		policy: unknown;
		actor: string;
		reason?: string;
		allowCostLimitChanges?: boolean;
	}): Promise<RunPodAccountReadModel> {
		const actor = input.actor.trim();
		const reason = input.reason?.trim() || "Updated RunPod safety settings";
		if (!actor) {
			throw new RunPodControlPlaneError(
				"invalid_operator_change",
				"RunPod policy changes require an actor",
			);
		}
		const parsed = RunPodMachinePolicySchema.safeParse(input.policy);
		if (!parsed.success) {
			const store = await this.accountStore();
			await store.audit({
				kind: "operator_policy_rejected",
				detail: {
					actor,
					reason,
					result: "invalid_policy",
					issues: parsed.error.issues.map((issue) => ({
						path: issue.path.join("."),
						message: issue.message,
					})),
				},
			});
			throw new RunPodControlPlaneError(
				"invalid_machine_policy",
				"RunPod machine policy is invalid",
			);
		}
		const next = parsed.data;
		const weakening = this.policyWeakening(next, input.allowCostLimitChanges);
		if (weakening) {
			const store = await this.accountStore();
			await store.audit({
				kind: "operator_policy_rejected",
				detail: {
					actor,
					reason,
					result: "safety_boundary_weakened",
					message: weakening,
				},
			});
			throw new RunPodControlPlaneError(
				"policy_safety_boundary_weakened",
				weakening,
			);
		}
		await this.serializeMutation(async () => {
			const store = await this.accountStore();
			await store.withMutationLock(async () => {
				const prior = await this.settings();
				if (prior.version !== input.expectedVersion) {
					throw new RunPodControlPlaneError(
						"settings_version_conflict",
						"RunPod operator settings changed; refresh before retrying",
					);
				}
				this.gate.close(
					"RunPod policy change is awaiting fresh reconciliation",
				);
				try {
					this.operatorSettings = await store.updateOperatorSettings({
						expectedVersion: input.expectedVersion,
						policy: next,
						dispatchPaused: prior.dispatchPaused,
						actor,
						reason,
					});
				} catch (error) {
					if (
						error instanceof Error &&
						error.message.includes("version conflict")
					) {
						throw new RunPodControlPlaneError(
							"settings_version_conflict",
							"RunPod operator settings changed; refresh before retrying",
						);
					}
					throw error;
				}
				this.currentPolicy = next;
				await store.audit({
					kind: "operator_policy_updated",
					detail: {
						actor,
						reason,
						version: this.operatorSettings.version,
						enabled: next.enabled,
						ceilings: next.enabled ? policyCeilings(next) : null,
						allowedGpuTypes: next.enabled
							? (next.allowedGpuTypes ?? null)
							: null,
						allowedCpuFlavors: next.enabled
							? (next.allowedCpuFlavors ?? null)
							: null,
						allowedImages: next.enabled ? (next.allowedImages ?? null) : null,
						allowedClouds: next.enabled ? (next.allowedClouds ?? null) : null,
					},
				});
			});
		});
		if (next.enabled) await this.reconcile("operator-policy-change");
		return this.readModel();
	}

	async setDispatchPaused(input: {
		expectedVersion: number;
		paused: boolean;
		actor: string;
		reason?: string;
	}): Promise<RunPodAccountReadModel> {
		const actor = input.actor.trim();
		const reason =
			input.reason?.trim() ||
			(input.paused ? "Paused RunPod dispatch" : "Resumed RunPod dispatch");
		if (!actor) {
			throw new RunPodControlPlaneError(
				"invalid_operator_change",
				"RunPod pause changes require an actor",
			);
		}
		await this.serializeMutation(async () => {
			const store = await this.accountStore();
			await store.withMutationLock(async () => {
				const prior = await this.settings();
				if (prior.version !== input.expectedVersion) {
					throw new RunPodControlPlaneError(
						"settings_version_conflict",
						"RunPod operator settings changed; refresh before retrying",
					);
				}
				if (input.paused) {
					this.gate.close("RunPod dispatch is paused by the operator");
				} else {
					this.gate.close(
						"RunPod resume is awaiting credential validation and fresh reconciliation",
					);
					this.requireEnabled();
					if (!(await this.options.client.credentialReady())) {
						throw new RunPodControlPlaneError(
							"credential_missing",
							"RunPod dispatch cannot resume without a stored credential",
						);
					}
					// Reconcile while the durable operator pause is still set. A failure
					// therefore leaves both the requested state and effective gate closed.
					await this.reconcileWithLock("operator-resume-prerequisite", store);
				}
				this.operatorSettings = await store.updateOperatorSettings({
					expectedVersion: input.expectedVersion,
					policy: this.currentPolicy,
					dispatchPaused: input.paused,
					actor,
					reason,
				});
				await store.audit({
					kind: input.paused
						? "operator_dispatch_paused"
						: "operator_dispatch_resumed",
					detail: {
						actor,
						reason,
						version: this.operatorSettings.version,
					},
				});
				if (!input.paused) this.openGate();
			});
		});
		return this.readModel();
	}

	/** Global API command: no provider mutation exists outside this lock/queue. */
	async requestCleanup(input: {
		podId: string;
		reason: string;
		actor: string;
		confirmed: true;
		expectedOwnershipFingerprint: string;
		expectedObservedAt: number;
	}): Promise<RunPodAccountReadModel> {
		const { podId, reason } = input;
		if (!podId.trim() || !reason.trim()) {
			throw new RunPodControlPlaneError(
				"invalid_cleanup_request",
				"RunPod cleanup requires a Pod id and reason",
			);
		}
		this.requireEnabled();
		await this.serializeMutation(async () => {
			const store = await this.accountStore();
			await store.withMutationLock(async () => {
				const inventory = await this.fullInventory("api:cleanup");
				if (!input.confirmed || !input.actor.trim()) {
					throw new RunPodControlPlaneError(
						"cleanup_confirmation_required",
						"RunPod cleanup requires explicit operator confirmation",
					);
				}
				const inspection = await this.assertUnambiguousInventory(inventory);
				await this.registerUntrackedOwned(inventory, inspection);
				const pod = inventory.pods.find((candidate) => candidate.id === podId);
				if (inventory.observedAt < input.expectedObservedAt) {
					throw new RunPodControlPlaneError(
						"stale_cleanup_confirmation",
						"RunPod cleanup confirmation is newer than the provider inventory",
					);
				}
				const encoded = pod ? pod.env[RUNPOD_OWNERSHIP_ENV] : undefined;
				const fingerprint = encoded
					? createHash("sha256").update(encoded).digest("hex")
					: null;
				if (pod && fingerprint !== input.expectedOwnershipFingerprint) {
					throw new RunPodControlPlaneError(
						"cleanup_identity_changed",
						"RunPod cleanup refused because the live ownership identity changed",
					);
				}
				await store.audit({
					kind: "operator_cleanup_confirmed",
					detail: { podId, reason, actor: input.actor.trim() },
				});
				if (!pod) {
					const queued = await store.getCleanup(podId);
					if (queued) {
						const expected = decodeRunPodOwnership(queued.ownershipEncoded);
						if (
							expected &&
							inventory.pods.some((candidate) => {
								const actual = inventory.metadata.get(candidate.id);
								return actual ? sameRunPodOwnership(expected, actual) : false;
							})
						) {
							this.gate.close(
								"RunPod cleanup ownership moved to a different Pod id",
							);
							throw new RunPodControlPlaneError(
								"ambiguous_ownership",
								"RunPod cleanup ownership moved to a different Pod id",
							);
						}
						await this.auditDecision(inventory, {
							kind: "runpod_decision_result",
							reason,
							decision: "cleanup_untracked_owned_pod",
							attempt: queued.cleanupAttempts,
							result: "absence_confirmed",
							extra: { podId },
						});
						await store.confirmCleanupAbsence(podId, inventory.observedAt);
						return;
					}
					throw new RunPodControlPlaneError(
						"pod_not_found",
						"RunPod Pod is absent from fresh full inventory",
					);
				}
				const lease = (await store.listLeases()).find(
					(candidate) =>
						this.matchingPods(candidate, inventory)[0]?.id === podId,
				);
				if (lease) {
					await this.deleteAndConfirm(
						lease,
						pod,
						`${lease.ref}/operator-delete/${Date.now()}`,
						reason,
					);
					return;
				}
				let queued = await store.getCleanup(podId);
				if (!queued) {
					const currentOwned = inspection.untrackedOwned.find(
						(candidate) => candidate.pod.id === podId,
					);
					if (!currentOwned || currentOwned.encoded !== encoded) {
						throw new RunPodControlPlaneError(
							"ownership_not_proven",
							"RunPod cleanup refused because ownership is not proven",
						);
					}
					queued = await store.enqueueCleanup({
						podId: currentOwned.pod.id,
						pod: currentOwned.pod,
						ownershipEncoded: currentOwned.encoded,
						projectId: currentOwned.metadata.project,
						runId: currentOwned.metadata.run,
						taskId: currentOwned.metadata.task,
						attempt: currentOwned.metadata.attempt,
						ownerKey: currentOwned.metadata.owner,
					});
					await this.auditDecision(inventory, {
						kind: "operator_untracked_cleanup_enqueued",
						reason,
						decision: "enqueue_confirmed_current_account_ownership",
						attempt: queued.cleanupAttempts + 1,
						result: "cleanup_pending",
						extra: {
							podId,
							ownerKey: currentOwned.metadata.owner,
						},
					});
				}
				await this.cleanupUntrackedOwned(queued, reason);
			});
		});
		return this.readModel();
	}

	async readModel(auditLimit = 200): Promise<RunPodAccountReadModel> {
		const settings = await this.settings();
		const credentialCheckedAt = Date.now();
		const credentialReady = await this.options.client.credentialReady();
		const hard = this.policy.enabled ? policyCeilings(this.policy) : null;
		const accountBalance = await (await this.accountStore()).accountBalance();
		const balanceFreshnessMs =
			(this.policy.enabled
				? (this.policy.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS)
				: DEFAULT_RECONCILE_INTERVAL_MS) * 2;
		const balance: RunPodAccountReadModel["balance"] = {
			remainingCredits: accountBalance?.remainingCredits ?? null,
			currency: "USD",
			source: "RunPod clientBalance",
			inferredFromSpend: false,
			observedAt: accountBalance?.observedAt ?? null,
			checkedAt: accountBalance?.checkedAt ?? null,
			fresh:
				accountBalance?.remainingCredits !== null &&
				accountBalance?.remainingCredits !== undefined &&
				accountBalance.observedAt !== null &&
				accountBalance.errorCode === null &&
				Date.now() - accountBalance.observedAt <= balanceFreshnessMs,
			error: accountBalance?.errorCode ?? null,
		};
		if (!this.policy.enabled) {
			return {
				enabled: false,
				accountId: this.accountId,
				credential: {
					ready: credentialReady,
					checkedAt: credentialCheckedAt,
					validatedAt:
						credentialReady &&
						(this.lastCredentialValidationError ?? accountBalance?.errorCode) ==
							null
							? (this.lastCredentialValidationAt ??
								accountBalance?.observedAt ??
								null)
							: null,
					validationError:
						this.lastCredentialValidationError ??
						accountBalance?.errorCode ??
						null,
				},
				balance,
				gate: this.gate.status(),
				settings: {
					version: settings.version,
					dispatchPaused: settings.dispatchPaused,
					updatedAt: settings.updatedAt,
					updatedBy: settings.updatedBy,
					reason: settings.reason,
					policy: settings.policy,
				},
				inventory: {
					observedAt: null,
					cause: null,
					fresh: false,
					error: null,
					podCount: 0,
				},
				reconcile: {
					lastAttemptAt: null,
					lastError: null,
					cleanupPending: 0,
				},
				policy: { hard: null },
				pods: [],
				costs: {
					providerInfrastructure: {
						label: "RunPod infrastructure",
						costPerHr: 0,
						adjustedCostPerHr: 0,
						hourlyBurn: 0,
						estimatedCost: 0,
					},
					agentTokens: {
						label: "Agent tokens",
						includedInInfrastructureCost: false,
						cost: null,
					},
				},
				historicalBilling: {
					available: false,
					key: "podId",
					gatesLiveSafety: false,
					records: [],
				},
				audit: [],
			};
		}

		const store = await this.accountStore();
		const [
			inventoryRows,
			snapshot,
			leases,
			cleanup,
			firstDeleteAttempts,
			latestInventoryOperation,
			latestReconcileOperation,
			audit,
		] = await Promise.all([
			store.listInventory(),
			store.latestInventorySnapshot(),
			store.listLeases(),
			store.listCleanup(),
			store.firstDeleteAttempts(),
			store.latestOperation("inventory"),
			store.latestOperation("reconcile"),
			store.listAudit(auditLimit),
		]);
		const leaseByOwnership = new Map(
			leases.map((lease) => [lease.ownershipEncoded, lease]),
		);
		const cleanupByPod = new Map(
			cleanup.map((record) => [record.podId, record]),
		);
		const cleanupByOwnership = new Map(
			cleanup.map((record) => [record.ownershipEncoded, record]),
		);
		const enabledPolicy = this.requireEnabled();
		const now = Date.now();
		const pods: RunPodAccountReadModel["pods"] = inventoryRows.map((row) => {
			const metadata = decodeRunPodOwnership(row.ownershipEncoded ?? undefined);
			const lease = row.ownershipEncoded
				? leaseByOwnership.get(row.ownershipEncoded)
				: undefined;
			const queued =
				cleanupByPod.get(row.pod.id) ??
				(row.ownershipEncoded
					? cleanupByOwnership.get(row.ownershipEncoded)
					: undefined);
			const ownedAccount =
				metadata?.ns === enabledPolicy.ownershipNamespace &&
				metadata.account === enabledPolicy.accountId;
			const ownership: RunPodOwnershipClassification = lease
				? "owned_tracked"
				: ownedAccount
					? "owned_untracked"
					: metadata
						? "foreign_account"
						: "unknown";
			let effective: Record<string, unknown> | null = null;
			if (lease) {
				try {
					effective = effectiveCeilings(
						effectiveRunPodPolicy(
							this.policy,
							this.options.projectPolicy?.(lease.owner.projectId),
						),
					);
				} catch {
					effective = effectiveCeilings(lease.policy);
				}
			}
			const start = lease?.createdAt ?? queued?.firstSeenAt ?? row.observedAt;
			const end = queued?.absenceConfirmedAt ?? now;
			const estimatedRuntimeHours = Math.max(0, end - start) / 3_600_000;
			const hourlyBurn = podHourlyPrice(row.pod as RunPodPod);
			const cleanupPending =
				queued?.absenceConfirmedAt === null || lease?.phase === "terminating";
			const cleanupRequestedAt =
				queued?.cleanupRequestedAt ??
				(lease ? (firstDeleteAttempts.get(lease.ref) ?? null) : null);
			return {
				podId: row.pod.id,
				name: row.pod.name,
				desiredStatus: row.pod.desiredStatus,
				live: isLivePod(row.pod as RunPodPod),
				ownership,
				projectId: lease?.owner.projectId ?? metadata?.project ?? null,
				projectName: lease?.owner.projectName ?? null,
				taskId: lease?.owner.taskId ?? metadata?.task ?? null,
				runId: lease?.owner.runId ?? metadata?.run ?? null,
				attempt: lease?.owner.attempt ?? metadata?.attempt ?? null,
				ownerKey: lease?.owner.ownerKey ?? metadata?.owner ?? null,
				ownershipFingerprint: row.ownershipEncoded
					? createHash("sha256").update(row.ownershipEncoded).digest("hex")
					: null,
				leaseRef: lease?.ref ?? null,
				phase:
					lease?.phase ?? (cleanupPending ? "cleanup_pending" : "observed"),
				requestedShape: lease ? { ...lease.request } : null,
				actualShape: observedRunPodShape(row.pod as RunPodPod),
				ceilings: { hard, effective },
				costPerHr: row.pod.costPerHr,
				adjustedCostPerHr: row.pod.adjustedCostPerHr,
				hourlyBurn,
				estimatedRuntimeHours,
				estimatedInfrastructureCost:
					hourlyBurn === null ? null : hourlyBurn * estimatedRuntimeHours,
				lifecycleAttempts: {
					teardown: lease?.teardownAttempts ?? 0,
					cleanup: queued?.cleanupAttempts ?? 0,
				},
				cleanup: {
					pending: cleanupPending,
					requestedAt: cleanupRequestedAt,
					pendingAgeMs:
						cleanupPending && cleanupRequestedAt !== null
							? Math.max(0, now - cleanupRequestedAt)
							: null,
					absenceConfirmedAt: queued?.absenceConfirmedAt ?? null,
					lastError: queued?.lastErrorCode ?? lease?.lastErrorCode ?? null,
				},
			};
		});
		const visibleOwnership = new Set(
			inventoryRows
				.map((row) => row.ownershipEncoded)
				.filter((value): value is string => value !== null),
		);
		for (const lease of leases) {
			if (
				visibleOwnership.has(lease.ownershipEncoded) ||
				!lease.providerPodId ||
				!lease.observedShape
			) {
				continue;
			}
			let effective: Record<string, unknown> | null = null;
			try {
				effective = effectiveCeilings(
					effectiveRunPodPolicy(
						this.policy,
						this.options.projectPolicy?.(lease.owner.projectId),
					),
				);
			} catch {
				effective = effectiveCeilings(lease.policy);
			}
			const end = lease.lastObservedAt ?? now;
			const runtime = Math.max(0, end - lease.createdAt) / 3_600_000;
			const cleanupRequestedAt = firstDeleteAttempts.get(lease.ref) ?? null;
			const pending = lease.phase === "terminating";
			pods.push({
				podId: lease.providerPodId,
				name: "",
				desiredStatus: lease.phase === "absent" ? "ABSENT" : "UNOBSERVED",
				live: false,
				ownership: "owned_tracked",
				projectId: lease.owner.projectId,
				projectName: lease.owner.projectName,
				taskId: lease.owner.taskId,
				runId: lease.owner.runId,
				attempt: lease.owner.attempt,
				ownerKey: lease.owner.ownerKey,
				ownershipFingerprint: createHash("sha256")
					.update(lease.ownershipEncoded)
					.digest("hex"),
				leaseRef: lease.ref,
				phase: lease.phase,
				requestedShape: { ...lease.request },
				actualShape: lease.observedShape,
				ceilings: { hard, effective },
				costPerHr: lease.observedHourlyPrice,
				adjustedCostPerHr: null,
				hourlyBurn: pending ? lease.observedHourlyPrice : 0,
				estimatedRuntimeHours: runtime,
				estimatedInfrastructureCost:
					lease.observedHourlyPrice === null
						? null
						: lease.observedHourlyPrice * runtime,
				lifecycleAttempts: {
					teardown: lease.teardownAttempts,
					cleanup: 0,
				},
				cleanup: {
					pending,
					requestedAt: cleanupRequestedAt,
					pendingAgeMs:
						pending && cleanupRequestedAt !== null
							? Math.max(0, now - cleanupRequestedAt)
							: null,
					absenceConfirmedAt:
						lease.phase === "absent" ? lease.lastObservedAt : null,
					lastError: lease.lastErrorCode,
				},
			});
		}
		const currentPodIds = new Set(inventoryRows.map((row) => row.pod.id));
		for (const record of cleanup) {
			if (
				currentPodIds.has(record.podId) ||
				visibleOwnership.has(record.ownershipEncoded) ||
				leaseByOwnership.has(record.ownershipEncoded)
			) {
				continue;
			}
			const metadata = decodeRunPodOwnership(record.ownershipEncoded);
			const end = record.absenceConfirmedAt ?? now;
			const runtime = Math.max(0, end - record.firstSeenAt) / 3_600_000;
			const rate = podHourlyPrice(record.observedPod as RunPodPod);
			const pending = record.absenceConfirmedAt === null;
			pods.push({
				podId: record.podId,
				name: record.observedPod.name,
				desiredStatus: pending ? "UNOBSERVED" : "ABSENT",
				live: false,
				ownership: "owned_untracked",
				projectId: metadata?.project ?? record.projectId,
				projectName: null,
				taskId: metadata?.task ?? record.taskId,
				runId: metadata?.run ?? record.runId,
				attempt: metadata?.attempt ?? record.attempt,
				ownerKey: metadata?.owner ?? record.ownerKey,
				ownershipFingerprint: createHash("sha256")
					.update(record.ownershipEncoded)
					.digest("hex"),
				leaseRef: null,
				phase: pending ? "cleanup_pending" : "absent",
				requestedShape: null,
				actualShape: observedRunPodShape(record.observedPod as RunPodPod),
				ceilings: { hard, effective: null },
				costPerHr: record.observedPod.costPerHr,
				adjustedCostPerHr: record.observedPod.adjustedCostPerHr,
				hourlyBurn: pending ? rate : 0,
				estimatedRuntimeHours: runtime,
				estimatedInfrastructureCost: rate === null ? null : rate * runtime,
				lifecycleAttempts: {
					teardown: 0,
					cleanup: record.cleanupAttempts,
				},
				cleanup: {
					pending,
					requestedAt: record.cleanupRequestedAt,
					pendingAgeMs: pending
						? Math.max(0, now - record.cleanupRequestedAt)
						: null,
					absenceConfirmedAt: record.absenceConfirmedAt,
					lastError: record.lastErrorCode,
				},
			});
		}
		const present = pods.filter((pod) => currentPodIds.has(pod.podId));
		const sumOrNull = (values: Array<number | null>): number | null =>
			values.every((value) => value !== null)
				? values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
				: null;
		const estimatedCost = sumOrNull(
			pods.map((pod) => pod.estimatedInfrastructureCost),
		);
		const freshnessMs = (this.policy.reconcileIntervalMs ?? 60_000) * 2;
		const inventoryError =
			latestInventoryOperation?.state === "failed"
				? latestInventoryOperation.errorCode
				: null;
		const reconcileError =
			latestReconcileOperation?.state === "failed"
				? latestReconcileOperation.errorCode
				: null;
		return {
			enabled: true,
			accountId: this.accountId,
			credential: {
				ready: credentialReady,
				checkedAt: credentialCheckedAt,
				validatedAt:
					credentialReady &&
					(this.lastCredentialValidationError ?? inventoryError) === null
						? (this.lastCredentialValidationAt ?? snapshot?.observedAt ?? null)
						: null,
				validationError: this.lastCredentialValidationError ?? inventoryError,
			},
			balance,
			gate: this.gate.status(),
			settings: {
				version: settings.version,
				dispatchPaused: settings.dispatchPaused,
				updatedAt: settings.updatedAt,
				updatedBy: settings.updatedBy,
				reason: settings.reason,
				policy: settings.policy,
			},
			inventory: {
				observedAt: snapshot?.observedAt ?? null,
				cause: snapshot?.cause ?? null,
				fresh:
					Boolean(snapshot) &&
					inventoryError === null &&
					now - (snapshot?.observedAt ?? 0) <= freshnessMs,
				error: inventoryError,
				podCount: snapshot?.podCount ?? 0,
			},
			reconcile: {
				lastAttemptAt:
					this.lastReconcileAt ?? latestReconcileOperation?.updatedAt ?? null,
				lastError: this.lastReconcileError ?? reconcileError,
				cleanupPending: cleanup.filter(
					(record) => record.absenceConfirmedAt === null,
				).length,
			},
			policy: { hard },
			pods,
			costs: {
				providerInfrastructure: {
					label: "RunPod infrastructure",
					costPerHr: sumOrNull(present.map((pod) => pod.costPerHr)),
					adjustedCostPerHr: sumOrNull(
						present.map((pod) => pod.adjustedCostPerHr),
					),
					hourlyBurn: sumOrNull(present.map((pod) => pod.hourlyBurn)),
					estimatedCost,
				},
				agentTokens: {
					label: "Agent tokens",
					includedInInfrastructureCost: false,
					cost: null,
				},
			},
			historicalBilling: {
				available: false,
				key: "podId",
				gatesLiveSafety: false,
				records: [],
			},
			audit,
		};
	}

	private async enforceLiveAccountPolicy(
		inventory: Inventory,
		leases: readonly RunPodLeaseRecord[],
	): Promise<boolean> {
		const policy = this.requireEnabled();
		let live = inventory.pods.filter(isLivePod);
		let deleted = false;
		const leaseForPod = (pod: RunPodPod): RunPodLeaseRecord | null =>
			leases.find(
				(lease) => this.matchingPods(lease, inventory)[0]?.id === pod.id,
			) ?? null;

		for (const pod of [...live]) {
			if (podHourlyPrice(pod) !== null) continue;
			const lease = leaseForPod(pod);
			if (!lease) {
				this.gate.close("an unowned live RunPod Pod has no trustworthy price");
				throw new RunPodControlPlaneError(
					"unknown_live_burn",
					"an unowned live RunPod Pod has no trustworthy price",
				);
			}
			await this.deleteAndConfirm(
				lease,
				pod,
				`${lease.ref}/unknown-burn-delete/${Date.now()}`,
				"unknown_live_burn",
			);
			live = live.filter((candidate) => candidate.id !== pod.id);
			deleted = true;
		}

		const burn = () =>
			live.reduce((sum, pod) => sum + (podHourlyPrice(pod) ?? 0), 0);
		const newestOwned = leases
			.map((lease) => ({
				lease,
				pod: this.matchingPods(lease, inventory).find(isLivePod),
			}))
			.filter(
				(entry): entry is { lease: RunPodLeaseRecord; pod: RunPodPod } =>
					entry.pod !== undefined,
			)
			.sort((a, b) => b.lease.createdAt - a.lease.createdAt);
		while (
			(policy.maxConcurrentPods !== undefined &&
				live.length > policy.maxConcurrentPods) ||
			burn() > policy.maxAggregateHourlyPrice
		) {
			const candidate = newestOwned.find((entry) =>
				live.some((pod) => pod.id === entry.pod.id),
			);
			if (!candidate) {
				this.gate.close("external Pods exceed the RunPod account hard caps");
				throw new RunPodControlPlaneError(
					"account_cap_exceeded",
					"external Pods exceed the RunPod account hard caps",
				);
			}
			await this.deleteAndConfirm(
				candidate.lease,
				candidate.pod,
				`${candidate.lease.ref}/account-cap-delete/${Date.now()}`,
				"account_hard_cap",
			);
			live = live.filter((pod) => pod.id !== candidate.pod.id);
			deleted = true;
		}
		return deleted;
	}

	async reconcile(targetKind: string, cause?: string): Promise<void>;
	async reconcile(cause: string): Promise<void>;
	async reconcile(
		targetKindOrCause: string,
		maybeCause?: string,
	): Promise<void> {
		if (!this.policy.enabled) return;
		if (maybeCause !== undefined && targetKindOrCause !== "runpod") return;
		const cause = maybeCause ?? targetKindOrCause;
		await this.serializeMutation(async () => {
			const store = await this.accountStore();
			await store.withMutationLock(() => this.reconcileWithLock(cause, store));
		});
	}

	private async reconcileWithLock(
		cause: string,
		store: RunPodAccountStore,
	): Promise<void> {
		const reconcileOperationId = `reconcile/${Date.now()}/${randomUUID()}`;
		await store.recordOperationIntent({
			operationId: reconcileOperationId,
			leaseRef: null,
			kind: "reconcile",
			request: { cause },
		});
		try {
			await this.refreshAccountBalance(`reconcile:${cause}`);
			let inventory = await this.fullInventory(`reconcile:${cause}`);
			this.lastCredentialValidationAt = inventory.observedAt;
			this.lastCredentialValidationError = null;
			let inspection = await this.assertUnambiguousInventory(inventory);
			let ownerUnavailable = (
				await this.registerUntrackedOwned(inventory, inspection)
			).ownerUnavailable;
			const initialLeases = await store.listLeases();
			for (const lease of initialLeases) {
				const createState = await store.getOperationState(
					lease.createOperationId,
				);
				if (
					isAmbiguousCreateBoundary(createState) &&
					this.matchingPods(lease, inventory).length === 0
				) {
					this.closeAmbiguousCreate();
				}
			}

			let cleanupError: unknown = null;
			for (const cleanup of (await store.listCleanup()).filter(
				(record) => record.absenceConfirmedAt === null,
			)) {
				try {
					const metadata = decodeRunPodOwnership(cleanup.ownershipEncoded);
					const ownerResolution = metadata
						? await this.resolveOwner(metadata, null)
						: null;
					if (ownerResolution?.state === "unavailable") {
						ownerUnavailable = true;
						this.gate.close(
							`RunPod owner project '${ownerResolution.projectName}' is configured but unavailable`,
						);
						continue;
					}
					await this.cleanupUntrackedOwned(
						cleanup,
						"owned Pod has no recoverable global lease",
					);
				} catch (error) {
					cleanupError ??= error;
				}
			}

			inventory = await this.fullInventory(
				`reconcile:${cause}:after-cleanup-queue`,
			);
			inspection = await this.assertUnambiguousInventory(inventory);
			// A Pod that appeared after the first account list is not ignored.
			if (inspection.untrackedOwned.length > 0) {
				const registered = await this.registerUntrackedOwned(
					inventory,
					inspection,
				);
				ownerUnavailable ||= registered.ownerUnavailable;
				if (registered.records.length > 0) {
					cleanupError ??= new RunPodControlPlaneError(
						"cleanup_pending",
						"new owned untracked RunPod Pods await the next cleanup pass",
					);
				}
			}
			let leases = await store.listLeases();
			// Establish attachment availability before hard-cap cleanup mutates any live owned Pod.
			for (const lease of leases) {
				const pod = this.matchingPods(lease, inventory).find(isLivePod);
				const metadata = pod ? inventory.metadata.get(pod.id) : null;
				const resolution = metadata
					? await this.resolveOwner(
							metadata,
							lease.ref,
							lease.owner.projectName,
						)
					: null;
				if (resolution?.state === "unavailable") {
					ownerUnavailable = true;
					this.gate.close(
						`RunPod owner project '${resolution.projectName}' is configured but unavailable`,
					);
				}
			}
			if (
				!ownerUnavailable &&
				!cleanupError &&
				(await this.enforceLiveAccountPolicy(inventory, leases))
			) {
				inventory = await this.fullInventory(
					`reconcile:${cause}:after-hard-policy`,
				);
				await this.assertUnambiguousInventory(inventory);
				leases = await store.listLeases();
			}
			for (const lease of leases) {
				const matching = this.matchingPods(lease, inventory);
				const liveMatching = matching.filter(isLivePod);
				const createState = await store.getOperationState(
					lease.createOperationId,
				);
				if (matching.length === 0) {
					if (isAmbiguousCreateBoundary(createState)) {
						this.closeAmbiguousCreate();
					}
					if (lease.phase !== "intent") {
						await this.auditDecision(inventory, {
							kind: "runpod_decision",
							reason: "fresh full inventory contains no matching Pod",
							decision: "confirm_absence",
							attempt: lease.teardownAttempts,
							result: "absent",
							leaseRef: lease.ref,
						});
						await this.removeLeaseBootstrap(lease);
						await store.updateLease(lease.ref, {
							phase: "absent",
							lastObservedAt: inventory.observedAt,
						});
					}
					continue;
				}
				if (matching.length !== 1) {
					this.gate.close("RunPod reconciliation found ambiguous ownership");
					throw new RunPodControlPlaneError(
						"ambiguous_ownership",
						"RunPod reconciliation found ambiguous ownership",
					);
				}
				if (liveMatching.length === 0) {
					if (isAmbiguousCreateBoundary(createState)) {
						this.closeAmbiguousCreate();
					}
					await this.deleteAndConfirm(
						lease,
						matching[0] as RunPodPod,
						`${lease.ref}/non-live-delete/${Date.now()}`,
						"owned_non_live_pod",
					);
					continue;
				}
				const pod = liveMatching[0] as RunPodPod;
				const metadata = inventory.metadata.get(pod.id);
				if (!metadata) {
					throw new RunPodControlPlaneError(
						"ownership_not_proven",
						"tracked RunPod Pod has no decoded ownership",
					);
				}
				const ownerResolution = await this.resolveOwner(
					metadata,
					lease.ref,
					lease.owner.projectName,
				);
				if (ownerResolution?.state === "unavailable") {
					ownerUnavailable = true;
					this.gate.close(
						`RunPod owner project '${ownerResolution.projectName}' is configured but unavailable`,
					);
					await this.auditDecision(inventory, {
						kind: "owner_unavailable",
						reason:
							"the configured owner project could not attach; ownership is not authoritatively detached",
						decision: "retain_owned_pod_and_close_dispatch",
						attempt: 1,
						result: ownerResolution.reason,
						leaseRef: lease.ref,
						extra: { podId: pod.id, ownerKey: metadata.owner },
					});
					continue;
				}
				if (lease.phase === "terminating") {
					try {
						await this.deleteAndConfirm(
							lease,
							pod,
							`${lease.ref}/cleanup-retry/${Date.now()}`,
							"cleanup_retry",
						);
					} catch (error) {
						cleanupError ??= error;
					}
					continue;
				}
				if (ownerResolution?.state === "unrecoverable") {
					try {
						await this.deleteAndConfirm(
							lease,
							pod,
							`${lease.ref}/unrecoverable-delete/${Date.now()}`,
							ownerResolution.reason,
						);
					} catch (error) {
						cleanupError ??= error;
					}
					continue;
				}
				const recoveredCreate = createState !== "completed";
				if (recoveredCreate) {
					await this.completeRecoveredCreate(store, lease, pod);
				}
				if (lease.phase === "absent" || lease.phase === "failed") {
					if (recoveredCreate) {
						await this.adopt(
							lease,
							pod,
							`${lease.ref}/recovered-create/${Date.now()}`,
							inventory,
						);
						if (ownerResolution?.state === "ended") {
							ownerResolution.resumeFinalization();
						}
						continue;
					}
					await this.deleteAndConfirm(
						lease,
						pod,
						`${lease.ref}/orphan-delete/${Date.now()}`,
						"owned_orphan",
					);
					continue;
				}
				await this.adopt(
					lease,
					pod,
					`${lease.ref}/reconcile/${Date.now()}`,
					inventory,
				);
				if (ownerResolution?.state === "ended") {
					ownerResolution.resumeFinalization();
				}
			}
			if (cleanupError) throw cleanupError;
			if (ownerUnavailable) {
				throw new RunPodControlPlaneError(
					"owner_unavailable",
					"RunPod ownership cannot be reconciled until every configured owner project attaches or is explicitly detached",
				);
			}
			const [pending, pendingLeases] = await Promise.all([
				store
					.listCleanup()
					.then((records) =>
						records.filter((record) => record.absenceConfirmedAt === null),
					),
				store
					.listLeases()
					.then((records) =>
						records.filter((lease) => lease.phase === "terminating"),
					),
			]);
			if (pending.length > 0 || pendingLeases.length > 0) {
				throw new RunPodControlPlaneError(
					"cleanup_pending",
					"RunPod cleanup remains pending absence proof",
				);
			}
			const detachedProjects = await store.listDetachedProjects();
			if (detachedProjects.length > 0) {
				// Tombstones are compacted only against a fresh, complete ownership
				// inventory after all cleanup queues have converged.
				const proof = await this.fullInventory(
					`reconcile:${cause}:detached-project-absence-proof`,
				);
				await this.assertUnambiguousInventory(proof);
				const presentProjectIds = new Set(
					[...proof.metadata.values()]
						.filter(
							(metadata): metadata is RunPodOwnershipMetadata =>
								metadata !== null,
						)
						.map((metadata) => metadata.project),
				);
				for (const detached of detachedProjects) {
					if (!presentProjectIds.has(detached.projectId)) {
						await store.clearDetachedProject(detached.projectId);
						await store.audit({
							kind: "project_detach_cleanup_proven",
							detail: {
								projectId: detached.projectId,
								projectName: detached.projectName,
								observedAt: proof.observedAt,
							},
						});
					}
				}
			}
			this.openGate();
			this.lastReconcileAt = Date.now();
			this.lastReconcileError = null;
			await store.finishOperation(reconcileOperationId, "completed", {
				result: {
					podCount: inventory.pods.length,
					leaseCount: leases.length,
				},
			});
		} catch (error) {
			this.lastReconcileAt = Date.now();
			this.lastReconcileError = safeCode(error);
			await store.finishOperation(reconcileOperationId, "failed", {
				errorCode: safeCode(error),
			});
			throw error;
		}
	}
}
