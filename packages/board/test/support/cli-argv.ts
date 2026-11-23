import { join } from "node:path";

const PRELOAD = join(import.meta.dir, "../../../../tools/test-preload.ts");

/**
 * argv that runs the board CLI in a child with the no-fsync test setup
 * preloaded (`bun test` preloads it only into its own process). Tests assert
 * board behaviour, never crash-safety, and each atomic write otherwise pays
 * two disk syncs. `--preload` is a flag of `bun run`, so `bun run <file>` keeps
 * working; BUN_OPTIONS would also reach the nested `bun` processes the tests
 * spawn deliberately and broke them.
 */
export function boardCliArgv(cli: string, args: readonly string[]): string[] {
	return [process.execPath, "run", "--preload", PRELOAD, cli, ...args];
}
