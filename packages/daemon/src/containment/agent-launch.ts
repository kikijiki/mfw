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

import { chmodSync, copyFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ProjectDb } from "@mfw/db/client";
import { z } from "zod";
import {
	installWipHelper,
	wipSnapshotArgv,
	wipSupervisorArgv,
} from "../run-workspace/wip-helper-install.ts";
import { HOST_BUN_FLAGS } from "./agent-launch-argv.ts";
import {
	AgentProfileError,
	agentToolCandidates,
	autonomyFlags,
	buildRunProfile,
	cloneLayout,
	declaredAgentBinaries,
	ensureFleetPrivateState,
	findLaunchSecret,
	findWritableBindParent,
	UNATTESTED_CONFIG_MARKER,
} from "./agent-profile.ts";
import { authorizeAutonomousLaunch } from "./attestation-gate.ts";
import {
	type CompileHost,
	compileBwrap,
	SANDBOX_PATHS,
} from "./compile-bwrap.ts";
import { EGRESS_SOCKET_NAME } from "./egress-run.ts";
import { launchSandbox } from "./launch-sandbox.ts";
import { attestSandbox } from "./probe-run.ts";
import { ProfileRejectedError, type SandboxProfile } from "./profile.ts";
import { RUN_CONTROL_DIR, runDirLayout } from "./run-dir.ts";

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
	/** A host-started one-shot: the WIP helper alone, with no agent, secret or network. */
	purpose: z.literal("wip-snapshot").optional(),
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

const RELAY_FILE = "egress-relay.ts";

/**
 * The agent command behind the in-sandbox relay. The relay is copied into the
 * run's control directory, which the sandbox sees read-only, because the source
 * tree is not bound. Bun reads no config or `.env` from the agent's workspace.
 */
export function withEgressRelay(
	req: Pick<AgentLaunchRequest, "runDir">,
	bun: string,
	argv: readonly string[],
): string[] {
	const copy = join(req.runDir, RUN_CONTROL_DIR, RELAY_FILE);
	rmSync(copy, { force: true });
	copyFileSync(join(import.meta.dir, RELAY_FILE), copy);
	chmodSync(copy, 0o444);
	return [
		bun,
		...HOST_BUN_FLAGS,
		"run",
		`${SANDBOX_PATHS.runControl}/${RELAY_FILE}`,
		"--socket",
		`${SANDBOX_PATHS.egress}/${EGRESS_SOCKET_NAME}`,
		"--",
		...argv,
	];
}

/** Run the whole path for one launch. Each launch needs its own passing probe. */
export async function launchAgentSandbox(
	req: AgentLaunchRequest,
	requestedArgv: readonly string[],
	deps: AgentLaunchDeps,
): Promise<AgentLaunchResult> {
	// A snapshot launch runs only the helper, whatever argv the caller passed.
	const snapshot = req.purpose === "wip-snapshot";
	const argv = snapshot ? ["bun"] : requestedArgv;
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

	const required = ["bun", "git", "sh", command];
	let host: CompileHost;
	let profile: SandboxProfile;
	try {
		cloneLayout(req.tree);
		if (!snapshot) {
			ensureFleetPrivateState(
				req.tree,
				req.cli,
				join(req.mfwHome, "agents", req.cli),
			);
		}
		const looked = await deps.compileHost(
			req,
			agentToolCandidates(required),
			launchRoots(req),
		);
		const binaries = declaredAgentBinaries(required, looked.toolchain.resolved);
		host = {
			...looked,
			toolchain: {
				...looked.toolchain,
				resolved: looked.toolchain.resolved.filter((b) =>
					binaries.includes(b.name),
				),
			},
		};
		profile = buildRunProfile({
			role: req.role,
			tree: req.tree,
			runDir: req.runDir,
			cli: req.cli,
			fleetDir: join(req.mfwHome, "agents", req.cli),
			binaries,
			env: {
				...req.env,
				...(req.cli === "claude" && !snapshot
					? { CLAUDE_CODE_PROJECT_DIR_NAME: `mfw-run-${req.runId}` }
					: {}),
				...secrets,
			},
			...(req.egressSocketDir && !snapshot
				? { egressSocketDir: req.egressSocketDir }
				: {}),
			...(snapshot ? { snapshotOnly: true } : {}),
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
	// Toolchain binds keep their host paths, so a CLI installed in a home
	// toolchain root shows that path (and the username in it) in `/proc/1/cmdline`,
	// `PATH` and the mount table. Accepted: hiding it from one of the three would
	// change nothing. Credentials are checked for below.
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

	// The helper starts beside the agent, in the same sandbox. The egress relay
	// is what the entry shell becomes, and it runs the agent; a snapshot launch
	// has no agent and no network, so it never gets one.
	const toolPath = (name: string) =>
		host.toolchain.resolved.find((b) => b.name === name)?.path;
	const bunPath = toolPath("bun");
	const shPath = toolPath("sh");
	if (!bunPath || !shPath) {
		return refuse(
			"compile_refused",
			"bun or sh is not in the sandbox toolchain, so the WIP helper and egress relay cannot run",
			"install them in a known toolchain root",
		);
	}
	installWipHelper(runDirLayout(req.runDir).control);
	const sandboxArgv = snapshot
		? wipSnapshotArgv(shPath, bunPath, req.runId)
		: wipSupervisorArgv(
				shPath,
				bunPath,
				req.runId,
				req.egressSocketDir
					? withEgressRelay(req, bunPath, finalArgv)
					: finalArgv,
			);
	const compiled = compileBwrap(profile, sandboxArgv, host);
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
		// Names the offending path: the detail is the host's own rendering.
		const failed = attested.items
			.filter((i) => i.status !== "pass")
			.map((i) => `${i.id} (${i.detail.slice(0, 400)})`);
		return refuse(
			"probe_failed",
			`the sandbox probe failed: ${failed.join(", ").slice(0, 2000)}`,
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
			? deps.launch(compiled, {
					approvalMode: "interactive",
					expectPins: attested.pins,
				})
			: deps.launch(compiled, {
					approvalMode: "autonomous",
					authorization: gate.authorization,
				});
	return { ok: true, child, attestationId: attested.attestationId };
}

/** The real home, for the live launcher. */
export const realHome = (): string => homedir();
