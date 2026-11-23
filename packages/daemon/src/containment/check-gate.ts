/**
 * The gate on DoD checks (backstage architecture.md, "Host-executed paths").
 *
 * A check exists to run the candidate's code, so its test files cannot be
 * pinned the way a trigger's script is. What can be held fixed is what the
 * check *enters through*. Before a check runs on a candidate, these must be
 * byte-identical to the trusted base commit:
 *
 *  - the script the command directly executes or sources;
 *  - the package script or Makefile it names;
 *  - the dev-environment files, when `checkPrefix` loads them (`.envrc`,
 *    `flake.nix`, ...), because the prefix evaluates them before the check.
 *
 * Otherwise the check is refused with a fix, and nothing runs.
 *
 * Residual, and the important one: this does not contain the check. Code the
 * entry point reaches (test files, imported modules) is candidate code and
 * still runs with the daemon's uid, in a scrubbed environment, until the
 * verifier role runs under the sandbox profile (plan lane P7, with P8 for the
 * dev shell).
 */
import { lstat } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
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

function scriptOf(json: string | null, name: string): string | undefined {
	if (json === null) return undefined;
	try {
		const parsed = JSON.parse(json) as { scripts?: Record<string, unknown> };
		const value = parsed.scripts?.[name];
		return typeof value === "string" ? value : undefined;
	} catch {
		return undefined;
	}
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
		if (found === "absent") continue;
		const read = await readRegularFile(join(root, rel), MAX_ENTRY_BYTES);
		const text = read ? read.buffer.toString("utf8") : null;
		const script = scriptOf(text, name);
		if (script === undefined) continue;
		if (script !== scriptOf(await baseFile(gate, rel), name)) {
			return {
				path: rel,
				reason: `this change alters the package script \`${name}\`, which the host would execute for this check`,
				fix: FIX,
			};
		}
		// Stay rooted at the repository so paths still match the base tree.
		const nested = await checkGateRefusal(
			root,
			dir === "." ? script : `cd '${dir.replace(/'/g, `'\\''`)}' && ${script}`,
			undefined,
			gate,
			seen,
		);
		if (nested) return nested;
	}
	return null;
}
