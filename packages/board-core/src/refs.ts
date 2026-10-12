import type { RefsRule } from "./external-config.ts";
import { idPattern } from "./ids.ts";
import type { ScannedFile } from "./scan.ts";

/**
 * Evaluates a `refs` rule over files already read: every match of the rule's
 * pattern names a document id, which must resolve to a document of the `to`
 * type whose status is allowed. Pure; the caller supplies the file texts and
 * the candidate documents.
 */

export interface RefTarget {
	id: string;
	status: string;
}

export interface RefFinding {
	file: string;
	line: number;
	/** The captured id. */
	id: string;
	message: string;
}

const WORD = /[A-Za-z0-9_]/;

export interface RefsResult {
	findings: RefFinding[];
	/** Pattern matches that named an id (resolved or not). */
	matches: number;
}

export function evaluateRefs(
	rule: RefsRule,
	files: readonly ScannedFile[],
	targets: ReadonlyMap<string, RefTarget>,
	idGrammar: RegExp | null,
): RefsResult {
	const re = new RegExp(rule.pattern, `${rule.flags}dg`);
	const out: RefFinding[] = [];
	let matches = 0;
	for (const file of files) {
		const lines = file.text.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const line = (lines[i] as string).replace(/\r$/, "");
			re.lastIndex = 0;
			for (const m of line.matchAll(re)) {
				const span = m.indices?.groups?.id;
				const id = m.groups?.id;
				if (!span || id === undefined) continue;
				// The pattern's own boundaries are the author's; the id's must hold
				// regardless, so POOT-641 is never read out of POOT-6410.
				if (WORD.test(line[span[1]] ?? "") && WORD.test(id.slice(-1))) continue;
				if (
					span[0] > 0 &&
					WORD.test(line[span[0] - 1] ?? "") &&
					WORD.test(id[0] ?? "")
				)
					continue;
				matches++;
				const where = { file: file.path, line: i + 1, id };
				if (idGrammar && !idGrammar.test(id)) {
					out.push({
						...where,
						message: `'${id}' is not a ${rule.to} id`,
					});
					continue;
				}
				const target = targets.get(id);
				if (!target) {
					out.push({
						...where,
						message: `refers to unknown ${rule.to} '${id}'`,
					});
					continue;
				}
				if (rule.status && !rule.status.includes(target.status)) {
					out.push({
						...where,
						message: `refers to ${id}, which is ${target.status} (allowed: ${rule.status.join(", ")})`,
					});
				}
			}
		}
	}
	return { findings: out, matches };
}

/** The id grammar of a type whose ids are `<KEY>-<n>`, else null (no check). */
export function grammarOf(
	key: string | undefined,
	suffix?: string,
): RegExp | null {
	return key ? idPattern(key, suffix) : null;
}
