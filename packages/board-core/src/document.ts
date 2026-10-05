import { Document, isMap, isScalar, isSeq, parse as parseYaml } from "yaml";
import {
	anchoredPattern,
	BOARD_CONFIG_VERSION,
	type FieldSpec,
	type TypeSpec,
} from "./config.ts";

/**
 * Generic document format: YAML frontmatter + markdown body. Every field
 * beyond `mfw`/`id`/`rev` is whatever the type's `board.yaml` entry declares —
 * this module has no idea what a "task" or an "ADR" is.
 */

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

/** A bare top-level `mfw:` key, matched on raw text (not a full YAML parse) so
 * a document that claims to be ours but has broken YAML still routes to the
 * real parser and surfaces a real error, instead of being silently skipped as
 * "not ours". */
const MFW_MARKER_RE = /^mfw:[ \t]*\S/m;

/** Does this file claim to be a board document at all? A loose `.md` file
 * with no `mfw:` marker (a README, someone's personal note, another tool's
 * frontmatter) is not adopted — only a file that at least claims a version is
 * ours to parse, validate, and report errors on. */
export function looksLikeBoardDocument(raw: string): boolean {
	const m = FRONTMATTER_RE.exec(raw);
	if (!m) return false;
	return MFW_MARKER_RE.test(m[1] as string);
}

export interface ParsedDocument {
	id: string;
	rev: number;
	fields: Record<string, unknown>;
	body: string;
}

export type ParseResult =
	| { ok: true; doc: ParsedDocument }
	| { ok: false; reason: string };

function normalizeBody(body: string): string {
	return body.replace(/^(?:[ \t]*\n)+/, "").replace(/\s+$/, "");
}

export type FieldsResult =
	| { ok: true; fields: Record<string, unknown> }
	| { ok: false; errors: string[] };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** One scalar value against its field's `type`/`pattern`, or an error
 * fragment (no field name — the caller has that context). `json` has no
 * shape check beyond already being a JS value (it parsed), by design. */
function scalarTypeError(
	spec: Extract<FieldSpec, { kind: "scalar" }>,
	value: unknown,
): string | null {
	switch (spec.type) {
		case "string":
			if (typeof value !== "string") return "must be a string";
			if (spec.pattern && !anchoredPattern(spec.pattern).test(value)) {
				return `must match /${spec.pattern}/`;
			}
			return null;
		case "number":
			return typeof value === "number" && Number.isFinite(value)
				? null
				: "must be a number";
		case "boolean":
			return typeof value === "boolean" ? null : "must be a boolean";
		case "date":
			return typeof value === "string" && DATE_RE.test(value)
				? null
				: "must be a YYYY-MM-DD date string";
		case "json":
			return null;
	}
}

export interface ChecklistItem {
	id: string;
	text: string;
	done: boolean;
}

/** `{done, total}` of a checklist's items. */
export function checklistProgress(items: readonly { done: boolean }[]): {
	done: number;
	total: number;
} {
	return { done: items.filter((i) => i.done).length, total: items.length };
}

const CHECKLIST_ID_RE = /^c(\d+)$/;

/** The next free checklist item id: `c` + one above the highest existing
 * `c<N>` (so it never collides with a present id). */
export function nextChecklistId(items: readonly { id?: unknown }[]): string {
	let max = 0;
	for (const item of items) {
		const m =
			typeof item.id === "string" ? CHECKLIST_ID_RE.exec(item.id) : null;
		if (m) max = Math.max(max, Number(m[1]));
	}
	return `c${max + 1}`;
}

/** Validate a checklist value, assigning ids to items that lack one (and
 * `done: false` where omitted). Items are normalized to `{id, text, done}`. */
export function normalizeChecklist(
	value: unknown,
): { ok: true; items: ChecklistItem[] } | { ok: false; error: string } {
	if (!Array.isArray(value)) return { ok: false, error: "must be a list" };
	const seen = new Set<string>();
	for (const [i, item] of value.entries()) {
		if (typeof item !== "object" || item === null || Array.isArray(item)) {
			return { ok: false, error: `item ${i + 1} must be an object` };
		}
		const o = item as Record<string, unknown>;
		for (const key of Object.keys(o)) {
			if (key !== "id" && key !== "text" && key !== "done") {
				return { ok: false, error: `item ${i + 1} has unknown key '${key}'` };
			}
		}
		if (typeof o.text !== "string" || o.text.trim().length === 0) {
			return {
				ok: false,
				error: `item ${i + 1} needs a non-empty string 'text'`,
			};
		}
		if (o.done !== undefined && typeof o.done !== "boolean") {
			return { ok: false, error: `item ${i + 1}: 'done' must be a boolean` };
		}
		if (o.id !== undefined) {
			if (typeof o.id !== "string" || o.id.length === 0) {
				return {
					ok: false,
					error: `item ${i + 1}: 'id' must be a non-empty string`,
				};
			}
			if (seen.has(o.id)) {
				return { ok: false, error: `duplicate item id '${o.id}'` };
			}
			seen.add(o.id);
		}
	}
	const items: ChecklistItem[] = [];
	for (const item of value as Record<string, unknown>[]) {
		const id =
			(item.id as string | undefined) ?? nextChecklistId([...items, ...value]);
		items.push({ id, text: item.text as string, done: item.done === true });
	}
	return { ok: true, items };
}

