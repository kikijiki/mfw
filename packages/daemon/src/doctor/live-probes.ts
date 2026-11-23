import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { lstat, stat } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	installPath,
	LEGACY_SKILL_DIR,
	legacyPath,
	TOOL_ORDER,
} from "@mfw/board/commands/skill-targets";
import { verifyBuiltMigrations } from "@mfw/db/migration-source";
import pino from "pino";
import { ZodError } from "zod";
import { authDbPath } from "../auth/service.ts";
import { readBoardLayout } from "../board-layout.ts";
import { loadConfig, type StoredProjectConfig } from "../config.ts";
import { verifyExecPin } from "../containment/exec-pin.ts";
import {
	type FsInfo,
	type HostReaders,
	liveHostReaders,
	type RunResult,
} from "../containment/host-caps.ts";
import { BUILT_HOST_SCRIPTS, hostScript } from "../containment/host-script.ts";
import { gitRaw } from "../git.ts";
import { runProc } from "../proc.ts";
import {
	LEGACY_ACK_TABLE,
	LEGACY_HOST_TABLES,
	legacyRowsMatch,
} from "../resources/legacy-host-state.ts";
import { pinnedToolIn } from "../sandbox.ts";
import { ArmingStore } from "../triggers/arming.ts";
import { loadTriggerDefs } from "../triggers/def.ts";
import type {
	AuthFacts,
	BuildFacts,
	DoctorProbes,
	FileList,
	LegacyHostFacts,
	PathStat,
	ProjectFacts,
	ToolLookup,
	TriggerFacts,
} from "./probes.ts";
import { withReadOnlyDb } from "./readonly-db.ts";

/**
 * The real probes. Nothing here writes:
 *  - databases are read as bytes into a private in-memory copy;
 *  - secret files are only stat'ed;
 *  - git runs through the hardened helper with optional locks off;
 *  - a binary is run only from a PATH entry an agent cannot write, with no
 *    home directory, so a CLI's `--version` cannot reach its credentials.
 */

const TOOL_TIMEOUT_MS = 3_000;
const GIT_TIMEOUT_MS = 5_000;
const MAX_LIST_BYTES = 2 * 1024 * 1024;
const SAMPLE = 5;

export interface LiveProbeOptions {
	env: Record<string, string | undefined>;
	home: string;
	/** Root of this install; defaults to the one this module runs from. */
	installRoot?: string;
	exposure?: DoctorProbes["exposure"];
	/** Test seam: directories treated as agent-writable. */
	writableRoots?: readonly string[];
}

/** This install's root, from source or from inside the production bundle. */
export function installRootFrom(moduleUrl: string): string {
	const file = fileURLToPath(moduleUrl);
	const marker = "/apps/start/.output/";
	const at = file.lastIndexOf(marker);
	return at >= 0 ? file.slice(0, at) : resolve(dirname(file), "../../../..");
}

const count = (db: Database, sql: string, ...args: number[]): number =>
	(db.query(sql).get(...args) as { n: number } | null)?.n ?? 0;

function readAuth(home: string): AuthFacts {
	const path = authDbPath(home);
	if (!existsSync(path)) return { state: "absent" };
	try {
		return withReadOnlyDb(path, (db) => {
			const now = Date.now();
			// Only whether a hash exists. The hash itself is never selected.
			const owner = db
				.query(
					"SELECT length(password_hash) > 0 AS has FROM principals WHERE kind = 'owner' LIMIT 1",
				)
				.get() as { has: number } | null;
			return {
				state: "ready" as const,
				owner: owner !== null,
				passwordSet: owner?.has === 1,
				liveTokens: count(
					db,
					"SELECT count(*) AS n FROM api_tokens WHERE revoked_at IS NULL AND expires_at > ?",
					now,
				),
				pendingSetup:
					count(
						db,
						"SELECT count(*) AS n FROM setup_tokens WHERE expires_at > ?",
						now,
					) > 0,
			};
		});
	} catch (e) {
		return { state: "unreadable", reason: (e as Error).message };
	}
}

