import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

/** realpath that tolerates a missing tail: resolve the nearest existing ancestor. */
export function resolveReal(p: string): string {
	const abs = resolve(p);
	const tail: string[] = [];
	let cur = abs;
	for (;;) {
		try {
			return join(realpathSync(cur), ...tail.reverse());
		} catch {
			const parent = dirname(cur);
			if (parent === cur) return abs;
			tail.push(basename(cur));
			cur = parent;
		}
	}
}

export function isUnder(path: string, root: string): boolean {
	const p = resolveReal(path);
	const r = resolveReal(root);
	return p === r || p.startsWith(r.endsWith(sep) ? r : r + sep);
}
