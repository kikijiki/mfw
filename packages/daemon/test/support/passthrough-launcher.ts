/**
 * A stand-in for the agent launcher, for brain-turn tests that drive a fake
 * CLI through the real host driver and bridge. It runs the agent argv after
 * `--` in the request's tree, with the request's env, where the real launcher
 * would compile, probe, attest and enter the sandbox. Only fake CLIs from the
 * test fixtures ever reach it; the real launch path is covered by the live
 * sandbox suites and the agent smoke.
 */
import { readFileSync } from "node:fs";

const [requestPath, sep, ...argv] = process.argv.slice(2);
if (!requestPath || sep !== "--" || argv.length === 0) {
	process.stderr.write("usage: passthrough-launcher <request> -- <argv>\n");
	process.exit(2);
}
const request = JSON.parse(readFileSync(requestPath, "utf8")) as {
	tree: string;
	env?: Record<string, string>;
};
const child = Bun.spawn(argv, {
	cwd: request.tree,
	env: { ...process.env, ...(request.env ?? {}) },
	stdin: "inherit",
	stdout: "inherit",
	stderr: "inherit",
});
process.exit(await child.exited);
