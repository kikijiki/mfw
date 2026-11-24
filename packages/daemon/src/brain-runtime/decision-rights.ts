import { builtinHarnessRegistry } from "@mfw/plugin-api/harness-registry";
import type { ActTool } from "./actions.ts";

/**
 * Decision rights (DESIGN W2 "Trust", decisions §6 Q14 and §6u): for every act
 * call, whether the brain decides alone, decides and tells the owner, or asks
 * first. Autonomy-first: only the classes the owner reserved are ask-first.
 *
 * This file is pure data and pure functions. `classifyAction` names what a
 * call does, `decide` applies the table and the taint rule. Later work
 * packages add a class here (a compile error until the table covers it) and
 * call `decide`; they never compare tool names themselves.
 */

/** Bump when a default changes, so a recorded decision says which table made it. */
export const DECISION_RIGHTS_VERSION = 1;

export const PROVENANCES = [
	/** What the daemon itself observed: counters, states, ids. */
	"host",
	/** Written by the owner to the brain. */
	"owner",
	/** Board content the owner authored. */
	"owner_board",
	/** The brain's own earlier words, in a session that has seen no untrusted text. */
	"brain",
	/** Written by a fleet agent: reports, questions, tasks it filed. */
	"agent",
	/** From outside mfw: repo content, CI logs, diffs, forge or web text. */
	"external",
] as const;
export type Provenance = (typeof PROVENANCES)[number];

const TAINTING: ReadonlySet<Provenance> = new Set(["agent", "external"]);

export function isTainting(p: Provenance): boolean {
	return TAINTING.has(p);
}

export const ACTION_CLASSES = [
	"own_memory",
	"escalate",
	"run_control",
	"dispatch",
	"board_edit",
	"merge_select",
	"goal_scope",
	"verification_change",
	"budget_lower",
	"nonproduction_deploy",
	"adr_proposal",
	"budget_ceiling",
	"sandbox_widening",
	"arm_trigger",
	"production_deploy",
	"adr_acceptance",
	"host_executed_merge",
	"publish_outward",
] as const;
export type ActionClass = (typeof ACTION_CLASSES)[number];

export type Right = "autonomous" | "notify_after" | "ask_first";

export interface RightsEntry {
	right: Right;
	/** False: a turn that read untrusted text must ask, whatever `right` says. */
	taintSafe: boolean;
}
export type RightsTable = Readonly<Record<ActionClass, RightsEntry>>;

const decides: RightsEntry = { right: "autonomous", taintSafe: true };
const tells: RightsEntry = { right: "notify_after", taintSafe: true };
const tellsUnlessTainted: RightsEntry = {
	right: "notify_after",
	taintSafe: false,
};
const asks: RightsEntry = { right: "ask_first", taintSafe: false };

/**
 * The defaults. `taintSafe` work stays autonomous after reading a CI log on
 * purpose: repairing from a failure report is the fleet's core loop, and what
 * it starts is confined by the run sandbox and the merge gates.
 */
export const DEFAULT_RIGHTS: RightsTable = {
	own_memory: decides,
	escalate: decides,
	run_control: tells,
	dispatch: tells,
	board_edit: tells,
	merge_select: tells,
	// The taint rule's list (DESIGN W2 "Untrusted input to the brain").
	goal_scope: tellsUnlessTainted,
	verification_change: tellsUnlessTainted,
	nonproduction_deploy: tellsUnlessTainted,
	adr_proposal: tellsUnlessTainted,
	budget_lower: tellsUnlessTainted,
	// Reserved for the owner (§6 Q14, §6u).
	budget_ceiling: asks,
	sandbox_widening: asks,
	arm_trigger: asks,
	production_deploy: asks,
	adr_acceptance: asks,
	host_executed_merge: asks,
	publish_outward: asks,
};

/** What the classifier needs to know about the board and the run. */
export interface RightsFacts {
	/** False only for a task known to be written by the brain or an agent. */
	ownerAuthored(taskId: string): boolean;
	/** `run` commands already trusted: on owner tasks, or on the edited task. */
	knownCommands: ReadonlySet<string>;
	/** `select_winner`: the run's changed files; null when they cannot be listed. */
	changedFiles: readonly string[] | null;
}

/**
 * What each supported harness loads from a project checkout, by catalogue id,
 * from its manifest. The host-executed lists below stay in the core, so a
 * manifest cannot remove a protected path, and
 * `merge-host-executed-gate.test.ts` fails if a manifest names a path they miss.
 */
