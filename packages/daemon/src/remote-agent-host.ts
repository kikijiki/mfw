import { chmod, lstat, mkdir, readFile, rm } from "node:fs/promises";
import { isIP } from "node:net";
import { isAbsolute, join } from "node:path";
import { ExecutionEnvironmentBuilder } from "./execution-environment.ts";
import { runProc } from "./proc.ts";
import {
	HOST_KEY,
	RemoteTransportError,
	type SshEndpoint,
	type SshProcessRunner,
	SshTransport,
} from "./ssh-transport.ts";

/**
 * RunPod's SSH endpoint policy, host-key scan and per-lease identities, on top
 * of the target-neutral `SshTransport` (`ssh-transport.ts`).
 */
export {
	encodeRemoteArgv,
	type RemoteCommandResult,
	RemoteTransportError,
	type RemoteTransportFailure,
	type SshProcessRunner,
} from "./ssh-transport.ts";

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

function genericEndpoint(endpoint: RunPodSshEndpoint): SshEndpoint {
	return {
		alias: `mfw-runpod-${endpoint.podId}`,
		host: endpoint.host,
		...(endpoint.mode === "runpod-direct" ? { port: endpoint.port } : {}),
		user: endpoint.principal,
		privateKeyPath: endpoint.privateKeyPath,
		hostPublicKey: endpoint.hostPublicKey,
	};
}

/**
 * The shared strict SSH transport with RunPod's endpoint policy: basic SSH
 * through `ssh.runpod.io` with a Pod-bound principal, or direct SSH to a
 * provider-observed public IP as root. Pod absence comes from the account.
 */
export class RunPodSshTransport extends SshTransport {
	constructor(options: RunPodSshTransportOptions) {
		validateEndpoint(options.endpoint);
		const { endpoint, isPodPresent, ...rest } = options;
		super({
			...rest,
			endpoint: genericEndpoint(endpoint),
			policy: () => validateEndpoint(endpoint),
			...(isPodPresent
				? { isAbsent: async () => !(await isPodPresent(endpoint.podId)) }
				: {}),
			absentMessage: "RunPod Pod is absent",
		});
	}
}
