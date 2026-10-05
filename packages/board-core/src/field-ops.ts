import type { BoardConfig, FieldSpec, TypeSpec } from "./config.ts";
import { type ChecklistItem, nextChecklistId } from "./document.ts";
import {
	type BoardDocument,
	type BoardStore,
	DocumentConflictError,
	UnknownTypeError,
	type UpdateInput,
} from "./store.ts";

/**
 * Typed, race-free field operations. Every operation is a pure function of the
 * freshly read document (`computeFieldOp`) run inside `BoardStore.transact`,
 * so two concurrent operations on one document both land; the patch then goes
 * through the normal `materializeFields` validation (enum values, scalar
 * types, patterns, `rows.required`, checklist shape).
 *
 * Duplicate policy: `append`/`prepend`/`insert` refuse a value that is already
 * present (or repeated in the same call) on `enum` and `ref` lists, since a
 * repeated member is never meaningful there; plain scalar lists allow
 * duplicates. `remove` takes out the first occurrence only.
 */

export type FieldOpErrorCode =
	| "unknown-field"
	| "wrong-kind"
	| "bad-selector"
	| "ambiguous-selector"
	| "duplicate"
	| "not-found"
	| "managed-field"
	| "bad-index"
	| "bad-value"
	| "required";

export class FieldOpError extends Error {
	constructor(
		readonly code: FieldOpErrorCode,
		message: string,
	) {
		super(message);
		this.name = "FieldOpError";
	}
}

export type FieldOp =
	/** Replace the whole value (like `update`). */
	| { op: "set"; field: string; value: unknown }
	/** Clear an optional field (a list field becomes `[]`). */
	| { op: "unset"; field: string }
	| { op: "append" | "prepend"; field: string; values: unknown[] }
	| { op: "insert"; field: string; index: number; values: unknown[] }
	| { op: "remove"; field: string; value: unknown; ifPresent?: boolean }
	| { op: "move"; field: string; from: number; to: number }
	| { op: "inc" | "dec"; field: string; by?: number }
	| { op: "toggle"; field: string }
	/** `type: json` list rows, addressed by their `id` key. */
	| { op: "set-row"; field: string; id: string; patch: Record<string, unknown> }
	| { op: "remove-row"; field: string; id: string }
	/** Checklist items; a selector is an item id or a unique text prefix. */
	| { op: "check-add"; field: string; text: string; done?: boolean }
	| { op: "check-toggle" | "check-remove"; field: string; selector: string }
	| { op: "check-set"; field: string; selector: string; done: boolean }
	| { op: "check-edit"; field: string; selector: string; text: string }
	/** Append a `### <UTC timestamp> - <text>` entry under a `##` section
	 * (default `Progress`, created at the end of the body if absent). */
	| { op: "note"; text: string; section?: string }
	/** Replace a `##` section's content (created if absent). */
	| { op: "section-set"; section: string; content: string };

export interface FieldOpOptions {
	baseRev?: number;
	/** Timestamp source for `note` (tests). */
	now?: Date;
}

export interface FieldOpResult {
	doc: BoardDocument;
	/** `check-add`: the id assigned to the new item. */
	itemId?: string;
	/** False when the op was a deliberate no-op (`remove` with `ifPresent`). */
	changed: boolean;
}

const same = (a: unknown, b: unknown) =>
	JSON.stringify(a) === JSON.stringify(b);
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const show = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function specOf(type: TypeSpec, typeName: string, field: string): FieldSpec {
	const spec = type.fields[field];
	if (!spec) {
		throw new FieldOpError(
			"unknown-field",
			`type '${typeName}' has no field '${field}' (fields: ${Object.keys(type.fields).join(", ") || "none"})`,
		);
	}
	return spec;
}

function plainList(spec: FieldSpec, field: string, op: string): void {
	if (spec.kind === "checklist") {
		throw new FieldOpError(
			"wrong-kind",
			`'${op}' does not apply to checklist field '${field}'; use check-add/check-toggle/...`,
		);
	}
	if (!spec.list) {
		throw new FieldOpError(
			"wrong-kind",
			`'${op}' needs a list field; '${field}' is not a list`,
		);
	}
}

function jsonRows(spec: FieldSpec, field: string, op: string): void {
	if (spec.kind !== "scalar" || spec.type !== "json" || !spec.list) {
		throw new FieldOpError(
			"wrong-kind",
			`'${op}' needs a 'type: json' list field; '${field}' is not one`,
		);
	}
}

function checklistField(spec: FieldSpec, field: string, op: string): void {
	if (spec.kind !== "checklist") {
		throw new FieldOpError(
			"wrong-kind",
			`'${op}' needs a checklist field; '${field}' is not one`,
		);
	}
}

