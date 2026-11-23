import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	type CompiledSandbox,
	type CompileHost,
	compileBwrap,
} from "../src/containment/compile-bwrap.ts";
import type { Check } from "../src/containment/host-caps.ts";
import {
	type OpenPins,
	openPinnedBinds,
	type PinnedBind,
	PinnedBindError,
} from "../src/containment/pinned-binds.ts";
import { parseSandboxProfile } from "../src/containment/profile.ts";
import { discoverToolchain } from "../src/containment/toolchain.ts";
import {
	assertContained,
	BASE_WRITABLE,
	buildControlScript,
	checkControlReport,
	decodeOptions,
	encodeOptions,
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

const REPO = resolve(import.meta.dir, "../../..");
const FIXTURES = join(REPO, ".live-sandbox");
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
// CI sets this where the live layer must run, so a broken host cannot pass by skipping.
const required = process.env.MFW_REQUIRE_LIVE_SANDBOX === "1";
if (skip && !required) console.log(`[compile-bwrap-live] skipped: ${skip}`);
if (skip && required) {
	test("the live sandbox suite is required here", () => {
		throw new Error(`MFW_REQUIRE_LIVE_SANDBOX is set, but ${skip}`);
	});
}

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
	mkdirSync(FIXTURES, { recursive: true });
	root = realpathSync(mkdtempSync(join(FIXTURES, "run-")));
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
		process?: Record<string, unknown>;
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
		...(extra.process ? { process: extra.process } : {}),
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

/** The inherited descriptors for a sandbox: seccomp on 3, options on 4. */
function sandboxFds(c: CompiledSandbox): unknown[] {
	const bpf = join(root, "deny.bpf");
	writeFileSync(bpf, c.seccomp, { mode: 0o600 });
	const fds: unknown[] = [Bun.file(bpf)];
	const file = join(root, "bwrap.args");
	writeFileSync(file, c.bwrapArgs, { mode: 0o600 });
	fds.push(Bun.file(file));
	return fds;
}

/** The binds a compiled sandbox declares; empty before pinning existed. */
const pinsOf = (c: CompiledSandbox): readonly PinnedBind[] =>
	(c as { pinnedBinds?: readonly PinnedBind[] }).pinnedBinds ?? [];

/**
 * Spawn without any guard. Only for harmless commands and guarded callers.
 * `held` is a set of pins opened earlier, for a swap after the pin.
 */
function spawnSandbox(argv: string[], c: CompiledSandbox, held?: OpenPins) {
	const pins = held ?? openPinnedBinds(pinsOf(c));
	const stdio = ["ignore", "pipe", "pipe", ...sandboxFds(c), ...pins.parentFds];
	// spawnSync closes the numeric entries itself.
	pins.release();
	const child = Bun.spawnSync(argv, {
		stdio: stdio as never,
		timeout: 30_000,
	});
	return {
		code: child.exitCode,
		out: child.stdout.toString(),
		err: child.stderr.toString(),
	};
}

function launch(c: CompiledSandbox, extraWritable: readonly string[] = []) {
	return spawnSandbox(assertContained(c, guardSpec(extraWritable)), c);
}

/**
 * The only way to run a destructive script. The control runs in a sandbox
 * with byte-identical options, and any problem throws before the launch.
 */
function destructive(script: string) {
	const spec = guardSpec();
	const scenario = compile(["sh", "-c", script]);
	const probe = compile(["sh", "-c", buildControlScript(spec)]);
	const scenarioArgv = assertContained(scenario, spec);
	const probeArgv = assertContained(probe, spec);
	if (
		JSON.stringify(scenarioArgv.slice(0, -1)) !==
			JSON.stringify(probeArgv.slice(0, -1)) ||
		!scenario.bwrapArgs.equals(probe.bwrapArgs)
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

/**
 * Run a mis-expansion inside the sandbox and prove it really deleted: a file
 * planted in the synthetic HOME must be gone afterwards (exit 82 if not). The
 * command's own status is ignored, since `rm` reports the read-only mounts.
 */
function misExpansion(command: string) {
	return destructive(`: > "$HOME/planted" || exit 80
[ -e "$HOME/planted" ] || exit 81
${command}
if [ -e "$HOME/planted" ]; then exit 82; fi
exit 0`);
}

function canaryIntact(): void {
	expect(readFileSync(join(home, CANARY), "utf8")).toBe("irreplaceable\n");
	expect(readFileSync(join(home, ".ssh/id_canary"), "utf8")).toBe(
		"not a real key\n",
	);
}

test("fixtures live outside the source tree, in an ignored directory", () => {
	expect(root.startsWith(`${FIXTURES}/`)).toBe(true);
	expect(readFileSync(join(REPO, ".gitignore"), "utf8")).toContain(
		"/.live-sandbox/",
	);
});

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

	test("an env value is in no command line, on the host or inside", async () => {
		const secret = `canary-${randomUUID()}`;
		const script = `
			[ "$OPENAI_API_KEY" != "" ] || exit 71
			printf %s "$OPENAI_API_KEY" > /tmp/needle
			if grep -lFf /tmp/needle /proc/[0-9]*/cmdline 2>/dev/null; then exit 72; fi
			[ ! -e /proc/self/fd/3 ] || exit 73
			[ ! -e /proc/self/fd/4 ] || exit 74
			echo ready
			cat >/dev/null`;
		const c = compile(["sh", "-c", script], "rw", {
			process: { env: { OPENAI_API_KEY: secret } },
		});
		const argv = assertContained(c, guardSpec());
		const pins = openPinnedBinds(pinsOf(c));
		const child = Bun.spawn(argv, {
			stdio: [
				"pipe",
				"pipe",
				"pipe",
				...sandboxFds(c),
				...pins.parentFds,
			] as never,
		});
		pins.close();
		try {
			const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
			const first = await reader.read();
			expect(new TextDecoder().decode(first.value)).toBe("ready\n");
			const leaks: string[] = [];
			for (const pid of readdirSync("/proc")) {
				if (!/^[0-9]+$/.test(pid)) continue;
				try {
					const line = readFileSync(`/proc/${pid}/cmdline`);
					if (line.includes(secret)) leaks.push(pid);
				} catch {
					// the process exited during the scan
				}
			}
			expect(leaks).toEqual([]);
			(child.stdin as unknown as { end(): void }).end();
			expect(await child.exited).toBe(0);
		} finally {
			child.kill();
		}
	}, 15_000);

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

	test("/run is read-only, so the egress path cannot be replaced", () => {
		const run = join(root, "mfw/runs/r1");
		mkdirSync(join(run, "egress"), { recursive: true });
		writeFileSync(join(run, "egress/marker"), "egress\n");
		const script = `
			if touch /run/planted 2>/dev/null; then exit 61; fi
			if mkdir /run/mfw/planted 2>/dev/null; then exit 62; fi
			if (cd /run && exec 2>/dev/null; : > /run/mfw/x); then exit 63; fi
			touch /run/user/ok || exit 64
			cat /run/mfw/egress/marker >/dev/null || exit 65
			exit 0`;
		const r = launch(
			compile(["sh", "-c", script], "rw", {
				network: { mode: "proxy", socketDir: join(run, "egress") },
			}),
		);
		expect(r.err).toBe("");
		expect(r.code).toBe(0);
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
		const options = decodeOptions(probe.bwrapArgs);
		const at = options.indexOf("--remount-ro");
		const smuggled: CompiledSandbox = {
			...probe,
			bwrapArgs: encodeOptions([
				...options.slice(0, at),
				"--bind-try",
				standIn,
				"/stand-in",
				...options.slice(at),
			]),
		};
		expect(() => assertContained(smuggled, spec)).toThrow("refusing to launch");
		// Harmless read-only command: past the guard only to test the control.
		const r = spawnSandbox(
			smuggled.argv.slice(smuggled.argv.indexOf("--") + 1),
			smuggled,
		);
		expect(r.code).toBe(0);
		expect(checkControlReport(r.out, spec).join()).toContain("/stand-in");
	});

	describe("a bind source swapped for a symlink after compile (M1)", () => {
		const WRITE = "echo pwned > /work/pwned";

		/** Compile, prove containment with the control, and return the scenario. */
		function controlled(): { scenario: CompiledSandbox; argv: string[] } {
			const spec = guardSpec();
			const scenario = compile(["sh", "-c", WRITE]);
			const probe = compile(["sh", "-c", buildControlScript(spec)]);
			const argv = assertContained(scenario, spec);
			const control = spawnSandbox(assertContained(probe, spec), probe);
			expect(control.code).toBe(0);
			expect(checkControlReport(control.out, spec)).toEqual([]);
			return { scenario, argv };
		}

		function swapSource(): string {
			const moved = `${work}.pinned`;
			renameSync(work, moved);
			symlinkSync(join(home, ".ssh"), work);
			return moved;
		}

		test("positive control: a path bind follows the swap", () => {
			const { scenario, argv } = controlled();
			swapSource();
			// Harmless write into the fixture's stand-in, through a plain path bind.
			const options = decodeOptions(scenario.bwrapArgs);
			const at = options.findIndex(
				(o, i) =>
					(o === "--bind" || o === "--bind-fd") && options[i + 2] === "/work",
			);
			expect(at).toBeGreaterThan(0);
			const pathBind: CompiledSandbox = {
				...scenario,
				bwrapArgs: encodeOptions([
					...options.slice(0, at),
					"--bind",
					work,
					"/work",
					...options.slice(at + 3),
				]),
				pinnedBinds: [],
			} as CompiledSandbox;
			const r = spawnSandbox(argv, pathBind);
			expect(r.code).toBe(0);
			expect(existsSync(join(home, ".ssh/pwned"))).toBe(true);
		});

		test("a swap before the pin is refused and nothing launches", () => {
			const { scenario } = controlled();
			swapSource();
			expect(() => openPinnedBinds(pinsOf(scenario))).toThrow(PinnedBindError);
			expect(existsSync(join(home, ".ssh/pwned"))).toBe(false);
			canaryIntact();
		});

		test("a swap after the pin writes to the pinned directory only", () => {
			const { scenario, argv } = controlled();
			const pins = openPinnedBinds(pinsOf(scenario));
			const moved = swapSource();
			const r = spawnSandbox(argv, scenario, pins);
			expect(r.err).toBe("");
			expect(r.code).toBe(0);
			expect(existsSync(join(home, ".ssh/pwned"))).toBe(false);
			expect(readFileSync(join(moved, "pwned"), "utf8")).toBe("pwned\n");
			canaryIntact();
		});
	});

	test("a mis-expansion scenario that deletes nothing does not pass", () => {
		expect(misExpansion("true").code).toBe(82);
	});

	// The mis-expansion scenarios the containment suite tracks as fail-until:P1.
	test.each([
		["rm -rf ~", "rm -rf ~"],
		["find $HOME -delete", 'find "$HOME" -delete'],
		// Skips the top-level names starting with n, u or l (/nix, /usr, /lib*):
		// they are read-only binds (checked above) and walking them takes minutes.
		["rm -rf with an unset variable", 'rm -rf "$UNSET/"[!nul]*'],
		[
			"rm -rf of the host path of the canary",
			`rm -rf "$HOME/planted" ${JSON.stringify("__HOME__")}`,
		],
	])(
		"mis-expansion: %s leaves the canary HOME intact",
		(_name, script) => {
			const r = misExpansion(script.replace("__HOME__", home));
			expect(r.code).toBe(0);
			canaryIntact();
		},
		30_000,
	);
});
