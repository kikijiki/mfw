import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { BoardConfig, BuiltinSeverity } from "./config.ts";
import { CoverageTableError, evaluateCoverage } from "./coverage.ts";
import {
	findOwnershipConflictsExempt,
	inertExemptionPairs,
	type OwnershipExemptions,
	ownsPath as ownsPathLike,
	parseOwnershipExemptions,
	validateOwnsPattern,
} from "./ownership.ts";
import { evaluateRefs, grammarOf, type RefTarget } from "./refs.ts";
import { evaluateRules } from "./rules.ts";
import { type ScannedFile, type SkippedFile, scanRoot } from "./scan.ts";
import type { BoardDocument, BoardStore, ValidationIssue } from "./store.ts";
import {
	blockedAfterCompletion,
	effectiveDependencies,
	isLive,
	isTerminal,
	workflowIssues,
} from "./workflow.ts";

/**
 * Checks: every way the board can be wrong, as one issue shape. A check is a
 * named rule; running it yields zero or more `CheckIssue`s. The structural
 * built-ins here derive from the schema in `board.yaml` and need no config of
 * their own; configured rules (field assertions, external refs, coverage)
 * produce the same issues.
 */

export type CheckSeverity = "error" | "advisory";

export interface CheckIssue {
	/** The rule that produced it (a built-in id or a configured check id). */
	rule: string;
	severity: CheckSeverity;
	/** Subject: a document... */
	type?: string;
	id?: string | null;
	path?: string;
	/** ...or a line of an external file. */
	file?: string;
	line?: number;
	message: string;
	/** Other documents the issue involves (a dependency, the other side of a pair). */
	related?: string[];
}

export interface CheckRuleInfo {
	id: string;
	/** `builtin` rules derive from the schema; `field` rules come from a type's `rules:`. */
	kind: "builtin" | "field" | "refs" | "coverage";
	/** The type a `field` rule belongs to. */
	type?: string;
	severity: CheckSeverity | "configurable";
	/** What the rule reads: only the board directory, or something outside it. */
	reads: "board" | "external";
	description: string;
}

/** The built-in rules, in the order `check --list` shows them. */
export const BUILTIN_RULES: readonly CheckRuleInfo[] = [
	rule("document", "a document does not parse or breaks its field schema"),
	rule(
		"id",
		"duplicate id, id outside its grammar, or an inherited id with no source",
	),
	rule("reference", "a ref field points at a document that does not exist"),
	rule(
		"hierarchy",
		"parent/children disagree, a rule or depth limit is broken",
	),
	rule("cycle", "a dependency or acyclic-field cycle"),
	rule("owns-glob", "an ownership glob is not usable"),
	rule("exemptions", "the ownership exemptions file is missing or invalid"),
	{
		id: "unreachable",
		kind: "builtin",
		severity: "configurable",
		reads: "board",
		description:
			"a live document can never become ready (dangling or parked dependency, cycle)",
	},
	{
		id: "conflicts",
		kind: "builtin",
		severity: "configurable",
		reads: "board",
		description:
			"live documents whose file scopes overlap with nothing ordering them",
	},
	{
		id: "inert-exemption",
		kind: "builtin",
		severity: "advisory",
		reads: "board",
		description:
			"an exemption pair protects nothing because a document finished",
	},
];

/** Built-in rules plus every configured rule of `config`. */
export function ruleCatalog(config: BoardConfig): CheckRuleInfo[] {
	const out: CheckRuleInfo[] = [...BUILTIN_RULES];
	for (const [typeName, t] of Object.entries(config.types)) {
		for (const r of t.rules ?? []) {
			out.push({
				id: r.id,
				kind: "field",
				type: typeName,
				severity: r.severity,
				reads: "board",
				description:
					r.message ??
					`${typeName}.${r.field}: ${r.forbid ? `forbids ${JSON.stringify(r.forbid)}` : r.mustMatch !== undefined ? `must match /${r.mustMatch}/` : `must not match /${r.mustNotMatch}/`}${r.when ? ` when ${JSON.stringify(r.when)}` : ""}`,
			});
		}
	}
	for (const c of config.coverage ?? []) {
		out.push({
			id: c.id,
			kind: "coverage",
			severity: c.severity,
			reads: c.root ? "external" : "board",
			description: `every open row of ${c.source} is closed by exactly ${c.closedBy.exactly} ${c.closedBy.type} via ${c.closedBy.field}${c.waivers ? ` (or waived in ${c.waivers.file})` : ""}`,
		});
	}
	for (const r of config.refs ?? []) {
		out.push({
			id: r.id,
			kind: "refs",
			severity: r.severity,
			reads: "external",
			description:
				r.message ??
				`/${r.pattern}/ in ${r.root}:${r.paths.join(",")} must name a ${r.to}${r.status ? ` that is ${r.status.join("|")}` : ""}`,
		});
	}
	return out;
}