/** Resolve a checklist selector: an item id, else a unique exact text, else a
 * unique (case-insensitive) text prefix. */
export function resolveChecklistItem(
	items: readonly ChecklistItem[],
	selector: string,
): ChecklistItem {
	const sel = selector.trim();
	if (sel.length === 0) {
		throw new FieldOpError("bad-selector", "empty checklist selector");
	}
	const list = (xs: readonly ChecklistItem[]) =>
		xs.map((i) => `${i.id} "${i.text}"`).join(", ");
	const byId = items.find((i) => i.id === sel);
	if (byId) return byId;
	const exact = items.filter((i) => i.text === sel);
	if (exact.length === 1) return exact[0] as ChecklistItem;
	const lower = sel.toLowerCase();
	const matches = items.filter((i) => i.text.toLowerCase().startsWith(lower));
	if (matches.length === 1) return matches[0] as ChecklistItem;
	if (matches.length > 1) {
		throw new FieldOpError(
			"ambiguous-selector",
			`selector '${sel}' matches ${matches.length} items: ${list(matches)}`,
		);
	}
	throw new FieldOpError(
		"not-found",
		`no checklist item matches '${sel}' (items: ${list(items) || "none"})`,
	);
}

// ---------------------------------------------------------------------------
// Body sections
// ---------------------------------------------------------------------------

interface SectionRange {
	/** Line index of the `## name` heading. */
	start: number;
	/** Line index of the next `## ` heading (or the line count). */
	end: number;
}

