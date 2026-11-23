/**
 * A headless agent call that is not a board run: the reviewer. It takes the same
 * single path as every other launch (profile, compile, probe, attestation,
 * single-use gate), with its own run directory and egress proxy, which last
 * exactly as long as the call. The prompt travels on stdin, so it is never in
 * an argv and is not mistaken for a leaked path or credential.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openProjectDb } from "@mfw/db/client";
import type { ProcResult } from "../proc.ts";
import { requireHostTool, SandboxUnavailableError } from "../sandbox.ts";
import {
	type AgentLaunchRequest,
	type LauncherSteps,
	launchAgentSandbox,
	realLaunchSteps,
} from "./agent-launch.ts";
import { HOST_BUN_FLAGS } from "./agent-launch-argv.ts";
import { liveCompileHost } from "./agent-launch-host.ts";
import type { FleetCli } from "./agent-profile.ts";
import { drainTail } from "./check-runner.ts";
import { harnessAllowlist, harnessEgressEnv } from "./egress-allowlists.ts";
import { prepareRunEgress } from "./egress-run.ts";
import { ensureRunDirLayout } from "./run-dir.ts";

const EGRESS_PROXY_MAIN = join(import.meta.dir, "egress-proxy-main.ts");
const PROXY_START_MS = 20_000;

export interface OneShotAgentRequest {
	role: "reviewer";
	cli: FleetCli;
	/** A private clone's tree, mounted read-only. */
	tree: string;
	projectRoot: string;
	stateDir: string;
	mfwHome: string;
	argv: readonly string[];
	prompt: string;
	timeoutMs: number;
	maxOutputBytes: number;
	signal?: AbortSignal;
	steps?: LauncherSteps;
	/** Stands in for the real proxy in the caged tests. */
	startProxy?: (configPath: string, socketPath: string) => Promise<() => void>;
}

async function startRealProxy(
	configPath: string,
	socketPath: string,
): Promise<() => void> {
	const proxy = Bun.spawn(
		[
			requireHostTool("env"),
			"-i",
			process.execPath,
			...HOST_BUN_FLAGS,
			"run",
			EGRESS_PROXY_MAIN,
			configPath,
		],
		{ stdin: "pipe", stdout: "ignore", stderr: "ignore" },
	);
	// Closing the pipe is how the proxy learns the call is over.
	const stop = () => {
		try {
			(proxy.stdin as unknown as { end(): void }).end();
		} catch {}
	};
	const deadline = Date.now() + PROXY_START_MS;
	while (!existsSync(socketPath)) {
		if (proxy.exitCode !== null || Date.now() > deadline) {
			stop();
			throw new SandboxUnavailableError(
				"the reviewer's egress proxy did not start",
			);
		}
		await Bun.sleep(25);
	}
	return stop;
}

export async function runOneShotAgent(
	req: OneShotAgentRequest,
): Promise<ProcResult> {
	const runId = `review-${randomUUID()}`;
	const steps: LauncherSteps = req.steps ?? {
		...realLaunchSteps,
		compileHost: liveCompileHost,
	};
	const mfwHome = realpathSync(req.mfwHome);
	const stateDir = realpathSync(req.stateDir);
	mkdirSync(join(stateDir, "runs"), { recursive: true, mode: 0o700 });
	const runDir = join(stateDir, "runs", runId);
	ensureRunDirLayout(runDir);
	const handle = await openProjectDb(stateDir);
	let stopProxy: (() => void) | null = null;
	try {
		const egress = prepareRunEgress({
			mfwHome,
			runDir,
			runId,
			allow: harnessAllowlist(req.cli, { telemetry: false, apiKeyAuth: false }),
		});
		stopProxy = await (req.startProxy ?? startRealProxy)(
			egress.configPath,
			egress.socketPath,
		);
		const request: AgentLaunchRequest = {
			version: 1,
			runId,
			role: req.role,
			approvalMode: "autonomous",
			cli: req.cli,
			tree: realpathSync(req.tree),
			runDir,
			projectRoot: realpathSync(req.projectRoot),
			stateDir,
			mfwHome,
			env: harnessEgressEnv(req.cli, { telemetry: false }),
			secretNames: [],
			egressSocketDir: egress.socketDir,
		};
		const launched = await launchAgentSandbox(request, req.argv, {
			...steps,
			db: handle.db,
			secretValue: () => undefined,
			warn: () => {},
		});
		if (!launched.ok) {
			throw new SandboxUnavailableError(
				`the reviewer sandbox was refused (${launched.code}): ${launched.reason}. Fix: ${launched.fix}`,
			);
		}
		const { child } = launched;
		const stdin = child.stdin as unknown as {
			write(s: string): unknown;
			end(): unknown;
		};
		try {
			stdin.write(req.prompt);
			stdin.end();
		} catch {
			// The agent already exited; its status says why.
		}
		let timedOut = false;
		const kill = () => child.kill("SIGKILL");
		const timer = setTimeout(() => {
			timedOut = true;
			kill();
		}, req.timeoutMs);
		req.signal?.addEventListener("abort", kill, { once: true });
		try {
			const [out, err, exitCode] = await Promise.all([
				drainTail(child.stdout as never, req.maxOutputBytes),
				drainTail(child.stderr as never, req.maxOutputBytes),
				child.exited,
			]);
			const signalCode = (child.signalCode ?? null) as NodeJS.Signals | null;
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
			req.signal?.removeEventListener("abort", kill);
		}
	} finally {
		stopProxy?.();
		handle.close();
		rmSync(runDir, { recursive: true, force: true });
	}
}
