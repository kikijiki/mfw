import { type Subprocess, spawn } from "bun";
import type { AgentTmuxRunner } from "../../src/agent-host.ts";

/**
 * A tmux stand-in that executes what `AgentHost` asks tmux to run, so the
 * generated `run.sh` can be exercised (and attacked) without a tmux server.
 * `new-session` starts the pane command with a stdin pipe; `send-keys` is the
 * go signal, optionally delayed per session (to widen a race window in tests).
 * Everything else succeeds silently.
 */
export function runShTmux(
	/** Per session: a delay in ms, or a gate to await, before the pane command gets its go. */
	goDelayMs: Record<string, number | (() => Promise<void>)> = {},
	/** Extra environment for the pane command, merged over the test process's own. */
	env: Record<string, string> = {},
): {
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
				spawn(["/bin/sh", "-c", command], {
					env: { ...process.env, ...env },
					stdin: "pipe",
					stdout: "ignore",
					stderr: "ignore",
				}),
			);
		} else if (args[0] === "send-keys") {
			const session = args[args.indexOf("-t") + 1] as string;
			const delay = goDelayMs[session] ?? 0;
			if (typeof delay === "function") await delay();
			else await Bun.sleep(delay);
			const p = procs.get(session);
			p?.stdin.write("\n");
			p?.stdin.flush();
		}
		return ok;
	};
	return { runner, procs };
}
