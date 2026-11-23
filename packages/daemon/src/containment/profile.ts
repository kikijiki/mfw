/**
 * SandboxProfile: the closed, versioned contract every sandbox backend
 * compiles (design "SandboxProfile").
 *
 * - Closed: every object is strict, so an unknown key is a rejection.
 * - Omitted means deny: no section grants anything by being absent. No
 *   workspace, no scratch, no caches, no fleet config, no network, and the
 *   smallest resource limits.
 * - Unenforceable means rejected: the hardening fields accept only their one
 *   enforced value, so `seccomp: "off"` or `userns: "allowed"` cannot parse.
 *   A weaker tier is a separate, recorded decision and has no spelling here.
 * - Narrow only: project config goes through {@link narrowProfile}, whose
 *   input can only remove access.
 *
 * Sandbox-side paths are not configurable. The compiler owns them, so a
 * profile cannot mount anything over `/proc`, `/etc` or the toolchain.
 */

import { posix } from "node:path";
import { z } from "zod";
import type { LimitsSpec } from "./limits.ts";

export const SANDBOX_PROFILE_VERSION = 1;

export const PROFILE_ROLES = [
	"task",
	"repair",
	"verifier",
	"merge-verify",
	"reviewer",
	"plan",
	"import",
	"brain",
	"trigger",
] as const;

/** The limits an omitted `resources` section means. */
export const MINIMAL_LIMITS: Readonly<LimitsSpec> = {
	tasksMax: 256,
	memoryMax: "1G",
};

function hasControlChar(s: string): boolean {
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c < 0x20 || c === 0x7f) return true;
	}
	return false;
}

function isCanonicalAbsolute(p: string): boolean {
	return (
		p.length > 1 &&
		p.length <= 4096 &&
		p.startsWith("/") &&
		!p.endsWith("/") &&
		!hasControlChar(p) &&
		posix.normalize(p) === p
	);
}

const AbsolutePath = z
	.string()
	.refine(isCanonicalAbsolute, "must be a canonical absolute path, not /");

const RelativeDir = z
	.string()
	.max(255)
	.refine(
		(p) =>
			!p.startsWith("/") &&
			!hasControlChar(p) &&
			p
				.split("/")
				.every(
					(s) => s !== "" && s !== "." && s !== ".." && !s.startsWith("-"),
				),
		"must be a relative directory with no empty, '.', '..' or dash-leading segment",
	);

const Access = z.enum(["ro", "rw"]);

const BinaryName = z
	.string()
	.min(1)
	.max(4096)
	.refine(
		(b) =>
			!hasControlChar(b) &&
			!b.startsWith("-") &&
			(b.startsWith("/") ? isCanonicalAbsolute(b) : !b.includes("/")),
		"must be a bare binary name or a canonical absolute path",
	);

const WorkspaceSection = z.strictObject({
	source: AbsolutePath,
	/** Kept outside the work tree (design "Placement"); same access as the tree. */
	gitDir: AbsolutePath.optional(),
	access: Access,
});

const CacheSection = z.strictObject({
	name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
	source: AbsolutePath,
	access: Access,
});

const FleetConfigSection = z.strictObject({
	cli: z.enum(["claude", "codex"]),
	source: AbsolutePath,
	/** Directories under `source` that stay writable; everything else is read-only. */
	writable: z.array(RelativeDir).max(64),
	/**
	 * Where those directories really live for this run. They are mounted over
	 * the shared ones, so nothing a run writes reaches another run.
	 */
	privateState: AbsolutePath.optional(),
});

/**
 * The run directory (`run-dir.ts`). Only its `control/` (always read-only) and
 * `outbox/` are mounted; `source` itself is never bound.
 */
const RunDirSection = z.strictObject({
	source: AbsolutePath,
	outbox: Access,
});

const FilesystemSection = z.strictObject({
	workspace: WorkspaceSection.optional(),
	runDir: RunDirSection.optional(),
	scratch: z.literal("tmpfs").optional(),
	caches: z
		.array(CacheSection)
		.max(32)
		.refine(
			(caches) => new Set(caches.map((c) => c.name)).size === caches.length,
			// A later bind would shadow an earlier one at the same /cache/<name>.
			"cache names must be unique",
		)
		.optional(),
	toolchain: z
		.strictObject({ binaries: z.array(BinaryName).max(128) })
		.optional(),
	fleetConfig: FleetConfigSection.optional(),
	/** Host paths no bind may equal, contain or sit inside. Deny wins. */
	deny: z.array(AbsolutePath).max(256).optional(),
});

