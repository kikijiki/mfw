/**
 * The pure half of `bun run screenshots`: the section list, CLI parsing, file
 * naming, the manifest, and the shape of the seed plan with its validator.
 * Nothing here touches the network, the disk or a browser, so it is unit
 * tested (`apps/start/src/lib/screenshotsPlan.test.ts`) and `--dry-run` can
 * run it in CI.
 */

export type Theme = "dark" | "light";
export type ThemeChoice = Theme | "both";

export interface Size {
	w: number;
	h: number;
}

export const DESKTOP_SIZE: Size = { w: 1440, h: 900 };
export const PHONE_SIZE: Size = { w: 390, h: 844 };

/** Where a section's route lives, resolved against the seeded projects and tasks. */
export type Target =
	| { kind: "path"; path: string }
	| { kind: "project"; project: string; path: string }
	| { kind: "task"; project: string; task: string; path: string }
	| { kind: "node"; project: string; node: string; path: string };

/** One thing to photograph. Add a section by adding one line to `SECTIONS`. */
export interface Section {
	/** File-name stem and `--only` key. */
	name: string;
	title: string;
	/** Which project the section looks at (a key of the seed plan); null = global. */
	project: string | null;
	/** App path, with `{project}` replaced by the project name and `{task:<alias>}` / `{run:<alias>}` / `{group:<alias>}` by the seeded ids. */
	path: string;
	/** Fixed viewport (phone sections); absent = every requested size. */
	size?: Size;
	/** A named interaction run after the page settles (see `capture.ts` ACTIONS). */
	action?: string;
	/** A selector that must exist before the shot. */
	waitFor?: string;
	/** A route that only exists in newer builds: 404 skips with a note. */
	optional?: boolean;
	/** Tall page: grow the viewport to fit the whole document. */
	full?: boolean;
	/** localStorage entries to set before navigation (e.g. the collapsed sidebar). */
	storage?: Record<string, string>;
}

/**
 * The sections, in capture order. Paths use placeholders:
 *   {p:<key>}      project name for seed-plan key
 *   {t:<key>:<alias>}  task id,  {r:<alias>} run id,  {g:<alias>} group id.
 */
