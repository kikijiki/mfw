import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	EgressCapacityError,
	type EgressSweepReport,
	prepareRunEgress,
	processStartTicks,
	runEgressPaths,
	sweepRunEgress,
} from "../src/containment/egress-run.ts";

const MAIN = resolve(
	import.meta.dir,
	"../src/containment/egress-proxy-main.ts",
);

let root: string;
let mfwHome: string;
let runDir: string;
const children: Bun.Subprocess[] = [];

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "mfw-eg-")));
	mfwHome = join(root, "h");
	runDir = join(root, "runs", "r1");
	mkdirSync(mfwHome, { recursive: true, mode: 0o700 });
	mkdirSync(runDir, { recursive: true });
});

afterEach(() => {
	for (const c of children.splice(0)) c.kill("SIGKILL");
	rmSync(root, { recursive: true, force: true });
});

async function until(check: () => boolean, ms = 15_000): Promise<void> {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) throw new Error("condition not met in time");
		await Bun.sleep(20);
	}
}

function startProxy(runId = "r1", dir = runDir) {
	const paths = prepareRunEgress({ mfwHome, runDir: dir, runId, allow: [] });
	const child = Bun.spawn(
		[
			process.execPath,
			"--config=/dev/null",
			"--no-env-file",
			"run",
			MAIN,
			paths.configPath,
		],
		{ stdin: "pipe", stdout: "ignore", stderr: "ignore", env: {} },
	);
	children.push(child);
	return { paths, child };
}

const indexed = (path: string) =>
	JSON.parse(readFileSync(path, "utf8")) as { pid?: number };

async function listening(paths: { socketPath: string; indexPath: string }) {
	await until(
		() =>
			existsSync(paths.socketPath) &&
			indexed(paths.indexPath).pid !== undefined,
	);
}

/** Send one request and return the whole answer. */
function ask(socketPath: string, request: string): Promise<string> {
	return new Promise((done, fail) => {
		let out = "";
		const c = net.connect(socketPath, () => c.write(request));
		c.on("data", (d) => {
			out += d.toString();
		});
		c.on("close", () => done(out));
		c.on("error", fail);
	});
}

describe("per-run egress lifecycle", () => {
	test("directories are private and the socket dir holds only the socket", async () => {
		const { paths } = startProxy();
		await listening(paths);
		for (const d of [paths.socketDir, paths.stateDir]) {
			expect(statSync(d).mode & 0o077).toBe(0);
		}
		expect(statSync(paths.socketPath).mode & 0o077).toBe(0);
		expect(readdirSync(paths.socketDir)).toEqual(["e.sock"]);
		// The config and counters are not in what the sandbox binds.
		expect(paths.configPath.startsWith(paths.socketDir)).toBe(false);
		expect(paths.statsPath.startsWith(paths.socketDir)).toBe(false);
	});

	test("an empty allowlist denies, with the distinctive answer", async () => {
		const { paths } = startProxy();
		await listening(paths);
		const answer = await ask(
			paths.socketPath,
			"CONNECT example.invalid:443 HTTP/1.1\r\nHost: x\r\n\r\n",
		);
		expect(answer).toContain("403");
		expect(answer).toContain("X-Mfw-Egress: denied");
	});

	test("a denied attempt reaches the run's counters, and a relaunch adds to them", async () => {
		for (const expected of [1, 2]) {
			const { paths, child } = startProxy();
			await listening(paths);
			await ask(
				paths.socketPath,
				"CONNECT denied.invalid:443 HTTP/1.1\r\nHost: x\r\n\r\n",
			);
			(child.stdin as import("bun").FileSink).end();
			await child.exited;
			const stats = JSON.parse(readFileSync(paths.statsPath, "utf8"));
			expect(stats.denied["denied.invalid:443"]).toEqual({
				count: expected,
				lastReason: "not-allowlisted",
			});
			expect(statSync(paths.statsPath).mode & 0o077).toBe(0);
		}
	});

	test("end of the lifeline stops the proxy and removes its endpoints", async () => {
		const { paths, child } = startProxy();
		await listening(paths);
		(child.stdin as import("bun").FileSink).end();
		await child.exited;
		expect(existsSync(paths.socketDir)).toBe(false);
		expect(existsSync(paths.indexPath)).toBe(false);
	});

	test("a killed parent ends the proxy: the pipe closes whatever the cause", async () => {
		const paths = prepareRunEgress({ mfwHome, runDir, runId: "r1", allow: [] });
		const script = `exec 8> >(exec ${process.execPath} --config=/dev/null --no-env-file run ${MAIN} ${paths.configPath} >/dev/null 2>&1)\necho up\nexec sleep 60`;
		const parent = Bun.spawn(["bash", "-c", script], {
			stdout: "pipe",
			stderr: "ignore",
		});
		children.push(parent);
		await listening(paths);
		const { pid } = indexed(paths.indexPath);
		const ticks = processStartTicks(pid as number);
		expect(ticks).not.toBeNull();
		parent.kill("SIGKILL");
		await until(() => processStartTicks(pid as number) !== ticks);
		await until(() => !existsSync(paths.socketDir));
	});
});

describe("a relaunch of the same run", () => {
	test("the old proxy's exit leaves the new proxy's socket and index alone", async () => {
		const old = startProxy();
		await listening(old.paths);
		const oldPid = indexed(old.paths.indexPath).pid;
		const next = startProxy();
		await until(() => {
			const pid = indexed(next.paths.indexPath).pid;
			return (
				pid !== undefined && pid !== oldPid && existsSync(next.paths.socketPath)
			);
		});
		const nextPid = indexed(next.paths.indexPath).pid;
		(old.child.stdin as import("bun").FileSink).end();
		await old.child.exited;
		expect(existsSync(next.paths.socketPath)).toBe(true);
		expect(indexed(next.paths.indexPath).pid).toBe(nextPid);
		expect(
			await ask(
				next.paths.socketPath,
				"CONNECT x.invalid:443 HTTP/1.1\r\n\r\n",
			),
		).toContain("X-Mfw-Egress: denied");
	}, 30_000);
});

