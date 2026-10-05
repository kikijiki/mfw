import type { RunReasoningEffort } from "@mfw/db/schema";
import type { SecretEnvironment } from "./execution-environment.ts";
import type { BwrapIsolation } from "./sandbox.ts";

/**
 * Execution placement is independent from admission. Resolving this value is
 * deliberately pure: callers can validate a task before asking either the
 * host coordinator or a provider account service for a lease.
 */
export interface ExecutionTargetSelection {
	kind: string;
	requestedShape?: TargetShape;
}

export type TargetShape = Readonly<Record<string, unknown>>;

export interface ProjectSemaphoreRequirement {
	scope: "project";
	id: string;
	amount: 1;
}

export interface HostResourceRequirement {
	scope: "host";
	id: string;
	/** Omitted is valid only for an eventual slot definition. */
	amount?: number | string;
}

export type ExecutionResourceRequirement =
	| string
	| {
			scope: "project" | "host";
			id: string;
			amount?: number | string;
	  };

export interface TargetResolutionInput extends ExecutionTargetSelection {
	requiresResources?: readonly ExecutionResourceRequirement[];
	localStagingResources?: readonly ExecutionResourceRequirement[];
}

export interface TargetAdmissionRequirements {
	/** Capacity on the machine which executes the driver. Empty for remote runs. */
	executionHost: readonly HostResourceRequirement[];
	/** Project-private one-slot semaphores; valid for every execution target. */
	projectSemaphores: readonly ProjectSemaphoreRequirement[];
	/** Daemon-host capacity used to stage/collect a remote workspace. */
	localStaging: readonly HostResourceRequirement[];
}

export interface ResolvedExecutionTarget extends ExecutionTargetSelection {
	requestedShape: TargetShape;
	requirements: TargetAdmissionRequirements;
}

export class InvalidExecutionTargetRequirementsError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvalidExecutionTargetRequirementsError";
	}
}

function nonEmptyId(id: unknown, field: string): string {
	if (typeof id !== "string" || id.trim().length === 0) {
		throw new InvalidExecutionTargetRequirementsError(
			`${field} resource id must be a non-empty string`,
		);
	}
	return id.trim();
}

function authoredHostAmount(
	amount: unknown,
	id: string,
): number | string | undefined {
	if (amount === undefined) return undefined;
	if (
		typeof amount === "number" &&
		Number.isSafeInteger(amount) &&
		amount > 0
	) {
		return amount;
	}
	if (
		typeof amount === "string" &&
		/^[1-9][0-9]* (?:B|KiB|MiB|GiB|TiB|PiB|EiB)$/.test(amount)
	) {
		return amount;
	}
	throw new InvalidExecutionTargetRequirementsError(
		`host resource '${id}' amount must be a positive integer or an explicit IEC byte quantity such as '8 GiB'`,
	);
}

/**
 * Split the three admission domains without acquiring anything. In
 * particular, host-scoped `requires_resources` on a remote target is rejected
 * here instead of being silently ignored or accidentally leased locally.
 */
export function resolveExecutionTarget(
	input: TargetResolutionInput,
): ResolvedExecutionTarget {
	const kind = input.kind.trim();
	if (!kind) {
		throw new InvalidExecutionTargetRequirementsError(
			"execution target kind must be a non-empty string",
		);
	}
	const executionHost: HostResourceRequirement[] = [];
	const projectSemaphores: ProjectSemaphoreRequirement[] = [];
	const localStaging: HostResourceRequirement[] = [];
	const requiresSeen = new Set<string>();
	const stagingSeen = new Set<string>();

	for (const requirement of input.requiresResources ?? []) {
		if (typeof requirement === "string") {
			const id = nonEmptyId(requirement, "project");
			const key = `project\0${id}`;
			if (requiresSeen.has(key)) {
				throw new InvalidExecutionTargetRequirementsError(
					`duplicate project resource '${id}' in requires_resources`,
				);
			}
			requiresSeen.add(key);
			projectSemaphores.push({
				scope: "project",
				id,
				amount: 1,
			});
			continue;
		}
		const id = nonEmptyId(requirement.id, requirement.scope);
		const key = `${requirement.scope}\0${id}`;
		if (requiresSeen.has(key)) {
			throw new InvalidExecutionTargetRequirementsError(
				`duplicate ${requirement.scope} resource '${id}' in requires_resources`,
			);
		}
		requiresSeen.add(key);
		if (requirement.scope === "project") {
			if (requirement.amount !== undefined && requirement.amount !== 1) {
				throw new InvalidExecutionTargetRequirementsError(
					`project semaphore '${id}' must request exactly one slot`,
				);
			}
			projectSemaphores.push({ scope: "project", id, amount: 1 });
			continue;
		}
		if (requirement.scope !== "host") {
			throw new InvalidExecutionTargetRequirementsError(
				`resource '${id}' has unsupported scope '${String(requirement.scope)}'`,
			);
		}
		if (kind !== "local") {
			throw new InvalidExecutionTargetRequirementsError(
				`execution target '${kind}' cannot use host requirement '${id}' in requires_resources; use target shape or local_staging_resources`,
			);
		}
		executionHost.push({
			scope: "host",
			id,
			amount: authoredHostAmount(requirement.amount, id),
		});
	}

	for (const requirement of input.localStagingResources ?? []) {
		if (kind === "local") {
			throw new InvalidExecutionTargetRequirementsError(
				"local_staging_resources is only valid for a non-local execution target",
			);
		}
		if (typeof requirement === "string" || requirement.scope !== "host") {
			throw new InvalidExecutionTargetRequirementsError(
				"local_staging_resources entries must be explicit host-scoped requirements",
			);
		}
		const id = nonEmptyId(requirement.id, "local staging");
		if (stagingSeen.has(id)) {
			throw new InvalidExecutionTargetRequirementsError(
				`duplicate host resource '${id}' in local_staging_resources`,
			);
		}
		stagingSeen.add(id);
		localStaging.push({
			scope: "host",
			id,
			amount: authoredHostAmount(requirement.amount, requirement.id),
		});
	}

	return {
		kind,
		requestedShape: { ...(input.requestedShape ?? {}) },
		requirements: { executionHost, projectSemaphores, localStaging },
	};
}