export const SECTIONS: readonly Section[] = [
	{
		name: "home",
		title: "Home: needs you, live runs, since you left",
		project: null,
		path: "/",
		waitFor: "main",
	},
	{
		name: "board",
		title: "Board",
		project: "harbor",
		path: "/p/{p:harbor}/board",
		action: "waitBoard",
	},
	{
		name: "board-columns",
		title: "Board, columns layout",
		project: "harbor",
		path: "/p/{p:harbor}/board",
		action: "boardColumns",
		optional: true,
	},
	{
		name: "board-inspector",
		title: "Board with the task inspector docked (Story)",
		project: "harbor",
		path: "/p/{p:harbor}/board?node=task:{t:harbor:headers}&tab=story",
	},
	{
		name: "task-definition",
		title: "Task definition",
		project: "harbor",
		path: "/p/{p:harbor}/n/task:{t:harbor:admin}?tab=definition",
	},
	{
		name: "task-changes",
		title: "Changes: the diff of a task in review",
		project: "harbor",
		path: "/p/{p:harbor}/n/task:{t:harbor:admin}?tab=changes",
	},
	{
		name: "flow",
		title: "Flow: work tree and timeline",
		project: "harbor",
		path: "/p/{p:harbor}/flow?w=7d",
		action: "waitFlow",
	},
	{
		name: "flow-run",
		title: "Flow with a run inspector",
		project: "harbor",
		path: "/p/{p:harbor}/flow?node=run:{r:headersRun}&w=7d",
		action: "waitFlow",
	},
	{
		name: "brain",
		title: "Brain inspector: decisions",
		project: "harbor",
		path: "/p/{p:harbor}/flow?node=brain&w=7d",
	},
	{
		name: "group-compare",
		title: "Competing attempts, compared",
		project: "harbor",
		path: "/p/{p:harbor}/flow?node=group:{g:cursors}&w=7d",
	},
	{
		name: "fleet",
		title: "Fleet: hosts, accounts, budgets, usage",
		project: null,
		path: "/fleet",
		waitFor: "main",
	},
	{
		name: "docs",
		title: "Docs",
		project: "harbor",
		path: "/p/{p:harbor}/docs",
		optional: true,
	},
	{
		name: "repo",
		title: "Repo: files with the README rendered",
		project: "harbor",
		path: "/p/{p:harbor}/repo?file=README.md",
		optional: true,
	},
	{
		name: "settings",
		title: "Project settings",
		project: "harbor",
		path: "/p/{p:harbor}/settings",
	},
	{
		name: "add-project",
		title: "Add project: repository",
		project: null,
		path: "/",
		action: "addProjectStep1",
	},
	{
		name: "add-project-board",
		title: "Add project: board",
		project: null,
		path: "/",
		action: "addProjectStep2",
	},
	{
		name: "palette",
		title: "Command palette",
		project: "harbor",
		path: "/p/{p:harbor}/board",
		action: "palette",
	},
	{
		name: "sidebar-collapsed",
		title: "Collapsed sidebar rail",
		project: "harbor",
		path: "/p/{p:harbor}/board",
		storage: { "mfw:v2:sidebar": "collapsed" },
	},
	{
		name: "phone-board",
		title: "Board on a phone",
		project: "harbor",
		path: "/p/{p:harbor}/board",
		size: PHONE_SIZE,
	},
	{
		name: "phone-home",
		title: "Home on a phone",
		project: null,
		path: "/",
		size: PHONE_SIZE,
	},
];

// ---- CLI ------------------------------------------------------------------

/** Where the PNGs and index.json go unless `--out` says otherwise (relative to the repo root). */
export const DEFAULT_OUT = "docs/screenshots";

export interface Options {
	out: string | null;
	sizes: Size[];
	scale: number;
	themes: Theme[];
	only: string[];
	publishDir: string | null;
	dryRun: boolean;
	firefox: string;
	port: number | null;
	keepRun: boolean;
	help: boolean;
}

export class UsageError extends Error {}

export function parseSize(text: string): Size {
	const m = /^(\d{2,5})x(\d{2,5})$/.exec(text.trim());
	if (!m) throw new UsageError(`bad size '${text}', expected WIDTHxHEIGHT`);
	return { w: Number(m[1]), h: Number(m[2]) };
}

const VALUE_FLAGS = new Set([
	"out",
	"sizes",
	"scale",
	"theme",
	"only",
	"publish-dir",
	"firefox",
	"port",
]);
const BOOL_FLAGS = new Set(["dry-run", "keep-run", "help"]);

export function parseArgs(argv: readonly string[]): Options {
	const values = new Map<string, string>();
	const bools = new Set<string>();
	for (let i = 0; i < argv.length; i++) {
		const raw = argv[i] as string;
		if (!raw.startsWith("--")) throw new UsageError(`unexpected '${raw}'`);
		const eq = raw.indexOf("=");
		const flag = raw.slice(2, eq < 0 ? undefined : eq);
		if (BOOL_FLAGS.has(flag)) {
			bools.add(flag);
			continue;
		}
		if (!VALUE_FLAGS.has(flag)) throw new UsageError(`unknown flag --${flag}`);
		const value = eq >= 0 ? raw.slice(eq + 1) : argv[++i];
		if (value === undefined || value.startsWith("--"))
			throw new UsageError(`--${flag} needs a value`);
		values.set(flag, value);
	}

	const themeText = values.get("theme") ?? "dark";
	if (!["dark", "light", "both"].includes(themeText))
		throw new UsageError(`--theme must be dark, light or both`);
	const scale = Number(values.get("scale") ?? "2");
	if (!Number.isFinite(scale) || scale < 1 || scale > 4)
		throw new UsageError("--scale must be a number from 1 to 4");
	const port = values.get("port");
	if (port !== undefined && !/^\d{2,5}$/.test(port))
		throw new UsageError("--port must be a port number");

	return {
		out: values.get("out") ?? null,
		sizes: (values.get("sizes") ?? "1440x900").split(",").map(parseSize),
		scale,
		themes: themeText === "both" ? ["dark", "light"] : [themeText as Theme],
		only: (values.get("only") ?? "")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean),
		publishDir: values.get("publish-dir") ?? null,
		dryRun: bools.has("dry-run"),
		firefox: values.get("firefox") ?? "firefox",
		port: port === undefined ? null : Number(port),
		keepRun: bools.has("keep-run"),
		help: bools.has("help"),
	};
}

