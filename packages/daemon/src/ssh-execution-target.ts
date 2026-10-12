import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { writeFileAtomic } from "@mfw/core/fsatomic";
import { SecretEnvironment } from "./execution-environment.ts";
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
	type HostConfig,
	type HostObservation,
	hostCandidate,
	type RegisteredHost,
} from "./host-registry.ts";
import {
	assertCollectionHasNoSecrets,
	assertPublicEnvironmentHasNoCredentials,
	bundledRemoteRuntime,
	bundleRemoteSupport,
	RemoteEvidenceSecretsUnavailableError,
	remoteErrorCode,
	syncRemoteArtifacts,
} from "./remote-execution-support.ts";
import { applyRemoteCollection, createRemoteStage } from "./remote-worktree.ts";
import { RemoteTransportError, type SshTransport } from "./ssh-transport.ts";
import { type Worktree, WorktreeManager } from "./worktree.ts";

/**
 * Execution on a registry SSH host (`execution_target: ssh`). Same lifecycle
 * and remote runtime as RunPod, minus the provider account: the box exists,
 * so `prepare` only creates the canonical local worktree and names the run's
 * directory on the box; `launch` ships a stage bundle (never the repo's
 * remotes or credentials), the runtime and the driver, then starts the
 * detached driver; `collect` brings changes back by 3-way apply; `dispose`
 * deletes the run directory and proves it gone.
 *
 * Trust enforcement at launch (see backstage architecture.md, "Security model", "SSH hosts"):
 *   - the host must be schedulable now (fresh passing probe: no root, no
 *     passwordless sudo, bwrap where required);
 *   - `sandbox: bwrap` hosts run the driver in bwrap: filesystem read-only
 *     except $HOME and /tmp, `~/.ssh` and every other run's directory masked,
 *     this run's worktree and run dir bound writable;
 *   - a `shared` host receives only the workload secrets it lists in
 *     `secrets`; any other granted secret refuses the launch;
 *   - no push credential, agent socket or $MFW_HOME ever crosses: the public
 *     environment is checked, and secrets travel on SSH stdin only.
 */

const DEFAULT_TRANSFER_BYTES = 64 * 1024 * 1024;
const REF = /^ssh\.([a-z0-9][a-z0-9_-]{0,62})\.([a-f0-9]{32})$/;

export type SshExecutionTransport = Pick<
	SshTransport,
	"run" | "runWithSecrets" | "upload" | "download"
>;

export interface SshHostSource {
	require(id: string): Promise<RegisteredHost>;
	list(): Promise<RegisteredHost[]>;
}

export interface SshExecutionTargetOptions {
	hosts: SshHostSource;
	projectRoot: string;
	integrationBranch: string;
	worktrees?: {
		create(runId: string, base?: string): Promise<Worktree>;
		remove(worktree: Worktree): Promise<void>;
	};
	/** Defaults to the strict, registry-pinned SshTransport. */
	transport: (
		host: RegisteredHost,
		pinned: readonly HostConfig[],
	) => SshExecutionTransport;
	maxTransferBytes?: number;
	now?: () => number;
}

export class SharedHostSecretError extends Error {
	constructor(hostId: string, names: readonly string[]) {
		super(
			`SSH host '${hostId}' is shared and is not allowed to receive ${names.join(", ")}: add the names to the host's secrets, or run the task elsewhere`,
		);
		this.name = "SharedHostSecretError";
	}
}

export class SshHostUnavailableError extends Error {
	constructor(hostId: string, reason: string) {
		super(`SSH host '${hostId}' ${reason}`);
		this.name = "SshHostUnavailableError";
	}
}

interface RemotePaths {
	root: string;
	worktree: string;
	runDir: string;
	support: string;
	stage: string;
	runtime: string;
	driver: string;
	bridge: string;
	config: string;
}

function pathsAt(root: string): RemotePaths {
	return {
		root,
		worktree: `${root}/worktree`,
		runDir: `${root}/run`,
		support: `${root}/support`,
		stage: `${root}/support/stage.json`,
		runtime: `${root}/support/runtime.js`,
		driver: `${root}/support/driver.js`,
		bridge: `${root}/support/bridge.js`,
		config: `${root}/support/runtime-config.json`,
	};
}

