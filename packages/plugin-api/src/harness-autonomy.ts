import type { HarnessAutonomy } from "./harness.ts";

/**
 * A DENYLIST of the arguments that make an agent CLI act without asking. It is
 * defence in depth and cannot be complete: a vendor can add a spelling at any
 * release. What keeps a non-autonomous launch honest is the POSITIVE check in
 * `harness-launch.ts`, which refuses anything mfw did not generate.
 *
 * Covered here: exact flags, the name patterns below, `--opt=value`, attached
 * short values (`-anever`), clustered short flags (`-yd`), case and `_`/`-`
 * variants of long names and values, `-c` values read as TOML (quoted keys,
 * triple quotes, comments, several lines), config indirection (`--settings`,
 * `--profile`, `-c profile=`) and a command hidden behind a wrapper (`sh -c`,
 * `env`, `xargs`). Not covered: what a config FILE or an environment variable
 * turns on, and a bypass spelled in a way no rule here anticipates.
 *
 * The table is {@link KNOWN_AUTONOMY} joined with what the loaded manifests
 * declare, so a manifest can add to it and can never remove from it.
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

/** Options that load settings from elsewhere, so any value can grant autonomy. */
const CONFIG_INDIRECTION: ReadonlySet<string> = new Set([
	"--settings",
	"--profile",
]);

/** `-c` roots that change approvals or the sandbox whatever their value. */
const CONFIG_ROOTS: ReadonlySet<string> = new Set([
	"profile",
	"profiles",
	"approvals_reviewer",
	"sandbox_workspace_write",
]);

/** Programs that run another command, which hides that command's flags. */
const WRAPPERS: ReadonlySet<string> = new Set([
	"ash",
	"bash",
	"busybox",
	"command",
	"dash",
	"doas",
	"env",
	"exec",
	"fish",
	"ionice",
	"ksh",
	"nice",
	"nohup",
	"setsid",
	"sh",
	"stdbuf",
	"sudo",
	"timeout",
	"unshare",
	"xargs",
	"zsh",
]);

export function isWrapperCommand(command: string): boolean {
	return WRAPPERS.has(command.slice(command.lastIndexOf("/") + 1));
}

/** A long option's name in one spelling; a short option is case-sensitive. */
const optionName = (name: string) =>
	name.startsWith("--") ? name.toLowerCase().replace(/_/g, "-") : name;

const optionValue = (value: string) => value.toLowerCase().replace(/_/g, "-");

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
		for (const f of data.flags) flags.add(optionName(f));
		for (const v of data.values)
			add(values, optionName(v.option), optionValue(v.value));
		for (const c of data.config) add(config, c.key, optionValue(c.value));
		for (const o of data.configOptions) configOptions.add(o);
	}
	return { flags, values, config, configOptions };
}

const unquoted = (value: string) => value.trim().replace(/^["']|["']$/g, "");

/** Every `dotted.key` and scalar value in a parsed TOML table. */
function tomlLeaves(
	value: unknown,
	path: string[] = [],
): [string[], unknown][] {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		return [[path, value]];
	return Object.entries(value).flatMap(([key, inner]) =>
		tomlLeaves(inner, [...path, key]),
	);
}

function settingGrantsAutonomy(
	table: AutonomyTable,
	path: readonly string[],
	value: unknown,
): boolean {
	if (CONFIG_ROOTS.has(path[0] ?? "")) return true;
	const wanted = table.config.get(path.join("."));
	return (
		typeof value === "string" && (wanted?.has(optionValue(value)) ?? false)
	);
}

/**
 * Read as TOML and also as the raw `key=value` text, because Codex takes a value
 * that is not valid TOML as a plain string. Either reading can trip this.
 */
function isAutonomyConfig(table: AutonomyTable, setting: string): boolean {
	const at = setting.indexOf("=");
	if (at < 0) return false;
	const key = unquoted(setting.slice(0, at));
	if (
		settingGrantsAutonomy(
			table,
			key.split("."),
			unquoted(setting.slice(at + 1)),
		)
	)
		return true;
	try {
		return tomlLeaves(Bun.TOML.parse(setting)).some(([path, value]) =>
			settingGrantsAutonomy(table, path, value),
		);
	} catch {
		// Several lines that do not parse cannot be read, so they cannot be cleared.
		return setting.includes("\n");
	}
}

/** How many arguments at `i` grant autonomy: 0, 1, or 2 for an option and value. */
function autonomySpan(
	table: AutonomyTable,
	argv: readonly string[],
	i: number,
): number {
	const arg = argv[i] as string;
	if (i === 0 && isWrapperCommand(arg)) return 1;
	const eqAt = arg.indexOf("=");
	const name = optionName(eqAt < 0 ? arg : arg.slice(0, eqAt));
	const next = argv[i + 1];
	if (table.flags.has(name)) return 1;
	if (CONFIG_INDIRECTION.has(name)) {
		return eqAt < 0 && next !== undefined && !next.startsWith("-") ? 2 : 1;
	}
	if (looksAutonomous(arg)) {
		// `--auto-approve true`: the value goes with the flag.
		return eqAt < 0 && next !== undefined && /^(true|yes|1)$/i.test(next)
			? 2
			: 1;
	}
	const wanted = table.values.get(name);
	if (wanted) {
		if (eqAt >= 0)
			return wanted.has(optionValue(unquoted(arg.slice(eqAt + 1)))) ? 1 : 0;
		return next !== undefined && wanted.has(optionValue(unquoted(next)))
			? 2
			: 0;
	}
	if (table.configOptions.has(name)) {
		if (eqAt >= 0) return isAutonomyConfig(table, arg.slice(eqAt + 1)) ? 1 : 0;
		return next !== undefined && isAutonomyConfig(table, next) ? 2 : 0;
	}
	if (!/^-[A-Za-z]./.test(arg)) return 0;
	// A short option with its value attached: `-anever`, `-capproval_policy=never`.
	const short = arg.slice(0, 2);
	const attached = arg.slice(2);
	const shortValues = table.values.get(short);
	if (shortValues?.has(optionValue(unquoted(attached)))) return 1;
	if (table.configOptions.has(short) && isAutonomyConfig(table, attached))
		return 1;
	// A cluster of short switches: `-yd`, `-fp`.
	if (/^-[A-Za-z]{2,}$/.test(arg))
		for (const letter of arg.slice(1))
			if (table.flags.has(`-${letter}`)) return 1;
	return 0;
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