function readLegacyHost(home: string): LegacyHostFacts {
	const path = join(home, "host", "host.db");
	if (!existsSync(path)) return { state: "none" };
	try {
		return withReadOnlyDb(path, (db): LegacyHostFacts => {
			const has = (name: string) =>
				db
					.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
					.get(name) !== null;
			const rows: Record<string, number> = {};
			for (const table of LEGACY_HOST_TABLES) {
				if (!has(table)) continue;
				const n = count(db, `SELECT count(*) AS n FROM "${table}"`);
				if (n > 0) rows[table] = n;
			}
			if (Object.keys(rows).length === 0) return { state: "none" };
			const recorded = has(LEGACY_ACK_TABLE)
				? (
						db
							.query(
								`SELECT counts_json AS j FROM ${LEGACY_ACK_TABLE} WHERE singleton=1`,
							)
							.get() as { j: string } | null
					)?.j
				: undefined;
			return recorded && legacyRowsMatch(JSON.parse(recorded), rows)
				? { state: "acknowledged", rows }
				: { state: "unacknowledged", rows };
		});
	} catch (e) {
		return { state: "unreadable", reason: (e as Error).message };
	}
}

function readBuild(
	installRoot: string,
	env: LiveProbeOptions["env"],
): BuildFacts {
	const output = join(installRoot, "apps", "start", ".output");
	if (!existsSync(join(output, "server"))) return { kind: "source" };
	const moduleUrl = pathToFileURL(join(output, "server", "index.mjs")).href;
	let hostScripts: string | null = null;
	try {
		for (const script of BUILT_HOST_SCRIPTS) hostScript(moduleUrl, script);
	} catch (e) {
		hostScripts = (e as Error).message;
	}
	let migrations: string | null = null;
	if (env.MFW_MIGRATIONS_DIR) {
		migrations =
			"MFW_MIGRATIONS_DIR is set, and a production build refuses it. Unset it";
	} else {
		try {
			verifyBuiltMigrations(`${output}/`);
		} catch (e) {
			migrations = (e as Error).message;
		}
	}
	return { kind: "build", hostScripts, migrations };
}

/** `-z` output as a bounded list. A cut-off last name is dropped. */
export function fileList(stdout: string, truncated: boolean): FileList {
	const names = stdout.split("\0");
	const last = names.pop();
	if (!truncated && last) names.push(last);
	return {
		count: names.length,
		sample: names.slice(0, SAMPLE),
		truncated,
	};
}

async function listFiles(
	root: string,
	args: string[],
): Promise<FileList | null> {
	const r = await gitRaw(["--no-optional-locks", "ls-files", ...args], root, {
		env: { GIT_OPTIONAL_LOCKS: "0" },
		timeoutMs: GIT_TIMEOUT_MS,
		maxOutputBytes: MAX_LIST_BYTES,
	}).catch(() => null);
	if (!r || r.timedOut || (!r.ok && !r.truncated)) return null;
	return fileList(r.stdout, r.truncated);
}

async function readRemotes(root: string): Promise<ProjectFacts["remotes"]> {
	const r = await gitRaw(
		["config", "--local", "--get-regexp", "^remote\\..*\\.url$"],
		root,
		{ timeoutMs: GIT_TIMEOUT_MS },
	).catch(() => null);
	if (!r?.ok) return [];
	const remotes: ProjectFacts["remotes"] = [];
	for (const line of r.stdout.split("\n")) {
		const m = /^remote\.(.+)\.url (.+)$/.exec(line);
		if (m) remotes.push({ name: m[1] as string, url: m[2] as string });
	}
	return remotes;
}

