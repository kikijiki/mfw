/**
 * What the harness maps produce, as plain JSON. `harness-legacy-maps.json` is
 * this function's output on the commit before the manifests replaced the
 * hand-written maps, so `harness-equivalence.test.ts` compares against the old
 * code and not against itself.
 */
import { profileFor } from "../../src/agents/acp-translate.ts";
import {
	AdapterRegistry,
	acpInferenceLaunch,
	PI_ACP_VERSION,
} from "../../src/agents/adapter.ts";
import {
	catalogueCredentialIds,
	DEFAULT_PROVIDER_ID,
	MODEL_SNAPSHOT_CHECKED,
	PROVIDER_CATALOGUE,
} from "../../src/agents/catalogue.ts";
import { inferenceEnv } from "../../src/agents/inference-env.ts";
import {
	HARNESS_CONFIG_PATHS,
	isHostExecutedPath,
} from "../../src/brain-runtime/decision-rights.ts";
import {
	autonomyFlags,
	TEMPORARY_FLEET_WRITABLE,
	withoutAutonomyFlags,
} from "../../src/containment/agent-profile.ts";
import { BRAIN_TRANSCRIPT_DIR } from "../../src/containment/brain-transcript.ts";
import {
	HARNESS_EGRESS,
	harnessAllowlist,
	harnessEgressEnv,
	usesApiKeyAuth,
} from "../../src/containment/egress-allowlists.ts";
import { REMOTE_HARNESSES } from "../../src/host-registry.ts";
import { hostProbeScript } from "../../src/host-registry-probe.ts";

export const plainJson = (value: unknown) =>
	JSON.parse(
		JSON.stringify(value, (_k, v) =>
			v instanceof RegExp ? { regexSource: v.source, regexFlags: v.flags } : v,
		),
	);

