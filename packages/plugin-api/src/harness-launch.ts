import type { HarnessManifest } from "./harness.ts";

/**
 * What mfw itself puts on a sandboxed CLI's command line. Held in the core and
 * not in a manifest, so a manifest cannot widen it.
 */
const VALUE_OPTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
	claude: new Set([
		"--input-format",
		"--output-format",
		"--model",
		"--session-id",
		"--resume",
		"--mcp-config",
		"--allowedTools",
		"--disallowedTools",
	]),
	codex: new Set(["-m", "-c"]),
};

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
