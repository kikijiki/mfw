import { join } from "node:path";
import { type BoardConfig, loadBoardConfig } from "@mfw/board-core";
import { TASK_STATUSES, type TaskStatus } from "@mfw/core/types";
import { parseStatusMap, type StatusMap } from "./board-status-map.ts";

/**
 * The board's own vocabulary, shaped for the UI: its statuses in declared
 * order with the daemon role each one reads as, the hierarchy rule's kind
 * field, the task types and the file layout. Pure: built from a loaded
 * `BoardConfig`, so the API layer only has to hand it the config.
 */

export interface BoardSchemaStatus {
	/** The board's value, e.g. "doing". */
	value: string;
	/** Display text; the value with `_`/`-` as spaces, capitalised. */
	label: string;
	/** The daemon role the value reads as; null when the map cannot place it. */
	role: TaskStatus | null;
	/** A write of `role` produces exactly this value (it is the role's first entry). */
	writable: boolean;
	/** Work in this status is finished or shelved for good. */
	terminal: boolean;
	/** Position in the board's declared order. */
	order: number;
}

export interface BoardSchemaType {
	value: string;
	label: string;
}

export interface BoardSchema {
	statuses: BoardSchemaStatus[];
	types: BoardSchemaType[];
	/** Null when the board declares no `hierarchy`. */
	hierarchy: {
		/** Null when the board declares no depth limit. */
		maxDepth: number | null;
		/** The task field the hierarchy rules branch on (poot: "kind"). */
		kindField?: string;
		/** Every value of that field a rule mentions, first-seen order. */
		kinds?: string[];
	} | null;
	layout: "flat" | "directory";
}

const label = (value: string): string => {
	const spaced = value.replace(/[_-]+/g, " ").trim();
	return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

const TERMINAL_ROLES: readonly TaskStatus[] = ["done", "archived"];

function hierarchyOf(config: BoardConfig): BoardSchema["hierarchy"] {
	const h = config.hierarchy;
	if (!h) return null;
	// The field the rules discriminate on: the first `where` key found. A board
	// using several kind fields reports the first.
	const kinds = new Map<string, string[]>();
	for (const rule of h.rules ?? []) {
		for (const sel of [rule.child, ...rule.parents]) {
			for (const [field, values] of Object.entries(sel.where ?? {})) {
				const seen = kinds.get(field) ?? [];
				for (const v of values) if (!seen.includes(v)) seen.push(v);
				kinds.set(field, seen);
			}
		}
	}
	const first = [...kinds.entries()][0];
	return {
		maxDepth: h.maxDepth ?? null,
		...(first ? { kindField: first[0], kinds: first[1] } : {}),
	};
}

/** Read `<boardDir>/board.yaml` and describe it. Read per call: the file is the truth and may have been edited. */
export async function loadBoardSchema(boardDir: string): Promise<BoardSchema> {
	return buildBoardSchema(await loadBoardConfig(join(boardDir, "board.yaml")));
}

export function buildBoardSchema(config: BoardConfig): BoardSchema {
	const task = config.types.task;
	const statusSpec = task?.fields.status;
	const values =
		statusSpec?.kind === "enum" ? [...statusSpec.values] : [...TASK_STATUSES];

	let map: StatusMap | null = null;
	if (task) {
		try {
			map = parseStatusMap(config.extensions, task);
		} catch {
			// An unmappable board still renders; its statuses just carry no role.
		}
	} else {
		map = { toCanonical: (v) => v as TaskStatus, toBoard: (r) => r };
	}
	const written = (role: TaskStatus): string | null => {
		try {
			return map ? map.toBoard(role) : null;
		} catch {
			return null;
		}
	};
	const terminalClass = new Set(task?.workflow?.classes.terminal ?? []);

	const statuses = values.map((value, order): BoardSchemaStatus => {
		let role: TaskStatus | null = null;
		try {
			role = map ? map.toCanonical(value) : null;
		} catch {
			role = null;
		}
		return {
			value,
			label: label(value),
			role,
			writable: role !== null && written(role) === value,
			terminal:
				terminalClass.has(value) ||
				(role !== null && TERMINAL_ROLES.includes(role)),
			order,
		};
	});

	const typeSpec = task?.fields.type;
	const types =
		typeSpec?.kind === "enum"
			? typeSpec.values.map((value) => ({ value, label: label(value) }))
			: [];

	return {
		statuses,
		types,
		hierarchy: hierarchyOf(config),
		layout: task?.layout ?? "directory",
	};
}
