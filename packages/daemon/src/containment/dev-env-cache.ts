/**
 * The evaluated dev environment, kept host-side so runs start fast (design
 * "Dev environment runs inside the sandbox").
 *
 * One entry per approval fingerprint (project, commit, every environment
 * file's bytes, the `env` config), under `$MFW_HOME/env/cache/<project>/<fp>`:
 *
 * - `capture.json`: the filtered environment (dev-env-capture.ts), the store
 *   closure it needs, and what the evaluation reached. Re-validated by the
 *   profile schema on every launch, because it came from project code;
 * - `data/`: the environment's private data (mise installs), written by the
 *   env-build sandbox and bound read-only into every later sandbox;
 * - `gcroots/`: indirect GC roots for the closure, so a collection on the
 *   host does not remove what runs bind. Best effort: a run whose closure is
 *   gone is refused at compile time (`dev_env_missing`), never given less.
 *
 * Building is serialized per fingerprint across processes (the CLI and the
 * daemon), and a finished entry is reused as is.
 */

import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { KeyedLock } from "@mfw/board-core";
import { writeFileAtomic } from "@mfw/core/fsatomic";
import {
	type EnvRunRequest,
	type EnvRunResult,
	runEnvStep,
} from "./dev-env-build.ts";
import {
	type DevEnvCapture,
	DevEnvCaptureSchema,
	devEnvCacheDir,
	loadDevEnv,
} from "./dev-env-cached.ts";
import {
	closePath,
	DevEnvParseError,
	decodeDirenvWatches,
	filterDevEnv,
	parseDirenvExport,
	parseMiseEnv,
	parseNixDevEnv,
	type RawEnv,
	watchedRepoPaths,
} from "./dev-env-capture.ts";
import type { EnvConfig } from "./dev-env-config.ts";
import { DEFAULT_ENV_TIMEOUT_SECONDS } from "./dev-env-config.ts";
import { envBuildAllowlist } from "./dev-env-egress.ts";
import { DEV_ENV_LIMITS } from "./dev-env-rules.ts";
import {
	EnvSourceError,
	type EnvSourceKind,
	hashCommitFiles,
} from "./dev-env-sources.ts";
import {
	type EnvTrustRecord,
	type EnvTrustStore,
	envFingerprint,
	envHome,
} from "./dev-env-trust.ts";
import { hostStoreClosure, type StoreClosure } from "./store-closure.ts";

export {
	type DevEnvCapture,
	DevEnvCaptureSchema,
	devEnvBindRoot,
	devEnvCacheDir,
	devEnvSection,
	loadDevEnv,
} from "./dev-env-cached.ts";

export class DevEnvBuildError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly fix: string,
		readonly log: string,
	) {
		super(message);
		this.name = "DevEnvBuildError";
	}
}

function parseOutput(source: EnvSourceKind, output: Buffer): RawEnv {
	const text = output.toString("utf8");
	switch (source) {
		case "direnv":
			return parseDirenvExport(text);
		case "mise":
			return parseMiseEnv(text);
		case "flake":
		case "devenv":
			return parseNixDevEnv(text);
	}
}

function exists(p: string): boolean {
	try {
		lstatSync(p);
		return true;
	} catch {
		return false;
	}
}

/** Fixed, root-owned locations of nix-store. `PATH` is never consulted. */
const NIX_STORE_TOOLS = [
	"/run/current-system/sw/bin/nix-store",
	"/nix/var/nix/profiles/default/bin/nix-store",
] as const;

/**
 * Indirect GC roots for `paths` under `dir`. Output paths only: a `.drv`
 * would be built by `--realise`, and these names came from project code.
 */
async function addGcRoots(
	dir: string,
	paths: readonly string[],
): Promise<boolean> {
	const outputs = paths.filter((p) => !p.endsWith(".drv"));
	if (outputs.length === 0) return true;
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	for (const tool of NIX_STORE_TOOLS) {
		if (!exists(tool)) continue;
		const child = Bun.spawn(
			[
				tool,
				"--add-root",
				join(dir, "r"),
				"--indirect",
				"--realise",
				...outputs,
			],
			{
				env: { NIX_REMOTE: "daemon" },
				cwd: "/",
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
			},
		);
		const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
		const code = await child.exited;
		clearTimeout(timer);
		return code === 0;
	}
	return false;
}

export interface BuildDevEnvInput {
	mfwHome: string;
	root: string;
	stateDir: string;
	record: EnvTrustRecord;
	config: EnvConfig | undefined;
	store: EnvTrustStore;
	/** Seams for the tests' caged chain. */
	run?: (req: EnvRunRequest) => Promise<EnvRunResult>;
	steps?: EnvRunRequest["steps"];
	nixTrust?: EnvRunRequest["nixTrust"];
	closure?: (roots: readonly string[]) => StoreClosure;
	gcRoots?: (dir: string, paths: readonly string[]) => Promise<boolean>;
	now?: () => Date;
}

const inFlight = new Map<string, Promise<DevEnvCapture>>();

/** Evaluate the approved environment, or return the cached result. Throws DevEnvBuildError. */
export function buildDevEnv(input: BuildDevEnvInput): Promise<DevEnvCapture> {
	const fingerprint = envFingerprint(input.record);
	const key = `${input.root}\0${fingerprint}`;
	const running = inFlight.get(key);
	if (running) return running;
	const p = buildLocked(input, fingerprint).finally(() => inFlight.delete(key));
	inFlight.set(key, p);
	return p;
}

