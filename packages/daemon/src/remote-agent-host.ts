import { chmod, lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { writeFileAtomic } from "@mfw/core/fsatomic";
import {
	assertDisjointEnvironmentNames,
	ExecutionEnvironmentBuilder,
	redactSecretValues,
	type SecretEnvironment,
} from "./execution-environment.ts";
import { type ProcOpts, type ProcResult, runProc } from "./proc.ts";

/** A provider-observed direct endpoint, plus legacy basic-proxy leases. */
export interface RunPodSshEndpoint {
	mode: "runpod-basic" | "runpod-direct";
	podId: string;
	/** `root` for direct SSH; the stored proxy principal for a legacy lease. */
	principal: string;
	host: string;
	port?: number;
	privateKeyPath: string;
	/** Complete OpenSSH public host-key line, e.g. `ssh-ed25519 AAAA…`. */
	hostPublicKey: string;
}

export async function scanRunPodDirectSshHostKey(input: {
	host: string;
	port: number;
	runner?: SshProcessRunner;
	keyscanPath?: string;
}): Promise<string> {
	if (
		isIP(input.host) === 0 ||
		!Number.isInteger(input.port) ||
		input.port < 1 ||
		input.port > 65_535
	) {
		throw new RemoteTransportError(
			"identity_mismatch",
			"RunPod direct SSH endpoint is invalid",
		);
	}
	const keyscanPath =
		input.keyscanPath ?? Bun.which("ssh-keyscan") ?? "/usr/bin/ssh-keyscan";
	if (!isAbsolute(keyscanPath)) {
		throw new RemoteTransportError(
			"identity_mismatch",
			"SSH host-key scanner path must be absolute",
		);
	}
	const result = await (input.runner ?? runProc)(
		[keyscanPath, "-T", "5", "-p", String(input.port), input.host],
		{
			env: new ExecutionEnvironmentBuilder().build(),
			timeoutMs: 10_000,
			maxOutputBytes: 32 * 1024,
		},
	);
	if (result.exitCode !== 0 || result.timedOut) {
		throw new RemoteTransportError(
			"network_lost",
			"Could not read the RunPod SSH host key",
		);
	}
	for (const line of result.stdout.split("\n")) {
		const parts = line.trim().split(/\s+/);
		if (parts.length >= 3) {
			const key = `${parts[1]} ${parts[2]}`;
			if (HOST_KEY.test(key)) return key;
		}
	}
	throw new RemoteTransportError(
		"identity_mismatch",
		"RunPod SSH endpoint returned no supported host key",
	);
}

export interface RemoteCommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	truncated: boolean;
}

export type RemoteTransportFailure =
	| "identity_mismatch"
	| "pod_absent"
	| "network_lost"
	| "deadline_exceeded"
	| "remote_exit";

export class RemoteTransportError extends Error {
	constructor(
		readonly failure: RemoteTransportFailure,
		message: string,
		readonly remoteExitCode?: number,
	) {
		super(message);
		this.name = "RemoteTransportError";
	}
}

export type SshProcessRunner = (
	argv: string[],
	opts: ProcOpts,
) => Promise<ProcResult>;

export interface RunPodSshTransportOptions {
	endpoint: RunPodSshEndpoint;
	/** Hard wall-clock bound for an individual command. */
	commandTimeoutMs?: number;
	/** OpenSSH TCP establishment timeout, independently capped by command time. */
	connectTimeoutMs?: number;
	maxOutputBytes?: number;
	/** Fresh provider inventory check used to distinguish loss from absence. */
	isPodPresent?: (podId: string) => Promise<boolean>;
	runner?: SshProcessRunner;
	/** Outside every worktree. Tests can inject an isolated carrier parent. */
	carrierRoot?: string;
}

export interface GenerateRunPodSshKeyOptions {
	/** Stable account-owned lease identity; it deliberately exists before a Pod id. */
	identifier: string;
	/** Account-service-owned directory outside project worktrees. */
	directory: string;
	/** Explicit image/host tool path; defaults to conventional Linux. */
	keygenPath?: string;
	runner?: SshProcessRunner;
}

export interface EphemeralRunPodSshKey {
	privateKeyPath: string;
	publicKey: string;
	dispose(): Promise<void>;
}

const POD_ID = /^[A-Za-z0-9_-]{1,128}$/;
const BOOTSTRAP_ID = /^[A-Za-z0-9_-]{1,96}$/;
const PRINCIPAL = /^[A-Za-z0-9_-]+$/;
const HOST_KEY =
	/^(?:ssh-ed25519|ecdsa-sha2-nistp(?:256|384|521)|ssh-rsa) [A-Za-z0-9+/=]+$/;
