/**
 * The dispatch-time refusal for sandboxed task and repair runs. It probes a
 * throwaway copy of the exact layout a real launch gets (clone, split run dir,
 * fleet config), so a pass here says something about the real launch. The real
 * launch still runs its own probe: this only refuses early, with the fix.
 */

import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { openProjectDb } from "@mfw/db/client";
import type { BwrapIsolation } from "../sandbox.ts";
import { protectedPaths } from "./agent-launch.ts";
import { liveCompileHost } from "./agent-launch-host.ts";
import {
	agentToolCandidates,
	buildRunProfile,
	declaredAgentBinaries,
	ensureFleetPrivateState,
} from "./agent-profile.ts";
import type { CompileHost } from "./compile-bwrap.ts";
import type { DevEnvResolution } from "./dev-env-resolve.ts";
import { EVALUATED_ENV_PATHS } from "./dev-env-sources.ts";
import { attestSandbox } from "./probe-run.ts";
import { ensureRunDirLayout } from "./run-dir.ts";

export interface AgentPreflightRefusal {
	code:
		| "sandbox_unavailable"
		| "sandbox_probe_failed"
		| "env_not_approved"
		| "env_unavailable";
	detail: string;
}

export interface AgentPreflightInput {
	approvalMode: "autonomous" | "interactive";
	isolation: BwrapIsolation | undefined;
	runWorkspace: "worktree" | "clone";
	projectRoot: string;
	mfwHome: string;
	/**
	 * The project's dev environment at its integrated base. Evaluated and
	 * installed here when approved and not yet cached, so a launch only loads
	 * it. Absent: the project is treated as declaring none.
	 */
	devEnv?: () => Promise<DevEnvResolution>;
}

export interface AgentPreflightDeps {
	compileHost: typeof liveCompileHost;
	attest: typeof attestSandbox;
	now: () => number;
}

const PROBE_TTL_MS = 60_000;
let memo: {
	key: string;
	at: number;
	result: AgentPreflightRefusal | null;
} | null = null;

/** Test seam: forgets the memoized probe. */
export function resetAgentPreflightCache(): void {
	memo = null;
}

/**
 * Whether a tree declares a dev environment, by the presence of a file a
 * source evaluates. Only `lstat`: nothing is opened, read or evaluated.
 */
export function declaresDevEnv(root: string): boolean {
	return EVALUATED_ENV_PATHS.some((rel) => {
		try {
			lstatSync(join(root, rel));
			return true;
		} catch {
			return false;
		}
	});
}

/** A launch that cannot learn the approved environment refuses rather than run without it. */
export const NO_DEV_ENV_RESOLVER =
	"this project declares a dev environment (.envrc, mise.toml, flake.nix or devenv.nix), and this launch has no way to apply the approved one, so it is refused rather than run without it";

/** The preflight refusal for an environment that cannot be applied, or null. */
export function devEnvRefusal(
	env: DevEnvResolution,
): AgentPreflightRefusal | null {
	if (env.kind !== "refused") return null;
	const owner =
		env.code === "env_not_approved" ||
		env.code === "env_denied" ||
		env.code === "env_drifted";
	const log = env.log ? ` Last lines of the log: ${env.log.slice(-1500)}` : "";
	return {
		code: owner ? "env_not_approved" : "env_unavailable",
		detail: `${env.reason}. Fix: ${env.fix}.${log}`,
	};
}

/** Build the fixture and probe it. Every path is inside a fresh private directory. */
async function probeLayout(
	mfwHome: string,
	projectRoot: string,
	deps: AgentPreflightDeps,
): Promise<AgentPreflightRefusal | null> {
	mkdirSync(mfwHome, { recursive: true, mode: 0o700 });
	const realHome = realpathSync(mfwHome);
	const base = mkdtempSync(join(realHome, ".sandbox-preflight-"));
	try {
		chmodSync(base, 0o700);
		const clone = join(base, "workspaces/preflight");
		mkdirSync(join(clone, "tree"), { recursive: true });
		mkdirSync(join(clone, "git"));
		writeFileSync(join(clone, "mfw-workspace.json"), "{}");
		const project = join(base, "project");
		const stateDir = join(project, ".mfw");
		const runDir = join(stateDir, "runs/preflight");
		ensureRunDirLayout(runDir);
		const fleet = join(base, "agents/claude");
		mkdirSync(fleet, { recursive: true, mode: 0o700 });
		ensureFleetPrivateState(join(clone, "tree"), "claude", fleet);
		const required = ["bun", "git"];
		let host: CompileHost;
		try {
			host = await deps.compileHost(
				{ mfwHome: base, cli: "claude", stateDir },
				agentToolCandidates(required),
				[clone, runDir, join(base, "agents")],
			);
		} catch (err) {
			return {
				code: "sandbox_unavailable",
				detail: (err as Error).message,
			};
		}
		const binaries = declaredAgentBinaries(
			required,
			host.toolchain?.resolved ?? [],
		);
		const profile = buildRunProfile({
			role: "task",
			tree: join(clone, "tree"),
			runDir,
			cli: "claude",
			fleetDir: fleet,
			binaries,
			env: {},
		});
		const handle = await openProjectDb(join(base, "db"));
		try {
			const attested = await deps.attest({
				db: handle.db,
				runId: "preflight",
				profile,
				host: { ...host, mfwHome: realHome },
				targets: {
					home: host.home,
					mfwHome: realHome,
					protectedPaths: protectedPaths({ projectRoot, stateDir }, host.home),
					fleetExecBaseline: [],
				},
			});
			if (!attested.ok) {
				return {
					code: "sandbox_unavailable",
					detail: `${attested.reason}. ${attested.fix}`,
				};
			}
			if (attested.outcome !== "pass") {
				const failed = attested.items
					.filter((i) => i.status !== "pass")
					.map((i) => i.id);
				return {
					code: "sandbox_probe_failed",
					detail: `probe items failed: ${failed.join(", ")}`,
				};
			}
			return null;
		} finally {
			handle.close();
		}
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
}

/** Null when a run may be dispatched, else the refusal. */
export async function agentSandboxRefusal(
	input: AgentPreflightInput,
	deps: AgentPreflightDeps = {
		compileHost: liveCompileHost,
		attest: attestSandbox,
		now: Date.now,
	},
): Promise<AgentPreflightRefusal | null> {
	// Unsandboxed interactive runs ask a human for every action. A sandboxed
	// run of either mode takes the same launch path, so it is refused here too.
	if (!input.isolation) {
		return input.approvalMode === "autonomous"
			? { code: "sandbox_unavailable", detail: "agentIsolation is none" }
			: null;
	}
	if (input.runWorkspace !== "clone") {
		return {
			code: "sandbox_unavailable",
			detail:
				'runWorkspace is "worktree": sandboxed runs need a private clone, so set "runWorkspace": "clone" for this project',
		};
	}
	// Projects with an environment are refused only when it is not approved or
	// cannot be prepared; then with the exact command or the evaluation's log.
	if (input.devEnv) {
		const refused = devEnvRefusal(await input.devEnv());
		if (refused) return refused;
	}
	const now = deps.now();
	const key = `${input.mfwHome}\0${input.projectRoot}`;
	if (memo?.key === key && now - memo.at < PROBE_TTL_MS) {
		return memo.result;
	}
	const result = await probeLayout(input.mfwHome, input.projectRoot, deps);
	memo = { key, at: now, result };
	return result;
}
