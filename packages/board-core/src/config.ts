import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
	normalizeWorkflow,
	rawWorkflowShape,
	type TypeWorkflow, // workflow-config: optional per-type workflow
} from "./workflow-config.ts";

/**
 * `board.yaml`: the only thing that makes this engine project-specific. The
 * engine itself knows nothing about tasks, ADRs, or mfw — every document type,
 * its directory, its id strategy, and its fields are declared here. Two
 * projects with two different `board.yaml` files are two different boards,
 * sharing no code path that mentions either project's vocabulary.
 */

export const BOARD_CONFIG_VERSION = 1;

/** Every document carries these three keys regardless of its type; a type
 * cannot redeclare them as fields of its own. */
export const RESERVED_FIELD_NAMES = new Set(["mfw", "id", "rev"]);

const TYPE_NAME_RE = /^[a-z][a-z0-9_]*$/;
const FIELD_NAME_RE = /^[a-z][a-z0-9_]*$/;
const KEY_RE = /^[A-Z][A-Z0-9]{1,9}$/;
/** A field `pattern` as the anchored regex it is documented to be: `^(?:p)$`
 * (already-anchored patterns behave unchanged). */
export function anchoredPattern(p: string): RegExp {
	return new RegExp(`^(?:${p})$`);
}

const SUFFIX_RE = /^[A-Z][A-Z0-9]*$/;

export class BoardConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BoardConfigError";
	}
}

// ---------------------------------------------------------------------------
// Field specs
// ---------------------------------------------------------------------------

export type FieldSpec =
	| {
			kind: "enum";
			values: readonly string[];
			list: boolean;
			optional: boolean;
			default?: string;
			requiredWhen?: RequiredWhen;
	  }
	| {
			kind: "ref";
			/** Normalized target: `"any"` (every declared type), or the non-empty
			 * list of declared type names the id may resolve in (a plain
			 * `ref: task` normalizes to `["task"]`). */
			ref: "any" | readonly string[];
			list: boolean;
			acyclic: boolean;
			optional: boolean;
			requiredWhen?: RequiredWhen;
	  }
	| {
			kind: "checklist";
			/** Always `true`: a checklist is an ordered list (of `{id, text, done}`
			 * items), so every "is this a list field" check applies unchanged. */
			list: true;
			optional: boolean;
			requiredWhen?: RequiredWhen;
	  }
	| {
			kind: "scalar";
			/** `json` is an escape hatch for a structured value this schema
			 * language has no shape for (an object, or a list of objects) — no
			 * validation beyond "it parsed as YAML", the author's problem to keep
			 * well-formed. Prefer a proper field kind when one fits. */
			type: "string" | "number" | "boolean" | "date" | "json";
			list: boolean;
			optional: boolean;
			default?: unknown;
			/** A regex (its source, anchored automatically) a `string` value must
			 * match; applied per element on a `list: true` field. `string` only -
			 * declaring it with another `type` is a config error. */
			pattern?: string;
			requiredWhen?: RequiredWhen;
			/** `type: json` list only: every row (an object) must carry these keys. */
			rows?: { required: readonly string[] };
	  };

/** `required_when`: the field is required only while another field of the
 * same document holds one of these values (otherwise it is optional). Keyed by
 * the other field's name; always normalized to a list of values. */
export type RequiredWhen = Record<
	string,
	readonly (string | number | boolean)[]
>;

export type IdSpec =
	| {
			strategy: "own-sequence";
			/** The id prefix: ids are always `<KEY>-<n>` (or `<KEY>-<SUFFIX>-<n>`),
			 * never a bare number. */
			key: string;
			suffix?: string;
			pad?: number;
			/** Share one counter and one max-scan across every type declaring the
			 * same `sequence` name, instead of one counter per type. */
			sequence?: string;
	  }
	| { strategy: "inherit"; from: string };

