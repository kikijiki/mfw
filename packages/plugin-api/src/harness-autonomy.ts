import type { HarnessAutonomy } from "./harness.ts";

/**
 * Recognises the arguments that make an agent CLI act without asking. Pure and
 * table-driven: the table is {@link KNOWN_AUTONOMY} joined with what the loaded
 * manifests declare, so a manifest can add to it and can never remove from it.
 */

export interface AutonomyTable {
	flags: ReadonlySet<string>;
	/** Option name to the values that grant autonomy. */
	values: ReadonlyMap<string, ReadonlySet<string>>;
	/** `-c` key to the values that grant autonomy. */
	config: ReadonlyMap<string, ReadonlySet<string>>;
	configOptions: ReadonlySet<string>;
}

type AutonomyData = Pick<
	HarnessAutonomy,
	"flags" | "values" | "config" | "configOptions"
>;

/**
 * The floor, held in the core and not in any manifest. Removing a harness or
 * shipping a manifest that omits a flag cannot make the gate forget it.
 * `-y`, `-f` and `--force` mean other things to other programs; a false match
 * only makes a launch need authorization, so they are listed for every CLI.
 */
export const KNOWN_AUTONOMY: AutonomyData = {
	flags: [
		"--dangerously-skip-permissions",
		"--allow-dangerously-skip-permissions",
		"--dangerously-bypass-approvals-and-sandbox",
		"--full-auto",
		"--yolo",
		"--approve-for-me",
		// Gemini's short form of --yolo.
		"-y",
		// Cursor's "run everything".
		"--force",
		"-f",
		"--approve-mcps",
		// pi: trust the project's config. `--no-approve` is the opposite.
		"--approve",
	],
	values: [
		{ option: "--permission-mode", value: "bypassPermissions" },
		{ option: "--permission-mode", value: "auto" },
		{ option: "--permission-mode", value: "acceptEdits" },
		{ option: "--approval-mode", value: "yolo" },
		{ option: "--approval-mode", value: "auto_edit" },
		{ option: "--ask-for-approval", value: "never" },
		{ option: "-a", value: "never" },
		{ option: "--sandbox", value: "danger-full-access" },
		{ option: "-s", value: "danger-full-access" },
	],
	config: [
		{ key: "approval_policy", value: "never" },
		{ key: "sandbox_mode", value: "danger-full-access" },
	],
	configOptions: ["-c", "--config"],
};

/**
 * Long flags that read as "do not ask", whether or not any CLI is known to have
 * them, so a new vendor spelling is caught before anyone lists it. Matched on
 * the lower-cased name with `_` as `-`. Deliberately broad: `--not-so-yolo`
 * matches too. `--no-approve` does not, because it withholds approval.
 */
const AUTONOMY_NAME_PATTERNS: readonly RegExp[] = [
	/(^|-)yolo(-|$)/,
	/^(allow-)?dangerously(-|$)/,
	/^no-(ask|approvals?|confirm|confirmations?|permissions?|prompts?)(-|$)/,
	/^skip-(approvals?|confirm|confirmations?|permissions?)(-|$)/,
	/^bypass(-|$)/,
	/^auto-?approve(-|$)/,
	/^always-approve(-|$)/,
	/^approve-(all|everything)(-|$)/,
	/^(accept|allow|trust)-all(-|$)/,
	/^yes-(all|always)$/,
	/^unrestricted$/,
];

/** True for a `--long-flag` whose name reads as turning approval off. */
export function looksAutonomous(arg: string): boolean {
	if (!arg.startsWith("--") || arg.length === 2) return false;
	const name = arg.slice(2).split("=", 1)[0]?.toLowerCase().replace(/_/g, "-");
	return AUTONOMY_NAME_PATTERNS.some((re) => re.test(name ?? ""));
}

export function buildAutonomyTable(
	declared: readonly AutonomyData[],
): AutonomyTable {
	const flags = new Set<string>();
	const values = new Map<string, Set<string>>();
	const config = new Map<string, Set<string>>();
	const configOptions = new Set<string>();
	const add = (map: Map<string, Set<string>>, key: string, value: string) => {
		const set = map.get(key) ?? new Set<string>();
		set.add(value);
		map.set(key, set);
	};
	for (const data of [KNOWN_AUTONOMY, ...declared]) {
		for (const f of data.flags) flags.add(f);
		for (const v of data.values) add(values, v.option, v.value);
		for (const c of data.config) add(config, c.key, c.value);
		for (const o of data.configOptions) configOptions.add(o);
	}
	return { flags, values, config, configOptions };
}

const unquoted = (value: string) => value.trim().replace(/^["']|["']$/g, "");

function isAutonomyConfig(table: AutonomyTable, setting: string): boolean {
	const at = setting.indexOf("=");
	if (at < 0) return false;
	const wanted = table.config.get(setting.slice(0, at).trim());
	return wanted?.has(unquoted(setting.slice(at + 1))) ?? false;
}

/** How many arguments at `i` grant autonomy: 0, 1, or 2 for an option and value. */
function autonomySpan(
	table: AutonomyTable,
	argv: readonly string[],
	i: number,
): number {
	const arg = argv[i] as string;
	const eqAt = arg.indexOf("=");
	if (table.flags.has(eqAt < 0 ? arg : arg.slice(0, eqAt))) return 1;
	const next = argv[i + 1];
	if (looksAutonomous(arg)) {
		// `--auto-approve true`: the value goes with the flag.
		return eqAt < 0 && next !== undefined && /^(true|yes|1)$/i.test(next)
			? 2
			: 1;
	}
	const wanted = table.values.get(arg);
	if (wanted) {
		return next !== undefined && wanted.has(unquoted(next)) ? 2 : 0;
	}
	if (table.configOptions.has(arg)) {
		return next !== undefined && isAutonomyConfig(table, next) ? 2 : 0;
	}
	if (eqAt < 0) return 0;
	const name = arg.slice(0, eqAt);
	const value = arg.slice(eqAt + 1);
	const wantedValue = table.values.get(name);
	if (wantedValue) return wantedValue.has(unquoted(value)) ? 1 : 0;
	return table.configOptions.has(name) && isAutonomyConfig(table, value)
		? 1
		: 0;
}

export function findAutonomyFlags(
	table: AutonomyTable,
	argv: readonly string[],
): string[] {
	const out: string[] = [];
	for (let i = 0; i < argv.length; ) {
		const span = autonomySpan(table, argv, i);
		if (span > 0) out.push(argv.slice(i, i + span).join(" "));
		i += span || 1;
	}
	return out;
}

export function stripAutonomyFlags(
	table: AutonomyTable,
	argv: readonly string[],
): string[] {
	const out: string[] = [];
	for (let i = 0; i < argv.length; ) {
		const span = autonomySpan(table, argv, i);
		if (span === 0) out.push(argv[i] as string);
		i += span || 1;
	}
	return out;
}
