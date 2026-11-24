import { z } from "zod";
import { Id, JsonObjectSchema, Text } from "./common.ts";
import { UNATTESTED_CONFIG_MARKER } from "./harness-markers.ts";

/**
 * `mfw.harness/v1`: a manifest plus one of a fixed set of core dialects. An
 * ACP agent needs no plugin code; a new dialect needs a core bridge, because
 * bridges turn untrusted output into host facts. mfw drives unmodified CLIs.
 *
 * Data-only is not inert: detection runs the named binary, today directly on
 * the host and unsandboxed. That is acceptable only because just the compiled-in
 * manifests can load. Running detection in the sandbox and pinning the resolved
 * binary by sha256 are R6 requirements (`docs/plugin-trust-requirements.md`).
 * Everything here is a closed, strict schema.
 */

export const HARNESS_DIALECTS = [
	"claude-stream-json",
	"codex-app-server",
	"codex-exec",
	"acp",
] as const;
export type HarnessDialect = (typeof HARNESS_DIALECTS)[number];

/**
 * The only substitutions an argv template may contain. Anything else in
 * braces is rejected, so a manifest cannot reach host state.
 */
export const ARGV_PLACEHOLDERS = [
	"model",
	"effort",
	"session_id",
	"prompt_file",
	"mcp_config",
	/** The prompt as one argv element. Built-in one-shot calls only. */
	"prompt",
	/** A whole entry: `modes.modelArgv` when a real model is chosen, else nothing. */
	"model_argv",
	/** A whole entry: the caller's reasoning-effort arguments, or nothing. */
	"effort_argv",
] as const;

/** The manifest format this core reads (`mfw.harness/v1`). */
export const HARNESS_SCHEMA_VERSION = 1;

export { UNATTESTED_CONFIG_MARKER };

const PLACEHOLDER_RE = /\{([^{}]*)\}/g;

const argvEntry = z
	.string()
	.max(512)
	.refine((s) => !s.includes("\0"), "no NUL")
	.refine((s) => {
		for (const m of s.matchAll(PLACEHOLDER_RE))
			if (!(ARGV_PLACEHOLDERS as readonly string[]).includes(m[1] as string))
				return false;
		return !s.replace(PLACEHOLDER_RE, "").match(/[{}]/);
	}, "unknown placeholder or stray brace");
const Argv = z.array(argvEntry).max(64);

/**
 * Env keys a manifest may set. Rejected: loader and runtime hooks (`LD_*`,
 * `DYLD_*`, `NODE_OPTIONS`, `BUN_*`), `PATH`, and every proxy variable
 * (`*_PROXY`, `NODE_USE_ENV_PROXY`): the host sets proxy env itself.
 */
const FORBIDDEN_ENV = [
	/^LD_/,
	/^DYLD_/,
	/^BUN_/,
	/^NODE_OPTIONS$/,
	/^PATH$/,
	/^HOME$/,
	/^IFS$/,
	/_PROXY$/i,
	/^PROXY$/i,
];
export function isAllowedEnvKey(key: string): boolean {
	return (
		/^[A-Z_][A-Z0-9_]{0,63}$/.test(key) &&
		!FORBIDDEN_ENV.some((re) => re.test(key))
	);
}
const EnvKey = z.string().refine(isAllowedEnvKey, "env key is not allowed");
const EnvValue = z
	.string()
	.max(1_024)
	.refine((s) => !s.includes("\0"), "no NUL");

/** A path inside the harness's own fleet dir: relative, no `..`, no escapes. */
export function isSafeRelativePath(path: string): boolean {
	if (!path || path.length > 256) return false;
	if (path.startsWith("/") || path.startsWith("~") || path.includes("\\"))
		return false;
	if (path.includes("\0")) return false;
	return path
		.split("/")
		.every((seg, i, all) =>
			seg === ""
				? i === all.length - 1 && all.length > 1
				: seg !== ".." && seg !== ".",
		);
}
const FleetPath = z.string().refine(isSafeRelativePath, "unsafe fleet path");

/** Exact host names only; no wildcards, no numeric hosts. */
export function isEgressHost(host: string): boolean {
	return (
		host.length <= 253 &&
		/^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)+$/.test(
			host,
		) &&
		// The proxy refuses a numeric or hex last label (IPv4 in any spelling).
		/\.[a-z]([a-z0-9-]*[a-z0-9])?$/.test(host)
	);
}
const EgressEntry = z.strictObject({
	host: z.string().refine(isEgressHost, "egress host must be an exact name"),
	port: z.number().int().min(1).max(65_535),
	purpose: z.enum(["inference", "auth", "telemetry", "update", "other"]),
	/** Where the entry comes from, so the owner can check it. */
	source: z.string().max(256).optional(),
	/**
	 * Only for a run authenticating with an API key. An API host accepts any
	 * caller's key, so a subscription run reaching one has an upload channel to
	 * an account of the agent's choosing.
	 */
	requiresApiKey: z.literal(true).optional(),
});

