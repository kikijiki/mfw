#!/usr/bin/env bun
import { commands } from "./commands/index.ts";
import {
	lookupTransitionCommand,
	transitionUsage,
} from "./commands/transition.ts";
import { CliError, type ParsedArgs, UsageError } from "./commands/types.ts";
import { type MfwProject, openMfwProject } from "./project.ts";

let loaded: MfwProject | undefined;
let configFlag: string | undefined;

/**
 * mfwb: the board CLI. This file is only the dispatcher (global flags, board
 * discovery, command lookup, usage); every command lives in `commands/`.
 */

function usageText(project?: MfwProject): string {
	const lines = [
		"usage: mfwb [--config <board.yaml>] [--json] <command> ...",
		"",
	];
	for (const c of commands) for (const u of c.usage) lines.push(`  ${u}`);
	if (project) {
		const t = transitionUsage(project);
		if (t.length > 0) {
			lines.push("", "transition verbs (from this board's config):");
			for (const u of t) lines.push(`  ${u}`);
			lines.push(
				"  (text is required exactly when the verb takes it; --commit commits only",
				"  that document, --push implies --commit)",
			);
		}
	}
	lines.push(
		"",
		"The board is found from the cwd upward (board.yaml, then .mfw/board.yaml),",
		"or given with --config <board.yaml> / MFW_BOARD.",
		"",
		"exit codes: 0 ok; 1 command failed; 2 usage error; 3 board/config error",
		"(no board found, unreadable or invalid board.yaml); validate failures:",
		"10 document, 11 id, 12 reference, 13 hierarchy, 14 cycle (the lowest code",
		"among the classes present; --json lists every issue).",
	);
	return lines.join("\n");
}

interface Parsed {
	args: ParsedArgs;
	config?: string;
	json: boolean;
}

const VALUE_FLAGS = new Set([
	"--type",
	"--id",
	"--body",
	"--base-rev",
	"--run",
	"--worktree",
	"--lease-ms",
	"--from",
	"--config",
	"--under",
	"--format",
	"--section",
	"--target",
	"--date",
	"--max",
]);

/** A non-negative integer flag value, or a usage error naming the flag. */
function intFlag(flag: string, v: string): number {
	if (!/^\d+$/.test(v) || !Number.isSafeInteger(Number(v))) {
		throw new UsageError(`${flag} needs a non-negative integer, got '${v}'`);
	}
	return Number(v);
}

function parseArgv(argv: string[]): Parsed {
	const args: ParsedArgs = {
		command: "",
		global: false,
		dryRun: false,
		check: false,
		commit: false,
		push: false,
		rest: [],
		fieldArgs: [],
		positional: [],
	};
	let config: string | undefined;
	let json = false;
	const loose: string[] = [];
	let terminated = false;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i] as string;
		if (terminated) loose.push(a);
		else if (a === "--") terminated = true;
		else if (VALUE_FLAGS.has(a)) {
			const v = argv[++i];
			if (v === undefined) throw new UsageError(`${a} needs a value`);
			if (a === "--type") args.type = v;
			else if (a === "--id") args.id = v;
			else if (a === "--body") args.body = v;
			else if (a === "--base-rev") args.baseRev = intFlag(a, v);
			else if (a === "--run") args.run = v;
			else if (a === "--worktree") args.worktree = v;
			else if (a === "--lease-ms") args.leaseMs = intFlag(a, v);
			else if (a === "--from") args.from = v;
			else if (a === "--under") args.under = v;
			else if (a === "--format") args.format = v;
			else if (a === "--section") args.section = v;
			else if (a === "--target") args.target = v;
			else if (a === "--date") args.date = v;
			else if (a === "--max") args.max = intFlag(a, v);
			else config = v;
		} else if (a === "--json") json = true;
		else if (a === "--if-present") args.ifPresent = true;
		else if (a === "--global") args.global = true;
		else if (a === "--here") args.here = true;
		else if (a === "--dry-run") args.dryRun = true;
		else if (a === "--check") args.check = true;
		else if (a === "--all") args.all = true;
		else if (a === "--unblocks") args.unblocks = true;
		else if (a === "--commit") args.commit = true;
		else if (a === "--push") args.push = args.commit = true;
		else if (a.startsWith("--"))
			throw new UsageError(
				`unknown flag ${a} (to pass text that starts with --, put it after a bare --)`,
			);
		else loose.push(a);
	}
	const command = loose.shift();
	if (!command) throw new UsageError();
	args.command = command;
	args.rest = [...loose];
	for (const a of loose) {
		if (a.includes("=") || a.includes("~")) args.fieldArgs.push(a);
		else args.positional.push(a);
	}
	return { args, config, json };
}

async function main(): Promise<void> {
	const { args, config, json } = parseArgv(process.argv.slice(2));
	configFlag = config;
	const cmd = commands.find((c) => c.name === args.command);
	// Commands that don't need a board work from any directory.
	if (cmd && cmd.needsBoard === false) {
		// biome-ignore lint/suspicious/noExplicitAny: no project for board-less commands
		await cmd.run({ project: undefined as any, json }, args);
		return;
	}
	let project: MfwProject;
	try {
		project = await openMfwProject(process.cwd(), { configPath: config });
	} catch (e) {
		// No board, ambiguous board, unreadable or invalid board.yaml.
		throw new CliError(e instanceof Error ? e.message : String(e), 3);
	}
	loaded = project;
	const target = cmd ?? lookupTransitionCommand(project, args.command);
	if (!target) throw new UsageError();
	await target.run({ project, json }, args);
}

main().catch(async (e) => {
	if (e instanceof UsageError) {
		if (!loaded) {
			try {
				loaded = await openMfwProject(process.cwd(), {
					configPath: configFlag,
				});
			} catch {
				// no board: usage shows only the static commands
			}
		}
		if (e.message) console.error(`${e.message}\n`);
		console.error(usageText(loaded));
		process.exit(2);
	}
	if (e instanceof CliError) {
		if (e.message) console.error(e.message);
		process.exit(e.code);
	}
	console.error(e instanceof Error ? e.message : String(e));
	process.exit(1);
});
