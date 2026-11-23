/**
 * Copies the project database's migrations into the production build, with a
 * content-hash manifest the server checks at each open. Runs after `vite build`:
 *
 *   bun run build
 */

import { join, resolve } from "node:path";
import { buildMigrations } from "../packages/db/src/migration-source.ts";

if (import.meta.main) {
	const root = resolve(import.meta.dir, "..");
	// An explicit output directory is for the build's own regression test.
	const output = process.argv[2]
		? resolve(process.argv[2])
		: join(root, "apps/start/.output");
	const manifest = buildMigrations(
		join(root, "packages/db/migrations"),
		output,
	);
	console.log(
		`migrations: ${Object.keys(manifest.files).length - 1} built with a hash manifest`,
	);
}
