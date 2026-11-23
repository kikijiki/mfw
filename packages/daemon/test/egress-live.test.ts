import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import net from "node:net";
import { dirname, join, resolve } from "node:path";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import {
	type AgentLaunchRequest,
	launchAgentSandbox,
} from "../src/containment/agent-launch.ts";
import {
	AGENT_BASE_TOOLS,
	TEMPORARY_FLEET_WRITABLE,
} from "../src/containment/agent-profile.ts";
import {
	createConnectionGate,
	type EgressLogEntry,
	type EgressProxy,
	startEgressProxy,
} from "../src/containment/egress-proxy.ts";
import {
	prepareRunEgress,
	type RunEgressPaths,
} from "../src/containment/egress-run.ts";
import { ensureRunDirLayout } from "../src/containment/run-dir.ts";
import { type CageConfig, cagedSteps } from "./support/caged-launch.ts";

/**
 * Egress through the real launcher, probe and bwrap, with a fake agent and a
 * fake upstream on loopback. The proxy's resolver and dialer are the test seam:
 * names resolve to a label address that is never dialed, and every upstream
 * connection lands on the local server. Nothing here reaches the internet, and
 * the agent checks it has no route before trying a direct connection.
 */

const BWRAP = Bun.which("bwrap");
const GIT = Bun.which("git");
const BUN = realpathSync(process.execPath);
const FIXTURES = resolve(import.meta.dir, "../../../.live-sandbox");
/** Only a label: the dial seam never connects to it. */
const LABEL_IP = "1.1.1.1";

function skipReason(): string | null {
	if (process.arch !== "x64") return "seccomp is x86_64 only";
	if (!BWRAP || !GIT) return "no bwrap or git";
	const r = Bun.spawnSync([
		BWRAP,
		"--unshare-all",
		"--unshare-user",
		"--disable-userns",
		"--ro-bind",
		"/",
		"/",
		"--proc",
		"/proc",
		"--dev",
		"/dev",
		"--",
		"true",
	]);
	return r.exitCode === 0 ? null : "bwrap cannot run here";
}
const skip = skipReason();
if (skip && process.env.MFW_REQUIRE_LIVE_SANDBOX === "1") {
	throw new Error(`MFW_REQUIRE_LIVE_SANDBOX is set, but ${skip}`);
}
if (skip) console.log(`[egress-live] skipped: ${skip}`);