async function readTriggers(
	home: string,
	entry: StoredProjectConfig,
): Promise<TriggerFacts> {
	const facts: TriggerFacts = {
		armedCurrent: 0,
		drifted: [],
		quarantined: [],
		unarmed: 0,
	};
	const dir = join(entry.root, ".mfw", "triggers");
	// The shared loader creates a missing directory, and the doctor writes nothing.
	if (!existsSync(dir)) return facts;
	let records: Awaited<ReturnType<ArmingStore["load"]>>;
	try {
		records = await ArmingStore.at(home, entry.name).load();
	} catch {
		// The loader's message can quote the file, so it is not repeated.
		return { ...facts, error: "the file is malformed" };
	}
	const { defs, quarantined } = await loadTriggerDefs(
		dir,
		pino({ level: "silent" }),
	);
	facts.quarantined = quarantined.map((q) => q.id ?? q.file);
	for (const def of defs) {
		const record = records[def.id];
		if (!record) {
			facts.unarmed++;
			continue;
		}
		let current = record.hash === def.hash && !record.disarmed;
		if (current && def.action.kind === "script") {
			current =
				record.execPin !== undefined &&
				(
					await verifyExecPin(record.execPin, {
						root: entry.root,
						gitCwd: entry.root,
						rev: "HEAD",
					})
				).ok;
		}
		if (current) facts.armedCurrent++;
		else facts.drifted.push(def.id);
	}
	return facts;
}

/** The config's validity, without repeating anything the file contains. */
function configError(e: unknown): string {
	if (e instanceof SyntaxError) return "it is not valid JSON";
	if (e instanceof ZodError) {
		const where = e.issues
			.slice(0, 3)
			.map((i) => i.path.join(".") || "(root)")
			.join(", ");
		return `invalid values at: ${where}`;
	}
	return (e as NodeJS.ErrnoException).code ?? "it could not be read";
}