export const USAGE = `bun run screenshots [options]

  --out DIR           where the PNGs and index.json go (default: docs/screenshots in the repo)
  --sizes WxH,WxH     desktop viewports (default 1440x900); phone sections keep 390x844
  --scale N           device pixel ratio (default 2)
  --theme dark|light|both   (default dark)
  --only a,b          section names to capture (see --dry-run for the list)
  --publish-dir DIR   also copy the PNGs and index.json there (does not touch git)
  --dry-run           validate the section list and the seed plan, launch nothing
  --firefox PATH      Firefox binary (>= 130, default: firefox)
  --port N            dev server port (default: a free one)
`;

/** The sections a run will capture, or throws naming the unknown ones. */
export function selectSections(
	only: readonly string[],
	all: readonly Section[] = SECTIONS,
): Section[] {
	if (only.length === 0) return [...all];
	const names = new Set(all.map((s) => s.name));
	const unknown = only.filter((n) => !names.has(n));
	if (unknown.length > 0)
		throw new UsageError(
			`unknown section${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")} (known: ${[...names].join(", ")})`,
		);
	return all.filter((s) => only.includes(s.name));
}

/** The viewports a section is captured at: its own fixed size, else every requested one. */
export function sizesFor(section: Section, requested: readonly Size[]): Size[] {
	return section.size ? [section.size] : [...requested];
}

export const sizeName = (s: Size): string => `${s.w}x${s.h}`;

/** `<section>-<theme>-<WxH>.png`, deterministic so a re-run overwrites in place. */
export function fileName(section: string, theme: Theme, size: Size): string {
	return `${section}-${theme}-${sizeName(size)}.png`;
}

// ---- manifest -------------------------------------------------------------

export interface ManifestEntry {
	name: string;
	title: string;
	path: string;
	file: string;
	viewport: Size;
	scale: number;
	theme: Theme;
	/** The app route captured, relative to the dev server. */
	route: string;
}

export interface SkippedEntry {
	name: string;
	title: string;
	reason: string;
}

export interface Manifest {
	generatedAt: string;
	commit: string;
	scale: number;
	themes: Theme[];
	screenshots: ManifestEntry[];
	skipped: SkippedEntry[];
}

export function buildManifest(input: {
	generatedAt: string;
	commit: string;
	scale: number;
	themes: Theme[];
	screenshots: ManifestEntry[];
	skipped: SkippedEntry[];
}): Manifest {
	const key = (e: ManifestEntry) => `${e.name}\u0000${e.theme}\u0000${e.file}`;
	return {
		...input,
		screenshots: [...input.screenshots].sort((a, b) =>
			key(a).localeCompare(key(b)),
		),
		skipped: [...input.skipped].sort((a, b) => a.name.localeCompare(b.name)),
	};
}

// ---- section paths --------------------------------------------------------

export interface IdMaps {
	projects: Record<string, string>;
	tasks: Record<string, Record<string, string>>;
	runs: Record<string, string>;
	groups: Record<string, string>;
}

