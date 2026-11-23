import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	closeSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readlinkSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import type { CompileHost } from "../src/containment/compile-bwrap.ts";
import type { Check } from "../src/containment/host-caps.ts";
import { collectProbe } from "../src/containment/probe-collect.ts";
import {
	attestSandbox,
	buildProbePlan,
	compileSealedProbe,
	probeToolchainTargets,
} from "../src/containment/probe-run.ts";
import {
	type SealedProbeRuntime,
	sealProbeRuntime,
} from "../src/containment/probe-runtime.ts";
import { parseSandboxProfile } from "../src/containment/profile.ts";
import { discoverToolchain } from "../src/containment/toolchain.ts";
import { liveGate } from "./support/live-gate.ts";

/** Security review P7, m6: 101 MB stayed open in the daemon until a later GC.
 * Every path out of a probe must release the descriptors by itself: no gc call,
 * no waiting, and nothing that depends on a finalizer. */

const BWRAP = Bun.which("bwrap");
const ENV = Bun.which("env");
const capable =
	process.arch === "x64" &&
	!!BWRAP &&
	Bun.spawnSync([
		BWRAP,
		"--unshare-all",
		"--ro-bind",
		"/",
		"/",
		"--proc",
		"/proc",
		"--dev",
		"/dev",
		"--",
		"true",
	]).exitCode === 0;
const usable =
	liveGate(
		"probe-sealed-fds-live",
		capable ? null : "no working bwrap on x86_64",
	) === null;

const pass = <T>(value: T): Check<T> => ({
	ok: true,
	severity: "required",
	value,
	detail: "ok",
});

const sealedOpen = () =>
	readdirSync("/proc/self/fd").filter((n) => {
		try {
			return readlinkSync(`/proc/self/fd/${n}`).startsWith("/memfd:mfw-probe-");
		} catch {
			return false;
		}
	}).length;

