import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
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

/**
 * Strict, host-pinned, deadline-bounded OpenSSH transport shared by every
 * remote execution target (RunPod Pods and registry SSH hosts).
 *
 * Every command runs the system `ssh` with `-F /dev/null` (no user config),
 * BatchMode, IdentitiesOnly, `StrictHostKeyChecking=yes` and a one-line
 * known_hosts file written per command under a fixed `HostKeyAlias`, so the
 * only host key ever accepted is the one the caller pinned. An endpoint
 * policy runs before every command: the transport never connects to an
 * endpoint its policy has not accepted. Secrets travel on stdin only.
 */

export interface SshEndpoint {
	/** HostKeyAlias: the pinned key is bound to this name, never to the address. */
	alias: string;
	host: string;
	port?: number;
	user: string;
	privateKeyPath: string;
	/** Complete OpenSSH public host-key line, e.g. `ssh-ed25519 AAAA…`. */
	hostPublicKey: string;
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

/** Throws `RemoteTransportError("identity_mismatch")` for an endpoint it refuses. */
export type SshEndpointPolicy = (endpoint: SshEndpoint) => void;

export interface SshTransportOptions {
	endpoint: SshEndpoint;
	policy: SshEndpointPolicy;
	/** Hard wall-clock bound for an individual command. */
	commandTimeoutMs?: number;
	/** OpenSSH TCP establishment timeout, independently capped by command time. */
	connectTimeoutMs?: number;
	maxOutputBytes?: number;
	/**
	 * Fresh control-plane check that distinguishes loss from absence after a
	 * connection failure. True = the remote machine is gone (`pod_absent`).
	 */
	isAbsent?: () => Promise<boolean>;
	absentMessage?: string;
	runner?: SshProcessRunner;
	/** Outside every worktree. Tests can inject an isolated carrier parent. */
	carrierRoot?: string;
}

export const HOST_KEY =
	/^(?:ssh-ed25519|ecdsa-sha2-nistp(?:256|384|521)|ssh-rsa) [A-Za-z0-9+/=]+$/;
const ALIAS = /^[A-Za-z0-9._-]{1,128}$/;
const SECRET_HANDOFF_SENTINEL = "MFW_REMOTE_SECRET_HANDOFF_COMPLETE";

/** `SHA256:…` fingerprint of a public host key line, as `ssh-keygen -lf` prints it. */
export function hostKeyFingerprint(hostPublicKey: string): string {
	const blob = hostPublicKey.trim().split(/\s+/)[1] ?? "";
	return `SHA256:${createHash("sha256")
		.update(Buffer.from(blob, "base64"))
		.digest("base64")
		.replace(/=+$/, "")}`;
}

export async function validateSshFile(
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

/** Shape checks every policy shares: alias, key path, port, pinned key. */
export function validateEndpointShape(endpoint: SshEndpoint): void {
	if (!ALIAS.test(endpoint.alias)) {
		throw new RemoteTransportError(
			"identity_mismatch",
			"SSH host-key alias is invalid",
		);
	}
	if (
		endpoint.port !== undefined &&
		(!Number.isInteger(endpoint.port) ||
			endpoint.port < 1 ||
			endpoint.port > 65_535)
	) {
		throw new RemoteTransportError(
			"identity_mismatch",
			"SSH endpoint port is invalid",
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
			"SSH host key is invalid",
		);
	}
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

export class SshTransport {
	private readonly commandTimeoutMs: number;
	private readonly connectTimeoutMs: number;
	private readonly maxOutputBytes: number;
	private readonly runner: SshProcessRunner;

	constructor(private readonly options: SshTransportOptions) {
		this.validate();
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

	get endpoint(): SshEndpoint {
		return this.options.endpoint;
	}

	private validate(): void {
		validateEndpointShape(this.options.endpoint);
		this.options.policy(this.options.endpoint);
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

	/** Stream a non-secret artifact over SSH (RunPod basic SSH has no SCP). */
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
		this.validate();
		const endpoint = this.options.endpoint;
		await validateSshFile(
			endpoint.privateKeyPath,
			(mode) => mode === 0o600,
			"private key",
		);
		const timeoutMs = Math.min(
			opts.timeoutMs ?? this.commandTimeoutMs,
			this.commandTimeoutMs,
		);
		const root = this.options.carrierRoot ?? tmpdir();
		await mkdir(root, { recursive: true, mode: 0o700 });
		const carrier = await mkdtemp(join(root, "mfw-ssh-"));
		const knownHosts = join(carrier, "known_hosts");
		try {
			await writeFileAtomic(
				knownHosts,
				`${endpoint.alias} ${endpoint.hostPublicKey.trim()}\n`,
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
				`HostKeyAlias=${endpoint.alias}`,
				"-o",
				`ConnectTimeout=${connectSeconds}`,
				"-o",
				"ServerAliveInterval=5",
				"-o",
				"ServerAliveCountMax=3",
				"-o",
				"LogLevel=ERROR",
				// Never forward an agent or X11: the box must not borrow the daemon's keys.
				"-o",
				"ForwardAgent=no",
				"-o",
				"ForwardX11=no",
				"-i",
				endpoint.privateKeyPath,
				...(endpoint.port !== undefined ? ["-p", String(endpoint.port)] : []),
				`${endpoint.user}@${endpoint.host}`,
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
				if (this.options.isAbsent && (await this.options.isAbsent())) {
					throw new RemoteTransportError(
						"pod_absent",
						this.options.absentMessage ?? "remote machine is absent",
					);
				}
				throw new RemoteTransportError(
					"network_lost",
					"SSH connection was lost while the remote machine remained present or unknown",
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
