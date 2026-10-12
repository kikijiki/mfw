import { mkdir, readFile, rm } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "@mfw/core/fsatomic";
import { z } from "zod";
import { ExecutionEnvironmentBuilder } from "./execution-environment.ts";
import { runProc } from "./proc.ts";
import {
	generateEphemeralRunPodSshKey,
	loadEphemeralRunPodSshKey,
} from "./remote-agent-host.ts";
import { serializeFileMutation } from "./serialized-file-mutation.ts";
import {
	HOST_KEY,
	hostKeyFingerprint,
	RemoteTransportError,
	type SshEndpoint,
	type SshEndpointPolicy,
	type SshProcessRunner,
} from "./ssh-transport.ts";

/**
 * The SSH host registry: machines the operator declared, in
 * `$MFW_HOME/hosts.json` (atomic replace + serialized mutate, as
 * `credentials.ts`). A host is declared config (address, user, pinned host
 * key, labels, trust, slots) plus the last probe's observation. The per-host
 * SSH identity lives next to it under `$MFW_HOME/hosts/keys/`, 0600 in a 0700
 * directory, and never leaves this machine.
 *
 * Trust model (backstage architecture.md, "Security model", "SSH hosts"): the agent runs with every
 * permission the box user has, so the box user is the blast radius. A host
 * is schedulable only when its last probe is fresh and passed:
 *   - the user is not root and `sudo -n true` fails (no passwordless sudo);
 *   - `trust: shared` hosts must sandbox with bwrap, and bwrap must work there;
 *     only `trust: owned` may set `sandbox: none`;
 *   - bun, git and setsid exist (the remote runtime needs them).
 * Stale or missing observations fail closed.
 */

export const HOST_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const USER = /^[a-z_][a-z0-9_-]{0,31}$/;
const HOSTNAME =
	/^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const LABEL = /^[a-z0-9][a-z0-9_.:-]{0,62}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Harnesses a host can run, keyed by the catalogue id routing uses. */
export const REMOTE_HARNESSES = {
	"claude-cli": { binary: "claude", authPaths: [".claude/.credentials.json"] },
	"codex-cli": { binary: "codex", authPaths: [".codex/auth.json"] },
} as const;
export type RemoteHarnessId = keyof typeof REMOTE_HARNESSES;

export const HostConfigSchema = z
	.object({
		id: z.string().regex(HOST_ID_PATTERN),
		address: z
			.string()
			.refine(
				(value) => isIP(value) !== 0 || HOSTNAME.test(value),
				"address must be a hostname or an IP address",
			),
		port: z.number().int().min(1).max(65_535).default(22),
		user: z
			.string()
			.regex(USER, "user must be a plain unix user name")
			.refine((value) => value !== "root", {
				message:
					"never run agents as root: create a dedicated unprivileged user on the box",
			}),
		/** Pinned public host key (`ssh-ed25519 AAAA…`); required, never learned. */
		hostKey: z
			.string()
			.transform((value) => value.trim().split(/\s+/).slice(0, 2).join(" "))
			.refine((value) => HOST_KEY.test(value), "hostKey is not an SSH key"),
		labels: z.array(z.string().regex(LABEL)).default([]),
		/** `owned`: your own box. `shared`: anything else; bwrap is mandatory. */
		trust: z.enum(["owned", "shared"]),
		sandbox: z.enum(["bwrap", "none"]).default("bwrap"),
		/** Concurrent runs; the coordinator's `remote.<id>.slots` capacity. */
		slots: z.number().int().min(1).max(64).default(1),
		/** Absolute directory for run mirrors; default `$HOME/.mfw-runs` on the box. */
		workdir: z
			.string()
			.startsWith("/")
			.refine((value) => !value.includes("\0") && !/\/\.\.(?:\/|$)/.test(value))
			.optional(),
		/**
		 * Workload secret env names a `shared` host may receive. Any other
		 * granted secret refuses the launch there. Ignored on `owned` hosts.
		 */
		secrets: z.array(z.string().regex(ENV_NAME)).default([]),
	})
	.superRefine((host, ctx) => {
		if (host.trust === "shared" && host.sandbox !== "bwrap") {
			ctx.addIssue({
				code: "custom",
				path: ["sandbox"],
				message:
					"bwrap is mandatory on a shared host; only trust: owned may set sandbox: none",
			});
		}
	});

