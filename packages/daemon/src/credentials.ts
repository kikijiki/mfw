import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "@mfw/core/fsatomic";
import { z } from "zod";
import { SecretEnvironment } from "./execution-environment.ts";
import { serializeFileMutation } from "./serialized-file-mutation.ts";

/** Provider API keys live in `~/.local/share/mfw/credentials.json` (chmod 600, tmp+rename), never in the DB. */

const CredentialVersionSchema = z.string().uuid();
const CredentialsSchema = z.object({
	providers: z.record(
		z.string(),
		z.object({
			apiKey: z.string(),
			version: CredentialVersionSchema.optional(),
		}),
	),
	/**
	 * Trigger script secrets. A sibling of `providers` so unrelated features
	 * cannot read model API keys. Resolved only when both the trigger definition
	 * and the arming record agree (`triggers/script-action.ts`).
	 */
	secrets: z
		.record(
			z.string(),
			z.union([
				z.string(),
				z.object({ value: z.string(), version: CredentialVersionSchema }),
			]),
		)
		.default({}),
});

interface VersionedCredential {
	value: string;
	version: string;
}

interface Credentials {
	providers: Record<string, { apiKey: string; version: string }>;
	secrets: Record<string, VersionedCredential>;
}

const EMPTY: Credentials = { providers: {}, secrets: {} };

export class CredentialStore {
	private readonly providerCandidate = new AsyncLocalStorage<
		ReadonlyMap<string, string>
	>();

	constructor(private readonly path: string) {}

	static at(mfwHome: string): CredentialStore {
		return new CredentialStore(join(mfwHome, "credentials.json"));
	}

	private async load(): Promise<Credentials> {
		let raw: string;
		try {
			raw = await readFile(this.path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return structuredClone(EMPTY); // missing file = no credentials yet
			}
			// Never treat an unreadable file as empty: the next mutation would wipe every secret.
			throw error;
		}
		let parsed: z.infer<typeof CredentialsSchema>;
		try {
			parsed = CredentialsSchema.parse(JSON.parse(raw));
		} catch (e) {
			throw new Error(
				`credentials file ${this.path} is malformed: ${e instanceof Error ? e.message : e}`,
			);
		}
		let migrated = false;
		const normalized: Credentials = { providers: {}, secrets: {} };
		for (const [id, credential] of Object.entries(parsed.providers)) {
			const version = credential.version ?? randomUUID();
			if (!credential.version) migrated = true;
			normalized.providers[id] = { apiKey: credential.apiKey, version };
		}
		for (const [id, credential] of Object.entries(parsed.secrets)) {
			if (typeof credential === "string") {
				migrated = true;
				normalized.secrets[id] = {
					value: credential,
					version: randomUUID(),
				};
			} else {
				normalized.secrets[id] = credential;
			}
		}
		// Kept separate from parse errors so EACCES/EIO surfaces as-is.
		if (migrated) await this.save(normalized);
		return normalized;
	}

	private async save(creds: Credentials): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
		await writeFileAtomic(this.path, `${JSON.stringify(creds, null, "\t")}\n`, {
			mode: 0o600,
		});
	}

	private read<T>(reader: (creds: Credentials) => T | Promise<T>): Promise<T> {
		return serializeFileMutation(this.path, async () =>
			reader(await this.load()),
		);
	}

	private mutate<T>(
		mutation: (creds: Credentials) => T | Promise<T>,
	): Promise<T> {
		return serializeFileMutation(this.path, async () => {
			const creds = await this.load();
			const result = await mutation(creds);
			await this.save(creds);
			return result;
		});
	}

	async get(providerId: string): Promise<string | undefined> {
		const candidate = this.providerCandidate.getStore()?.get(providerId);
		if (candidate !== undefined) return candidate;
		return this.read((creds) => creds.providers[providerId]?.apiKey);
	}

	async getVersioned(
		providerId: string,
	): Promise<VersionedCredential | undefined> {
		return this.read((creds) => {
			const credential = creds.providers[providerId];
			return credential
				? { value: credential.apiKey, version: credential.version }
				: undefined;
		});
	}

	async set(providerId: string, apiKey: string): Promise<void> {
		await this.mutate((creds) => {
			creds.providers[providerId] = { apiKey, version: randomUUID() };
		});
	}

	/** Validate a provider key in an async-local view before its only durable write. */
	async setProviderValidated(
		providerId: string,
		apiKey: string,
		validate: () => Promise<void>,
	): Promise<void> {
		await this.mutate(async (creds) => {
			await this.providerCandidate.run(
				new Map([[providerId, apiKey]]),
				validate,
			);
			creds.providers[providerId] = { apiKey, version: randomUUID() };
		});
	}

	async remove(providerId: string): Promise<void> {
		await this.mutate((creds) => {
			delete creds.providers[providerId];
		});
	}

	async list(): Promise<string[]> {
		return this.read((creds) => Object.keys(creds.providers));
	}

	async getSecret(name: string): Promise<string | undefined> {
		return this.read((creds) => creds.secrets[name]?.value);
	}

	async getSecretVersioned(
		name: string,
	): Promise<VersionedCredential | undefined> {
		return this.read((creds) => {
			const credential = creds.secrets[name];
			return credential ? { ...credential } : undefined;
		});
	}

	async setSecret(name: string, value: string): Promise<void> {
		await this.mutate((creds) => {
			creds.secrets[name] = { value, version: randomUUID() };
		});
	}

	async removeSecret(name: string): Promise<void> {
		await this.mutate((creds) => {
			delete creds.secrets[name];
		});
	}

	async listSecrets(): Promise<string[]> {
		return this.read((creds) => Object.keys(creds.secrets));
	}
}

