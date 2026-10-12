import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import {
	type BoardConfig,
	BoardStore,
	loadBoardConfig,
	parseBoardConfig,
	writeFileAtomic,
} from "@mfw/board-core";
import { TASK_STATUSES, type TaskStatus } from "@mfw/core/types";
import { isMap, isScalar, isSeq, parse, parseDocument } from "yaml";
import { buildBoardSchema } from "./board-schema.ts";
import { parseStatusMap } from "./board-status-map.ts";
import { getBoardTemplate } from "./board-templates.ts";
import { git } from "./git.ts";

/**
 * Structured edits of a board's own configuration (`board.yaml`): the task
 * status list, which daemon role each status plays (`x-mfw-daemon.statusMap`),
 * the task `type` values and the hierarchy depth limit.
 *
 * The file is edited through the `yaml` Document API, so comments, key order
 * and everything this module does not own (fields, per-type rules, hierarchy
 * rules, other `x-` extensions) survive byte for byte where the edit does not
 * touch them. Every result is validated with board-core's strict parser and
 * the daemon's own status-map parser BEFORE anything is written, and an edit
 * that would leave existing tasks on a status the board no longer has is
 * refused (naming the tasks) unless `remapTo` says where they go.
 */

const EXTENSION_KEY = "x-mfw-daemon";
const MAP_KEY = "statusMap";
/** Order roles are written in, matching the board templates. */
const ROLE_ORDER: readonly TaskStatus[] = [
	"draft",
	"backlog",
	"ready",
	"in_progress",
	"blocked",
	"review",
	"done",
	"archived",
];
const STATUS_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

export interface BoardStatusEdit {
	value: string;
	role: TaskStatus;
}

export interface BoardConfigPatch {
	/** The complete ordered status list of the task type. */
	statuses?: BoardStatusEdit[];
	/** The complete list of the task `type` field's values. */
	types?: string[];
	/** The hierarchy depth limit; `null` removes it. Needs a declared hierarchy. */
	maxDepth?: number | null;
	/** The status a new task starts in; defaulted when the old one is removed. */
	defaultStatus?: string;
	/** Removed status -> a status that stays; its tasks are rewritten to it. */
	remapTo?: Record<string, string>;
	/**
	 * Old status -> new name: a rename. The new name takes the old one's place
	 * in the workflow (classes, transitions, default) and its tasks follow.
	 */
	renames?: Record<string, string>;
}

export interface BoardConfigView {
	/** Absolute path of `board.yaml`. */
	path: string;
	/** The file's current text. */
	yaml: string;
	statuses: { value: string; role: TaskStatus | null; tasks: number }[];
	/** The task `type` field's values; null when the board has no such enum. */
	taskTypes: string[] | null;
	defaultStatus: string | null;
	hierarchy: {
		maxDepth: number | null;
		ruleCount: number;
		kindField: string | null;
		kinds: string[];
	} | null;
	layout: "flat" | "directory";
	/** Why the board cannot be edited structurally, or null. */
	unsupported: string | null;
}

export interface BoardOrphan {
	status: string;
	ids: string[];
}

export interface BoardConfigDiffLine {
	op: "+" | "-" | " ";
	text: string;
}

export interface BoardConfigPlan {
	ok: true;
	/** The rewritten `board.yaml` text. */
	yaml: string;
	/** Changed lines with two lines of context; empty when nothing changes. */
	diff: BoardConfigDiffLine[];
	changed: boolean;
	/** Tasks that get a new status: removed status -> target. */
	remaps: { id: string; from: string; to: string }[];
	/** Things the edit drops or that leave the board unable to do something. */
	warnings: string[];
}

export interface BoardConfigRefusal {
	ok: false;
	errors: string[];
	/** Present when tasks would be orphaned. */
	orphans?: BoardOrphan[];
}

export type BoardConfigPlanResult = BoardConfigPlan | BoardConfigRefusal;

export type BoardConfigApplyResult =
	| (BoardConfigPlan & {
			path: string;
			/** The board commit's sha, or null (not versioned, off-branch, nothing to record). */
			committed: string | null;
	  })
	| BoardConfigRefusal;

