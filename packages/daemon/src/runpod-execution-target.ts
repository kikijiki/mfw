import { mkdir, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "@mfw/core/fsatomic";
import {
	redactSecretValues,
	SecretEnvironment,
} from "./execution-environment.ts";
import type {
	CollectExecutionResult,
	DisposeExecutionResult,
	ExecutionControl,
	ExecutionInventoryItem,
	ExecutionObservation,
	ExecutionReconcileReport,
	ExecutionTarget,
	ExecutionTargetRef,
	LaunchExecutionRequest,
	PreparedExecution,
	PrepareExecutionRequest,
} from "./execution-target.ts";
import { ExecutionLaunchUncertainError } from "./execution-target.ts";
import {
	RemoteTransportError,
	RunPodSshTransport,
} from "./remote-agent-host.ts";
import { applyRemoteCollection, createRemoteStage } from "./remote-worktree.ts";
import type {
	RunPodAccountService,
	RunPodLeaseConnection,
} from "./runpod-account-service.ts";
import { MFW_RUNPOD_CPU_IMAGE } from "./runpod-client.ts";
import {
	MFW_RUNPOD_CPU_READY_PATH,
	mfwRunPodCpuBootstrapCommand,
} from "./runpod-runtime.ts";
import { type Worktree, WorktreeManager } from "./worktree.ts";

const DEFAULT_READINESS_MS = 10 * 60_000;
const DEFAULT_TRANSFER_BYTES = 64 * 1024 * 1024;

export interface RunPodExecutionAccount {
	putLeaseIntent: RunPodAccountService["putLeaseIntent"];
	command: RunPodAccountService["command"];
	observe: RunPodAccountService["observe"];
	inventory: RunPodAccountService["inventory"];
	reconcile: RunPodAccountService["reconcile"];
	connection(ref: string): Promise<RunPodLeaseConnection | null>;
	podPresent(podId: string): Promise<boolean>;
}

export interface RunPodExecutionTransport {
	waitUntilReady(deadlineMs: number): Promise<void>;
	run(
		command: readonly string[],
		opts?: { timeoutMs?: number },
	): Promise<{
		stdout: string;
		stderr: string;
	}>;
	runWithSecrets: RunPodSshTransport["runWithSecrets"];
	upload(path: string, bytes: Uint8Array): Promise<void>;
	download(path: string): Promise<Uint8Array>;
}

export interface RunPodExecutionTargetOptions {
	account: RunPodExecutionAccount;
	projectRoot: string;
	integrationBranch: string;
	worktrees?: {
		create(runId: string, base?: string): Promise<Worktree>;
		remove(worktree: Worktree): Promise<void>;
	};
	transport?: (connection: RunPodLeaseConnection) => RunPodExecutionTransport;
	readinessMs?: number;
	maxTransferBytes?: number;
	remoteRoot?: string;
	/** Explicit absolute Git path in the selected image. */
	remoteGitPath?: string;
}

interface RemotePaths {
	root: string;
	worktree: string;
	runDir: string;
	stage: string;
	runtime: string;
	driver: string;
	bridge: string;
	config: string;
}

function paths(ref: string, remoteRoot: string): RemotePaths {
	if (!/^runpod_[a-f0-9]{32}$/.test(ref))
		throw new Error("invalid RunPod lease ref");
	const root = `${remoteRoot}/${ref}`;
	return {
		root,
		worktree: `${root}/worktree`,
		runDir: `${root}/run`,
		stage: `${root}/support/stage.json`,
		runtime: `${root}/support/runtime.js`,
		driver: `${root}/support/driver.js`,
		bridge: `${root}/support/bridge.js`,
		config: `${root}/support/runtime-config.json`,
	};
}

async function bundle(entrypoint: string): Promise<Uint8Array> {
	if (!isAbsolute(entrypoint))
		throw new Error("remote support entrypoint is not absolute");
	const built = await Bun.build({
		entrypoints: [entrypoint],
		target: "bun",
		format: "esm",
		minify: false,
		sourcemap: "none",
	});
	if (!built.success || !built.outputs[0]) {
		throw new Error("could not bundle remote execution support");
	}
	return new Uint8Array(await built.outputs[0].arrayBuffer());
}

function runtimeEntrypoint(): string {
	return fileURLToPath(new URL("./runpod-remote-runtime.ts", import.meta.url));
}

let runtimeBundle: Promise<Uint8Array> | undefined;
function bundledRuntime(): Promise<Uint8Array> {
	runtimeBundle ??= bundle(runtimeEntrypoint());
	return runtimeBundle;
}

function errorCode(error: unknown): string {
	return error instanceof RemoteTransportError
		? error.failure
		: error instanceof Error
			? error.name
			: "unknown";
}

function assertPublicEnvironmentHasNoCredentials(
	environment: Readonly<Record<string, string>>,
): void {
	const unsafe = Object.keys(environment).filter(
		(name) =>
			/(?:^|_)(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?)$/i.test(name) ||
			name.toUpperCase().startsWith("RUNPOD"),
	);
	if (unsafe.length > 0) {
		throw new Error(
			`remote public environment contains credential-like names: ${unsafe.sort().join(", ")}`,
		);
	}
}

export class RemoteSecretLeakError extends Error {
	constructor() {
		super("remote collection contains a workload secret and was rejected");
		this.name = "RemoteSecretLeakError";
	}
}

export class RemoteEvidenceSecretsUnavailableError extends Error {
	constructor() {
		super(
			"remote evidence cannot be synchronized because workload secrets are unavailable",
		);
		this.name = "RemoteEvidenceSecretsUnavailableError";
	}
}

function assertCollectionHasNoSecrets(
	bytes: Uint8Array,
	secrets: SecretEnvironment,
): void {
	if (secrets.isEmpty()) return;
	const materialized = secrets.materializeForLaunch();
	const text = new TextDecoder().decode(bytes);
	if (
		Object.values(materialized).some((value) => value && text.includes(value))
	) {
		throw new RemoteSecretLeakError();
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return;
	}
	if (!parsed || typeof parsed !== "object" || !("snapshot" in parsed)) return;
	const snapshot = (parsed as { snapshot?: unknown }).snapshot;
	if (!Array.isArray(snapshot)) return;
	for (const item of snapshot) {
		if (!item || typeof item !== "object") continue;
		const content = (item as { content?: unknown }).content;
		if (typeof content !== "string") continue;
		const decoded = Buffer.from(content, "base64").toString("utf8");
		if (
			Object.values(materialized).some(
				(value) => value && decoded.includes(value),
			)
		) {
			throw new RemoteSecretLeakError();
		}
	}
}

/** Provider capacity + secure SSH expressed through the shared target contract. */
export class RunPodExecutionTarget implements ExecutionTarget {
	readonly kind = "runpod";
	private readonly worktrees: NonNullable<
		RunPodExecutionTargetOptions["worktrees"]
	>;
	private readonly remoteRoot: string;

	constructor(private readonly options: RunPodExecutionTargetOptions) {
		this.worktrees =
			options.worktrees ?? new WorktreeManager(options.projectRoot);
		this.remoteRoot = options.remoteRoot ?? "/workspace/mfw";
	}

	async prepare(request: PrepareExecutionRequest): Promise<PreparedExecution> {
		const lease = await this.options.account.putLeaseIntent({
			operationId: `${request.owner.ownerKey}/prepare/intent`,
			targetKind: this.kind,
			owner: request.owner,
			requestedShape: request.requestedShape,
		});
		try {
			const worktree = request.reuse
				? {
						path: request.reuse.worktreePath,
						branch: request.reuse.branch,
						baseSha: request.reuse.baseSha ?? "",
					}
				: await this.worktrees.create(
						request.owner.runId,
						request.integrationBranch,
					);
			if (!worktree.baseSha)
				throw new Error("remote canonical worktree has no base SHA");
			return {
				targetKind: this.kind,
				workspace: {
					canonicalPath: worktree.path,
					executionPath: paths(lease.ref, this.remoteRoot).worktree,
					branch: worktree.branch,
					baseSha: worktree.baseSha,
				},
				globalLeaseRef: lease.ref,
				observedShape: lease.observedShape,
			};
		} catch (error) {
			await this.options.account.command(
				lease.ref,
				`${request.owner.ownerKey}/prepare-failed/dispose`,
				{ type: "dispose", reason: "prepare_failed" },
			);
			throw error;
		}
	}

	async rollbackPreparation(
		request: PrepareExecutionRequest,
		prepared: PreparedExecution,
	): Promise<void> {
		if (prepared.globalLeaseRef) {
			await this.options.account.command(
				prepared.globalLeaseRef,
				`${request.owner.ownerKey}/rollback/dispose`,
				{ type: "dispose", reason: "project_link_failed" },
			);
		}
		if (!request.reuse) {
			await this.worktrees.remove({
				path: prepared.workspace.canonicalPath,
				branch: prepared.workspace.branch,
				baseSha: prepared.workspace.baseSha,
			});
		}
	}

	async launch(request: LaunchExecutionRequest): Promise<void> {
		assertPublicEnvironmentHasNoCredentials(request.driver.env);
		const ref = this.requireLease(request.globalLeaseRef);
		await this.options.account.command(
			ref,
			`${request.owner.ownerKey}/provision`,
			{ type: "provision" },
		);
		const { transport } = await this.readyTransport(ref);
		const remote = paths(ref, this.remoteRoot);
		// A retry after detached launch must observe, never launch a second driver.
		const prior = await this.remoteObservation(transport, remote).catch(
			(error) => {
				if (error instanceof RemoteTransportError) {
					if (error.failure === "remote_exit") return null;
					if (
						error.failure === "network_lost" ||
						error.failure === "deadline_exceeded"
					) {
						throw new ExecutionLaunchUncertainError(
							"could not determine whether the remote driver was already launched",
						);
					}
				}
				throw error;
			},
		);
		if (prior?.state === "running" || prior?.state === "exited") return;

		await this.options.account.command(
			ref,
			`${request.owner.ownerKey}/phase/staging`,
			{ type: "phase", phase: "staging" },
		);
		const staged = await createRemoteStage({
			canonicalPath: request.workspace.canonicalPath,
			runDir: request.runDir,
			branch: request.workspace.branch,
			baseSha: request.workspace.baseSha,
			maxTransferBytes: this.maxTransferBytes,
		});
		const bridgeLocal = request.driver.bridgeArgv?.find(
			(value) => isAbsolute(value) && /\.[cm]?[jt]s$/.test(value),
		);
		const [stageBytes, runtimeBytes, driverBytes, bridgeBytes] =
			await Promise.all([
				readFile(staged.stagePath),
				bundledRuntime(),
				bundle(request.driver.driverScript),
				bridgeLocal ? bundle(bridgeLocal) : Promise.resolve(null),
			]);
		await transport.upload(remote.stage, stageBytes);
		await transport.upload(remote.runtime, runtimeBytes);
		await transport.upload(remote.driver, driverBytes);
		if (bridgeBytes) await transport.upload(remote.bridge, bridgeBytes);
		await transport.run(
			[
				"bun",
				"run",
				remote.runtime,
				"stage",
				remote.stage,
				remote.worktree,
				this.options.remoteGitPath ?? "/usr/bin/git",
			],
			{ timeoutMs: 10 * 60_000 },
		);

		const bridgeArgv = request.driver.bridgeArgv?.map((value) =>
			value === bridgeLocal ? remote.bridge : value,
		);
		const publicEnvironment = {
			...request.driver.env,
			MFW_REPORT_PATH: `${remote.worktree}/MFW_REPORT.json`,
		};
		const config = {
			runDir: remote.runDir,
			executionPath: remote.worktree,
			driverScript: remote.driver,
			secretNames: request.driver.secretEnvironment?.names() ?? [],
			driver: {
				argv: request.driver.agentArgv,
				bridgeArgv: bridgeArgv ?? request.driver.agentArgv,
				providerArgv: request.driver.providerArgv ?? [],
				cwd: remote.worktree,
				env: publicEnvironment,
				model: request.driver.model,
				reasoningEffort: request.driver.reasoningEffort,
				initialMessage: request.driver.initialMessage,
				steer: request.driver.steer,
				approvalMode: request.driver.approvalMode,
			},
		};
		await transport.upload(
			remote.config,
			new TextEncoder().encode(`${JSON.stringify(config)}\n`),
		);
		await this.options.account.command(
			ref,
			`${request.owner.ownerKey}/phase/executing`,
			{ type: "phase", phase: "executing" },
		);
		try {
			await transport.runWithSecrets(
				[
					"/usr/bin/setsid",
					"-f",
					"bun",
					"run",
					remote.runtime,
					"run",
					remote.config,
				],
				publicEnvironment,
				request.driver.secretEnvironment ?? new SecretEnvironment({}),
				{ timeoutMs: 60_000 },
			);
		} catch (error) {
			if (
				error instanceof RemoteTransportError &&
				(error.failure === "network_lost" ||
					error.failure === "deadline_exceeded")
			) {
				throw new ExecutionLaunchUncertainError(
					"remote detached launch response was uncertain",
				);
			}
			throw error;
		}
	}

	async observe(ref: ExecutionTargetRef): Promise<ExecutionObservation> {
		const leaseRef = this.requireLease(ref.globalLeaseRef);
		const connection = await this.options.account.connection(leaseRef);
		if (!connection) {
			const lease = await this.options.account.observe(leaseRef);
			const phase = String(lease?.observedShape?.phase ?? "unknown");
			return phase === "absent"
				? { state: "absent", observedShape: lease?.observedShape ?? undefined }
				: {
						state: "starting",
						observedShape: lease?.observedShape ?? undefined,
					};
		}
		const transport = this.transport(connection);
		const remote = paths(leaseRef, this.remoteRoot);
		if (!ref.evidenceSecretsUnavailable) {
			await this.syncArtifacts(
				transport,
				remote,
				ref.runDir,
				ref.secretEnvironment,
			);
		}
		const observed = await this.remoteObservation(transport, remote);
		return {
			...observed,
			observedShape: {
				...(connection.lease.observedShape ?? {}),
				...(ref.evidenceSecretsUnavailable
					? { evidenceSync: "blocked_secret_unavailable" }
					: {}),
			},
		};
	}

	async control(
		ref: ExecutionTargetRef,
		command: ExecutionControl,
	): Promise<void> {
		const leaseRef = this.requireLease(ref.globalLeaseRef);
		const { transport } = await this.readyTransport(leaseRef);
		const remote = paths(leaseRef, this.remoteRoot);
		const encoded = Buffer.from(JSON.stringify(command)).toString("base64");
		await transport.run([
			"bun",
			"run",
			remote.runtime,
			"control",
			remote.runDir,
			encoded,
		]);
		if (!ref.evidenceSecretsUnavailable) {
			await this.syncArtifacts(
				transport,
				remote,
				ref.runDir,
				ref.secretEnvironment,
			);
		}
	}

	async collect(ref: ExecutionTargetRef): Promise<CollectExecutionResult> {
		const leaseRef = this.requireLease(ref.globalLeaseRef);
		if (!ref.workspace)
			throw new Error("RunPod collection has no canonical workspace");
		if (ref.evidenceSecretsUnavailable) {
			throw new RemoteEvidenceSecretsUnavailableError();
		}
		await this.options.account.command(
			leaseRef,
			`${ref.owner.ownerKey}/phase/collecting`,
			{ type: "phase", phase: "collecting" },
		);
		const { connection, transport } = await this.readyTransport(leaseRef);
		const remote = paths(leaseRef, this.remoteRoot);
		await this.syncArtifacts(
			transport,
			remote,
			ref.runDir,
			ref.secretEnvironment,
		);
		const result = await transport.run(
			[
				"bun",
				"run",
				remote.runtime,
				"collect",
				remote.worktree,
				remote.runDir,
				remote.stage,
			],
			{ timeoutMs: 10 * 60_000 },
		);
		const manifest = JSON.parse(result.stdout) as {
			collectionPath: string;
			digest: string;
		};
		if (!/^[a-f0-9]{64}$/.test(manifest.digest)) {
			throw new Error("remote collection returned an invalid digest");
		}
		const bytes = await transport.download(manifest.collectionPath);
		if (bytes.byteLength > this.maxTransferBytes) {
			throw new Error(
				"remote collection exceeds the configured transfer bound",
			);
		}
		assertCollectionHasNoSecrets(
			bytes,
			ref.secretEnvironment ?? new SecretEnvironment({}),
		);
		const collectionPath = join(
			ref.runDir,
			"remote-worktree",
			"collections",
			`${manifest.digest}.json`,
		);
		await mkdir(join(ref.runDir, "remote-worktree", "collections"), {
			recursive: true,
			mode: 0o700,
		});
		await writeFileAtomic(collectionPath, bytes, { mode: 0o600 });
		await applyRemoteCollection({
			canonicalPath: ref.workspace.canonicalPath,
			runDir: ref.runDir,
			stagePath: join(ref.runDir, "remote-worktree", "stage.json"),
			collectionPath,
			maxTransferBytes: this.maxTransferBytes,
		});
		return { observedShape: connection.lease.observedShape };
	}

	async dispose(ref: ExecutionTargetRef): Promise<DisposeExecutionResult> {
		const leaseRef = this.requireLease(ref.globalLeaseRef);
		const lease = await this.options.account.command(
			leaseRef,
			`${ref.owner.ownerKey}/dispose`,
			{ type: "dispose", reason: "run_finalization" },
		);
		return {
			absenceConfirmed: lease.observedShape?.phase === "absent",
			observedShape: lease.observedShape,
		};
	}

	async inventory(
		refs: readonly ExecutionTargetRef[],
	): Promise<readonly ExecutionInventoryItem[]> {
		const leases = await this.options.account.inventory(this.kind);
		return Promise.all(
			refs.map(async (ref) => {
				const lease = leases.find((item) => item.ref === ref.globalLeaseRef);
				return {
					ownerKey: ref.owner.ownerKey,
					globalLeaseRef: ref.globalLeaseRef,
					observation: lease
						? await this.observe(ref)
						: { state: "absent" as const },
				};
			}),
		);
	}

	async reconcile(
		refs: readonly ExecutionTargetRef[],
	): Promise<ExecutionReconcileReport> {
		await this.options.account.reconcile(this.kind, "execution-target");
		const observations: ExecutionInventoryItem[] = [];
		const errors: { ownerKey: string; code: string }[] = [];
		for (const ref of refs) {
			try {
				observations.push({
					ownerKey: ref.owner.ownerKey,
					globalLeaseRef: ref.globalLeaseRef,
					observation: await this.observe(ref),
				});
			} catch (error) {
				errors.push({ ownerKey: ref.owner.ownerKey, code: errorCode(error) });
			}
		}
		return { observations, errors };
	}

	private get maxTransferBytes(): number {
		return this.options.maxTransferBytes ?? DEFAULT_TRANSFER_BYTES;
	}

	private requireLease(ref: string | null): string {
		if (!ref) throw new Error("RunPod target has no durable global lease link");
		return ref;
	}

	private transport(
		connection: RunPodLeaseConnection,
	): RunPodExecutionTransport {
		return this.options.transport
			? this.options.transport(connection)
			: new RunPodSshTransport({
					endpoint: connection.endpoint,
					commandTimeoutMs: 10 * 60_000,
					maxOutputBytes: Math.ceil(this.maxTransferBytes * 1.5),
					isPodPresent: (podId) => this.options.account.podPresent(podId),
				});
	}

	private async readyTransport(ref: string): Promise<{
		connection: RunPodLeaseConnection;
		transport: RunPodExecutionTransport;
	}> {
		const deadline =
			Date.now() + (this.options.readinessMs ?? DEFAULT_READINESS_MS);
		for (;;) {
			const connection = await this.options.account.connection(ref);
			if (connection) {
				const transport = this.transport(connection);
				await transport.waitUntilReady(deadline);
				if (connection.lease.requestedShape.image === MFW_RUNPOD_CPU_IMAGE) {
					await transport.run(mfwRunPodCpuBootstrapCommand(), {
						timeoutMs: Math.max(1, deadline - Date.now()),
					});
					await transport.run(["test", "-f", MFW_RUNPOD_CPU_READY_PATH], {
						timeoutMs: Math.max(1, deadline - Date.now()),
					});
				}
				return { connection, transport };
			}
			const lease = await this.options.account.observe(ref);
			if (lease?.observedShape?.phase === "absent") {
				throw new RemoteTransportError(
					"pod_absent",
					"RunPod Pod became absent before remote transport was ready",
				);
			}
			if (Date.now() >= deadline)
				throw new Error("RunPod readiness deadline elapsed");
			await Bun.sleep(Math.min(1_000, deadline - Date.now()));
		}
	}

	private async remoteObservation(
		transport: RunPodExecutionTransport,
		remote: RemotePaths,
	): Promise<ExecutionObservation> {
		const result = await transport.run([
			"bun",
			"run",
			remote.runtime,
			"observe",
			remote.runDir,
		]);
		const value = JSON.parse(result.stdout) as {
			state?: string;
			exit?: string;
		};
		if (value.state === "running") return { state: "running" };
		if (value.state === "exited") {
			const exit = /^exit:(\d+)$/.exec(value.exit ?? "");
			const killed = /^killed:(.+)$/.exec(value.exit ?? "");
			return {
				state: "exited",
				...(exit ? { exitCode: Number(exit[1]) } : {}),
				...(killed ? { killReason: killed[1] } : {}),
			};
		}
		return { state: "unknown" };
	}

	private async syncArtifacts(
		transport: RunPodExecutionTransport,
		remote: RemotePaths,
		localRunDir: string,
		secrets: SecretEnvironment | undefined,
	): Promise<void> {
		for (const name of ["events.jsonl", "raw.log", "exit"] as const) {
			let bytes: Uint8Array;
			try {
				bytes = await transport.download(`${remote.runDir}/${name}`);
			} catch (error) {
				if (
					error instanceof RemoteTransportError &&
					error.failure === "remote_exit"
				)
					continue;
				throw error;
			}
			if (bytes.byteLength > this.maxTransferBytes) {
				throw new Error(`remote ${name} exceeds the configured transfer bound`);
			}
			const safeBytes =
				!secrets || secrets.isEmpty()
					? bytes
					: new TextEncoder().encode(
							redactSecretValues(new TextDecoder().decode(bytes), secrets),
						);
			await writeFileAtomic(join(localRunDir, name), safeBytes, {
				mode: 0o600,
			});
		}
	}
}

export function createRunPodExecutionTarget(
	options: RunPodExecutionTargetOptions,
): RunPodExecutionTarget {
	return new RunPodExecutionTarget(options);
}
