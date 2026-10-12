#!/usr/bin/env bun
import { RuleViolationError } from "@mfw/board-core";
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
		"Writes refused by an error rule of the board can be let through with",
		"--override <rule[,rule]> (check always reports every violation).",
		"",
		"The board is found from the cwd upward (board.yaml),",
		"or given with --config <board.yaml> / MFW_BOARD.",
		"",
		"exit codes: 0 ok; 1 command failed (for check: an error-severity issue);",
		"2 usage error; 3 board/config/environment error (no board found, invalid",
		"board.yaml, an unreadable file a check needs).",
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
	"--rule",
	"--override",
	"--root",
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
		strict: false,
		list: false,
		boardOnly: false,
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
			else if (a === "--root") {
				const eq = v.indexOf("=");
				if (eq <= 0 || eq === v.length - 1) {
					throw new UsageError(`--root needs name=path, got '${v}'`);
				}
				args.roots = {
					...(args.roots ?? {}),
					[v.slice(0, eq)]: v.slice(eq + 1),
				};
			} else if (a === "--override")
				args.override = [
					...(args.override ?? []),
					...v.split(",").filter((x) => x.length > 0),
				];
			else if (a === "--rule")
				args.rule = [
					...(args.rule ?? []),
					...v.split(",").filter((x) => x.length > 0),
				];
			else config = v;
		} else if (a === "--json") json = true;
		else if (a === "--if-present") args.ifPresent = true;
		else if (a === "--global") args.global = true;
		else if (a === "--here") args.here = true;
		else if (a === "--dry-run") args.dryRun = true;
		else if (a === "--strict") args.strict = true;
		else if (a === "--list") args.list = true;
		else if (a === "--board-only") args.boardOnly = true;
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
		project = await openMfwProject(process.cwd(), {
			configPath: config,
			...(args.override ? { overrideRules: args.override } : {}),
			onOverride: ({ type, id, violation }) =>
				console.error(
					`override: ${violation.rule} on ${type} ${id}: ${violation.message}`,
				),
		});
	} catch (e) {
		// No board, ambiguous board, unreadable or invalid board.yaml.
		throw new CliError(e instanceof Error ? e.message : String(e), 3);
	}
	loaded = project;
	for (const r of args.override ?? []) {
		const known = Object.values(project.config.types)
			.flatMap((t) => t.rules ?? [])
			.find((x) => x.id === r);
		if (known?.severity !== "error") {
			throw new CliError(
				`--override '${r}': not an error-severity rule of this board${known ? " (advisory rules never block a write)" : ""}`,
				2,
			);
		}
	}
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
	if (e instanceof RuleViolationError) {
		const rules = [...new Set(e.violations.map((v) => v.rule))];
		console.error(
			`${e.message}\n(override on purpose with --override ${rules.join(",")})`,
		);
		process.exit(1);
	}
	console.error(e instanceof Error ? e.message : String(e));
	process.exit(1);
});