export const HARNESS_CONFIG_PATHS: Readonly<Record<string, readonly string[]>> =
	// No prototype: an id is data and must not resolve to `constructor`.
	Object.assign(
		Object.create(null),
		Object.fromEntries(
			builtinHarnessRegistry()
				.list()
				.map((m) => [m.id, m.install.projectConfig]),
		),
	);

const HOST_EXECUTED_DIRS = [
	// mise config directory (`.mise/config.toml`).
	".mise",
	// Harness configuration.
	".claude",
	".codex",
	".gemini",
	".cursor",
	".opencode",
	".pi",
	".vscode",
	// Git hooks.
	".husky",
	".githooks",
	// CI that runs on a push.
	".circleci",
	".buildkite",
	".woodpecker",
];
const HOST_EXECUTED_NESTED_DIRS = [
	[".github", "workflows"],
	[".github", "actions"],
	[".forgejo", "workflows"],
	[".gitea", "workflows"],
	// mise reads these as config (`.config/mise/config.toml`, `.config/mise/conf.d/*`).
	[".config", "mise"],
	["mise", "config.toml"],
];
const HOST_EXECUTED_FILES = [
	// Harness instructions and configuration.
	"claude.md",
	"claude.local.md",
	".claude.json",
	".mcp.json",
	"agents.md",
	"agents.override.md",
	"gemini.md",
	".cursorrules",
	"opencode.json",
	"opencode.jsonc",
	// Development shell.
	".envrc",
	"flake.nix",
	"shell.nix",
	"default.nix",
	"devenv.nix",
	"devenv.yaml",
	".tool-versions",
	"mise.toml",
	".mise.toml",
	"mise.local.toml",
	".mise.local.toml",
	"devenv.local.nix",
	// Evaluated with network in the env-build sandbox, and the result is bound
	// into every run (dev-env-build.ts): ask-first, no longer notify-after.
	"flake.lock",
	"devenv.lock",
	// Package managers: registries and install behaviour.
	"bunfig.toml",
	".npmrc",
	".yarnrc",
	".yarnrc.yml",
	".pnpmfile.cjs",
	"pnpm-workspace.yaml",
	// Git behaviour: filters, drivers, submodule URLs, hook managers.
	".gitattributes",
	".gitmodules",
	".gitconfig",
	".pre-commit-config.yaml",
	"lefthook.yml",
	"lefthook.yaml",
	".lefthook.yml",
	".lefthook.yaml",
	// Build entry points a person or hook runs.
	"makefile",
	"gnumakefile",
	"justfile",
	".justfile",
	"taskfile.yml",
	"taskfile.yaml",
	// CI defined by a single file.
	".gitlab-ci.yml",
	".travis.yml",
	".woodpecker.yml",
	"azure-pipelines.yml",
	"jenkinsfile",
];

/**
 * Dependency files are not ask-first by name: run checks are sandboxed and
 * host-run triggers pin the whole tree. A project whose approved environment
 * installs from a lockfile protects it per project instead (dev-env-trust.ts).
 * `flake.lock` and `devenv.lock` are not here: they are host-executed. A landed change is a notify-after inbox
 * item. `package.json` is the exception by content: the merge gate holds it
 * when a field that executes something changes (`merge-gate.ts`).
 */
const DEPENDENCY_FILES = [
	"package.json",
	"bun.lock",
	"bun.lockb",
	"pnpm-lock.yaml",
	"package-lock.json",
	"npm-shrinkwrap.json",
	"yarn.lock",
	"cargo.lock",
	"uv.lock",
	"poetry.lock",
];

const baseName = (path: string) =>
	path.toLowerCase().split("/").filter(Boolean).at(-1) ?? "";

export function isDependencyPath(path: string): boolean {
	return DEPENDENCY_FILES.includes(baseName(path));
}

export function isPackageManifest(path: string): boolean {
	return baseName(path) === "package.json";
}

/**
 * The default protected class (§6u.4), at any depth and in any letter case.
 * A directory name also matches as the last component: replacing `.claude`
 * with a symlink changes one entry, named exactly that.
 */
export function isHostExecutedPath(path: string): boolean {
	const parts = path.toLowerCase().split("/").filter(Boolean);
	const base = parts.at(-1) ?? "";
	if (HOST_EXECUTED_FILES.includes(base)) return true;
	if (parts.some((d) => HOST_EXECUTED_DIRS.includes(d))) return true;
	return parts.some((d, i) =>
		HOST_EXECUTED_NESTED_DIRS.some(
			([outer, inner]) => d === outer && parts[i + 1] === inner,
		),
	);
}

/** The shell commands a verification plan would run. */
export function verificationCommands(v: unknown): string[] {
	const checks = (v as { checks?: unknown } | null | undefined)?.checks;
	if (!Array.isArray(checks)) return [];
	return checks.flatMap((c) => {
		const run = (c as { run?: unknown } | null)?.run;
		return typeof run === "string" ? [run.trim()] : [];
	});
}

