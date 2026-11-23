/**
 * The gate on DoD checks (backstage architecture.md, "Host-executed paths").
 *
 * A check exists to run the candidate's code, so its test files cannot be
 * pinned the way a trigger's script is. What can be held fixed is what the
 * check *enters through*. Before a check runs on a candidate, these must be
 * byte-identical to the trusted base commit:
 *
 *  - the script the command directly executes or sources;
 *  - the package's whole `scripts` block (pre and post hooks included), and the
 *    config a package runner reads first (`bunfig.toml`, `.npmrc`, lockfiles);
 *  - the Makefile it names and everything that Makefile includes;
 *  - the dev-environment files, when `checkPrefix` loads them (`.envrc`,
 *    `flake.nix`, ...), because the prefix evaluates them before the check.
 *
 * Otherwise the check is refused with a fix, and nothing runs. So is a command
 * the analyzer cannot read (substitution, control flow, loader variables).
 *
 * Residual, and the important one: this does not contain the check. Code the
 * entry point reaches (test files, imported modules) is candidate code and
 * still runs with the daemon's uid, in a scrubbed environment, until the
 * verifier role runs under the sandbox profile (plan lane P7, with P8 for the
 * dev shell).
 */
import { lstat } from "node:fs/promises";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	normalize,
	relative,
	resolve,
	sep,
} from "node:path";
import { git } from "../git.ts";
import { analyzeShell, committedBlobs, gitBlobId } from "./exec-pin.ts";
import { readRegularFile } from "./safe-file.ts";

export interface CheckGate {
	/** The trusted primary; git runs here, never in the candidate tree. */
	primaryRoot: string;
	/** The revision the entry points must match. */
	baseRev: string;
}

export interface CheckRefusal {
	path: string;
	reason: string;
	fix: string;
}

const MAX_ENTRY_BYTES = 8 * 1024 * 1024;
const WRAPPERS = new Set(["exec", "command", "env", "nohup"]);
const SHELLS = new Set(["sh", "bash", "dash"]);
const PACKAGE_RUNNERS = new Set(["bun", "npm", "pnpm", "yarn"]);
const BUILD_FILES: Record<string, string[]> = {
	make: ["GNUmakefile", "makefile", "Makefile"],
	just: ["justfile", "Justfile", ".justfile"],
};
const DEV_ENV_FILES = [
	".envrc",
	"flake.nix",
	"flake.lock",
	"shell.nix",
	"default.nix",
	"devenv.nix",
	"devenv.yaml",
	"devenv.lock",
	"devbox.json",
	"mise.toml",
	".mise.toml",
	".tool-versions",
];
/** Read by a package runner before any script: a change here can preload code. */
const PACKAGE_CONFIG = [
	"bunfig.toml",
	".npmrc",
	".yarnrc",
	".yarnrc.yml",
	"bun.lock",
	"bun.lockb",
	"package-lock.json",
	"npm-shrinkwrap.json",
	"pnpm-lock.yaml",
	"pnpm-workspace.yaml",
	"yarn.lock",
];
/** What `bun run <name>` falls back to when no script has that name. */
const SCRIPT_FILE_SUFFIXES = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const RUNNER_SUBCOMMANDS = new Set([
	"test",
	"install",
	"i",
	"ci",
	"x",
	"add",
	"exec",
	"build",
]);
const MAKE_INCLUDE = /^[ \t]*-?s?include[ \t]+(.+)$/gm;
const ENV_LOADER =
	/(?:^|[\s/])(?:direnv|nix|nix-shell|devenv|devbox|mise|asdf)(?:\s|$)/;

const FIX =
	"Leave this file unchanged in the task, or land the change by hand so it becomes the new baseline.";

interface Entries {
	files: Set<string>;
	/** `<dir>\0<script name>` for a package script the command runs. */
	packageScripts: Set<string>;
}