export type HostConfig = z.infer<typeof HostConfigSchema>;
export type HostConfigInput = z.input<typeof HostConfigSchema>;

export const HostObservationSchema = z.object({
	checkedAt: z.number(),
	/**
	 * `ok`: schedulable. `refused`: violates the trust minimum (root, sudo,
	 * missing bwrap). `error`: reachable but missing tooling. `unreachable`.
	 */
	health: z.enum(["ok", "refused", "error", "unreachable"]),
	problems: z.array(z.string()),
	uid: z.number().nullable(),
	user: z.string().nullable(),
	home: z.string().nullable(),
	path: z.string().nullable(),
	bunPath: z.string().nullable(),
	gitPath: z.string().nullable(),
	setsidPath: z.string().nullable(),
	bwrapPath: z.string().nullable(),
	/** `allowed` means `sudo -n true` succeeded: the host is refused. */
	sudo: z.enum(["refused", "allowed", "unknown"]),
	bwrap: z.boolean(),
	harnesses: z.record(
		z.string(),
		z.object({ version: z.string().nullable(), auth: z.boolean() }),
	),
	gpus: z.number().int().nonnegative(),
	diskFreeBytes: z.number().nullable(),
	memAvailableBytes: z.number().nullable(),
});
export type HostObservation = z.infer<typeof HostObservationSchema>;

const FileSchema = z.object({
	version: z.literal(1),
	hosts: z.record(z.string(), HostConfigSchema),
	observed: z.record(z.string(), HostObservationSchema).default({}),
});
type HostFile = z.infer<typeof FileSchema>;

export interface RegisteredHost {
	config: HostConfig;
	observed: HostObservation | null;
	/** Per-host private key path on this machine (never shipped). */
	keyPath: string;
}

/** What placement needs about a host, from one registry snapshot. */
export interface HostCandidate {
	id: string;
	labels: readonly string[];
	/** Harnesses installed AND authenticated on the box. */
	harnesses: readonly string[];
	slots: number;
	schedulable: boolean;
	/** Why it is not schedulable, for the refusal message. */
	reason: string | null;
}

/** Observations older than this make a host unschedulable (fail closed). */
export const HOST_OBSERVATION_MAX_AGE_MS = 30 * 60_000;

export function hostAlias(id: string): string {
	return `mfw-host-${id}`;
}

export function hostSlotResourceId(id: string): string {
	return `remote.${id}.slots`;
}

export function hostEndpoint(
	config: HostConfig,
	privateKeyPath: string,
): SshEndpoint {
	return {
		alias: hostAlias(config.id),
		host: config.address,
		port: config.port,
		user: config.user,
		privateKeyPath,
		hostPublicKey: config.hostKey,
	};
}

/**
 * Endpoint policy for registry hosts: the endpoint must be exactly a declared
 * host (alias, address, port, user and the pinned host key). An unpinned
 * address, a different user or a changed key is refused before ssh runs.
 */
export function registryPinnedPolicy(
	hosts: readonly Pick<
		HostConfig,
		"id" | "address" | "port" | "user" | "hostKey"
	>[],
): SshEndpointPolicy {
	return (endpoint) => {
		const host = hosts.find((item) => hostAlias(item.id) === endpoint.alias);
		if (
			!host ||
			host.address !== endpoint.host ||
			host.port !== (endpoint.port ?? 22) ||
			host.user !== endpoint.user ||
			host.hostKey !== endpoint.hostPublicKey.trim()
		) {
			throw new RemoteTransportError(
				"identity_mismatch",
				"SSH endpoint is not a registry-pinned host",
			);
		}
		if (endpoint.user === "root") {
			throw new RemoteTransportError(
				"identity_mismatch",
				"registry hosts never connect as root",
			);
		}
	};
}