export interface TypeSpec {
	layout: "flat" | "directory";
	/** Relative to the board root (the directory `board.yaml` lives in). */
	dir: string;
	/** Required for `layout: "directory"`; the file holding frontmatter+body. */
	primary?: string;
	/** Optional sibling file/dir names (a trailing `/` marks an opaque directory, e.g. attachments). Directory layout only. */
	siblings: readonly string[];
	id: IdSpec;
	/** A declared field slugified into the filename ONCE, at creation. There is
	 * no re-slugging on update: the path a document is created at is the path
	 * it keeps, even if this field's value changes later. Omit for a bare-id
	 * filename. */
	slugFrom?: string;
	fields: Record<string, FieldSpec>;
	/** Status classes / ready / transitions; see workflow-config.ts. */
	workflow?: TypeWorkflow;
	/** File scopes: `field` is a list-of-globs field naming the paths a document
	 * works in; `exemptions` is an optional YAML file (relative to the board
	 * root) of rulings that let two documents share files on purpose. */
	ownership?: { field: string; exemptions?: string };
}

/** The parent/children relation: a single-ref `parent` field on child
 * documents with a stored list-ref inverse `children` on parent documents. */
export interface HierarchySpec {
	parent: string;
	children: string;
	rules?: HierarchyRule[];
	maxDepth?: number;
}

/** Which documents a hierarchy rule talks about: a type, optionally narrowed
 * to documents whose frontmatter fields hold given values (every `where` key
 * must hold one of its values), e.g. `{type: task, where: {kind: [subtask]}}`. */
export interface HierarchySelector {
	type: string;
	where?: Record<string, string[]>;
}

/** A child matching `child` may only sit under a parent matching one of
 * `parents` (an empty list: no parent at all). The first matching rule in
 * declared order applies; a document matching no rule may not have a parent. */
export interface HierarchyRule {
	child: HierarchySelector;
	parents: HierarchySelector[];
}

const whereHolds = (
	sel: HierarchySelector,
	fields: Record<string, unknown>,
): boolean =>
	Object.entries(sel.where ?? {}).every(([f, values]) =>
		values.includes(String(fields[f])),
	);

export const selectorMatches = (
	sel: HierarchySelector,
	typeName: string,
	fields: Record<string, unknown>,
): boolean => sel.type === typeName && whereHolds(sel, fields);

export function describeSelector(sel: HierarchySelector): string {
	const w = Object.entries(sel.where ?? {}).map(
		([f, v]) => `${f}=${v.join("|")}`,
	);
	return w.length > 0 ? `${sel.type}(${w.join(", ")})` : sel.type;
}

/** The rule governing a document of `typeName` with `fields`, if any. */
export const ruleFor = (
	rules: readonly HierarchyRule[],
	typeName: string,
	fields: Record<string, unknown>,
): HierarchyRule | undefined =>
	rules.find((r) => selectorMatches(r.child, typeName, fields));

/** Why a document may not sit under `parent`, or null if the rules allow it. */
export function parentRuleProblem(
	rules: readonly HierarchyRule[],
	child: { type: string; fields: Record<string, unknown> },
	parent: { type: string; fields: Record<string, unknown> },
): string | null {
	const rule = ruleFor(rules, child.type, child.fields);
	const who = `a '${child.type}'${
		rule ? ` matching ${describeSelector(rule.child)}` : ""
	}`;
	if (!rule || rule.parents.length === 0) {
		return `${who} may not have a parent`;
	}
	if (
		rule.parents.some((p) => selectorMatches(p, parent.type, parent.fields))
	) {
		return null;
	}
	return `${who} may only have a parent matching ${rule.parents.map(describeSelector).join(" or ")} (got a '${parent.type}' with ${JSON.stringify(parent.fields)})`;
}

export interface BoardConfig {
	mfw: number;
	types: Record<string, TypeSpec>;
	hierarchy?: HierarchySpec;
}

// ---------------------------------------------------------------------------
// Raw (on-disk) shape
// ---------------------------------------------------------------------------

const rawRequiredWhen = z
	.record(
		z.string().regex(FIELD_NAME_RE),
		z.union([
			z.union([z.string(), z.number(), z.boolean()]),
			z.array(z.union([z.string(), z.number(), z.boolean()])).min(1),
		]),
	)
	.refine((r) => Object.keys(r).length > 0, "must name at least one field");

const rawEnumFieldSchema = z
	.object({
		values: z.array(z.string().min(1)).min(1),
		list: z.boolean().optional(),
		default: z.string().optional(),
		optional: z.boolean().optional(),
		required_when: rawRequiredWhen.optional(),
	})
	.strict();

