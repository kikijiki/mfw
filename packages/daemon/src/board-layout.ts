import { mkdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { type BoardConfig, writeFileAtomic } from "@mfw/board-core";
import { readProjectFile } from "./containment/safe-file.ts";

/**
 * Where the board sits relative to the repository, as far as the code that
 * guards it is concerned.
 *
 * The board lives at the root of its board folder (`board.yaml`, `tasks/`,
 * `adrs/`, `templates/`), which is the repository root unless the project has a
 * `boardRoot`. The merge firewall (`merge-queue.ts`) is built from a bare
 * repository path, so `boot` records the board's repository-relative paths in
 * the daemon's own state and the firewall reads them from there.
 */

/** What a repository gets before `boot` has recorded anything (fail closed). */
export const DEFAULT_PROTECTED_BOARD_PATHS: readonly string[] = [
	"board.yaml",
	"tasks",
	"adrs",
];

/**
 * The board layout record: one per project, and the only resolver of where the
 * board is. Layout (a) keeps the board in the code repository; layout (c) keeps
 * it in a separate repository. Layout (b), a dedicated branch, is not
 * supported yet, so it is not representable here.
 */
export type BoardLayoutKind = "in-repo" | "separate-repo";

/**
 * Where board writes go and whether they leave the machine with the code.
 * `with-code`: committed on the integration branch and pushed with it.
 * `board-repo`: committed to the board repository, pushed per its own setting.
 * `untracked`: written but never committed or pushed (reports on a public remote).
 */
export type BoardPushPolicy = "with-code" | "board-repo" | "untracked";

export interface BoardLayoutRecord {
	version: 1;
	layout: BoardLayoutKind;
	/** Absolute path of the board folder (holds `board.yaml`). */
	root: string;
	/** Absolute path of the repository the board commits to. */
	commitRepo: string;
	push: BoardPushPolicy;
	/** Repository-relative POSIX paths of the board's own files, empty in layout (c). */
	protectedPaths: string[];
}

export function buildBoardLayoutRecord(input: {
	repoRoot: string;
	boardFolder: string;
	config: Pick<BoardConfig, "types">;
	push?: BoardPushPolicy;
}): BoardLayoutRecord {
	const paths = boardRepoPaths(input.repoRoot, input.boardFolder, input.config);
	// A board folder nested inside the repository is still layout (a).
	const inRepo = paths.length > 0;
	return {
		version: 1,
		layout: inRepo ? "in-repo" : "separate-repo",
		root: resolve(input.boardFolder),
		commitRepo: inRepo ? resolve(input.repoRoot) : resolve(input.boardFolder),
		push: input.push ?? (inRepo ? "with-code" : "board-repo"),
		protectedPaths: paths,
	};
}

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
	record: BoardLayoutRecord,
): Promise<void> {
	await mkdir(join(repoRoot, ".mfw", "state"), { recursive: true });
	await writeFileAtomic(
		locationFile(repoRoot),
		`${JSON.stringify(record, null, 2)}\n`,
	);
}

const LAYOUTS: readonly string[] = ["in-repo", "separate-repo"];
const PUSH: readonly string[] = ["with-code", "board-repo", "untracked"];

function isStringArray(v: unknown): v is string[] {
	return Array.isArray(v) && v.every((p) => typeof p === "string");
}

/** The recorded layout, or `null` when none was recorded or the file is not a valid record. */
export async function readBoardLayout(
	repoRoot: string,
): Promise<BoardLayoutRecord | null> {
	try {
		const text = await readProjectFile(locationFile(repoRoot));
		if (text === null) return null;
		const raw = JSON.parse(text) as Record<string, unknown>;
		if (
			raw.version === 1 &&
			typeof raw.layout === "string" &&
			LAYOUTS.includes(raw.layout) &&
			typeof raw.root === "string" &&
			typeof raw.commitRepo === "string" &&
			typeof raw.push === "string" &&
			PUSH.includes(raw.push) &&
			isStringArray(raw.protectedPaths)
		) {
			return raw as unknown as BoardLayoutRecord;
		}
	} catch {
		// not recorded yet
	}
	return null;
}

/** The recorded board paths, or the defaults when none were recorded (fail closed). */
export async function readProtectedBoardPaths(
	repoRoot: string,
): Promise<string[]> {
	const record = await readBoardLayout(repoRoot);
	return record
		? [...record.protectedPaths]
		: [...DEFAULT_PROTECTED_BOARD_PATHS];
}

/**
 * The paths the merge firewall (`merge-queue.ts` `restoreBoard`) takes from
 * the target whatever a run did: the board's own files and everything under
 * `.mfw/` except `.mfw/triggers/`, which a run may change.
 */
export function firewalledPath(
	boardPaths: readonly string[],
): (path: string) => boolean {
	return (path) =>
		(path.startsWith(".mfw/") && !path.startsWith(".mfw/triggers/")) ||
		boardPaths.some((p) => path === p || path.startsWith(`${p}/`));
}