function rule(id: string, description: string): CheckRuleInfo {
	return {
		id,
		kind: "builtin",
		severity: "error",
		reads: "board",
		description,
	};
}

const VALIDATION_RULE: Record<ValidationIssue["kind"], string> = {
	document: "document",
	id: "id",
	reference: "reference",
	hierarchy: "hierarchy",
	cycle: "cycle",
};

function fromValidation(v: ValidationIssue): CheckIssue {
	return {
		rule: VALIDATION_RULE[v.kind],
		severity: "error",
		type: v.type,
		id: v.id,
		path: v.path,
		message: v.message,
	};
}

function statusOf(config: BoardConfig, doc: BoardDocument): string {
	const field = config.types[doc.type]?.workflow?.statusField ?? "status";
	const v = doc.fields[field];
	return typeof v === "string" ? v : "";
}

/** Every document of every type. */
export async function listAllDocuments(
	store: BoardStore,
	config: BoardConfig,
): Promise<BoardDocument[]> {
	const out: BoardDocument[] = [];
	for (const t of Object.keys(config.types)) {
		out.push(...(await store.listDocuments(t)));
	}
	return out;
}

/** True when some type declares status classes (so liveness rules mean something). */
export function hasStatusClasses(config: BoardConfig): boolean {
	return Object.values(config.types).some((t) => {
		const c = t.workflow?.classes;
		return (
			c !== undefined &&
			c.terminal.length + c.live.length + c.parked.length + c.queued.length > 0
		);
	});
}

/**
 * The exemptions file a type's `ownership.exemptions` points at (relative to the
 * board root), parsed against that type's ids; undefined when none is declared.
 * Throws on a missing or invalid file.
 */
export async function loadOwnershipExemptions(
	root: string,
	config: BoardConfig,
	typeName: string,
	docs: readonly BoardDocument[],
): Promise<OwnershipExemptions | undefined> {
	const file = config.types[typeName]?.ownership?.exemptions;
	if (!file) return undefined;
	const path = join(root, file);
	try {
		const raw = parseYaml(await readFile(path, "utf8"));
		const ids = new Set(
			docs.filter((d) => d.type === typeName).map((d) => d.id),
		);
		return parseOwnershipExemptions(raw, ids);
	} catch (e) {
		throw new Error(`${path}: ${e instanceof Error ? e.message : String(e)}`);
	}
}

export interface ConflictReport {
	found: { a: string; b: string; patterns: [string, string][] }[];
	inert: { cards: [string, string]; ruling?: string }[];
	liveCount: number;
}

/** Unordered file-scope overlaps among live documents of `types`, after exemptions. */
export async function ownershipConflicts(
	root: string,
	config: BoardConfig,
	docs: readonly BoardDocument[],
	types: readonly string[],
): Promise<ConflictReport> {
	const deps = effectiveDependencies(config, docs);
	const report: ConflictReport = { found: [], inert: [], liveCount: 0 };
	for (const t of types) {
		const field = config.types[t]?.ownership?.field as string;
		const ex = await loadOwnershipExemptions(root, config, t, docs);
		const mine = docs.filter((d) => d.type === t);
		const live = mine.filter((d) => isLive(config, t, statusOf(config, d)));
		report.liveCount += live.length;
		const nodes = live.map((d) => ({
			id: d.id,
			owns: (d.fields[field] as string[] | undefined) ?? [],
			dependsOn: deps.get(d.id) ?? [],
		}));
		report.found.push(...findOwnershipConflictsExempt(nodes, ex));
		if (ex) {
			const open = new Set(
				mine
					.filter((d) => !isTerminal(config, t, statusOf(config, d)))
					.map((d) => d.id),
			);
			report.inert.push(...inertExemptionPairs(ex, open));
		}
	}
	return report;
}

