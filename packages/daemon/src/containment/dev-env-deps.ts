/**
 * The deps layer of the dev environment (design "Dev environment runs inside
 * the sandbox"). Dependencies such as `node_modules` cannot be installed in a
 * run, which has no registry access, so the approved `env.setup` commands run
 * once per approval in the env-install sandbox:
 *
 * - a disposable clone of the approved commit, with the evaluated environment
 *   applied (its tools on PATH, its store closure read-only);
 * - egress only to the package registries (dev-env-egress.ts): the lockfiles'
 *   defaults, or exactly `env.registries`;
 * - lifecycle scripts (`postinstall` and the like) run there and nowhere else.
 *
 * What setup produced (`env.outputs`, by default the node_modules
 * directories) is moved out of the clone into the cache entry of the approval,
 * whose fingerprint already covers the lockfiles and the setup commands, and
 * copied into every later task and verifier clone with a reflink where the
 * filesystem has one (btrfs, XFS) and a plain copy otherwise.
 */

import { randomUUID } from "node:crypto";
import {
	lstatSync,
	mkdirSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { KeyedLock } from "@mfw/board-core";
import { writeFileAtomic } from "@mfw/core/fsatomic";
import { z } from "zod";
import { runProc } from "../proc.ts";
import { findUnsafeSymlink } from "../run-workspace/caches.ts";
import {
	type EnvRunRequest,
	type EnvRunResult,
	runEnvStep,
} from "./dev-env-build.ts";
import { DevEnvBuildError } from "./dev-env-cache.ts";
import {
	type DevEnvCapture,
	devEnvBindRoot,
	devEnvCacheDir,
	devEnvSection,
} from "./dev-env-cached.ts";
import {
	DEFAULT_ENV_TIMEOUT_SECONDS,
	type EnvConfig,
} from "./dev-env-config.ts";
import { envInstallAllowlist } from "./dev-env-egress.ts";
import { DEPS_LOCKFILES, type EnvFile } from "./dev-env-sources.ts";
import {
	type EnvTrustRecord,
	envFingerprint,
	envHome,
	hasSetup,
	lockfileKey,
} from "./dev-env-trust.ts";
import { readRegularFile } from "./safe-file.ts";

export const DEFAULT_DEPS_OUTPUTS: readonly string[] = [
	"node_modules",
	"packages/*/node_modules",
	"apps/*/node_modules",
];

const DepsManifestSchema = z.strictObject({
	version: z.literal(1),
	fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
	lockKey: z.string().regex(/^[0-9a-f]{64}$/),
	/** The commit installed from: the approved one, or a later one whose lockfiles alone changed. */
	commit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
	outputs: z.array(z.string()).max(1024),
	egress: z.strictObject({
		allowed: z.array(z.string()).max(256),
		denied: z.array(z.string()).max(256),
	}),
	builtAt: z.string(),
});

export interface DepsEntry {
	/** Holds each output at its tree path. */
	dir: string;
	/** Tree-relative directories, sorted. */
	outputs: string[];
	egress: { allowed: string[]; denied: string[] };
}

/** One install per environment definition and package lockfile content. */
export const depsDir = (
	mfwHome: string,
	root: string,
	fingerprint: string,
	lockKey: string,
) => {
	if (!/^[0-9a-f]{64}$/.test(lockKey)) throw new Error("not a lockfile key");
	return join(devEnvCacheDir(mfwHome, root, fingerprint), "deps", lockKey);
};

/** The installed dependencies of an approval, or null. */
export async function loadDeps(
	mfwHome: string,
	root: string,
	fingerprint: string,
	lockKey: string,
): Promise<DepsEntry | null> {
	const dir = depsDir(mfwHome, root, fingerprint, lockKey);
	const r = await readRegularFile(join(dir, "deps.json"), 1024 * 1024);
	if (!r || r.size > 1024 * 1024) return null;
	try {
		const m = DepsManifestSchema.parse(JSON.parse(r.buffer.toString("utf8")));
		if (m.fingerprint !== fingerprint || m.lockKey !== lockKey) return null;
		return { dir: join(dir, "tree"), outputs: m.outputs, egress: m.egress };
	} catch {
		return null;
	}
}

function isRealDir(p: string): boolean {
	try {
		return lstatSync(p).isDirectory();
	} catch {
		return false;
	}
}

/** The tree paths `patterns` name that exist as real directories, never through a link. */
export function expandOutputs(
	tree: string,
	patterns: readonly string[],
): string[] {
	const out = new Set<string>();
	for (const pattern of patterns) {
		const parts = pattern.split("/");
		const star = parts.indexOf("*");
		const candidates: string[][] = [];
		if (star < 0) {
			candidates.push(parts);
		} else {
			const parent = join(tree, ...parts.slice(0, star));
			if (!isRealDir(parent)) continue;
			for (const name of readdirSync(parent).sort()) {
				candidates.push([
					...parts.slice(0, star),
					name,
					...parts.slice(star + 1),
				]);
			}
		}
		for (const c of candidates) {
			// Every component, not only the last, must be a real directory.
			let ok = true;
			for (let i = 1; i <= c.length; i++) {
				if (!isRealDir(join(tree, ...c.slice(0, i)))) {
					ok = false;
					break;
				}
			}
			if (ok) out.add(c.join("/"));
		}
	}
	return [...out].sort();
}

async function moveOutputs(
	tree: string,
	staging: string,
	patterns: readonly string[],
): Promise<string[]> {
	const outputs = expandOutputs(tree, patterns);
	for (const rel of outputs) {
		const src = join(tree, rel);
		const unsafe = await findUnsafeSymlink(src, tree);
		if (unsafe) {
			throw new DevEnvBuildError(
				"deps_unsafe",
				`setup left a link that leaves the tree: ${unsafe}`,
				"fix the install so its links stay inside the project",
				"",
			);
		}
		const dst = join(staging, "tree", rel);
		mkdirSync(dirname(dst), { recursive: true, mode: 0o700 });
		try {
			renameSync(src, dst);
		} catch {
			const r = await runProc(["cp", "-a", "--reflink=auto", "--", src, dst], {
				timeoutMs: 10 * 60_000,
			});
			if (r.exitCode !== 0) {
				throw new DevEnvBuildError(
					"deps_copy",
					`cannot keep ${rel}: ${(r.stderr || r.stdout).trim().slice(0, 300)}`,
					"check the free space under $MFW_HOME",
					"",
				);
			}
		}
	}
	return outputs;
}

export interface InstallDepsInput {
	mfwHome: string;
	root: string;
	stateDir: string;
	record: EnvTrustRecord;
	capture: DevEnvCapture;
	config: EnvConfig | undefined;
	/**
	 * The commit to install from. Its environment definition is the approved
	 * one (the caller checked), so only its package lockfiles may differ.
	 */
	commit: string;
	/** The package lockfiles and `package.json` at `commit`. */
	lockfiles: readonly EnvFile[];
	run?: (req: EnvRunRequest) => Promise<EnvRunResult>;
	steps?: EnvRunRequest["steps"];
	now?: () => Date;
}

const inFlight = new Map<string, Promise<DepsEntry | null>>();

/** Run `env.setup` for an approval, or return what an earlier run kept. Throws DevEnvBuildError. */
export function installDeps(
	input: InstallDepsInput,
): Promise<DepsEntry | null> {
	if (!hasSetup(input.config)) return Promise.resolve(null);
	const fingerprint = envFingerprint(input.record);
	const lockKey = lockfileKey(input.lockfiles);
	const key = `${input.root}\0${fingerprint}\0${lockKey}`;
	const running = inFlight.get(key);
	if (running) return running;
	const lock = new KeyedLock(join(envHome(input.mfwHome), "locks"), {
		timeoutMs:
			(input.config?.timeoutSeconds ?? DEFAULT_ENV_TIMEOUT_SECONDS) * 1000 +
			120_000,
	});
	const p = lock
		.with(`deps-${fingerprint}-${lockKey}`, async () => {
			const cached = await loadDeps(
				input.mfwHome,
				input.root,
				fingerprint,
				lockKey,
			);
			return cached ?? install(input, fingerprint, lockKey);
		})
		.finally(() => inFlight.delete(key));
	inFlight.set(key, p);
	return p;
}

async function install(
	input: InstallDepsInput,
	fingerprint: string,
	lockKey: string,
): Promise<DepsEntry> {
	const config = input.config ?? {};
	const dir = depsDir(input.mfwHome, input.root, fingerprint, lockKey);
	const staging = join(dirname(dir), `deps.tmp-${randomUUID()}`);
	mkdirSync(staging, { recursive: true, mode: 0o700 });
	const lockfiles = input.lockfiles
		.map((f) => f.path)
		.filter((p) => DEPS_LOCKFILES.includes(p));
	let outputs: string[] = [];
	try {
		const result = await (input.run ?? runEnvStep)({
			step: "setup",
			commands: config.setup ?? [],
			lifecycleScripts: (config.trustedDependencies ?? []).length > 0,
			projectRoot: input.root,
			stateDir: input.stateDir,
			mfwHome: input.mfwHome,
			commit: input.commit,
			allow: envInstallAllowlist(lockfiles, config.registries),
			timeoutMs: (config.timeoutSeconds ?? DEFAULT_ENV_TIMEOUT_SECONDS) * 1000,
			devEnv: {
				grant: devEnvSection(input.mfwHome, input.capture),
				bindRoot: devEnvBindRoot(input.mfwHome, input.capture),
			},
			collectTree: async (tree) => {
				outputs = await moveOutputs(
					tree,
					staging,
					config.outputs ?? DEFAULT_DEPS_OUTPUTS,
				);
			},
			...(input.steps ? { steps: input.steps } : {}),
		});
		const egress = {
			allowed: Object.keys(result.egress?.allowed ?? {}).sort(),
			denied: Object.keys(result.egress?.denied ?? {}).sort(),
		};
		if (!result.ok) {
			throw new DevEnvBuildError(
				"deps_failed",
				`setup failed: ${result.reason}${egress.denied.length ? ` (refused: ${egress.denied.join(", ")})` : ""}`,
				result.fix,
				result.log,
			);
		}
		mkdirSync(join(staging, "tree"), { recursive: true, mode: 0o700 });
		await writeFileAtomic(
			join(staging, "deps.json"),
			`${JSON.stringify(
				{
					version: 1,
					fingerprint,
					lockKey,
					commit: input.commit,
					outputs,
					egress,
					builtAt: (input.now ?? (() => new Date()))().toISOString(),
				},
				null,
				2,
			)}\n`,
			{ mode: 0o600 },
		);
		await writeFileAtomic(join(staging, "log.txt"), result.log, {
			mode: 0o600,
		});
		rmSync(dir, { recursive: true, force: true });
		renameSync(staging, dir);
		return { dir: join(dir, "tree"), outputs, egress };
	} catch (err) {
		rmSync(staging, { recursive: true, force: true });
		throw err;
	}
}

/**
 * Copy the installed dependencies into a fresh clone, before any sandbox runs
 * in it. A path the commit already tracks is left alone. Throws on a failed
 * copy: a clone without its dependencies would fail its checks for a reason
 * that is not the code's.
 */
export async function seedDeps(
	tree: string,
	entry: DepsEntry,
): Promise<string[]> {
	const realTree = realpathSync(tree);
	const seeded: string[] = [];
	for (const rel of entry.outputs) {
		const src = join(entry.dir, rel);
		const dst = join(realTree, rel);
		if (!isRealDir(src)) continue;
		try {
			lstatSync(dst);
			continue;
		} catch {}
		// No component may be a link: a tracked symlink would carry the copy,
		// or the directories made for it, out of the tree. Checked before
		// anything is created.
		const parts = rel.split("/");
		for (let i = 1; i < parts.length; i++) {
			const p = join(realTree, ...parts.slice(0, i));
			let st: ReturnType<typeof lstatSync> | null = null;
			try {
				st = lstatSync(p);
			} catch {}
			if (st && !st.isDirectory()) {
				throw new Error(
					`${rel} would be copied through ${parts.slice(0, i).join("/")}, which is not a directory`,
				);
			}
		}
		mkdirSync(dirname(dst), { recursive: true });
		const r = await runProc(["cp", "-a", "--reflink=auto", "--", src, dst], {
			timeoutMs: 10 * 60_000,
		});
		if (r.exitCode !== 0) {
			rmSync(dst, { recursive: true, force: true });
			throw new Error(
				`cannot copy ${rel} into the clone: ${(r.stderr || r.stdout).trim().slice(0, 300)}`,
			);
		}
		seeded.push(rel);
	}
	return seeded;
}
