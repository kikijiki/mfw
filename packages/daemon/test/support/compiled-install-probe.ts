/**
 * Built by `compiled-install.test.ts` with the bundle's build stamp and placed
 * inside a server bundle, so host-script resolution runs exactly as it does in
 * a production bundle: from its own module URL, with its own stamp. Prints one
 * JSON result per call: `{ ok, value }` or `{ ok: false, error }`.
 */

import { resolveScript } from "../../src/agents/adapter.ts";
import {
	AGENT_LAUNCHER,
	APP_SERVER_DRIVER,
	CLAUDE_BRIDGE,
	EGRESS_RELAY,
	type HostScript,
	hostArgv,
	hostCommand,
	hostEntry,
	hostScript,
	runsHostEntries,
} from "../../src/containment/host-script.ts";

const SCRIPTS: Record<string, HostScript> = {
	AGENT_LAUNCHER,
	APP_SERVER_DRIVER,
	CLAUDE_BRIDGE,
	EGRESS_RELAY,
};

const [op, name = "AGENT_LAUNCHER"] = process.argv.slice(2);
const script = SCRIPTS[name] as HostScript;
const url = import.meta.url;

function run(): unknown {
	switch (op) {
		case "runs":
			return runsHostEntries(url);
		case "command":
			return hostCommand(hostEntry(url, script), "/bin/bun");
		case "argv":
			return hostArgv(["bun", "run", hostEntry(url, script)], "/bin/bun");
		case "script":
			return hostScript(url, script);
		case "resolve":
			return resolveScript(url, script, "MFW_TEST_OVERRIDE_SCRIPT");
		default:
			throw new Error(`unknown op ${op}`);
	}
}

try {
	console.log(JSON.stringify({ ok: true, value: run() }));
} catch (e) {
	console.log(JSON.stringify({ ok: false, error: (e as Error).message }));
}