const SecretGrantSchema = z.object({
	id: z.string().regex(/^[A-Za-z0-9._-]+$/),
	projectId: z.string().min(1),
	/** `null` grants any task, but a run must still select this grant by id. */
	taskIds: z.array(z.string().min(1)).nullable(),
	environment: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
	source: z.discriminatedUnion("kind", [
		z.object({ kind: z.literal("secret"), id: z.string().min(1) }),
		z.object({ kind: z.literal("provider"), id: z.string().min(1) }),
	]),
});

const SecretGrantFileSchema = z.object({
	version: z.literal(1),
	grants: z.record(z.string(), SecretGrantSchema),
});

export type WorkloadSecretGrant = z.infer<typeof SecretGrantSchema>;

const EMPTY_GRANTS: z.infer<typeof SecretGrantFileSchema> = {
	version: 1,
	grants: {},
};

function namesRunPodControlPlaneCredential(value: string): boolean {
	return value.toLowerCase().startsWith("runpod");
}

function assertWorkloadGrantCredentialBoundary(
	grant: WorkloadSecretGrant,
): void {
	if (
		namesRunPodControlPlaneCredential(grant.source.id) ||
		namesRunPodControlPlaneCredential(grant.environment)
	) {
		throw new Error(
			"RunPod provider credentials are control-plane-only and cannot be granted to workloads",
		);
	}
}

/** Machine-side approval records: selectors and credential names, never values, stored outside project state. */
export class WorkloadSecretGrantStore {
	constructor(private readonly path: string) {}

	static at(mfwHome: string): WorkloadSecretGrantStore {
		return new WorkloadSecretGrantStore(
			join(mfwHome, "workload-secret-grants.json"),
		);
	}

	private async loadFile(): Promise<z.infer<typeof SecretGrantFileSchema>> {
		let raw: string;
		try {
			raw = await readFile(this.path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return structuredClone(EMPTY_GRANTS);
			}
			throw error;
		}
		try {
			return SecretGrantFileSchema.parse(JSON.parse(raw));
		} catch (error) {
			throw new Error(
				`workload secret grant file is malformed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private async saveFile(
		file: z.infer<typeof SecretGrantFileSchema>,
	): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
		await writeFileAtomic(this.path, `${JSON.stringify(file, null, "\t")}\n`, {
			mode: 0o600,
		});
	}

	private read<T>(
		reader: (file: z.infer<typeof SecretGrantFileSchema>) => T | Promise<T>,
	): Promise<T> {
		return serializeFileMutation(this.path, async () =>
			reader(await this.loadFile()),
		);
	}

	private mutate<T>(
		mutation: (file: z.infer<typeof SecretGrantFileSchema>) => T | Promise<T>,
	): Promise<T> {
		return serializeFileMutation(this.path, async () => {
			const file = await this.loadFile();
			const result = await mutation(file);
			await this.saveFile(file);
			return result;
		});
	}

	async list(): Promise<WorkloadSecretGrant[]> {
		return this.read((file) =>
			Object.values(file.grants).sort((left, right) =>
				left.id.localeCompare(right.id),
			),
		);
	}

	async put(grant: WorkloadSecretGrant): Promise<void> {
		const parsed = SecretGrantSchema.parse(grant);
		assertWorkloadGrantCredentialBoundary(parsed);
		await this.mutate((file) => {
			file.grants[parsed.id] = parsed;
		});
	}

	async remove(id: string): Promise<void> {
		await this.mutate((file) => {
			delete file.grants[id];
		});
	}

	/** Resolve only the grants selected by this invocation. Missing, cross-project/task, duplicate-env and missing-value cases fail closed, without values in errors. */
	async resolve(
		selection: {
			projectId: string;
			taskId: string | null;
			grantIds: readonly string[];
		},
		credentials: Pick<CredentialStore, "getVersioned" | "getSecretVersioned">,
	): Promise<SecretEnvironment> {
		return (await this.resolveBound(selection, credentials)).secretEnvironment;
	}

	async resolveBound(
		selection: {
			projectId: string;
			taskId: string | null;
			grantIds: readonly string[];
		},
		credentials: Pick<CredentialStore, "getVersioned" | "getSecretVersioned">,
	): Promise<{ secretEnvironment: SecretEnvironment; binding: string }> {
		const file = await this.read((loaded) => loaded);
		const resolved: Record<string, string> = {};
		const versions: [string, string][] = [];
		for (const grantId of [...new Set(selection.grantIds)].sort()) {
			const grant = file.grants[grantId];
			if (!grant)
				throw new Error(`workload secret grant '${grantId}' is missing`);
			assertWorkloadGrantCredentialBoundary(grant);
			if (grant.projectId !== selection.projectId) {
				throw new Error(
					`workload secret grant '${grantId}' is not approved for this project`,
				);
			}
			if (
				grant.taskIds !== null &&
				(selection.taskId === null || !grant.taskIds.includes(selection.taskId))
			) {
				throw new Error(
					`workload secret grant '${grantId}' is not approved for this task`,
				);
			}
			if (grant.environment in resolved) {
				throw new Error(
					`multiple workload grants select environment name '${grant.environment}'`,
				);
			}
			const credential =
				grant.source.kind === "secret"
					? await credentials.getSecretVersioned(grant.source.id)
					: await credentials.getVersioned(grant.source.id);
			if (credential === undefined) {
				throw new Error(
					`credential selected by workload grant '${grantId}' is unavailable`,
				);
			}
			resolved[grant.environment] = credential.value;
			versions.push([grantId, credential.version]);
		}
		return {
			secretEnvironment: new SecretEnvironment(resolved),
			binding: `v1.${Buffer.from(JSON.stringify(versions)).toString("base64url")}`,
		};
	}
}
