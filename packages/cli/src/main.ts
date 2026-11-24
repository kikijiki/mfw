#!/usr/bin/env bun
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pinnedToolIn } from "../../daemon/src/sandbox.ts";
import { runForwarding } from "./run-child.ts";

/**
 * `mfw`: the one dispatcher. It owns no logic of its own; each subcommand is
 * either another executable (`board` -> `mfw-board`, so the board tool stays
 * usable without the server) or a module run in this process (`mcp`).
 *
 * The same code runs from a checkout (`bun packages/cli/src/main.ts`) and as
 * the compiled executable (`compiled-main.ts`); `Deps` carries the difference.
 */

const SUBCOMMANDS = [
	"auth",
	"board",
	"doctor",
	"env",
	"init",
	"mcp",
	"server",
	"version",
] as const;

export interface Deps {
	env: Record<string, string | undefined>;
	/** Directory of this script (or executable); `mfw-board` is looked up here first. */
	selfDir: string;
	/** A `mfw-board` on PATH, only from a directory agents cannot write. */
	trustedOnPath?: (name: string, pathVar: string | undefined) => string | null;
	/** Why the `mfw-board` beside this executable must not run, or null (the install's hash check). */
	siblingProblem?: (path: string) => string | null;
	/** `mfw __host ...` (compiled only). Resolves to an exit code, or null while an entry runs. */
	runHostExec?: (args: string[]) => Promise<number | null>;
	/** The lines `mfw version` prints. */
	versionLines?: () => Promise<string[]>;
	/** A compiled install's server: the verified runtime and bundle, or why it cannot start. */
	serverCommand?: () => { argv: string[]; cwd: string } | { error: string };
	/** The board CLI source in a checkout (fallback when no executable is found). */
	sourceBoardCli: string | null;
	/** The built server entry (`bun run build`), or null when absent. */
	serverEntry: string | null;
	repoRoot: string;
	/** The bun binary that runs source and the server (this process's own). */
	bun: string;
	out: (line: string) => void;
	err: (line: string) => void;
	/** Runs a child with inherited stdio, forwarding SIGTERM/SIGINT/SIGHUP; resolves to the code to exit with. */
	run: (argv: string[], cwd?: string) => Promise<number>;
	/** Runs the MCP stdio server in this process (resolves when it is set up). */
	runMcp: (args: string[]) => Promise<void>;
	/** Runs `mfw auth ...` against this install's auth store. */
	runAuth: (args: string[]) => Promise<number>;
	/** Runs `mfw env ...` against this install's dev environment approvals. */
	runEnv: (args: string[]) => Promise<number>;
	/** Runs the read-only `mfw doctor`, or `mfw init`. */
	runDoctor: (command: "doctor" | "init", args: string[]) => Promise<number>;
}

export const USAGE = [
	"usage: mfw <command> [args]",
	"",
	"  auth ...      owner tools: token, passkey, unlock, setup-token, sign-out-everywhere, reset",
	"  board ...     the markdown board (runs mfw-board; no server needed)",
	"  doctor        read-only host and install check; prints fixes, applies none",
	"  env ...       owner tools for each project's dev environment: status, allow, deny, build",
	"  init          guided first run: doctor, setup token path, minimal project config",
	"  mcp [--token-file <path>]   MCP server over stdio, using a scoped API token",
	"  server        run mfw-server (engine, API and web UI) in the foreground",
	"  version       print the versions, the build and its integrity hashes",
].join("\n");

function isExecutable(p: string): boolean {
	try {
		const s = statSync(p);
		return s.isFile() && (s.mode & 0o111) !== 0;
	} catch {
		return false;
	}
}

/**
 * `mfw-board` next to this executable, else on PATH from a directory agents
 * cannot write (the trusted-binary rule of `sandbox.ts`); null when neither
 * has it. A copy in a writable PATH directory is never run: it could be an
 * agent's.
 */
export function findBoardExecutable(
	env: Deps["env"],
	selfDir: string,
	trustedOnPath: NonNullable<Deps["trustedOnPath"]> = (name, pathVar) =>
		pinnedToolIn(name, pathVar),
): string | null {
	const sibling = join(selfDir, "mfw-board");
	if (isExecutable(sibling)) return sibling;
	return trustedOnPath("mfw-board", env.PATH);
}