const rawRefFieldSchema = z
	.object({
		ref: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
		list: z.boolean().optional(),
		acyclic: z.boolean().optional(),
		optional: z.boolean().optional(),
		required_when: rawRequiredWhen.optional(),
	})
	.strict();

const rawScalarFieldSchema = z
	.object({
		type: z
			.enum(["string", "number", "boolean", "date", "json", "checklist"])
			.optional(),
		list: z.boolean().optional(),
		optional: z.boolean().optional(),
		default: z.unknown().optional(),
		required_when: rawRequiredWhen.optional(),
		rows: z
			.object({ required: z.array(z.string().min(1)).min(1) })
			.strict()
			.optional(),
		pattern: z
			.string()
			.refine((p) => {
				try {
					anchoredPattern(p);
					return true;
				} catch {
					return false;
				}
			}, "must be a valid regex")
			.optional(),
	})
	.strict();

const rawFieldSchema = z.union([
	rawEnumFieldSchema,
	rawRefFieldSchema,
	rawScalarFieldSchema,
]);

const rawIdSchema = z.discriminatedUnion("strategy", [
	z
		.object({
			strategy: z.literal("own-sequence"),
			/** Required: ids are always `<KEY>-<n>`, like Jira, never bare numbers. */
			key: z.string().regex(KEY_RE, "must be 2-10 uppercase alphanumerics"),
			suffix: z.string().regex(SUFFIX_RE).optional(),
			/** Zero-pad the generated number to at least this many digits
			 * (e.g. `pad: 4` -> WH-0001). Overflow past the width just widens,
			 * never truncates. */
			pad: z.number().int().min(1).max(10).optional(),
			/** Share one counter and max-scan across every type with this same
			 * name, instead of one counter per type. */
			sequence: z.string().min(1).optional(),
		})
		.strict(),
	z
		.object({
			strategy: z.literal("inherit"),
			from: z.string().min(1),
		})
		.strict(),
]);

const rawTypeSchema = z
	.object({
		layout: z.enum(["flat", "directory"]),
		dir: z.string().min(1),
		primary: z.string().min(1).optional(),
		siblings: z.array(z.string().min(1)).optional(),
		id: rawIdSchema,
		slugFrom: z.string().regex(FIELD_NAME_RE).optional(),
		fields: z
			.record(z.string().regex(FIELD_NAME_RE), rawFieldSchema)
			.default({}),
		...rawWorkflowShape, // workflow-config.ts
		ownership: z
			.object({
				field: z.string().regex(FIELD_NAME_RE),
				exemptions: z.string().min(1).optional(),
			})
			.strict()
			.optional(),
	})
	.strict();

const rawSelectorSchema = z.union([
	z.string().min(1),
	z
		.object({
			type: z.string().min(1),
			where: z
				.record(
					z.string().regex(FIELD_NAME_RE),
					z.union([z.string(), z.array(z.string()).min(1)]),
				)
				.optional(),
		})
		.strict(),
]);

const rawHierarchySchema = z
	.object({
		parent: z.string().regex(FIELD_NAME_RE),
		children: z.string().regex(FIELD_NAME_RE),
		rules: z
			.array(
				z
					.object({
						child: rawSelectorSchema,
						parents: z.array(rawSelectorSchema),
					})
					.strict(),
			)
			.optional(),
		maxDepth: z.number().int().positive().optional(),
	})
	.strict();

const rawConfigSchema = z
	.object({
		mfw: z.literal(BOARD_CONFIG_VERSION),
		types: z.record(z.string().regex(TYPE_NAME_RE), rawTypeSchema),
		hierarchy: rawHierarchySchema.optional(),
	})
	.strict();

function formatIssues(error: z.ZodError): string {
	return error.issues
		.map((i) =>
			i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message,
		)
		.join("; ");
}

function normalizeRequiredWhen(
	raw: z.infer<typeof rawRequiredWhen> | undefined,
): RequiredWhen | undefined {
	if (!raw) return undefined;
	return Object.fromEntries(
		Object.entries(raw).map(([k, v]) => [k, Array.isArray(v) ? v : [v]]),
	);
}