export interface BoardEditOptions {
	/** The daemon's state directory (`<repo>/.mfw`): where the store keeps its locks and counters. */
	stateDir?: string;
	/** Commit only when HEAD of the board's repository is this branch. */
	integrationBranch?: string;
	/** Apply only: record the change in git (path-scoped). Default true. */
	commit?: boolean;
}

const boardYamlPath = (boardDir: string) => join(boardDir, "board.yaml");

const asStrings = (input: unknown): string[] | null => {
	const v = isSeq(input) ? input.toJSON() : input;
	return Array.isArray(v) && v.every((x) => typeof x === "string")
		? (v as string[])
		: null;
};

async function listTasks(
	boardDir: string,
	config: BoardConfig,
	opts: BoardEditOptions,
): Promise<{ id: string; status: string; path: string }[]> {
	if (!config.types.task) return [];
	const store = new BoardStore(boardDir, config, {
		...(opts.stateDir ? { stateDir: join(opts.stateDir, ".board") } : {}),
	});
	const docs = await store.listDocuments("task");
	return docs.map((d) => ({
		id: d.id,
		status: String(d.fields.status),
		path: d.path,
	}));
}

/** The editable view of a board: the text plus the parts this module edits. */
export async function readBoardConfig(
	boardDir: string,
	opts: BoardEditOptions = {},
): Promise<BoardConfigView> {
	const path = boardYamlPath(boardDir);
	const yaml = await readFile(path, "utf8");
	const config = await loadBoardConfig(path);
	const schema = buildBoardSchema(config);
	const task = config.types.task;
	const counts = new Map<string, number>();
	for (const t of await listTasks(boardDir, config, opts)) {
		counts.set(t.status, (counts.get(t.status) ?? 0) + 1);
	}
	const typeSpec = task?.fields.type;
	const statusSpec = task?.fields.status;
	const unsupported = !task
		? "the board declares no 'task' type"
		: statusSpec?.kind !== "enum" || statusSpec.list
			? "the task type has no single-valued enum 'status' field"
			: null;
	const defaultStatus =
		statusSpec?.kind === "enum" && typeof statusSpec.default === "string"
			? statusSpec.default
			: null;
	return {
		path,
		yaml,
		statuses: schema.statuses.map((s) => ({
			value: s.value,
			role: s.role,
			tasks: counts.get(s.value) ?? 0,
		})),
		taskTypes: typeSpec?.kind === "enum" ? [...typeSpec.values] : null,
		defaultStatus,
		hierarchy: config.hierarchy
			? {
					maxDepth: config.hierarchy.maxDepth ?? null,
					ruleCount: config.hierarchy.rules?.length ?? 0,
					kindField: schema.hierarchy?.kindField ?? null,
					kinds: schema.hierarchy?.kinds ?? [],
				}
			: null,
		layout: schema.layout,
		unsupported,
	};
}

/** A template's statuses, roles and type values as a patch for an existing board. */
export function patchFromTemplate(templateId: string): BoardConfigPatch | null {
	const template = getBoardTemplate(templateId);
	if (!template) return null;
	const raw = parse(template.yaml("TPL")) as Record<string, unknown>;
	const types = raw.types as Record<
		string,
		{ fields?: Record<string, { values?: unknown; default?: unknown }> }
	>;
	const fields = types.task?.fields ?? {};
	const statusValues = asStrings(fields.status?.values) ?? template.statuses;
	const map = (raw[EXTENSION_KEY] as Record<string, unknown> | undefined)?.[
		MAP_KEY
	] as Record<string, string[]> | undefined;
	const roleOf = new Map<string, TaskStatus>();
	for (const role of ROLE_ORDER) {
		for (const v of map?.[role] ?? []) {
			if (!roleOf.has(v)) roleOf.set(v, role);
		}
	}
	return {
		statuses: statusValues.map((value) => ({
			value,
			role: roleOf.get(value) ?? "backlog",
		})),
		...(asStrings(fields.type?.values)
			? { types: asStrings(fields.type?.values) as string[] }
			: {}),
		...(typeof fields.status?.default === "string"
			? { defaultStatus: fields.status.default as string }
			: {}),
	};
}