/** Runs inside the sandbox. Reports what it could reach as JSON in the outbox. */
const AGENT = String.raw`
const net = require("node:net");
const fs = require("node:fs");
const spec = __SPEC__;

function viaRelay(authority) {
  return new Promise((done) => {
    let buf = "", tunnelled = false, settled = false, refused = null;
    const finish = (r) => { if (!settled) { settled = true; c.destroy(); done(r); } };
    const c = net.connect(3128, "127.0.0.1", () =>
      c.write("CONNECT " + authority + " HTTP/1.1\r\nHost: " + authority + "\r\n\r\n"));
    c.on("data", (d) => {
      buf += d.toString("latin1");
      if (!tunnelled && buf.includes("\r\n\r\n")) {
        const status = Number(buf.split(" ")[1]);
        if (status !== 200) {
          refused = { status, denied: /X-Mfw-Egress: denied/.test(buf), body: buf.split("\r\n\r\n")[1] };
          return;
        }
        tunnelled = true;
        buf = "";
        c.write("ping");
      } else if (tunnelled && buf.includes("pong:ping")) {
        finish({ status: 200, echoed: true });
      }
    });
    c.on("error", (e) => finish({ error: e.code }));
    c.on("close", () => finish(refused ?? { status: 0, closed: true }));
    setTimeout(() => finish({ timeout: true }), 8000);
  });
}

function direct(host, port) {
  return new Promise((done) => {
    const c = net.connect(port, host);
    c.on("connect", () => { c.destroy(); done("connected"); });
    c.on("error", (e) => done(e.code));
    setTimeout(() => { c.destroy(); done("timeout"); }, 3000);
  });
}

/** Send raw bytes to the relay, optionally a byte at a time, and read the status. */
function rawRelay(bytes, dripMs) {
  return new Promise((done) => {
    const started = Date.now();
    let buf = "", settled = false, timer = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      c.destroy();
      done({ status: Number(buf.split(" ")[1]) || 0, denied: /X-Mfw-Egress: denied/.test(buf), ms: Date.now() - started });
    };
    const c = net.connect(3128, "127.0.0.1", () => {
      if (!dripMs) { c.write(bytes); return; }
      let i = 0;
      timer = setInterval(() => { if (i < bytes.length && !c.destroyed) c.write(bytes[i++]); }, dripMs);
    });
    c.on("data", (d) => { buf += d.toString("latin1"); });
    c.on("error", finish);
    c.on("close", finish);
    setTimeout(finish, 6000);
  });
}

/** Ask the allowed upstream for a redirect, and return where it points. */
function redirectTarget() {
  return new Promise((done) => {
    let buf = "", tunnelled = false;
    const c = net.connect(3128, "127.0.0.1", () => c.write("CONNECT allowed.test:443 HTTP/1.1\r\n\r\n"));
    c.on("data", (d) => {
      buf += d.toString("latin1");
      if (!tunnelled && buf.includes("\r\n\r\n")) { tunnelled = true; buf = ""; c.write("redirect"); return; }
      const m = /Location: http:\/\/([^/\r]+)/.exec(buf);
      if (m) { c.destroy(); done(m[1]); }
    });
    c.on("error", () => done(null));
    setTimeout(() => { c.destroy(); done(null); }, 4000);
  });
}

(async () => {
  const out = { targets: {}, direct: {}, visible: {}, raw: {} };
  out.routes = fs.readFileSync("/proc/net/route", "utf8").trim().split("\n").length - 1;
  out.proxyEnv = process.env.HTTPS_PROXY;
  out.nodeEnvProxy = process.env.NODE_USE_ENV_PROXY;
  out.socketDir = fs.readdirSync("/run/mfw/egress");
  for (const t of spec.targets) out.targets[t] = await viaRelay(t);
  // Only with no route out, so a broken sandbox can never send a packet.
  if (out.routes === 0) {
    out.direct.upstream = await direct("127.0.0.1", spec.upstreamPort);
    // Through bash: Bun reports every failed connect as ECONNREFUSED.
    const tried = require("node:child_process").spawnSync("bash", ["-c", "(exec 3<>/dev/tcp/192.0.2.1/443) 2>&1"], { encoding: "utf8", timeout: 3000 });
    out.direct.external = tried.status !== 0 && /Network is unreachable/.test(tried.stdout) ? "ENETUNREACH" : "other: " + tried.stdout;
  }
  if (spec.hostile) {
    out.raw.oversized = await rawRelay("CONNECT allowed.test:443 HTTP/1.1\r\nX-Pad: " + "a".repeat(9000) + "\r\n\r\n");
    out.raw.plainHttp = await rawRelay("GET http://allowed.test/ HTTP/1.1\r\nHost: allowed.test\r\n\r\n");
    out.raw.slowLoris = await rawRelay("CONNECT allowed.test:443 HTTP/1.1\r\nX-Slow: " + "a".repeat(200), 40);
    const location = await redirectTarget();
    out.raw.redirectLocation = location;
    out.raw.redirectFollowed = await viaRelay(location + ":80");
    out.raw.afterAbuse = await viaRelay("allowed.test:443");
  }
  for (const p of spec.hidden) out.visible[p] = fs.existsSync(p);
  fs.writeFileSync("/mfw-run/outbox/result.json", JSON.stringify(out));
})();
`;

interface Run {
	runId: string;
	tree: string;
	runDir: string;
	egress: RunEgressPaths;
	proxy: EgressProxy;
	log: EgressLogEntry[];
}

interface AgentReport {
	routes: number;
	proxyEnv: string;
	nodeEnvProxy: string;
	socketDir: string[];
	targets: Record<
		string,
		{
			status?: number;
			denied?: boolean;
			echoed?: boolean;
			body?: string;
			error?: string;
			timeout?: boolean;
		}
	>;
	direct: { upstream?: string; external?: string };
	visible: Record<string, boolean>;
	raw: {
		oversized?: RawAnswer;
		plainHttp?: RawAnswer;
		slowLoris?: RawAnswer;
		redirectLocation?: string | null;
		redirectFollowed?: { status?: number; denied?: boolean };
		afterAbuse?: { echoed?: boolean };
	};
}

interface RawAnswer {
	status: number;
	denied: boolean;
	ms: number;
}

async function until(check: () => boolean, ms = 5_000): Promise<void> {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) throw new Error("condition not met in time");
		await Bun.sleep(20);
	}
}

const NAMES: Record<string, string[]> = {
	"allowed.test": [LABEL_IP],
	"rebind.test": ["127.0.0.1"],
	"mixed.test": [LABEL_IP, "10.0.0.8"],
	"metadata.test": ["169.254.169.254"],
};