/** The repo-relative files `run` directly enters through. Best effort by design. */
export function checkEntries(run: string): Entries {
	const out: Entries = { files: new Set(), packageScripts: new Set() };
	let dir = ".";
	for (const command of analyzeShell(run).commands) {
		let words = command.words;
		while (words.length > 1 && WRAPPERS.has(words[0] ?? "")) {
			let next = 1;
			while (
				next < words.length &&
				(words[next]?.startsWith("-") ||
					/^[A-Za-z_]\w*=/.test(words[next] ?? ""))
			) {
				next++;
			}
			words = words.slice(next);
		}
		const head = words[0];
		if (typeof head !== "string") continue;
		const args = words
			.slice(1)
			.filter((w): w is string => typeof w === "string" && !w.startsWith("-"));
		if (head === "cd") {
			if (args[0]) dir = normalize(join(dir, args[0]));
			continue;
		}
		const add = (path: string) => {
			if (!isAbsolute(path)) out.files.add(normalize(join(dir, path)));
			else out.files.add(path);
		};
		if (head === "." || head === "source") {
			if (args[0]) add(args[0]);
		} else if (head.includes("/")) {
			add(head);
		}
		if (SHELLS.has(head.split("/").pop() ?? "") && args[0]) add(args[0]);
		for (const name of BUILD_FILES[head] ?? []) add(name);
		if (PACKAGE_RUNNERS.has(head)) {
			const name = args[0] === "run" ? args[1] : args[0];
			if (name) out.packageScripts.add(`${dir}\0${name}`);
		}
	}
	return out;
}

/** Inside `root`, with no symlink on the way; null when it does not exist. */
async function candidateBlob(
	root: string,
	rel: string,
): Promise<{ blob: string } | "absent" | CheckRefusal> {
	let cur = root;
	for (const part of rel.split(sep)) {
		cur = join(cur, part);
		const st = await lstat(cur).catch(() => null);
		if (!st) return "absent";
		if (st.isSymbolicLink()) {
			return {
				path: rel,
				reason: `${rel} goes through a symlink in the candidate`,
				fix: FIX,
			};
		}
	}
	const read = await readRegularFile(cur, MAX_ENTRY_BYTES);
	if (!read || read.size > MAX_ENTRY_BYTES) {
		return {
			path: rel,
			reason: `${rel} is not a readable regular file`,
			fix: FIX,
		};
	}
	return { blob: gitBlobId(read.buffer) };
}

async function baseFile(gate: CheckGate, rel: string): Promise<string | null> {
	const r = await git(
		["cat-file", "blob", `${gate.baseRev}:${rel}`],
		gate.primaryRoot,
	);
	return r.exitCode === 0 ? r.stdout : null;
}

/** The `scripts` block with sorted keys; null when the file is absent or unparsable. */
function scriptsOf(json: string | null): Record<string, unknown> | null {
	if (json === null) return null;
	try {
		const parsed = JSON.parse(json) as { scripts?: Record<string, unknown> };
		const scripts = parsed.scripts ?? {};
		return Object.fromEntries(
			Object.entries(scripts).sort(([a], [b]) => a.localeCompare(b)),
		);
	} catch {
		return null;
	}
}

/**
 * Add what `rel` includes to `files`, transitively. A computed include cannot
 * be compared, so it is a refusal.
 */