/** Stable identities which every target operation and global lease command carries. */
export interface ExecutionOwnership {
	projectId: string;
	projectName: string;
	runId: string;
	taskId: string | null;
	attempt: number;
	/** Stable across retries of this run attempt. */
	ownerKey: string;
}

export function executionOwnerKey(
	projectId: string,
	runId: string,
	attempt: number,
): string {
	return `${projectId}/${runId}/${attempt}`;
}

export function targetOperationId(
	owner: ExecutionOwnership,
	operation: string,
): string {
	return `${owner.ownerKey}/${operation}`;
}

export interface ExecutionWorkspace {
	/** Canonical local merge candidate, even when execution occurs elsewhere. */
	canonicalPath: string;
	branch: string;
	baseSha: string;
	/** Target-side mirror; local execution uses canonicalPath. */
	executionPath: string;
}

export interface PrepareExecutionRequest {
	owner: ExecutionOwnership;
	runDir: string;
	projectRoot: string;
	integrationBranch: string;
	requestedShape: TargetShape;
	reuse?: {
		worktreePath: string;
		branch: string;
		baseSha?: string;
	};
}

export interface PreparedExecution {
	targetKind: string;
	workspace: ExecutionWorkspace;
	globalLeaseRef: string | null;
	observedShape: TargetShape | null;
}

/** Target-neutral driver invocation. Targets materialize their own transport. */
export interface ExecutionDriverSpec {
	driverScript: string;
	agentArgv: string[];
	bridgeArgv?: string[];
	providerArgv?: string[];
	/** Public deterministic values only; credentials belong in secretEnvironment. */
	env: Record<string, string>;
	/** Values are in-memory only and may be opened only by a secret-aware host. */
	secretEnvironment?: SecretEnvironment;
	model: string;
	reasoningEffort: RunReasoningEffort;
	initialMessage: string;
	steer: boolean;
	approvalMode: "autonomous" | "interactive";
	isolation?: BwrapIsolation;
}

export interface LaunchExecutionRequest {
	owner: ExecutionOwnership;
	runDir: string;
	projectRoot: string;
	workspace: ExecutionWorkspace;
	globalLeaseRef: string | null;
	driver: ExecutionDriverSpec;
}

export type ExecutionObservation =
	| { state: "starting" | "running" | "unknown"; observedShape?: TargetShape }
	| {
			state: "exited";
			exitCode?: number;
			killReason?: string;
			observedShape?: TargetShape;
	  }
	| { state: "absent"; observedShape?: TargetShape };

export type ExecutionControl =
	| { type: "interrupt" }
	| { type: "kill"; reason: string }
	| { type: "steer"; message: string; interruptCapable: boolean }
	| {
			type: "approval";
			requestId: string;
			decision: "accept" | "acceptForSession" | "decline" | "cancel";
	  };

