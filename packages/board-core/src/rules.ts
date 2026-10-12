import type { FieldRule, FieldSpec, RequiredWhen, TypeSpec } from "./config.ts";

/**
 * Evaluates a type's `rules` over one document's fields. Pure: no I/O, no
 * board access, so the store can run it inside a write's lock and `check` can
 * run it over every document with the same result.
 */

export interface RuleViolation {
	rule: string;
	severity: "error" | "advisory";
	field: string;
	/** The offending item: a row/checklist id, the list element, or null for a scalar. */
	item: string | null;
	message: string;
}

const TEXT_MAX = 90;

function clip(text: string): string {
	return text.length > TEXT_MAX ? text.slice(0, TEXT_MAX) : text;
}

function holds(
	when: RequiredWhen | undefined,
	fields: Record<string, unknown>,
) {
	if (!when) return true;
	return Object.entries(when).every(([k, values]) =>
		values.some((v) => fields[k] === v),
	);
}

interface Item {
	/** Row/checklist id when it has one, else the element itself or an index. */
	label: string | null;
	/** The row/item as an object (rows, checklist items), else undefined. */
	row?: Record<string, unknown>;
	/** The text patterns apply to; undefined when the item has none. */
	text?: string;
}

function itemsOf(spec: FieldSpec, rule: FieldRule, value: unknown): Item[] {
	if (value === undefined || value === null) return [];
	if (
		spec.kind === "checklist" ||
		(spec.kind === "scalar" && spec.type === "json" && spec.list)
	) {
		if (!Array.isArray(value)) return [];
		const key = spec.kind === "checklist" ? "text" : rule.key;
		return value.flatMap((row, i): Item[] => {
			if (typeof row !== "object" || row === null || Array.isArray(row))
				return [];
			const o = row as Record<string, unknown>;
			const raw = key !== undefined ? o[key] : undefined;
			return [
				{
					label: typeof o.id === "string" ? o.id : `[${i}]`,
					row: o,
					...(typeof raw === "string" ? { text: raw } : {}),
				},
			];
		});
	}
	const values = Array.isArray(value) ? value : [value];
	return values.flatMap((v): Item[] =>
		typeof v === "string" ? [{ label: clip(v), text: v }] : [],
	);
}

function render(
	template: string,
	vars: { id: string; text: string; field: string; rule: string },
): string {
	return template.replace(
		/\{(id|text|field|rule)\}/g,
		(_, k: keyof typeof vars) => vars[k],
	);
}

/** Violations of `rule` in `fields` (empty when its `when` does not hold). */
export function evaluateRule(
	spec: FieldSpec,
	rule: FieldRule,
	fields: Record<string, unknown>,
): RuleViolation[] {
	if (!holds(rule.when, fields)) return [];
	const out: RuleViolation[] = [];
	const flags = rule.flags;
	const must = rule.mustMatch ? new RegExp(rule.mustMatch, flags) : undefined;
	const mustNot = rule.mustNotMatch
		? new RegExp(rule.mustNotMatch, flags)
		: undefined;
	const strip = rule.strip ? new RegExp(rule.strip, `${flags}g`) : undefined;
	const unless = rule.unless ? new RegExp(rule.unless, flags) : undefined;
	for (const item of itemsOf(spec, rule, fields[rule.field])) {
		let why: string | null = null;
		if (rule.forbid) {
			for (const [k, values] of Object.entries(rule.forbid)) {
				const got = item.row?.[k];
				if (got !== undefined && values.some((v) => v === got)) {
					why = `${k} is ${JSON.stringify(got)}`;
					break;
				}
			}
		} else if (item.text !== undefined) {
			const text = strip ? item.text.replace(strip, "") : item.text;
			if (must && !must.test(text)) {
				why = `does not match /${rule.mustMatch}/: ${clip(item.text)}`;
			} else if (mustNot?.test(text) && !(unless?.test(item.text) ?? false)) {
				why = `matches /${rule.mustNotMatch}/: ${clip(item.text)}`;
			}
		}
		if (why === null) continue;
		const detail = rule.message
			? render(rule.message, {
					id: item.label ?? "",
					text: clip(item.text ?? ""),
					field: rule.field,
					rule: rule.id,
				})
			: why;
		out.push({
			rule: rule.id,
			severity: rule.severity,
			field: rule.field,
			item: item.label,
			message:
				item.label !== null && item.label !== item.text
					? `${rule.field} ${item.label}: ${detail}`
					: `${rule.field}: ${detail}`,
		});
	}
	return out;
}

/** Every violation of every rule of `type` in `fields`. */
export function evaluateRules(
	type: TypeSpec,
	fields: Record<string, unknown>,
): RuleViolation[] {
	const out: RuleViolation[] = [];
	for (const rule of type.rules ?? []) {
		const spec = type.fields[rule.field];
		if (spec) out.push(...evaluateRule(spec, rule, fields));
	}
	return out;
}

/** Identity of a violation, for "is this one new". */
export function violationKey(v: RuleViolation): string {
	return `${v.rule}\u0000${v.item ?? ""}`;
}

/** Violations in `after` that `before` did not already have. */
export function newViolations(
	type: TypeSpec,
	before: Record<string, unknown>,
	after: Record<string, unknown>,
): RuleViolation[] {
	const known = new Set(evaluateRules(type, before).map(violationKey));
	return evaluateRules(type, after).filter((v) => !known.has(violationKey(v)));
}