function severityOf(
	config: BoardConfig,
	rule: "unreachable" | "conflicts",
): BuiltinSeverity {
	return config.builtins?.[rule] ?? "error";
}

/** Violations of every configured field rule, over `docs`. */
export function fieldRuleIssues(
	config: BoardConfig,
	docs: readonly BoardDocument[],
): CheckIssue[] {
	const out: CheckIssue[] = [];
	for (const d of docs) {
		const type = config.types[d.type];
		if (!type?.rules?.length) continue;
		for (const v of evaluateRules(type, d.fields)) {
			out.push({
				rule: v.rule,
				severity: v.severity,
				type: d.type,
				id: d.id,
				path: d.path,
				message: v.message,
			});
		}
	}
	return out;
}

export interface CollectOptions {
	/** Run only these rules; undefined runs every rule. */
	rules?: ReadonlySet<string>;
	/** Skip rules that read outside the board directory. */
	boardOnly?: boolean;
	/** `name -> path` overrides for `roots` (relative paths resolve against `cwd`). */
	rootOverrides?: Readonly<Record<string, string>>;
	/** Receives, per `refs` rule run, how much it scanned and matched. */
	stats?: CheckStat[];
	/** Where relative overrides resolve (default: the process cwd). */
	cwd?: string;
	/** Environment for `MFWB_ROOT_<NAME>` overrides (default: `process.env`). */
	env?: Readonly<Record<string, string | undefined>>;
}

export type CheckStat =
	| {
			kind: "refs";
			rule: string;
			files: number;
			matches: number;
			skipped: number;
	  }
	| {
			kind: "coverage";
			rule: string;
			rows: number;
			open: number;
			waived: number;
			covered: number;
	  };

/** A check could not run (a missing root, an unreadable file): not a violation. */
export class CheckEnvironmentError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CheckEnvironmentError";
	}
}

/** Where root `name` is on this machine: `--root`, then `MFWB_ROOT_<NAME>`, then board.yaml. */
export function resolveRoot(
	config: BoardConfig,
	boardRoot: string,
	name: string,
	opts: CollectOptions = {},
): string {
	const cwd = opts.cwd ?? process.cwd();
	const env = opts.env ?? process.env;
	const flag = opts.rootOverrides?.[name];
	if (flag !== undefined) return resolve(cwd, flag);
	const fromEnv = env[`MFWB_ROOT_${name.toUpperCase().replaceAll("-", "_")}`];
	if (fromEnv) return resolve(cwd, fromEnv);
	const configured = config.roots?.[name];
	if (configured === undefined) {
		throw new CheckEnvironmentError(`root '${name}' is not declared`);
	}
	return resolve(boardRoot, configured);
}

/** A path as the user would type it from `cwd`: relative when that stays close, else absolute. */
function displayPath(abs: string, cwd: string = process.cwd()): string {
	const rel = relative(cwd, abs);
	const ups = rel.split("/").filter((x) => x === "..").length;
	return ups > 2 || isAbsolute(rel) ? abs : rel;
}

