import type { DaemonConfig, StoredProjectConfig } from "../config.ts";
import type { HostReaders } from "../containment/host-caps.ts";

/**
 * Everything the doctor may look at. The checks are pure over this interface,
 * so each runs against a fixture host; `live-probes.ts` is the real one and
 * holds the read-only guarantees.
 */

export interface PathStat {
	kind: "file" | "dir" | "other";
	mode: number;
	uid: number;
}

export interface ToolLookup {
	/** On a PATH entry an agent cannot write. Only this path is ever executed. */
	path: string | null;
	/** `path` with symlinks resolved, when it differs. */
	realPath?: string;
	/** Found only somewhere an agent could have planted it. Never executed. */
	untrustedPath?: string;
}

/** Counts and names only: the doctor never reads the secrets themselves. */
export type AuthFacts =
	| { state: "absent" }
	| { state: "unreadable"; reason: string }
	| {
			state: "ready";
			owner: boolean;
			passwordSet: boolean;
			liveTokens: number;
			pendingSetup: boolean;
	  };

export type LegacyHostFacts =
	| { state: "none" }
	| { state: "acknowledged"; rows: Record<string, number> }
	| { state: "unacknowledged"; rows: Record<string, number> }
	| { state: "unreadable"; reason: string };

export type BuildFacts =
	| { kind: "source" }
	| {
			kind: "build";
			/** Why the host script manifest does not verify, or null. */
			hostScripts: string | null;
			/** Why the migration manifest does not verify, or null. */
			migrations: string | null;
	  };

export interface FileList {
	count: number;
	/** The first few names, for the report. */
	sample: string[];
	truncated: boolean;
}

export interface TriggerFacts {
	armedCurrent: number;
	/** Armed, but the definition or a pinned file changed since. */
	drifted: string[];
	quarantined: string[];
	unarmed: number;
	/** The arming store could not be read. */
	error?: string;
}

export interface ProjectFacts {
	rootExists: boolean;
	isGit: boolean;
	hasEnvrc: boolean;
	/** Why host git refuses this repository, or null. */
	gitConfigRefusal: string | null;
	remotes: { name: string; url: string }[];
	/** Not ignored and not tracked; null when git could not answer. */
	untracked: FileList | null;
	/** Ignored files under `.mfw`, which no clone or push carries. */
	ignoredState: FileList | null;
	boardPush: "with-code" | "board-repo" | "untracked" | null;
	triggers: TriggerFacts;
}

export interface DoctorProbes {
	env: Record<string, string | undefined>;
	home: string;
	uid: number;
	bunVersion: string;
	host: HostReaders;
	tool(name: string): Promise<ToolLookup>;
	/** The parsed version from a trusted binary. Raw output never leaves the probe. */
	toolVersion(
		path: string,
		args?: string | readonly string[],
	): Promise<string | undefined>;
	stat(path: string): Promise<PathStat | null>;
	config(): Promise<
		{ ok: true; config: DaemonConfig } | { ok: false; error: string }
	>;
	auth(): Promise<AuthFacts>;
	legacyHost(): Promise<LegacyHostFacts>;
	build(): Promise<BuildFacts>;
	/** The server's own exposure policy. Absent means the check is skipped. */
	exposure?: (env: Record<string, string | undefined>) => {
		problem: string | null;
		warnings: string[];
	};
	legacySkills(
		projectRoots: readonly string[],
	): Promise<{ available: boolean; paths: string[] }>;
	project(entry: StoredProjectConfig): Promise<ProjectFacts>;
}