const SECRET_HANDOFF_SENTINEL = "MFW_REMOTE_SECRET_HANDOFF_COMPLETE";

function bootstrapPaths(opts: GenerateRunPodSshKeyOptions): {
	privateKeyPath: string;
	publicKeyPath: string;
} {
	if (!BOOTSTRAP_ID.test(opts.identifier) || !isAbsolute(opts.directory)) {
		throw new RemoteTransportError(
			"identity_mismatch",
			"ephemeral SSH key requires a valid lease bootstrap identity and absolute machine path",
		);
	}
	const privateKeyPath = join(
		opts.directory,
		`lease-${opts.identifier}-ed25519`,
	);
	return { privateKeyPath, publicKeyPath: `${privateKeyPath}.pub` };
}

async function validateBootstrapDirectory(directory: string): Promise<void> {
	const info = await lstat(directory).catch(() => null);
	if (
		!info?.isDirectory() ||
		info.isSymbolicLink() ||
		(info.mode & 0o777) !== 0o700
	) {
		throw new RemoteTransportError(
			"identity_mismatch",
			"SSH bootstrap directory must be a real 0700 directory",
		);
	}
}

async function validateBootstrapFile(
	path: string,
	allowedMode: (mode: number) => boolean,
	label: string,
): Promise<void> {
	const info = await lstat(path).catch(() => null);
	if (
		!info?.isFile() ||
		info.isSymbolicLink() ||
		!allowedMode(info.mode & 0o777)
	) {
		throw new RemoteTransportError(
			"identity_mismatch",
			`SSH ${label} must be a permission-safe regular file`,
		);
	}
}

/** Generate one key for one lease bootstrap; provider registration is account-service work. */
export async function generateEphemeralRunPodSshKey(
	opts: GenerateRunPodSshKeyOptions,
): Promise<EphemeralRunPodSshKey> {
	const { privateKeyPath, publicKeyPath } = bootstrapPaths(opts);
	const keygenPath = opts.keygenPath ?? "/usr/bin/ssh-keygen";
	if (!isAbsolute(keygenPath)) {
		throw new RemoteTransportError(
			"identity_mismatch",
			"SSH key generator path must be absolute",
		);
	}
	await mkdir(opts.directory, { recursive: true, mode: 0o700 });
	await validateBootstrapDirectory(opts.directory);
	if (
		(await lstat(privateKeyPath).catch(() => null)) ||
		(await lstat(publicKeyPath).catch(() => null))
	) {
		throw new RemoteTransportError(
			"identity_mismatch",
			"SSH bootstrap evidence already exists",
		);
	}
	const runner = opts.runner ?? runProc;
	try {
		const result = await runner(
			[
				keygenPath,
				"-q",
				"-t",
				"ed25519",
				"-N",
				"",
				"-C",
				`mfw:${opts.identifier}`,
				"-f",
				privateKeyPath,
			],
			{
				env: new ExecutionEnvironmentBuilder().build(),
				timeoutMs: 15_000,
				maxOutputBytes: 16 * 1024,
			},
		);
		if (result.exitCode !== 0 || result.timedOut) {
			throw new RemoteTransportError(
				"identity_mismatch",
				"could not generate ephemeral SSH identity",
			);
		}
		await chmod(privateKeyPath, 0o600);
		await chmod(publicKeyPath, 0o600);
		return loadEphemeralRunPodSshKey(opts);
	} catch (error) {
		await Promise.all([
			rm(privateKeyPath, { force: true }),
			rm(publicKeyPath, { force: true }),
		]);
		if (error instanceof RemoteTransportError) throw error;
		throw new RemoteTransportError(
			"identity_mismatch",
			"could not generate ephemeral SSH identity",
		);
	}
}