/**
 * The env names a profile may set: an allowlist, because the variables that
 * change how a program loads code cannot be enumerated (`LD_*`, `GCONV_PATH`,
 * `GLIBC_TUNABLES`, `JAVA_TOOL_OPTIONS`, `ZDOTDIR`, and more each release).
 * Everything the sandbox itself needs (`PATH`, `HOME`, proxy, git) is set by
 * the compiler. Named workload secrets use the `MFW_GRANT_` namespace.
 */
const ALLOWED_ENV: ReadonlySet<string> = new Set([
	"CI",
	"NO_COLOR",
	"FORCE_COLOR",
	"RUST_BACKTRACE",
	"ANTHROPIC_API_KEY",
	"OPENAI_API_KEY",
	"OPENROUTER_API_KEY",
	"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
	"DISABLE_TELEMETRY",
	"DISABLE_ERROR_REPORTING",
	"DISABLE_AUTOUPDATER",
	"DO_NOT_TRACK",
	"ENABLE_CLAUDEAI_MCP_SERVERS",
	// The run's identity, set by the engine. MFW_REPORT_PATH is a sandbox path.
	"MFW_RUN_ID",
	"MFW_PROJECT",
	"MFW_TASK_ID",
	"MFW_RUN_KIND",
	"MFW_REPORT_PATH",
	// Keeps a run's transcripts and memory out of the shared `-work` slug.
	"CLAUDE_CODE_PROJECT_DIR_NAME",
]);
const GRANT_ENV = /^MFW_GRANT_[A-Z0-9][A-Z0-9_]{0,100}$/;

export function isAllowedEnvName(name: string): boolean {
	return ALLOWED_ENV.has(name) || GRANT_ENV.test(name);
}

const EnvName = z
	.string()
	.refine(isAllowedEnvName, "is not on the sandbox env allowlist");

const EnvValue = z
	.string()
	.max(32_768)
	.refine((v) => !v.includes("\0"), "must not contain NUL");

const ProcessSection = z.strictObject({
	env: z.record(EnvName, EnvValue).optional(),
	userns: z.literal("disabled").optional(),
	seccomp: z.literal("denylist").optional(),
	terminal: z.literal("none").optional(),
});

const NetworkSection = z.discriminatedUnion("mode", [
	z.strictObject({ mode: z.literal("none") }),
	z.strictObject({
		mode: z.literal("proxy"),
		/** Host directory holding only this run's proxy socket. */
		socketDir: AbsolutePath,
	}),
]);

const ResourcesSection = z.strictObject({
	tasksMax: z.number().int().min(1).max(1_000_000),
	memoryMax: z.string().regex(/^[1-9][0-9]{0,8}[KMGT]$/),
});

const LifecycleSection = z.strictObject({
	dieWithParent: z.literal(true).optional(),
	newSession: z.literal(true).optional(),
});

/**
 * Roles enforced read-only at the mount level (design "Role profiles"): no
 * host path they can reach may be writable. Their tmpfs mounts stay writable
 * and vanish with the sandbox. Harness read-only flags are only a second layer.
 */
export const READ_ONLY_ROLES: ReadonlySet<(typeof PROFILE_ROLES)[number]> =
	new Set(["reviewer", "plan", "import", "brain", "trigger"]);

export const SandboxProfileSchema = z
	.strictObject({
		version: z.literal(SANDBOX_PROFILE_VERSION),
		role: z.enum(PROFILE_ROLES),
		filesystem: FilesystemSection.optional(),
		home: z.literal("synthetic").optional(),
		process: ProcessSection.optional(),
		network: NetworkSection.optional(),
		resources: ResourcesSection.optional(),
		lifecycle: LifecycleSection.optional(),
	})
	.superRefine((profile, ctx) => {
		if (!READ_ONLY_ROLES.has(profile.role)) return;
		const deny = (path: (string | number)[], what: string) =>
			ctx.addIssue({
				code: "custom",
				path: ["filesystem", ...path],
				message: `role ${profile.role} is read-only and cannot have ${what}`,
			});
		const fs = profile.filesystem;
		if (fs?.workspace?.access === "rw") {
			deny(["workspace", "access"], "a writable workspace");
		}
		if (fs?.runDir?.outbox === "rw") {
			deny(["runDir", "outbox"], "a writable outbox");
		}
		fs?.caches?.forEach((cache, i) => {
			if (cache.access === "rw") {
				deny(["caches", i, "access"], "a writable cache");
			}
		});
		if (fs?.fleetConfig?.writable.length) {
			deny(["fleetConfig", "writable"], "writable fleet directories");
		}
	});

export type SandboxProfile = z.infer<typeof SandboxProfileSchema>;