const PLACEHOLDER = /\{(p|t|r|g):([A-Za-z0-9_-]+)(?::([A-Za-z0-9_-]+))?\}/g;

/** Every placeholder a path uses, as `[kind, a, b?]`. */
export function placeholdersOf(path: string): Array<[string, string, string?]> {
	return [...path.matchAll(PLACEHOLDER)].map(
		(m) => [m[1], m[2], m[3]] as [string, string, string?],
	);
}

/** Resolve a section path against the seeded ids; throws on an unknown alias. */
export function resolvePath(path: string, ids: IdMaps): string {
	return path.replace(
		PLACEHOLDER,
		(_all, kind: string, a: string, b: string | undefined) => {
			let value: string | undefined;
			if (kind === "p") value = ids.projects[a];
			else if (kind === "t") value = b ? ids.tasks[a]?.[b] : undefined;
			else if (kind === "r") value = ids.runs[a];
			else if (kind === "g") value = ids.groups[a];
			if (!value)
				throw new Error(`unresolved placeholder {${kind}:${a}} in ${path}`);
			return value;
		},
	);
}

// ---- the seed plan --------------------------------------------------------

/** Minutes before the anchor instant. Written `"3d4h"`, `"90m"`, `"2h30m"`. */
export function parseAgo(text: string): number {
	const re = /(\d+)\s*([dhm])/g;
	let total = 0;
	let consumed = 0;
	for (const m of text.matchAll(re)) {
		const n = Number(m[1]);
		total += m[2] === "d" ? n * 1440 : m[2] === "h" ? n * 60 : n;
		consumed += m[0].length;
	}
	if (consumed === 0 || consumed !== text.replace(/\s+/g, "").length)
		throw new Error(`bad age '${text}', expected e.g. 3d4h, 2h30m or 45m`);
	return total;
}

export type Template = "mfw-default" | "kanban" | "planning";

export interface SeedTask {
	/** Plan-local alias; ids are assigned by the board in plan order. */
	alias: string;
	title: string;
	type?: "implementation" | "spike" | "epic" | "maintenance";
	priority?: "critical" | "high" | "medium" | "low";
	size?: "xs" | "s" | "m" | "l" | "xl";
	/** A status of the project's template. */
	status: string;
	parent?: string;
	dependsOn?: string[];
	labels?: string[];
	body?: string;
	criteria?: string[];
	blockedReason?: string;
	/** Age at creation. */
	created: string;
	/** Status moves (oldest first); the last should equal `status`. */
	moves?: Array<{ ago: string; to: string; actor?: string; reason?: string }>;
	owns?: string[];
}

export type RunEnd =
	| "merged"
	| "review"
	| "failed"
	| "interrupted"
	| "killed"
	| "live";

export interface SeedRun {
	alias: string;
	task: string;
	/** `task` runs are the default. */
	kind?: "task" | "repair";
	relation?: "fresh" | "repair" | "resume" | "attempt" | "answer";
	role?: "implement" | "attempt" | "review" | "verify";
	parent?: string;
	group?: string;
	harness: "claude-cli" | "codex-cli";
	model: string;
	effort?: "low" | "medium" | "high" | "xhigh";
	/** When it started, and how long it ran (minutes). */
	start: string;
	minutes: number;
	end: RunEnd;
	costUsd: number;
	tokensIn: number;
	tokensOut: number;
	/** What the run committed on its branch; merged runs land on main. */
	change?: { message: string; files: Record<string, string> };
	/** Verification results shown on the run. */
	checks?: Array<{ check: string; passed: boolean; detail?: string }>;
	/** Last assistant message of the run. */
	summary?: string;
	/** A live run's current activity. */
	activity?: "working" | "needs_answer";
	question?: { text: string; options?: string[] };
	subagents?: Array<{
		type: string;
		description: string;
		tools: Record<string, number>;
	}>;
}

