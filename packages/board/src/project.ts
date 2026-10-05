import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type BoardConfig, BoardStore, loadBoardConfig } from "@mfw/board-core";
import type { ClaimConfig } from "./claim.ts";

/** mfw's own field-name choices for claim semantics — kept out of `claim.ts`
 * itself, which knows nothing about mfw's particular `board.yaml`. */
export const MFW_CLAIM_FIELDS: Omit<ClaimConfig, "root"> = {
	statusField: "status",
	dependsOnField: "depends_on",
	ownsField: "owns",
	doneStatus: "done",
	activeStatus: "in_progress",
};

/** Both `board.yaml` and `.mfw/board.yaml` exist in one directory. */
export class AmbiguousBoardError extends Error {
	constructor(
		readonly dir: string,
		readonly candidates: string[],
	) {
		super(
			`ambiguous board in ${dir}: both ${candidates.join(" and ")} exist; remove one or pick with --config / MFW_BOARD`,
		);
		this.name = "AmbiguousBoardError";
	}
}

export interface BoardLocation {
	/** Absolute path of the `board.yaml` that was found. */
	configPath: string;
	/** Directory containing it: where locks/state live (`.mfw` for the nested layout). */
	root: string;
}

export interface DiscoverOptions {
	/** Explicit path to a `board.yaml` (`--config`); beats `env` and the search. */
	configPath?: string;
	/** Environment to read `MFW_BOARD` from (default: `process.env`). */
	env?: Record<string, string | undefined>;
}

function located(configPath: string): BoardLocation {
	const abs = resolve(configPath);
	return { configPath: abs, root: dirname(abs) };
}

/**
 * Finds the board gitignore-style: from `startDir` and each parent up to `/`,
 * check `board.yaml` then `.mfw/board.yaml`; the first directory with a hit
 * wins. `--config` beats `MFW_BOARD` beats the search. Returns null if there
 * is no board; throws `AmbiguousBoardError` on a both-present directory.
 */
export function discoverBoard(
	startDir: string = process.cwd(),
	opts: DiscoverOptions = {},
): BoardLocation | null {
	const explicit = opts.configPath ?? (opts.env ?? process.env).MFW_BOARD;
	if (explicit) {
		const loc = located(resolve(startDir, explicit));
		if (!existsSync(loc.configPath)) {
			const via = opts.configPath ? "--config" : "MFW_BOARD";
			throw new Error(`${via}: ${loc.configPath} does not exist`);
		}
		return loc;
	}
	let dir = resolve(startDir);
	for (;;) {
		const direct = join(dir, "board.yaml");
		const nested = join(dir, ".mfw", "board.yaml");
		const hasDirect = existsSync(direct);
		const hasNested = existsSync(nested);
		if (hasDirect && hasNested)
			throw new AmbiguousBoardError(dir, [direct, nested]);
		if (hasDirect) return located(direct);
		if (hasNested) return located(nested);
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/** The board root found from `startDir` (see `discoverBoard`), or null. */
export function findMfwRoot(startDir: string): string | null {
	return discoverBoard(startDir)?.root ?? null;
}

export interface MfwProject {
	/** The board root: the directory `board.yaml` lives in (`.mfw` for the nested layout). */
	root: string;
	/** Absolute path of the `board.yaml` in use. */
	configPath: string;
	config: BoardConfig;
	store: BoardStore;
	claim: ClaimConfig;
}

export async function openMfwProject(
	startDir: string = process.cwd(),
	opts: DiscoverOptions = {},
): Promise<MfwProject> {
	const loc = discoverBoard(startDir, opts);
	if (!loc) {
		throw new Error(
			`no board found: looked for board.yaml and .mfw/board.yaml in ${resolve(startDir)} and every parent up to / (override with --config <board.yaml> or MFW_BOARD)`,
		);
	}
	const config = await loadBoardConfig(loc.configPath);
	const store = new BoardStore(loc.root, config);
	return {
		root: loc.root,
		configPath: loc.configPath,
		config,
		store,
		claim: { root: loc.root, ...MFW_CLAIM_FIELDS, boardConfig: config },
	};
}