const SCOPE_FIELDS = ["title", "body", "spec", "acceptance", "owns"];

function hasNewCommand(v: unknown, facts: RightsFacts): boolean {
	return verificationCommands(v).some((c) => !facts.knownCommands.has(c));
}

function newTaskClasses(
	specs: readonly { verification?: unknown }[],
	facts: RightsFacts,
): ActionClass[] {
	return specs.some((s) => hasNewCommand(s.verification, facts))
		? ["verification_change"]
		: [];
}

/** Every class a call belongs to; `decide` applies the strictest. */
export function classifyAction(
	tool: ActTool,
	args: Record<string, unknown>,
	facts: RightsFacts,
): ActionClass[] {
	const owner = (id: unknown) =>
		typeof id === "string" && facts.ownerAuthored(id);
	switch (tool) {
		case "set_plan":
		case "note":
		case "sleep":
			return ["own_memory"];
		case "notify_human":
			return ["escalate"];
		case "answer_question":
		case "request_review":
		case "steer":
		case "stop":
		case "pause":
		case "resume":
			return ["run_control"];
		case "spawn":
		case "spawn_attempts":
			return ["dispatch"];
		case "set_budget":
			return ["budget_lower"];
		case "select_winner":
			return facts.changedFiles === null ||
				facts.changedFiles.some(isHostExecutedPath)
				? ["host_executed_merge"]
				: ["merge_select"];
		case "create_tasks":
			return [
				"board_edit",
				...newTaskClasses(args.tasks as { verification?: unknown }[], facts),
			];
		case "update_task": {
			const patch = (args.patch ?? {}) as Record<string, unknown>;
			const out: ActionClass[] = ["board_edit"];
			if (owner(args.id) && SCOPE_FIELDS.some((f) => patch[f] !== undefined)) {
				out.push("goal_scope");
			}
			if (
				patch.verification !== undefined &&
				(owner(args.id) || hasNewCommand(patch.verification, facts))
			) {
				out.push("verification_change");
			}
			return out;
		}
		case "reparent":
			return owner(args.id) ? ["board_edit", "goal_scope"] : ["board_edit"];
		case "set_status":
			return args.to === "archived" && owner(args.id)
				? ["board_edit", "goal_scope"]
				: ["board_edit"];
		case "split_task":
			return [
				"board_edit",
				...(owner(args.id) ? (["goal_scope"] as const) : []),
				...newTaskClasses(args.into as { verification?: unknown }[], facts),
			];
		case "merge_tasks":
			return [
				"board_edit",
				...((args.ids as string[]).some(owner)
					? (["goal_scope"] as const)
					: []),
				...newTaskClasses([args.into as { verification?: unknown }], facts),
			];
	}
}

/** The inbox id of the card that holds an action. */
export const decisionCardId = (actionId: string) =>
	`brain_decision:${actionId}`;

export interface RightsDecision {
	version: number;
	right: Right;
	/** The class that decided. */
	actionClass: ActionClass;
	classes: ActionClass[];
	/** Why: the table's default, or the taint rule raising it to ask-first. */
	cause: "default" | "taint";
	tainted: boolean;
	provenance: Provenance[];
}

const RANK: Record<Right, number> = {
	autonomous: 0,
	notify_after: 1,
	ask_first: 2,
};

/**
 * The right for one call. An empty class list or an empty provenance list is
 * not evidence of safety: both resolve to the strictest reading.
 */
export function decide(
	classes: readonly ActionClass[],
	provenance: readonly Provenance[],
	table: RightsTable = DEFAULT_RIGHTS,
): RightsDecision {
	const seen: Provenance[] =
		provenance.length > 0 ? [...new Set(provenance)] : ["external"];
	const tainted = seen.some(isTainting);
	const list: ActionClass[] =
		classes.length > 0 ? [...classes] : ["publish_outward"];
	let best: Omit<RightsDecision, "version" | "classes" | "provenance"> | null =
		null;
	for (const actionClass of list) {
		const entry = table[actionClass];
		const raised = tainted && !entry.taintSafe && entry.right !== "ask_first";
		const right: Right = raised ? "ask_first" : entry.right;
		if (!best || RANK[right] > RANK[best.right]) {
			best = {
				right,
				actionClass,
				cause: raised ? "taint" : "default",
				tainted,
			};
		}
	}
	return {
		version: DECISION_RIGHTS_VERSION,
		...(best as NonNullable<typeof best>),
		classes: list,
		provenance: seen,
	};
}
