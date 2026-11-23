import { PROVIDER_CATALOGUE } from "./catalogue.ts";

/**
 * The environment of a one-shot inference CLI. The prompt carries
 * agent-written text, so the child must not inherit the daemon's environment:
 * only what a CLI needs to start and find its own login, plus the API key
 * variables its catalogue entry declares.
 */
const BASE_VARS = [
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"TZ",
	"TMPDIR",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_CACHE_HOME",
	"XDG_STATE_HOME",
	"CLAUDE_CONFIG_DIR",
	"CODEX_HOME",
] as const;

export function inferenceEnv(
	providerId: string,
	source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
	const entry = PROVIDER_CATALOGUE.find((p) => p.id === providerId);
	const keys = entry?.auth.flatMap((a) => a.envVars ?? []) ?? [];
	const env: Record<string, string> = {};
	for (const name of [...BASE_VARS, ...keys]) {
		const value = source[name];
		if (value !== undefined) env[name] = value;
	}
	return env;
}
