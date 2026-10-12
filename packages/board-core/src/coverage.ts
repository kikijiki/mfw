import type { CoverageRule } from "./external-config.ts";

/**
 * Evaluates a `coverage` rule: every open row of a table (a TSV: tab-separated,
 * header line first, no quoting) must be named by exactly one document through
 * the rule's `closedBy` field, or be waived. Pure over the table texts and the
 * candidate documents.
 */

export interface CoverageDoc {
	type: string;
	id: string;
	status: string;
	fields: Record<string, unknown>;
	path: string;
}

export interface CoverageFinding {
	kind: "uncovered" | "unknown-ref" | "duplicate-row" | "stale-waiver";
	/** The row/waiver id, or the unknown id a document named. */
	id: string;
	/** The table line (1-based) when the finding is about a table row. */
	line?: number;
	/** Which table: the source or the waivers file. */
	table?: "source" | "waivers";
	/** The document at fault, for an unknown reference. */
	doc?: { type: string; id: string; path: string };
	closers?: string[];
	message: string;
}

export interface CoverageResult {
	findings: CoverageFinding[];
	rows: number;
	open: number;
	waived: number;
	covered: number;
}

/** The table has a shape the rule cannot work with (a missing column). */
export class CoverageTableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CoverageTableError";
	}
}

interface Table {
	header: string[];
	rows: { line: number; cells: string[] }[];
}

export function parseTsv(text: string): Table {
	const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
	const rows: Table["rows"] = [];
	let header: string[] | null = null;
	for (let i = 0; i < lines.length; i++) {
		const l = lines[i] as string;
		if (l.length === 0) continue;
		if (header === null) header = l.split("\t");
		else rows.push({ line: i + 1, cells: l.split("\t") });
	}
	return { header: header ?? [], rows };
}

function column(t: Table, name: string, what: string): number {
	const i = t.header.indexOf(name);
	if (i < 0) {
		throw new CoverageTableError(
			`${what} has no column '${name}' (columns: ${t.header.join(", ") || "none"})`,
		);
	}
	return i;
}

function idsOf(v: unknown): string[] {
	return Array.isArray(v)
		? v.filter((x): x is string => typeof x === "string")
		: [];
}

export function evaluateCoverage(
	rule: CoverageRule,
	sourceText: string,
	waiversText: string | undefined,
	docs: readonly CoverageDoc[],
): CoverageResult {
	const findings: CoverageFinding[] = [];
	const source = parseTsv(sourceText);
	const idCol = column(source, rule.idColumn, `coverage '${rule.id}' source`);
	const openCol = rule.openWhen
		? column(source, rule.openWhen.column, `coverage '${rule.id}' source`)
		: -1;
	const aliasCol = rule.aliasColumn
		? column(source, rule.aliasColumn, `coverage '${rule.id}' source`)
		: -1;

	const rowLine = new Map<string, number>();
	const open: string[] = [];
	for (const r of source.rows) {
		const id = r.cells[idCol] ?? "";
		if (id === "") continue;
		if (rowLine.has(id)) {
			findings.push({
				kind: "duplicate-row",
				id,
				line: r.line,
				table: "source",
				message: `row id '${id}' repeats the one at line ${rowLine.get(id)}`,
			});
			continue;
		}
		rowLine.set(id, r.line);
		if (!rule.openWhen || r.cells[openCol] === rule.openWhen.equals)
			open.push(id);
	}
	const alias = new Map<string, string>();
	if (aliasCol >= 0) {
		for (const r of source.rows) {
			const id = r.cells[idCol] ?? "";
			const cell = r.cells[aliasCol] ?? "";
			if (cell === "" || cell === rule.aliasNone) continue;
			for (const a of cell.split(",").map((x) => x.trim())) {
				if (a !== "" && !rowLine.has(a) && !alias.has(a)) alias.set(a, id);
			}
		}
	}
	const resolve = (id: string): string | null =>
		rowLine.has(id) ? id : (alias.get(id) ?? null);

	const closers = new Map<string, string[]>();
	const add = (m: Map<string, string[]>, k: string, v: string) => {
		const l = m.get(k);
		if (!l) m.set(k, [v]);
		else if (!l.includes(v)) l.push(v);
	};
	const unknown = (
		d: CoverageDoc,
		field: string,
		id: string,
	): CoverageFinding => ({
		kind: "unknown-ref",
		id,
		doc: { type: d.type, id: d.id, path: d.path },
		message: `${field} names '${id}', which is not a row of ${rule.source}`,
	});
	for (const d of docs) {
		if (d.type === rule.closedBy.type) {
			const counts =
				!rule.closedBy.status || rule.closedBy.status.includes(d.status);
			for (const id of idsOf(d.fields[rule.closedBy.field])) {
				const p = resolve(id);
				if (p === null) findings.push(unknown(d, rule.closedBy.field, id));
				else if (counts) add(closers, p, d.id);
			}
		}
		if (rule.referencedBy && d.type === rule.referencedBy.type) {
			for (const id of idsOf(d.fields[rule.referencedBy.field])) {
				if (resolve(id) === null) {
					findings.push(unknown(d, rule.referencedBy.field, id));
				}
			}
		}
	}

	const waived = new Set<string>();
	if (rule.waivers && waiversText !== undefined) {
		const t = parseTsv(waiversText);
		const wc = column(
			t,
			rule.waivers.idColumn,
			`coverage '${rule.id}' waivers`,
		);
		const openSet = new Set(open);
		for (const r of t.rows) {
			const id = r.cells[wc] ?? "";
			if (id === "") continue;
			const p = resolve(id);
			const stale = (why: string) =>
				findings.push({
					kind: "stale-waiver",
					id,
					line: r.line,
					table: "waivers",
					message: `waiver for '${id}' ${why}`,
				});
			if (p === null) stale(`names no row of ${rule.source}`);
			else if (!openSet.has(p)) stale("is for a row that is not open");
			else if ((closers.get(p) ?? []).length > 0) {
				stale(`is redundant: ${(closers.get(p) ?? []).join(", ")} closes it`);
			}
			if (p !== null) waived.add(p);
		}
	}

	let covered = 0;
	let waivedOpen = 0;
	for (const id of open) {
		if (waived.has(id)) {
			waivedOpen++;
			continue;
		}
		const who = closers.get(id) ?? [];
		if (who.length === rule.closedBy.exactly) {
			covered++;
			continue;
		}
		findings.push({
			kind: "uncovered",
			id,
			line: rowLine.get(id),
			table: "source",
			closers: who,
			message: `${id} is closed by ${who.length === 0 ? "no document" : `${who.length} documents (${who.join(", ")})`}, expected exactly ${rule.closedBy.exactly}`,
		});
	}
	return {
		findings,
		rows: rowLine.size,
		open: open.length,
		waived: waivedOpen,
		covered,
	};
}
