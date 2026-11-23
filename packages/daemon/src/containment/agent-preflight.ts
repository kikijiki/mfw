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
import { attestSandbox } from "./probe-run.ts";
import { ensureRunDirLayout } from "./run-dir.ts";

export interface AgentPreflightRefusal {
	code: "sandbox_unavailable" | "sandbox_probe_failed";
	detail: string;
}

export interface AgentPreflightInput {
	approvalMode: "autonomous" | "interactive";
	isolation: BwrapIsolation | undefined;
	runWorkspace: "worktree" | "clone";
	projectRoot: string;
	mfwHome: string;
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
 * A project with an `.envrc` needs a dev shell, which only exists inside the
 * sandbox once P8 lands. The host only checks that the file exists, and never
 * reads or evaluates it.
 */
export function needsDevShell(root: string): boolean {
	try {
		lstatSync(join(root, ".envrc"));
		return true;
	} catch {
		return false;
	}
}

export const DEV_SHELL_REFUSAL =
	"this project has an .envrc, and dev shells inside the sandbox are not available yet. Sandboxed runs of this project can start once they are, or now if the project works with its plain toolchain and its .envrc is removed";

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
	if (needsDevShell(input.projectRoot)) {
		return { code: "sandbox_unavailable", detail: DEV_SHELL_REFUSAL };
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