function parseRef(ref: string | null): { hostId: string; hex: string } {
	const match = ref ? REF.exec(ref) : null;
	if (!match) throw new Error("SSH target has no valid run reference");
	return { hostId: match[1] as string, hex: match[2] as string };
}

export function sshRunRef(hostId: string, ownerKey: string): string {
	const hex = createHash("sha256").update(ownerKey).digest("hex").slice(0, 32);
	return `ssh.${hostId}.${hex}`;
}

/** Where run directories live on the box. */
export function hostWorkdir(
	config: Pick<HostConfig, "workdir">,
	observed: Pick<HostObservation, "home"> | null,
): string {
	if (config.workdir) return config.workdir;
	if (!observed?.home) throw new Error("SSH host has no probed home directory");
	return `${observed.home}/.mfw-runs`;
}

/**
 * The bwrap prefix for a run's driver on the box: host filesystem read-only,
 * `$HOME` and `/tmp` writable (harness state and auth live in `$HOME`),
 * `~/.ssh` masked so the agent cannot touch authorized_keys, every other
 * run's directory masked, this run's support read-only and its worktree and
 * run dir writable. Network stays shared (documented).
 */
export function remoteBwrapArgv(input: {
	bwrapPath: string;
	home: string;
	workdir: string;
	paths: Pick<RemotePaths, "support" | "worktree" | "runDir">;
}): string[] {
	for (const path of [input.bwrapPath, input.home, input.workdir]) {
		if (!isAbsolute(path)) throw new Error("sandbox paths must be absolute");
	}
	return [
		input.bwrapPath,
		"--die-with-parent",
		"--ro-bind",
		"/",
		"/",
		"--dev",
		"/dev",
		"--proc",
		"/proc",
		"--bind",
		input.home,
		input.home,
		"--bind",
		"/tmp",
		"/tmp",
		"--tmpfs",
		`${input.home}/.ssh`,
		"--tmpfs",
		input.workdir,
		"--ro-bind",
		input.paths.support,
		input.paths.support,
		"--bind",
		input.paths.worktree,
		input.paths.worktree,
		"--bind",
		input.paths.runDir,
		input.paths.runDir,
		"--",
	];
}

export class SshExecutionTarget implements ExecutionTarget {
	readonly kind = "ssh";
	private readonly worktrees: NonNullable<
		SshExecutionTargetOptions["worktrees"]
	>;

	constructor(private readonly options: SshExecutionTargetOptions) {
		this.worktrees =
			options.worktrees ?? new WorktreeManager(options.projectRoot);
	}

	private get maxTransferBytes(): number {
		return this.options.maxTransferBytes ?? DEFAULT_TRANSFER_BYTES;
	}

	private now(): number {
		return (this.options.now ?? Date.now)();
	}

	private async connect(hostId: string): Promise<{
		host: RegisteredHost;
		transport: SshExecutionTransport;
	}> {
		const host = await this.options.hosts.require(hostId);
		const pinned = (await this.options.hosts.list()).map((h) => h.config);
		return { host, transport: this.options.transport(host, pinned) };
	}

	private remote(
		ref: { workspace: { executionPath: string } | null },
		host: RegisteredHost,
		hex: string,
	): RemotePaths {
		const execution = ref.workspace?.executionPath;
		return pathsAt(
			execution?.endsWith("/worktree")
				? dirname(execution)
				: `${hostWorkdir(host.config, host.observed)}/${hex}`,
		);
	}

