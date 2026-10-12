import { z } from "zod";
import type { TypeSpec } from "./config.ts";
import { validateOwnsPattern } from "./ownership.ts";

/**
 * The top-level sections of `board.yaml` that look outside the board:
 * `roots` (named directories other than the board's) and `refs` (a pattern
 * found in files there must name a board document in an allowed state). Like
 * `workflow-config.ts` this returns error strings rather than throwing, so it
 * never imports `BoardConfigError` (no import cycle).
 */

const NAME_RE = /^[a-z][a-z0-9_-]*$/;
const RULE_ID_RE = /^[a-z][a-z0-9-]*$/;
const FIELD_NAME_RE = /^[a-z][a-z0-9_]*$/;

const rawRefsRule = z
	.object({
		id: z.string().regex(RULE_ID_RE, "must be lowercase letters, digits, '-'"),
		root: z.string().regex(NAME_RE),
		paths: z.array(z.string().min(1)).min(1),
		pattern: z.string().min(1),
		flags: z.string().regex(/^i?$/, "flags may be 'i'").optional(),
		to: z.string().min(1),
		status: z.array(z.string().min(1)).min(1).optional(),
		severity: z.enum(["error", "advisory"]).optional(),
		max_bytes: z.number().int().positive().optional(),
		message: z.string().min(1).optional(),
	})
	.strict();

const rawFieldRef = z
	.object({
		type: z.string().min(1),
		field: z.string().regex(FIELD_NAME_RE),
		/** Only documents in these statuses count; omitted: any status. */
		status: z.array(z.string().min(1)).min(1).optional(),
	})
	.strict();

const rawTableRef = z
	.object({
		file: z.string().min(1),
		id_column: z.string().min(1),
	})
	.strict();

const rawCoverageRule = z
	.object({
		id: z.string().regex(RULE_ID_RE, "must be lowercase letters, digits, '-'"),
		/** Table of rows (TSV, header line first), relative to the board or `root`. */
		source: z.string().min(1),
		root: z.string().regex(NAME_RE).optional(),
		id_column: z.string().min(1),
		/** Only rows where `column` equals `equals` need covering. */
		open_when: z
			.object({ column: z.string().min(1), equals: z.string() })
			.strict()
			.optional(),
		/** Column listing, comma separated, other ids this row absorbed. */
		alias_column: z.string().min(1).optional(),
		/** The cell value that means "no aliases". */
		alias_none: z.string().optional(),
		waivers: rawTableRef.optional(),
		closed_by: rawFieldRef.extend({
			exactly: z.number().int().positive().optional(),
		}),
		referenced_by: rawFieldRef.optional(),
		severity: z.enum(["error", "advisory"]).optional(),
	})
	.strict();

export const rawExternalShape = {
	roots: z.record(z.string().regex(NAME_RE), z.string().min(1)).optional(),
	refs: z.array(rawRefsRule).optional(),
	coverage: z.array(rawCoverageRule).optional(),
};

export interface RefsRule {
	id: string;
	/** Name of a `roots` entry. */
	root: string;
	/** Root-relative path globs (board-core ownership grammar). */
	paths: readonly string[];
	/** Per-line regex; the named group `id` captures the document id. */
	pattern: string;
	flags: string;
	/** The document type the captured id must resolve to. */
	to: string;
	/** Allowed status values of the target; omitted: existence only. */
	status?: readonly string[];
	severity: "error" | "advisory";
	/** Files larger than this are skipped (and counted). */
	maxBytes: number;
	message?: string;
}

export const DEFAULT_MAX_BYTES = 1024 * 1024;

/** A document field that names rows of a table. */
export interface FieldRef {
	type: string;
	field: string;
	status?: readonly string[];
}

/**
 * Every open row of a table must be named by exactly one document through
 * `closedBy.field` (or be waived); `referencedBy` is a non-closing mention.
 */
export interface CoverageRule {
	id: string;
	source: string;
	root?: string;
	idColumn: string;
	openWhen?: { column: string; equals: string };
	aliasColumn?: string;
	aliasNone?: string;
	waivers?: { file: string; idColumn: string };
	closedBy: FieldRef & { exactly: number };
	referencedBy?: FieldRef;
	severity: "error" | "advisory";
}

export interface ExternalSpec {
	roots: Record<string, string>;
	refs: RefsRule[];
	coverage: CoverageRule[];
}

export type ExternalResult =
	| { ok: true; external: ExternalSpec }
	| { ok: false; error: string };