/** Line diff with two lines of context (LCS; board files are small). */
export function diffLines(
	before: string,
	after: string,
): BoardConfigDiffLine[] {
	if (before === after) return [];
	const a = before.split("\n");
	const b = after.split("\n");
	const n = a.length;
	const m = b.length;
	const lcs: number[][] = Array.from({ length: n + 1 }, () =>
		new Array<number>(m + 1).fill(0),
	);
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			(lcs[i] as number[])[j] =
				a[i] === b[j]
					? ((lcs[i + 1] as number[])[j + 1] as number) + 1
					: Math.max(
							(lcs[i + 1] as number[])[j] as number,
							(lcs[i] as number[])[j + 1] as number,
						);
		}
	}
	const all: BoardConfigDiffLine[] = [];
	let i = 0;
	let j = 0;
	while (i < n || j < m) {
		if (i < n && j < m && a[i] === b[j]) {
			all.push({ op: " ", text: a[i] as string });
			i++;
			j++;
		} else if (
			j >= m ||
			(i < n &&
				((lcs[i + 1] as number[])[j] as number) >=
					((lcs[i] as number[])[j + 1] as number))
		) {
			all.push({ op: "-", text: a[i] as string });
			i++;
		} else {
			all.push({ op: "+", text: b[j] as string });
			j++;
		}
	}
	const keep = new Array<boolean>(all.length).fill(false);
	all.forEach((l, idx) => {
		if (l.op === " ") return;
		for (
			let k = Math.max(0, idx - 2);
			k <= Math.min(all.length - 1, idx + 2);
			k++
		) {
			keep[k] = true;
		}
	});
	return all.filter((_, idx) => keep[idx]);
}

// ---------------------------------------------------------------------------

function fail(...errors: string[]): BoardConfigRefusal {
	return { ok: false, errors };
}

/** Reject structurally bad patches before touching the document. */
function checkPatch(patch: BoardConfigPatch): string[] {
	const errors: string[] = [];
	if (patch.statuses) {
		if (patch.statuses.length === 0)
			errors.push("a board needs at least one status");
		const seen = new Set<string>();
		for (const s of patch.statuses) {
			if (!STATUS_NAME_RE.test(s.value)) {
				errors.push(
					`status '${s.value}': use letters, digits, '_' or '-', starting with a letter`,
				);
			}
			if (seen.has(s.value)) errors.push(`status '${s.value}' is listed twice`);
			seen.add(s.value);
			if (!(TASK_STATUSES as readonly string[]).includes(s.role)) {
				errors.push(`status '${s.value}': '${s.role}' is not a daemon role`);
			}
		}
	}
	if (patch.types) {
		if (patch.types.length === 0)
			errors.push("a board needs at least one task type");
		const seen = new Set<string>();
		for (const t of patch.types) {
			if (!t.trim()) errors.push("a task type cannot be empty");
			if (seen.has(t)) errors.push(`task type '${t}' is listed twice`);
			seen.add(t);
		}
	}
	if (
		patch.maxDepth !== undefined &&
		patch.maxDepth !== null &&
		(!Number.isInteger(patch.maxDepth) || patch.maxDepth < 1)
	) {
		errors.push("maxDepth must be a positive whole number");
	}
	return errors;
}

type ClassName = "terminal" | "live" | "parked" | "queued";

/**
 * Compute the edited `board.yaml` for `patch` without writing anything.
 * Validates with board-core's strict parser and the daemon's status-map parser,
 * and refuses to orphan existing tasks.
 */
