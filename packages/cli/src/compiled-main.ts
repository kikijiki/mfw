/**
 * The entry point of the compiled `mfw` (`tools/compile.ts`). It registers what
 * the build embedded (the migrations, the sandbox scripts, the libsql addon)
 * before any other module loads, then runs the same dispatcher as a checkout.
 *
 * It does not, and cannot, refuse bun's runtime variables: with `BUN_BE_BUN`
 * set none of this code runs, and a `BUN_OPTIONS` preload has run before it.
 * The control is the environment the host gives every process it starts
 * (`packages/daemon/src/containment/host-spawn-env.ts`).
 */

import payload from "mfw:embedded";
import { registerEmbeddedHostScripts } from "../../daemon/src/containment/host-script.ts";
import { registerEmbeddedMigrations } from "../../db/src/migration-source.ts";
import { installLibsqlLoader } from "./native-addon.ts";

const argv = process.argv.slice(2);
registerEmbeddedMigrations(payload.migrations);
registerEmbeddedHostScripts(payload.scripts);
installLibsqlLoader(payload.libsql);

// Loaded only now, so nothing reaches libsql or the migrations unregistered.
const [{ main }, { compiledDeps }] = await Promise.all([
	import("./main.ts"),
	import("./compiled-deps.ts"),
]);
await main(argv, compiledDeps(payload));
