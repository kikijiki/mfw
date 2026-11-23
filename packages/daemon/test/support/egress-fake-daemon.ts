import { AgentHost, type LaunchSpec } from "../../src/agent-host.ts";
import { runShTmux } from "./run-sh-tmux.ts";

/**
 * A stand-in daemon for the crash test: it launches one run through the real
 * `AgentHost`, reports the run script's pid, and waits to be killed. Like tmux,
 * the stand-in runner leaves the run alive when this process dies.
 */
const [specJson, controlRoot] = process.argv.slice(2);
const spec = JSON.parse(specJson as string) as LaunchSpec;
const { runner, procs } = runShTmux();
await new AgentHost(undefined, {
	tmuxRunner: runner,
	controlRoot: controlRoot as string,
}).launch(spec);
const pane = procs.get(`mfw_${spec.runId}`);
process.stdout.write(`${pane?.pid}\n`);
setInterval(() => {}, 60_000);
