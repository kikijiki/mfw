import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
import { join, resolve } from "node:path";
import type { LaunchSpec } from "../src/agent-host.ts";
import {
	processStartTicks,
	runEgressPaths,
	sweepRunEgress,
} from "../src/containment/egress-run.ts";

/**
 * The proxy's life through the real generated `run.sh`, with a fake driver and
 * a stand-in daemon that is really killed with SIGKILL. Everything lives under
 * a throwaway directory, and no agent or sandbox is started.
 */

const FIXTURES = resolve(import.meta.dir, "../../../.live-sandbox");
const FAKE_DAEMON = resolve(import.meta.dir, "support/egress-fake-daemon.ts");

let base: string;
let mfwHome: string;
let control: string;
let runId: string;
let runDir: string;
let driverPid: string;
const pids: number[] = [];
const spawned: Bun.Subprocess[] = [];

const alive = (pid: number, ticks: string | null) =>
	ticks !== null && processStartTicks(pid) === ticks;

/** Not a zombie: the state field of `/proc/<pid>/stat`. */
function running(pid: number): boolean {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "latin1");
		return (
			stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z"
		);
	} catch {
		return false;
	}
}

async function until(check: () => boolean, ms = 20_000): Promise<void> {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) throw new Error("condition not met in time");
		await Bun.sleep(25);
	}
}

function ask(socketPath: string): Promise<string> {
	return new Promise((done, fail) => {
		let out = "";
		const c = net.connect(socketPath, () =>
			c.write("CONNECT denied.invalid:443 HTTP/1.1\r\nHost: x\r\n\r\n"),
		);
		c.on("data", (d) => {
			out += d.toString();
		});
		c.on("close", () => done(out));
		c.on("error", fail);
	});
}

