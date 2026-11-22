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

/**
 * The compiled profile under real bwrap. The scenarios are destructive on
 * purpose, so three guards stand before each one:
 *
 * - every fixture, including the canary HOME, lives in a throwaway directory
 *   inside this package, and no real home is ever named;
 * - `assertContained` refuses an argv without the hardening flags or with a
 *   writable bind outside the fixture;
 * - a harmless control command must first prove that the canary is invisible
 *   and `/` is read-only. Any failure throws and the scenario never runs.
 *
 * The `systemd-run` scope is removed before launching, because the limits need
 * a user manager that test environments often lack. Its argv is covered by the
 * unit layer.
 */

const BWRAP = Bun.which("bwrap");
const ENV = Bun.which("env");
const TOOLS = ["sh", "rm", "find", "touch", "cat", "ls", "grep"];

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

function assertContained(c: CompiledSandbox): string[] {
	const argv = c.argv.slice(c.argv.indexOf("--") + 1);
	if (argv[0] !== ENV || argv[1] !== "-i" || argv[2] !== BWRAP) {
		throw new Error("refusing to launch: not an env -i bwrap command");
	}
	const end = argv.lastIndexOf("--");
	const flags = argv.slice(0, end);
	for (const f of [
		"--unshare-all",
		"--unshare-user",
		"--disable-userns",
		"--remount-ro",
		"--seccomp",
	]) {
		if (!flags.includes(f)) throw new Error(`refusing to launch: no ${f}`);
	}
	flags.forEach((f, i) => {
		if (f === "--bind" && !flags[i + 1]?.startsWith(`${root}/`)) {
			throw new Error(`refusing to launch: writable bind ${flags[i + 1]}`);
		}
	});
	return argv;
}

function launch(c: CompiledSandbox) {
	const argv = assertContained(c);
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

/** Throws unless the sandbox hides the canary HOME and has a read-only root. */
function control(): void {
	const script = `
		[ ! -e ${JSON.stringify(home)} ] || exit 11
		[ "$HOME" = /sandbox/agent ] || exit 12
		if touch /mfw-root-write 2>/dev/null; then exit 13; fi
		exit 0`;
	const r = launch(compile(["sh", "-c", script]));
	if (r.code !== 0) {
		throw new Error(`containment control failed (${r.code}): ${r.err}`);
	}
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
			control();
			const r = launch(compile(["sh", "-c", script.replace("__HOME__", home)]));
			expect(r.code).toBe(0);
			canaryIntact();
		},
		30_000,
	);
});
