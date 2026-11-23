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
 */
export const KNOWN_AUTONOMY: AutonomyData = {
	flags: [
		"--dangerously-skip-permissions",
		"--allow-dangerously-skip-permissions",
		"--dangerously-bypass-approvals-and-sandbox",
		"--full-auto",
		"--yolo",
	],
	values: [
		{ option: "--permission-mode", value: "bypassPermissions" },
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
