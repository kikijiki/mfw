#!/usr/bin/env bun
import { existsSync, readFileSync, statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

/**
 * `mfw`: the one dispatcher. It owns no logic of its own; each subcommand is
 * either another executable (`board` -> `mfw-board`, so the board tool stays
 * usable without the server) or a module run in this process (`mcp`).
 */

const SUBCOMMANDS = [
	"auth",
	"board",
	"host",
	"mcp",
	"server",
	"version",
] as const;

export interface Deps {
	env: Record<string, string | undefined>;
	/** Directory of this script; `mfw-board` is looked up here first. */
	selfDir: string;
	/** The board CLI source in a checkout (fallback when no executable is found). */
	sourceBoardCli: string | null;
	/** The built server entry (`bun run build`), or null when absent. */
	serverEntry: string | null;
	repoRoot: string;
	/** The bun binary that runs source and the server (this process's own). */
	bun: string;
	out: (line: string) => void;
	err: (line: string) => void;
	/** Runs a child with inherited stdio, resolving to its exit code. */
	run: (argv: string[], cwd?: string) => Promise<number>;
	/** Runs the MCP stdio server in this process (resolves when it is set up). */
	runMcp: (args: string[]) => Promise<void>;
	/** Runs `mfw auth ...` against this install's auth store. */
	runAuth: (args: string[]) => Promise<number>;
	/** Runs `mfw host ...` against this install's host state. */
	runHost: (args: string[]) => Promise<number>;
}

export const USAGE = [
	"usage: mfw <command> [args]",
	"",
	"  auth ...      owner tools: token, unlock, setup-token, sign-out-everywhere, reset",
	"  board ...     the markdown board (runs mfw-board; no server needed)",
	"  host ...      owner tools for host state: acknowledge-legacy",
	"  mcp [--token-file <path>]   MCP server over stdio, using a scoped API token",
	"  server        run the orchestrator + web UI in the foreground",
	"  version       print the mfw and mfw-board versions",
].join("\n");

function isExecutable(p: string): boolean {
	try {
		const s = statSync(p);
		return s.isFile() && (s.mode & 0o111) !== 0;
	} catch {
		return false;
	}
}

/** `mfw-board` next to this script, else on PATH; null when neither has it. */
export function findBoardExecutable(
	env: Deps["env"],
	selfDir: string,
): string | null {
	const dirs = [selfDir, ...(env.PATH ?? "").split(delimiter)];
	for (const dir of dirs) {
		if (!dir) continue;
		const p = join(dir, "mfw-board");
		if (isExecutable(p)) return p;
	}
	return null;
}

export function boardMissingMessage(): string {
	return [
		"mfw: cannot find the `mfw-board` executable (looked next to mfw and on PATH).",
		"Fix: put it on PATH (it ships next to `mfw`), or in a source checkout run",
		"`bun install` and use `bun packages/board/src/cli.ts` directly.",
	].join("\n");
}

function versionOf(pkgJson: string): string {
	try {
		return JSON.parse(readFileSync(pkgJson, "utf8")).version ?? "unknown";
	} catch {
		return "unknown";
	}
}

export async function dispatch(argv: string[], d: Deps): Promise<number> {
	const [cmd, ...rest] = argv;
	if (cmd === undefined) {
		d.err(USAGE);
		return 2;
	}
	if (cmd === "--help" || cmd === "-h" || cmd === "help") {
		d.out(USAGE);
		return 0;
	}
	switch (cmd) {
		case "auth":
			return d.runAuth(rest);
		case "host":
			return d.runHost(rest);
		case "board": {
			const exe = findBoardExecutable(d.env, d.selfDir);
			if (exe) return d.run([exe, ...rest]);
			if (d.sourceBoardCli)
				return d.run([d.bun, "run", d.sourceBoardCli, ...rest]);
			d.err(boardMissingMessage());
			return 127;
		}
		case "mcp": {
			if (rest.includes("--help") || rest.includes("-h")) {
				d.out(
					"usage: mfw mcp [--token-file <path>]   (MCP server over stdio; the server must be reachable via MFW_URL)\n\nThe API token comes from --token-file, then MFW_TOKEN, then $MFW_HOME/mcp-token (0600).\nCreate one on the host: mfw auth token create --name mcp --scope board:read --write-file",
				);
				return 0;
			}
			await d.runMcp(rest);
			return 0;
		}
		case "server": {
			if (rest.includes("--help") || rest.includes("-h")) {
				d.out(
					"usage: mfw server   (foreground: orchestrator + web UI on $HOST:$PORT)",
				);
				return 0;
			}
			if (!d.serverEntry) {
				d.err(
					"mfw: the server is not built. Fix: run `bun run build` in the mfw checkout.",
				);
				return 1;
			}
			// The server refuses an unset HOST (Bun would bind every interface).
			if (!d.env.NITRO_HOST && !d.env.HOST) d.env.HOST = "127.0.0.1";
			return d.run([d.bun, "run", d.serverEntry], d.repoRoot);
		}
		case "version": {
			d.out(`mfw ${versionOf(join(d.selfDir, "../package.json"))}`);
			d.out(
				`mfw-board ${versionOf(join(d.repoRoot, "packages/board/package.json"))}`,
			);
			return 0;
		}
		default:
			d.err(
				`mfw: unknown command '${cmd}' (commands: ${SUBCOMMANDS.join(", ")})\n${USAGE}`,
			);
			return 2;
	}
}

function realDeps(): Deps {
	const selfDir = import.meta.dir;
	const repoRoot = resolve(selfDir, "../../..");
	const boardCli = join(repoRoot, "packages/board/src/cli.ts");
	const serverEntry = join(repoRoot, "apps/start/.output/server/index.mjs");
	return {
		env: process.env,
		selfDir,
		sourceBoardCli: existsSync(boardCli) ? boardCli : null,
		serverEntry: existsSync(serverEntry) ? serverEntry : null,
		repoRoot,
		bun: process.execPath,
		out: (l) => console.log(l),
		err: (l) => console.error(l),
		run: async (argv, cwd) => {
			const p = Bun.spawn(argv, {
				cwd,
				stdin: "inherit",
				stdout: "inherit",
				stderr: "inherit",
			});
			return p.exited;
		},
		runMcp: async (args) => {
			// The MCP entry reads process.argv itself; present it as its own script.
			process.argv = [process.argv[0] ?? "bun", "mfw mcp", ...args];
			await import("@mfw/mcp");
		},
		runHost: async (args) => {
			const [{ runHostCommand }, { mfwHome }] = await Promise.all([
				import("../../daemon/src/resources/legacy-host-state.ts"),
				import("../../daemon/src/config.ts"),
			]);
			return runHostCommand(args, {
				home: mfwHome(),
				out: (l) => console.log(l),
				err: (l) => console.error(l),
			});
		},
		runAuth: async (args) => {
			const [{ runAuthCommand }, { mfwHome }] = await Promise.all([
				import("../../daemon/src/auth/cli.ts"),
				import("../../daemon/src/config.ts"),
			]);
			return runAuthCommand(args, {
				home: mfwHome(),
				out: (l) => console.log(l),
				err: (l) => console.error(l),
			});
		},
	};
}

if (import.meta.main) {
	// Read first: `runMcp` replaces `process.argv` for the MCP entry point.
	const isMcp = process.argv[2] === "mcp";
	const wantsHelp =
		process.argv.includes("--help") || process.argv.includes("-h");
	const code = await dispatch(process.argv.slice(2), realDeps());
	// `mcp` keeps the process alive on its stdio transport; everything else exits.
	if (!isMcp || wantsHelp) process.exit(code);
}