export async function planBoardConfigEdit(
	boardDir: string,
	patch: BoardConfigPatch,
	opts: BoardEditOptions = {},
): Promise<BoardConfigPlanResult> {
	const path = boardYamlPath(boardDir);
	let before: string;
	let current: BoardConfig;
	try {
		before = await readFile(path, "utf8");
		current = await loadBoardConfig(path);
	} catch (e) {
		return fail((e as Error).message);
	}
	const problems = checkPatch(patch);
	if (problems.length > 0) return fail(...problems);

	const task = current.types.task;
	const oldStatus = task?.fields.status;
	if (!task || oldStatus?.kind !== "enum" || oldStatus.list) {
		return fail(
			"this board has no single-valued enum 'status' on its 'task' type, so its statuses cannot be edited here",
		);
	}
	const oldValues = [...oldStatus.values];
	const warnings: string[] = [];

	const doc = parseDocument(before);
	if (doc.errors.length > 0) {
		return fail(...doc.errors.map((e) => e.message));
	}
	const statusPath = ["types", "task", "fields", "status"];

	// ---- statuses -----------------------------------------------------------
	const newValues = patch.statuses?.map((s) => s.value) ?? oldValues;
	const removed = oldValues.filter((v) => !newValues.includes(v));
	const added = newValues.filter((v) => !oldValues.includes(v));

	const renames = patch.renames ?? {};
	for (const [from, to] of Object.entries(renames)) {
		if (!removed.includes(from)) {
			return fail(`renames: '${from}' is still a status of the edited board`);
		}
		if (oldValues.includes(to) || !newValues.includes(to)) {
			return fail(`renames: '${to}' (for '${from}') must be a new status`);
		}
	}
	const remapTo: Record<string, string> = { ...patch.remapTo, ...renames };
	for (const [from, to] of Object.entries(remapTo)) {
		if (!removed.includes(from)) {
			return fail(`remapTo: '${from}' is not a status this edit removes`);
		}
		if (!newValues.includes(to)) {
			return fail(
				`remapTo: '${to}' (for '${from}') is not a status of the edited board`,
			);
		}
	}

	const tasks = await listTasks(boardDir, current, opts);
	const orphans: BoardOrphan[] = removed
		.filter((status) => !(status in remapTo))
		.map((status) => ({
			status,
			ids: tasks.filter((t) => t.status === status).map((t) => t.id),
		}))
		.filter((o) => o.ids.length > 0);
	if (orphans.length > 0) {
		return {
			ok: false,
			errors: orphans.map(
				(o) =>
					`status '${o.status}' is still used by ${o.ids.length} task${o.ids.length === 1 ? "" : "s"} ` +
					`(${o.ids.slice(0, 8).join(", ")}${o.ids.length > 8 ? ", ..." : ""}); ` +
					"move them first or choose a status to remap them to",
			),
			orphans,
		};
	}
	const remaps = tasks
		.filter((t) => t.status in remapTo)
		.map((t) => ({
			id: t.id,
			from: t.status,
			to: remapTo[t.status] as string,
		}));

	const statusNode = doc.getIn(statusPath, true);
	if (!isMap(statusNode)) {
		return fail("types.task.fields.status is not a mapping with 'values'");
	}
	if (patch.statuses) {
		const oldSeq = doc.getIn([...statusPath, "values"], true);
		const seq = doc.createNode(newValues);
		seq.flow = isSeq(oldSeq) ? (oldSeq.flow ?? true) : true;
		doc.setIn([...statusPath, "values"], seq);

		// Default status: keep it while it exists; else the explicit one; else
		// the first backlog/ready/draft status; else the first status.
		const oldDefault = oldStatus.default;
		let next: string | undefined = patch.defaultStatus;
		if (next === undefined) {
			if (typeof oldDefault === "string" && oldDefault in renames) {
				next = renames[oldDefault];
			} else if (
				typeof oldDefault === "string" &&
				newValues.includes(oldDefault)
			) {
				next = oldDefault;
			} else if (oldDefault !== undefined || removed.length > 0) {
				const byRole = (role: TaskStatus) =>
					patch.statuses?.find((s) => s.role === role)?.value;
				next =
					byRole("backlog") ??
					byRole("ready") ??
					byRole("draft") ??
					newValues[0];
			}
		}
		if (next !== undefined) {
			if (!newValues.includes(next)) {
				return fail(`defaultStatus '${next}' is not one of the statuses`);
			}
			if (oldDefault !== next) doc.setIn([...statusPath, "default"], next);
		}

		// statusMap: one flow list per role, in template order.
		for (const role of ROLE_ORDER) {
			const values = patch.statuses
				.filter((s) => s.role === role)
				.map((s) => s.value);
			const node = doc.createNode(values);
			node.flow = true;
			doc.setIn([EXTENSION_KEY, MAP_KEY, role], node);
		}
		for (const role of ["ready", "in_progress", "done"] as const) {
			if (!patch.statuses.some((s) => s.role === role)) {
				warnings.push(
					role === "ready"
						? "no status plays the 'ready' role: the scheduler has nothing to dispatch"
						: role === "in_progress"
							? "no status plays the 'in_progress' role: runs cannot start tasks"
							: "no status plays the 'done' role: tasks cannot finish",
				);
			}
		}
	} else if (patch.defaultStatus !== undefined) {
		if (!oldValues.includes(patch.defaultStatus)) {
			return fail(
				`defaultStatus '${patch.defaultStatus}' is not one of the statuses`,
			);
		}
		doc.setIn([...statusPath, "default"], patch.defaultStatus);
	}

	// ---- workflow: keep statuses a type's classes and transitions mention ----
	if (patch.statuses && (removed.length > 0 || added.length > 0)) {
		const wfPath = ["types", "task"];
		const classes = doc.getIn([...wfPath, "statusClasses"], true);
		if (isMap(classes)) {
			const names: ClassName[] = ["terminal", "live", "parked", "queued"];
			for (const name of names) {
				const list = asStrings(doc.getIn([...wfPath, "statusClasses", name]));
				if (!list) continue;
				// A renamed status keeps its place; a removed one leaves its
				// class (a remap target keeps its own).
				const out = list
					.map((v) => renames[v] ?? v)
					.filter((v) => !removed.includes(v));
				if (JSON.stringify(out) !== JSON.stringify(list)) {
					const node = doc.createNode(out);
					node.flow = true;
					doc.setIn([...wfPath, "statusClasses", name], node);
				}
			}
			// New statuses join the class their role implies.
			for (const s of patch.statuses) {
				if (!added.includes(s.value)) continue;
				const target: ClassName[] =
					s.role === "done" || s.role === "archived"
						? ["terminal"]
						: s.role === "ready"
							? ["live", "queued"]
							: ["live"];
				for (const name of target) {
					const list = asStrings(doc.getIn([...wfPath, "statusClasses", name]));
					if (!list || list.includes(s.value)) continue;
					const node = doc.createNode([...list, s.value]);
					node.flow = true;
					doc.setIn([...wfPath, "statusClasses", name], node);
				}
			}
		}
		const transitions = doc.getIn([...wfPath, "transitions"], true);
		if (isMap(transitions)) {
			for (const pair of [...transitions.items]) {
				const verb = isScalar(pair.key) ? String(pair.key.value) : null;
				if (!verb) continue;
				const from = asStrings(
					doc.getIn([...wfPath, "transitions", verb, "from"]),
				);
				const to = doc.getIn([...wfPath, "transitions", verb, "to"]);
				if (!from || typeof to !== "string") continue;
				// A transition INTO a removed status has no meaning on the
				// target (its tasks were not "moved there" by that verb): drop it.
				const nextTo = renames[to] ?? (removed.includes(to) ? undefined : to);
				const nextFrom: string[] = [];
				for (const v of from) {
					const n = removed.includes(v) ? remapTo[v] : v;
					if (n !== undefined && !nextFrom.includes(n)) nextFrom.push(n);
				}
				const touchedByRemoval = from.some((v) => removed.includes(v));
				if (
					nextTo === undefined ||
					nextFrom.length === 0 ||
					(touchedByRemoval && nextFrom.every((v) => v === nextTo))
				) {
					doc.deleteIn([...wfPath, "transitions", verb]);
					warnings.push(
						`transition '${verb}' was removed: it depended on a removed status`,
					);
					continue;
				}
				if (nextTo !== to) {
					doc.setIn([...wfPath, "transitions", verb, "to"], nextTo);
				}
				if (JSON.stringify(nextFrom) !== JSON.stringify(from)) {
					const node = doc.createNode(nextFrom);
					node.flow = true;
					doc.setIn([...wfPath, "transitions", verb, "from"], node);
				}
			}
		}
	}

	// ---- task types ---------------------------------------------------------
	if (patch.types) {
		const typeSpec = task.fields.type;
		if (typeSpec?.kind !== "enum" || typeSpec.list) {
			return fail(
				"the task type has no single-valued enum 'type' field to edit",
			);
		}
		const tPath = ["types", "task", "fields", "type"];
		const oldSeq = doc.getIn([...tPath, "values"], true);
		const seq = doc.createNode(patch.types);
		seq.flow = isSeq(oldSeq) ? (oldSeq.flow ?? true) : true;
		doc.setIn([...tPath, "values"], seq);
		const removedTypes = typeSpec.values.filter(
			(v) => !patch.types?.includes(v),
		);
		if (removedTypes.length > 0) {
			const used = (
				await listTasksByField(boardDir, current, "type", opts)
			).filter((t) => removedTypes.includes(t.value));
			if (used.length > 0) {
				return fail(
					...removedTypes
						.map((r) => ({
							r,
							ids: used.filter((u) => u.value === r).map((u) => u.id),
						}))
						.filter((x) => x.ids.length > 0)
						.map(
							(x) =>
								`task type '${x.r}' is still used by ${x.ids.length} task${x.ids.length === 1 ? "" : "s"} (${x.ids.slice(0, 8).join(", ")}); change those tasks first`,
						),
				);
			}
		}
		const oldTypeDefault = typeSpec.default;
		if (
			typeof oldTypeDefault === "string" &&
			!patch.types.includes(oldTypeDefault)
		) {
			doc.setIn([...tPath, "default"], patch.types[0]);
		}
	}

	// ---- hierarchy ----------------------------------------------------------
	if (patch.maxDepth !== undefined) {
		if (!current.hierarchy) {
			return fail(
				"the board declares no hierarchy, so there is no depth limit to set",
			);
		}
		if (patch.maxDepth === null) doc.deleteIn(["hierarchy", "maxDepth"]);
		else doc.setIn(["hierarchy", "maxDepth"], patch.maxDepth);
	}

	// ---- validate before anything is written -------------------------------
	const after = doc.toString();
	const checked = validateBoardYaml(after);
	if (!checked.ok) return checked;
	// A new status vocabulary the surviving tasks must still fit.
	if (after !== before) {
		const finalConfig = checked.config;
		const finalStatus = finalConfig.types.task?.fields.status;
		if (finalStatus?.kind === "enum") {
			const stranded = tasks.filter(
				(t) => !finalStatus.values.includes(remapTo[t.status] ?? t.status),
			);
			if (stranded.length > 0) {
				return fail(
					`tasks would be left on unknown statuses: ${stranded
						.slice(0, 8)
						.map((t) => t.id)
						.join(", ")}`,
				);
			}
		}
	}
	return {
		ok: true,
		yaml: after,
		diff: diffLines(before, after),
		changed: after !== before,
		remaps,
		warnings,
	};
}

