import { type HarnessManifest, HarnessManifestSchema } from "./harness.ts";
import {
	type AutonomyTable,
	buildAutonomyTable,
	findAutonomyFlags,
	KNOWN_AUTONOMY,
} from "./harness-autonomy.ts";
import { BUILTIN_HARNESS_MANIFESTS } from "./harness-builtins.ts";

/**
 * The one place the core gets harness facts from. Validation has two layers:
 * the closed schema, then {@link harnessCeilingViolations}, which holds what a
 * manifest may never ask for. The sandbox compiler and the egress proxy still
 * apply on top, so a manifest can narrow a run and can never widen one.
 *
 * External manifests are refused until the plugin host (R6) exists; the load
 * API already takes an origin so R6 does not change its shape.
 */

export type HarnessOrigin = "builtin" | "external";

export interface HarnessSource {
	origin: HarnessOrigin;
	manifest: unknown;
	/** Refuse this manifest unless its `manifestVersion` is exactly this. */
	pinnedVersion?: number;
}

export type HarnessRegistryCode =
	| "external_not_enabled"
	| "invalid_manifest"
	| "ceiling_exceeded"
	| "duplicate_id"
	| "duplicate_fleet_cli"
	| "version_pin_mismatch"
	| "unknown_harness";

export class HarnessRegistryError extends Error {
	readonly code: HarnessRegistryCode;
	readonly issues: readonly string[];
	constructor(
		code: HarnessRegistryCode,
		message: string,
		issues: readonly string[] = [],
	) {
		super(issues.length ? `${message}: ${issues.join("; ")}` : message);
		this.name = "HarnessRegistryError";
		this.code = code;
		this.issues = issues;
	}
}

/**
 * The only fleet directories a harness may keep writable, until P4 replaces
 * them with per-CLI attested lists. An allowlist: a CLI loads instructions and
 * code from the rest of its config dir.
 */
export const FLEET_WRITABLE_CEILING: ReadonlySet<string> = new Set([
	"backups",
	"cache",
	"projects",
	"sessions",
	"shell_snapshots",
	"thread-writer-locks",
	"tmp",
]);

/** The fleet CLIs the sandbox profile knows, and the variable locating each. */
export const FLEET_ENV_CEILING: Readonly<Record<string, string>> = {
	claude: "CLAUDE_CONFIG_DIR",
	codex: "CODEX_HOME",
};

/** Name endings that never lead to a vendor endpoint. */
const PRIVATE_HOST_SUFFIXES = [
	".arpa",
	".home",
	".internal",
	".intranet",
	".lan",
	".local",
	".localdomain",
	".localhost",
	".onion",
	".test",
];

/** A login probe reveals whether a file exists, so these stay out of reach. */
const PROTECTED_HOME_ROOTS = new Set([
	".aws",
	".azure",
	".docker",
	".git-credentials",
	".gnupg",
	".kube",
	".netrc",
	".npmrc",
	".pgpass",
	".ssh",
]);

const isProtectedHomePath = (path: string) => {
	const parts = path.split("/");
	return (
		PROTECTED_HOME_ROOTS.has(parts[0] as string) ||
		(parts[0] === ".config" && (parts[1] === "gcloud" || parts[1] === "gh"))
	);
};

function allArgv(m: HarnessManifest): readonly (readonly string[])[] {
	return [
		m.modes.task,
		m.modes.brain ?? [],
		m.modes.inference ?? [],
		m.modes.modelArgv ?? [],
		m.readOnly.value,
		m.innerSandbox?.disableArgv ?? [],
	];
}

/**
 * Everything in this manifest that exceeds what a harness may ask for. Empty
 * means it may load. An external manifest gets the stricter half: no autonomy
 * arguments at all, no fleet dir of its own and no environment.
 */
