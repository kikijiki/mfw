/**
 * Runs under `script`, so this process really has a terminal on stdio. Not a
 * test file: launch-sandbox-live.test.ts validates the compiled sandbox with
 * the containment guard and the control before it starts this.
 *
 * Modes:
 * - `control`: hand the terminal to bwrap directly, to prove the check can see it;
 * - `refuse`: ask the launcher to use the terminal as stdin;
 * - `pipes`: launch normally from a process that has a terminal and an extra fd.
 */

import { openSync, readFileSync, writeFileSync } from "node:fs";
import { isatty } from "node:tty";
import type { CompiledSandbox } from "../src/containment/compile-bwrap.ts";
import {
	launchSandbox,
	openSandboxFds,
	SandboxLaunchError,
} from "../src/containment/launch-sandbox.ts";

const [compiledPath, resultPath, mode, keyPath] = process.argv.slice(2) as [
	string,
	string,
	string,
	string,
];
const raw = JSON.parse(readFileSync(compiledPath, "utf8"));
const compiled: CompiledSandbox = {
	...raw,
	seccomp: Buffer.from(raw.seccomp, "base64"),
	bwrapArgs: Buffer.from(raw.bwrapArgs, "base64"),
};
const result: Record<string, unknown> = { parentTty: isatty(0) };

if (mode === "control") {
	const opened = openSandboxFds(compiled);
	const argv = compiled.argv.slice(compiled.argv.indexOf("--") + 1);
	const child = Bun.spawn(argv, { stdio: [0, 1, 2, ...opened.fds] as never });
	opened.release();
	result.code = await child.exited;
} else if (mode === "refuse") {
	try {
		const child = launchSandbox(compiled, { scope: "none", stdin: 0 });
		result.code = await child.exited;
		result.refused = null;
	} catch (err) {
		if (!(err instanceof SandboxLaunchError)) throw err;
		result.refused = err.code;
	}
} else {
	// Deliberately not close-on-exec: this is the descriptor that must not cross.
	result.extraFd = openSync(keyPath, "r+");
	const child = launchSandbox(compiled, { scope: "none" });
	result.code = await child.exited;
}

writeFileSync(resultPath, JSON.stringify(result));