describe.skipIf(!usable)("the probe's sealed runtime", () => {
	let root: string;
	let handle: ProjectDbHandle;

	beforeEach(async () => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "mfw-sealed-fds-")));
		mkdirSync(join(root, "home"));
		mkdirSync(join(root, "mfw"));
		handle = await openProjectDb(join(root, "db"));
	});
	afterEach(() => {
		handle.close();
		rmSync(root, { recursive: true, force: true });
	});

	const host = (): CompileHost => ({
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
		bwrapPath: BWRAP as string,
		envPath: ENV as string,
		systemdRunPath: "/unused/systemd-run",
		toolchain: discoverToolchain({
			home: join(root, "home"),
			binaries: [],
			path: "",
		}),
		home: join(root, "home"),
		mfwHome: join(root, "mfw"),
		allowedRoots: [],
		realpath: (p) => {
			try {
				return realpathSync(p);
			} catch {
				return null;
			}
		},
	});

	const targets = () => ({
		home: join(root, "home"),
		mfwHome: join(root, "mfw"),
		protectedPaths: [],
		fleetExecBaseline: [],
	});
	const profile = () => parseSandboxProfile({ version: 1, role: "trigger" });

	/** Seal, compile and collect the way attestSandbox does, with hooks. */
	async function collect(
		h: CompileHost,
		opts: {
			timeoutMs: number;
			readCgroup?: (pid: number) => null;
			sealed?: SealedProbeRuntime;
		},
	) {
		const runtime = opts.sealed ?? sealProbeRuntime();
		try {
			const sealed = compileSealedProbe(profile(), h, runtime);
			if ("ok" in sealed) throw new Error(sealed.reason);
			const plan = buildProbePlan(
				profile(),
				sealed.compiled,
				{
					...targets(),
					...probeToolchainTargets(h.toolchain),
					realpath: h.realpath,
				},
				{
					nonce: "n",
					loopbackPort: 1,
					scope: "none",
					sealedFds: sealed.sealedFds,
				},
			);
			const items = await collectProbe(sealed.compiled, plan, {
				scope: "none",
				timeoutMs: opts.timeoutMs,
				readCgroup: opts.readCgroup,
				sealed: runtime,
			});
			// What a leak would look like, before the caller's own close().
			return { items, openBeforeClose: sealedOpen() };
		} finally {
			runtime.close();
		}
	}

	test("is closed when the probe returns", async () => {
		const r = await attestSandbox({
			db: handle.db,
			runId: "sealed-fds",
			profile: profile(),
			host: host(),
			targets: targets(),
			scope: "none",
			timeoutMs: 40_000,
		});
		expect(r.ok).toBe(true);
		expect(sealedOpen()).toBe(0);
	}, 45_000);

	test("is closed when the probe times out", async () => {
		const r = await collect(host(), { timeoutMs: 1 });
		expect(r.items[0]?.detail).toContain("timed out");
		expect(r.openBeforeClose).toBe(0);
		expect(sealedOpen()).toBe(0);
	}, 45_000);

	test("is closed when the probe is killed", async () => {
		const r = await collect(host(), {
			timeoutMs: 40_000,
			readCgroup: (pid) => {
				process.kill(pid, "SIGKILL");
				return null;
			},
		});
		expect(r.items.every((i) => i.status === "fail")).toBe(true);
		expect(r.openBeforeClose).toBe(0);
		expect(sealedOpen()).toBe(0);
	}, 45_000);

	test("is closed when the sandbox cannot start", async () => {
		const h = { ...host(), bwrapPath: join(root, "no-such-bwrap") };
		const r = await collect(h, { timeoutMs: 5_000 });
		expect(r.items.every((i) => i.status === "fail")).toBe(true);
		expect(r.openBeforeClose).toBe(0);
		expect(sealedOpen()).toBe(0);
	}, 45_000);

	test("is closed when the launch is refused before any spawn", async () => {
		const runtime = sealProbeRuntime();
		const held = runtime.fds.length;
		expect(sealedOpen()).toBe(held);
		const sealed = compileSealedProbe(profile(), host(), runtime);
		if ("ok" in sealed) throw new Error(sealed.reason);
		const plan = buildProbePlan(
			profile(),
			sealed.compiled,
			{
				...targets(),
				...probeToolchainTargets(host().toolchain),
				realpath: host().realpath,
			},
			{ nonce: "n", loopbackPort: 1, scope: "none" },
		);
		// Descriptor 2 is not a sealed runtime, so the launch is refused.
		const items = await collectProbe(sealed.compiled, plan, {
			scope: "none",
			sealed: { fds: [...runtime.fds, 2], release: () => runtime.release() },
		});
		expect(items[0]?.detail).toContain("did not launch");
		// Still ours: nothing took them, so the owner closes them, once or twice.
		expect(sealedOpen()).toBe(held);
		runtime.close();
		expect(sealedOpen()).toBe(0);
		expect(() => runtime.close()).not.toThrow();
		expect(() => runtime.release()).not.toThrow();
	}, 45_000);

	test("a release frees the memory at once and never frees a reused number", async () => {
		const runtime = sealProbeRuntime();
		const numbers = [...runtime.fds];
		runtime.release();
		expect(sealedOpen()).toBe(0);
		// The numbers stay taken until their owner closes them, so a new
		// descriptor cannot land on one and be closed by that late close.
		const other = openSync(join(root, "mfw", "other"), "w");
		expect(numbers).not.toContain(other);
		runtime.release();
		expect(() => runtime.close()).not.toThrow();
		expect(existsSync(`/proc/self/fd/${other}`)).toBe(true);
		closeSync(other);
		for (const n of numbers) closeSync(n);
	});

	test("concurrent probes keep their own descriptors", async () => {
		const results = await Promise.all(
			[1, 2, 3].map((i) =>
				attestSandbox({
					db: handle.db,
					runId: `sealed-fds-concurrent-${i}`,
					profile: profile(),
					host: host(),
					targets: targets(),
					scope: "none",
					timeoutMs: 40_000,
				}),
			),
		);
		for (const r of results) {
			if (!r.ok) throw new Error(r.reason);
			expect(
				r.items.filter((x) => x.status === "fail").map((x) => x.id),
			).toEqual(["cgroup_limits"]);
		}
		expect(sealedOpen()).toBe(0);
	}, 90_000);
});