/** Find a `## <name>` section, ignoring headings inside fenced code blocks. */
function findSection(lines: string[], name: string): SectionRange | null {
	let fence = false;
	let start = -1;
	const want = name.trim().toLowerCase();
	for (const [i, line] of lines.entries()) {
		if (/^\s*(```|~~~)/.test(line)) fence = !fence;
		if (fence) continue;
		const m = /^## (.*?)\s*$/.exec(line);
		if (!m) continue;
		if (start !== -1) return { start, end: i };
		if ((m[1] as string).trim().toLowerCase() === want) start = i;
	}
	return start === -1 ? null : { start, end: lines.length };
}

function sectionName(name: string | undefined, dflt?: string): string {
	const n = (name ?? dflt ?? "").trim();
	if (n.length === 0 || /[\n\r]/.test(n)) {
		throw new FieldOpError("bad-value", "section name must be a single line");
	}
	return n;
}

function editSection(
	body: string,
	name: string,
	fn: (existing: string) => string,
): string {
	const lines = body.length > 0 ? body.split("\n") : [];
	const range = findSection(lines, name);
	if (!range) {
		const head = body.replace(/\s+$/, "");
		return `${head ? `${head}\n\n` : ""}## ${name}\n\n${fn("")}`;
	}
	const existing = lines
		.slice(range.start + 1, range.end)
		.join("\n")
		.trim();
	const before = lines.slice(0, range.start).join("\n").trimEnd();
	const after = lines.slice(range.end).join("\n");
	return [
		before ? `${before}\n\n` : "",
		`## ${lines[range.start]?.slice(3).trim()}\n\n${fn(existing)}`,
		after ? `\n\n${after}` : "",
	]
		.join("")
		.trimEnd();
}

// ---------------------------------------------------------------------------
// Patch computation
// ---------------------------------------------------------------------------

export interface ComputedOp {
	patch: UpdateInput;
	itemId?: string;
}

/** The patch an op makes against `current` (pure; no I/O, no validation of
 * the final document - `transact` runs `materializeFields` on the result). */
export function computeFieldOp(
	type: TypeSpec,
	typeName: string,
	current: Pick<BoardDocument, "fields" | "body">,
	op: FieldOp,
	now: Date = new Date(),
): ComputedOp {
	if (op.op === "note" || op.op === "section-set") {
		return { patch: { body: computeBody(current.body, op, now) } };
	}
	const field = op.field;
	const spec = specOf(type, typeName, field);
	const cur = current.fields[field];
	const fieldsPatch = (value: unknown): ComputedOp => ({
		patch: { fields: { [field]: value } },
	});
	const list = (): unknown[] => [...asArray(cur)];

	switch (op.op) {
		case "set":
			return fieldsPatch(op.value);
		case "unset":
			if (!spec.list && !spec.optional) {
				throw new FieldOpError(
					"required",
					`field '${field}' is required and cannot be unset`,
				);
			}
			return fieldsPatch(null);
		case "append":
		case "prepend":
		case "insert": {
			plainList(spec, field, op.op);
			if (op.values.length === 0) {
				throw new FieldOpError(
					"bad-value",
					`'${op.op}' needs at least one value`,
				);
			}
			const items = list();
			guardDuplicates(spec, field, items, op.values);
			if (op.op === "insert") {
				if (
					!Number.isInteger(op.index) ||
					op.index < 0 ||
					op.index > items.length
				) {
					throw new FieldOpError(
						"bad-index",
						`insert index ${op.index} out of range 0..${items.length} for '${field}'`,
					);
				}
				items.splice(op.index, 0, ...op.values);
			} else if (op.op === "append") items.push(...op.values);
			else items.unshift(...op.values);
			return fieldsPatch(items);
		}
		case "remove": {
			plainList(spec, field, "remove");
			const items = list();
			const i = items.findIndex((x) => same(x, op.value));
			if (i === -1) {
				if (op.ifPresent) return { patch: {} };
				throw new FieldOpError(
					"not-found",
					`'${show(op.value)}' is not in '${field}'`,
				);
			}
			items.splice(i, 1);
			return fieldsPatch(items);
		}
		case "move": {
			plainList(spec, field, "move");
			const items = list();
			for (const [label, n] of [
				["from", op.from],
				["to", op.to],
			] as const) {
				if (!Number.isInteger(n) || n < 0 || n >= items.length) {
					throw new FieldOpError(
						"bad-index",
						`move ${label} index ${n} out of range 0..${items.length - 1} for '${field}'`,
					);
				}
			}
			const [moved] = items.splice(op.from, 1);
			items.splice(op.to, 0, moved);
			return fieldsPatch(items);
		}
		case "inc":
		case "dec": {
			if (spec.kind !== "scalar" || spec.type !== "number" || spec.list) {
				throw new FieldOpError(
					"wrong-kind",
					`'${op.op}' needs a non-list number field; '${field}' is not one`,
				);
			}
			const by = op.by ?? 1;
			if (typeof by !== "number" || !Number.isFinite(by)) {
				throw new FieldOpError(
					"bad-value",
					`'${op.op}' amount must be a number`,
				);
			}
			const base = typeof cur === "number" ? cur : 0;
			return fieldsPatch(op.op === "inc" ? base + by : base - by);
		}
		case "toggle": {
			if (spec.kind !== "scalar" || spec.type !== "boolean" || spec.list) {
				throw new FieldOpError(
					"wrong-kind",
					`'toggle' needs a non-list boolean field; '${field}' is not one`,
				);
			}
			return fieldsPatch(cur !== true);
		}
		case "set-row":
		case "remove-row": {
			jsonRows(spec, field, op.op);
			const rows = list();
			const i = rows.findIndex((r) => isObject(r) && String(r.id) === op.id);
			if (i === -1) {
				throw new FieldOpError(
					"not-found",
					`no row with id '${op.id}' in '${field}'`,
				);
			}
			if (op.op === "remove-row") rows.splice(i, 1);
			else {
				if (!isObject(op.patch)) {
					throw new FieldOpError("bad-value", "row patch must be an object");
				}
				const merged = { ...(rows[i] as Record<string, unknown>), ...op.patch };
				if (
					"id" in op.patch &&
					rows.some((r, j) => j !== i && isObject(r) && same(r.id, merged.id))
				) {
					throw new FieldOpError(
						"duplicate",
						`a row with id '${show(merged.id)}' already exists`,
					);
				}
				rows[i] = merged;
			}
			return fieldsPatch(rows);
		}
		case "check-add": {
			checklistField(spec, field, op.op);
			if (typeof op.text !== "string" || op.text.trim().length === 0) {
				throw new FieldOpError(
					"bad-value",
					"checklist item text must not be empty",
				);
			}
			const items = list() as ChecklistItem[];
			const id = nextChecklistId(items);
			items.push({ id, text: op.text.trim(), done: op.done === true });
			return { patch: { fields: { [field]: items } }, itemId: id };
		}
		default: {
			checklistField(spec, field, op.op);
			const items = list() as ChecklistItem[];
			const item = resolveChecklistItem(items, op.selector);
			const edit = (i: ChecklistItem): ChecklistItem | null => {
				switch (op.op) {
					case "check-toggle":
						return { ...i, done: !i.done };
					case "check-set":
						return { ...i, done: op.done };
					case "check-remove":
						return null;
					case "check-edit":
						if (typeof op.text !== "string" || op.text.trim().length === 0) {
							throw new FieldOpError(
								"bad-value",
								"checklist item text must not be empty",
							);
						}
						return { ...i, text: op.text.trim() };
				}
			};
			const next: ChecklistItem[] = [];
			for (const i of items) {
				const r = i.id === item.id ? edit(i) : i;
				if (r) next.push(r);
			}
			return { patch: { fields: { [field]: next } }, itemId: item.id };
		}
	}
}

function guardDuplicates(
	spec: FieldSpec,
	field: string,
	existing: unknown[],
	added: unknown[],
): void {
	if (spec.kind !== "enum" && spec.kind !== "ref") {
		// Plain json rows with an `id` still must not share one.
		if (spec.kind === "scalar" && spec.type === "json") {
			const ids = new Set(existing.filter(isObject).map((r) => String(r.id)));
			for (const r of added) {
				if (isObject(r) && r.id !== undefined) {
					if (ids.has(String(r.id))) {
						throw new FieldOpError(
							"duplicate",
							`a row with id '${show(r.id)}' is already in '${field}'`,
						);
					}
					ids.add(String(r.id));
				}
			}
		}
		return;
	}
	const seen = new Set(existing.map(show));
	for (const v of added) {
		if (seen.has(show(v))) {
			throw new FieldOpError(
				"duplicate",
				`'${show(v)}' is already in '${field}'`,
			);
		}
		seen.add(show(v));
	}
}

function computeBody(
	body: string,
	op: Extract<FieldOp, { op: "note" | "section-set" }>,
	now: Date,
): string {
	if (op.op === "section-set") {
		const name = sectionName(op.section);
		return editSection(body, name, () => op.content.trim());
	}
	if (typeof op.text !== "string" || op.text.trim().length === 0) {
		throw new FieldOpError("bad-value", "note text must not be empty");
	}
	const name = sectionName(op.section, "Progress");
	const stamp = now.toISOString().replace(/\.\d{3}Z$/, "Z");
	const entry = `### ${stamp} - ${op.text.trim()}`;
	return editSection(body, name, (existing) =>
		existing ? `${existing}\n\n${entry}` : entry,
	);
}

// ---------------------------------------------------------------------------
// Store wrapper
// ---------------------------------------------------------------------------

/** A hierarchy `parent`/`children` field is changed by re-parenting, never by
 * a field op (it would desync the two sides of the relation). */
function refuseManaged(config: BoardConfig, type: TypeSpec, op: FieldOp): void {
	const h = config.hierarchy;
	if (!h || !("field" in op)) return;
	if (
		(op.field === h.parent || op.field === h.children) &&
		op.field in type.fields
	) {
		throw new FieldOpError(
			"managed-field",
			`'${op.field}' is managed by the board hierarchy; change it by re-parenting, not with '${op.op}'`,
		);
	}
}

async function checkRefTargets(
	store: BoardStore,
	config: BoardConfig,
	spec: FieldSpec,
	before: unknown,
	after: unknown,
): Promise<void> {
	if (spec.kind !== "ref") return;
	const had = new Set(Array.isArray(before) ? before : [before]);
	const targets = spec.ref === "any" ? Object.keys(config.types) : spec.ref;
	for (const v of asArray(after).concat(spec.list ? [] : [after])) {
		if (typeof v !== "string" || had.has(v)) continue;
		let found = false;
		for (const t of targets) {
			if (await store.readDocument(t, v)) {
				found = true;
				break;
			}
		}
		if (!found) {
			throw new FieldOpError(
				"not-found",
				`'${v}' does not exist (looked in ${targets.join("/")})`,
			);
		}
	}
}

/** Apply one field operation atomically; see `FieldOp`. Also returns what the
 * op produced (`check-add`'s new item id). */
export async function applyFieldOpDetailed(
	store: BoardStore,
	config: BoardConfig,
	typeName: string,
	id: string,
	op: FieldOp,
	opts: FieldOpOptions = {},
): Promise<FieldOpResult> {
	const type = config.types[typeName];
	if (!type) throw new UnknownTypeError(typeName);
	refuseManaged(config, type, op);
	let itemId: string | undefined;
	let seen: BoardDocument | undefined;
	const written = await store.transact(typeName, id, async (current) => {
		seen = current;
		if (opts.baseRev !== undefined && opts.baseRev !== current.rev) {
			throw new DocumentConflictError(typeName, id, current.rev);
		}
		const computed = computeFieldOp(type, typeName, current, op, opts.now);
		itemId = computed.itemId;
		if (!computed.patch.fields && computed.patch.body === undefined)
			return null;
		if ("field" in op && computed.patch.fields) {
			const spec = type.fields[op.field] as FieldSpec;
			await checkRefTargets(
				store,
				config,
				spec,
				current.fields[op.field],
				computed.patch.fields[op.field],
			);
		}
		return computed.patch;
	});
	if (written) return { doc: written, itemId, changed: true };
	return { doc: seen as BoardDocument, itemId, changed: false };
}

export async function applyFieldOp(
	store: BoardStore,
	config: BoardConfig,
	typeName: string,
	id: string,
	op: FieldOp,
	opts: FieldOpOptions = {},
): Promise<BoardDocument> {
	return (await applyFieldOpDetailed(store, config, typeName, id, op, opts))
		.doc;
}
