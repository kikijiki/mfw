import { z } from "zod";
import { Id, JsonObjectSchema, Text } from "./common.ts";

/**
 * `mfw.harness/v1`: a manifest plus one of a fixed set of core dialects. An
 * ACP agent needs no plugin code; a new dialect needs a core bridge, because
 * bridges turn untrusted output into host facts. mfw drives unmodified CLIs.
 *
 * Data-only is not inert: detection runs the named binary. For a non-built-in
 * manifest detection runs inside the sandbox and the resolved binary is
 * pinned by sha256 at enable. Everything here is a closed, strict schema.
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
] as const;

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
		!/^[0-9.]+$/.test(host)
	);
}
const EgressEntry = z.strictObject({
	host: z.string().refine(isEgressHost, "egress host must be an exact name"),
	port: z.number().int().min(1).max(65_535),
	purpose: z.enum(["inference", "auth", "telemetry", "update", "other"]),
});

const Capabilities = z.strictObject({
	steer: z.boolean(),
	interrupt: z.boolean(),
	resume: z.boolean(),
	mcp: z.boolean(),
});

const Mode = Argv;

/** Declarative usage and rate-limit rules; R4 tightens these to concrete rule shapes. */
const Rules = z.array(JsonObjectSchema).max(32);

export const HarnessManifestSchema = z.strictObject({
	id: Id,
	detect: z.strictObject({
		/** A bare binary name resolved on the sandbox PATH, never a path. */
		bin: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/),
		versionArgs: Argv,
		identity: z.record(z.string().max(64), z.string().max(256)).default({}),
		versionRange: z.string().max(64).optional(),
	}),
	dialect: z.enum(HARNESS_DIALECTS),
	modes: z.strictObject({
		task: Mode,
		brain: Mode.optional(),
		inference: Mode.optional(),
	}),
	/** Defence in depth; the mount is what enforces read-only. */
	readOnly: z.strictObject({
		mechanism: z.enum(["argv", "config", "none"]),
		value: Argv.default([]),
	}),
	capabilities: Capabilities,
	/** Never trusted from the transcript; G1 saw Codex print a false DONE. */
	completion: z.strictObject({ signal: z.string().min(1).max(128) }),
	innerSandbox: z.strictObject({ disableArgv: Argv }).optional(),
	fleet: z.strictObject({
		env: EnvKey.optional(),
		writable: z.array(FleetPath).max(64).default([]),
		readOnly: z.array(FleetPath).max(64).default([]),
	}),
	egress: z.array(EgressEntry).max(32).default([]),
	env: z.record(EnvKey, EnvValue).default({}),
	telemetryOff: z.strictObject({ config: JsonObjectSchema }).optional(),
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
	}),
	models: z
		.strictObject({
			tiers: z.strictObject({
				light: z.string().max(128),
				standard: z.string().max(128),
				strong: z.string().max(128),
			}),
		})
		.optional(),
});
export type HarnessManifest = z.infer<typeof HarnessManifestSchema>;

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