async function listTasksByField(
	boardDir: string,
	config: BoardConfig,
	field: string,
	opts: BoardEditOptions,
): Promise<{ id: string; value: string }[]> {
	const store = new BoardStore(boardDir, config, {
		...(opts.stateDir ? { stateDir: join(opts.stateDir, ".board") } : {}),
	});
	const docs = await store.listDocuments("task");
	return docs.map((d) => ({ id: d.id, value: String(d.fields[field]) }));
}

/** board-core's strict parser, then the daemon's status-map parser, never throwing. */
export function validateBoardYaml(
	text: string,
): { ok: true; config: BoardConfig } | BoardConfigRefusal {
	let config: BoardConfig;
	try {
		const raw = parse(text);
		config = parseBoardConfig(raw);
	} catch (e) {
		return fail((e as Error).message);
	}
	const task = config.types.task;
	if (task) {
		try {
			parseStatusMap(config.extensions, task);
		} catch (e) {
			return fail((e as Error).message);
		}
	}
	return { ok: true, config };
}

// ---------------------------------------------------------------------------

/**
 * Apply `patch`: remap tasks off removed statuses, write `board.yaml`
 * atomically and commit exactly the touched files. The order keeps the board
 * valid at every step: first a `board.yaml` that still lists the removed
 * statuses, then the task rewrites, then the final file.
 */
