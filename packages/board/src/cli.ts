#!/usr/bin/env bun
import { buildKind, buildStamp } from "../../core/src/build-info.ts";
import pkg from "../package.json" with { type: "json" };
import { runCli } from "./run.ts";

/** `mfw-board --version`: what `mfw version` reads from its sibling. */
function versionLines(): string[] {
	const stamp = buildStamp();
	const lines = [`mfw-board ${pkg.version} (${buildKind()})`];
	if (stamp) {
		lines.push(
			`git ${stamp.gitSha}`,
			`built ${stamp.buildTime}`,
			`bun ${Bun.version}`,
		);
	}
	return lines;
}

/**
 * mfw-board: the bin entry. A thin wrapper: the CLI is `runCli` (see `run.ts`);
 * this hands it the real process (cwd, env, stdout/stderr, stdin) and exits
 * with its code. Everything testable lives there; only what needs a real
 * process (exit codes, signals, the shebang) is left here.
 */
const argv = process.argv.slice(2);
if (argv.length === 1 && argv[0] === "--version") {
	for (const line of versionLines()) process.stdout.write(`${line}\n`);
	process.exit(0);
}
const code = await runCli(argv, {
	cwd: process.cwd(),
	env: process.env,
	out: (line) => process.stdout.write(`${line}\n`),
	err: (line) => process.stderr.write(`${line}\n`),
	stdin: () => Bun.stdin.text(),
});
// Success ends naturally (stdout flushes); failures exit at once, as before.
if (code !== 0) process.exit(code);