async function buildLocked(
	input: BuildDevEnvInput,
	fingerprint: string,
): Promise<DevEnvCapture> {
	const lock = new KeyedLock(join(envHome(input.mfwHome), "locks"), {
		timeoutMs:
			(input.config?.timeoutSeconds ?? DEFAULT_ENV_TIMEOUT_SECONDS) * 1000 +
			120_000,
	});
	return lock.with(`build-${fingerprint}`, async () => {
		const cached = await loadDevEnv(input.mfwHome, input.root, fingerprint);
		if (cached) return cached;
		return evaluate(input, fingerprint);
	});
}

async function evaluate(
	input: BuildDevEnvInput,
	fingerprint: string,
): Promise<DevEnvCapture> {
	const { record } = input;
	if (record.state !== "allowed" || !record.source) {
		throw new DevEnvBuildError(
			"env_not_approved",
			"the environment is not approved",
			`mfw env allow ${record.project}`,
			"",
		);
	}
	const source = record.source;
	const dir = devEnvCacheDir(input.mfwHome, input.root, fingerprint);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const staging = join(dir, `data.tmp-${randomUUID()}`);
	const result = await (input.run ?? runEnvStep)({
		step: source,
		projectRoot: input.root,
		stateDir: input.stateDir,
		mfwHome: input.mfwHome,
		commit: record.commit,
		allow: envBuildAllowlist(input.config?.extraHosts ?? []),
		dataDir: staging,
		timeoutMs:
			(input.config?.timeoutSeconds ?? DEFAULT_ENV_TIMEOUT_SECONDS) * 1000,
		...(input.steps ? { steps: input.steps } : {}),
		...(input.nixTrust ? { nixTrust: input.nixTrust } : {}),
	});
	const egress = {
		allowed: Object.keys(result.egress?.allowed ?? {}).sort(),
		denied: Object.keys(result.egress?.denied ?? {}).sort(),
	};
	if (!result.ok) {
		rmSync(staging, { recursive: true, force: true });
		throw new DevEnvBuildError(
			result.code,
			`${result.reason}${egress.denied.length ? ` (refused: ${egress.denied.join(", ")})` : ""}`,
			result.fix,
			result.log,
		);
	}
	let raw: RawEnv;
	try {
		raw = parseOutput(source, result.output);
	} catch (err) {
		rmSync(staging, { recursive: true, force: true });
		if (err instanceof DevEnvParseError) {
			throw new DevEnvBuildError(
				"bad_output",
				err.message,
				"read the log",
				result.log,
			);
		}
		throw err;
	}
	const watches =
		source === "direnv"
			? watchedRepoPaths(decodeDirenvWatches(raw.DIRENV_WATCHES))
			: [];
	const filtered = filterDevEnv(raw, { evaluationPath: result.sandboxPath });
	// A path the store does not hold cannot be bound: it is dropped, with what names it.
	const roots = filtered.storeRoots.filter(
		(p) => !p.endsWith(".drv") && exists(p),
	);
	let closure: StoreClosure = { method: "nix-store", paths: [] };
	if (roots.length > 0) {
		try {
			closure = (input.closure ?? hostStoreClosure)(roots);
		} catch (err) {
			rmSync(staging, { recursive: true, force: true });
			throw new DevEnvBuildError(
				"closure",
				`the environment's store closure cannot be computed: ${(err as Error).message}`,
				"check that nix-store works on the host",
				result.log,
			);
		}
	}
	if (closure.paths.length > DEV_ENV_LIMITS.maxClosurePaths) {
		rmSync(staging, { recursive: true, force: true });
		throw new DevEnvBuildError(
			"closure",
			`the environment needs ${closure.paths.length} store paths, more than ${DEV_ENV_LIMITS.maxClosurePaths}`,
			"make the dev shell smaller",
			result.log,
		);
	}
	const closed = closePath(filtered.path, new Set(closure.paths));
	const hasData = exists(staging) && exists(join(staging, "mise", "installs"));
	const dataDir = join(dir, "data");
	rmSync(dataDir, { recursive: true, force: true });
	if (hasData) renameSync(staging, dataDir);
	else rmSync(staging, { recursive: true, force: true });

	// What the evaluation read is part of the approved commit: protect it too.
	if (watches.length > 0) {
		try {
			const discovered = await hashCommitFiles(
				input.root,
				record.commit,
				watches,
			);
			await input.store.addDiscovered(input.root, fingerprint, discovered);
		} catch (err) {
			if (!(err instanceof EnvSourceError)) throw err;
			throw new DevEnvBuildError("watch", err.message, err.fix, result.log);
		}
	}
	const gcRooted = await (input.gcRoots ?? addGcRoots)(
		join(dir, "gcroots"),
		roots,
	);
	const capture: DevEnvCapture = {
		version: 1,
		fingerprint,
		root: input.root,
		commit: record.commit,
		source,
		env: filtered.env,
		path: closed.path,
		closure: closure.paths,
		closureMethod: roots.length > 0 ? closure.method : "none",
		hasData,
		dropped: filtered.dropped,
		droppedPath: [...filtered.droppedPath, ...closed.dropped],
		watches,
		egress,
		gcRooted,
		builtAt: (input.now ?? (() => new Date()))().toISOString(),
	};
	DevEnvCaptureSchema.parse(capture);
	await writeFileAtomic(
		join(dir, "capture.json"),
		`${JSON.stringify(capture, null, 2)}\n`,
		{
			mode: 0o600,
		},
	);
	await writeFileAtomic(join(dir, "log.txt"), result.log, { mode: 0o600 });
	return capture;
}
