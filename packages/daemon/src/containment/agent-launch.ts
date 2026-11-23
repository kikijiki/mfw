/**
 * The one path by which an agent CLI starts in a sandbox (design "Bridge on the
 * host", "Probe barrier"):
 *
 *   profile -> compile -> probe -> attestation row -> gate -> launchSandbox
 *
 * Every step refuses with a fix, and nothing falls back to a weaker sandbox.
 * The scope is never chosen here, so `launchSandbox` applies its systemd
 * default, and an attestation made without that scope cannot pass the gate.
 *
 * The authorization is an in-process token, so this runs in the process that
 * spawns the child: `agent-launch-main.ts`, which drivers and bridges execute
 * in place of the agent CLI.
 */

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ProjectDb } from "@mfw/db/client";
import { z } from "zod";
import {
	AgentProfileError,
	autonomyFlags,
	buildRunProfile,
	cloneLayout,
	findLaunchSecret,
	findWritableBindParent,
	UNATTESTED_CONFIG_MARKER,
} from "./agent-profile.ts";
import { authorizeAutonomousLaunch } from "./attestation-gate.ts";
import { type CompileHost, compileBwrap } from "./compile-bwrap.ts";
import { launchSandbox } from "./launch-sandbox.ts";
import { attestSandbox } from "./probe-run.ts";
import { ProfileRejectedError, type SandboxProfile } from "./profile.ts";

const AbsolutePath = z.string().startsWith("/").max(4096);

/** Written by the agent host into its private control directory. Holds no secret. */
export const AgentLaunchRequestSchema = z.strictObject({
	version: z.literal(1),
	runId: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/),
	role: z.enum(["task", "repair"]),
	approvalMode: z.enum(["autonomous", "interactive"]),
	cli: z.enum(["claude", "codex"]),
	tree: AbsolutePath,
	runDir: AbsolutePath,
	projectRoot: AbsolutePath,
	stateDir: AbsolutePath,
	mfwHome: AbsolutePath,
	env: z.record(z.string(), z.string()),
	/** Names read from the launcher's own environment; values never touch a file. */
	secretNames: z.array(z.string()),
	egressSocketDir: AbsolutePath.optional(),
});

export type AgentLaunchRequest = z.infer<typeof AgentLaunchRequestSchema>;

export type AgentLaunchRefusalCode =
	| "autonomy_flag_refused"
	| "workspace_not_clone"
	| "profile_rejected"
	| "secret_in_launch"
	| "compile_refused"
	| "bind_parent_writable"
	| "probe_refused"
	| "probe_failed"
	| "not_authorized";

export interface AgentLaunchRefusal {
	ok: false;
	code: AgentLaunchRefusalCode;
	reason: string;
	fix: string;
}

export interface AgentLaunchDeps {
	/** The host facts for this launch, with the toolchain resolved for `binaries`. */
	compileHost(
		req: AgentLaunchRequest,
		binaries: readonly string[],
		allowedRoots: readonly string[],
	): Promise<CompileHost>;
	db: ProjectDb;
	secretValue(name: string): string | undefined;
	attest: typeof attestSandbox;
	authorize: typeof authorizeAutonomousLaunch;
	launch: typeof launchSandbox;
	warn(message: string): void;
}

export const realLaunchSteps = {
	attest: attestSandbox,
	authorize: authorizeAutonomousLaunch,
	launch: launchSandbox,
} as const;

const refuse = (
	code: AgentLaunchRefusalCode,
	reason: string,
	fix: string,
): AgentLaunchRefusal => ({ ok: false, code, reason, fix });

/** Everything the probe must find absent, beyond the home and `$MFW_HOME`. */
export function protectedPaths(
	req: Pick<AgentLaunchRequest, "projectRoot" | "stateDir">,
	home: string,
): string[] {
	return [
		req.projectRoot,
		req.stateDir,
		join(home, ".claude"),
		join(home, ".claude.json"),
		join(home, ".codex"),
		join(home, ".config"),
		join(home, ".ssh"),
	];
}

/** Where a run may bind from: its clone, its run dir, the fleet dirs, its proxy. */
export function launchRoots(req: AgentLaunchRequest): string[] {
	return [
		dirname(req.tree),
		req.runDir,
		join(req.mfwHome, "agents"),
		...(req.egressSocketDir ? [dirname(req.egressSocketDir)] : []),
	];
}

export type AgentLaunchResult =
	| { ok: true; child: ReturnType<typeof launchSandbox>; attestationId: string }
	| AgentLaunchRefusal;