export function harnessCeilingViolations(
	m: HarnessManifest,
	origin: HarnessOrigin,
): string[] {
	const out: string[] = [];
	if (m.sandbox.needsUserns)
		out.push("needsUserns: the sandbox always disables user namespaces");

	for (const e of m.egress) {
		if (e.port !== 443) out.push(`egress ${e.host}:${e.port}: only port 443`);
		if (PRIVATE_HOST_SUFFIXES.some((s) => e.host.endsWith(s)))
			out.push(`egress ${e.host}: a private name`);
	}

	for (const dir of m.fleet.writable)
		if (!FLEET_WRITABLE_CEILING.has(dir))
			out.push(`fleet.writable ${dir}: outside the fleet ceiling`);
	if (m.fleet.writable.length > 0 && m.fleet.cli === undefined)
		out.push("fleet.writable needs a fleet dir");
	if (m.fleet.cli !== undefined) {
		const env = FLEET_ENV_CEILING[m.fleet.cli];
		if (env === undefined)
			out.push(`fleet.cli ${m.fleet.cli}: the sandbox has no such fleet dir`);
		else if (m.fleet.env !== env)
			out.push(`fleet.env ${m.fleet.env}: ${m.fleet.cli} uses ${env}`);
	}

	for (const method of m.auth.methods)
		for (const file of method.loginFiles ?? [])
			if (isProtectedHomePath(file))
				out.push(`login file ${file}: a protected path`);
	for (const file of m.auth.remoteLoginFiles)
		if (isProtectedHomePath(file))
			out.push(`login file ${file}: a protected path`);

	// The known flags and this manifest's own: declaring one does not excuse it.
	const table = buildAutonomyTable([m.autonomy]);
	const carried = allArgv(m).flatMap((argv) => findAutonomyFlags(table, argv));
	const allowed = origin === "builtin" ? m.autonomy.launchFlags : [];
	for (const flag of new Set(carried))
		if (!allowed.includes(flag)) out.push(`argv carries autonomy: ${flag}`);

	// A mode starts the harness itself, never a shell or another program.
	const commands = [m.modes.task, m.modes.brain, m.modes.inference].flatMap(
		(argv) => (argv?.[0] === undefined ? [] : [argv[0]]),
	);
	const startable =
		origin === "builtin" ? m.sandbox.executables : [m.detect.bin];
	for (const command of new Set(commands))
		if (!startable.includes(command))
			out.push(`argv starts ${command}, which is not this harness`);
	if (m.modes.task.length === 0) out.push("modes.task is empty");

	if (origin === "external") {
		for (const exe of m.sandbox.executables)
			if (exe !== m.detect.bin)
				out.push(`sandbox.executables ${exe}: only the harness binary`);
		if (m.autonomy.launchFlags.length > 0)
			out.push("autonomy.launchFlags: built-in manifests only");
		if (m.fleet.cli !== undefined || m.fleet.writable.length > 0)
			out.push("fleet: an external harness cannot declare a fleet dir yet");
		if (Object.keys(m.env).length > 0)
			out.push("env: an external harness cannot set environment yet");
		if (Object.keys(m.telemetryOff?.env ?? {}).length > 0)
			out.push("telemetryOff.env: an external harness cannot set environment");
		if ((m.innerSandbox?.disableArgv.length ?? 0) > 0)
			out.push("innerSandbox.disableArgv: built-in manifests only");
		if (allArgv(m).some((argv) => argv.some((a) => a.includes("{prompt}"))))
			out.push("{prompt}: an external harness takes the prompt on stdin");
		for (const method of m.auth.methods)
			for (const name of method.envVars ?? [])
				if (!name.endsWith("_API_KEY") || name.startsWith("MFW_"))
					out.push(`auth env ${name}: only a *_API_KEY variable`);
	}
	return out;
}

/** What the doctor and the detector need, without the rest of the manifest. */
export interface HarnessDetectionSpec {
	id: string;
	displayName: string;
	bin: string;
	versionArgs: readonly string[];
	versionRange?: string;
	identity?: HarnessManifest["detect"]["identity"];
}

export class HarnessRegistry {
	private readonly byId: ReadonlyMap<string, HarnessManifest>;
	/** Known flags joined with every loaded manifest's. */
	readonly autonomy: AutonomyTable;

