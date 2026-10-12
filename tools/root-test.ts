import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, parse, resolve } from "node:path";

const TEST_HOME_PREFIX = "mfw-test-";
const WORKTREE_IGNORE = "**/worktrees/**";

/**
 * The suite owns exactly one direct child of the system temp directory. Keep
 * this check next to cleanup so a future refactor cannot turn a missing or
 * ambient MFW_HOME into a recursive-delete target.
 */
export function validateTestHome(path: string, tempRoot = tmpdir()): string {
	const home = resolve(path);
	const root = resolve(tempRoot);
	if (
		root === parse(root).root ||
		dirname(home) !== root ||
		!basename(home).startsWith(TEST_HOME_PREFIX) ||
		basename(home).length === TEST_HOME_PREFIX.length
	) {
		throw new Error(`refusing to clean unvalidated test home: ${path}`);
	}
	return home;
}

/** Test files per `bun test` process; see `testShards`. */
export const SHARD_FILES = 40;

export function testArgs(
	repoRoot: string,
	files?: readonly string[],
): string[] {
	return [
		"test",
		"--path-ignore-patterns",
		WORKTREE_IGNORE,
		...(files ?? [join(repoRoot, "packages"), join(repoRoot, "apps")]),
	];
}

/**
 * Splits the suite into several `bun test` processes. One process running
 * everything (~3500 tests, minutes) has segfaulted in Bun 1.3.13 on CI late in
 * the run, after every test passed; short-lived processes do not accumulate
 * whatever it trips over. Files are sorted so shards are stable.
 */
export function testShards(
	files: readonly string[],
	size = SHARD_FILES,
): string[][] {
	const sorted = [...files].sort();
	const shards: string[][] = [];
	for (let i = 0; i < sorted.length; i += size)
		shards.push(sorted.slice(i, i + size));
	return shards;
}

async function discoverTests(repoRoot: string): Promise<string[]> {
	const found: string[] = [];
	for (const tree of ["packages", "apps"]) {
		const glob = new Bun.Glob("**/*.test.{ts,tsx}");
		for await (const rel of glob.scan({ cwd: join(repoRoot, tree) })) {
			if (/(^|\/)(node_modules|worktrees)\//.test(rel)) continue;
			found.push(join(repoRoot, tree, rel));
		}
	}
	return found;
}

export function testEnvironment(
	home: string,
	socket: string,
	ambient: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	return {
		...ambient,
		MFW_HOME: home,
		MFW_TMUX_SOCKET: socket,
	};
}

function stopProcessGroup(pid: number, signal: NodeJS.Signals) {
	try {
		process.kill(-pid, signal);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}

async function stopTmux(socket: string) {
	try {
		const proc = Bun.spawn(["tmux", "-L", socket, "kill-server"], {
			stdout: "ignore",
			stderr: "ignore",
		});
		await proc.exited;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

export async function main(): Promise<number> {
	const repoRoot = resolve(import.meta.dir, "..");
	const explicitHome = validateTestHome(
		await mkdtemp(join(tmpdir(), TEST_HOME_PREFIX)),
	);
	const socket = `mfw-test-${process.pid}-${randomUUID().slice(0, 12)}`;
	let child: ReturnType<typeof Bun.spawn> | undefined;
	const forward = (signal: NodeJS.Signals) => {
		if (child) stopProcessGroup(child.pid, signal);
	};
	const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
	const signalHandlers = signals.map((signal) => ({
		signal,
		handle: () => forward(signal),
	}));
	for (const { signal, handle } of signalHandlers) process.on(signal, handle);

	try {
		let exitCode = 0;
		const shards = testShards(await discoverTests(repoRoot));
		for (const [i, shard] of shards.entries()) {
			console.log(`\n== test shard ${i + 1}/${shards.length} ==`);
			child = Bun.spawn([process.execPath, ...testArgs(repoRoot, shard)], {
				cwd: repoRoot,
				env: testEnvironment(explicitHome, socket),
				stdin: "inherit",
				stdout: "inherit",
				stderr: "inherit",
				// All ordinary descendants stay in this private process group. The
				// finally block can therefore reap stragglers without touching
				// another test invocation or the operator's processes.
				detached: true,
			});
			const code = await child.exited;
			stopProcessGroup(child.pid, "SIGKILL");
			if (code !== 0 && exitCode === 0) exitCode = code;
		}
		return exitCode;
	} finally {
		for (const { signal, handle } of signalHandlers)
			process.off(signal, handle);
		if (child) {
			stopProcessGroup(child.pid, "SIGTERM");
			await Bun.sleep(50);
			stopProcessGroup(child.pid, "SIGKILL");
		}
		await stopTmux(socket);
		await rm(validateTestHome(explicitHome), {
			recursive: true,
			force: true,
		});
	}
}

if (import.meta.main) process.exitCode = await main();
