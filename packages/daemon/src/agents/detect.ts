import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { runProc } from "../proc.ts";
import type {
	ProviderAuthKind,
	ProviderAuthMethod,
	ProviderEntry,
} from "./catalogue.ts";

/**
 * Detect whether each catalogue CLI is installed (and its version), so the
 * picker does not offer tools that would die with `command not found`.
 * PATH lookup is in-process (no `which` fork per render); the version is
 * read from `<bin> --version`, never hard-coded.
 */

export interface ProviderDetection {
	id: string;
	installed: boolean;
	/** Absolute path the PATH scan matched, or null. */
	path: string | null;
	/** First line of `<bin> --version`, or null when it could not be asked. */
	version: string | null;
	/** Why the version is null despite the binary existing. */
	versionError?: string;
}

export interface ProviderAuthStatus {
	kind: ProviderAuthKind;
	credentialId?: string;
	/** A login file with the expected marker exists, or a key is present. */
	configured: boolean;
	/** What proved it: the login file, the credential store, or an env var. */
	via: string | null;
	hint: string;
}

const VERSION_TIMEOUT_MS = 5_000;

/** `exec.LookPath` equivalent. Returns null (not found) rather than throwing. */
export async function whichBin(
	bin: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
	// An explicit path in the entry (or an operator override) is used as-is.
	if (bin.includes("/")) {
		return (await isExecutable(bin)) ? bin : null;
	}
	const path = env.PATH;
	if (!path) return null;
	for (const dir of path.split(delimiter)) {
		if (!dir || !isAbsolute(dir)) continue;
		const candidate = join(dir, bin);
		if (await isExecutable(candidate)) return candidate;
	}
	return null;
}

async function isExecutable(path: string): Promise<boolean> {
	try {
		await access(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

export interface DetectorDeps {
	env?: NodeJS.ProcessEnv;
	home?: string;
	/** Test seam + cache clock. */
	now?: () => number;
	/** How long a detection result is reused. */
	ttlMs?: number;
	/** Test seam: run a version probe without spawning. */
	probeVersion?: (
		path: string,
		args: readonly string[],
	) => Promise<{ ok: boolean; text: string }>;
}

/** Caches per entry id so a polling settings panel does not spawn `--version` on every render. */
export class ProviderDetector {
	private readonly cache = new Map<
		string,
		{ at: number; value: ProviderDetection }
	>();
	private readonly env: NodeJS.ProcessEnv;
	private readonly ttlMs: number;
	private readonly now: () => number;

	constructor(private readonly deps: DetectorDeps = {}) {
		this.env = deps.env ?? process.env;
		this.ttlMs = deps.ttlMs ?? 60_000;
		this.now = deps.now ?? Date.now;
	}

	clear(): void {
		this.cache.clear();
	}

	async detect(entry: ProviderEntry): Promise<ProviderDetection> {
		const hit = this.cache.get(entry.id);
		if (hit && this.now() - hit.at < this.ttlMs) return hit.value;
		const value = await this.probe(entry);
		this.cache.set(entry.id, { at: this.now(), value });
		return value;
	}

	async detectAll(
		entries: readonly ProviderEntry[],
	): Promise<Map<string, ProviderDetection>> {
		const found = await Promise.all(entries.map((e) => this.detect(e)));
		return new Map(found.map((d) => [d.id, d]));
	}

	private async probe(entry: ProviderEntry): Promise<ProviderDetection> {
		const path = await whichBin(entry.bin, this.env);
		if (!path) {
			return { id: entry.id, installed: false, path: null, version: null };
		}
		const probe =
			this.deps.probeVersion ??
			(async (p: string, args: readonly string[]) => {
				const r = await runProc([p, ...args], {
					timeoutMs: VERSION_TIMEOUT_MS,
					env: this.env,
				});
				return {
					ok: r.exitCode === 0,
					text: r.stdout.trim() || r.stderr.trim(),
				};
			});
		try {
			const { ok, text } = await probe(path, entry.versionArgs);
			// A failing --version still means installed.
			if (!ok || !text) {
				return {
					id: entry.id,
					installed: true,
					path,
					version: null,
					versionError: text || `\`${entry.bin} --version\` failed`,
				};
			}
			return {
				id: entry.id,
				installed: true,
				path,
				version: firstLine(text),
			};
		} catch (e) {
			return {
				id: entry.id,
				installed: true,
				path,
				version: null,
				versionError: e instanceof Error ? e.message : String(e),
			};
		}
	}
}

function firstLine(text: string): string {
	const line = text.split("\n", 1)[0] ?? "";
	return line.trim().slice(0, 200);
}

export interface AuthProbeDeps {
	home?: string;
	env?: NodeJS.ProcessEnv;
	/** Presence-only view of the machine credential store. */
	hasCredential?: (id: string) => Promise<boolean>;
}

/** Probe each auth method (subscription login file, stored credential, env var) for a provider. */
export async function probeAuth(
	entry: ProviderEntry,
	deps: AuthProbeDeps = {},
): Promise<ProviderAuthStatus[]> {
	const home = deps.home ?? homedir();
	const env = deps.env ?? process.env;
	const out: ProviderAuthStatus[] = [];
	for (const method of entry.auth) {
		out.push(await probeMethod(method, home, env, deps.hasCredential));
	}
	return out;
}

async function probeMethod(
	method: ProviderAuthMethod,
	home: string,
	env: NodeJS.ProcessEnv,
	hasCredential?: (id: string) => Promise<boolean>,
): Promise<ProviderAuthStatus> {
	const base = {
		kind: method.kind,
		...(method.credentialId ? { credentialId: method.credentialId } : {}),
		hint: method.hint,
	};
	for (const rel of method.loginFiles ?? []) {
		const abs = join(home, rel);
		const ok = await loginFileSatisfies(abs, method.loginMarker);
		if (ok) return { ...base, configured: true, via: abs };
	}
	if (method.credentialId && hasCredential) {
		if (await hasCredential(method.credentialId)) {
			return {
				...base,
				configured: true,
				via: `credentials.json:${method.credentialId}`,
			};
		}
	}
	for (const name of method.envVars ?? []) {
		if (env[name]) return { ...base, configured: true, via: `$${name}` };
	}
	return { ...base, configured: false, via: null };
}

async function loginFileSatisfies(
	abs: string,
	marker?: string,
): Promise<boolean> {
	let raw: string;
	try {
		raw = await readFile(abs, "utf8");
	} catch {
		return false;
	}
	if (!marker) return true;
	try {
		const parsed: unknown = JSON.parse(raw);
		return (
			typeof parsed === "object" &&
			parsed !== null &&
			(parsed as Record<string, unknown>)[marker] != null
		);
	} catch {
		// Unparseable third-party file counts as "not signed in"; mfw does not own the format.
		return false;
	}
}
