import { runLauncher } from "../../src/containment/agent-launch-run.ts";
import { type CageConfig, cagedSteps } from "./caged-launch.ts";

/** Stands in for `agent-launch-main.ts` in a host without a user manager. */
const cage = JSON.parse(process.env.MFW_CAGE_CONFIG as string) as CageConfig;
const maxOutputBytes = Number(process.env.MFW_CAGE_MAX_OUTPUT ?? 0);
await runLauncher(
	process.argv.slice(2),
	cagedSteps(cage),
	maxOutputBytes > 0 ? { maxOutputBytes } : {},
);
