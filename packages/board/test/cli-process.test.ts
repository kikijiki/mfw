import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	ambientEnv,
	type BoardRun,
	runBoard,
	spawnBoard,
} from "./support/board-run.ts";

/**
 * The few tests that need a REAL `mfw-board` process. Every other board test
 * runs the CLI in-process (`runBoard`); these keep what only a process can
 * show: the bin entry and its shebang, exit statuses and pipes through the OS,
 * and that the in-process and spawned paths agree. A spawn costs 0.1 s idle and
 * seconds when the machine is busy, so each test sets its own timeout (30 s: a
 * generous multiple of the busiest spawn seen, per spawn, for up to a dozen
 * spawns) instead of leaning on the 5 s default.
 */
const CLI = join(import.meta.dir, "../src/cli.ts");
const SPAWN_TIMEOUT = 30_000;

const BOARD = [
	"mfw: 1",
	"types:",
	"  task:",
	"    layout: flat",
	"    dir: tasks",
	"    id: { strategy: own-sequence, key: TK }",
	"    fields:",
	"      title: {}",
	"      status: { values: [todo, done], default: todo }",
].join("\n");

const dirs: string[] = [];
async function tmp(withBoard = true): Promise<string> {
	const d = await realpath(await mkdtemp(join(tmpdir(), "mfw-board-proc-")));
	dirs.push(d);
	if (withBoard) await writeFile(join(d, "board.yaml"), BOARD);
	return d;
}
afterEach(async () => {
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe("in-process and spawned runs agree", () => {
	// Each case is run both ways on identical fresh boards; stdout, stderr and the
	// exit code must be byte-identical. This is what lets every other test use the
	// in-process path: `cli.ts` adds nothing to `runCli` but the process plumbing.
	const cases: { name: string; board?: boolean; args: string[] }[] = [
		{ name: "ok: list on an empty board", args: ["list"] },
		{ name: "ok: create prints the document", args: ["create", "title=a"] },
		{ name: "usage error: no command (exit 2)", args: [] },
		{ name: "usage error: unknown flag (exit 2)", args: ["list", "--nope"] },
		{ name: "usage error: unknown command (exit 2)", args: ["frobnicate"] },
		{ name: "--help (exit 0, stdout)", args: ["--help"] },
		{ name: "command help", args: ["create", "--help"] },
		{ name: "failed command (exit 1)", args: ["delete", "TK-9"] },
		{
			name: "--override of an unknown rule (exit 2)",
			args: ["list", "--override", "x"],
		},
		{ name: "no board (exit 3)", board: false, args: ["list"] },
		{ name: "no board: help still prints", board: false, args: ["--help"] },
	];
	for (const c of cases) {
		test(
			c.name,
			async () => {
				const board = c.board ?? true;
				const [a, b] = [await tmp(board), await tmp(board)];
				const inProc = await runBoard(a, c.args);
				const spawned = await spawnBoard(b, c.args);
				const norm = (r: BoardRun): BoardRun => ({
					...r,
					stdout: r.stdout.replaceAll(b, a),
					stderr: r.stderr.replaceAll(b, a),
				});
				expect(inProc).toEqual(norm(spawned));
			},
			SPAWN_TIMEOUT,
		);
	}
});

describe("the bin entry", () => {
	test(
		"runs by its shebang, with a real stdout and exit status 0",
		async () => {
			const d = await tmp();
			const bun = dirname(process.execPath);
			const p = Bun.spawn([CLI, "list"], {
				cwd: d,
				// the shebang is `env bun`: bun must be on PATH, nothing else is needed
				env: { ...ambientEnv(), PATH: `${bun}:${process.env.PATH ?? ""}` },
				stdout: "pipe",
				stderr: "pipe",
			});
			const [out, err, code] = await Promise.all([
				new Response(p.stdout).text(),
				new Response(p.stderr).text(),
				p.exited,
			]);
			expect({ out, err, code }).toEqual({ out: "", err: "", code: 0 });
		},
		SPAWN_TIMEOUT,
	);

	test(
		"a failure exits with its code and writes to stderr, not stdout",
		async () => {
			const d = await tmp(false);
			const r = await spawnBoard(d, ["list"]);
			expect(r.code).toBe(3);
			expect(r.stdout).toBe("");
			expect(r.stderr).toContain("no board found");
		},
		SPAWN_TIMEOUT,
	);

	test(
		"--body-file - reads the process's real stdin",
		async () => {
			const d = await tmp();
			const c = await spawnBoard(d, ["create", "title=a", "--body-file", "-"], {
				stdin: "from a pipe\n",
			});
			expect(c.code).toBe(0);
			const shown = await spawnBoard(d, ["show", "TK-1"]);
			expect(shown.stdout).toContain("from a pipe");
		},
		SPAWN_TIMEOUT,
	);
});
