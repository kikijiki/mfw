import type { HarnessManifest } from "./harness.ts";

/**
 * Renders `docs/harness-matrix.md` from the manifests. Pure and deterministic
 * (no dates), so a test can compare it with the committed file.
 */

export const HARNESS_MATRIX_PATH = "docs/harness-matrix.md";

const CAPABILITIES = [
	["streaming", "Streaming"],
	["steer", "Steering"],
	["interrupt", "Interrupt"],
	["approvals", "Approvals"],
	["tools", "Tools"],
	["mcp", "MCP (task bridge)"],
	["plan", "Plan mode"],
	["fileChanges", "File-change events"],
	["commandProgress", "Command progress"],
	["resume", "Resume"],
] as const;

const cell = (value: string) => value.replace(/\|/g, "\\|");
const code = (value: string) => `\`${cell(value)}\``;
const codes = (values: readonly string[]) =>
	values.length ? values.map(code).join(", ") : "none";
const yesNo = (value: boolean) => (value ? "yes" : "no");

function table(head: readonly string[], rows: readonly string[][]): string[] {
	return [
		`| ${head.join(" | ")} |`,
		`|${head.map(() => "---").join("|")}|`,
		...rows.map((row) => `| ${row.join(" | ")} |`),
	];
}

function autonomyArgs(m: HarnessManifest): string[] {
	return [
		...m.autonomy.flags,
		...m.autonomy.values.map((v) => `${v.option} ${v.value}`),
		...m.autonomy.config.map((c) => `-c ${c.key}=${c.value}`),
	];
}

export function renderHarnessMatrix(
	manifests: readonly HarnessManifest[],
): string {
	const names = manifests.map((m) => m.displayName);
	const lines: string[] = [
		"# Harness matrix",
		"",
		"<!-- Generated from the built-in harness manifests. Do not edit. Run: bun run harness:matrix -->",
		"",
		"What mfw knows about each agent CLI it can drive. The manifests in `packages/plugin-api/src/harness-builtins.ts` are the source.",
		"",
		"## Harnesses",
		"",
		...table(
			["Harness", "Id", "Binary", "Protocol", "Version", "Endpoints"],
			manifests.map((m) => [
				m.displayName,
				code(m.id),
				code(m.detect.bin),
				code(m.dialect),
				m.detect.versionRange ? code(m.detect.versionRange) : "any",
				yesNo(m.acceptsEndpoints),
			]),
		),
		"",
		"## Capabilities",
		"",
		"As each task bridge declares them. A brain turn can differ: Codex brain turns use `codex exec`, which cannot be steered.",
		"",
		...table(
			["Capability", ...names],
			CAPABILITIES.map(([key, label]) => [
				label,
				...manifests.map((m) => yesNo(m.capabilities[key])),
			]),
		),
		"",
		"## Sessions, usage and login",
		"",
		...table(
			["Harness", "Resume", "Usage source", "Login kinds"],
			manifests.map((m) => [
				m.displayName,
				`${code(m.resume.method)}: ${cell(m.resume.detail)}`,
				code(m.usage?.source ?? "none"),
				m.auth.kinds.join(", "),
			]),
		),
		"",
		"## Sandbox",
		"",
		"Only harnesses with a fleet directory run in the agent sandbox today. A list marked `unattested-config` is provisional and has not been checked against an authenticated CLI.",
		"",
		...table(
			[
				"Harness",
				"Fleet dir",
				"Writable",
				"Attestation",
				"User namespace",
				"Inner sandbox",
			],
			manifests.map((m) => [
				m.displayName,
				m.fleet.cli ? code(m.fleet.env as string) : "none",
				codes(m.fleet.writable),
				m.fleet.attestation ? code(m.fleet.attestation) : "n/a",
				m.sandbox.needsUserns ? "needed" : "not needed",
				m.innerSandbox?.mode
					? `${code(m.innerSandbox.mode)} via ${m.innerSandbox.via}`
					: "none",
			]),
		),
		"",
		"## Network",
		"",
		"Exact host and port, deny by default. Telemetry hosts need the owner's opt-in. API-key hosts open only for a run launched with that harness's key.",
		"",
		...table(
			["Harness", "Host", "Port", "Purpose", "Condition"],
			manifests.flatMap((m) =>
				m.egress.map((e) => [
					m.displayName,
					code(e.host),
					String(e.port),
					e.purpose,
					e.purpose === "telemetry"
						? "telemetry opt-in"
						: e.requiresApiKey
							? `${code(m.auth.apiKeyEnv as string)} set`
							: "always",
				]),
			),
		),
		"",
		"## Autonomy flags",
		"",
		"A non-autonomous launch may carry only the arguments mfw generates for that CLI. These are the second layer: a launch carrying any of them is refused.",
		"",
		...table(
			["Harness", "Flags"],
			manifests.map((m) => [m.displayName, codes(autonomyArgs(m))]),
		),
		"",
		"## Project files",
		"",
		"Changes to these paths count as host-executed at merge.",
		"",
		...table(
			["Harness", "Config files", "Directories", "Skills"],
			manifests.map((m) => [
				m.displayName,
				codes(m.install.projectConfig),
				codes(m.install.projectDirs),
				m.install.skills ? code(m.install.skills) : "none",
			]),
		),
		"",
	];
	return lines.join("\n");
}