/** Pure schedulability: fresh `ok` observation and a still-valid trust minimum. */
export function hostCandidate(
	host: Pick<RegisteredHost, "config" | "observed">,
	now: number,
	maxAgeMs = HOST_OBSERVATION_MAX_AGE_MS,
): HostCandidate {
	const { config, observed } = host;
	let reason: string | null = null;
	if (!observed) reason = "has never been probed";
	else if (observed.health !== "ok")
		reason = `is ${observed.health}: ${observed.problems.join("; ") || "see the last probe"}`;
	else if (now - observed.checkedAt > maxAgeMs)
		reason = "has a stale probe (probe it again)";
	else if (config.sandbox === "bwrap" && !observed.bwrap)
		reason = "needs bwrap, which the last probe did not find";
	return {
		id: config.id,
		labels: config.labels,
		harnesses: observed
			? Object.entries(observed.harnesses)
					.filter(([, h]) => h.version !== null && h.auth)
					.map(([id]) => id)
					.sort()
			: [],
		slots: config.slots,
		schedulable: reason === null,
		reason,
	};
}

/**
 * Read a box's public host keys with ssh-keyscan, for the operator to VERIFY
 * (compare the fingerprint with `ssh-keygen -lf /etc/ssh/ssh_host_*.pub` on
 * the box) before pinning one. Nothing is pinned automatically.
 */
export async function scanHostKeys(input: {
	address: string;
	port: number;
	runner?: SshProcessRunner;
}): Promise<{ key: string; fingerprint: string }[]> {
	const address = HostConfigSchema.shape.address.parse(input.address);
	const keyscan = Bun.which("ssh-keyscan") ?? "/usr/bin/ssh-keyscan";
	const result = await (input.runner ?? runProc)(
		[keyscan, "-T", "5", "-p", String(input.port), "--", address],
		{
			env: new ExecutionEnvironmentBuilder().build(),
			timeoutMs: 15_000,
			maxOutputBytes: 64 * 1024,
		},
	);
	if (result.timedOut || result.exitCode !== 0) {
		throw new Error(`could not read host keys from ${address}:${input.port}`);
	}
	const keys = new Map<string, string>();
	for (const line of result.stdout.split("\n")) {
		const parts = line.trim().split(/\s+/);
		if (parts.length < 3 || parts[0]?.startsWith("#")) continue;
		const key = `${parts[1]} ${parts[2]}`;
		if (HOST_KEY.test(key)) keys.set(key, hostKeyFingerprint(key));
	}
	return [...keys].map(([key, fingerprint]) => ({ key, fingerprint }));
}

export class HostNotFoundError extends Error {
	constructor(readonly hostId: string) {
		super(`SSH host '${hostId}' is not registered`);
		this.name = "HostNotFoundError";
	}
}

export interface HostRegistryOptions {
	/** Absolute ssh-keygen path; tests inject one. */
	keygenPath?: string;
	keygenRunner?: SshProcessRunner;
	now?: () => number;
}

export class HostRegistry {
	private readonly keyDirectory: string;

	constructor(
		private readonly path: string,
		private readonly options: HostRegistryOptions = {},
	) {
		this.keyDirectory = join(dirname(path), "hosts", "keys");
	}

	static at(mfwHome: string, options?: HostRegistryOptions): HostRegistry {
		return new HostRegistry(join(mfwHome, "hosts.json"), options);
	}

	private now(): number {
		return (this.options.now ?? Date.now)();
	}