function normalizeField(raw: z.infer<typeof rawFieldSchema>): FieldSpec {
	const requiredWhen = normalizeRequiredWhen(raw.required_when);
	if ("values" in raw) {
		return {
			kind: "enum",
			values: raw.values,
			list: raw.list ?? false,
			optional: raw.optional ?? false,
			default: raw.default,
			requiredWhen,
		};
	}
	if ("ref" in raw) {
		return {
			kind: "ref",
			ref:
				raw.ref === "any"
					? "any"
					: typeof raw.ref === "string"
						? [raw.ref]
						: raw.ref,
			list: raw.list ?? false,
			acyclic: raw.acyclic ?? false,
			optional: raw.optional ?? false,
			requiredWhen,
		};
	}
	if (raw.type === "checklist") {
		return {
			kind: "checklist",
			list: true,
			optional: raw.optional ?? false,
			requiredWhen,
		};
	}
	return {
		kind: "scalar",
		type: raw.type ?? "string",
		list: raw.list ?? false,
		optional: raw.optional ?? false,
		default: raw.default,
		pattern: raw.pattern,
		requiredWhen,
		rows: raw.rows,
	};
}

/** Parse and fully validate a `board.yaml` document already read into memory. */
export function parseBoardConfig(raw: unknown): BoardConfig {
	const parsed = rawConfigSchema.safeParse(raw);
	if (!parsed.success) {
		throw new BoardConfigError(`board.yaml: ${formatIssues(parsed.error)}`);
	}

	const types: Record<string, TypeSpec> = {};
	for (const [typeName, rawType] of Object.entries(parsed.data.types)) {
		if (rawType.layout === "directory" && !rawType.primary) {
			throw new BoardConfigError(
				`type '${typeName}': layout "directory" requires 'primary'`,
			);
		}
		if (rawType.layout === "flat" && rawType.primary) {
			throw new BoardConfigError(
				`type '${typeName}': 'primary' only applies to layout "directory"`,
			);
		}
		if (rawType.layout === "flat" && rawType.siblings) {
			throw new BoardConfigError(
				`type '${typeName}': 'siblings' only applies to layout "directory"`,
			);
		}
		const fields: Record<string, FieldSpec> = {};
		for (const [fieldName, rawField] of Object.entries(rawType.fields)) {
			if (RESERVED_FIELD_NAMES.has(fieldName)) {
				throw new BoardConfigError(
					`type '${typeName}': field '${fieldName}' is reserved ` +
						"(mfw/id/rev are implicit on every document)",
				);
			}
			if (
				"type" in rawField &&
				rawField.type === "checklist" &&
				(rawField.list !== undefined ||
					rawField.default !== undefined ||
					rawField.pattern !== undefined ||
					rawField.rows !== undefined)
			) {
				throw new BoardConfigError(
					`type '${typeName}' field '${fieldName}': a 'type: checklist' field takes only 'optional' and 'required_when'`,
				);
			}
			const field = normalizeField(rawField);
			if (
				field.kind === "scalar" &&
				field.pattern !== undefined &&
				field.type !== "string"
			) {
				throw new BoardConfigError(
					`type '${typeName}' field '${fieldName}': 'pattern' only applies to type: string (got '${field.type}')`,
				);
			}
			if (field.kind === "ref" && Array.isArray(field.ref)) {
				if (field.ref.includes("any")) {
					throw new BoardConfigError(
						`type '${typeName}' field '${fieldName}': "any" cannot be mixed into a list of ref types`,
					);
				}
			}
			if (field.kind === "scalar" && field.rows !== undefined) {
				if (field.type !== "json" || !field.list) {
					throw new BoardConfigError(
						`type '${typeName}' field '${fieldName}': 'rows' only applies to a 'type: json' list field`,
					);
				}
			}
			fields[fieldName] = field;
		}
		for (const [fieldName, field] of Object.entries(fields)) {
			if (!field.requiredWhen) continue;
			const where = `type '${typeName}' field '${fieldName}'`;
			for (const other of Object.keys(field.requiredWhen)) {
				if (other === fieldName || !(other in fields)) {
					throw new BoardConfigError(
						`${where}: required_when names '${other}', which is not another declared field of this type`,
					);
				}
			}
			if (
				(field.kind === "enum" || field.kind === "scalar") &&
				field.default !== undefined
			) {
				throw new BoardConfigError(
					`${where}: required_when cannot be combined with a default (the default would always satisfy it)`,
				);
			}
		}
		if (rawType.slugFrom && !(rawType.slugFrom in fields)) {
			throw new BoardConfigError(
				`type '${typeName}': slugFrom '${rawType.slugFrom}' is not a declared field`,
			);
		}
		const wf = normalizeWorkflow(
			typeName,
			rawType,
			fields,
			parsed.data.hierarchy,
		); // workflow-config.ts
		if (!wf.ok) throw new BoardConfigError(wf.error);
		types[typeName] = {
			layout: rawType.layout,
			dir: rawType.dir,
			primary: rawType.primary,
			siblings: rawType.siblings ?? [],
			id: rawType.id,
			slugFrom: rawType.slugFrom,
			fields,
			...(wf.workflow ? { workflow: wf.workflow } : {}),
			...(rawType.ownership ? { ownership: rawType.ownership } : {}),
		};
		const own = rawType.ownership;
		if (own) {
			const f = fields[own.field];
			if (f?.kind !== "scalar" || f.type !== "string" || !f.list) {
				throw new BoardConfigError(
					`type '${typeName}': ownership.field '${own.field}' must be a list of strings (a path-glob list field)`,
				);
			}
		}
	}

	// Types sharing a `sequence` share one id space, so they must agree on the
	// id grammar (`pad` is formatting only and may differ).
	const sequenceOwner = new Map<
		string,
		{ type: string; key?: string; suffix?: string }
	>();
	for (const [typeName, spec] of Object.entries(types)) {
		if (spec.id.strategy !== "own-sequence" || !spec.id.sequence) continue;
		const first = sequenceOwner.get(spec.id.sequence);
		if (!first) {
			sequenceOwner.set(spec.id.sequence, {
				type: typeName,
				key: spec.id.key,
				suffix: spec.id.suffix,
			});
		} else if (first.key !== spec.id.key || first.suffix !== spec.id.suffix) {
			throw new BoardConfigError(
				`type '${typeName}': id.sequence '${spec.id.sequence}' is shared with type '${first.type}', so both must declare the same id.key and id.suffix`,
			);
		}
	}

	// Cross-type validation: nothing above could check that a `ref`/`inherit`
	// target actually exists, since types are parsed one at a time.
	for (const [typeName, spec] of Object.entries(types)) {
		if (spec.id.strategy === "inherit" && !(spec.id.from in types)) {
			throw new BoardConfigError(
				`type '${typeName}': id.from '${spec.id.from}' is not a declared type`,
			);
		}
		for (const [fieldName, field] of Object.entries(spec.fields)) {
			if (field.kind !== "ref") continue;
			for (const target of field.ref === "any" ? [] : field.ref) {
				if (!(target in types)) {
					throw new BoardConfigError(
						`type '${typeName}' field '${fieldName}': ref '${target}' is not a declared type`,
					);
				}
			}
			if (
				field.acyclic &&
				!(
					field.list &&
					field.ref !== "any" &&
					field.ref.length === 1 &&
					field.ref[0] === typeName
				)
			) {
				throw new BoardConfigError(
					`type '${typeName}' field '${fieldName}': 'acyclic' only applies to a ` +
						`self-referential list ref (ref: ${typeName}, list: true)`,
				);
			}
		}
	}

	const hierarchy = parsed.data.hierarchy
		? validateHierarchy(parsed.data.hierarchy, types)
		: undefined;
	return hierarchy
		? { mfw: parsed.data.mfw, types, hierarchy }
		: { mfw: parsed.data.mfw, types };
}

