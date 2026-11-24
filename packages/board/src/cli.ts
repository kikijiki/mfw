#!/usr/bin/env bun
import { runCli } from "./run.ts";

/**
 * mfw-board: the bin entry. A thin wrapper: the CLI is `runCli` (see `run.ts`);
 * this hands it the real process (cwd, env, stdout/stderr, stdin) and exits
 * with its code. Everything testable lives there; only what needs a real
 * process (exit codes, signals, the shebang) is left here.
 */
const code = await runCli(process.argv.slice(2), {
	cwd: process.cwd(),
	env: process.env,
	out: (line) => process.stdout.write(`${line}\n`),
	err: (line) => process.stderr.write(`${line}\n`),
	stdin: () => Bun.stdin.text(),
});
// Success ends naturally (stdout flushes); failures exit at once, as before.
if (code !== 0) process.exit(code);
