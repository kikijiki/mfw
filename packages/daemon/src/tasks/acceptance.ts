import { readFile } from "node:fs/promises";
import {
	type BoardConfig,
	BoardStore,
	type ChecklistItem,
	nextChecklistId,
	parseBoardConfig,
	RuleViolationError,
	writeFileAtomic,
} from "@mfw/board-core";
import { isMap, isScalar, parseDocument } from "yaml";

/**
 * Acceptance criteria are the task type's `acceptance` frontmatter field, a
 * board-core `checklist` (`{id, text, done}` items). That makes them subject
 * to the board's own `rules:` (a `forbid: {done: false}` done gate, a
 * `must_not_match` naming lint) and editable with `mfw board checklist`, same as
 * any other board's checklist.
 *
 * Why a checklist and not `type: json` rows carrying a `result` key: a
 * checklist item's `done` is exactly what `forbid` tests on a checklist, its
 * text is what `must_match`/`must_not_match` test without a `key:`, ids are
 * assigned and shapes validated by board-core, and `mfw board checklist` already
 * edits it. Rows would buy a tri-state `result` the daemon has no use for
 * (an `unmet` or `uncertain` verdict is simply `done: false`) at the cost of
 * a row schema the daemon would have to validate itself. Per-criterion
 * evidence stays where it already lives: the critic's decision rows.
 *
 * A board.yaml whose task type lacks the field (hand-written, or from another
 * template) gets it added in place at attach (`upgradeBoardYaml`).
 */

export const ACCEPTANCE_FIELD = "acceptance";
const TASK_TYPE = "task";
const FIELD_LINE = `${ACCEPTANCE_FIELD}: { type: checklist, optional: true }`;

/** The board's `board.yaml` cannot take the acceptance field. Nothing was written. */
export class BoardUpgradeError extends Error {
	constructor(
		readonly path: string,
		message: string,
	) {
		super(`${path}: ${message}`);
		this.name = "BoardUpgradeError";
	}
}

function parseConfigText(path: string, text: string): BoardConfig {
	try {
		return parseBoardConfig(parseDocument(text).toJS());
	} catch (e) {
		throw new BoardUpgradeError(path, (e as Error).message);
	}
}

/** "absent", "present" (a checklist: nothing to do), or a conflict message. */
function acceptanceState(
	path: string,
	config: BoardConfig,
): "absent" | "present" {
	const task = config.types[TASK_TYPE];
	if (!task) {
		throw new BoardUpgradeError(path, `there is no '${TASK_TYPE}' type`);
	}
	const spec = task.fields[ACCEPTANCE_FIELD];
	if (!spec) return "absent";
	if (spec.kind === "checklist") return "present";
	throw new BoardUpgradeError(
		path,
		`type '${TASK_TYPE}' already declares a field '${ACCEPTANCE_FIELD}' that is not a checklist ` +
			`(mfw keeps acceptance criteria there as '${FIELD_LINE}'). ` +
			"Rename that field or change it to a checklist, then restart the daemon.",
	);
}

/** The `types.task.fields` map node of a parsed board.yaml, or null. */
function fieldsNode(text: string) {
	const doc = parseDocument(text);
	const node = doc.getIn(["types", TASK_TYPE, "fields"], true);
	return { doc, node: isMap(node) ? node : null };
}

/**
 * Insert the acceptance field into a board.yaml's task type. Pure text
 * insertion at the end of the block `fields:` map (indented like its first
 * key), so the rest of the file, comments included, is byte-for-byte kept; a
 * flow-style `fields: {...}` map is re-rendered instead.
 */
export function addAcceptanceField(path: string, text: string): string {
	const state = acceptanceState(path, parseConfigText(path, text));
	if (state === "present") return text;
	const { doc, node } = fieldsNode(text);
	if (!node) {
		throw new BoardUpgradeError(
			path,
			`type '${TASK_TYPE}' has no 'fields' map to add '${ACCEPTANCE_FIELD}' to`,
		);
	}
	let out: string;
	const first = node.items[0];
	const last = node.items.at(-1);
	const firstKey = first && isScalar(first.key) ? first.key : null;
	const lastEnd = last?.value
		? (last.value as { range?: [number, number, number] }).range?.[1]
		: last && isScalar(last.key)
			? last.key.range?.[1]
			: undefined;
	if (!node.flow && firstKey?.range && lastEnd !== undefined) {
		const keyStart = firstKey.range[0];
		const indent = keyStart - (text.lastIndexOf("\n", keyStart - 1) + 1);
		let at = lastEnd;
		if (text[at - 1] !== "\n") {
			const nl = text.indexOf("\n", at);
			at = nl === -1 ? text.length : nl + 1;
		}
		const lead = at === text.length && !text.endsWith("\n") ? "\n" : "";
		out = `${text.slice(0, at)}${lead}${" ".repeat(indent)}${FIELD_LINE}\n${text.slice(at)}`;
	} else {
		const value = doc.createNode({ type: "checklist", optional: true });
		value.flow = true;
		node.set(ACCEPTANCE_FIELD, value);
		out = doc.toString();
	}
	if (acceptanceState(path, parseConfigText(path, out)) !== "present") {
		throw new BoardUpgradeError(path, "could not add the acceptance field");
	}
	return out;
}

/**
 * Idempotent: adds the field when absent, does nothing when a checklist is
 * already declared, throws `BoardUpgradeError` (writing nothing) when a
 * different field of that name exists. Returns whether the file changed.
 */
export async function upgradeBoardYaml(path: string): Promise<boolean> {
	const text = await readFile(path, "utf8");
	const out = addAcceptanceField(path, text);
	if (out === text) return false;
	await writeFileAtomic(path, out);
	return true;
}

/** Items for the field from criteria that may lack ids: given ids are kept,
 * the rest get fresh `c<N>` ids above every id in `items` and `previous` (so
 * a removed item's id is not handed to a new one). */
export function toChecklist(
	items: readonly { id?: string; text: string; done: boolean }[],
	previous: readonly { id?: string }[] = [],
): ChecklistItem[] {
	const out: ChecklistItem[] = [];
	const taken = [...previous, ...items];
	for (const item of items) {
		const id = item.id ?? nextChecklistId([...taken, ...out]);
		out.push({ id, text: item.text, done: item.done });
	}
	return out;
}