/** Post-submission/restart path: validate only. Never repairs or replaces evidence. */
export async function loadEphemeralRunPodSshKey(
	opts: GenerateRunPodSshKeyOptions,
): Promise<EphemeralRunPodSshKey> {
	const { privateKeyPath, publicKeyPath } = bootstrapPaths(opts);
	const keygenPath = opts.keygenPath ?? "/usr/bin/ssh-keygen";
	if (!isAbsolute(keygenPath)) {
		throw new RemoteTransportError(
			"identity_mismatch",
			"SSH key generator path must be absolute",
		);
	}
	await validateBootstrapDirectory(opts.directory);
	await validateBootstrapFile(
		privateKeyPath,
		(mode) => mode === 0o600,
		"private key",
	);
	await validateBootstrapFile(
		publicKeyPath,
		(mode) => (mode & 0o022) === 0,
		"public key",
	);
	const publicKey = (await readFile(publicKeyPath, "utf8")).trim();
	const parsed = /^(ssh-ed25519) ([A-Za-z0-9+/=]+)(?: |$)/.exec(publicKey);
	if (!parsed) {
		throw new RemoteTransportError(
			"identity_mismatch",
			"persisted SSH public key is invalid",
		);
	}
	const runner = opts.runner ?? runProc;
	const derived = await runner([keygenPath, "-y", "-f", privateKeyPath], {
		env: new ExecutionEnvironmentBuilder().build(),
		timeoutMs: 15_000,
		maxOutputBytes: 16 * 1024,
	});
	const derivedParts = /^(ssh-ed25519) ([A-Za-z0-9+/=]+)(?: |$)/.exec(
		derived.stdout.trim(),
	);
	if (
		derived.exitCode !== 0 ||
		derived.timedOut ||
		!derivedParts ||
		derivedParts[1] !== parsed[1] ||
		derivedParts[2] !== parsed[2]
	) {
		throw new RemoteTransportError(
			"identity_mismatch",
			"persisted SSH public key does not match its private key",
		);
	}
	return {
		privateKeyPath,
		publicKey,
		async dispose() {
			await Promise.all([
				rm(privateKeyPath, { force: true }),
				rm(publicKeyPath, { force: true }),
			]);
		},
	};
}