export interface SeedGroup {
	alias: string;
	task: string;
	status: "open" | "selecting" | "merged";
	selection: "brain" | "first_verified";
	winner?: string;
	start: string;
}

export interface SeedBrainAction {
	ago: string;
	tool: string;
	task?: string;
	run?: string;
	rationale: string;
	confidence?: "low" | "medium" | "high";
	status?: "applied" | "proposed" | "rejected";
	args?: Record<string, unknown>;
	alternatives?: Array<{ option: string; why_not: string }>;
	/** `notify_human` (needs-you) and `set_plan` carry their own text. */
	text?: string;
}

export interface SeedBrain {
	model: string;
	harness: "claude-cli";
	turns: Array<{
		ago: string;
		wake:
			| "settled"
			| "attention"
			| "frontier"
			| "capacity"
			| "merge"
			| "human"
			| "heartbeat";
		minutes: number;
		costUsd: number;
		actions: SeedBrainAction[];
	}>;
}

export interface SeedAdr {
	title: string;
	status: "accepted" | "proposed" | "superseded";
	date: string;
	body: string;
}

export interface SeedProject {
	/** Plan key (stable across runs; used in section paths). */
	key: string;
	/** Directory and project name. */
	name: string;
	template: Template;
	/** A separate board folder beside the repository (the docs/site shape). */
	separateBoard?: boolean;
	/** Which `repos.ts` generator builds the repository. */
	repo: string;
	tasks: SeedTask[];
	runs: SeedRun[];
	groups?: SeedGroup[];
	adrs?: SeedAdr[];
	brain?: SeedBrain;
	budgets?: { dailyUsd?: number; weeklyUsd?: number };
	/** Alias of the task whose live run is in `activity: needs_answer`, for tests. */
	notes?: string;
}

export interface SeedPlan {
	projects: SeedProject[];
	usage: UsageFixture;
}

export interface UsageFixture {
	subscriptions: Array<{
		provider: string;
		name: string;
		accountLabel: string | null;
		windows: Array<{
			label: string;
			usedPercent: number;
			/** Minutes until it resets; the loader turns it into an instant. */
			resetsInMinutes: number;
			windowMinutes: number;
		}>;
	}>;
}

/** Statuses a template declares (mirror of `daemon/board-templates.ts`; a test pins the two together). */
export const TEMPLATE_STATUSES: Record<Template, readonly string[]> = {
	"mfw-default": [
		"draft",
		"backlog",
		"ready",
		"in_progress",
		"blocked",
		"review",
		"done",
		"archived",
	],
	kanban: ["todo", "doing", "review", "done"],
	planning: ["planned", "doing", "done", "deferred", "dropped", "retired"],
};