describe.skipIf(skip !== null)("egress through the real launch path", () => {
	let base: string;
	let home: string;
	let mfwHome: string;
	let project: string;
	let stateDir: string;
	let cage: CageConfig;
	let handle: ProjectDbHandle;
	let upstream: net.Server;
	let upstreamPort: number;
	const gate = createConnectionGate(32);
	const runs: Run[] = [];

	async function makeRun(): Promise<Run> {
		const runId = `eg-${randomUUID().slice(0, 12)}`;
		const clone = join(mfwHome, "workspaces", runId);
		const tree = join(clone, "tree");
		const gitDir = join(clone, "git");
		mkdirSync(tree, { recursive: true });
		mkdirSync(gitDir);
		writeFileSync(join(clone, "mfw-workspace.json"), "{}");
		Bun.spawnSync([
			GIT as string,
			"--git-dir",
			gitDir,
			"init",
			"-q",
			"--template=",
		]);
		const runDir = join(stateDir, "runs", runId);
		ensureRunDirLayout(runDir);
		const egress = prepareRunEgress({
			mfwHome,
			runDir,
			runId,
			allow: [{ host: "allowed.test", port: 443 }],
		});
		const log: EgressLogEntry[] = [];
		const proxy = await startEgressProxy({
			runId,
			socketPath: egress.socketPath,
			allow: ["allowed.test", "rebind.test", "mixed.test", "metadata.test"],
			gate,
			log: (e) => log.push(e),
			resolve: async (name) => {
				const answers = NAMES[name.replace(/\.$/, "")];
				if (!answers) throw new Error("no such name");
				return answers;
			},
			connect: () => net.connect(upstreamPort, "127.0.0.1"),
			limits: { headerDeadlineMs: 700 },
		});
		const run = { runId, tree, runDir, egress, proxy, log };
		runs.push(run);
		return run;
	}

	async function runAgent(
		run: Run,
		targets: string[],
		hidden: string[] = [],
		hostile = false,
	): Promise<AgentReport> {
		const script = join(home, ".local/bin/claude");
		writeFileSync(
			script,
			`#!${BUN}\n${AGENT.replace("__SPEC__", JSON.stringify({ targets, upstreamPort, hidden, hostile }))}`,
		);
		chmodSync(script, 0o755);
		const req: AgentLaunchRequest = {
			version: 1,
			runId: run.runId,
			role: "task",
			approvalMode: "autonomous",
			cli: "claude",
			tree: run.tree,
			runDir: run.runDir,
			projectRoot: project,
			stateDir,
			mfwHome,
			env: { MFW_RUN_ID: run.runId },
			secretNames: [],
			egressSocketDir: run.egress.socketDir,
		};
		const launched = await launchAgentSandbox(req, ["claude"], {
			...cagedSteps(cage),
			db: handle.db,
			secretValue: () => undefined,
			warn: () => {},
		});
		if (!launched.ok) {
			throw new Error(`refused: ${launched.code}: ${launched.reason}`);
		}
		const { child } = launched;
		(child.stdin as unknown as { end(): void }).end();
		const [, stderr, code] = await Promise.all([
			new Response(child.stdout as never).text(),
			new Response(child.stderr as never).text(),
			child.exited,
		]);
		const result = join(run.runDir, "outbox/result.json");
		if (!existsSync(result)) {
			throw new Error(`agent wrote no report (exit ${code}): ${stderr}`);
		}
		return JSON.parse(readFileSync(result, "utf8")) as AgentReport;
	}

	beforeAll(async () => {
		mkdirSync(FIXTURES, { recursive: true });
		base = realpathSync(mkdtempSync(join(FIXTURES, "egress-")));
		home = join(base, "home");
		const bin = join(home, ".local/bin");
		mkdirSync(bin, { recursive: true });
		mfwHome = join(base, "mfw");
		mkdirSync(mfwHome, { mode: 0o700 });
		for (const cli of ["claude", "codex"] as const) {
			for (const rel of TEMPORARY_FLEET_WRITABLE[cli]) {
				mkdirSync(join(mfwHome, "agents", cli, rel), { recursive: true });
			}
		}
		project = join(base, "project");
		mkdirSync(project);
		stateDir = join(project, ".mfw");
		handle = await openProjectDb(stateDir);
		const shim = join(base, "systemd-run-shim");
		writeFileSync(
			shim,
			'#!/bin/sh\nwhile [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n',
		);
		chmodSync(shim, 0o755);
		const toolDirs = AGENT_BASE_TOOLS.flatMap((tool) => {
			const found = Bun.which(tool);
			return found ? [dirname(realpathSync(found))] : [];
		});
		cage = {
			home,
			path: [
				bin,
				dirname(BUN),
				dirname(realpathSync(GIT as string)),
				...new Set(toolDirs),
			].join(":"),
			shim,
		};
		upstream = net.createServer((s) => {
			s.on("data", (d) => {
				s.write(
					d.toString() === "redirect"
						? "HTTP/1.1 302 Found\r\nLocation: http://169.254.169.254/latest/meta-data\r\n\r\n"
						: `pong:${d.toString()}`,
				);
			});
			s.on("error", () => s.destroy());
		});
		await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
		upstreamPort = (upstream.address() as net.AddressInfo).port;
	});

	afterAll(async () => {
		for (const r of runs) await r.proxy.close().catch(() => {});
		await new Promise<void>((r) => upstream.close(() => r()));
		handle.close();
		rmSync(base, { recursive: true, force: true });
	});

	test("an allowed host is reachable and everything else is not", async () => {
		const run = await makeRun();
		const out = await runAgent(run, [
			"allowed.test:443",
			"denied.test:443",
			"allowed.test:8443",
			"127.0.0.1:443",
			"2130706433:443",
			"rebind.test:443",
			"mixed.test:443",
			"metadata.test:443",
		]);
		// Positive controls: the sandbox has the relay and no route.
		expect(out.routes).toBe(0);
		expect(out.proxyEnv).toBe("http://127.0.0.1:3128");
		expect(out.nodeEnvProxy).toBe("1");
		expect(out.socketDir).toEqual(["e.sock"]);
		expect(out.targets["allowed.test:443"]?.echoed).toBe(true);
		for (const t of [
			"denied.test:443",
			"allowed.test:8443",
			"127.0.0.1:443",
			"2130706433:443",
			"rebind.test:443",
			"mixed.test:443",
			"metadata.test:443",
		]) {
			expect([t, out.targets[t]?.status]).toEqual([t, 403]);
			expect(out.targets[t]?.denied).toBe(true);
		}
		// No direct path: not to the host's loopback server, not outward.
		expect(out.direct.upstream).toBe("ECONNREFUSED");
		expect(out.direct.external).toBe("ENETUNREACH");
		const denied = run.log.filter((e) => e.decision === "DENY");
		expect(denied.some((e) => e.host === "denied.test")).toBe(true);
	}, 90_000);

	test("hostile requests are refused and the proxy keeps serving", async () => {
		const run = await makeRun();
		const out = await runAgent(run, [], [], true);
		expect(out.raw.oversized).toMatchObject({ status: 431, denied: true });
		expect(out.raw.plainHttp).toMatchObject({ status: 405, denied: true });
		// A drip does not extend the total deadline.
		expect(out.raw.slowLoris).toMatchObject({ status: 408, denied: true });
		expect(out.raw.slowLoris?.ms).toBeLessThan(3_000);
		// The redirect is the upstream's to send; following it is a new request.
		expect(out.raw.redirectLocation).toBe("169.254.169.254");
		expect(out.raw.redirectFollowed).toMatchObject({
			status: 403,
			denied: true,
		});
		expect(out.raw.afterAbuse?.echoed).toBe(true);
		const reasons = run.log.flatMap((e) =>
			e.decision === "DENY" ? [e.reason] : [],
		);
		expect(reasons).toEqual(
			expect.arrayContaining([
				"head-too-large",
				"not-connect",
				"header-timeout",
				"numeric-host",
			]),
		);
		await until(() => run.proxy.active === 0);
	}, 90_000);

	test("a run sees neither another run's socket nor its counters", async () => {
		const a = await makeRun();
		const b = await makeRun();
		writeFileSync(b.egress.statsPath, "{}");
		const out = await runAgent(
			a,
			["allowed.test:443"],
			[
				b.egress.socketPath,
				b.egress.socketDir,
				b.egress.statsPath,
				b.egress.configPath,
				a.egress.statsPath,
				a.egress.configPath,
				a.egress.socketPath,
			],
		);
		expect(out.targets["allowed.test:443"]?.echoed).toBe(true);
		expect(Object.values(out.visible)).toEqual(
			Object.values(out.visible).map(() => false),
		);
		expect(Object.keys(out.visible).length).toBe(7);
		expect(b.log.filter((e) => e.decision === "ALLOW")).toEqual([]);
	}, 90_000);
});