/** `rows.required`: every row of a `type: json` list must be an object
 * carrying each required key (present and not null). */
function rowsError(
	spec: Extract<FieldSpec, { kind: "scalar" }>,
	rows: unknown[],
): string | null {
	if (!spec.rows) return null;
	for (const [i, row] of rows.entries()) {
		if (typeof row !== "object" || row === null || Array.isArray(row)) {
			return `row ${i + 1} must be an object`;
		}
		const missing = spec.rows.required.filter(
			(k) => (row as Record<string, unknown>)[k] == null,
		);
		if (missing.length > 0) {
			return `row ${i + 1} is missing required key(s) ${missing.map((k) => `'${k}'`).join(", ")}`;
		}
	}
	return null;
}

/**
 * Validate and default a plain value record (already-parsed YAML, or a
 * programmatic `create`/`update` input) against a type's declared fields.
 * Shared by `parseDocument` and `BoardStore`'s create/update, so "what counts
 * as a valid document" has exactly one implementation.
 */
export function materializeFields(
	typeName: string,
	type: TypeSpec,
	input: Record<string, unknown>,
): FieldsResult {
	const errors: string[] = [];
	const fields: Record<string, unknown> = {};
	// Fields whose `required_when` condition can only be judged once every
	// other field has its final (defaulted) value.
	const conditional: string[] = [];
	for (const [fieldName, spec] of Object.entries(type.fields)) {
		const present = fieldName in input;
		const value = input[fieldName];
		// `null` is this engine's own sentinel for "optional and absent" (see the
		// `optional` branch just below) — a document's own `fields` record must
		// round-trip through here unchanged, so `null` is absent too, not a value
		// to validate against the field's declared kind.
		if (
			!present ||
			value === undefined ||
			value === null ||
			(spec.requiredWhen && Array.isArray(value) && value.length === 0)
		) {
			if (
				(spec.kind === "enum" || spec.kind === "scalar") &&
				spec.default !== undefined
			) {
				fields[fieldName] = spec.default;
			} else if (spec.requiredWhen) {
				fields[fieldName] = spec.list ? [] : null;
				conditional.push(fieldName);
			} else if (spec.list) {
				fields[fieldName] = [];
			} else if (spec.optional) {
				fields[fieldName] = null;
			} else {
				errors.push(
					`missing required field '${fieldName}' (no default; pass ${fieldName}=...)`,
				);
			}
			continue;
		}
		if (spec.kind === "enum") {
			const values = spec.list ? value : [value];
			if (
				!Array.isArray(values) ||
				values.some((v) => typeof v !== "string" || !spec.values.includes(v))
			) {
				errors.push(
					`field '${fieldName}' must be ${spec.list ? "a list of " : ""}one of ${spec.values.join(", ")}`,
				);
			} else {
				fields[fieldName] = value;
			}
		} else if (spec.kind === "ref") {
			const values = spec.list ? value : [value];
			if (!Array.isArray(values) || values.some((v) => typeof v !== "string")) {
				errors.push(
					`field '${fieldName}' must be ${spec.list ? "a list of ids" : "an id"}`,
				);
			} else {
				fields[fieldName] = value;
			}
		} else if (spec.kind === "checklist") {
			const r = normalizeChecklist(value);
			if (r.ok) fields[fieldName] = r.items;
			else errors.push(`field '${fieldName}': ${r.error}`);
		} else if (spec.list) {
			if (!Array.isArray(value)) {
				errors.push(`field '${fieldName}' must be a list`);
			} else {
				const err = value
					.map((v) => scalarTypeError(spec, v))
					.find((e) => e !== null);
				if (err) errors.push(`field '${fieldName}': each item ${err}`);
				else {
					const rowErr = rowsError(spec, value);
					if (rowErr) errors.push(`field '${fieldName}': ${rowErr}`);
					else fields[fieldName] = value;
				}
			}
		} else {
			const err = scalarTypeError(spec, value);
			if (err) errors.push(`field '${fieldName}' ${err}`);
			else fields[fieldName] = value;
		}
	}
	for (const fieldName of conditional) {
		const when = (type.fields[fieldName] as FieldSpec).requiredWhen ?? {};
		const hit = Object.entries(when).find(([other, wanted]) => {
			const actual = fields[other];
			const actuals = Array.isArray(actual) ? actual : [actual];
			return actuals.some((a) => wanted.includes(a as never));
		});
		if (hit) {
			errors.push(
				`missing required field '${fieldName}': required when '${hit[0]}' is ${hit[1].join(" or ")} (no default; pass ${fieldName}=...)`,
			);
		}
	}
	for (const key of Object.keys(input)) {
		if (key === "mfw" || key === "id" || key === "rev") continue;
		if (!(key in type.fields))
			errors.push(`unknown field '${key}' for type '${typeName}'`);
	}
	return errors.length > 0 ? { ok: false, errors } : { ok: true, fields };
}