/** Everything wrong with a plan, as sentences; empty = valid. */
export function validateSeedPlan(plan: SeedPlan): string[] {
	const problems: string[] = [];
	const keys = new Set<string>();
	for (const p of plan.projects) {
		const at = `project ${p.key}`;
		if (keys.has(p.key)) problems.push(`${at}: duplicate key`);
		keys.add(p.key);
		const statuses = TEMPLATE_STATUSES[p.template];
		const aliases = new Set<string>();
		for (const t of p.tasks) {
			if (aliases.has(t.alias))
				problems.push(`${at}: duplicate task ${t.alias}`);
			aliases.add(t.alias);
		}
		const order = new Map(p.tasks.map((t, i) => [t.alias, i] as const));
		for (const t of p.tasks) {
			const where = `${at}, task ${t.alias}`;
			if (!statuses.includes(t.status))
				problems.push(`${where}: status '${t.status}' is not in ${p.template}`);
			for (const m of t.moves ?? []) {
				if (!statuses.includes(m.to))
					problems.push(`${where}: move to '${m.to}' is not in ${p.template}`);
			}
			const last = t.moves?.at(-1);
			if (last && last.to !== t.status)
				problems.push(
					`${where}: last move ends in '${last.to}', status is '${t.status}'`,
				);
			for (const ref of [t.parent, ...(t.dependsOn ?? [])]) {
				if (ref === undefined) continue;
				if (!aliases.has(ref))
					problems.push(`${where}: unknown reference '${ref}'`);
				else if ((order.get(ref) as number) >= (order.get(t.alias) as number))
					problems.push(`${where}: '${ref}' must be listed before it`);
			}
			try {
				parseAgo(t.created);
				for (const m of t.moves ?? []) parseAgo(m.ago);
			} catch (e) {
				problems.push(`${where}: ${(e as Error).message}`);
			}
		}
		const runAliases = new Set<string>();
		for (const r of p.runs) {
			const where = `${at}, run ${r.alias}`;
			if (runAliases.has(r.alias)) problems.push(`${where}: duplicate`);
			runAliases.add(r.alias);
			if (!aliases.has(r.task))
				problems.push(`${where}: unknown task '${r.task}'`);
			if (r.parent && !runAliases.has(r.parent))
				problems.push(
					`${where}: parent '${r.parent}' must be listed before it`,
				);
			if (r.group && !(p.groups ?? []).some((g) => g.alias === r.group))
				problems.push(`${where}: unknown group '${r.group}'`);
			if (r.end === "live" && r.activity === undefined)
				problems.push(`${where}: a live run needs an activity`);
			try {
				parseAgo(r.start);
			} catch (e) {
				problems.push(`${where}: ${(e as Error).message}`);
			}
		}
		for (const g of p.groups ?? []) {
			if (!aliases.has(g.task))
				problems.push(`${at}, group ${g.alias}: unknown task`);
			if (g.winner && !runAliases.has(g.winner))
				problems.push(`${at}, group ${g.alias}: unknown winner`);
		}
		for (const turn of p.brain?.turns ?? []) {
			for (const a of turn.actions) {
				if (a.task && !aliases.has(a.task))
					problems.push(
						`${at}, brain action ${a.tool}: unknown task '${a.task}'`,
					);
				if (a.run && !runAliases.has(a.run))
					problems.push(
						`${at}, brain action ${a.tool}: unknown run '${a.run}'`,
					);
			}
		}
	}
	return problems;
}

/** Everything in the section list that cannot work, as sentences; empty = valid. */
export function validateSections(
	sections: readonly Section[],
	plan: SeedPlan,
): string[] {
	const problems: string[] = [];
	const seen = new Set<string>();
	const projects = new Map(plan.projects.map((p) => [p.key, p]));
	for (const s of sections) {
		if (!/^[a-z][a-z0-9-]*$/.test(s.name))
			problems.push(`section '${s.name}': names are lowercase-kebab`);
		if (seen.has(s.name)) problems.push(`section '${s.name}': duplicate`);
		seen.add(s.name);
		if (!s.path.startsWith("/"))
			problems.push(`section '${s.name}': path must start with /`);
		if (s.project !== null && !projects.has(s.project))
			problems.push(`section '${s.name}': unknown project '${s.project}'`);
		for (const [kind, a, b] of placeholdersOf(s.path)) {
			const project = projects.get(
				kind === "p" || kind === "t" ? a : (s.project ?? ""),
			);
			if (!project) {
				problems.push(`section '${s.name}': {${kind}:${a}} names no project`);
				continue;
			}
			if (kind === "t" && !project.tasks.some((t) => t.alias === b))
				problems.push(`section '${s.name}': no task '${b}' in ${a}`);
			if (kind === "r" && !project.runs.some((r) => r.alias === a))
				problems.push(`section '${s.name}': no run '${a}' in ${project.key}`);
			if (kind === "g" && !(project.groups ?? []).some((g) => g.alias === a))
				problems.push(`section '${s.name}': no group '${a}' in ${project.key}`);
		}
	}
	return problems;
}
