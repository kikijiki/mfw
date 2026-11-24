import { join } from "node:path";
import { runCli } from "../../src/run.ts";
import { boardCliArgv } from "./cli-argv.ts";

/** What a CLI call produced; stdout and stderr are trimmed. */
export interface BoardRun {
	stdout: string;
	stderr: string;
	code: number;
}

export interface RunOptions {
	/** The whole environment of the call. Default: this process's, minus `MFW_BOARD`. */
	env?: Record<string, string | undefined>;
	/** What `--body-file -` reads. Default: empty, like a closed stdin. */
	stdin?: string;
}

const CLI = join(import.meta.dir, "../../src/cli.ts");

/** The ambient environment without a board pointer from the developer's shell. */
export function ambientEnv(): Record<string, string | undefined> {
	const e: Record<string, string | undefined> = { ...process.env };
	delete e.MFW_BOARD;
	return e;
}

/**
 * Runs the board CLI IN-PROCESS: the same `runCli` that `src/cli.ts` (the bin)
 * wraps, with this call's cwd, environment, stdin and output buffers injected.
 * It starts no process, so it costs milliseconds where a spawn costs
 * hundreds under load. Use `spawnBoard` only for what needs a real process.
 */
export async function runBoard(
	cwd: string,
	args: readonly string[],
	opts: RunOptions = {},
): Promise<BoardRun> {
	const out: string[] = [];
	const err: string[] = [];
	const before = process.cwd();
	const code = await runCli([...args], {
		cwd,
		env: opts.env ?? ambientEnv(),
		out: (line) => out.push(line),
		err: (line) => err.push(line),
		stdin: async () => opts.stdin ?? "",
	});
	// A command that reached for the process's own cwd would work from `cwd` only by luck.
	if (process.cwd() !== before) throw new Error("runCli changed process.cwd()");
	return {
		stdout: out
			.map((l) => `${l}\n`)
			.join("")
			.trim(),
		stderr: err
			.map((l) => `${l}\n`)
			.join("")
			.trim(),
		code,
	};
}

/**
 * Runs the board CLI as the real bin in a child process (`bun run cli.ts`, the
 * no-fsync test setup preloaded). One spawn costs seconds under load, so only
 * tests whose subject is the process itself use it: exit status, real pipes,
 * the launcher, cross-process locking.
 */
export async function spawnBoard(
	cwd: string,
	args: readonly string[],
	opts: RunOptions = {},
): Promise<BoardRun> {
	const p = Bun.spawn(boardCliArgv(CLI, args), {
		cwd,
		env: opts.env ?? ambientEnv(),
		stdin:
			opts.stdin === undefined
				? "ignore"
				: new TextEncoder().encode(opts.stdin),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(p.stdout).text(),
		new Response(p.stderr).text(),
		p.exited,
	]);
	return { stdout: stdout.trim(), stderr: stderr.trim(), code };
}
