import { basename } from "node:path";
import type { HarnessManifest } from "./harness.ts";

/**
 * The POSITIVE check on a non-autonomous launch: every argument must be one mfw
 * itself generates for that CLI, with a value of the expected shape. Anything
 * else is refused, whatever it is called, so a bypass spelling nobody has listed
 * still cannot pass. The denylist in `harness-autonomy.ts` is the second layer.
 *
 * The lists below are held in the core and not in a manifest, so a manifest
 * cannot widen them. They are what these build:
 * - Claude: the stream-json options, `--model`, `--session-id`, `--resume`, and
 *   a brain turn's `--mcp-config`, `--strict-mcp-config` and tool lists;
 * - Codex: `app-server`, or `exec [resume <id>] --json --skip-git-repo-check`
 *   with `-m`, `-` for the prompt on stdin, and the `-c` settings in
 *   {@link codexConfigProblem}.
 *
 * Options may be absent: this limits what a launch can add, and does not prove
 * that a protection is present.
 */

type ValueCheck = (value: string) => boolean;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid: ValueCheck = (v) => UUID.test(v);
const isModel: ValueCheck = (v) =>
	/^[A-Za-z0-9][A-Za-z0-9._:/@[\]+-]*$/.test(v);
/** Codex mints its thread ids, so only the shape that cannot be an option. */
const isThreadId: ValueCheck = (v) =>
	/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(v);
const isAbsolute: ValueCheck = (v) =>
	v.startsWith("/") && !v.split("/").includes("..");
const oneOf =
	(...allowed: string[]): ValueCheck =>
	(v) =>
		allowed.includes(v);

const CLAUDE_SWITCHES: ReadonlySet<string> = new Set([
	"--print",
	"-p",
	"--verbose",
	"--include-partial-messages",
	"--replay-user-messages",
	"--strict-mcp-config",
]);

const CLAUDE_VALUES: ReadonlyMap<string, ValueCheck> = new Map([
	["--input-format", oneOf("stream-json")],
	["--output-format", oneOf("stream-json", "json")],
	["--model", isModel],
	["--session-id", isUuid],
	["--resume", isUuid],
	["--mcp-config", isAbsolute],
	[
		"--allowedTools",
		(v: string) => /^mcp__[A-Za-z0-9_-]+__\*,Read,Grep,Glob$/.test(v),
	],
	["--disallowedTools", (v: string) => /^[A-Za-z]+(,[A-Za-z]+)*$/.test(v)],
]);

const VALUE_OPTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
	claude: new Set(CLAUDE_VALUES.keys()),
	codex: new Set(["-m", "-c"]),
};

const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

const isRecord = (v: unknown): v is Record<string, unknown> =>
	v !== null && typeof v === "object" && !Array.isArray(v);

/** Why this `-c` value is not one mfw generates, or null. */
function codexConfigProblem(setting: string, role: string): string | null {
	const refused = "a -c setting mfw does not generate";
	if (setting.includes("\n")) return refused;
	let parsed: unknown;
	try {
		parsed = Bun.TOML.parse(setting);
	} catch {
		return refused;
	}
	if (!isRecord(parsed)) return refused;
	const keys = Object.keys(parsed);
	if (keys.length !== 1) return refused;
	const key = keys[0] as string;
	const value = parsed[key];
	if (key === "model_reasoning_effort")
		return typeof value === "string" && EFFORTS.includes(value)
			? null
			: refused;
	if (key === "sandbox_mode") return value === "read-only" ? null : refused;
	if (key === "model_provider")
		return typeof value === "string" && /^mfw-[A-Za-z0-9_-]+$/.test(value)
			? null
			: refused;
	if (key === "model_providers") {
		if (!isRecord(value)) return refused;
		const names = Object.keys(value);
		const entry = value[names[0] as string];
		if (names.length !== 1 || !/^mfw-[A-Za-z0-9_-]+$/.test(names[0] as string))
			return refused;
		if (!isRecord(entry)) return refused;
		const allowed = ["name", "base_url", "wire_api", "env_key"];
		if (Object.keys(entry).some((k) => !allowed.includes(k))) return refused;
		return entry.wire_api === "responses" &&
			typeof entry.base_url === "string" &&
			/^https?:\/\//.test(entry.base_url)
			? null
			: refused;
	}
	if (key === "mcp_servers" && role === "brain") {
		if (!isRecord(value)) return refused;
		const names = Object.keys(value);
		const server = value[names[0] as string];
		if (names.length !== 1 || !isRecord(server)) return refused;
		const fields = Object.keys(server);
		if (fields.length !== 1) return refused;
		const field = fields[0] as string;
		// The sandbox's copy of the brain's MCP server always starts with bun.
		if (field === "command") return server.command === "bun" ? null : refused;
		return field === "args" || field === "env" ? null : refused;
	}
	return refused;
}