/** Why `ref` cannot name table rows, or null. */
function fieldRefProblem(
	where: string,
	ref: FieldRef,
	types: Record<string, TypeSpec>,
): string | null {
	const t = types[ref.type];
	if (!t) return `${where}: type '${ref.type}' is not a declared type`;
	const f = t.fields[ref.field];
	if (!f) {
		return `${where}: '${ref.type}' has no field '${ref.field}'`;
	}
	const textList =
		(f.kind === "scalar" && f.type === "string" && f.list) ||
		(f.kind === "enum" && f.list);
	if (!textList) {
		return `${where}: ${ref.type}.${ref.field} must be a list of strings`;
	}
	if (ref.status) {
		const sf = t.workflow?.statusField ?? "status";
		const spec = t.fields[sf];
		if (spec?.kind !== "enum") {
			return `${where}: type '${ref.type}' has no enum status field '${sf}' to restrict`;
		}
		for (const s of ref.status) {
			if (!spec.values.includes(s)) {
				return `${where}: '${s}' is not a value of ${ref.type}.${sf} (${spec.values.join(", ")})`;
			}
		}
	}
	return null;
}

export function normalizeExternal(
	raw: {
		roots?: Record<string, string>;
		refs?: z.infer<typeof rawRefsRule>[];
		coverage?: z.infer<typeof rawCoverageRule>[];
	},
	types: Record<string, TypeSpec>,
): ExternalResult {
	const roots = raw.roots ?? {};
	const refs: RefsRule[] = [];
	for (const r of raw.refs ?? []) {
		const where = `refs '${r.id}'`;
		if (!(r.root in roots)) {
			return {
				ok: false,
				error: `${where}: root '${r.root}' is not declared under 'roots'`,
			};
		}
		for (const p of r.paths) {
			const bad = validateOwnsPattern(p);
			if (bad) return { ok: false, error: `${where}: paths '${p}': ${bad}` };
		}
		const flags = r.flags ?? "";
		let re: RegExp;
		try {
			re = new RegExp(r.pattern, `${flags}d`);
		} catch (e) {
			return {
				ok: false,
				error: `${where}: pattern is not a valid regular expression: ${e instanceof Error ? e.message : String(e)}`,
			};
		}
		if (!/\(\?<id>/.test(re.source)) {
			return {
				ok: false,
				error: `${where}: pattern needs a named group (?<id>...) capturing the document id`,
			};
		}
		const target = types[r.to];
		if (!target) {
			return {
				ok: false,
				error: `${where}: 'to' type '${r.to}' is not a declared type`,
			};
		}
		if (r.status) {
			const field = target.workflow?.statusField ?? "status";
			const spec = target.fields[field];
			if (spec?.kind !== "enum") {
				return {
					ok: false,
					error: `${where}: type '${r.to}' has no enum status field '${field}' to restrict`,
				};
			}
			for (const s of r.status) {
				if (!spec.values.includes(s)) {
					return {
						ok: false,
						error: `${where}: '${s}' is not a value of ${r.to}.${field} (${spec.values.join(", ")})`,
					};
				}
			}
		}
		refs.push({
			id: r.id,
			root: r.root,
			paths: r.paths,
			pattern: r.pattern,
			flags,
			to: r.to,
			...(r.status ? { status: r.status } : {}),
			severity: r.severity ?? "error",
			maxBytes: r.max_bytes ?? DEFAULT_MAX_BYTES,
			...(r.message ? { message: r.message } : {}),
		});
	}
	const coverage: CoverageRule[] = [];
	for (const c of raw.coverage ?? []) {
		const where = `coverage '${c.id}'`;
		if (c.root !== undefined && !(c.root in roots)) {
			return {
				ok: false,
				error: `${where}: root '${c.root}' is not declared under 'roots'`,
			};
		}
		if (c.alias_none !== undefined && c.alias_column === undefined) {
			return { ok: false, error: `${where}: alias_none needs alias_column` };
		}
		for (const [what, ref] of [
			["closed_by", c.closed_by],
			["referenced_by", c.referenced_by],
		] as const) {
			if (!ref) continue;
			const problem = fieldRefProblem(`${where} ${what}`, ref, types);
			if (problem) return { ok: false, error: problem };
		}
		coverage.push({
			id: c.id,
			source: c.source,
			...(c.root ? { root: c.root } : {}),
			idColumn: c.id_column,
			...(c.open_when ? { openWhen: c.open_when } : {}),
			...(c.alias_column ? { aliasColumn: c.alias_column } : {}),
			...(c.alias_none !== undefined ? { aliasNone: c.alias_none } : {}),
			...(c.waivers
				? { waivers: { file: c.waivers.file, idColumn: c.waivers.id_column } }
				: {}),
			closedBy: {
				type: c.closed_by.type,
				field: c.closed_by.field,
				...(c.closed_by.status ? { status: c.closed_by.status } : {}),
				exactly: c.closed_by.exactly ?? 1,
			},
			...(c.referenced_by
				? {
						referencedBy: {
							type: c.referenced_by.type,
							field: c.referenced_by.field,
							...(c.referenced_by.status
								? { status: c.referenced_by.status }
								: {}),
						},
					}
				: {}),
			severity: c.severity ?? "error",
		});
	}
	return { ok: true, external: { roots, refs, coverage } };
}