	async prepare(request: PrepareExecutionRequest): Promise<PreparedExecution> {
		const hostId = request.requestedShape.hostId;
		if (typeof hostId !== "string")
			throw new Error("execution_target ssh needs a placed host");
		const host = await this.options.hosts.require(hostId);
		const ref = sshRunRef(hostId, request.owner.ownerKey);
		const { hex } = parseRef(ref);
		const root = `${hostWorkdir(host.config, host.observed)}/${hex}`;
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
		if (!worktree.baseSha) {
			if (!request.reuse) await this.worktrees.remove(worktree);
			throw new Error("remote canonical worktree has no base SHA");
		}
		return {
			targetKind: this.kind,
			workspace: {
				canonicalPath: worktree.path,
				executionPath: pathsAt(root).worktree,
				branch: worktree.branch,
				baseSha: worktree.baseSha,
			},
			globalLeaseRef: ref,
			observedShape: { hostId, phase: "prepared" },
		};
	}

	async rollbackPreparation(
		request: PrepareExecutionRequest,
		prepared: PreparedExecution,
	): Promise<void> {
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
		const { hostId, hex } = parseRef(request.globalLeaseRef);
		const { host, transport } = await this.connect(hostId);
		const candidate = hostCandidate(host, this.now());
		if (!candidate.schedulable)
			throw new SshHostUnavailableError(
				hostId,
				candidate.reason ?? "is not schedulable",
			);
		const observed = host.observed as HostObservation;
		const secrets =
			request.driver.secretEnvironment ?? new SecretEnvironment({});
		if (host.config.trust === "shared") {
			const refused = secrets
				.names()
				.filter((name) => !host.config.secrets.includes(name));
			if (refused.length > 0) throw new SharedHostSecretError(hostId, refused);
		}
		if (host.config.sandbox === "bwrap" && !observed.bwrapPath)
			throw new SshHostUnavailableError(hostId, "has no usable bwrap");
		const bunPath = observed.bunPath as string;
		const remote = this.remote(request, host, hex);

		// A retry after a detached launch must observe, never launch a second driver.
		const prior = await this.remoteObservation(
			transport,
			remote,
			bunPath,
		).catch((error) => {
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
		});
		if (prior?.state === "running" || prior?.state === "exited") return;

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
				bundledRemoteRuntime(),
				bundleRemoteSupport(request.driver.driverScript),
				bridgeLocal ? bundleRemoteSupport(bridgeLocal) : Promise.resolve(null),
			]);
		await transport.upload(remote.stage, stageBytes);
		await transport.upload(remote.runtime, runtimeBytes);
		await transport.upload(remote.driver, driverBytes);
		if (bridgeBytes) await transport.upload(remote.bridge, bridgeBytes);
		await transport.run(
			[
				bunPath,
				"run",
				remote.runtime,
				"stage",
				remote.stage,
				remote.worktree,
				observed.gitPath as string,
			],
			{ timeoutMs: 10 * 60_000 },
		);
		await transport.run(["mkdir", "-p", "-m", "700", "--", remote.runDir]);

		const bridgeArgv = request.driver.bridgeArgv?.map((value) =>
			value === bridgeLocal ? remote.bridge : value,
		);
		const home = observed.home as string;
		const publicEnvironment = {
			...request.driver.env,
			// The harness logs in once on the box as this user: its auth is in $HOME.
			HOME: home,
			PATH: observed.path ?? `${dirname(bunPath)}:/usr/local/bin:/usr/bin:/bin`,
			MFW_REPORT_PATH: `${remote.worktree}/MFW_REPORT.json`,
		};
		const config = {
			runDir: remote.runDir,
			executionPath: remote.worktree,
			driverScript: remote.driver,
			secretNames: secrets.names(),
			bunPath,
			...(host.config.sandbox === "bwrap"
				? {
						sandboxArgv: remoteBwrapArgv({
							bwrapPath: observed.bwrapPath as string,
							home,
							workdir: dirname(remote.root),
							paths: remote,
						}),
					}
				: {}),
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
		try {
			await transport.runWithSecrets(
				[
					observed.setsidPath as string,
					"-f",
					bunPath,
					"run",
					remote.runtime,
					"run",
					remote.config,
				],
				publicEnvironment,
				secrets,
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
		const { hostId, hex } = parseRef(ref.globalLeaseRef);
		const { host, transport } = await this.connect(hostId);
		const bunPath = this.bun(host);
		const remote = this.remote(ref, host, hex);
		if (!ref.evidenceSecretsUnavailable) {
			await syncRemoteArtifacts(
				transport,
				remote.runDir,
				ref.runDir,
				ref.secretEnvironment,
				this.maxTransferBytes,
			);
		}
		const observed = await this.remoteObservation(transport, remote, bunPath);
		return {
			...observed,
			observedShape: {
				hostId,
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
		const { hostId, hex } = parseRef(ref.globalLeaseRef);
		const { host, transport } = await this.connect(hostId);
		const remote = this.remote(ref, host, hex);
		const encoded = Buffer.from(JSON.stringify(command)).toString("base64");
		await transport.run([
			this.bun(host),
			"run",
			remote.runtime,
			"control",
			remote.runDir,
			encoded,
		]);
		if (!ref.evidenceSecretsUnavailable) {
			await syncRemoteArtifacts(
				transport,
				remote.runDir,
				ref.runDir,
				ref.secretEnvironment,
				this.maxTransferBytes,
			);
		}
	}

	async collect(ref: ExecutionTargetRef): Promise<CollectExecutionResult> {
		const { hostId, hex } = parseRef(ref.globalLeaseRef);
		if (!ref.workspace)
			throw new Error("SSH collection has no canonical workspace");
		if (ref.evidenceSecretsUnavailable) {
			throw new RemoteEvidenceSecretsUnavailableError();
		}
		const { host, transport } = await this.connect(hostId);
		const remote = this.remote(ref, host, hex);
		await syncRemoteArtifacts(
			transport,
			remote.runDir,
			ref.runDir,
			ref.secretEnvironment,
			this.maxTransferBytes,
		);
		const result = await transport.run(
			[
				this.bun(host),
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
		const collections = join(ref.runDir, "remote-worktree", "collections");
		await mkdir(collections, { recursive: true, mode: 0o700 });
		const collectionPath = join(collections, `${manifest.digest}.json`);
		await writeFileAtomic(collectionPath, bytes, { mode: 0o600 });
		await applyRemoteCollection({
			canonicalPath: ref.workspace.canonicalPath,
			runDir: ref.runDir,
			stagePath: join(ref.runDir, "remote-worktree", "stage.json"),
			collectionPath,
			maxTransferBytes: this.maxTransferBytes,
		});
		return { observedShape: { hostId, phase: "collected" } };
	}

	/** Delete the run directory on the box and prove it is gone. */
	async dispose(ref: ExecutionTargetRef): Promise<DisposeExecutionResult> {
		const { hostId, hex } = parseRef(ref.globalLeaseRef);
		const { host, transport } = await this.connect(hostId);
		const remote = this.remote(ref, host, hex);
		await transport.run(["rm", "-rf", "--", remote.root]);
		await transport.run(["test", "!", "-e", remote.root]);
		return {
			absenceConfirmed: true,
			observedShape: { hostId, phase: "absent" },
		};
	}

	async inventory(
		refs: readonly ExecutionTargetRef[],
	): Promise<readonly ExecutionInventoryItem[]> {
		return Promise.all(
			refs.map(async (ref) => ({
				ownerKey: ref.owner.ownerKey,
				globalLeaseRef: ref.globalLeaseRef,
				observation: await this.observe(ref).catch(
					(): ExecutionObservation => ({ state: "unknown" }),
				),
			})),
		);
	}

	async reconcile(
		refs: readonly ExecutionTargetRef[],
	): Promise<ExecutionReconcileReport> {
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
				errors.push({
					ownerKey: ref.owner.ownerKey,
					code: remoteErrorCode(error),
				});
			}
		}
		return { observations, errors };
	}

	private bun(host: RegisteredHost): string {
		const bun = host.observed?.bunPath;
		if (!bun)
			throw new SshHostUnavailableError(
				host.config.id,
				"has no probed bun (probe it again)",
			);
		return bun;
	}

	private async remoteObservation(
		transport: SshExecutionTransport,
		remote: RemotePaths,
		bunPath: string,
	): Promise<ExecutionObservation> {
		const result = await transport.run([
			bunPath,
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
}