export function parseDocument(
	raw: string,
	typeName: string,
	type: TypeSpec,
): ParseResult {
	const m = FRONTMATTER_RE.exec(raw.replace(/\r\n/g, "\n"));
	if (!m) return { ok: false, reason: "missing or malformed frontmatter" };

	let data: unknown;
	try {
		data = parseYaml(m[1] as string);
	} catch (e) {
		return { ok: false, reason: `invalid YAML: ${(e as Error).message}` };
	}
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return { ok: false, reason: "frontmatter must be a YAML mapping" };
	}
	const obj = data as Record<string, unknown>;

	if (obj.mfw !== BOARD_CONFIG_VERSION) {
		return {
			ok: false,
			reason: `unsupported mfw document version (got ${JSON.stringify(obj.mfw)}, this board understands ${BOARD_CONFIG_VERSION})`,
		};
	}
	if (typeof obj.id !== "string" || obj.id.length === 0) {
		return { ok: false, reason: "missing 'id'" };
	}
	const rev =
		typeof obj.rev === "number" && Number.isInteger(obj.rev) ? obj.rev : 1;

	const result = materializeFields(typeName, type, obj);
	if (!result.ok) return { ok: false, reason: result.errors.join("; ") };

	return {
		ok: true,
		doc: {
			id: obj.id,
			rev,
			fields: result.fields,
			body: normalizeBody(m[2] ?? ""),
		},
	};
}

function frontmatterObject(
	type: TypeSpec,
	doc: { id: string; rev: number; fields: Record<string, unknown> },
): Record<string, unknown> {
	const out: Record<string, unknown> = {
		mfw: BOARD_CONFIG_VERSION,
		id: doc.id,
		rev: doc.rev,
	};
	for (const [fieldName, spec] of Object.entries(type.fields)) {
		const value = doc.fields[fieldName];
		const isEmptyList = spec.list && Array.isArray(value) && value.length === 0;
		const isDefault =
			(spec.kind === "enum" || spec.kind === "scalar") &&
			spec.default !== undefined &&
			value === spec.default;
		const isAbsent = value === undefined || value === null;
		if (isDefault) continue;
		if (isEmptyList && (spec.optional || true)) continue; // quiet by default: an empty list never needs to be written
		if (isAbsent && spec.optional) continue;
		out[fieldName] = value;
	}
	return out;
}

/** A flow-style sequence is a readability convenience for a short list of
 * scalars (`labels: [hitl, research]`); past this width — or with a single
 * non-scalar item, e.g. a `type: json` list of objects — it stops being
 * readable and makes every one-row edit a whole-line diff, so block style
 * (the renderer's default for anything NOT explicitly flagged flow) is
 * strictly better. The width is approximate on purpose: this only chooses a
 * style, it never changes what a round-trip reads back as. */
const FLOW_WIDTH = 100;

function fitsFlowStyle(seq: { items: unknown[] }): boolean {
	let width = 2; // "[" + "]"
	for (const item of seq.items) {
		if (!isScalar(item)) return false;
		width += String(item.value).length + 2; // ", "
		if (width > FLOW_WIDTH) return false;
	}
	return true;
}

export function renderDocument(
	type: TypeSpec,
	doc: {
		id: string;
		rev: number;
		fields: Record<string, unknown>;
		body: string;
	},
): string {
	const fmDoc = new Document(frontmatterObject(type, doc));
	if (isMap(fmDoc.contents)) {
		for (const item of fmDoc.contents.items) {
			if (isSeq(item.value) && fitsFlowStyle(item.value)) {
				item.value.flow = true;
			}
		}
	}
	// Disable the stringifier's own 80-column wrap: `fitsFlowStyle` already
	// decided which sequences are short enough for one line, and a prose value
	// wrapping mid-sentence only makes its own diff noisier for no benefit.
	const fm = fmDoc.toString({ lineWidth: 0, flowCollectionPadding: false });
	const body = normalizeBody(doc.body);
	return `---\n${fm}---\n${body ? `\n${body}\n` : ""}`;
}
