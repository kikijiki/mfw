import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type BoardConfig,
	type BoardDocument,
	type OwnershipExemptions,
	parseOwnershipExemptions,
} from "@mfw/board-core";
import { CliError, type CommandContext, UsageError } from "./types.ts";

/** Every document of every type on the board. */
export async function allDocuments(
	ctx: CommandContext,
): Promise<BoardDocument[]> {
	const out: BoardDocument[] = [];
	for (const t of Object.keys(ctx.project.config.types)) {
		out.push(...(await ctx.project.store.listDocuments(t)));
	}
	return out;
}

/** The hierarchy children field, read defensively (see board-core workflow.ts). */
export function childrenField(config: BoardConfig): string | undefined {
	return (config as { hierarchy?: { children: string } }).hierarchy?.children;
}

export function statusFieldOf(config: BoardConfig, type: string): string {
	return config.types[type]?.workflow?.statusField ?? "status";
}

export function statusValueOf(config: BoardConfig, doc: BoardDocument): string {
	const v = doc.fields[statusFieldOf(config, doc.type)];
	return typeof v === "string" ? v : "";
}

/** Exit 2 unless some type declares non-empty `statusClasses`. */
export function requireStatusClasses(config: BoardConfig): void {
	const any = Object.values(config.types).some((t) => {
		const c = t.workflow?.classes;
		return (
			c !== undefined &&
			c.terminal.length + c.live.length + c.parked.length + c.queued.length > 0
		);
	});
	if (!any) {
		throw new CliError(
			"this board declares no statusClasses. Add to a type in board.yaml, e.g.\n" +
				"  statusClasses:\n" +
				"    terminal: [done]\n" +
				"    live: [todo, doing]\n" +
				"    queued: [todo]\n" +
				"(queued values must also be in live; optionally add ready: {columns: [...]})",
			2,
		);
	}
}

/** `--type` validated against the board's types, or undefined. */
export function optionalType(
	config: BoardConfig,
	type: string | undefined,
): string | undefined {
	if (type === undefined) return undefined;
	if (!(type in config.types)) {
		throw new CliError(
			`unknown type '${type}' (board types: ${Object.keys(config.types).join(", ") || "none"})`,
			2,
		);
	}
	return type;
}

/** Validates `--under`: needs a configured hierarchy and an existing id. */
export function checkUnder(
	config: BoardConfig,
	docs: readonly BoardDocument[],
	under: string | undefined,
): void {
	if (under === undefined) return;
	if (!childrenField(config)) {
		throw new CliError(
			"--under needs a hierarchy: the board declares none (no `hierarchy` section in board.yaml)",
			2,
		);
	}
	if (!docs.some((d) => d.id === under)) {
		throw new CliError(`--under: '${under}' not found`, 2);
	}
}

function idsIn(v: unknown): string[] {
	if (typeof v === "string") return v ? [v] : [];
	if (Array.isArray(v))
		return v.filter((x): x is string => typeof x === "string");
	return [];
}

/** Transitive descendants of `root` through the hierarchy children field. */
export function descendantsOf(
	config: BoardConfig,
	docs: readonly BoardDocument[],
	root: string,
): Set<string> {
	const field = childrenField(config);
	const byId = new Map(docs.map((d) => [d.id, d] as const));
	const seen = new Set<string>();
	if (!field) return seen;
	const queue = [root];
	for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
		for (const c of idsIn(byId.get(id)?.fields[field])) {
			if (c === root || seen.has(c)) continue;
			seen.add(c);
			queue.push(c);
		}
	}
	return seen;
}

export type Format = "md" | "tsv" | "json";

export function parseFormat(f: string | undefined): Format {
	if (f === undefined) return "md";
	if (f === "md" || f === "tsv" || f === "json") return f;
	throw new CliError(`unknown format '${f}' (valid: md, tsv, json)`, 2);
}

export interface Table {
	columns: string[];
	rows: (string | number)[][];
}

/** Render rows as md / tsv / json (array of objects keyed by column). */
export function renderTable(t: Table, format: Format): string {
	if (format === "json") {
		return JSON.stringify(
			t.rows.map((r) =>
				Object.fromEntries(t.columns.map((c, i) => [c, r[i] ?? ""])),
			),
		);
	}
	const clean = (v: string | number) => String(v).replace(/[\t\r\n]+/g, " ");
	if (format === "tsv") {
		return [t.columns, ...t.rows]
			.map((r) => r.map(clean).join("\t"))
			.join("\n");
	}
	const esc = (v: string | number) => clean(v).replace(/\|/g, "\\|");
	const line = (r: (string | number)[]) => `| ${r.map(esc).join(" | ")} |`;
	return [
		line(t.columns),
		`| ${t.columns.map(() => "---").join(" | ")} |`,
		...t.rows.map(line),
	].join("\n");
}

export function requireNoPositional(positional: string[]): void {
	if (positional.length > 0) throw new UsageError();
}

/**
 * The exemptions file a type's `ownership.exemptions` points at (relative to the
 * board root), parsed against the ids of that type; undefined when none is
 * declared. A missing or invalid file is a board error (exit 3).
 */
export async function loadExemptions(
	ctx: CommandContext,
	typeName: string,
	docs: readonly BoardDocument[],
): Promise<OwnershipExemptions | undefined> {
	const file = ctx.project.config.types[typeName]?.ownership?.exemptions;
	if (!file) return undefined;
	const path = join(ctx.project.root, file);
	try {
		const raw = Bun.YAML.parse(await readFile(path, "utf8"));
		const ids = new Set(
			docs.filter((d) => d.type === typeName).map((d) => d.id),
		);
		return parseOwnershipExemptions(raw, ids);
	} catch (e) {
		throw new CliError(
			`${path}: ${e instanceof Error ? e.message : String(e)}`,
			3,
		);
	}
}

/** Types that declare `ownership`, or an error (exit 2) naming how to. */
export function requireOwnership(config: BoardConfig, only?: string): string[] {
	const types = Object.entries(config.types)
		.filter(([name, t]) => t.ownership && (only === undefined || name === only))
		.map(([name]) => name);
	if (types.length === 0) {
		throw new CliError(
			"no type declares file scopes. Add to a type in board.yaml, e.g.\n" +
				"  ownership: { field: owns, exemptions: shares.yaml }   # exemptions optional\n" +
				"  fields:\n    owns: { type: string, list: true, optional: true }",
			2,
		);
	}
	return types;
}
