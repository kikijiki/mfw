import type { MfwProject } from "../project.ts";

/**
 * What a command may touch of the process: where it runs, its environment, and
 * its output and input. The real entry passes the process's own; tests pass
 * their own, so a command never reads `process.cwd()`/`process.env` or prints
 * through `console` itself.
 */
export interface CliIo {
	cwd: string;
	env: Record<string, string | undefined>;
	/** One line to stdout (a newline is added). */
	out(line: string): void;
	/** One line to stderr (a newline is added). */
	err(line: string): void;
	/** All of stdin as text (`--body-file -`). */
	stdin(): Promise<string>;
}

/** Everything a command needs besides its own arguments. */
export interface CommandContext extends CliIo {
	project: MfwProject;
	/** Global `--json` flag (commands that have no JSON form ignore it). */
	json: boolean;
}

/** Parsed argv, after the command name and global flags are consumed. */
export interface ParsedArgs {
	/** The command name as typed. */
	command: string;
	/** `--type`, unresolved; use `resolveType(ctx, args)`. */
	type?: string;
	id?: string;
	body?: string;
	/** `--body-file <path>` (create/update): the body from a file, `-` for stdin. */
	bodyFile?: string;
	/** `--dir <dir>` (shim): where the launcher goes. */
	dir?: string;
	/** `--help` / `-h`: print usage and exit 0. */
	help?: boolean;
	baseRev?: number;
	run?: string;
	worktree?: string;
	leaseMs?: number;
	from?: string;
	/** `--under <id>`: restrict to descendants (ready/levels/view). */
	under?: string;
	/** `--format md|tsv|json` (levels/view). */
	format?: string;
	/** `--section <name>` (note). */
	section?: string;
	/** `--if-present` (remove): a missing value is not an error. */
	ifPresent?: boolean;
	/** `--strict` (check): advisory issues fail too. */
	strict: boolean;
	/** `--list` (check): list the rules instead of running them. */
	list: boolean;
	/** `--board-only` (check): skip rules that read outside the board. */
	boardOnly: boolean;
	/** `--root name=path` (check): where a `roots` entry is on this machine. */
	roots?: Record<string, string>;
	/** `--rule a,b` (check): run only these rules (repeatable). */
	rule?: string[];
	/** `--override a,b` (writes): let this write introduce violations of these error rules. */
	override?: string[];
	/** `--all` (graph): include finished documents. */
	all?: boolean;
	/** `--unblocks` (ready): show how much each ready document frees. */
	unblocks?: boolean;
	/** `--max <n>` (plan): at most this many documents in the batch. */
	max?: number;
	/** `--commit` (transition verbs): commit the document afterwards. */
	commit: boolean;
	/** `--push` (transition verbs): implies `commit`, then `git push`. */
	push: boolean;
	/** Every non-flag token in order, untouched (transition text may contain `=`). */
	rest: string[];
	/** `--global` (skill install). */
	global: boolean;
	/** `--here` (skill install/status): use the cwd, not the git root, as the project root. */
	here?: boolean;
	/** `--target <list>` (skill install/status). */
	target?: string;
	/** `--date YYYY-MM-DD` (transition verbs that declare a `date` field). */
	date?: string;
	/** `--dry-run` (skill install). */
	dryRun: boolean;
	/** Tokens like `field=a`, `field~a|b` (operators are interpreted per command). */
	fieldArgs: string[];
	/** Everything else, in order (ids, subcommands). */
	positional: string[];
}

/** Thrown by a command to print `message` and exit with `code` (default 1). */
export class CliError extends Error {
	constructor(
		message: string,
		readonly code = 1,
	) {
		super(message);
	}
}

/** Thrown to print the usage text and exit 2. */
export class UsageError extends Error {}

export interface Command {
	name: string;
	/** Usage lines, shown under "usage:" (one per form). */
	usage: string[];
	/** Whether the command needs a board (default true). `skill` does not. */
	needsBoard?: boolean;
	run(ctx: CommandContext, args: ParsedArgs): Promise<void>;
}
