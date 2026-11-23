import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import net from "node:net";
import { realLaunchSteps } from "../../src/containment/agent-launch.ts";
import type { LauncherSteps } from "../../src/containment/agent-launch-run.ts";
import { recordAttestation } from "../../src/containment/attestation-store.ts";
import {
	type CompileHost,
	compileBwrap,
} from "../../src/containment/compile-bwrap.ts";
import type { Check } from "../../src/containment/host-caps.ts";
import type { PinIdentity } from "../../src/containment/pinned-binds.ts";
import { collectProbe } from "../../src/containment/probe-collect.ts";
import { probeOutcome } from "../../src/containment/probe-evaluate.ts";
import {
	buildProbePlan,
	probeCommand,
	probeToolchainTargets,
	sandboxFingerprint,
} from "../../src/containment/probe-run.ts";
import {
	effectiveLimits,
	memoryBytes,
	parseSandboxProfile,
} from "../../src/containment/profile.ts";
import { discoverToolchain } from "../../src/containment/toolchain.ts";

/**
 * The launch path as far as a host without a user manager can run it: real
 * bwrap, real probe, real gate, real launcher. Only the systemd layer is a
 * stand-in: a `systemd-run` shim that execs its command, and a cgroup reading
 * that echoes the profile's limits. So these tests say nothing about the real
 * scope, which stays unverified until it runs on a real host.
 */

export interface CageConfig {
	home: string;
	/** PATH for toolchain discovery. */
	path: string;
	/** The `systemd-run` stand-in. */
	shim: string;
}

const pass = <T>(value: T): Check<T> => ({
	ok: true,
	severity: "required",
	value,
	detail: "ok",
});

const realOrNull = (p: string) => {
	try {
		return realpathSync(p);
	} catch {
		return null;
	}
};

export function cagedSteps(cage: CageConfig): LauncherSteps {
	const compileHost: LauncherSteps["compileHost"] = async (
		req,
		binaries,
		allowedRoots,
	): Promise<CompileHost> => ({
		caps: {
			userns: pass({ unprivileged: true } as never),
			bwrap: pass({ version: "0.13.1", disableUserns: true }),
			systemd: pass({
				hostKind: "native",
				manager: true,
				delegated: ["cpu", "memory", "pids"],
				missing: [],
			}),
			arch: pass("x86_64"),
		},
		bwrapPath: Bun.which("bwrap") as string,
		envPath: Bun.which("env") as string,
		systemdRunPath: cage.shim,
		toolchain: discoverToolchain({
			home: cage.home,
			binaries,
			path: cage.path,
		}),
		home: cage.home,
		mfwHome: req.mfwHome,
		projectDbDirs: [req.stateDir],
		allowedRoots,
		realpath: realOrNull,
	});

	const attest = (async (req) => {
		const profile = parseSandboxProfile(req.profile);
		const bun = req.host.toolchain.resolved.find((b) => b.name === "bun");
		if (!bun) throw new Error("no bun in the caged toolchain");
		const compiled = compileBwrap(profile, probeCommand(bun.path), req.host);
		if (!compiled.ok) {
			return {
				ok: false,
				code: "compile_refused",
				reason: compiled.reason,
				fix: compiled.fix,
			};
		}
		const limits = effectiveLimits(profile);
		const server = net.createServer((s) => s.destroy());
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		let pins: PinIdentity[] = [];
		const items = await collectProbe(
			compiled,
			buildProbePlan(
				profile,
				compiled,
				{
					...req.targets,
					...probeToolchainTargets(req.host.toolchain),
					realpath: req.host.realpath,
				},
				{
					nonce: randomBytes(16).toString("hex"),
					loopbackPort: (server.address() as net.AddressInfo).port,
					scope: "systemd",
				},
			),
			{
				scope: "systemd",
				timeoutMs: 40_000,
				readCgroup: () => ({
					path: "/user.slice/caged.scope",
					memoryMax: String(memoryBytes(limits.memoryMax)),
					pidsMax: String(limits.tasksMax),
					swapMax: "0",
				}),
				observePins: (seen) => {
					pins = seen;
				},
			},
		);
		await new Promise<void>((r) => server.close(() => r()));
		const outcome = probeOutcome(items);
		const fingerprint = sandboxFingerprint(profile, compiled);
		const attestationId = await recordAttestation(req.db, {
			runId: req.runId,
			...fingerprint,
			bwrapVersion: req.host.caps.bwrap.value.version ?? "unknown",
			scope: "systemd",
			outcome,
			items,
			pins,
			createdAt: new Date(),
		});
		return { ok: true, attestationId, outcome, items, fingerprint, pins };
	}) as LauncherSteps["attest"];

	return {
		compileHost,
		attest,
		authorize: realLaunchSteps.authorize,
		launch: realLaunchSteps.launch,
	};
}