beforeEach(() => {
	mkdirSync(FIXTURES, { recursive: true });
	base = realpathSync(mkdtempSync(join(FIXTURES, "egl-")));
	mfwHome = join(base, "mfw");
	control = join(base, "control");
	mkdirSync(control, { mode: 0o700 });
	runId = `life-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
	runDir = join(base, "project/.mfw/runs", runId);
	mkdirSync(runDir, { recursive: true });
	writeFileSync(join(base, "project/.mfw/mfw.db"), "");
	mkdirSync(join(mfwHome, "workspaces", runId, "tree"), { recursive: true });
	driverPid = join(base, "driver.pid");
});

afterEach(() => {
	for (const pid of pids.splice(0)) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	}
	for (const c of spawned.splice(0)) c.kill("SIGKILL");
	rmSync(base, { recursive: true, force: true });
});

/** A driver that records its pid and runs until its release file appears. */
function spec(): LaunchSpec {
	const driver = join(base, "driver.ts");
	writeFileSync(
		driver,
		`import { existsSync, writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(driverPid)}, String(process.pid));
const t = setInterval(() => {
  if (existsSync(${JSON.stringify(join(base, "release"))})) { clearInterval(t); process.exit(0); }
}, 25);
`,
	);
	chmodSync(driver, 0o644);
	return {
		runId,
		runDir,
		cwd: join(mfwHome, "workspaces", runId, "tree"),
		projectRoot: join(base, "project"),
		driverScript: driver,
		agentArgv: ["claude", "--print"],
		bridgeArgv: ["bun", "run", "/opt/mfw/bridge.ts"],
		providerArgv: ["claude", "--print"],
		env: { MFW_RUN_ID: runId },
		steer: false,
		approvalMode: "interactive",
		isolation: { mode: "bwrap", hidePaths: [mfwHome], mfwHome },
		runKind: "task",
		providerId: "claude-cli",
	};
}

/** Launch through the stand-in daemon, and wait for the proxy and the driver. */
async function launch() {
	const daemon = Bun.spawn(
		[process.execPath, "run", FAKE_DAEMON, JSON.stringify(spec()), control],
		{ stdout: "pipe", stderr: "pipe", stdin: "ignore" },
	);
	spawned.push(daemon);
	const reader = (daemon.stdout as ReadableStream<Uint8Array>).getReader();
	const { value } = await reader.read();
	reader.releaseLock();
	const pane = Number(new TextDecoder().decode(value).trim());
	if (!Number.isInteger(pane) || pane <= 0) {
		throw new Error(
			`the daemon did not launch: ${await new Response(daemon.stderr as ReadableStream).text()}`,
		);
	}
	pids.push(pane);
	const paths = runEgressPaths(mfwHome, runDir, runId);
	const proxyPid = () => {
		try {
			return (
				JSON.parse(readFileSync(paths.indexPath, "utf8")) as { pid?: number }
			).pid;
		} catch {
			return undefined;
		}
	};
	await until(() => existsSync(driverPid) && proxyPid() !== undefined);
	const proxy = proxyPid() as number;
	const driver = Number(readFileSync(driverPid, "utf8"));
	pids.push(proxy, driver);
	return {
		daemon,
		pane,
		proxy,
		driver,
		paths,
		ticks: processStartTicks(proxy),
	};
}

describe("the proxy through the real run script", () => {
	test("starts before the driver with no inherited environment, and ends with the run", async () => {
		const run = await launch();
		expect(existsSync(run.paths.socketPath)).toBe(true);
		expect(readFileSync(`/proc/${run.proxy}/environ`).length).toBe(0);
		// Its own descriptor limit, whatever the launching shell had.
		expect(readFileSync(`/proc/${run.proxy}/limits`, "utf8")).toMatch(
			/Max open files\s+512\s+512/,
		);
		expect(await ask(run.paths.socketPath)).toContain("X-Mfw-Egress: denied");
		writeFileSync(join(base, "release"), "");
		await until(() => existsSync(join(control, `exit-${runId}`)));
		// The script waits for the proxy, so its counters are down before the exit is.
		const stats = JSON.parse(readFileSync(run.paths.statsPath, "utf8"));
		expect(stats.denied["denied.invalid:443"].count).toBe(1);
		expect(alive(run.proxy, run.ticks) && running(run.proxy)).toBe(false);
		expect(existsSync(run.paths.socketDir)).toBe(false);
		expect(existsSync(run.paths.indexPath)).toBe(false);
	}, 60_000);

	test("a stuck proxy cannot hold up the run's exit record", async () => {
		const run = await launch();
		process.kill(run.proxy, "SIGSTOP");
		writeFileSync(join(base, "release"), "");
		await until(() => existsSync(join(control, `exit-${runId}`)), 15_000);
		expect(readFileSync(join(control, `exit-${runId}`), "utf8")).toBe("exit:0");
		// The run script signals nothing, so the stuck proxy is recovery's to remove.
		expect(alive(run.proxy, run.ticks)).toBe(true);
		expect(existsSync(run.paths.socketDir)).toBe(true);
		const report = await sweepRunEgress(mfwHome, async () => false, {
			graceMs: 0,
		});
		expect(report).toEqual({ killed: 1, removed: 1, kept: 0 });
		await until(() => !running(run.proxy));
		expect(existsSync(run.paths.socketDir)).toBe(false);
	}, 60_000);

	test("kill -9 of the daemon: the run keeps its proxy, and recovery leaves it", async () => {
		const run = await launch();
		run.daemon.kill("SIGKILL");
		await run.daemon.exited;
		expect(running(run.proxy)).toBe(true);
		expect(await ask(run.paths.socketPath)).toContain("X-Mfw-Egress: denied");
		const report = await sweepRunEgress(mfwHome, async () => true, {
			graceMs: 0,
		});
		expect(report).toEqual({ killed: 0, removed: 0, kept: 1 });
		expect(await ask(run.paths.socketPath)).toContain("X-Mfw-Egress: denied");
	}, 60_000);

	test("kill -9 of the run script ends the proxy with no daemon involved", async () => {
		const run = await launch();
		run.daemon.kill("SIGKILL");
		await run.daemon.exited;
		process.kill(run.pane, "SIGKILL");
		await until(() => !running(run.proxy));
		await until(() => !existsSync(run.paths.socketDir));
		expect(existsSync(run.paths.indexPath)).toBe(false);
	}, 60_000);

	test("recovery kills a proxy that outlived its run and removes its socket dir", async () => {
		const run = await launch();
		run.daemon.kill("SIGKILL");
		await run.daemon.exited;
		// Stopped, it cannot notice its pipe closing: a true orphan.
		process.kill(run.proxy, "SIGSTOP");
		process.kill(run.pane, "SIGKILL");
		process.kill(run.driver, "SIGKILL");
		await until(() => !running(run.pane));
		expect(alive(run.proxy, run.ticks)).toBe(true);
		const report = await sweepRunEgress(mfwHome, async () => false, {
			graceMs: 0,
		});
		expect(report).toEqual({ killed: 1, removed: 1, kept: 0 });
		await until(() => !running(run.proxy));
		expect(existsSync(run.paths.socketDir)).toBe(false);
		expect(existsSync(run.paths.indexPath)).toBe(false);
	}, 60_000);
});
