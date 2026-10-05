import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

export type ToolId = "claude" | "codex" | "opencode" | "pi";
export type Scope = "project" | "global";

/** Processing order of the coverage rule (not the display order). */
export const TOOL_ORDER: ToolId[] = ["claude", "codex", "pi", "opencode"];
export const ALL_TOOLS: ToolId[] = ["claude", "codex", "opencode", "pi"];

interface Env {
	[k: string]: string | undefined;
}

/** A skills root a tool reads, as a function of scope. */
type Root = (scope: Scope, cwd: string, env: Env) => string;

const home = (env: Env) => env.HOME || homedir();
const projectOrHome =
	(sub: string): Root =>
	(scope, cwd, env) =>
		scope === "project" ? join(cwd, sub) : join(home(env), sub);

const AGENTS: Root = projectOrHome(".agents/skills");
// Global scope follows CLAUDE_CONFIG_DIR, exactly like the claude target.
const CLAUDE_COMPAT: Root = (scope, cwd, env) =>
	scope === "project"
		? join(cwd, ".claude/skills")
		: join(CONFIG_DIRS.claude(env), "skills");

interface ToolSpec {
	exe: string;
	/** The tool's global config directory (also used for detection). */
	configDir: (env: Env) => string;
	/** Where we install for this tool (a skills root; `mfwb/SKILL.md` goes below). */
	native: Root;
	/** Other skills roots the tool also reads. */
	alsoReads: Root[];
}

const globalOrProject =
	(project: string, config: (env: Env) => string): Root =>
	(scope, cwd, env) =>
		scope === "project" ? join(cwd, project) : join(config(env), "skills");

const CONFIG_DIRS: Record<ToolId, (env: Env) => string> = {
	claude: (e) => e.CLAUDE_CONFIG_DIR || join(home(e), ".claude"),
	codex: (e) => e.CODEX_HOME || join(home(e), ".codex"),
	opencode: (e) =>
		join(e.XDG_CONFIG_HOME || join(home(e), ".config"), "opencode"),
	pi: (e) => e.PI_CODING_AGENT_DIR || join(home(e), ".pi", "agent"),
};

export const TOOLS: Record<ToolId, ToolSpec> = {
	claude: {
		exe: "claude",
		configDir: CONFIG_DIRS.claude,
		native: globalOrProject(".claude/skills", CONFIG_DIRS.claude),
		alsoReads: [],
	},
	codex: {
		exe: "codex",
		configDir: CONFIG_DIRS.codex,
		native: globalOrProject(".agents/skills", CONFIG_DIRS.codex),
		// Project scope: native already is .agents/skills.
		alsoReads: [AGENTS],
	},
	opencode: {
		exe: "opencode",
		configDir: CONFIG_DIRS.opencode,
		native: globalOrProject(".opencode/skills", CONFIG_DIRS.opencode),
		alsoReads: [CLAUDE_COMPAT, AGENTS],
	},
	pi: {
		exe: "pi",
		configDir: CONFIG_DIRS.pi,
		native: globalOrProject(".pi/skills", CONFIG_DIRS.pi),
		alsoReads: [AGENTS],
	},
};

/**
 * The project root for project-scope installs: the nearest ancestor of `cwd`
 * (itself included) containing `.git` (directory or file), else `cwd`.
 */
export function findProjectRoot(cwd: string): string {
	let dir = cwd;
	for (;;) {
		if (existsSync(join(dir, ".git"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return cwd;
		dir = parent;
	}
}

export function installPath(
	tool: ToolId,
	scope: Scope,
	cwd: string,
	env: Env,
): string {
	return join(TOOLS[tool].native(scope, cwd, env), "mfwb", "SKILL.md");
}

function isExecutable(p: string): boolean {
	try {
		const s = statSync(p);
		return s.isFile() && (s.mode & 0o111) !== 0;
	} catch {
		return false;
	}
}

export function detect(tool: ToolId, env: Env): boolean {
	const spec = TOOLS[tool];
	for (const dir of (env.PATH ?? "").split(delimiter)) {
		if (dir && isExecutable(join(dir, spec.exe))) return true;
	}
	return existsSync(spec.configDir(env));
}

export interface PlanEntry {
	tool: ToolId;
	/** The tool's own install path. */
	path: string;
	/** Install path of the earlier planned install that already serves it. */
	coveredBy?: string;
}

/**
 * The coverage rule: in TOOL_ORDER, a tool is covered when any skills root it
 * also reads (own native root included) holds an already-planned install.
 */
export function plan(
	selected: ToolId[],
	scope: Scope,
	cwd: string,
	env: Env,
): PlanEntry[] {
	const entries: PlanEntry[] = [];
	const planned = new Set<string>();
	for (const tool of TOOL_ORDER.filter((t) => selected.includes(t))) {
		const spec = TOOLS[tool];
		const path = installPath(tool, scope, cwd, env);
		const reads = [spec.native, ...spec.alsoReads].map((r) =>
			join(r(scope, cwd, env), "mfwb", "SKILL.md"),
		);
		const coveredBy = reads.find((p) => planned.has(p));
		if (coveredBy) entries.push({ tool, path, coveredBy });
		else {
			planned.add(path);
			entries.push({ tool, path });
		}
	}
	return entries;
}

export type FileState = "installed" | "missing" | "stale";

export function fileState(path: string, packaged: string): FileState {
	if (!existsSync(path)) return "missing";
	return readFileSync(path, "utf8") === packaged ? "installed" : "stale";
}

/** Parses a `--target` list; returns null for an unknown name. */
export function parseTargets(value: string, env: Env): ToolId[] | null {
	if (value === "all") return [...ALL_TOOLS];
	if (value === "detected") {
		return ALL_TOOLS.filter((t) => detect(t, env));
	}
	const out: ToolId[] = [];
	for (const raw of value.split(",")) {
		const n = raw.trim() as ToolId;
		if (!ALL_TOOLS.includes(n)) return null;
		if (!out.includes(n)) out.push(n);
	}
	return out.length ? out : null;
}