async function addMakeIncludes(
	root: string,
	rel: string,
	files: Set<string>,
	seen: Set<string>,
): Promise<CheckRefusal | null> {
	if (seen.has(rel)) return null;
	seen.add(rel);
	const found = await candidateBlob(root, rel);
	if (found === "absent" || "reason" in found) return null;
	const read = await readRegularFile(join(root, rel), MAX_ENTRY_BYTES);
	if (!read) return null;
	const text = read.buffer.toString("utf8");
	for (const match of text.matchAll(MAKE_INCLUDE)) {
		for (const name of (match[1] as string).trim().split(/\s+/)) {
			if (name.startsWith("#")) break;
			if (/[$*?[]/.test(name)) {
				return {
					path: rel,
					reason: `${rel} has a computed include (${name}) that cannot be checked against the base`,
					fix: "Name the included file literally, or land the change by hand.",
				};
			}
			const target = normalize(join(dirname(rel), name));
			if (target === ".." || target.startsWith(`..${sep}`)) continue;
			files.add(target);
			const nested = await addMakeIncludes(root, target, files, seen);
			if (nested) return nested;
		}
	}
	return null;
}

/** Why `run` must not execute in `cwd`, or null when its entry points match the base. */
export async function checkGateRefusal(
	cwd: string,
	run: string,
	checkPrefix: string | undefined,
	gate: CheckGate,
	seen: Set<string> = new Set(),
): Promise<CheckRefusal | null> {
	const root = resolve(cwd);
	const analysis = analyzeShell(run);
	if (analysis.unanalyzable) {
		return {
			path: run.slice(0, 80),
			reason: `this check cannot be checked against the base because ${analysis.unanalyzable}`,
			fix: "Move the logic into a script committed on the base branch and run that script.",
		};
	}
	const entries = checkEntries(run);
	const files = new Set<string>();
	for (const file of entries.files) {
		const rel = isAbsolute(file) ? relative(root, file) : file;
		if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
		files.add(rel);
	}
	if (checkPrefix && ENV_LOADER.test(checkPrefix)) {
		for (const name of DEV_ENV_FILES) files.add(name);
	}

	for (const key of entries.packageScripts) {
		const [dir] = key.split("\0") as [string, string];
		for (const name of PACKAGE_CONFIG) {
			files.add(normalize(join(dir, name)));
			files.add(name);
		}
	}
	const makeSeen = new Set<string>();
	for (const rel of [...files]) {
		if (!Object.values(BUILD_FILES).flat().includes(basename(rel))) continue;
		const refused = await addMakeIncludes(root, rel, files, makeSeen);
		if (refused) return refused;
	}

	const present = new Map<string, string>();
	for (const rel of files) {
		const found = await candidateBlob(root, rel);
		if (found === "absent") continue;
		if ("reason" in found) return found;
		present.set(rel, found.blob);
	}
	const relevant = [...new Set([...files])];
	if (relevant.length > 0) {
		const base = await committedBlobs(gate.primaryRoot, gate.baseRev, relevant);
		if (!base) {
			return {
				path: relevant[0] as string,
				reason: `cannot read the base revision ${gate.baseRev}`,
				fix: "Check that the run's base commit still exists in the primary.",
			};
		}
		for (const rel of relevant) {
			const candidate = present.get(rel);
			const committed = base.get(rel);
			if (candidate === committed) continue;
			if (candidate === undefined) {
				return {
					path: rel,
					reason: `this change removes ${rel}, which the check depends on`,
					fix: FIX,
				};
			}
			return {
				path: rel,
				reason: committed
					? `this change modifies ${rel}, which the host would execute for this check`
					: `this change adds ${rel}, which the host would execute for this check`,
				fix: FIX,
			};
		}
	}

	for (const key of entries.packageScripts) {
		if (seen.has(key)) continue;
		seen.add(key);
		const [dir, name] = key.split("\0") as [string, string];
		const rel = normalize(join(dir, "package.json"));
		const found = await candidateBlob(root, rel);
		if (found !== "absent" && "reason" in found) return found;
		const read =
			found === "absent"
				? null
				: await readRegularFile(join(root, rel), MAX_ENTRY_BYTES);
		const scripts = scriptsOf(read ? read.buffer.toString("utf8") : null);
		const baseScripts = scriptsOf(await baseFile(gate, rel));
		// The whole block: `pre<name>` and `post<name>` run without being named,
		// and removing a script makes the runner fall back to a file of that name.
		if (JSON.stringify(scripts ?? {}) !== JSON.stringify(baseScripts ?? {})) {
			return {
				path: rel,
				reason: `this change alters the package scripts in ${rel}, which the host would execute for this check`,
				fix: FIX,
			};
		}
		if (typeof scripts?.[name] !== "string") {
			// A runner's own subcommand (`bun test`) is not a file lookup.
			if (RUNNER_SUBCOMMANDS.has(name)) continue;
			const fallback = SCRIPT_FILE_SUFFIXES.map((suffix) =>
				normalize(join(dir, `${name}${suffix}`)),
			);
			const blobs = await committedBlobs(
				gate.primaryRoot,
				gate.baseRev,
				fallback,
			);
			for (const path of fallback) {
				const st = await lstat(join(root, path)).catch(() => null);
				if (st?.isDirectory()) continue;
				const candidate = await candidateBlob(root, path);
				if (candidate === "absent") continue;
				if ("reason" in candidate) return candidate;
				if (blobs?.get(path) !== candidate.blob) {
					return {
						path,
						reason: `this change adds or modifies ${path}, which \`${name}\` would run for this check`,
						fix: FIX,
					};
				}
			}
			continue;
		}
		// Stay rooted at the repository so paths still match the base tree.
		for (const scriptName of [`pre${name}`, name, `post${name}`]) {
			const script = scripts[scriptName];
			if (typeof script !== "string") continue;
			const nested = await checkGateRefusal(
				root,
				dir === "."
					? script
					: `cd '${dir.replace(/'/g, `'\\''`)}' && ${script}`,
				undefined,
				gate,
				seen,
			);
			if (nested) return nested;
		}
	}
	return null;
}
