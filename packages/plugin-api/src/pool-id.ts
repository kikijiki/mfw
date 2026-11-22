import { z } from "zod";

/**
 * Pool id grammar (locked; budgets, the brain and frontmatter reference it):
 *
 *   <plugin>.<instance>[.<unit>]            local.gpu.0  runpod.main
 *   <pool>/<scope>:<name>                   openrouter.main/brain:mfw
 *
 * Segments are lower-case `[a-z0-9][a-z0-9_-]*`. The first segment names the
 * owner (`local`, `runpod`, `codex-cli`, `project`, `ssh`, `endpoint`, ...).
 * The second names the instance, the optional third a unit inside it. The
 * `/scope:name` suffix addresses a child quota under the pool.
 */

const SEGMENT = "[a-z0-9][a-z0-9_-]{0,63}";
const POOL = `${SEGMENT}\\.${SEGMENT}(?:\\.${SEGMENT})?`;
const QUOTA = `(?:/${SEGMENT}:[a-z0-9][a-z0-9._-]{0,63})?`;
const POOL_RE = new RegExp(`^${POOL}$`);
const QUOTA_RE = new RegExp(`^(${POOL})(${QUOTA})$`);

export const PoolIdSchema = z
	.string()
	.max(256)
	.regex(POOL_RE, "pool id must be <plugin>.<instance>[.<unit>]");
export type PoolId = z.infer<typeof PoolIdSchema>;

/** A pool id with an optional child-quota suffix. */
export const QuotaRefSchema = z
	.string()
	.max(320)
	.regex(QUOTA_RE, "quota ref must be <pool>[/<scope>:<name>]");

export interface ParsedPoolId {
	plugin: string;
	instance: string;
	unit?: string;
}

export function parsePoolId(id: string): ParsedPoolId | null {
	if (!POOL_RE.test(id)) return null;
	const [plugin, instance, unit] = id.split(".") as [string, string, string?];
	return unit === undefined ? { plugin, instance } : { plugin, instance, unit };
}

export function formatPoolId(parts: ParsedPoolId): PoolId {
	const id = [parts.plugin, parts.instance, parts.unit]
		.filter((p) => p !== undefined)
		.join(".");
	return PoolIdSchema.parse(id);
}

export interface ParsedQuotaRef {
	pool: PoolId;
	scope?: string;
	name?: string;
}

export function parseQuotaRef(ref: string): ParsedQuotaRef | null {
	const match = QUOTA_RE.exec(ref);
	if (!match) return null;
	const pool = match[1] as string;
	const suffix = match[2] ?? "";
	if (!suffix) return { pool };
	const [scope, name] = suffix.slice(1).split(":") as [string, string];
	return { pool, scope, name };
}
