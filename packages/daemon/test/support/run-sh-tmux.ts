import { type Subprocess, spawn } from "bun";
import type { AgentTmuxRunner } from "../../src/agent-host.ts";

/**
 * A tmux stand-in that executes what `AgentHost` asks tmux to run, so the
 * generated `run.sh` can be exercised (and attacked) without a tmux server.
 * `new-session` starts the pane command with a stdin pipe; `send-keys` is the
 * go signal, optionally delayed per session (to widen a race window in tests).
 * Everything else succeeds silently.
 */
export function runShTmux(goDelayMs: Record<string, number> = {}): {
	runner: AgentTmuxRunner;
	procs: Map<string, Subprocess<"pipe", "ignore", "ignore">>;
} {
	const procs = new Map<string, Subprocess<"pipe", "ignore", "ignore">>();
	const ok = {
		exitCode: 0,
		stdout: "",
		stderr: "",
		timedOut: false,
		truncated: false,
		signalCode: null,
	};
	const runner: AgentTmuxRunner = async (args) => {
		if (args[0] === "new-session") {
			const name = args[args.indexOf("-s") + 1] as string;
			const command = args[args.length - 1] as string;
			procs.set(
				name,
				spawn(["sh", "-c", command], {
					stdin: "pipe",
					stdout: "ignore",
					stderr: "ignore",
				}),
			);
		} else if (args[0] === "send-keys") {
			const session = args[args.indexOf("-t") + 1] as string;
			await Bun.sleep(goDelayMs[session] ?? 0);
			const p = procs.get(session);
			p?.stdin.write("\n");
			p?.stdin.flush();
		}
		return ok;
	};
	return { runner, procs };
}