describe("recovery sweep", () => {
	const sweep = (
		live: (id: string) => boolean | null,
	): Promise<EgressSweepReport> =>
		sweepRunEgress(mfwHome, async (id) => live(id), { graceMs: 0 });

	test("kills the proxy of a dead run and removes its socket dir", async () => {
		const { paths, child } = startProxy();
		await listening(paths);
		const report = await sweep(() => false);
		await child.exited;
		expect(child.signalCode).toBe("SIGKILL");
		expect(report).toEqual({ killed: 1, removed: 1, kept: 0 });
		expect(existsSync(paths.socketDir)).toBe(false);
		expect(existsSync(paths.indexPath)).toBe(false);
	});

	test.each([
		[true],
		[null],
	])("keeps a run whose liveness is %s", async (state) => {
		const { paths, child } = startProxy();
		await listening(paths);
		const report = await sweep(() => state);
		expect(report).toEqual({ killed: 0, removed: 0, kept: 1 });
		expect(child.killed).toBe(false);
		expect(existsSync(paths.socketPath)).toBe(true);
	});

	test("keeps a launch still inside its grace period", async () => {
		const paths = prepareRunEgress({ mfwHome, runDir, runId: "r1", allow: [] });
		const report = await sweepRunEgress(mfwHome, async () => false);
		expect(report.kept).toBe(1);
		expect(existsSync(paths.socketDir)).toBe(true);
	});

	test("never signals a reused pid", async () => {
		const bystander = Bun.spawn(["sleep", "30"]);
		children.push(bystander);
		const paths = prepareRunEgress({ mfwHome, runDir, runId: "r1", allow: [] });
		writeFileSync(
			paths.indexPath,
			JSON.stringify({
				runId: "r1",
				socketDir: paths.socketDir,
				pid: bystander.pid,
				startTicks: "1",
			}),
		);
		const report = await sweep(() => false);
		expect(report.killed).toBe(0);
		expect(report.removed).toBe(1);
		expect(bystander.killed).toBe(false);
		expect(processStartTicks(bystander.pid)).not.toBeNull();
	});

	test("a forged index cannot aim the delete outside the socket root", async () => {
		const keep = join(root, "keep");
		mkdirSync(keep);
		const paths = prepareRunEgress({ mfwHome, runDir, runId: "r1", allow: [] });
		writeFileSync(
			paths.indexPath,
			JSON.stringify({ runId: "r1", socketDir: keep }),
		);
		await sweep(() => false);
		expect(existsSync(keep)).toBe(true);
		expect(existsSync(paths.socketDir)).toBe(false);
	});

	test("a damaged index entry is removed and signals nothing", async () => {
		const paths = prepareRunEgress({ mfwHome, runDir, runId: "r1", allow: [] });
		writeFileSync(paths.indexPath, "{not json");
		const report = await sweep(() => true);
		expect(report).toEqual({ killed: 0, removed: 1, kept: 0 });
		expect(existsSync(paths.socketDir)).toBe(false);
	});

	test("two runs have separate endpoints", () => {
		const a = runEgressPaths(mfwHome, join(root, "runs/a"), "a");
		const b = runEgressPaths(mfwHome, join(root, "runs/b"), "b");
		expect(a.socketDir).not.toBe(b.socketDir);
		expect(a.stateDir).not.toBe(b.stateDir);
		expect(a.indexPath).not.toBe(b.indexPath);
	});
});

describe("the machine-wide cap on proxied runs", () => {
	const fill = (runId: string, pid?: number) => {
		const paths = prepareRunEgress({
			mfwHome,
			runDir: join(root, "runs", runId),
			runId,
			allow: [],
			maxRuns: 100,
		});
		if (pid) {
			writeFileSync(
				paths.indexPath,
				JSON.stringify({
					runId,
					socketDir: paths.socketDir,
					pid,
					startTicks: processStartTicks(pid),
				}),
			);
		}
		return paths;
	};

	test("a run over the cap is refused", () => {
		const a = Bun.spawn(["sleep", "30"]);
		const b = Bun.spawn(["sleep", "30"]);
		children.push(a, b);
		fill("a", a.pid);
		fill("b", b.pid);
		expect(() =>
			prepareRunEgress({
				mfwHome,
				runDir: join(root, "runs/c"),
				runId: "c",
				allow: [],
				maxRuns: 2,
			}),
		).toThrow(EgressCapacityError);
		expect(
			existsSync(runEgressPaths(mfwHome, join(root, "runs/c"), "c").indexPath),
		).toBe(false);
	});

	test("a relaunch of a counted run is not a new run", () => {
		const a = Bun.spawn(["sleep", "30"]);
		children.push(a);
		fill("a", a.pid);
		expect(() =>
			prepareRunEgress({
				mfwHome,
				runDir: join(root, "runs/a"),
				runId: "a",
				allow: [],
				maxRuns: 1,
			}),
		).not.toThrow();
	});

	test("what a dead proxy left does not use up the cap", () => {
		const paths = fill("gone");
		writeFileSync(
			paths.indexPath,
			JSON.stringify({
				runId: "gone",
				socketDir: paths.socketDir,
				pid: 999_999_9,
				startTicks: "1",
			}),
		);
		expect(() =>
			prepareRunEgress({
				mfwHome,
				runDir: join(root, "runs/c"),
				runId: "c",
				allow: [],
				maxRuns: 1,
			}),
		).not.toThrow();
	});
});
