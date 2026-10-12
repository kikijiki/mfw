import { readFile } from "node:fs/promises";
import { parseBoardConfig, writeFileAtomic } from "@mfw/board-core";
import { isMap, isScalar, parseDocument } from "yaml";

/**
 * The task type's routing fields (`routing.ts`): `provider` names a catalogue
 * harness (`claude-cli`, `codex-cli`) or a project endpoint id, `model` the
 * exact model id. Both optional; unset means "the project decides".
 *
 * Boards created before these fields existed are upgraded in place on attach,
 * the same way and in the same commit as the acceptance field: a text
 * insertion at the end of the task type's `fields:` map, so the rest of the
 * file is kept byte for byte. A board that already declares a field of that
 * name keeps its own declaration (a string scalar works as is; anything else
 * makes the daemon ignore the value, see `routingFieldValue`).
 */
export const ROUTING_FIELDS = {
	provider: "provider: { optional: true, pattern: '[A-Za-z0-9_-]+' }",
	model: "model: { optional: true }",
} as const;

const TASK_TYPE = "task";

/** Add whichever routing fields the task type lacks. Pure; returns `text` unchanged when nothing is missing. */
export function addRoutingFields(text: string): string {
	let out = text;
	for (const [name, line] of Object.entries(ROUTING_FIELDS)) {
		out = addFieldText(out, name, line);
	}
	if (out !== text) parseBoardConfig(parseDocument(out).toJS());
	return out;
}

/** Insert `line` (a `name: {...}` entry) into the task type's `fields:` map unless `name` is declared. */
export function addFieldText(text: string, name: string, line: string): string {
	const doc = parseDocument(text);
	const node = doc.getIn(["types", TASK_TYPE, "fields"], true);
	if (!isMap(node)) return text;
	if (node.items.some((p) => isScalar(p.key) && p.key.value === name))
		return text;
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
		return `${text.slice(0, at)}${lead}${" ".repeat(indent)}${line}\n${text.slice(at)}`;
	}
	const value = doc.createNode(
		parseDocument(line).toJS()[name] as Record<string, unknown>,
	);
	value.flow = true;
	node.set(name, value);
	return doc.toString();
}

/** Idempotent in-place upgrade; returns whether the file changed. */
export async function upgradeRoutingFields(path: string): Promise<boolean> {
	const text = await readFile(path, "utf8");
	let out: string;
	try {
		out = addRoutingFields(text);
	} catch {
		// Never refuse an attach over optional routing fields: the board keeps
		// working, tasks just cannot pin a provider until board.yaml is fixed.
		return false;
	}
	if (out === text) return false;
	await writeFileAtomic(path, out);
	return true;
}
