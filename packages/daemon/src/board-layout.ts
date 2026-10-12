import { mkdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { type BoardConfig, writeFileAtomic } from "@mfw/board-core";

/**
 * Where the board sits relative to the repository, as far as the code that
 * guards it is concerned.
 *
 * The board lives at the root of its board folder (`board.yaml`, `tasks/`,
 * `adrs/`, `templates/`), which is the repository root unless the project has a
 * `boardRoot`. Run worktrees (`worktree.ts`) and the merge firewall
 * (`merge-queue.ts`) are built from a bare repository path in many places, so
 * `boot` records the board's repository-relative paths in the daemon's own
 * state and both read them from there.
 */

/** What a repository gets before `boot` has recorded anything (fail closed). */
export const DEFAULT_PROTECTED_BOARD_PATHS: readonly string[] = [
	"board.yaml",
	"tasks",
	"adrs",
];

function locationFile(repoRoot: string): string {
	return join(repoRoot, ".mfw", "state", "board-location.json");
}

/**
 * The repository-relative POSIX paths of the board's own files: `board.yaml`
 * and every document type's directory. Empty when the board folder is outside
 * the repository. `templates/` is deliberately not protected: at a repository
 * root it is as likely to be code as board.
 */
export function boardRepoPaths(
	repoRoot: string,
	boardFolder: string,
	config: Pick<BoardConfig, "types">,
): string[] {
	const rel = relative(repoRoot, boardFolder);
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return [];
	const prefix = rel === "" ? "" : `${rel.split(sep).join("/")}/`;
	const names = new Set<string>(["board.yaml"]);
	for (const type of Object.values(config.types)) {
		const dir = (type.dir ?? "").replace(/^\.\//, "").replace(/\/+$/, "");
		if (dir !== "" && dir !== "." && !dir.startsWith("..")) names.add(dir);
	}
	return [...names].map((n) => `${prefix}${n}`);
}

export async function recordBoardLocation(
	repoRoot: string,
	paths: readonly string[],
): Promise<void> {
	await mkdir(join(repoRoot, ".mfw", "state"), { recursive: true });
	await writeFileAtomic(
		locationFile(repoRoot),
		`${JSON.stringify({ paths }, null, 2)}\n`,
	);
}

/** The recorded board paths, or the defaults when none were recorded. */
export async function readProtectedBoardPaths(
	repoRoot: string,
): Promise<string[]> {
	try {
		const raw = JSON.parse(await readFile(locationFile(repoRoot), "utf8")) as {
			paths?: unknown;
		};
		if (
			Array.isArray(raw.paths) &&
			raw.paths.every((p) => typeof p === "string")
		) {
			return raw.paths as string[];
		}
	} catch {
		// not recorded yet
	}
	return [...DEFAULT_PROTECTED_BOARD_PATHS];
}
