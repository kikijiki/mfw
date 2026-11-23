import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	closeSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
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
 * The launcher under real bwrap. Every fixture is throwaway, and each launch
 * first passes `assertContained` and a control in an identical sandbox.
 */

const REPO = resolve(import.meta.dir, "../../..");
const FIXTURES = join(REPO, ".live-sandbox");
const CHILD = join(import.meta.dir, "launch-sandbox-tty-child.ts");
const BWRAP = Bun.which("bwrap");
const ENV = Bun.which("env");
const SCRIPT = Bun.which("script");
const TOOLS = ["sh", "ls", "cat"];

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
if (skip) console.log(`[launch-sandbox-live] skipped: ${skip}`);
if (!SCRIPT) console.log("[launch-sandbox-live] tty tests skipped: no script");

const pass = <T>(value: T): Check<T> => ({
	ok: true,
	severity: "required",
	value,
	detail: "ok",
});

let root: string;
let home: string;
let work: string;

beforeEach(() => {
	mkdirSync(FIXTURES, { recursive: true });
	root = realpathSync(mkdtempSync(join(FIXTURES, "launch-")));
	home = join(root, "fake-home");
	work = join(root, "mfw/runs/r1/work");
	mkdirSync(join(home, ".ssh"), { recursive: true });
	writeFileSync(join(home, ".ssh/id_canary"), "not a real key\n");
	mkdirSync(work, { recursive: true });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function compile(script: string): CompiledSandbox {
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
		toolchain: discoverToolchain({
			home,
			binaries: TOOLS,
			path: process.env.PATH ?? "",
		}),
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
	const r = compileBwrap(
		parseSandboxProfile({
			version: 1,
			role: "task",
			filesystem: {
				workspace: { source: work, access: "rw" },
				toolchain: { binaries: TOOLS },
			},
		}),
		["sh", "-c", script],
		host,
	);
	if (!r.ok) throw new Error(`compile refused: ${r.reason}`);
	return r;
}

const guardSpec = (): GuardSpec => ({
	root,
	bwrap: BWRAP as string,
	env: ENV as string,
	homes: realHomes(),
	hidden: [root, home],
	hostNs: hostNamespaces(),
	writable: [...BASE_WRITABLE, "/work"],
});

/** Compile a scenario, and refuse to return it unless the control passes. */
async function guarded(script: string): Promise<CompiledSandbox> {
	const spec = guardSpec();
	const scenario = compile(script);
	assertContained(scenario, spec);
	const probe = compile(buildControlScript(spec));
	assertContained(probe, spec);
	if (!scenario.bwrapArgs.equals(probe.bwrapArgs)) {
		throw new Error("refusing to launch: control used a different sandbox");
	}
	const child = launchSandbox(probe, {
		approvalMode: "interactive",
		scope: "none",
	});
	(child.stdin as unknown as { end(): void }).end();
	const [out, code] = await Promise.all([
		new Response(child.stdout as unknown as ReadableStream).text(),
		child.exited,
	]);
	if (code !== 0) throw new Error(`containment control failed (${code})`);
	const problems = checkControlReport(out, spec);
	if (problems.length > 0) {
		throw new Error(`containment control failed: ${problems.join("; ")}`);
	}
	return scenario;
}

async function run(c: CompiledSandbox) {
	const child = launchSandbox(c, {
		approvalMode: "interactive",
		scope: "none",
	});
	(child.stdin as unknown as { end(): void }).end();
	const [out, err, code] = await Promise.all([
		new Response(child.stdout as unknown as ReadableStream).text(),
		new Response(child.stderr as unknown as ReadableStream).text(),
		child.exited,
	]);
	return { out, err, code };
}

const REPORT = `{
	if [ -e /dev/console ] || [ -L /dev/console ]; then echo console=present; else echo console=absent; fi
	ls /proc/self/fd
} > /work/report`;

/** Run the child under a real terminal and return what it recorded. */
function underTty(c: CompiledSandbox, mode: string) {
	const compiledPath = join(root, "compiled.json");
	const resultPath = join(root, "result.json");
	writeFileSync(
		compiledPath,
		JSON.stringify({
			...c,
			seccomp: c.seccomp.toString("base64"),
			bwrapArgs: c.bwrapArgs.toString("base64"),
		}),
		{ mode: 0o600 },
	);
	const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
	const command = [
		process.execPath,
		CHILD,
		compiledPath,
		resultPath,
		mode,
		join(home, ".ssh/id_canary"),
	]
		.map(quote)
		.join(" ");
	const r = Bun.spawnSync([SCRIPT as string, "-qefc", command, "/dev/null"], {
		stdio: ["pipe", "pipe", "pipe"],
		timeout: 20_000,
	});
	if (!existsSync(resultPath)) {
		throw new Error(`tty child failed: ${r.stdout}${r.stderr}`);
	}
	return JSON.parse(readFileSync(resultPath, "utf8")) as {
		parentTty: boolean;
		code?: number;
		refused?: string | null;
	};
}

describe.skipIf(skip !== null)("launchSandbox under bwrap", () => {
	test("runs the command with its stdio on pipes", async () => {
		const r = await run(await guarded("echo out; echo err >&2"));
		expect(r).toEqual({ out: "out\n", err: "err\n", code: 0 });
	});

	test("an inherited extra descriptor does not reach the sandbox", async () => {
		const key = join(home, ".ssh/id_canary");
		const c = await guarded("ls /proc/self/fd");
		// Not close-on-exec, like the descriptor the review carried across.
		const extra = openSync(key, "r+");
		try {
			const r = await run(c);
			expect(r.code).toBe(0);
			// 3 is the descriptor `ls` itself opens on the directory.
			expect(r.out.trim().split("\n")).toEqual(["0", "1", "2", "3"]);
		} finally {
			closeSync(extra);
		}
		expect(readFileSync(key, "utf8")).toBe("not a real key\n");
	});

	test("a launch never closes a descriptor it does not own", async () => {
		const c = await guarded("true");
		// Repeated, because the stale close lands at exit or at finalization.
		for (let round = 0; round < 12; round++) {
			let child: ReturnType<typeof launchSandbox> | null = launchSandbox(c, {
				approvalMode: "interactive",
				scope: "none",
			});
			// These take any number the launch wrongly gave back.
			const victims = Array.from({ length: 6 }, () =>
				openSync(join(root, "victim"), "a"),
			);
			(child.stdin as unknown as { end(): void }).end();
			expect(await child.exited).toBe(0);
			child = null;
			Bun.gc(true);
			await Bun.sleep(10);
			Bun.gc(true);
			for (const fd of victims) {
				expect(existsSync(`/proc/self/fd/${fd}`)).toBe(true);
				closeSync(fd);
			}
		}
	}, 30_000);

	test("no pinned bind descriptor reaches the command", async () => {
		const r = await run(await guarded("ls /proc/self/fd; touch /work/ok"));
		expect(r.out.trim().split("\n")).toEqual(["0", "1", "2", "3"]);
	});

	test("the options never get a name on disk", async () => {
		const tmp = join(root, "tmp");
		mkdirSync(tmp);
		const c = await guarded("true");
		const child = launchSandbox(c, {
			approvalMode: "interactive",
			scope: "none",
			tmpDir: tmp,
		});
		(child.stdin as unknown as { end(): void }).end();
		expect(Array.from(new Bun.Glob("*").scanSync(tmp))).toEqual([]);
		expect(await child.exited).toBe(0);
	});

	test.skipIf(!SCRIPT)(
		"positive control: a terminal on stdio appears as /dev/console",
		async () => {
			const result = underTty(await guarded(REPORT), "control");
			expect(result.parentTty).toBe(true);
			expect(result.code).toBe(0);
			expect(readFileSync(join(work, "report"), "utf8")).toContain(
				"console=present",
			);
		},
		30_000,
	);

	test.skipIf(!SCRIPT)(
		"a launcher under a terminal gives the sandbox no console and no extra fd",
		async () => {
			const result = underTty(await guarded(REPORT), "pipes");
			expect(result.parentTty).toBe(true);
			expect(result.code).toBe(0);
			const lines = readFileSync(join(work, "report"), "utf8")
				.trim()
				.split("\n");
			expect(lines).toEqual(["console=absent", "0", "1", "2", "3"]);
		},
		30_000,
	);

	test.skipIf(!SCRIPT)(
		"a terminal passed as stdio is refused before anything launches",
		async () => {
			const result = underTty(await guarded(REPORT), "refuse");
			expect(result.parentTty).toBe(true);
			expect(result.refused).toBe("stdio_tty");
			expect(existsSync(join(work, "report"))).toBe(false);
		},
		30_000,
	);

	test("a stdio descriptor that is not a pipe is refused", async () => {
		const c = await guarded("true");
		const file = openSync(join(root, "log"), "w");
		try {
			expect(() =>
				launchSandbox(c, {
					approvalMode: "interactive",
					scope: "none",
					stdout: file,
				}),
			).toThrow(SandboxLaunchError);
		} finally {
			closeSync(file);
		}
	});

	test("a pin that no longer verifies stops the launch", async () => {
		const c = await guarded("touch /work/launched");
		rmSync(work, { recursive: true });
		expect(() =>
			launchSandbox(c, { approvalMode: "interactive", scope: "none" }),
		).toThrow(SandboxLaunchError);
	});

	test("a compiled result with a misnumbered pin is refused", async () => {
		const c = await guarded("true");
		const bad = {
			...c,
			pinnedBinds: c.pinnedBinds.map((p) => ({ ...p, fd: p.fd + 1 })),
		};
		expect(() =>
			launchSandbox(bad, { approvalMode: "interactive", scope: "none" }),
		).toThrow(SandboxLaunchError);
	});
});

/**
 * The real scope needs a user manager. This uses the inherited environment
 * only and never points at a bus by path, so a cage that hides the session
 * cannot be escaped by this test.
 */
function scopeSkipReason(): string | null {
	if (skip) return skip;
	if (!Bun.which("systemd-run")) return "no systemd-run";
	if (!process.env.XDG_RUNTIME_DIR && !process.env.DBUS_SESSION_BUS_ADDRESS) {
		return "no user manager in this environment (XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS are unset)";
	}
	const state = Bun.spawnSync(["systemctl", "--user", "is-system-running"]);
	const s = state.stdout.toString().trim();
	return s === "running" || s === "degraded"
		? null
		: `no usable user manager (state: ${s || "unreachable"})`;
}

const scopeSkip = scopeSkipReason();
if (scopeSkip) {
	console.log(`[launch-sandbox-live] systemd-run chain skipped: ${scopeSkip}`);
}

describe.skipIf(scopeSkip !== null)("launchSandbox through systemd-run", () => {
	test("fd 3, fd 4 and the pins survive the real scope", async () => {
		const c = await guarded("touch /work/through-scope; ls /proc/self/fd");
		const withScope: CompiledSandbox = {
			...c,
			argv: [Bun.which("systemd-run") as string, ...c.argv.slice(1)],
		};
		const child = launchSandbox(withScope, {
			approvalMode: "interactive",
			scope: "systemd",
		});
		(child.stdin as unknown as { end(): void }).end();
		expect(await child.exited).toBe(0);
		expect(existsSync(join(work, "through-scope"))).toBe(true);
	}, 30_000);
});