function claudeArgvProblem(args: readonly string[]): string | null {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string;
		if (CLAUDE_SWITCHES.has(arg)) continue;
		const check = CLAUDE_VALUES.get(arg);
		if (!check) return `${arg} is not an option mfw generates`;
		const value = args[++i];
		if (value === undefined || !check(value))
			return `${arg} has a value mfw does not generate`;
	}
	return null;
}

function codexArgvProblem(
	args: readonly string[],
	role: string,
): string | null {
	if (args.length === 0) return null;
	const sub = args[0];
	if (sub !== "app-server" && sub !== "exec")
		return `${sub} is not a subcommand mfw generates`;
	let i = 1;
	if (sub === "exec" && args[1] === "resume") {
		if (!isThreadId(args[2] ?? "")) return "resume needs a thread id";
		i = 3;
	}
	for (; i < args.length; i++) {
		const arg = args[i] as string;
		if (sub === "exec" && arg === "-") {
			if (i !== args.length - 1) return "nothing may follow the stdin prompt";
			continue;
		}
		if (sub === "exec" && (arg === "--json" || arg === "--skip-git-repo-check"))
			continue;
		if (arg === "-m" && sub === "exec") {
			if (!isModel(args[++i] ?? ""))
				return "-m has a value mfw does not generate";
			continue;
		}
		if (arg === "-c") {
			const problem = codexConfigProblem(args[++i] ?? "", role);
			if (problem) return problem;
			continue;
		}
		return `${arg} is not an option mfw generates`;
	}
	return null;
}

/**
 * Why this argv is not one mfw generates for this harness, or null. The command
 * must be the harness's own binary, by name or by a resolved path.
 */
export function launchArgvProblem(
	manifest: Pick<HarnessManifest, "detect" | "fleet">,
	argv: readonly string[],
	role: string,
): string | null {
	const command = argv[0];
	if (command === undefined) return "no command";
	if (basename(command) !== manifest.detect.bin)
		return `${basename(command)} is not ${manifest.detect.bin}`;
	const args = argv.slice(1);
	if (manifest.fleet.cli === "claude") return claudeArgvProblem(args);
	if (manifest.fleet.cli === "codex") return codexArgvProblem(args, role);
	return `${manifest.detect.bin} has no sandboxed launch`;
}

/**
 * The argv of a non-autonomous launch: the manifest's own autonomy arguments
 * removed, and nothing else. An option's value is copied without being looked
 * at, so a value can never be removed and shift the next option into its place.
 */
export function withoutLaunchFlags(
	manifest: Pick<HarnessManifest, "autonomy" | "fleet">,
	argv: readonly string[],
): string[] {
	const launch = manifest.autonomy.launchFlags.map((flag) => {
		const space = flag.indexOf(" ");
		return space < 0 ? [flag] : [flag.slice(0, space), flag.slice(space + 1)];
	});
	const valued = VALUE_OPTIONS[manifest.fleet.cli ?? ""] ?? new Set<string>();
	const out: string[] = [];
	for (let i = 0; i < argv.length; ) {
		const found = launch.find((parts) =>
			parts.every((part, at) => argv[i + at] === part),
		);
		if (found) {
			i += found.length;
		} else if (valued.has(argv[i] as string) && i + 1 < argv.length) {
			out.push(argv[i] as string, argv[i + 1] as string);
			i += 2;
		} else {
			out.push(argv[i] as string);
			i += 1;
		}
	}
	return out;
}