	private async load(): Promise<HostFile> {
		let raw: string;
		try {
			raw = await readFile(this.path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT")
				return { version: 1, hosts: {}, observed: {} };
			throw error;
		}
		try {
			return FileSchema.parse(JSON.parse(raw));
		} catch (error) {
			// Never treat a malformed registry as empty: a mutation would drop hosts.
			throw new Error(
				`host registry ${this.path} is malformed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private async save(file: HostFile): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
		await writeFileAtomic(this.path, `${JSON.stringify(file, null, "\t")}\n`, {
			mode: 0o600,
		});
	}

	private read<T>(reader: (file: HostFile) => T): Promise<T> {
		return serializeFileMutation(this.path, async () =>
			reader(await this.load()),
		);
	}

	private mutate<T>(mutation: (file: HostFile) => T | Promise<T>): Promise<T> {
		return serializeFileMutation(this.path, async () => {
			const file = await this.load();
			const result = await mutation(file);
			await this.save(file);
			return result;
		});
	}

	private keyIdentifier(id: string): string {
		return `host_${id}`;
	}

	keyPath(id: string): string {
		return join(this.keyDirectory, `lease-${this.keyIdentifier(id)}-ed25519`);
	}

	private registered(file: HostFile, id: string): RegisteredHost | null {
		const config = file.hosts[id];
		if (!config) return null;
		return {
			config,
			observed: file.observed[id] ?? null,
			keyPath: this.keyPath(id),
		};
	}

	async list(): Promise<RegisteredHost[]> {
		return this.read((file) =>
			Object.keys(file.hosts)
				.sort()
				.map((id) => this.registered(file, id) as RegisteredHost),
		);
	}

	async get(id: string): Promise<RegisteredHost | null> {
		return this.read((file) => this.registered(file, id));
	}

	async require(id: string): Promise<RegisteredHost> {
		const host = await this.get(id);
		if (!host) throw new HostNotFoundError(id);
		return host;
	}

	/** Placement view of every host, schedulability judged now. */
	async candidates(now = this.now()): Promise<HostCandidate[]> {
		return (await this.list()).map((host) => hostCandidate(host, now));
	}

	/**
	 * Add or update a host. A new host gets its own Ed25519 identity; the
	 * returned public key is what the operator appends to the box user's
	 * `~/.ssh/authorized_keys`. Changing address/user/key clears the last
	 * observation, so the host must be probed again before it is scheduled.
	 */
	async put(input: HostConfigInput): Promise<{
		host: RegisteredHost;
		publicKey: string;
	}> {
		const config = HostConfigSchema.parse(input);
		const keygen = {
			identifier: this.keyIdentifier(config.id),
			directory: this.keyDirectory,
			...(this.options.keygenPath
				? { keygenPath: this.options.keygenPath }
				: {}),
			...(this.options.keygenRunner
				? { runner: this.options.keygenRunner }
				: {}),
		};
		return this.mutate(async (file) => {
			const prior = file.hosts[config.id];
			const key = prior
				? await loadEphemeralRunPodSshKey(keygen)
				: await generateEphemeralRunPodSshKey(keygen);
			if (
				!prior ||
				prior.address !== config.address ||
				prior.port !== config.port ||
				prior.user !== config.user ||
				prior.hostKey !== config.hostKey ||
				prior.trust !== config.trust ||
				prior.sandbox !== config.sandbox
			) {
				delete file.observed[config.id];
			}
			file.hosts[config.id] = config;
			return {
				host: this.registered(file, config.id) as RegisteredHost,
				publicKey: key.publicKey,
			};
		});
	}

	async publicKey(id: string): Promise<string> {
		await this.require(id);
		const key = await loadEphemeralRunPodSshKey({
			identifier: this.keyIdentifier(id),
			directory: this.keyDirectory,
			...(this.options.keygenPath
				? { keygenPath: this.options.keygenPath }
				: {}),
			...(this.options.keygenRunner
				? { runner: this.options.keygenRunner }
				: {}),
		});
		return key.publicKey;
	}

	async remove(id: string): Promise<void> {
		await this.mutate(async (file) => {
			if (!file.hosts[id]) throw new HostNotFoundError(id);
			delete file.hosts[id];
			delete file.observed[id];
		});
		await Promise.all([
			rm(this.keyPath(id), { force: true }),
			rm(`${this.keyPath(id)}.pub`, { force: true }),
		]);
	}

	/** Record a probe result; ignored when the host was removed meanwhile. */
	async recordObservation(
		id: string,
		observation: HostObservation,
	): Promise<void> {
		const parsed = HostObservationSchema.parse(observation);
		await this.mutate((file) => {
			if (file.hosts[id]) file.observed[id] = parsed;
		});
	}
}
