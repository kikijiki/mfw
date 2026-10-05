import type { MfwProject } from "../project.ts";

/** Everything a command needs besides its own arguments. */
export interface CommandContext {
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
	/** `--check` (ready). */
	check: boolean;
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
