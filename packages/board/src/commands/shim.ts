import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { CliError, type Command, UsageError } from "./types.ts";

/** First line after the shebang; `install` only ever overwrites a file that has it. */
const MARKER = "# mfwb-shim (written by `mfwb shim install`)";

const cliPath = () => resolve(import.meta.dir, "../cli.ts");

/** POSIX single-quoting, so a checkout path with spaces or quotes stays one word. */
const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

function shimText(): string {
	return `#!/bin/sh\n${MARKER}\nexec bun ${quote(cliPath())} "$@"\n`;
}

type State = "installed" | "outdated" | "missing" | "foreign";

/** Only a regular file we wrote (marker on line 2) is ours; a symlink, a
 * directory or any other file is `foreign`, so install never writes through it. */
function stateOf(path: string): State {
	let st: ReturnType<typeof lstatSync>;
	try {
		st = lstatSync(path);
	} catch {
		return "missing";
	}
	if (!st.isFile()) return "foreign";
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return "foreign";
	}
	if (text.split("\n", 2)[1] !== MARKER) return "foreign";
	return text === shimText() ? "installed" : "outdated";
}

const real = (p: string): string => {
	try {
		return realpathSync(p);
	} catch {
		return resolve(p);
	}
};

const dirOnPath = (dir: string): boolean =>
	(process.env.PATH ?? "")
		.split(delimiter)
		.filter((e) => e !== "")
		.some((e) => real(e) === real(dir));

/**
 * Puts a stable `mfwb` on PATH: a two-line `sh` script that execs this
 * checkout's CLI under bun. Like `skill install` it is a plain file write, it
 * never replaces a file it did not write, and re-running it is a no-op.
 */
export const shim: Command = {
	name: "shim",
	usage: [
		"shim install [--dir <dir>] [--dry-run]   (write an `mfwb` launcher into <dir>, default ~/.local/bin)",
		"shim status [--dir <dir>]",
	],
	needsBoard: false,
	async run(ctx, args) {
		const verb = args.positional[0];
		if (
			(verb !== "install" && verb !== "status") ||
			args.positional.length > 1
		) {
			throw new UsageError();
		}
		if (args.dir?.startsWith("~")) {
			throw new CliError(
				`--dir '${args.dir}': '~' is not expanded here; pass an absolute path`,
				2,
			);
		}
		const dir = resolve(
			args.dir ?? join(process.env.HOME || homedir(), ".local/bin"),
		);
		const path = join(dir, "mfwb");
		const state = stateOf(path);
		const onPath = dirOnPath(dir);
		if (verb === "status") {
			if (ctx.json) {
				console.log(JSON.stringify({ path, state, onPath, target: cliPath() }));
			} else {
				console.log(`${path} ${state}${onPath ? "" : " (dir not on PATH)"}`);
			}
			return;
		}
		if (!existsSync(cliPath())) {
			throw new CliError(`cannot find the CLI at ${cliPath()}`, 3);
		}
		if (state === "foreign") {
			throw new CliError(
				`${path} exists and was not written by mfwb; move it or pass --dir`,
			);
		}
		if (state === "installed") {
			console.log(`up-to-date ${path}`);
		} else {
			if (!args.dryRun) {
				// Temp file + rename: a concurrent `mfwb` never sees a partial or
				// non-executable script, and rename replaces rather than follows.
				const tmp = `${path}.${process.pid}.tmp`;
				try {
					mkdirSync(dir, { recursive: true });
					writeFileSync(tmp, shimText(), { mode: 0o755, flag: "wx" });
					renameSync(tmp, path);
				} catch (e) {
					throw new CliError(
						`cannot write ${path}: ${e instanceof Error ? e.message : String(e)}`,
						3,
					);
				}
			}
			console.log(`${args.dryRun ? "would install" : "installed"} ${path}`);
		}
		if (!onPath) console.error(`note: ${dir} is not on PATH`);
	},
};