	constructor(private readonly manifests: readonly HarnessManifest[]) {
		this.byId = new Map(manifests.map((m) => [m.id, m]));
		this.autonomy = buildAutonomyTable([
			KNOWN_AUTONOMY,
			...manifests.map((m) => m.autonomy),
		]);
	}

	/** In load order, which is the order the UI lists them. */
	list(): readonly HarnessManifest[] {
		return this.manifests;
	}

	get(id: string | null | undefined): HarnessManifest | undefined {
		return id ? this.byId.get(id) : undefined;
	}

	require(id: string): HarnessManifest {
		const m = this.byId.get(id);
		if (!m)
			throw new HarnessRegistryError(
				"unknown_harness",
				`no harness '${id}', mfw knows: ${[...this.byId.keys()].join(", ")}`,
			);
		return m;
	}

	byFleetCli(cli: string): HarnessManifest {
		const m = this.manifests.find((x) => x.fleet.cli === cli);
		if (!m)
			throw new HarnessRegistryError(
				"unknown_harness",
				`no harness has the fleet dir '${cli}'`,
			);
		return m;
	}

	/** Detection facts for each harness, for the doctor and the settings panel. */
	detectionSpecs(): HarnessDetectionSpec[] {
		return this.manifests.map((m) => ({
			id: m.id,
			displayName: m.displayName,
			bin: m.detect.bin,
			versionArgs: m.detect.versionArgs,
			...(m.detect.versionRange ? { versionRange: m.detect.versionRange } : {}),
			...(m.detect.identity ? { identity: m.detect.identity } : {}),
		}));
	}
}

/** Validates every source in order. One bad manifest refuses the whole load. */
export function loadHarnessRegistry(
	sources: readonly HarnessSource[],
): HarnessRegistry {
	const loaded: HarnessManifest[] = [];
	const ids = new Set<string>();
	const fleetClis = new Set<string>();
	for (const [i, source] of sources.entries()) {
		const raw = source.manifest as { id?: unknown } | null;
		const label = typeof raw?.id === "string" ? raw.id : `#${i}`;
		if (source.origin !== "builtin")
			throw new HarnessRegistryError(
				"external_not_enabled",
				`refusing external harness manifest ${label}: the plugin host is not available yet`,
			);
		const parsed = HarnessManifestSchema.safeParse(source.manifest);
		if (!parsed.success)
			throw new HarnessRegistryError(
				"invalid_manifest",
				`harness manifest ${label} is invalid`,
				parsed.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`),
			);
		const m = parsed.data;
		const over = harnessCeilingViolations(m, source.origin);
		if (over.length > 0)
			throw new HarnessRegistryError(
				"ceiling_exceeded",
				`harness manifest ${m.id} exceeds the ceilings`,
				over,
			);
		if (ids.has(m.id))
			throw new HarnessRegistryError(
				"duplicate_id",
				`duplicate harness id ${m.id}`,
			);
		ids.add(m.id);
		if (m.fleet.cli !== undefined) {
			if (fleetClis.has(m.fleet.cli))
				throw new HarnessRegistryError(
					"duplicate_fleet_cli",
					`two harnesses claim the fleet dir ${m.fleet.cli}`,
				);
			fleetClis.add(m.fleet.cli);
		}
		if (
			source.pinnedVersion !== undefined &&
			source.pinnedVersion !== m.manifestVersion
		)
			throw new HarnessRegistryError(
				"version_pin_mismatch",
				`harness ${m.id} is version ${m.manifestVersion}, pinned to ${source.pinnedVersion}`,
			);
		loaded.push(m);
	}
	return new HarnessRegistry(loaded);
}

let builtin: HarnessRegistry | null = null;

/** The registry the daemon runs on: the built-in manifests, validated once. */
export function builtinHarnessRegistry(): HarnessRegistry {
	builtin ??= loadHarnessRegistry(
		BUILTIN_HARNESS_MANIFESTS.map((manifest) => ({
			origin: "builtin" as const,
			manifest,
		})),
	);
	return builtin;
}