export async function applyBoardConfigEdit(
	boardDir: string,
	patch: BoardConfigPatch,
	opts: BoardEditOptions = {},
): Promise<BoardConfigApplyResult> {
	const plan = await planBoardConfigEdit(boardDir, patch, opts);
	if (!plan.ok) return plan;
	const path = boardYamlPath(boardDir);
	if (!plan.changed) return { ...plan, path, committed: null };

	const touched = new Set<string>([path]);
	if (plan.remaps.length > 0) {
		// Transitional board: the final file's statuses plus the removed ones.
		const removed = [...new Set(plan.remaps.map((r) => r.from))];
		const transitional = parseDocument(plan.yaml);
		const valuesPath = ["types", "task", "fields", "status", "values"];
		const seq = asStrings(transitional.getIn(valuesPath)) ?? [];
		const merged = transitional.createNode([...seq, ...removed]);
		merged.flow = true;
		transitional.setIn(valuesPath, merged);
		const transitionalText = transitional.toString();
		const parsed = validateBoardYaml(transitionalText);
		if (!parsed.ok) return parsed;
		await writeFileAtomic(path, transitionalText);
		const store = new BoardStore(boardDir, parsed.config, {
			...(opts.stateDir ? { stateDir: join(opts.stateDir, ".board") } : {}),
		});
		for (const r of plan.remaps) {
			const doc = await store.updateDocument("task", r.id, {
				fields: { status: r.to },
			});
			touched.add(doc.path);
		}
	}
	await writeFileAtomic(path, plan.yaml);

	const committed =
		opts.commit === false
			? null
			: await commitPaths(boardDir, [...touched], opts.integrationBranch);
	return { ...plan, path, committed };
}