/** Violations of every `refs` rule selected by `opts`. Reads each file once per root. */
export async function refsIssues(
	config: BoardConfig,
	docs: readonly BoardDocument[],
	boardRoot: string,
	opts: CollectOptions = {},
): Promise<CheckIssue[]> {
	const rules = (config.refs ?? []).filter(
		(r) => !opts.rules || opts.rules.has(r.id),
	);
	if (rules.length === 0) return [];
	const issues: CheckIssue[] = [];
	const scans = new Map<
		string,
		{ files: ScannedFile[]; skipped: SkippedFile[] }
	>();
	const byRoot = new Map<string, typeof rules>();
	for (const r of rules) byRoot.set(r.root, [...(byRoot.get(r.root) ?? []), r]);
	for (const [name, group] of byRoot) {
		const dir = resolveRoot(config, boardRoot, name, opts);
		const st = await stat(dir).catch(() => null);
		if (!st?.isDirectory()) {
			throw new CheckEnvironmentError(
				`refs root '${name}' (${dir}) is not a directory; set it under 'roots' in board.yaml, or with --root ${name}=<path> or MFWB_ROOT_${name.toUpperCase().replaceAll("-", "_")}`,
			);
		}
		scans.set(
			name,
			await scanRoot(dir, [...new Set(group.flatMap((r) => [...r.paths]))], {
				maxBytes: Math.max(...group.map((r) => r.maxBytes)),
			}),
		);
	}
	for (const r of rules) {
		const scan = scans.get(r.root) as {
			files: ScannedFile[];
			skipped: SkippedFile[];
		};
		const dir = resolveRoot(config, boardRoot, r.root, opts);
		const shown = (p: string) => displayPath(join(dir, p), opts.cwd);
		const matches = (p: string) => r.paths.some((g) => ownsPathLike(g, p));
		const target = config.types[r.to];
		const targets = new Map<string, RefTarget>();
		for (const d of docs) {
			if (d.type === r.to)
				targets.set(d.id, { id: d.id, status: statusOf(config, d) });
		}
		const grammar =
			target?.id.strategy === "own-sequence"
				? grammarOf(target.id.key, target.id.suffix)
				: null;
		const files = scan.files.filter((f) => matches(f.path));
		const result = evaluateRefs(r, files, targets, grammar);
		opts.stats?.push({
			kind: "refs",
			rule: r.id,
			files: files.length,
			matches: result.matches,
			skipped: scan.skipped.filter((x) => matches(x.path)).length,
		});
		if (files.length === 0) {
			issues.push({
				rule: r.id,
				severity: "advisory",
				message: `no file under root '${r.root}' matched paths ${r.paths.join(", ")}: the rule checked nothing`,
			});
		}
		for (const f of result.findings) {
			issues.push({
				rule: r.id,
				severity: r.severity,
				file: shown(f.file),
				line: f.line,
				related: [f.id],
				message: r.message
					? r.message.replaceAll("{id}", f.id).replaceAll("{detail}", f.message)
					: f.message,
			});
		}
		for (const s of scan.skipped.filter((x) => matches(x.path))) {
			issues.push({
				rule: r.id,
				severity: "advisory",
				file: shown(s.path),
				message: `not scanned (${s.reason}${s.reason === "too-large" ? `, over ${r.maxBytes} bytes` : ""})`,
			});
		}
	}
	return issues;
}

/** Violations of every `coverage` rule selected by `opts`. */
export async function coverageIssues(
	config: BoardConfig,
	docs: readonly BoardDocument[],
	boardRoot: string,
	opts: CollectOptions = {},
): Promise<CheckIssue[]> {
	const issues: CheckIssue[] = [];
	for (const c of config.coverage ?? []) {
		if (opts.rules && !opts.rules.has(c.id)) continue;
		if (opts.boardOnly && c.root) continue;
		const base = c.root
			? resolveRoot(config, boardRoot, c.root, opts)
			: boardRoot;
		const read = async (file: string) => {
			const path = resolve(base, file);
			try {
				return { path, text: await readFile(path, "utf8") };
			} catch (e) {
				throw new CheckEnvironmentError(
					`coverage '${c.id}': cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`,
				);
			}
		};
		const source = await read(c.source);
		const waivers = c.waivers ? await read(c.waivers.file) : undefined;
		let result: ReturnType<typeof evaluateCoverage>;
		try {
			result = evaluateCoverage(
				c,
				source.text,
				waivers?.text,
				docs.map((d) => ({
					type: d.type,
					id: d.id,
					status: statusOf(config, d),
					fields: d.fields,
					path: d.path,
				})),
			);
		} catch (e) {
			if (e instanceof CoverageTableError)
				throw new CheckEnvironmentError(e.message);
			throw e;
		}
		opts.stats?.push({
			kind: "coverage",
			rule: c.id,
			rows: result.rows,
			open: result.open,
			waived: result.waived,
			covered: result.covered,
		});
		for (const f of result.findings) {
			const table = f.table === "waivers" ? waivers : source;
			issues.push({
				rule: c.id,
				severity: f.kind === "stale-waiver" ? "advisory" : c.severity,
				...(f.doc
					? { type: f.doc.type, id: f.doc.id, path: f.doc.path }
					: {
							file: displayPath(table?.path ?? source.path, opts.cwd),
							...(f.line !== undefined ? { line: f.line } : {}),
						}),
				related: f.closers ?? [f.id],
				message: f.message,
			});
		}
	}
	return issues;
}