const Capabilities = z.strictObject({
	steer: z.boolean(),
	interrupt: z.boolean(),
	resume: z.boolean(),
	mcp: z.boolean(),
	/** As the task bridge declares them in its `initialize` answer. */
	approvals: z.boolean().default(false),
	plan: z.boolean().default(false),
	fileChanges: z.boolean().default(false),
	commandProgress: z.boolean().default(false),
	/** Incremental output reaches the run's transcript. */
	streaming: z.boolean().default(false),
	/** The CLI runs its own tools (shell, edits) in a task run. */
	tools: z.boolean().default(false),
});

const Mode = Argv;

/** Declarative usage and rate-limit rules; R4 tightens these to concrete rule shapes. */
const Rules = z.array(JsonObjectSchema).max(32);

/**
 * A pattern run over a tool's own `--help` output, so it is untrusted input to
 * a regex engine: no quantified groups, no backreferences or lookaround, and
 * at most one unbounded quantifier, which rules out catastrophic backtracking.
 */
export function isSafeIdentityPattern(pattern: string): boolean {
	if (!pattern || pattern.length > 128) return false;
	if (/\\[1-9]|\(\?/.test(pattern)) return false;
	if (/\)[*+?{]/.test(pattern)) return false;
	if ((pattern.match(/(?<!\\)[*+]/g) ?? []).length > 1) return false;
	if (/(?<!\\)\{/.test(pattern)) return false;
	try {
		new RegExp(pattern);
		return true;
	} catch {
		return false;
	}
}

const Identity = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("symlink-target"),
		basename: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/),
		describe: z.string().min(1).max(160),
	}),
	z.strictObject({
		kind: z.literal("help-text"),
		args: Argv.min(1).max(4),
		pattern: z
			.string()
			.refine(isSafeIdentityPattern, "identity pattern is not safe"),
		flags: z.enum(["", "i", "m", "im"]),
		describe: z.string().min(1).max(160),
	}),
]);
export type HarnessIdentity = z.infer<typeof Identity>;

const AutonomyFlag = z.string().regex(/^--?[A-Za-z][A-Za-z0-9-]*$/);

/** What makes this CLI act without asking; the launch gate refuses these. */
const Autonomy = z.strictObject({
	flags: z.array(AutonomyFlag).max(32),
	/** Options that grant autonomy only with this value. */
	values: z
		.array(
			z.strictObject({
				option: AutonomyFlag,
				value: z.string().min(1).max(64),
			}),
		)
		.max(32),
	/** `-c key=value` settings that do the same. */
	config: z
		.array(
			z.strictObject({
				key: z.string().regex(/^[a-z][a-z0-9_.]{0,63}$/),
				value: z.string().min(1).max(64),
			}),
		)
		.max(16),
	configOptions: z.array(AutonomyFlag).max(4),
	/**
	 * The autonomy arguments this manifest's own argv carries, as the detector
	 * prints them. Built-ins only: an external manifest must leave this empty.
	 */
	launchFlags: z.array(z.string().min(1).max(128)).max(8),
});
export type HarnessAutonomy = z.infer<typeof Autonomy>;

const HomeRelativeFile = z
	.string()
	.refine(isSafeRelativePath, "unsafe login path")
	.refine((p) => !p.endsWith("/"), "a login path names a file");

const AuthMethod = z.strictObject({
	kind: z.enum(["subscription", "api-key"]),
	credentialId: z
		.string()
		.regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)
		.optional(),
	envVars: z.array(EnvKey).max(8).optional(),
	/** Relative to `$HOME`. Presence only: mfw never opens a login file. */
	loginFiles: z.array(HomeRelativeFile).max(8).optional(),
	hint: z.string().min(1).max(400),
});

const ModelChoice = z.strictObject({
	id: z.string().min(1).max(128),
	label: z.string().min(1).max(128),
	kind: z.enum(["alias", "pinned"]),
});

const AcpProfileSection = z.strictObject({
	label: z.string().min(1).max(64),
	capabilityMeta: JsonObjectSchema.optional(),
	modelOnArgv: z.literal(true).optional(),
	readOnlyMode: z.string().min(1).max(32).optional(),
	brainEligible: z.boolean(),
	readOnlyOtherTitles: z.array(z.string().min(1).max(32)).max(16).optional(),
});

const ProjectPath = z
	.string()
	.refine(isSafeRelativePath, "unsafe project path")
	.refine((p) => !p.endsWith("/"), "name the path without a trailing slash");