/** Commit exactly `files` (absolute) in the repository holding `dir`; null when that is not possible. */
async function commitPaths(
	dir: string,
	files: string[],
	integrationBranch: string | undefined,
): Promise<string | null> {
	if (!existsSync(dir)) return null;
	const top = await git(["rev-parse", "--show-toplevel"], dir);
	if (top.exitCode !== 0) return null;
	if (integrationBranch) {
		const head = await git(["symbolic-ref", "-q", "HEAD"], dir);
		if (head.stdout.trim() !== `refs/heads/${integrationBranch}`) return null;
	}
	const rel = files.map((f) => relative(dir, f));
	for (const p of rel) {
		const ignored = await git(["check-ignore", "-q", "--", p], dir);
		if (ignored.exitCode === 0) return null;
	}
	const added = await git(["add", "--", ...rel], dir);
	if (added.exitCode !== 0) return null;
	const staged = await git(
		["diff", "--cached", "--name-only", "-z", "--", ...rel],
		dir,
	);
	if (staged.stdout.split("\0").filter(Boolean).length === 0) return null;
	const message =
		rel.length > 1
			? `mfw: board config edited (${rel.length - 1} task${rel.length === 2 ? "" : "s"} remapped)`
			: "mfw: board config edited";
	const commit = await git(
		[
			"-c",
			"user.name=mfw",
			"-c",
			"user.email=mfw@localhost",
			"commit",
			"-q",
			"--no-verify",
			"-m",
			message,
			"--",
			...rel,
		],
		dir,
	);
	if (commit.exitCode !== 0) return null;
	const sha = await git(["rev-parse", "HEAD"], dir);
	return sha.exitCode === 0 ? sha.stdout : null;
}
