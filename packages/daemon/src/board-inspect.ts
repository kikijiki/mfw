import { stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { type BoardConfig, BoardStore, loadBoardConfig } from "@mfw/board-core";
import { parseStatusMap } from "./board-status-map.ts";

/**
 * Read-only answer to "does this folder hold an mfw board, and what is in it",
 * so the add-project UI can say `existing board found: 760 tasks, ...` before
 * attaching. Nothing here writes: `BoardStore` is only ever asked for
 * `listDocuments` (a readdir + parse), never to create a document, a counter
 * or a lock — no `.board/` directory appears in the inspected folder.
 */

/** Where the `board.yaml` sits: at the folder itself, under the legacy `.mfw`, both, or neither. */
export type BoardLocation = "root" | "legacy-mfw" | "none" | "ambiguous";

export interface BoardTypeSummary {
	/** Type name from `board.yaml`, e.g. "task". */
	name: string;
	/** Directory declared by the type, relative to the board root. */
	dir: string;
	layout: "flat" | "directory";
	/** How many documents of this type load. */
	documents: number;
	/** "status" when the type has an enum field of that name, else null. */
	statusField: string | null;
	/** The enum values of the status field, declaration order ([] if none). */
	statuses: string[];
	/** Documents per status, keyed by every declared status (missing/absent status counts nowhere). */
	statusCounts: Record<string, number>;
}

export interface BoardInspection {
	/** The folder inspected (absolute, normalized). */
	path: string;
	exists: boolean;
	isGitRepo: boolean;
	location: BoardLocation;
	/** Absolute path of the `board.yaml` that would be used (the root one when both exist). */
	boardYaml: string | null;
	/** `board.yaml` parsed and validated by `@mfw/board-core`. */
	valid: boolean;
	/** Why not valid (config error message), else null. */
	error: string | null;
	/** Id key of the first own-sequence type, e.g. "POOT". */
	key: string | null;
	types: BoardTypeSummary[];
	/** The task type's status value -> the daemon role it reads as (board-status-map.ts), null with no task type or an unusable map. */
	statusRoles: Record<string, string> | null;
	/** Why the status map cannot work (the attach would refuse with this), else null. */
	statusMapError: string | null;
}

const isFile = (path: string): Promise<boolean> =>
	stat(path).then(
		(entry) => entry.isFile(),
		() => false,
	);

async function isRepositoryRoot(path: string): Promise<boolean> {
	return stat(join(path, ".git"))
		.then((entry) => entry.isDirectory() || entry.isFile())
		.catch(() => false);
}

/** The id key of the first type declaring its own sequence ("POOT"), or null. */
function ownSequenceKey(config: BoardConfig): string | null {
	for (const spec of Object.values(config.types)) {
		if (spec.id.strategy === "own-sequence") return spec.id.key;
	}
	return null;
}

async function summarizeTypes(
	boardDir: string,
	config: BoardConfig,
): Promise<BoardTypeSummary[]> {
	const store = new BoardStore(boardDir, config);
	return Promise.all(
		Object.entries(config.types).map(async ([name, spec]) => {
			const statusSpec = spec.fields.status;
			const statuses =
				statusSpec?.kind === "enum" ? [...statusSpec.values] : [];
			const statusCounts: Record<string, number> = {};
			for (const status of statuses) statusCounts[status] = 0;
			const documents = await store.listDocuments(name);
			if (statusSpec?.kind === "enum") {
				for (const doc of documents) {
					const value = doc.fields.status;
					if (typeof value === "string" && value in statusCounts) {
						statusCounts[value] = (statusCounts[value] ?? 0) + 1;
					}
				}
			}
			return {
				name,
				dir: spec.dir,
				layout: spec.layout,
				documents: documents.length,
				statusField: statusSpec?.kind === "enum" ? "status" : null,
				statuses,
				statusCounts,
			};
		}),
	);
}

function readStatusRoles(config: BoardConfig): {
	statusRoles: Record<string, string> | null;
	statusMapError: string | null;
} {
	const task = config.types.task;
	const status = task?.fields.status;
	if (!task || status?.kind !== "enum") {
		return { statusRoles: null, statusMapError: null };
	}
	try {
		const map = parseStatusMap(config.extensions, task);
		const roles: Record<string, string> = {};
		for (const value of status.values) roles[value] = map.toCanonical(value);
		return { statusRoles: roles, statusMapError: null };
	} catch (e) {
		return {
			statusRoles: null,
			statusMapError: e instanceof Error ? e.message : String(e),
		};
	}
}

/** Inspect `path` for an mfw board without touching it: never creates, writes
 * or locks anything, and a missing folder is reported, not thrown. */
export async function inspectBoardFolder(
	path: string,
): Promise<BoardInspection> {
	const folder = resolve(path);
	const info = await stat(folder).catch(() => null);
	const exists = info?.isDirectory() ?? false;
	const base = {
		path: folder,
		exists,
		isGitRepo: false,
		location: "none" as BoardLocation,
		boardYaml: null,
		valid: false,
		error: null,
		key: null,
		types: [] as BoardTypeSummary[],
		statusRoles: null as Record<string, string> | null,
		statusMapError: null as string | null,
	};
	if (!exists) return base;

	const isGitRepo = await isRepositoryRoot(folder);
	const rootYaml = join(folder, "board.yaml");
	const legacyYaml = join(folder, ".mfw", "board.yaml");
	const [atRoot, atLegacy] = await Promise.all([
		isFile(rootYaml),
		isFile(legacyYaml),
	]);
	const summary = {
		...base,
		exists: true,
		isGitRepo,
		location: (atRoot
			? atLegacy
				? "ambiguous"
				: "root"
			: atLegacy
				? "legacy-mfw"
				: "none") as BoardLocation,
		// Both present is `ambiguous`; the root file is the one a search finds first.
		boardYaml: atRoot ? rootYaml : atLegacy ? legacyYaml : null,
	};
	if (summary.boardYaml === null) return summary;

	let config: BoardConfig;
	try {
		config = await loadBoardConfig(summary.boardYaml);
	} catch (e) {
		return {
			...summary,
			error: e instanceof Error ? e.message : String(e),
		};
	}
	const { statusRoles, statusMapError } = readStatusRoles(config);
	return {
		...summary,
		valid: true,
		statusRoles,
		statusMapError,
		key: ownSequenceKey(config),
		types: await summarizeTypes(dirname(summary.boardYaml), config),
	};
}