export const HarnessManifestSchema = z
	.strictObject({
		/** The format; a manifest for a newer format is refused, never guessed at. */
		schemaVersion: z.literal(HARNESS_SCHEMA_VERSION),
		/** This manifest's own revision, which the registry can pin. */
		manifestVersion: z.number().int().positive(),
		id: Id,
		displayName: z.string().min(1).max(64),
		description: z.string().min(1).max(400),
		docsUrl: z.url({ protocol: /^https$/ }).optional(),
		detect: z.strictObject({
			/** A bare binary name resolved on the sandbox PATH, never a path. */
			bin: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/),
			versionArgs: Argv,
			/** Extra proof that a generically named `bin` is the CLI meant. */
			identity: Identity.optional(),
			/** Declared for the doctor; detection reports the version and does not gate on it. */
			versionRange: z.string().max(64).optional(),
		}),
		dialect: z.enum(HARNESS_DIALECTS),
		modes: z.strictObject({
			task: Mode,
			brain: Mode.optional(),
			inference: Mode.optional(),
			/** What `{model_argv}` expands to when a real model is chosen. */
			modelArgv: Mode.optional(),
		}),
		/** Defence in depth; the mount is what enforces read-only. */
		readOnly: z.strictObject({
			mechanism: z.enum(["argv", "config", "none"]),
			value: Argv.default([]),
		}),
		capabilities: Capabilities,
		/** How a later turn continues the CLI's native session. */
		resume: z.strictObject({
			method: z.enum(["session-id-flag", "thread-arg", "acp-session", "none"]),
			detail: z.string().min(1).max(200),
		}),
		/** Never trusted from the transcript; G1 saw Codex print a false DONE. */
		completion: z.strictObject({ signal: z.string().min(1).max(128) }),
		innerSandbox: z
			.strictObject({
				disableArgv: Argv,
				/** The CLI's own sandbox mode mfw sets, and how. */
				mode: z.string().min(1).max(64).optional(),
				via: z.enum(["app-server-rpc", "argv"]).optional(),
				/** Values mfw must never select. */
				refused: z.array(z.string().min(1).max(64)).max(8).optional(),
			})
			.optional(),
		sandbox: z.strictObject({
			/** The compiler disables user namespaces, so `true` is always refused. */
			needsUserns: z.boolean(),
			/** Binaries a run needs beyond the base tools. */
			executables: z
				.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/))
				.max(16),
		}),
		fleet: z.strictObject({
			/** Set for a harness with a fleet config dir under `$MFW_HOME/agents`. */
			cli: z
				.string()
				.regex(/^[a-z][a-z0-9-]{0,31}$/)
				.optional(),
			env: EnvKey.optional(),
			writable: z.array(FleetPath).max(64).default([]),
			readOnly: z.array(FleetPath).max(64).default([]),
			/** The directory under the fleet dir holding resumable sessions. */
			transcriptDir: FleetPath.optional(),
			/** `unattested-config` until P4 checks the list against the real CLI. */
			attestation: z.literal(UNATTESTED_CONFIG_MARKER).optional(),
		}),
		egress: z.array(EgressEntry).max(32).default([]),
		env: z.record(EnvKey, EnvValue).default({}),
		telemetryOff: z
			.strictObject({
				config: JsonObjectSchema.default({}),
				/** Set unless the owner opts in to telemetry. */
				env: z.record(EnvKey, EnvValue).default({}),
			})
			.optional(),
		autonomy: Autonomy,
		/** A parser mismatch makes usage `unknown`, never 0. */
		usage: z
			.strictObject({
				source: z.enum([
					"app-server-rpc",
					"rate-limit-event",
					"status-command",
					"none",
				]),
				rules: Rules.default([]),
			})
			.optional(),
		rateLimit: z
			.strictObject({
				rules: Rules.default([]),
				holdScope: z.enum(["account", "fleet", "machine"]),
			})
			.optional(),
		concurrency: z
			.strictObject({
				perFleetDir: z.number().int().positive(),
				unless: z.enum(["api-key"]).optional(),
			})
			.optional(),
		auth: z.strictObject({
			kinds: z.array(z.enum(["subscription", "api-key"])).min(1),
			loginHint: Text.optional(),
			methods: z.array(AuthMethod).max(8).default([]),
			/** The variable whose presence means this run uses an API key. */
			apiKeyEnv: EnvKey.optional(),
			/** Login files the SSH host probe stats (presence only). */
			remoteLoginFiles: z.array(HomeRelativeFile).max(8).default([]),
		}),
		models: z
			.strictObject({
				tiers: z
					.strictObject({
						light: z.string().max(128),
						standard: z.string().max(128),
						strong: z.string().max(128),
					})
					.optional(),
				choices: z.array(ModelChoice).max(64).default([]),
				default: z.string().min(1).max(128).optional(),
				/** The list is a hand-kept snapshot, not something the tool reported. */
				isSnapshot: z.boolean().default(false),
			})
			.optional(),
		/** Can run on an OpenAI-compatible routing endpoint. */
		acceptsEndpoints: z.boolean().default(false),
		/** ACP agents only: the bridge's per-agent profile. */
		acp: AcpProfileSection.optional(),
		/** What the CLI loads from a project checkout, and where skills go. */
		install: z.strictObject({
			/** Files the merge gate treats as host-executed. */
			projectConfig: z.array(ProjectPath).max(16),
			/** Directories it loads from, all host-executed. */
			projectDirs: z.array(ProjectPath).max(8),
			/** Project-scope skill directory, as `mfw board skill install` writes it. */
			skills: ProjectPath.optional(),
		}),
	})
	.superRefine((m, ctx) => {
		const issue = (path: (string | number)[], message: string) =>
			ctx.addIssue({ code: "custom", path, message });
		if ((m.dialect === "acp") !== (m.acp !== undefined))
			issue(["acp"], "the acp section is required for, and only for, acp");
		if (m.egress.some((e) => e.requiresApiKey) && !m.auth.apiKeyEnv)
			issue(["auth", "apiKeyEnv"], "an API-key egress entry needs apiKeyEnv");
		const seen = new Set<string>();
		for (const [i, e] of m.egress.entries()) {
			const key = `${e.host}:${e.port}`;
			if (seen.has(key)) issue(["egress", i], `duplicate egress ${key}`);
			seen.add(key);
		}
		if (m.fleet.cli !== undefined && m.fleet.env === undefined)
			issue(["fleet", "env"], "a fleet dir needs the variable that locates it");
		const argvs = [m.modes.task, m.modes.brain, m.modes.inference];
		const usesModelArgv = argvs.some((a) => a?.includes("{model_argv}"));
		if (usesModelArgv && !m.modes.modelArgv)
			issue(["modes", "modelArgv"], "{model_argv} needs modes.modelArgv");
		for (const argv of argvs)
			for (const entry of argv ?? [])
				if (
					entry !== "{model_argv}" &&
					entry !== "{effort_argv}" &&
					/\{(model|effort)_argv\}/.test(entry)
				)
					issue(["modes"], "an *_argv placeholder must be a whole entry");
	});
