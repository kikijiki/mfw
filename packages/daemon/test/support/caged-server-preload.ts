import { plugin } from "bun";
import { type CageConfig, cagedSteps } from "./caged-launch.ts";

/**
 * Lets the production bundle pass its dispatch preflight on a host with no
 * systemd user manager, using the same stand-in as the conformance tests. Only
 * `tools/agent-launch-smoke.ts` loads this, through `bun --preload`: nothing in
 * the production build can select it.
 */
const STEPS = Symbol.for("mfw.test.cagedSteps");
const cage = JSON.parse(process.env.MFW_CAGE_CONFIG as string) as CageConfig;
(globalThis as Record<symbol, unknown>)[STEPS] = cagedSteps(cage);

const TARGET = /compileHost: liveCompileHost,\s*attest: attestSandbox,/;
const CAGED = `compileHost: globalThis[Symbol.for("mfw.test.cagedSteps")].compileHost,
  attest: globalThis[Symbol.for("mfw.test.cagedSteps")].attest,`;

plugin({
	name: "caged-server",
	setup(build) {
		build.onLoad({ filter: /\.output\/server\/.*\.mjs$/ }, async (args) => {
			const text = await Bun.file(args.path).text();
			return { loader: "js", contents: text.replace(TARGET, CAGED) };
		});
	},
});
