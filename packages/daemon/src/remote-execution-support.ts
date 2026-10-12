import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "@mfw/core/fsatomic";
import {
	redactSecretValues,
	type SecretEnvironment,
} from "./execution-environment.ts";
import { RemoteTransportError } from "./ssh-transport.ts";

/**
 * Pieces every SSH-reached execution target shares (RunPod Pods and
 * registry hosts): the uploaded runtime bundle, the public-environment
 * credential guard, the collection secret scan and evidence sync.
 */

export async function bundleRemoteSupport(
	entrypoint: string,
): Promise<Uint8Array> {
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
/** The argv-only remote runtime (`runpod-remote-runtime.ts`), bundled once. */
export function bundledRemoteRuntime(): Promise<Uint8Array> {
	runtimeBundle ??= bundleRemoteSupport(runtimeEntrypoint());
	return runtimeBundle;
}

export function remoteErrorCode(error: unknown): string {
	return error instanceof RemoteTransportError
		? error.failure
		: error instanceof Error
			? error.name
			: "unknown";
}

/**
 * Public (argv/config-visible) environment must never carry a credential or
 * anything that lets the remote side push or borrow the daemon's identity:
 * secrets go through workload grants on stdin only.
 */
export function assertPublicEnvironmentHasNoCredentials(
	environment: Readonly<Record<string, string>>,
): void {
	const unsafe = Object.keys(environment).filter(
		(name) =>
			/(?:^|_)(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?)$/i.test(name) ||
			name.toUpperCase().startsWith("RUNPOD") ||
			/^(?:SSH_AUTH_SOCK|GIT_ASKPASS|SSH_ASKPASS|GIT_SSH|GIT_SSH_COMMAND|GIT_CONFIG_GLOBAL|MFW_HOME)$/i.test(
				name,
			),
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

export function assertCollectionHasNoSecrets(
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

/** Copy the remote run's evidence files locally, redacted, bounded. */
export async function syncRemoteArtifacts(
	transport: { download(path: string): Promise<Uint8Array> },
	remoteRunDir: string,
	localRunDir: string,
	secrets: SecretEnvironment | undefined,
	maxTransferBytes: number,
): Promise<void> {
	for (const name of ["events.jsonl", "raw.log", "exit"] as const) {
		let bytes: Uint8Array;
		try {
			bytes = await transport.download(`${remoteRunDir}/${name}`);
		} catch (error) {
			if (
				error instanceof RemoteTransportError &&
				error.failure === "remote_exit"
			)
				continue;
			throw error;
		}
		if (bytes.byteLength > maxTransferBytes) {
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
