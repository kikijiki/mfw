/**
 * Scripts the host runs or copies for a sandboxed run. The server bundle has
 * none of them beside its chunks, so a bundled module finds them in the checkout
 * that holds the bundle.
 *
 * It never searches from the working directory or upward: a run's working
 * directory is agent-written, and a planted copy would execute on the host.
 *
 * Imported by the drivers and bridges: node builtins only. `import.meta.dir`
 * is not used because Vite's dev server does not define it.
 */

import { existsSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface HostScript {
	/** The file name, beside the module that asks for it when run from source. */
	file: string;
	/** Its path from the repository root. */
	fromRoot: string;
}

const CONTAINMENT = "packages/daemon/src/containment";

export const AGENT_LAUNCHER: HostScript = {
	file: "agent-launch-main.ts",
	fromRoot: `${CONTAINMENT}/agent-launch-main.ts`,
};
export const EGRESS_PROXY: HostScript = {
	file: "containment/egress-proxy-main.ts",
	fromRoot: `${CONTAINMENT}/egress-proxy-main.ts`,
};
/** The same proxy, for a module that sits beside it in `containment/`. */
export const EGRESS_PROXY_BESIDE: HostScript = {
	...EGRESS_PROXY,
	file: "egress-proxy-main.ts",
};
export const BRAIN_TRANSCRIPT: HostScript = {
	file: "containment/brain-transcript-main.ts",
	fromRoot: `${CONTAINMENT}/brain-transcript-main.ts`,
};
export const EGRESS_RELAY: HostScript = {
	file: "egress-relay.ts",
	fromRoot: `${CONTAINMENT}/egress-relay.ts`,
};
export const WIP_HELPER: HostScript = {
	file: "wip-helper.ts",
	fromRoot: "packages/daemon/src/run-workspace/wip-helper.ts",
};

const BUNDLE_DIR = `${sep}apps${sep}start${sep}.output${sep}`;

/** The script's path for the module at `moduleUrl`. Throws when it is not there. */
export function hostScript(moduleUrl: string, script: HostScript): string {
	const moduleFile = fileURLToPath(moduleUrl);
	const beside = join(dirname(moduleFile), script.file);
	if (existsSync(beside)) return beside;
	const bundle = moduleFile.lastIndexOf(BUNDLE_DIR);
	if (bundle >= 0) {
		const inCheckout = join(moduleFile.slice(0, bundle), script.fromRoot);
		if (existsSync(inCheckout)) return inCheckout;
	}
	throw new Error(
		`cannot locate ${script.fromRoot} from ${moduleFile}: run the server from its checkout`,
	);
}
