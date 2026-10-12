import { readFile } from "node:fs/promises";
import { parseBoardConfig, writeFileAtomic } from "@mfw/board-core";
import { parseDocument } from "yaml";
import { addFieldText } from "./routing-fields.ts";

/**
 * The task type's provenance fields (design §2.3): `created_by` names who
 * wrote a task (`brain:<actionId>#<n>` for the brain; absent for a person),
 * `edited_by` the brain action that last changed it, `superseded_by` the task
 * that replaced it in a merge.
 *
 * `created_by` is also the brain's idempotency key: the document is written
 * with it atomically, so a crash after the board write and before the action
 * is marked applied is repaired by looking the key up, never by writing a
 * second task.
 *
 * Boards created before these fields existed are upgraded in place on attach,
 * the same way as the routing pins: a text insertion at the end of the task
 * type's `fields:` map. A board that already declares a field of that name
 * keeps its own declaration.
 */
export const PROVENANCE_FIELDS = {
	created_by: "created_by: { optional: true }",
	edited_by: "edited_by: { optional: true }",
	superseded_by: "superseded_by: { optional: true }",
} as const;

/** Add whichever provenance fields the task type lacks. Pure. */
export function addProvenanceFields(text: string): string {
	let out = text;
	for (const [name, line] of Object.entries(PROVENANCE_FIELDS)) {
		out = addFieldText(out, name, line);
	}
	if (out !== text) parseBoardConfig(parseDocument(out).toJS());
	return out;
}

/** Idempotent in-place upgrade; returns whether the file changed. */
export async function upgradeProvenanceFields(path: string): Promise<boolean> {
	const text = await readFile(path, "utf8");
	let out: string;
	try {
		out = addProvenanceFields(text);
	} catch {
		// Never refuse an attach over optional fields: the brain's board tools
		// report the missing field with its fix instead.
		return false;
	}
	if (out === text) return false;
	await writeFileAtomic(path, out);
	return true;
}