export interface ExecutionTargetRef {
	owner: ExecutionOwnership;
	runDir: string;
	globalLeaseRef: string | null;
	workspace: ExecutionWorkspace | null;
	/** Re-resolved in memory for remote evidence redaction and collection scanning. */
	secretEnvironment?: SecretEnvironment;
	/** Durable names only; values may be unavailable after credential revocation. */
	secretNames?: readonly string[];
	/** Status/control/disposal remain allowed, but no remote evidence may be copied. */
	evidenceSecretsUnavailable?: boolean;
}

export interface CollectExecutionResult {
	observedShape: TargetShape | null;
}

export interface DisposeExecutionResult {
	absenceConfirmed: boolean;
	observedShape: TargetShape | null;
}

export interface ExecutionInventoryItem {
	ownerKey: string;
	globalLeaseRef: string | null;
	observation: ExecutionObservation;
}

export interface ExecutionReconcileReport {
	observations: readonly ExecutionInventoryItem[];
	errors: readonly { ownerKey: string; code: string }[];
}

/**
 * One lifecycle contract for local and external targets. Implementations must
 * make every method safe to retry with the same owner/operation identity.
 */
export interface ExecutionTarget {
	readonly kind: string;
	prepare(request: PrepareExecutionRequest): Promise<PreparedExecution>;
	/** Compensate a prepared allocation which could not be durably linked. */
	rollbackPreparation?(
		request: PrepareExecutionRequest,
		prepared: PreparedExecution,
	): Promise<void>;
	launch(request: LaunchExecutionRequest): Promise<void>;
	observe(ref: ExecutionTargetRef): Promise<ExecutionObservation>;
	control(ref: ExecutionTargetRef, command: ExecutionControl): Promise<void>;
	collect(ref: ExecutionTargetRef): Promise<CollectExecutionResult>;
	dispose(ref: ExecutionTargetRef): Promise<DisposeExecutionResult>;
	inventory(
		refs: readonly ExecutionTargetRef[],
	): Promise<readonly ExecutionInventoryItem[]>;
	reconcile(
		refs: readonly ExecutionTargetRef[],
	): Promise<ExecutionReconcileReport>;
}

export class UnknownExecutionTargetError extends Error {
	constructor(readonly kind: string) {
		super(`execution target '${kind}' is not installed`);
		this.name = "UnknownExecutionTargetError";
	}
}

/** The remote launch request may have detached successfully; retry by observe. */
export class ExecutionLaunchUncertainError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ExecutionLaunchUncertainError";
	}
}

/** Injected selector; it owns adapters, never provider credentials or clients. */
export interface ExecutionTargetSelector {
	get(kind: string): ExecutionTarget | null;
}

export class ExecutionTargetRegistry implements ExecutionTargetSelector {
	private readonly targets = new Map<string, ExecutionTarget>();

	constructor(targets: readonly ExecutionTarget[] = []) {
		for (const target of targets) this.register(target);
	}

	register(target: ExecutionTarget): void {
		if (!target.kind.trim()) throw new Error("execution target kind is empty");
		if (this.targets.has(target.kind)) {
			throw new Error(
				`execution target '${target.kind}' is already registered`,
			);
		}
		this.targets.set(target.kind, target);
	}

	get(kind: string): ExecutionTarget | null {
		return this.targets.get(kind) ?? null;
	}

	require(kind: string): ExecutionTarget {
		const target = this.get(kind);
		if (!target) throw new UnknownExecutionTargetError(kind);
		return target;
	}
}

// -------------------------------------------------------------------------
// Process-global provider account boundary
// -------------------------------------------------------------------------

export interface ProviderLeaseIntent {
	operationId: string;
	targetKind: string;
	owner: ExecutionOwnership;
	requestedShape: TargetShape;
}

export interface ProviderLease {
	/** Opaque global-store reference. It is not a provider resource id. */
	ref: string;
	targetKind: string;
	ownerKey: string;
	requestedShape: TargetShape;
	observedShape: TargetShape | null;
}

export type ProviderLeaseCommand =
	| { type: "provision" }
	| { type: "phase"; phase: "staging" | "executing" | "collecting" }
	| { type: "control"; command: ExecutionControl }
	| { type: "collect" }
	| { type: "dispose"; reason: string };

/**
 * Narrow port implemented by a process-global account service. A project or
 * target adapter receives this interface by injection; it never constructs a
 * provider client or owns credentials/reconciliation state.
 */
export interface ExecutionAccountServicePort {
	putLeaseIntent(intent: ProviderLeaseIntent): Promise<ProviderLease>;
	command(
		leaseRef: string,
		operationId: string,
		command: ProviderLeaseCommand,
	): Promise<ProviderLease>;
	observe(leaseRef: string): Promise<ProviderLease | null>;
	inventory(targetKind: string): Promise<readonly ProviderLease[]>;
	reconcile(targetKind: string, cause: string): Promise<void>;
}
