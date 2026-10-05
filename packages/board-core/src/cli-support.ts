import type { BoardConfig, FieldSpec } from "./config.ts";
import type { BoardDocument } from "./store.ts";

/** Shared by `board-core`'s own CLI and any CLI layered on top of it (e.g.
 * mfw's richer one) — "how a `field=value` argv token becomes a typed field
 * value" has exactly one implementation. */

export function coerceScalar(
	type: "string" | "number" | "boolean" | "date" | "json",
	raw: string,
): unknown {
	if (type === "number") {
		const n = raw.trim() === "" ? Number.NaN : Number(raw);
		if (!Number.isFinite(n)) {
			throw new Error(`field must be a number, got '${raw}'`);
		}
		return n;
	}
	if (type === "boolean") {
		if (raw !== "true" && raw !== "false") {
			throw new Error(`field must be true or false, got '${raw}'`);
		}
		return raw === "true";
	}
	if (type === "json") return JSON.parse(raw);
	return raw;
}

/** Splits on comma for a `list:` field, per the field's declared kind. */
export function coerceFieldValue(spec: FieldSpec, raw: string): unknown {
	if (spec.kind === "checklist") {
		const t = raw.trim();
		if (t.startsWith("[")) return JSON.parse(t);
		return t.length === 0
			? []
			: t
					.split(",")
					.map((p) => p.trim())
					.filter((p) => p.length > 0)
					.map((text) => ({ text }));
	}
	if (spec.list) {
		// A `type: json` list takes a JSON array literally (its elements may
		// contain commas); the comma form stays for every other list.
		if (spec.kind === "scalar" && spec.type === "json") {
			const t = raw.trim();
			if (t.startsWith("[")) {
				const parsed: unknown = JSON.parse(t);
				if (!Array.isArray(parsed))
					throw new Error("field must be a JSON array");
				return parsed;
			}
		}
		const parts = raw.length === 0 ? [] : raw.split(",");
		return spec.kind === "scalar"
			? parts.map((p) => coerceScalar(spec.type, p))
			: parts;
	}
	return spec.kind === "scalar" ? coerceScalar(spec.type, raw) : raw;
}

/** One element of a list field (`append`/`insert`/`remove` operands): the
 * single-value counterpart of `coerceFieldValue`'s per-element step. */
export function coerceListElement(spec: FieldSpec, raw: string): unknown {
	return spec.kind === "scalar" ? coerceScalar(spec.type, raw) : raw;
}

/** Parses a list of `field=value` argv tokens against a declared type. */
export function parseFieldArgs(
	config: BoardConfig,
	typeName: string,
	args: readonly string[],
): Record<string, unknown> {
	const type = config.types[typeName];
	if (!type) throw new Error(`unknown type '${typeName}'`);
	const out: Record<string, unknown> = {};
	for (const arg of args) {
		const eq = arg.indexOf("=");
		const key = arg.slice(0, eq);
		const raw = arg.slice(eq + 1);
		const spec: FieldSpec | undefined = type.fields[key];
		if (!spec) throw new Error(`type '${typeName}' has no field '${key}'`);
		try {
			out[key] = coerceFieldValue(spec, raw);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(msg.replace(/^field must/, `${key} must`));
		}
	}
	return out;
}

export function printDocument(
	doc: BoardDocument,
	log: (line: string) => void = console.log,
): void {
	log(`${doc.type} ${doc.id} (rev ${doc.rev})`);
	for (const [k, v] of Object.entries(doc.fields)) {
		log(`  ${k}: ${JSON.stringify(v)}`);
	}
	if (doc.body.trim()) {
		log("");
		log(doc.body);
	}
}

export interface QueryFilter {
	field: string;
	/** `eq`: the field's string value must equal one of `values` (OR within
	 * the filter). `has`: the field (a list) must contain one of `values`. */
	op: "eq" | "has";
	values: string[];
}

/** Parses `field=a|b` (exact match, `|`-alternation) and `field~a|b` (list
 * membership) argv tokens for `list`'s query filters — a shell script can
 * build these without any project-specific code. Whichever operator
 * character appears first in the token wins, so a field name itself must
 * contain neither. */
export function parseQueryFilters(args: readonly string[]): QueryFilter[] {
	return args.map((arg) => {
		const eq = arg.indexOf("=");
		const has = arg.indexOf("~");
		const op: "eq" | "has" =
			has !== -1 && (eq === -1 || has < eq) ? "has" : "eq";
		const i = op === "has" ? has : eq;
		if (i === -1) {
			throw new Error(
				`invalid filter '${arg}' (expected field=value or field~value)`,
			);
		}
		return { field: arg.slice(0, i), op, values: arg.slice(i + 1).split("|") };
	});
}

/** A document matches when every filter matches (AND across filters, OR
 * within one filter's `|`-separated values) — the same semantics `list`'s
 * plain `field=value` always had, extended rather than replaced. */
export function matchesQueryFilters(
	doc: BoardDocument,
	filters: readonly QueryFilter[],
): boolean {
	return filters.every((f) => {
		const raw = f.field === "id" ? doc.id : doc.fields[f.field];
		if (f.op === "has") {
			return Array.isArray(raw) && f.values.some((v) => raw.includes(v));
		}
		return f.values.includes(String(raw));
	});
}

/** A document as a plain JSON-serializable object, for `--json` output. */
export function documentToJson(doc: BoardDocument): Record<string, unknown> {
	return {
		type: doc.type,
		id: doc.id,
		rev: doc.rev,
		fields: doc.fields,
		body: doc.body,
		path: doc.path,
		hash: doc.hash,
	};
}
