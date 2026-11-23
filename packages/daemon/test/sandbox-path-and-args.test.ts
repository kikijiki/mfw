import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AgentHost } from "../src/agent-host.ts";
import { buildProbeScript } from "../src/containment/minimal-probe.ts";
import { SecretEnvironment } from "../src/execution-environment.ts";
import { runProc } from "../src/proc.ts";
import {
	agentSandboxPath,
	resetBwrapAvailableCache,
	trustedPathEntries,
} from "../src/sandbox.ts";
import {
	baseSpec,
	fakeHome,
	installCleanup,
	plant,
	savedEnv,
	usable,
	waitFor,
} from "./support/review-fixes.ts";
import { runShTmux } from "./support/run-sh-tmux.ts";

/** Security review wave 1 (C), X6, X7, X13: no secret in an argv, no planted binary ahead of a trusted one, probe gaps. */

installCleanup();

describe("X7: a planted binary in a run-writable PATH entry never runs before or instead of a trusted one", () => {
	test("agentSandboxPath puts trusted entries first and keeps the rest after them", async () => {
		const { home } = await fakeHome();
		process.env.HOME = home;
		const planted = join(home, "bin");
		const pathVar = `${planted}:${savedEnv.PATH}`;
		const out = agentSandboxPath(pathVar).split(":");
		const trusted = trustedPathEntries(pathVar);
		expect(trusted).not.toContain(planted);
		expect(out.slice(0, trusted.length)).toEqual(trusted);
		expect(out).toContain(planted);
		expect(out.indexOf(planted)).toBeGreaterThanOrEqual(trusted.length);
	});

	test("planted sh, env, sed and bun are not run by a sandboxed launch", async () => {
		const why = await usable();
		if (why) return console.log(`skip: ${why}`);
		const { base, home, mk } = await fakeHome();
		process.env.HOME = home;
		const runDir = mk("run");
		// Planted inside the worktree: it is bound into the sandbox, so a PATH entry
		// there would be found by the old code. It is first on the daemon's PATH.
		const cwd = mk("wt");
		const planted = join(cwd, "bin");
		mkdirSync(planted);
		const marker = join(cwd, "ran");
		for (const n of ["sh", "env", "sed", "tr", "ls", "find", "head", "bun"]) {
			plant(planted, n, marker);
		}
		process.env.PATH = `${planted}:${savedEnv.PATH}`;
		resetBwrapAvailableCache();
		const driver = join(base, "driver.ts");
		writeFileSync(
			driver,
			`require("node:fs").writeFileSync(${JSON.stringify(join(runDir, "outbox", "ok"))}, "1");`,
		);
		const { runner, procs } = runShTmux();
		const host = new AgentHost(undefined, { tmuxRunner: runner });
		await host.launch({
			...baseSpec(base, "x7", runDir, cwd),
			driverScript: driver,
		});
		await procs.get("mfw_x7")?.exited;
		expect(await waitFor(() => existsSync(join(runDir, "outbox", "ok")))).toBe(
			true,
		);
		expect(existsSync(marker) ? await readFile(marker, "utf8") : "").toBe("");
	}, 40_000);
});

describe("X6: secrets are never in an argv", () => {
	test("no host or sandbox process has the secret on its command line, yet the driver gets it", async () => {
		const why = await usable();
		if (why) return console.log(`skip: ${why}`);
		const { base, mk } = await fakeHome();
		const runDir = mk("run");
		const cwd = mk("wt");
		const canary = "canary-x6-9f1c2e7a";
		const driver = join(base, "driver.ts");
		writeFileSync(
			driver,
			`
const fs = require("node:fs");
const leaked = [];
for (const pid of fs.readdirSync("/proc").filter((d) => /^[0-9]+$/.test(d))) {
  try { if (fs.readFileSync("/proc/" + pid + "/cmdline", "utf8").includes(${JSON.stringify(canary)})) leaked.push(pid); } catch {}
}
fs.writeFileSync(${JSON.stringify(join(runDir, "outbox", "seen.json"))}, JSON.stringify({ got: process.env.MFW_X6_SECRET, leaked }));
const t0 = Date.now();
while (!fs.existsSync(${JSON.stringify(join(runDir, "outbox", "release"))}) && Date.now() - t0 < 10000) await new Promise((r) => setTimeout(r, 25));
`,
		);
		const { runner, procs } = runShTmux();
		const host = new AgentHost(undefined, { tmuxRunner: runner });
		await host.launch({
			...baseSpec(base, "x6", runDir, cwd),
			driverScript: driver,
			secretEnvironment: new SecretEnvironment({ MFW_X6_SECRET: canary }),
		});
		expect(
			await waitFor(() => existsSync(join(runDir, "outbox", "seen.json"))),
		).toBe(true);
		// The host's own view while the sandbox is alive: no process carries the secret.
		const hostLeaks: string[] = [];
		const { readdirSync, readFileSync } = await import("node:fs");
		for (const pid of readdirSync("/proc").filter((d) => /^[0-9]+$/.test(d))) {
			try {
				if (readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(canary))
					hostLeaks.push(pid);
			} catch {}
		}
		writeFileSync(join(runDir, "outbox", "release"), "1");
		await procs.get("mfw_x6")?.exited;
		const seen = JSON.parse(
			await readFile(join(runDir, "outbox", "seen.json"), "utf8"),
		);
		expect(seen.got).toBe(canary);
		expect(seen.leaked).toEqual([]);
		expect(hostLeaks).toEqual([]);
	}, 40_000);
});

describe("X13: probe gaps", () => {
	const spec = {
		allowedEnv: ["PATH"],
		emptyDirs: [],
		noSocketDirs: [],
		checkPid1Environ: false,
	};
	test("an environment name that is not a shell identifier is a leak", async () => {
		const r = await runProc(
			[
				"env",
				"-i",
				`PATH=${savedEnv.PATH}`,
				"MFW_PROBE_SENTINEL=1",
				"BAD-NAME=secret",
				"bash",
				"-c",
				buildProbeScript(spec),
			],
			{ timeoutMs: 10_000 },
		);
		expect(r.exitCode).toBe(78);
		expect(r.stderr).toContain("BAD-NAME");
		expect(r.stderr).not.toContain("secret");
	});

	test("an unreadable /proc/1/environ fails the probe instead of being skipped", async () => {
		if (
			existsSync("/proc/1/environ") &&
			(await Bun.file("/proc/1/environ")
				.text()
				.then(
					() => true,
					() => false,
				))
		) {
			return console.log("skip: /proc/1/environ is readable here (root)");
		}
		const r = await runProc(
			[
				"env",
				"-i",
				`PATH=${savedEnv.PATH}`,
				"MFW_PROBE_SENTINEL=1",
				"bash",
				"-c",
				buildProbeScript({ ...spec, checkPid1Environ: true }),
			],
			{ timeoutMs: 10_000 },
		);
		expect(r.exitCode).toBe(78);
		expect(r.stderr).toContain("/proc/1/environ");
	});
});
