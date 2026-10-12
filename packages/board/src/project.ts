import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	type BoardConfig,
	BoardStore,
	type BoardStoreOptions,
	loadBoardConfig,
} from "@mfw/board-core";
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

export interface BoardLocation {
	/** Absolute path of the `board.yaml` that was found. */
	configPath: string;
	/** Directory containing it: the board folder, where locks/state live. */
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
 * look for `board.yaml` at the directory's root; the first directory with a
 * hit wins. `--config` beats `MFW_BOARD` beats the search. Returns null if
 * there is no board. A board from the `.mfw/` era is not searched for: the
 * daemon moves it out of `.mfw/` when it attaches the project (see
 * `legacyBoardNear`, used only to say so).
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
		if (existsSync(direct)) return located(direct);
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/** A `.mfw/board.yaml` (the layout before the board moved to its folder's
 * root) in `startDir` or a parent, to name in the "no board" error. */
export function legacyBoardNear(startDir: string): string | null {
	let dir = resolve(startDir);
	for (;;) {
		const nested = join(dir, ".mfw", "board.yaml");
		if (existsSync(nested)) return nested;
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
	/** The board root: the directory `board.yaml` lives in. */
	root: string;
	/** Absolute path of the `board.yaml` in use. */
	configPath: string;
	config: BoardConfig;
	store: BoardStore;
	claim: ClaimConfig;
}

export async function openMfwProject(
	startDir: string = process.cwd(),
	opts: DiscoverOptions & BoardStoreOptions = {},
): Promise<MfwProject> {
	const loc = discoverBoard(startDir, opts);
	if (!loc) {
		const legacy = legacyBoardNear(startDir);
		throw new Error(
			`no board found: looked for board.yaml in ${resolve(startDir)} and every parent up to / (override with --config <board.yaml> or MFW_BOARD)` +
				(legacy
					? `; ${legacy} is a board from the .mfw/ layout, attach its project in mfw (it moves the board out of .mfw) or point --config at it`
					: ""),
		);
	}
	const config = await loadBoardConfig(loc.configPath);
	const store = new BoardStore(loc.root, config, {
		...(opts.overrideRules ? { overrideRules: opts.overrideRules } : {}),
		...(opts.onOverride ? { onOverride: opts.onOverride } : {}),
	});
	return {
		root: loc.root,
		configPath: loc.configPath,
		config,
		store,
		claim: { root: loc.root, ...MFW_CLAIM_FIELDS, boardConfig: config },
	};
}