function q(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** ssh concatenates remote command arguments; quote each one as POSIX data. */
export function encodeRemoteArgv(argv: readonly string[]): string {
	if (argv.length === 0) throw new Error("remote command argv is empty");
	for (const value of argv) {
		if (value.includes("\0")) throw new Error("remote command contains NUL");
	}
	return argv.map(q).join(" ");
}

function validateEndpoint(endpoint: RunPodSshEndpoint): void {
	if (
		(endpoint.mode === "runpod-basic" && endpoint.host !== "ssh.runpod.io") ||
		(endpoint.mode === "runpod-direct" &&
			(isIP(endpoint.host) === 0 ||
				!Number.isInteger(endpoint.port) ||
				(endpoint.port ?? 0) < 1 ||
				(endpoint.port ?? 0) > 65_535))
	) {
		throw new RemoteTransportError(
			"identity_mismatch",
			"SSH endpoint is not a valid RunPod endpoint",
		);
	}
	if (!POD_ID.test(endpoint.podId) || !PRINCIPAL.test(endpoint.principal)) {
		throw new RemoteTransportError(
			"identity_mismatch",
			"RunPod SSH endpoint contains an invalid Pod identity",
		);
	}
	if (
		(endpoint.mode === "runpod-basic" &&
			!endpoint.principal.startsWith(`${endpoint.podId}-`)) ||
		(endpoint.mode === "runpod-direct" && endpoint.principal !== "root")
	) {
		throw new RemoteTransportError(
			"identity_mismatch",
			"RunPod SSH principal does not belong to the expected Pod",
		);
	}
	if (endpoint.principal.length === endpoint.podId.length + 1) {
		throw new RemoteTransportError(
			"identity_mismatch",
			"RunPod SSH principal is missing its provider connection identity",
		);
	}
	if (!isAbsolute(endpoint.privateKeyPath)) {
		throw new RemoteTransportError(
			"identity_mismatch",
			"SSH private key path must be absolute",
		);
	}
	if (!HOST_KEY.test(endpoint.hostPublicKey.trim())) {
		throw new RemoteTransportError(
			"identity_mismatch",
			"RunPod SSH host key is invalid",
		);
	}
}

async function validatePrivateKey(path: string): Promise<void> {
	await validateBootstrapFile(path, (mode) => mode === 0o600, "private key");
}

const SECRET_LAUNCH_SCRIPT = [
	"set -eu",
	`unset ${SECRET_HANDOFF_SENTINEL}`,
	"set -a",
	". /dev/stdin || exit 78",
	"set +a",
	`[ "\${${SECRET_HANDOFF_SENTINEL}:-}" = 1 ] || exit 78`,
	`unset ${SECRET_HANDOFF_SENTINEL}`,
	'exec "$@"',
].join("; ");

function secretCarrierContents(secrets: SecretEnvironment): string {
	return `${Object.entries(secrets.materializeForLaunch())
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([name, value]) => `${name}=${q(value)}`)
		.join("\n")}\n${SECRET_HANDOFF_SENTINEL}=1\n`;
}

/** Strict, host-pinned, deadline-bounded OpenSSH transport. */
export class RunPodSshTransport {
	private readonly endpoint: RunPodSshEndpoint;
	private readonly commandTimeoutMs: number;
	private readonly connectTimeoutMs: number;
	private readonly maxOutputBytes: number;
	private readonly runner: SshProcessRunner;

	constructor(private readonly options: RunPodSshTransportOptions) {
		validateEndpoint(options.endpoint);
		this.endpoint = options.endpoint;
		this.commandTimeoutMs = options.commandTimeoutMs ?? 60_000;
		this.connectTimeoutMs = Math.min(
			options.connectTimeoutMs ?? 15_000,
			this.commandTimeoutMs,
		);
		this.maxOutputBytes = options.maxOutputBytes ?? 4 * 1024 * 1024;
		this.runner = options.runner ?? runProc;
		for (const value of [this.commandTimeoutMs, this.connectTimeoutMs]) {
			if (!Number.isFinite(value) || value <= 0) {
				throw new RangeError("SSH deadlines must be positive and finite");
			}
		}
	}

	async run(
		command: readonly string[],
		opts: { input?: string; timeoutMs?: number; signal?: AbortSignal } = {},
	): Promise<RemoteCommandResult> {
		return this.runInternal(command, opts);
	}

	/** Run configured setup from the same empty-ambient builder as launch. */
	async runWithEnvironment(
		command: readonly string[],
		environment: Readonly<Record<string, string>> = {},
		opts: { input?: string; timeoutMs?: number; signal?: AbortSignal } = {},
	): Promise<RemoteCommandResult> {
		const materialized = new ExecutionEnvironmentBuilder(environment).build();
		return this.runInternal(
			[
				"env",
				"-i",
				...Object.entries(materialized).map(
					([name, value]) => `${name}=${value}`,
				),
				...command,
			],
			opts,
		);
	}

	/** Stream a non-secret artifact over basic SSH (which intentionally has no SCP). */
	async upload(
		remotePath: string,
		bytes: Uint8Array,
		opts: { timeoutMs?: number; signal?: AbortSignal } = {},
	): Promise<void> {
		if (!remotePath.startsWith("/") || remotePath.includes("\0")) {
			throw new Error("remote upload path must be absolute");
		}
		const input = Buffer.from(bytes).toString("base64");
		await this.run(
			[
				"/bin/sh",
				"-c",
				'umask 077; mkdir -p "$(dirname -- "$1")"; base64 -d > "$1"',
				"mfw-upload",
				remotePath,
			],
			{ ...opts, input },
		);
	}

	async download(
		remotePath: string,
		opts: { timeoutMs?: number; signal?: AbortSignal } = {},
	): Promise<Uint8Array> {
		if (!remotePath.startsWith("/") || remotePath.includes("\0")) {
			throw new Error("remote download path must be absolute");
		}
		const result = await this.run(["base64", "-w0", "--", remotePath], opts);
		try {
			return Uint8Array.from(Buffer.from(result.stdout, "base64"));
		} catch {
			throw new RemoteTransportError(
				"network_lost",
				"downloaded SSH artifact was not valid base64",
			);
		}
	}

	/**
	 * Source values directly from encrypted SSH stdin, require a final marker,
	 * then exec and redact output. Values never enter SSH argv, config, or disk.
	 */
	async runWithSecrets(
		command: readonly string[],
		publicEnvironment: Readonly<Record<string, string>>,
		secrets: SecretEnvironment,
		opts: { timeoutMs?: number; signal?: AbortSignal } = {},
	): Promise<RemoteCommandResult> {
		assertDisjointEnvironmentNames(publicEnvironment, secrets);
		if (
			SECRET_HANDOFF_SENTINEL in publicEnvironment ||
			secrets.names().includes(SECRET_HANDOFF_SENTINEL)
		) {
			throw new Error("launch environment uses a reserved internal name");
		}
		const environment = new ExecutionEnvironmentBuilder(
			publicEnvironment,
		).build();
		const launch = [
			"env",
			"-i",
			...Object.entries(environment).map(([name, value]) => `${name}=${value}`),
			"/bin/sh",
			"-c",
			SECRET_LAUNCH_SCRIPT,
			"mfw-secret-launch",
			...command,
		];
		try {
			const result = await this.runInternal(launch, {
				...opts,
				input: secretCarrierContents(secrets),
			});
			return {
				...result,
				stdout: redactSecretValues(result.stdout, secrets),
				stderr: redactSecretValues(result.stderr, secrets),
			};
		} catch (error) {
			// RemoteTransportError messages never contain process output. This catch
			// also protects an injected runner which threw with the canary attached.
			if (error instanceof RemoteTransportError) throw error;
			throw new RemoteTransportError(
				"network_lost",
				"secret-aware SSH launch failed",
			);
		}
	}

	async waitUntilReady(
		deadlineMs: number,
		opts: { pollMs?: number; signal?: AbortSignal } = {},
	): Promise<void> {
		if (!Number.isFinite(deadlineMs) || deadlineMs <= Date.now()) {
			throw new RemoteTransportError(
				"deadline_exceeded",
				"SSH readiness deadline elapsed",
			);
		}
		const pollMs = Math.max(25, Math.min(opts.pollMs ?? 1_000, 5_000));
		for (;;) {
			if (opts.signal?.aborted) {
				throw new RemoteTransportError(
					"deadline_exceeded",
					"SSH readiness was cancelled",
				);
			}
			const remaining = deadlineMs - Date.now();
			if (remaining <= 0) {
				throw new RemoteTransportError(
					"deadline_exceeded",
					"SSH readiness deadline elapsed",
				);
			}
			try {
				await this.run(["true"], {
					timeoutMs: Math.min(remaining, this.commandTimeoutMs),
					signal: opts.signal,
				});
				return;
			} catch (error) {
				if (
					error instanceof RemoteTransportError &&
					error.failure === "pod_absent"
				) {
					throw error;
				}
			}
			await Bun.sleep(Math.min(pollMs, Math.max(1, deadlineMs - Date.now())));
		}
	}

	private async runInternal(
		command: readonly string[],
		opts: { input?: string; timeoutMs?: number; signal?: AbortSignal },
	): Promise<RemoteCommandResult> {
		validateEndpoint(this.endpoint);
		await validatePrivateKey(this.endpoint.privateKeyPath);
		const timeoutMs = Math.min(
			opts.timeoutMs ?? this.commandTimeoutMs,
			this.commandTimeoutMs,
		);
		const root = this.options.carrierRoot ?? tmpdir();
		await mkdir(root, { recursive: true, mode: 0o700 });
		const carrier = await mkdtemp(join(root, "mfw-ssh-"));
		const knownHosts = join(carrier, "known_hosts");
		const alias = `mfw-runpod-${this.endpoint.podId}`;
		try {
			await writeFileAtomic(
				knownHosts,
				`${alias} ${this.endpoint.hostPublicKey.trim()}\n`,
				{ mode: 0o600 },
			);
			const connectSeconds = Math.max(
				1,
				Math.ceil(Math.min(this.connectTimeoutMs, timeoutMs) / 1_000),
			);
			const argv = [
				"ssh",
				"-F",
				"/dev/null",
				"-T",
				"-o",
				"BatchMode=yes",
				"-o",
				"IdentitiesOnly=yes",
				"-o",
				"PasswordAuthentication=no",
				"-o",
				"KbdInteractiveAuthentication=no",
				"-o",
				"StrictHostKeyChecking=yes",
				"-o",
				`UserKnownHostsFile=${knownHosts}`,
				"-o",
				"GlobalKnownHostsFile=/dev/null",
				"-o",
				`HostKeyAlias=${alias}`,
				"-o",
				`ConnectTimeout=${connectSeconds}`,
				"-o",
				"ServerAliveInterval=5",
				"-o",
				"ServerAliveCountMax=3",
				"-o",
				"LogLevel=ERROR",
				"-i",
				this.endpoint.privateKeyPath,
				...(this.endpoint.mode === "runpod-direct"
					? ["-p", String(this.endpoint.port)]
					: []),
				`${this.endpoint.principal}@${this.endpoint.host}`,
				encodeRemoteArgv(command),
			];
			const result = await this.runner(argv, {
				input: opts.input,
				timeoutMs,
				maxOutputBytes: this.maxOutputBytes,
				signal: opts.signal,
			});
			if (result.timedOut) {
				throw new RemoteTransportError(
					"deadline_exceeded",
					"SSH command deadline elapsed",
				);
			}
			if (result.exitCode === 255 || result.exitCode === null) {
				if (
					this.options.isPodPresent &&
					!(await this.options.isPodPresent(this.endpoint.podId))
				) {
					throw new RemoteTransportError("pod_absent", "RunPod Pod is absent");
				}
				throw new RemoteTransportError(
					"network_lost",
					"SSH connection was lost while the Pod remained present or unknown",
				);
			}
			if (result.exitCode !== 0) {
				throw new RemoteTransportError(
					"remote_exit",
					`remote command exited with code ${result.exitCode}`,
					result.exitCode,
				);
			}
			return {
				exitCode: result.exitCode,
				stdout: result.stdout,
				stderr: result.stderr,
				truncated: result.truncated,
			};
		} finally {
			await rm(carrier, { recursive: true, force: true });
		}
	}
}