export function boardMissingMessage(): string {
	return [
		"mfw: cannot find the `mfw-board` executable (looked next to mfw, and on PATH",
		"in directories agents cannot write).",
		"Fix: install it next to `mfw` (they ship together), or in a source checkout",
		"run `bun install` and use `bun packages/board/src/cli.ts` directly.",
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
		case "env":
			return d.runEnv(rest);
		case "doctor":
		case "init":
			return d.runDoctor(cmd, rest);
		case "__host": {
			if (!d.runHostExec) {
				d.err(
					"mfw: `mfw __host` is internal to a compiled mfw; from a checkout the server runs its scripts directly",
				);
				return 78;
			}
			const code = await d.runHostExec(rest);
			return code ?? 0;
		}
		case "board": {
			const exe = findBoardExecutable(d.env, d.selfDir, d.trustedOnPath);
			if (exe) {
				const problem =
					exe === join(d.selfDir, "mfw-board") ? d.siblingProblem?.(exe) : null;
				if (problem) {
					d.err(`mfw: refusing to run ${exe}: ${problem}`);
					return 78;
				}
				return d.run([exe, ...rest]);
			}
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
					"usage: mfw server   (mfw-server in the foreground: engine, API and web UI on $HOST:$PORT)",
				);
				return 0;
			}
			if (d.serverCommand) {
				const command = d.serverCommand();
				if ("error" in command) {
					d.err(`mfw: ${command.error}`);
					return 1;
				}
				if (!d.env.NITRO_HOST && !d.env.HOST) d.env.HOST = "127.0.0.1";
				return d.run(command.argv, command.cwd);
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
			const lines = d.versionLines
				? await d.versionLines()
				: [
						`mfw ${versionOf(join(d.selfDir, "../package.json"))} (source)`,
						`mfw-board ${versionOf(join(d.repoRoot, "packages/board/package.json"))}`,
						`bun ${Bun.version}`,
					];
			for (const line of lines) d.out(line);
			return 0;
		}
		default:
			d.err(
				`mfw: unknown command '${cmd}' (commands: ${SUBCOMMANDS.join(", ")})\n${USAGE}`,
			);
			return 2;
	}
}

/** The real dependencies when run from a checkout. */
export function sourceDeps(): Deps {
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
		...inProcessCommands(),
	};
}

/** The commands that run in this process, the same from source and compiled. */
export function inProcessCommands(): Pick<
	Deps,
	"out" | "err" | "run" | "runMcp" | "runDoctor" | "runAuth" | "runEnv"
> {
	return {
		out: (l) => console.log(l),
		err: (l) => console.error(l),
		run: (argv, cwd) => runForwarding(argv, cwd),
		runMcp: async (args) => {
			// The MCP entry reads process.argv itself; present it as its own script.
			process.argv = [process.argv[0] ?? "bun", "mfw mcp", ...args];
			await import("@mfw/mcp");
		},
		runDoctor: async (command, args) => {
			const [{ runDoctorCommand, runInitCommand }, { mfwHome }, policy] =
				await Promise.all([
					import("../../daemon/src/doctor/cli.ts"),
					import("../../daemon/src/config.ts"),
					import("../../../apps/start/src/server/exposure.ts"),
				]);
			const deps = {
				env: process.env,
				home: mfwHome(),
				out: (l: string) => console.log(l),
				err: (l: string) => console.error(l),
				// Judged as `mfw server` would start from this shell, which defaults HOST.
				exposure: (env: Record<string, string | undefined>) => {
					const served =
						env.NITRO_HOST || env.HOST ? env : { ...env, HOST: "127.0.0.1" };
					return {
						problem: policy.checkExposure(served),
						warnings: policy.exposureWarnings(served),
					};
				},
			};
			return command === "doctor"
				? runDoctorCommand(args, deps)
				: runInitCommand(args, deps);
		},
		runEnv: async (args) => {
			const [{ runEnvCommand }, { mfwHome }] = await Promise.all([
				import("../../daemon/src/containment/dev-env-cli.ts"),
				import("../../daemon/src/config.ts"),
			]);
			return runEnvCommand(args, {
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

/**
 * Run `mfw` as this process. `mcp` and a host entry keep the process alive on
 * their own work; every other command exits with its code.
 */
export async function main(argv: string[], deps: Deps): Promise<void> {
	// Read first: `runMcp` replaces `process.argv` for the MCP entry point.
	const stays = argv[0] === "mcp" || argv[0] === "__host";
	const wantsHelp = argv.includes("--help") || argv.includes("-h");
	const code = await dispatch(argv, deps);
	if (argv[0] === "__host" && code !== 0) process.exit(code);
	if (!stays || (argv[0] === "mcp" && wantsHelp)) process.exit(code);
}

if (import.meta.main) await main(process.argv.slice(2), sourceDeps());
