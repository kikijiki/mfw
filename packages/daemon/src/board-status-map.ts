import type { TypeSpec } from "@mfw/board-core";
import { TASK_STATUSES, type TaskStatus } from "@mfw/core/types";

/**
 * Status translation at the board boundary.
 *
 * The daemon's own eight statuses (`TaskStatus`) are what everything behind
 * the task index sees; a board whose `status` enum speaks another vocabulary
 * translates through a map the board itself declares in `board.yaml`:
 *
 * ```yaml
 * x-mfw-daemon:
 *   statusMap:              # mfw status role -> this board's status values
 *     ready: [planned]
 *     in_progress: [doing]
 *     done: [done]
 *     archived: [dropped, retired]
 * ```
 *
 * Reading a board value: every role listing it is a candidate; a role listing
 * it FIRST beats a role listing it later, and any remaining tie is broken by
 * {@link ROLE_PRIORITY}. `planned` listed first under both `ready` and
 * `backlog` therefore reads as `ready`, which is what lets the scheduler
 * dispatch it.
 *
 * Writing a role: the FIRST value of its list. An omitted (or empty) role has
 * no board equivalent and cannot be written.
 *
 * No map at all is the identity map — legal only while every board status
 * value already is one of the eight, checked when the map is parsed, so a
 * board that needs a map fails at attach with the map to add instead of at
 * the first status write.
 */

/** The key the map is declared under, and the entry inside it. */
const EXTENSION_KEY = "x-mfw-daemon";
const MAP_KEY = "statusMap";

/**
 * Fixed tie-break among roles claiming the same board value (after "listed it
 * first"). `ready` first, so a shared value still dispatches.
 */
export const ROLE_PRIORITY: readonly TaskStatus[] = [
	"ready",
	"in_progress",
	"review",
	"blocked",
	"done",
	"backlog",
	"draft",
	"archived",
];

export class StatusMapError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "StatusMapError";
	}
}

export interface StatusMap {
	/** The daemon's status a value on the board reads as. */
	toCanonical(boardValue: string): TaskStatus;
	/** The board's status value a daemon status writes. */
	toBoard(role: TaskStatus): string;
}

const isRole = (value: string): value is TaskStatus =>
	(TASK_STATUSES as readonly string[]).includes(value);

const list = (values: readonly string[]): string =>
	values.map((v) => `'${v}'`).join(", ");

/** The map to paste into `board.yaml`, one line per role to fill in. */
function mapToAdd(): string {
	return [
		"x-mfw-daemon:",
		`  ${MAP_KEY}:`,
		...ROLE_PRIORITY.map(
			(role) => `    ${role}: [<this board's status for ${role}>]`,
		),
	].join("\n");
}

function unmapped(values: readonly string[]): StatusMapError {
	return new StatusMapError(
		`board.yaml: task ${values.length > 1 ? "statuses" : "status"} ${list(values)} ` +
			`are not mfw statuses, and board.yaml declares no ${EXTENSION_KEY}.${MAP_KEY} ` +
			"to translate them. Add one:\n\n" +
			mapToAdd(),
	);
}

/** Identity translation: every board status value already is an mfw status. */
function identityMap(boardValues: readonly string[]): StatusMap {
	const foreign = boardValues.filter((v) => !isRole(v));
	if (foreign.length > 0) throw unmapped(foreign);
	return {
		toCanonical(boardValue) {
			if (!isRole(boardValue)) throw unmapped([boardValue]);
			return boardValue;
		},
		toBoard(role) {
			return role;
		},
	};
}

function declaredMap(
	roles: Partial<Record<TaskStatus, readonly string[]>>,
): StatusMap {
	return {
		toCanonical(boardValue) {
			const candidates = ROLE_PRIORITY.filter((role) =>
				roles[role]?.includes(boardValue),
			);
			const firsts = candidates.filter(
				(role) => (roles[role] as readonly string[])[0] === boardValue,
			);
			const pool = firsts.length > 0 ? firsts : candidates;
			if (pool.length === 0) {
				throw new StatusMapError(
					`board status '${boardValue}' has no entry in ` +
						`${EXTENSION_KEY}.${MAP_KEY}; add it to one of the role lists`,
				);
			}
			return pool[0] as TaskStatus;
		},
		toBoard(role) {
			const values = roles[role];
			if (!values || values.length === 0) {
				throw new StatusMapError(
					`cannot set a task's status to '${role}': ${EXTENSION_KEY}.${MAP_KEY} ` +
						`declares no board status for the '${role}' role. Add ` +
						`'${role}: [<this board's status for ${role}>]' under ` +
						`${EXTENSION_KEY}.${MAP_KEY} in board.yaml.`,
				);
			}
			return values[0] as string;
		},
	};
}

/**
 * Parse a board's status translation out of `board.yaml`'s extensions,
 * validating it against the task type's own `status` enum. Throws
 * {@link StatusMapError} on a map that cannot work; with no map, on a board
 * whose statuses are not mfw statuses.
 */
export function parseStatusMap(
	extensions: Record<string, unknown> | undefined,
	taskType: TypeSpec,
): StatusMap {
	const status = taskType.fields.status;
	if (status?.kind !== "enum" || status.list) {
		throw new StatusMapError(
			"the task type needs a single-valued enum 'status' field to translate against",
		);
	}
	const boardValues = status.values;

	const extension = extensions?.[EXTENSION_KEY];
	if (extension === undefined) return identityMap(boardValues);
	if (
		typeof extension !== "object" ||
		extension === null ||
		Array.isArray(extension)
	) {
		throw new StatusMapError(`${EXTENSION_KEY} must be a mapping`);
	}
	const raw = (extension as Record<string, unknown>)[MAP_KEY];
	if (raw === undefined) return identityMap(boardValues);
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new StatusMapError(`${EXTENSION_KEY}.${MAP_KEY} must be a mapping`);
	}

	const roles: Partial<Record<TaskStatus, readonly string[]>> = {};
	for (const [role, values] of Object.entries(raw)) {
		if (!isRole(role)) {
			throw new StatusMapError(
				`${EXTENSION_KEY}.${MAP_KEY}: '${role}' is not an mfw status ` +
					`(one of ${TASK_STATUSES.join(", ")})`,
			);
		}
		if (!Array.isArray(values) || values.some((v) => typeof v !== "string")) {
			throw new StatusMapError(
				`${EXTENSION_KEY}.${MAP_KEY}.${role}: must be a list of this board's status values`,
			);
		}
		for (const value of values) {
			if (!boardValues.includes(value as string)) {
				throw new StatusMapError(
					`${EXTENSION_KEY}.${MAP_KEY}.${role}: '${value}' is not a value of the ` +
						`task type's 'status' field (one of ${list(boardValues)})`,
				);
			}
		}
		roles[role] = values as string[];
	}
	return declaredMap(roles);
}
