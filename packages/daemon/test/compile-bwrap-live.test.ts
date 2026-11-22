import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
	type CompiledSandbox,
	type CompileHost,
	compileBwrap,
} from "../src/containment/compile-bwrap.ts";
import type { Check } from "../src/containment/host-caps.ts";
import { parseSandboxProfile } from "../src/containment/profile.ts";
import { discoverToolchain } from "../src/containment/toolchain.ts";
import {
	assertContained,
	BASE_WRITABLE,
	buildControlScript,
	checkControlReport,
	type GuardSpec,
	hostNamespaces,
	realHomes,
} from "./compile-bwrap-guard.ts";

/**
 * The compiled profile under real bwrap. The scenarios are destructive on
 * purpose, so they can only run through `destructive`:
 *
 * - every fixture, including the canary HOME, lives in a throwaway directory;
 * - `assertContained` allowlists every bwrap option in the argv;
 * - a control command with the identical sandbox options must report the exact
 *   writable mount set, its own namespaces and no real home. Any failure
 *   throws and the scenario is never launched.
 *
 * The `systemd-run` scope is removed before launching, because the limits need
 * a user manager that test environments often lack. Its argv is covered by the
 * unit layer.
 */

const BWRAP = Bun.which("bwrap");
const ENV = Bun.which("env");
const TOOLS = ["sh", "rm", "find", "touch", "cat", "ls", "grep", "readlink"];

function liveSkipReason(): string | null {
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
	return r.exitCode === 0
		? null
		: `bwrap cannot run here: ${r.stderr.toString().trim()}`;
}

const skip = liveSkipReason();
if (skip) console.log(`[compile-bwrap-live] skipped: ${skip}`);

const pass = <T>(value: T): Check<T> => ({
	ok: true,
	severity: "required",
	value,
	detail: "ok",
});

let root: string;
let home: string;
let work: string;