/** Project config: every field can only remove access. */
export const ProfileNarrowingSchema = z.strictObject({
	workspaceAccess: z.literal("ro").optional(),
	outboxAccess: z.literal("ro").optional(),
	dropScratch: z.literal(true).optional(),
	/** The caches to keep; any other is dropped. */
	keepCaches: z.array(z.string()).optional(),
	/** The caches to downgrade to read-only. */
	readOnlyCaches: z.array(z.string()).optional(),
	/** The fleet directories that stay writable; a subset of the base. */
	fleetWritable: z.array(RelativeDir).optional(),
	deny: z.array(AbsolutePath).max(256).optional(),
	network: z.literal("none").optional(),
	resources: ResourcesSection.partial().optional(),
	dropEnv: z.array(z.string()).optional(),
});

export type ProfileNarrowing = z.infer<typeof ProfileNarrowingSchema>;

export class ProfileRejectedError extends Error {
	readonly issues: readonly string[];
	constructor(issues: readonly string[]) {
		super(`sandbox profile rejected: ${issues.join("; ")}`);
		this.name = "ProfileRejectedError";
		this.issues = issues;
	}
}

function parseOrThrow<S extends z.ZodType>(
	schema: S,
	input: unknown,
): z.output<S> {
	const r = schema.safeParse(input);
	if (r.success) return r.data;
	throw new ProfileRejectedError(
		r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
	);
}

/** Parse untrusted input. Throws {@link ProfileRejectedError}. */
export function parseSandboxProfile(input: unknown): SandboxProfile {
	return parseOrThrow(SandboxProfileSchema, input);
}

const MEMORY_UNITS: Readonly<Record<string, number>> = {
	K: 1024,
	M: 1024 ** 2,
	G: 1024 ** 3,
	T: 1024 ** 4,
};

/** Bytes for a validated systemd memory value such as `512M`. */
export function memoryBytes(value: string): number {
	return Number(value.slice(0, -1)) * (MEMORY_UNITS[value.slice(-1)] as number);
}

/** The limits a profile runs under; an omitted section means the smallest. */
export function effectiveLimits(profile: SandboxProfile): LimitsSpec {
	return { ...(profile.resources ?? MINIMAL_LIMITS) };
}

/**
 * Apply project config to a base profile. The result never grants anything
 * the base did not: a request to raise a limit, or to keep something the base
 * lacks, is rejected rather than ignored.
 */
export function narrowProfile(
	base: SandboxProfile,
	input: unknown,
): SandboxProfile {
	const n = parseOrThrow(ProfileNarrowingSchema, input);
	const issues: string[] = [];
	const out: SandboxProfile = structuredClone(base);
	const fs = out.filesystem;

	if (n.workspaceAccess && fs?.workspace) fs.workspace.access = "ro";
	if (n.outboxAccess && fs?.runDir) fs.runDir.outbox = "ro";
	if (n.dropScratch && fs) delete fs.scratch;

	const cacheNames = new Set((fs?.caches ?? []).map((c) => c.name));
	for (const name of [...(n.keepCaches ?? []), ...(n.readOnlyCaches ?? [])]) {
		if (!cacheNames.has(name)) issues.push(`cache ${name} is not in the base`);
	}
	if (fs?.caches) {
		if (n.keepCaches) {
			const keep = new Set(n.keepCaches);
			fs.caches = fs.caches.filter((c) => keep.has(c.name));
		}
		for (const c of fs.caches) {
			if (n.readOnlyCaches?.includes(c.name)) c.access = "ro";
		}
	}

	if (n.fleetWritable) {
		const allowed = new Set(fs?.fleetConfig?.writable ?? []);
		for (const dir of n.fleetWritable) {
			if (!allowed.has(dir)) {
				issues.push(`fleet directory ${dir} is not writable in the base`);
			}
		}
		if (fs?.fleetConfig) fs.fleetConfig.writable = [...n.fleetWritable];
	}

	if (n.deny?.length) {
		out.filesystem = {
			...out.filesystem,
			deny: [...new Set([...(out.filesystem?.deny ?? []), ...n.deny])],
		};
	}

	if (n.network) out.network = { mode: "none" };

	if (n.resources) {
		const current = effectiveLimits(base);
		const tasksMax = n.resources.tasksMax ?? current.tasksMax;
		const memoryMax = n.resources.memoryMax ?? current.memoryMax;
		if (tasksMax > current.tasksMax) {
			issues.push(`tasksMax ${tasksMax} exceeds the base ${current.tasksMax}`);
		}
		if (memoryBytes(memoryMax) > memoryBytes(current.memoryMax)) {
			issues.push(
				`memoryMax ${memoryMax} exceeds the base ${current.memoryMax}`,
			);
		}
		out.resources = { tasksMax, memoryMax };
	}

	if (n.dropEnv && out.process?.env) {
		for (const name of n.dropEnv) delete out.process.env[name];
	}

	if (issues.length > 0) throw new ProfileRejectedError(issues);
	return parseSandboxProfile(out);
}
