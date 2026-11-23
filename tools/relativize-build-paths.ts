/**
 * Removes the machine's build directory from the server output.
 *
 *   bun run tools/relativize-build-paths.ts <output-dir> <build-root>
 *
 * TanStack Start writes each route's absolute source `filePath` into the server
 * route manifest, so a build leaks the builder's home path. Those values are
 * labels only; this rewrites `<build-root>/` to nothing in every server file, so
 * `/abs/apps/start/src/routes/x.tsx` becomes `src/routes/x.tsx`.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export function relativize(text: string, buildRoot: string): string {
	return text.split(`${buildRoot.replace(/\/+$/, "")}/`).join("");
}

function* files(dir: string): Generator<string> {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) yield* files(p);
		else if (/\.(mjs|js|json)$/.test(e.name)) yield p;
	}
}

if (import.meta.main) {
	const [outDir, root] = process.argv.slice(2);
	if (!outDir || !root) {
		console.error("usage: relativize-build-paths.ts <output-dir> <build-root>");
		process.exit(2);
	}
	const buildRoot = resolve(root);
	let changed = 0;
	for (const f of files(resolve(outDir))) {
		const text = readFileSync(f, "utf8");
		const next = relativize(text, buildRoot);
		if (next !== text) {
			writeFileSync(f, next);
			changed++;
		}
	}
	console.log(`relativized build paths in ${changed} file(s)`);
}