export function liveDoctorProbes(o: LiveProbeOptions): DoctorProbes {
	const { env, home } = o;
	const installRoot = o.installRoot ?? installRootFrom(import.meta.url);
	const pathVar = env.PATH;
	const trusted = (name: string) =>
		pinnedToolIn(name, pathVar, o.writableRoots);

	const run = async (argv: string[]): Promise<RunResult | undefined> => {
		const bin = argv[0] ?? "";
		const path = bin.startsWith("/") ? bin : trusted(bin);
		if (!path) return undefined;
		try {
			const res = await runProc([path, ...argv.slice(1)], {
				cwd: "/",
				timeoutMs: TOOL_TIMEOUT_MS,
				maxOutputBytes: 64 * 1024,
				env: {
					PATH: pathVar ?? "",
					...(env.XDG_RUNTIME_DIR
						? { XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR }
						: {}),
					...(env.DBUS_SESSION_BUS_ADDRESS
						? { DBUS_SESSION_BUS_ADDRESS: env.DBUS_SESSION_BUS_ADDRESS }
						: {}),
				},
			});
			if (res.timedOut || res.exitCode === 127) return undefined;
			return { code: res.exitCode, stdout: res.stdout };
		} catch {
			return undefined;
		}
	};

	/** The nearest existing parent, so a home not created yet is still placed. */
	const fsInfo = async (path: string): Promise<FsInfo | undefined> => {
		let at = path;
		while (at !== "/" && !existsSync(at)) at = dirname(at);
		try {
			const st = await stat(at);
			const out = await run(["findmnt", "-n", "-o", "SOURCE,FSTYPE", "-T", at]);
			const m = /^(\S+)\s+(\S+)$/.exec(out?.stdout.trim().split("\n")[0] ?? "");
			return { dev: st.dev, source: m?.[1] ?? "", fstype: m?.[2] ?? "unknown" };
		} catch {
			return undefined;
		}
	};

	const host: HostReaders = {
		...liveHostReaders(),
		run,
		fsInfo,
		// The real probe writes a file. From the filesystem type alone: XFS
		// depends on how it was formatted, so it stays unknown.
		reflink: async (dir) => {
			const fstype = (await fsInfo(dir))?.fstype;
			if (fstype === "btrfs") return true;
			if (fstype === undefined || fstype === "xfs" || fstype === "unknown") {
				return undefined;
			}
			return false;
		},
	};

	const tool = async (name: string): Promise<ToolLookup> => {
		const path = trusted(name);
		if (path) return { path };
		for (const dir of (pathVar ?? "").split(delimiter)) {
			if (!dir) continue;
			const candidate = join(dir, name);
			if (existsSync(candidate))
				return { path: null, untrustedPath: candidate };
		}
		return { path: null };
	};

	const toolVersion = async (path: string, flag = "--version") => {
		try {
			const res = await runProc([path, flag], {
				cwd: "/",
				timeoutMs: TOOL_TIMEOUT_MS,
				maxOutputBytes: 4096,
				// No HOME: a CLI's version flag has no reason to find its login.
				env: {
					PATH: dirname(path),
					HOME: "/nonexistent",
					NO_COLOR: "1",
					LC_ALL: "C",
				},
			});
			if (res.timedOut || res.exitCode !== 0) return undefined;
			return /\d+\.\d+(?:\.\d+)?[a-z]?/.exec(res.stdout)?.[0];
		} catch {
			return undefined;
		}
	};

	const statPath = async (path: string): Promise<PathStat | null> => {
		try {
			// `$MFW_HOME` may be a link; a link in place of a secret file is "other".
			const st = path === home ? await stat(path) : await lstat(path);
			return {
				kind: st.isFile() ? "file" : st.isDirectory() ? "dir" : "other",
				mode: st.mode & 0o7777,
				uid: st.uid,
			};
		} catch {
			return null;
		}
	};

	const project = async (entry: StoredProjectConfig): Promise<ProjectFacts> => {
		const root = entry.root;
		const rootExists = existsSync(root);
		const isGit = rootExists && existsSync(join(root, ".git"));
		const empty: FileList = { count: 0, sample: [], truncated: false };
		if (!isGit) {
			return {
				rootExists,
				isGit,
				hasEnvrc: rootExists && (await statPath(join(root, ".envrc"))) !== null,
				remotes: [],
				untracked: empty,
				ignoredState: empty,
				boardPush: null,
				triggers: { armedCurrent: 0, drifted: [], quarantined: [], unarmed: 0 },
			};
		}
		const [remotes, untracked, ignoredState, layout, triggers, envrc] =
			await Promise.all([
				readRemotes(root),
				listFiles(root, ["--others", "--exclude-standard", "-z"]),
				listFiles(root, [
					"--others",
					"--ignored",
					"--exclude-standard",
					"-z",
					"--",
					".mfw",
				]),
				readBoardLayout(root),
				readTriggers(home, entry),
				statPath(join(root, ".envrc")),
			]);
		return {
			rootExists,
			isGit,
			hasEnvrc: envrc !== null,
			remotes,
			untracked,
			ignoredState,
			boardPush: layout?.push ?? null,
			triggers,
		};
	};

	return {
		env,
		home,
		uid: host.uid,
		bunVersion: Bun.version,
		host,
		tool,
		toolVersion,
		stat: statPath,
		config: async () => {
			try {
				return { ok: true, config: await loadConfig(home) };
			} catch (e) {
				return { ok: false, error: configError(e) };
			}
		},
		auth: async () => readAuth(home),
		legacyHost: async () => readLegacyHost(home),
		build: async () => readBuild(installRoot, env),
		...(o.exposure ? { exposure: o.exposure } : {}),
		legacySkills: async (projectRoots) => {
			const paths = new Set<string>();
			const skillEnv = env as Parameters<typeof installPath>[3];
			for (const tool of TOOL_ORDER) {
				const installs = [
					installPath(tool, "global", home, skillEnv),
					...projectRoots.map((r) => installPath(tool, "project", r, skillEnv)),
				];
				for (const p of installs) {
					const legacy = legacyPath(p);
					if (legacy.includes(`/${LEGACY_SKILL_DIR}/`) && existsSync(legacy)) {
						paths.add(legacy);
					}
				}
			}
			return { available: true, paths: [...paths] };
		},
		project,
	};
}