/** Run the whole path for one launch. Each launch needs its own passing probe. */
export async function launchAgentSandbox(
	req: AgentLaunchRequest,
	argv: readonly string[],
	deps: AgentLaunchDeps,
): Promise<AgentLaunchResult> {
	const command = argv[0];
	if (!command) {
		return refuse("profile_rejected", "no agent command", "pass an agent argv");
	}
	if (req.approvalMode !== "autonomous" && autonomyFlags(argv).length > 0) {
		return refuse(
			"autonomy_flag_refused",
			`an ${req.approvalMode} launch carries ${autonomyFlags(argv).join(", ")}`,
			"autonomous flags are applied only to an authorized autonomous launch",
		);
	}

	const secrets: Record<string, string> = {};
	for (const name of req.secretNames) {
		const value = deps.secretValue(name);
		if (value === undefined) {
			return refuse(
				"profile_rejected",
				`the granted secret ${name} did not reach the launcher`,
				"check the run's workload grants",
			);
		}
		secrets[name] = value;
	}

	const binaries = ["bun", "git", command];
	let host: CompileHost;
	let profile: SandboxProfile;
	try {
		cloneLayout(req.tree);
		host = await deps.compileHost(req, binaries, launchRoots(req));
		profile = buildRunProfile({
			role: req.role,
			tree: req.tree,
			runDir: req.runDir,
			cli: req.cli,
			fleetDir: join(req.mfwHome, "agents", req.cli),
			binaries,
			env: { ...req.env, ...secrets },
			...(req.egressSocketDir ? { egressSocketDir: req.egressSocketDir } : {}),
		});
	} catch (err) {
		if (err instanceof AgentProfileError) {
			return refuse("workspace_not_clone", err.message, err.fix);
		}
		if (err instanceof ProfileRejectedError) {
			return refuse(
				"profile_rejected",
				err.message,
				"remove the rejected setting from the run's launch environment",
			);
		}
		throw err;
	}

	const resolved = host.toolchain.resolved.find((b) => b.name === command);
	const finalArgv = [resolved?.path ?? command, ...argv.slice(1)];
	const forbidden = [
		...new Set(
			[host.home, host.mfwHome, req.projectRoot, req.stateDir].flatMap((p) => [
				p,
				host.realpath(p) ?? p,
			]),
		),
	];
	const leak = findLaunchSecret({
		argv: finalArgv,
		env: req.env,
		secretValues: Object.values(secrets),
		forbiddenPaths: forbidden,
		...(resolved ? { allowedArgv0: resolved.path } : {}),
	});
	if (leak) {
		return refuse(
			"secret_in_launch",
			`the agent's command line or env is unsafe: ${leak}`,
			"pass secrets through a workload grant and use sandbox paths",
		);
	}

	const compiled = compileBwrap(profile, finalArgv, host);
	if (!compiled.ok) {
		return refuse(
			"compile_refused",
			`${compiled.code}: ${compiled.reason}`,
			compiled.fix,
		);
	}
	const parent = findWritableBindParent(compiled.pinnedBinds);
	if (parent) {
		return refuse(
			"bind_parent_writable",
			`${parent.parent.label} is writable and holds ${parent.child.label}`,
			"keep every bind source's parent out of the sandbox's writable binds",
		);
	}
	deps.warn(
		`${UNATTESTED_CONFIG_MARKER}: run ${req.runId} uses the temporary ${req.cli} fleet allowlist`,
	);

	const attested = await deps.attest({
		db: deps.db,
		runId: req.runId,
		profile,
		host,
		targets: {
			home: host.home,
			mfwHome: host.mfwHome,
			protectedPaths: protectedPaths(req, host.home),
			fleetExecBaseline: [],
		},
	});
	if (!attested.ok) {
		return refuse("probe_refused", attested.reason, attested.fix);
	}
	if (attested.outcome !== "pass") {
		const failed = attested.items
			.filter((i) => i.status !== "pass")
			.map((i) => i.id);
		return refuse(
			"probe_failed",
			`the sandbox probe failed: ${failed.join(", ")}`,
			"run `mfw doctor`, fix the failing items, then retry",
		);
	}

	const gate = await deps.authorize(deps.db, {
		runId: req.runId,
		approvalMode: req.approvalMode,
		profile,
		compiled,
		bwrapVersion: host.caps.bwrap.value.version ?? "unknown",
	});
	if (!gate.ok) return refuse("not_authorized", gate.reason, gate.fix);

	const child =
		gate.authorization === null
			? deps.launch(compiled, { approvalMode: "interactive" })
			: deps.launch(compiled, {
					approvalMode: "autonomous",
					authorization: gate.authorization,
				});
	return { ok: true, child, attestationId: attested.attestationId };
}

/** The real home, for the live launcher. */
export const realHome = (): string => homedir();
