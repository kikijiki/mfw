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
 * `must_not_match` naming lint) and editable with `mfwb checklist`, same as
 * any other board's checklist.
 *
 * Why a checklist and not `type: json` rows carrying a `result` key: a
 * checklist item's `done` is exactly what `forbid` tests on a checklist, its
 * text is what `must_match`/`must_not_match` test without a `key:`, ids are
 * assigned and shapes validated by board-core, and `mfwb checklist` already
 * edits it. Rows would buy a tri-state `result` the daemon has no use for
 * (an `unmet` or `uncertain` verdict is simply `done: false`) at the cost of
 * a row schema the daemon would have to validate itself. Per-criterion
 * evidence stays where it already lives: the critic's decision rows.
 *
 * Boards created before the field existed are upgraded in place
 * (`upgradeBoardYaml`) and their tasks' old `## Acceptance Criteria` body
 * section moved into the field (`migrateBodyCriteria`), once per board. The
 * reverse (`downgradeBoardYaml` + `revertBodyCriteria`) exists only so a
 * board can be handed back to an older daemon (`tools/board-acceptance.ts`).
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

/** The inverse of `addAcceptanceField`: drop the field's line(s) again. */
export function removeAcceptanceField(path: string, text: string): string {
	if (acceptanceState(path, parseConfigText(path, text)) === "absent") {
		return text;
	}
	const { doc, node } = fieldsNode(text);
	const pair = node?.items.find(
		(p) => isScalar(p.key) && p.key.value === ACCEPTANCE_FIELD,
	);
	let out: string;
	const keyRange = pair && isScalar(pair.key) ? pair.key.range : undefined;
	const valueEnd = (pair?.value as { range?: [number, number, number] })
		?.range?.[1];
	if (node && !node.flow && keyRange && valueEnd !== undefined) {
		const start = text.lastIndexOf("\n", keyRange[0] - 1) + 1;
		let end = valueEnd;
		if (text[end - 1] !== "\n") {
			const nl = text.indexOf("\n", end);
			end = nl === -1 ? text.length : nl + 1;
		}
		out = text.slice(0, start) + text.slice(end);
	} else {
		node?.delete(ACCEPTANCE_FIELD);
		out = doc.toString();
	}
	try {
		parseBoardConfig(parseDocument(out).toJS());
	} catch (e) {
		throw new BoardUpgradeError(
			path,
			`removing '${ACCEPTANCE_FIELD}' would leave an invalid board.yaml (a rule still names it?): ${(e as Error).message}`,
		);
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

export async function downgradeBoardYaml(path: string): Promise<boolean> {
	const text = await readFile(path, "utf8");
	const out = removeAcceptanceField(path, text);
	if (out === text) return false;
	await writeFileAtomic(path, out);
	return true;
}

// ---------------------------------------------------------------------------
// Body section <-> field
// ---------------------------------------------------------------------------

const SECTION_RE = /^##[ \t]+acceptance criteria[ \t]*$/i;
const ITEM_RE = /^[-*+] (?:\[([ xX])\][ \t]*)?(.*)$/;
const HEADING_RE = /^#{1,2}[ \t]+\S/;
const BLANK_RE = /^[ \t]*$/;

export type BodyMigration =
	| { kind: "none" }
	| { kind: "skip"; reason: string }
	| { kind: "move"; body: string; items: { text: string; done: boolean }[] };

/**
 * Plan moving a body's `## Acceptance Criteria` list into the field. Lossless
 * or nothing: a section holding anything but top-level list items (prose, a
 * nested or wrapped item), a second such section, or a task whose field is
 * already filled is skipped with the reason, its body left as it is.
 */
export function planBodyMigration(
	body: string,
	existing: readonly unknown[],
): BodyMigration {
	const lines = body.split("\n");
	const starts = lines.flatMap((l, i) => (SECTION_RE.test(l) ? [i] : []));
	if (starts.length === 0) return { kind: "none" };
	if (starts.length > 1) {
		return {
			kind: "skip",
			reason: `${starts.length} '## Acceptance Criteria' sections`,
		};
	}
	if (existing.length > 0) {
		return {
			kind: "skip",
			reason: `'${ACCEPTANCE_FIELD}' is already filled and the body still has a criteria section`,
		};
	}
	const start = starts[0] as number;
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		if (HEADING_RE.test(lines[i] as string)) {
			end = i;
			break;
		}
	}
	const items: { text: string; done: boolean }[] = [];
	for (let i = start + 1; i < end; i++) {
		const line = lines[i] as string;
		if (BLANK_RE.test(line)) continue;
		const m = ITEM_RE.exec(line);
		if (!m) {
			return {
				kind: "skip",
				reason: `the criteria section has a line that is not a list item: ${JSON.stringify(line.trim().slice(0, 80))}`,
			};
		}
		const text = (m[2] as string).trim();
		if (text.length === 0) continue;
		items.push({ text, done: (m[1] ?? "").toLowerCase() === "x" });
	}
	let removeStart = start;
	while (removeStart > 0 && BLANK_RE.test(lines[removeStart - 1] as string)) {
		removeStart--;
	}
	const before = lines.slice(0, removeStart);
	const after = lines.slice(end);
	const gap = before.length > 0 && after.length > 0 ? [""] : [];
	const rest = [...before, ...gap, ...after]
		.join("\n")
		.replace(/^(?:[ \t]*\n)+/, "")
		.replace(/\s+$/, "");
	return { kind: "move", body: rest, items };
}

/** The reverse: render checklist items back into a body section. */
export function bodyWithCriteriaSection(
	body: string,
	items: readonly { text: string; done: boolean }[],
): string {
	const trimmed = body.trim();
	if (items.length === 0) return trimmed;
	const lines = items.map(
		(i) => `- [${i.done ? "x" : " "}] ${i.text.replace(/\r?\n/g, " ")}`,
	);
	const section = `## Acceptance Criteria\n\n${lines.join("\n")}`;
	return trimmed.length > 0 ? `${trimmed}\n\n${section}` : section;
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

export interface MigrationReport {
	migrated: string[];
	skipped: { id: string; reason: string }[];
}

/**
 * Put every task's acceptance field back into an `## Acceptance Criteria`
 * body section (as `- [x]`/`- [ ]` items) and clear the field. Run with no
 * daemon attached (the tool takes the project lock), before
 * `downgradeBoardYaml`. A task a board rule refuses is skipped and reported.
 */
export async function revertBodyCriteria(
	boardDir: string,
	config: BoardConfig,
	/** Where the store keeps locks and counters (the daemon's `.mfw/.board`). */
	stateDir?: string,
): Promise<MigrationReport> {
	const store = new BoardStore(boardDir, config, {
		...(stateDir ? { stateDir } : {}),
	});
	const report: MigrationReport = { migrated: [], skipped: [] };
	for (const doc of await store.listDocuments(TASK_TYPE)) {
		const items =
			(doc.fields[ACCEPTANCE_FIELD] as ChecklistItem[] | undefined) ?? [];
		if (items.length === 0) continue;
		try {
			await store.transact(TASK_TYPE, doc.id, async (current) => {
				const now =
					(current.fields[ACCEPTANCE_FIELD] as ChecklistItem[] | undefined) ??
					[];
				if (now.length === 0) return null;
				return {
					fields: { [ACCEPTANCE_FIELD]: [] },
					body: bodyWithCriteriaSection(current.body, now),
				};
			});
			report.migrated.push(doc.id);
		} catch (e) {
			if (!(e instanceof RuleViolationError)) throw e;
			report.skipped.push({ id: doc.id, reason: e.message });
		}
	}
	return report;
}