export function captureHarnessMaps(): Record<string, unknown> {
	const ids = PROVIDER_CATALOGUE.map((p) => p.id);
	const acpIds = PROVIDER_CATALOGUE.filter((p) => p.configType === "acp").map(
		(p) => p.id,
	);
	const brain = {
		sessionId: "11111111-1111-4111-8111-111111111111",
		mcpConfigPath: "/fixture/mcp.json",
		projectDirName: "fixture-project",
		mcp: {
			name: "mfw-brain",
			command: "/fixture/bun",
			args: ["run", "/fixture/mcp.ts"],
			env: { MFW_FIXTURE: "1" },
		},
	};
	const endpoint = {
		id: "fixture",
		baseUrl: "https://endpoint.example/v1",
		envKey: "FIXTURE_KEY",
	};
	const registry = new AdapterRegistry();
	const launches: Record<string, unknown> = {};
	for (const id of ids) {
		const type = PROVIDER_CATALOGUE.find((p) => p.id === id)?.configType;
		for (const model of ["default", "fixture-model"]) {
			const cases: [string, Record<string, unknown>, boolean][] = [
				["task", { steer: true, runId: "run-1" }, false],
				["task-bg", { steer: false, disallowBackgroundAgents: true }, false],
				["brain", { steer: false, brain }, false],
				[
					"brain-resume",
					{
						steer: false,
						brain: {
							...brain,
							sessionId: undefined,
							resumeSessionId: "22222222-2222-4222-8222-222222222222",
						},
					},
					false,
				],
				["task-endpoint", { steer: true, runId: "run-1" }, true],
				["brain-endpoint", { steer: false, brain }, true],
			];
			for (const [name, opts, withEndpoint] of cases) {
				const key = `${id}|${model}|${name}`;
				try {
					const inv = registry.invocation(
						{
							id,
							type: type as "acp",
							env: { FIXTURE: "1" },
							...(withEndpoint ? { endpoint } : {}),
						},
						model,
						"prompt",
						opts as never,
					);
					launches[key] = {
						providerArgv: inv.providerArgv,
						agentArgv: inv.agentArgv,
						bridge: inv.bridgeArgv.at(-1)?.split("/").at(-1),
						env: inv.env,
						declaredCapabilities: inv.declaredCapabilities,
					};
				} catch (error) {
					launches[key] = { throws: (error as Error).message };
				}
			}
		}
	}
	const inference: Record<string, unknown> = {};
	for (const id of acpIds)
		for (const model of ["default", "fixture-model"]) {
			const l = acpInferenceLaunch(id, model);
			inference[`${id}|${model}`] = {
				providerArgv: l.providerArgv,
				env: l.env,
			};
		}

	const autonomyCorpus = [
		"--dangerously-skip-permissions",
		"--dangerously-skip-permissions=true",
		"--allow-dangerously-skip-permissions",
		"--dangerously-bypass-approvals-and-sandbox",
		"--full-auto",
		"--yolo",
		"--yolo=1",
		"-y",
		"--force",
		"--permission-mode bypassPermissions",
		"--permission-mode=bypassPermissions",
		"--permission-mode plan",
		"--ask-for-approval never",
		"--ask-for-approval=never",
		"--ask-for-approval on-request",
		"-a never",
		"-a=never",
		"-a on-request",
		"--sandbox danger-full-access",
		"--sandbox=danger-full-access",
		"--sandbox read-only",
		"-s danger-full-access",
		"-s=danger-full-access",
		"-s read-only",
		'-c approval_policy="never"',
		"-c approval_policy=never",
		"-c approval_policy='never'",
		'-c approval_policy="on-request"',
		'-c sandbox_mode="danger-full-access"',
		'-c sandbox_mode="read-only"',
		'--config approval_policy="never"',
		'--config=approval_policy="never"',
		'--config=sandbox_mode="danger-full-access"',
		'-c=approval_policy="never"',
		"-c other=1",
		"--approval-mode yolo",
		"--approval-mode plan",
		"--model opus",
		"--sandbox",
		"-c",
	].map((line) => {
		const argv = ["cli", ...line.split(" "), "tail"];
		return {
			argv,
			flags: autonomyFlags(argv),
			without: withoutAutonomyFlags(argv),
		};
	});

	const hostExecutedCorpus = [
		...Object.values(HARNESS_CONFIG_PATHS).flat(),
		".claude/x",
		".codex/x",
		".gemini/x",
		".cursor/x",
		".opencode/plugin.ts",
		".pi/x",
		".vscode/tasks.json",
		"src/.claude/settings.json",
		"sub/AGENTS.md",
		"CLAUDE.MD",
		"README.md",
		"src/index.ts",
	];

	const apiKey: Record<string, boolean> = {};
	for (const h of Object.keys(
		HARNESS_EGRESS,
	) as (keyof typeof HARNESS_EGRESS)[])
		for (const names of [
			[],
			["OPENAI_API_KEY"],
			["ANTHROPIC_API_KEY"],
			["MFW_RUN_ID"],
		])
			apiKey[`${h}|${names.join(",")}`] = usesApiKeyAuth(h, names);

	const allowlists: Record<string, unknown> = {};
	for (const h of Object.keys(
		HARNESS_EGRESS,
	) as (keyof typeof HARNESS_EGRESS)[])
		for (const telemetry of [false, true])
			for (const apiKeyAuth of [false, true]) {
				allowlists[`${h}|telemetry=${telemetry}|apiKey=${apiKeyAuth}`] = {
					allow: harnessAllowlist(h, { telemetry, apiKeyAuth }),
					env: harnessEgressEnv(h, { telemetry, apiKeyAuth }),
				};
			}

	const inferenceEnvs: Record<string, unknown> = {};
	const source = Object.fromEntries(
		[
			"PATH",
			"HOME",
			"CODEX_HOME",
			"CLAUDE_CONFIG_DIR",
			"UNRELATED",
			...PROVIDER_CATALOGUE.flatMap((p) =>
				p.auth.flatMap((a) => a.envVars ?? []),
			),
		].map((k) => [k, `v-${k}`]),
	);
	for (const id of [...ids, "unknown"])
		inferenceEnvs[id] = inferenceEnv(id, source);

	return plainJson({
		capturedFrom: "the hand-written harness maps before the manifests",
		piAcpVersion: PI_ACP_VERSION,
		defaultProviderId: DEFAULT_PROVIDER_ID,
		modelSnapshotChecked: MODEL_SNAPSHOT_CHECKED,
		credentialIds: catalogueCredentialIds(),
		fleetWritable: TEMPORARY_FLEET_WRITABLE,
		brainTranscriptDir: BRAIN_TRANSCRIPT_DIR,
		egress: HARNESS_EGRESS,
		allowlists,
		apiKey,
		catalogue: PROVIDER_CATALOGUE,
		remote: REMOTE_HARNESSES,
		configPaths: HARNESS_CONFIG_PATHS,
		hostExecuted: Object.fromEntries(
			hostExecutedCorpus.map((p) => [p, isHostExecutedPath(p)]),
		),
		acpProfiles: Object.fromEntries(
			[...acpIds, "unknown"].map((id) => [id, profileFor(id)]),
		),
		launches,
		inference,
		inferenceEnvs,
		autonomyCorpus,
		hostProbeScript: hostProbeScript(),
	});
}