/** Does a ref field's declared target cover the named type? */
export function refCovers(
	ref: "any" | readonly string[],
	typeName: string,
): boolean {
	return ref === "any" || ref.includes(typeName);
}

function validateHierarchy(
	raw: z.infer<typeof rawHierarchySchema>,
	types: Record<string, TypeSpec>,
): HierarchySpec {
	const { parent, children } = raw;
	if (parent === children) {
		throw new BoardConfigError(
			"hierarchy: 'parent' and 'children' must be different fields",
		);
	}
	const participating: string[] = [];
	for (const [typeName, spec] of Object.entries(types)) {
		const p = spec.fields[parent];
		const c = spec.fields[children];
		if (!p && !c) continue;
		participating.push(typeName);
		if (!p || !c) {
			throw new BoardConfigError(
				`hierarchy: type '${typeName}' declares '${p ? parent : children}' but not '${p ? children : parent}' (a hierarchy type declares both)`,
			);
		}
		if (p.kind !== "ref" || p.list) {
			throw new BoardConfigError(
				`hierarchy: type '${typeName}' field '${parent}' must be a single (non-list) ref`,
			);
		}
		if (c.kind !== "ref" || !c.list) {
			throw new BoardConfigError(
				`hierarchy: type '${typeName}' field '${children}' must be a list ref`,
			);
		}
	}
	if (participating.length === 0) {
		throw new BoardConfigError(
			`hierarchy: no type declares the '${parent}'/'${children}' fields`,
		);
	}
	const refOf = (typeName: string, field: string) =>
		(types[typeName]?.fields[field] as Extract<FieldSpec, { kind: "ref" }>).ref;
	const selector = (
		raw: string | { type: string; where?: Record<string, string | string[]> },
	): HierarchySelector => {
		const sel = typeof raw === "string" ? { type: raw } : raw;
		if (!(sel.type in types)) {
			throw new BoardConfigError(
				`hierarchy: rule type '${sel.type}' is not a declared type`,
			);
		}
		if (!participating.includes(sel.type)) {
			throw new BoardConfigError(
				`hierarchy: rule type '${sel.type}' does not declare the '${parent}'/'${children}' fields`,
			);
		}
		const where: Record<string, string[]> = {};
		for (const [f, v] of Object.entries(sel.where ?? {})) {
			const spec = types[sel.type]?.fields[f];
			const ok =
				spec !== undefined &&
				!spec.list &&
				(spec.kind === "enum" ||
					(spec.kind === "scalar" && spec.type === "string"));
			if (!ok) {
				throw new BoardConfigError(
					`hierarchy: rule on '${sel.type}': 'where' field '${f}' must be a single-valued enum or string field`,
				);
			}
			const values = Array.isArray(v) ? v : [v];
			if (spec.kind === "enum") {
				for (const x of values) {
					if (!spec.values.includes(x)) {
						throw new BoardConfigError(
							`hierarchy: rule on '${sel.type}': '${x}' is not a value of '${f}'`,
						);
					}
				}
			}
			where[f] = values;
		}
		return Object.keys(where).length > 0
			? { type: sel.type, where }
			: { type: sel.type };
	};
	const rules: HierarchyRule[] = [];
	const seen = new Set<string>();
	for (const r of raw.rules ?? []) {
		const child = selector(r.child);
		const key = describeSelector(child);
		if (seen.has(key)) {
			throw new BoardConfigError(
				`hierarchy: more than one rule for child '${key}'`,
			);
		}
		seen.add(key);
		const parents = r.parents.map(selector);
		for (const p of parents) {
			if (!refCovers(refOf(child.type, parent), p.type)) {
				throw new BoardConfigError(
					`hierarchy: type '${child.type}' field '${parent}' does not accept '${p.type}' as a target, but a rule allows it`,
				);
			}
			if (!refCovers(refOf(p.type, children), child.type)) {
				throw new BoardConfigError(
					`hierarchy: type '${p.type}' field '${children}' does not accept '${child.type}' as a target, but a rule allows it as a child`,
				);
			}
		}
		rules.push({ child, parents });
	}
	return {
		parent,
		children,
		...(raw.rules ? { rules } : {}),
		...(raw.maxDepth !== undefined ? { maxDepth: raw.maxDepth } : {}),
	};
}

export async function loadBoardConfig(path: string): Promise<BoardConfig> {
	let raw: unknown;
	try {
		raw = parseYaml(await readFile(path, "utf8"));
	} catch (e) {
		throw new BoardConfigError(`${path}: ${(e as Error).message}`);
	}
	return parseBoardConfig(raw);
}