export type HarnessManifest = z.infer<typeof HarnessManifestSchema>;
export type HarnessManifestInput = z.input<typeof HarnessManifestSchema>;

export interface HarnessArgvValues {
	model?: string;
	prompt?: string;
	/** Already-split arguments for `{effort_argv}`. */
	effortArgv?: readonly string[];
}

/**
 * Fills a manifest argv. `{model_argv}` disappears for an empty or `default`
 * model, which leaves the agent's own choice. A placeholder without a value
 * throws rather than reach a CLI as literal text.
 */
export function renderHarnessArgv(
	template: readonly string[],
	manifest: Pick<HarnessManifest, "modes">,
	values: HarnessArgvValues,
): string[] {
	if (values.model !== undefined && /^\s*-/.test(values.model))
		throw new Error(
			"a model id cannot start with '-': it would be read as a command-line option",
		);
	const fill = (entry: string) =>
		entry.replace(PLACEHOLDER_RE, (_all, name: string) => {
			const value =
				name === "model"
					? values.model
					: name === "prompt"
						? values.prompt
						: undefined;
			if (value === undefined)
				throw new Error(`no value for argv placeholder {${name}}`);
			return value;
		});
	return template.flatMap((entry) => {
		if (entry === "{model_argv}") {
			const model = values.model ?? "";
			return model === "" || model === "default"
				? []
				: (manifest.modes.modelArgv ?? []).map(fill);
		}
		if (entry === "{effort_argv}") return [...(values.effortArgv ?? [])];
		return [fill(entry)];
	});
}

export interface HarnessWidening {
	kind:
		| "egress"
		| "fleet-writable"
		| "fleet-readonly"
		| "env"
		| "inner-sandbox";
	detail: string;
}

/**
 * What approving this manifest widens for every run of the harness. Egress
 * and `fleet.writable` are ask-first sandbox widening; the card lists
 * each entry in plain words. Built-in manifests are reviewed with the release
 * and skip the card, but the list is still computed for Capacity.
 */
export function harnessWidenings(m: HarnessManifest): HarnessWidening[] {
	const out: HarnessWidening[] = [];
	for (const e of m.egress)
		out.push({ kind: "egress", detail: `${e.host}:${e.port} (${e.purpose})` });
	for (const p of m.fleet.writable)
		out.push({ kind: "fleet-writable", detail: p });
	for (const p of m.fleet.readOnly)
		out.push({ kind: "fleet-readonly", detail: p });
	for (const k of Object.keys(m.env)) out.push({ kind: "env", detail: k });
	if (m.innerSandbox)
		out.push({
			kind: "inner-sandbox",
			detail: m.innerSandbox.disableArgv.join(" "),
		});
	return out;
}
