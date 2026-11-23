import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import {
	type CompiledSandbox,
	type CompileHost,
	compileBwrap,
} from "../src/containment/compile-bwrap.ts";
import type { Check } from "../src/containment/host-caps.ts";
import {
	launchSandbox,
	SandboxLaunchError,
} from "../src/containment/launch-sandbox.ts";
import { probeChildSource } from "../src/containment/probe-child.ts";
import { checkFds } from "../src/containment/probe-evaluate.ts";
import { attestSandbox } from "../src/containment/probe-run.ts";
import {
	elfInterpreter,
	ProbeRuntimeError,
	parseLoaderList,
	sealProbeRuntime,
} from "../src/containment/probe-runtime.ts";
import { parseSandboxProfile } from "../src/containment/profile.ts";
import { discoverToolchain } from "../src/containment/toolchain.ts";

/**
 * The probe's runtime arrives as sealed descriptors, so a role with no runtime
 * of its own is still measured, and its sandbox holds no bun, node or libc.
 */

const BWRAP = Bun.which("bwrap");
const ENV = Bun.which("env");

function skipReason(): string | null {
	if (process.arch !== "x64") return "seccomp is x86_64 only";
	if (!BWRAP || !ENV) return "no bwrap";
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
if (skip) console.log(`[probe-sealed-live] skipped: ${skip}`);

const pass = <T>(value: T): Check<T> => ({
	ok: true,
	severity: "required",
	value,
	detail: "ok",
});

let root: string;
let handle: ProjectDbHandle;

beforeEach(async () => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "mfw-sealed-")));
	mkdirSync(join(root, "home/.ssh"), { recursive: true });
	writeFileSync(join(root, "home/.ssh/id_canary"), "canary\n");
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
	systemdRunPath: Bun.which("systemd-run") ?? "/unused/systemd-run",
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

describe("the ELF and loader parsing", () => {
	test("a non-ELF runtime is refused", () => {
		expect(() => elfInterpreter(Buffer.alloc(128))).toThrow(ProbeRuntimeError);
	});

	test("an unresolved library is refused", () => {
		const loader = realpathSync(process.execPath);
		expect(() =>
			parseLoaderList("\tlibmissing.so => not found\n", loader),
		).toThrow(ProbeRuntimeError);
	});
});

describe.skipIf(skip !== null)("the sealed runtime", () => {
	test("a profile with no toolchain passes every item but the scope", async () => {
		const r = await attestSandbox({
			db: handle.db,
			runId: "sealed",
			profile: parseSandboxProfile({ version: 1, role: "trigger" }),
			host: host(),
			targets: {
				home: join(root, "home"),
				mfwHome: join(root, "mfw"),
				protectedPaths: [join(root, "home/.ssh")],
				fleetExecBaseline: [],
			},
			scope: "none",
			timeoutMs: 40_000,
		});
		if (!r.ok) throw new Error(r.reason);
		expect(r.items.filter((i) => i.status === "fail").map((i) => i.id)).toEqual(
			["cgroup_limits"],
		);
	}, 45_000);

	test("an autonomous launch cannot inherit the runtime", () => {
		const compiled = compileBwrap(
			parseSandboxProfile({ version: 1, role: "trigger" }),
			["/agent"],
			host(),
		) as CompiledSandbox;
		const runtime = sealProbeRuntime();
		try {
			expect(() =>
				launchSandbox(compiled, {
					approvalMode: "autonomous",
					authorization: {} as never,
					sealedProbeFds: runtime.fds,
				}),
			).toThrow(SandboxLaunchError);
		} finally {
			runtime.close();
		}
	});

	test("a descriptor that is not the runtime is refused", () => {
		const compiled = compileBwrap(
			parseSandboxProfile({ version: 1, role: "trigger" }),
			["/agent"],
			host(),
		) as CompiledSandbox;
		expect(() =>
			launchSandbox(compiled, {
				approvalMode: "interactive",
				scope: "none",
				sealedProbeFds: [2],
			}),
		).toThrow(SandboxLaunchError);
	});
});

// Review P7, m4: errno was read in a second FFI call, which the runtime could
// overwrite first, so a correct filter sometimes failed the probe.
describe("how the probe reads a syscall's result", () => {
	test("from the return value, never from libc's errno", () => {
		const source = probeChildSource();
		expect(source).not.toContain("__errno_location");
		expect(source).not.toContain("symbols.syscall");
	});
});

describe.skipIf(skip !== null)("the probe's descriptors", () => {
	test("repeated probes all measure their syscalls", async () => {
		for (let i = 0; i < 8; i++) {
			const r = await attestSandbox({
				db: handle.db,
				runId: `sealed-repeat-${i}`,
				profile: parseSandboxProfile({ version: 1, role: "trigger" }),
				host: host(),
				targets: {
					home: join(root, "home"),
					mfwHome: join(root, "mfw"),
					protectedPaths: [join(root, "home/.ssh")],
					fleetExecBaseline: [],
				},
				scope: "none",
				timeoutMs: 40_000,
			});
			if (!r.ok) throw new Error(r.reason);
			expect(
				r.items.filter((x) => x.status === "fail").map((x) => x.id),
			).toEqual(["cgroup_limits"]);
		}
	}, 120_000);
});

describe("the descriptor check", () => {
	const observed = (fd: number, target: string) =>
		({
			fds: [
				{ fd: 0, target: "pipe:[1]" },
				{ fd: 1, target: "pipe:[2]" },
				{ fd: 2, target: "pipe:[3]" },
				{ fd, target },
			],
			pid1: { cmdline: null, environ: null, fds: [] },
		}) as never;
	const expected = { sealedFds: [5] } as never;
	const memfd = "/memfd:mfw-probe-bun (deleted)";

	test("the runtime at its own number passes", () => {
		expect(checkFds(observed(5, memfd), expected)).toBeNull();
	});

	test("a memfd at another number fails", () => {
		expect(checkFds(observed(9, memfd), expected)).toContain("unexpected");
	});

	test("another memfd at the runtime's number fails", () => {
		expect(
			checkFds(observed(5, "/memfd:planted (deleted)"), expected),
		).toContain("unexpected");
	});

	test("a launch that expects no runtime tolerates none", () => {
		expect(checkFds(observed(5, memfd), {} as never)).toContain("unexpected");
	});
});

describe.skipIf(skip !== null)("the seal", () => {
	test("a sealed descriptor refuses a write", () => {
		const runtime = sealProbeRuntime();
		try {
			const fd = runtime.fds[0] as number;
			const r = Bun.spawnSync(["sh", "-c", `printf x >> /proc/self/fd/${fd}`], {
				stdio: ["ignore", "ignore", "pipe"],
			});
			expect(r.exitCode).not.toBe(0);
		} finally {
			runtime.close();
		}
	});
});