const CANARY = "documents/precious.txt";

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(import.meta.dir, ".live-sandbox-")));
	home = join(root, "fake-home");
	work = join(root, "mfw/runs/r1/work");
	mkdirSync(join(home, dirname(CANARY)), { recursive: true });
	mkdirSync(join(home, ".ssh"), { recursive: true });
	writeFileSync(join(home, CANARY), "irreplaceable\n");
	writeFileSync(join(home, ".ssh/id_canary"), "not a real key\n");
	mkdirSync(work, { recursive: true });
	writeFileSync(join(work, "file.txt"), "work\n");
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function compile(
	command: string[],
	access: "rw" | "ro" = "rw",
	extra: {
		workspace?: Record<string, unknown>;
		filesystem?: Record<string, unknown>;
		network?: Record<string, unknown>;
	} = {},
): CompiledSandbox {
	const plan = discoverToolchain({
		home,
		binaries: TOOLS,
		path: process.env.PATH ?? "",
	});
	const host: CompileHost = {
		caps: {
			userns: pass({ unprivileged: true } as never),
			bwrap: pass({ version: "0.11.0", disableUserns: true }),
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
		toolchain: plan,
		home,
		mfwHome: join(root, "mfw"),
		allowedRoots: [join(root, "mfw/runs/r1")],
		realpath: (p) => {
			try {
				return realpathSync(p);
			} catch {
				return null;
			}
		},
	};
	const profile = parseSandboxProfile({
		version: 1,
		role: "task",
		filesystem: {
			workspace: { source: work, access, ...extra.workspace },
			scratch: "tmpfs",
			toolchain: { binaries: TOOLS },
			...extra.filesystem,
		},
		...(extra.network ? { network: extra.network } : {}),
	});
	const r = compileBwrap(profile, command, host);
	if (!r.ok) throw new Error(`compile refused: ${r.reason}`);
	return r;
}

function guardSpec(extraWritable: readonly string[] = []): GuardSpec {
	return {
		root,
		bwrap: BWRAP as string,
		env: ENV as string,
		homes: realHomes(),
		hidden: [root, home],
		hostNs: hostNamespaces(),
		writable: [...BASE_WRITABLE, "/scratch", "/work", ...extraWritable],
	};
}

/** Spawn without any guard. Only for harmless commands and guarded callers. */
function spawnSandbox(argv: string[], c: CompiledSandbox) {
	const bpf = join(root, "deny.bpf");
	writeFileSync(bpf, c.seccomp, { mode: 0o600 });
	const child = Bun.spawnSync(argv, {
		stdio: ["ignore", "pipe", "pipe", Bun.file(bpf)] as never,
		timeout: 30_000,
	});
	return {
		code: child.exitCode,
		out: child.stdout.toString(),
		err: child.stderr.toString(),
	};
}

function launch(c: CompiledSandbox, extraWritable: readonly string[] = []) {
	return spawnSandbox(assertContained(c.argv, guardSpec(extraWritable)), c);
}

/**
 * The only way to run a destructive script. The control runs in a sandbox
 * with byte-identical options, and any problem throws before the launch.
 */
function destructive(script: string) {
	const spec = guardSpec();
	const scenario = compile(["sh", "-c", script]);
	const probe = compile(["sh", "-c", buildControlScript(spec)]);
	const scenarioArgv = assertContained(scenario.argv, spec);
	const probeArgv = assertContained(probe.argv, spec);
	if (
		JSON.stringify(scenarioArgv.slice(0, -1)) !==
		JSON.stringify(probeArgv.slice(0, -1))
	) {
		throw new Error("refusing to launch: control used a different sandbox");
	}
	const r = spawnSandbox(probeArgv, probe);
	if (r.code !== 0) {
		throw new Error(`containment control failed (${r.code}): ${r.err}`);
	}
	const problems = checkControlReport(r.out, spec);
	if (problems.length > 0) {
		throw new Error(`containment control failed: ${problems.join("; ")}`);
	}
	return spawnSandbox(scenarioArgv, scenario);
}

function canaryIntact(): void {
	expect(readFileSync(join(home, CANARY), "utf8")).toBe("irreplaceable\n");
	expect(readFileSync(join(home, ".ssh/id_canary"), "utf8")).toBe(
		"not a real key\n",
	);
}

describe.skipIf(skip !== null)("compiled profile under bwrap", () => {
	test("isolates the process", () => {
		const r = launch(
			compile([
				"sh",
				"-c",
				`grep -E '^(CapEff|Seccomp):' /proc/self/status; pwd; echo "$HOME"`,
			]),
		);
		expect(r.code).toBe(0);
		expect(r.out).toContain("CapEff:\t0000000000000000");
		expect(r.out).toContain("Seccomp:\t2");
		expect(r.out).toContain("/work");
		expect(r.out).toContain("/sandbox/agent");
	});

	test("the launching environment does not reach the sandbox", () => {
		process.env.MFW_P1_SECRET_CANARY = "leak";
		try {
			const r = launch(compile(["sh", "-c", "cat /proc/self/environ"]));
			expect(r.code).toBe(0);
			expect(r.out).not.toContain("MFW_P1_SECRET_CANARY");
		} finally {
			delete process.env.MFW_P1_SECRET_CANARY;
		}
	});

	test("has no network interface but loopback", () => {
		const r = launch(compile(["cat", "/proc/net/dev"]));
		expect(r.code).toBe(0);
		const interfaces = r.out
			.split("\n")
			.slice(2)
			.filter((line) => line.includes(":"))
			.map((line) => line.split(":")[0]?.trim());
		expect(interfaces).toEqual(["lo"]);
	});

	test("the workspace is writable and the rest is not", () => {
		const r = launch(
			compile([
				"sh",
				"-c",
				`touch /work/new || exit 21
				 touch /scratch/new || exit 22
				 touch /tmp/new || exit 23
				 touch "$HOME/new" || exit 24
				 if touch /etc/new 2>/dev/null; then exit 25; fi
				 if touch /usr/new 2>/dev/null; then exit 26; fi
				 if touch /nix/store/new 2>/dev/null; then exit 27; fi
				 exit 0`,
			]),
		);
		expect(r.code).toBe(0);
		expect(existsSync(join(work, "new"))).toBe(true);
	});

	test("git dir, cache, fleet config and egress dir keep their access", () => {
		const run = join(root, "mfw/runs/r1");
		for (const d of ["git", "cache", "fleet/sessions", "egress"]) {
			mkdirSync(join(run, d), { recursive: true });
		}
		writeFileSync(join(run, "cache/dep"), "cached\n");
		writeFileSync(join(run, "fleet/config.toml"), "original\n");
		writeFileSync(join(run, "egress/marker"), "egress\n");
		const script = `
			touch /git/new || exit 41
			cat /cache/deps/dep >/dev/null || exit 42
			if touch /cache/deps/new 2>/dev/null; then exit 43; fi
			touch /fleet/codex/sessions/new || exit 44
			if touch /fleet/codex/new 2>/dev/null; then exit 45; fi
			if (echo changed > /fleet/codex/config.toml) 2>/dev/null; then exit 46; fi
			cat /run/mfw/egress/marker >/dev/null || exit 47
			if touch /run/mfw/egress/new 2>/dev/null; then exit 48; fi
			[ "$GIT_DIR" = /git ] || exit 49
			[ "$CODEX_HOME" = /fleet/codex ] || exit 50
			[ "$HTTPS_PROXY" = http://127.0.0.1:3128 ] || exit 51
			exit 0`;
		const r = launch(
			compile(["sh", "-c", script], "rw", {
				workspace: { gitDir: join(run, "git") },
				filesystem: {
					caches: [{ name: "deps", source: join(run, "cache"), access: "ro" }],
					fleetConfig: {
						cli: "codex",
						source: join(run, "fleet"),
						writable: ["sessions"],
					},
				},
				network: { mode: "proxy", socketDir: join(run, "egress") },
			}),
			["/git", "/fleet/codex/sessions"],
		);
		expect(r.err).toBe("");
		expect(r.code).toBe(0);
		expect(existsSync(join(run, "git/new"))).toBe(true);
		expect(existsSync(join(run, "fleet/sessions/new"))).toBe(true);
		expect(existsSync(join(run, "fleet/new"))).toBe(false);
		expect(readFileSync(join(run, "fleet/config.toml"), "utf8")).toBe(
			"original\n",
		);
	});

	test("a read-only workspace refuses writes at the mount", () => {
		const r = launch(
			compile(
				[
					"sh",
					"-c",
					"if touch /work/new 2>/dev/null; then exit 31; fi; cat /work/file.txt",
				],
				"ro",
			),
		);
		expect(r.code).toBe(0);
		expect(r.out).toBe("work\n");
		expect(existsSync(join(work, "new"))).toBe(false);
	});

	test("the control passes on the real compiled sandbox", () => {
		const spec = guardSpec();
		const probe = compile(["sh", "-c", buildControlScript(spec)]);
		const r = launch(probe);
		expect(r.code).toBe(0);
		expect(checkControlReport(r.out, spec)).toEqual([]);
	});

	test("a smuggled writable bind is caught by the guard and the control", () => {
		const standIn = join(root, "stand-in-home");
		mkdirSync(standIn);
		const spec = guardSpec();
		const probe = compile(["sh", "-c", buildControlScript(spec)]);
		const at = probe.argv.indexOf("--remount-ro");
		const smuggled = [
			...probe.argv.slice(0, at),
			"--bind-try",
			standIn,
			"/stand-in",
			...probe.argv.slice(at),
		];
		expect(() => assertContained(smuggled, spec)).toThrow("refusing to launch");
		// Harmless read-only command: past the guard only to test the control.
		const r = spawnSandbox(smuggled.slice(smuggled.indexOf("--") + 1), probe);
		expect(r.code).toBe(0);
		expect(checkControlReport(r.out, spec).join()).toContain("/stand-in");
	});

	// The mis-expansion scenarios the containment suite tracks as fail-until:P1.
	test.each([
		["rm -rf ~", "rm -rf ~; true"],
		["find $HOME -delete", 'find "$HOME" -delete; true'],
		// Skips the top-level names starting with n, u or l (/nix, /usr, /lib*):
		// they are read-only binds (checked above) and walking them takes minutes.
		["rm -rf with an unset variable", 'rm -rf "$UNSET/"[!nul]*; true'],
		[
			"rm -rf of the host path of the canary",
			`rm -rf ${JSON.stringify("__HOME__")}; true`,
		],
	])(
		"mis-expansion: %s leaves the canary HOME intact",
		(_name, script) => {
			const r = destructive(script.replace("__HOME__", home));
			expect(r.code).toBe(0);
			canaryIntact();
		},
		30_000,
	);
});
