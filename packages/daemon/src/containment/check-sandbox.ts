/**
 * Runs one DoD check inside the verifier role (design "Role profiles", review
 * WIPW H4). A check executes the candidate's code, so the host never does:
 *
 *   profile -> compile -> probe -> attestation -> single-use gate -> launch
 *
 * The launch is always autonomous, because no human approves a check, whatever
 * the project's approval mode. Every step refuses rather than falling back, and
 * a refusal says nothing about the code under test.
 *
 * The check sees its clone's tree (writable, for build outputs), a read-only
 * gitdir, a synthetic home and tmpfs scratch. It has no network, no credentials
 * and no ambient environment: `envPolicy` no longer reaches it.
 *
 * `checkPrefix` still wraps the command, but inside the sandbox, where it is
 * only a convenience. Entering a real dev shell there is P8.
 */

import { randomUUID } from "node:crypto";
import { closeSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import type { ProjectDb } from "@mfw/db/client";
import {
	type LauncherSteps,
	protectedPaths,
	realLaunchSteps,
} from "./agent-launch.ts";
import { liveCompileHost } from "./agent-launch-host.ts";
import { AgentProfileError } from "./agent-profile.ts";
import {
	type CheckRunner,
	CheckSandboxRefusal,
	checkStartedOn,
	drainTail,
	openStartPipe,
} from "./check-runner.ts";
import { DEFAULT_CHECK_TREE_MB, watchTreeSize } from "./check-tree-cap.ts";
import {
	type CompileHost,
	compileBwrap,
	FIRST_PINNED_FD,
} from "./compile-bwrap.ts";
import { ProfileRejectedError } from "./profile.ts";
import { buildVerifierProfile, VERIFIER_TOOLS } from "./role-profiles.ts";

export interface CheckSandboxDeps {
	db: ProjectDb;
	mfwHome: string;
	projectRoot: string;
	stateDir: string;
	steps?: LauncherSteps;
	/** The most a check's tree may hold (`checkMaxTreeMb`). */
	maxTreeBytes?: number;
	/** How often the tree is measured. Tests shorten it. */
	treePollMs?: number;
}

/**
 * Set inside, so no value crosses from the host. A check has no terminal and
 * nobody to answer a prompt: `true` is a no-op editor.
 *
 * The entry reports on the start pipe and closes it before the exec, so no
 * candidate code ever holds it. Without that report the exit status is the
 * sandbox's, not the check's.
 */
export function checkEntry(startFd: number): string {
	return `export MFW_VERIFY=1 EDITOR=true GIT_EDITOR=true VISUAL=true GIT_TERMINAL_PROMPT=0; printf 'started\\n' >&${startFd} || exit 125; exec ${startFd}>&-; exec "$0" -c "$1"`;
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The shell text a check runs as, with its prefix quoted around it. */
export function checkShellText(command: string, prefix?: string): string {
	const wrapper = prefix?.trim();
	return wrapper ? `${wrapper} sh -c ${quote(command)}` : command;
}

export function createCheckSandbox(deps: CheckSandboxDeps): CheckRunner {
	const steps: LauncherSteps = deps.steps ?? {
		...realLaunchSteps,
		compileHost: liveCompileHost,
	};
	return async (req) => {
		const runId = `verify-${randomUUID()}`;
		const refuse = (code: string, reason: string, fix: string): never => {
			throw new CheckSandboxRefusal(code, reason, fix);
		};

		let tree: string;
		let mfwHome: string;
		try {
			tree = realpathSync(req.tree);
			mfwHome = realpathSync(deps.mfwHome);
		} catch {
			return refuse(
				"workspace_missing",
				`the verification clone ${req.tree} is gone`,
				"retry the verification",
			);
		}
		const looked = await steps.compileHost(
			{
				mfwHome,
				cli: "claude",
				stateDir: deps.stateDir,
			} as never,
			VERIFIER_TOOLS,
			[dirname(tree)],
		);
		const found = new Set(looked.toolchain.resolved.map((b) => b.name));
		const binaries = VERIFIER_TOOLS.filter((t) => found.has(t));
		const sh = looked.toolchain.resolved.find((b) => b.name === "sh");
		if (!sh) {
			return refuse(
				"toolchain",
				"no sh in the sandbox toolchain",
				"install a shell in a known toolchain root",
			);
		}
		const host: CompileHost = {
			...looked,
			toolchain: {
				...looked.toolchain,
				resolved: looked.toolchain.resolved.filter((b) =>
					binaries.includes(b.name as (typeof binaries)[number]),
				),
			},
		};
		let profile: ReturnType<typeof buildVerifierProfile>;
		try {
			profile = buildVerifierProfile({ role: req.role, tree, binaries });
		} catch (err) {
			if (
				err instanceof AgentProfileError ||
				err instanceof ProfileRejectedError
			) {
				return refuse("profile", err.message, "verify in a host-owned clone");
			}
			throw err;
		}
		// The pins depend on the profile alone, so this fixes the pipe's number.
		const shape = compileBwrap(profile, [sh.path], host);
		if (!shape.ok) return refuse(shape.code, shape.reason, shape.fix);
		const startFd = FIRST_PINNED_FD + shape.pinnedBinds.length;
		if (startFd > 9) {
			return refuse(
				"profile",
				"too many binds for the check's start pipe",
				"reduce the declared caches",
			);
		}
		const compiled = compileBwrap(
			profile,
			[
				sh.path,
				"-c",
				checkEntry(startFd),
				sh.path,
				checkShellText(req.command, req.prefix),
			],
			host,
		);
		if (!compiled.ok) {
			return refuse(compiled.code, compiled.reason, compiled.fix);
		}
		const attested = await steps.attest({
			db: deps.db,
			runId,
			profile,
			host,
			targets: {
				home: host.home,
				mfwHome: host.mfwHome,
				protectedPaths: protectedPaths(
					{ projectRoot: deps.projectRoot, stateDir: deps.stateDir },
					host.home,
				),
				fleetExecBaseline: [],
			},
		});
		if (!attested.ok)
			return refuse(attested.code, attested.reason, attested.fix);
		if (attested.outcome !== "pass") {
			const failed = attested.items
				.filter((i) => i.status !== "pass")
				.map((i) => `${i.id} (${i.detail.slice(0, 200)})`);
			return refuse(
				"probe_failed",
				`the verifier sandbox probe failed: ${failed.join(", ").slice(0, 1000)}`,
				"run `mfw doctor`, fix the failing items, then retry",
			);
		}
		const gate = await steps.authorize(deps.db, {
			runId,
			approvalMode: "autonomous",
			profile,
			compiled,
			bwrapVersion: host.caps.bwrap.value.version ?? "unknown",
		});
		if (!gate.ok) return refuse(gate.code, gate.reason, gate.fix);
		if (gate.authorization === null) {
			return refuse(
				"not_authorized",
				"the gate granted no authorization",
				"retry the verification",
			);
		}
		if (req.signal?.aborted) {
			return {
				exitCode: null,
				stdout: "",
				stderr: "",
				timedOut: false,
				truncated: false,
				signalCode: "SIGTERM",
			};
		}

		const start = openStartPipe();
		let child: ReturnType<LauncherSteps["launch"]>;
		try {
			child = steps.launch(compiled, {
				approvalMode: "autonomous",
				authorization: gate.authorization,
				startPipeFd: start.write,
			});
		} catch (err) {
			// A launch that threw left both ends with us.
			closeSync(start.write);
			closeSync(start.read);
			throw err;
		}
		(child.stdin as unknown as { end(): void }).end();
		let timedOut = false;
		// bwrap dies with its parent and takes the check's pid namespace with it.
		const kill = () => child.kill("SIGKILL");
		const timer = setTimeout(() => {
			timedOut = true;
			kill();
		}, req.timeoutMs);
		req.signal?.addEventListener("abort", kill, { once: true });
		const maxTreeBytes =
			deps.maxTreeBytes ?? DEFAULT_CHECK_TREE_MB * 1024 * 1024;
		let breach: "over" | "blind" | null = null;
		const stopWatching = watchTreeSize(
			tree,
			maxTreeBytes,
			(why) => {
				breach = why;
				kill();
			},
			deps.treePollMs,
		);
		let started: boolean | null = null;
		try {
			const [out, err, exitCode] = await Promise.all([
				drainTail(child.stdout as never, req.maxOutputBytes),
				drainTail(child.stderr as never, req.maxOutputBytes),
				child.exited,
			]);
			const signalCode = (child.signalCode ?? null) as NodeJS.Signals | null;
			started = checkStartedOn(start.read);
			if (breach) {
				return refuse(
					"check_tree_cap",
					breach === "over"
						? `the check wrote more than ${Math.round(maxTreeBytes / 1024 / 1024)} MiB to its tree and was stopped`
						: "the check hid part of its tree from the size measurement and was stopped",
					"reduce what the check writes, or raise checkMaxTreeMb for this project",
				);
			}
			if (!started) {
				return refuse(
					"no_start_handshake",
					`the sandbox ended (${signalCode ?? `exit ${exitCode}`}) before the check started`,
					"run `mfw doctor`, then retry",
				);
			}
			return {
				exitCode: signalCode ? null : exitCode,
				stdout: out.text,
				stderr: err.text,
				timedOut,
				truncated: out.truncated || err.truncated,
				signalCode,
			};
		} finally {
			clearTimeout(timer);
			stopWatching();
			req.signal?.removeEventListener("abort", kill);
			// Reading it closes it, so only an early throw leaves it open.
			if (started === null) closeSync(start.read);
		}
	};
}