/** Every rule, evaluated: the built-ins, the board's field rules, refs and coverage. */
export async function collectIssues(
	store: BoardStore,
	config: BoardConfig,
	root: string,
	opts: CollectOptions = {},
): Promise<CheckIssue[]> {
	const docs = await listAllDocuments(store, config);
	const issues = await builtinIssues(store, config, root);
	issues.push(...fieldRuleIssues(config, docs));
	if (!opts.boardOnly)
		issues.push(...(await refsIssues(config, docs, root, opts)));
	issues.push(...(await coverageIssues(config, docs, root, opts)));
	return issues;
}

/**
 * Every built-in rule, evaluated. Rules that do not apply to this board (no
 * status classes, no ownership) are skipped silently: a board opts into the
 * features whose rules it wants.
 */
export async function builtinIssues(
	store: BoardStore,
	config: BoardConfig,
	root: string,
): Promise<CheckIssue[]> {
	const issues: CheckIssue[] = (await store.validate()).map(fromValidation);

	// Workflow cycles: only types that declare a workflow take part, so ids are
	// unique across the documents it is given.
	const wfDocs: BoardDocument[] = [];
	for (const [name, t] of Object.entries(config.types)) {
		if (t.workflow) wfDocs.push(...(await store.listDocuments(name)));
	}
	if (wfDocs.length > 0) {
		issues.push(...workflowIssues(config, wfDocs).map(fromValidation));
	}

	// File scopes: every glob usable, every exemptions file valid.
	const ownershipTypes: string[] = [];
	const docs = await listAllDocuments(store, config);
	for (const [name, t] of Object.entries(config.types)) {
		if (!t.ownership) continue;
		ownershipTypes.push(name);
		for (const d of docs.filter((x) => x.type === name)) {
			const globs = (d.fields[t.ownership.field] as string[] | undefined) ?? [];
			for (const g of globs) {
				const bad = validateOwnsPattern(g);
				if (bad) {
					issues.push({
						rule: "owns-glob",
						severity: "error",
						type: name,
						id: d.id,
						path: d.path,
						message: `${t.ownership.field} '${g}': ${bad}`,
					});
				}
			}
		}
	}

	const conflictSeverity = severityOf(config, "conflicts");
	let conflictTypes = ownershipTypes;
	for (const name of ownershipTypes) {
		try {
			await loadOwnershipExemptions(root, config, name, docs);
		} catch (e) {
			issues.push({
				rule: "exemptions",
				severity: "error",
				type: name,
				id: null,
				path: config.types[name]?.ownership?.exemptions ?? "",
				message: e instanceof Error ? e.message : String(e),
			});
			conflictTypes = conflictTypes.filter((t) => t !== name);
		}
	}
	if (conflictSeverity !== "off" && conflictTypes.length > 0) {
		const report = await ownershipConflicts(root, config, docs, conflictTypes);
		for (const c of report.found) {
			const first = docs.find((d) => d.id === c.a);
			issues.push({
				rule: "conflicts",
				severity: conflictSeverity,
				type: first?.type,
				id: c.a,
				path: first?.path,
				related: [c.b],
				message: `file scopes overlap with ${c.b} and nothing orders them: ${c.patterns.map(([pa, pb]) => `${pa} ~ ${pb}`).join(", ")}`,
			});
		}
		for (const p of report.inert) {
			issues.push({
				rule: "inert-exemption",
				severity: "advisory",
				id: p.cards[0],
				related: [p.cards[1]],
				message: `exemption pair ${p.cards[0]} <-> ${p.cards[1]} protects nothing (a document has finished); delete it`,
			});
		}
	}

	const unreachableSeverity = severityOf(config, "unreachable");
	if (unreachableSeverity !== "off" && hasStatusClasses(config)) {
		const blocked = blockedAfterCompletion(config, docs);
		const byId = new Map(docs.map((d) => [d.id, d] as const));
		for (const id of [...blocked.keys()].sort()) {
			const deps = blocked.get(id) ?? [];
			const d = byId.get(id);
			issues.push({
				rule: "unreachable",
				severity: unreachableSeverity,
				type: d?.type,
				id,
				path: d?.path,
				related: deps,
				message: `can never become ready: unresolved dependencies ${deps.join(",") || "-"}`,
			});
		}
	}
	return issues;
}
