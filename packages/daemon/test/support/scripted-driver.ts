import { readFileSync, writeFileSync } from "node:fs";

/**
 * Point a scripted driver at its run's clone on the host. Every launch is
 * sandboxed, so `driver.json` names the sandbox's own paths (`cwd: /work`)
 * and sits in the run's `control/`. A scripted driver replaces the host
 * driver and plays the agent itself, so it needs the host path of the tree
 * and the clone's gitdir, as the sandbox would set them.
 *
 * The source uses `cfg.cwd` for the tree and `{ cwd: cfg.cwd }` for git, as
 * the drivers written for the old unsandboxed launch did.
 */
export function onRunTree(source: string, workspaceRoot: string): string {
	const prelude = [
		`const __runDir = process.argv[2];`,
		`const __tree = ${JSON.stringify(workspaceRoot)} + "/" + __runDir.split("/").pop() + "/tree";`,
		`const __gitEnv = { ...process.env, GIT_DIR: __tree + "/../git", GIT_WORK_TREE: __tree };`,
		"",
	].join("\n");
	return (
		prelude +
		source
			.replaceAll('dir + "/driver.json"', 'dir + "/control/driver.json"')
			.replaceAll('dir + "/steer.jsonl"', 'dir + "/control/steer.jsonl"')
			.replaceAll("{ cwd: cfg.cwd }", "{ cwd: __tree, env: __gitEnv }")
			.replaceAll("cfg.cwd", "__tree")
	);
}

/** Rewrite the scripted driver at `path` in place (see `onRunTree`). */
export function pointDriverAtRunTree(
	path: string,
	workspaceRoot: string,
): void {
	writeFileSync(path, onRunTree(readFileSync(path, "utf8"), workspaceRoot));
}
