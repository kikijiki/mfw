/**
 * The entry point of the compiled `mfw` (`tools/compile.ts`). It registers what
 * the build embedded (the migrations, the sandbox scripts, the libsql addon)
 * before any other module loads, then runs the same dispatcher as a checkout.
 *
 * Bun runtime options are refused before anything else: `BUN_OPTIONS` would
 * already have preloaded code by now, and `BUN_BE_BUN` would have made this a
 * plain bun. The refusal is loud so such an environment is fixed, and nothing
 * this process starts inherits them. `mfw version` still reports.
 */

import payload from "mfw:embedded";
import { registerEmbeddedHostScripts } from "../../daemon/src/containment/host-script.ts";
import { registerEmbeddedMigrations } from "../../db/src/migration-source.ts";
import { runtimeOptionProblem } from "./host-exec.ts";
import { installLibsqlLoader } from "./native-addon.ts";

const argv = process.argv.slice(2);
const problem = runtimeOptionProblem(process.env, process.execArgv);
if (problem && argv[0] !== "version") {
	console.error(
		`mfw: refusing to run: ${problem}, and a compiled mfw takes no bun runtime options. Fix: unset it`,
	);
	process.exit(78);
}
registerEmbeddedMigrations(payload.migrations);
registerEmbeddedHostScripts(payload.scripts);
installLibsqlLoader(payload.libsql);

// Loaded only now, so nothing reaches libsql or the migrations unregistered.
const [{ main }, { compiledDeps }] = await Promise.all([
	import("./main.ts"),
	import("./compiled-deps.ts"),
]);
await main(argv, compiledDeps(payload));
