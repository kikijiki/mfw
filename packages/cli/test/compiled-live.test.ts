import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
	hostTarget,
	LIBSQL_ADDONS,
	libsqlAddonPath,
} from "../../../tools/compile.ts";
import {
	type CompileHost,
	compileBwrap,
	SANDBOX_PATHS,
} from "../../daemon/src/containment/compile-bwrap.ts";
import { HOST_CONTENT_IDS } from "../../daemon/src/containment/host-script.ts";
import {
	hostSpawnEnv,
	hostSpawnEnvShell,
} from "../../daemon/src/containment/host-spawn-env.ts";
import { openPinnedBinds } from "../../daemon/src/containment/pinned-binds.ts";
import { parseSandboxProfile } from "../../daemon/src/containment/profile.ts";
import { discoverToolchain } from "../../daemon/src/containment/toolchain.ts";
import {
	assertContained,
	BASE_WRITABLE,
	hostNamespaces,
	realHomes,
} from "../../daemon/test/compile-bwrap-guard.ts";
import { liveGate } from "../../daemon/test/support/live-gate.ts";

/**
 * The compiled `mfw` and `mfw-board`, built from this checkout and run as
 * processes. Skips with the reason when this bun cannot compile them here;
 * `MFW_REQUIRE_COMPILED=1` turns that into a failure. The server, the auth
 * smoke and a caged agent launch through a compiled install are
 * `bun run smoke:compiled` (they need the production build).
 */

const ROOT = resolve(import.meta.dir, "../../..");
const TIMEOUT = 120_000;

function compileUnavailable(): string | null {
	if (typeof Bun.build !== "function") return "this bun has no Bun.build";
	// A test of this gate makes the target unknown, to see the suite fail.
	const target = process.env.MFW_TEST_COMPILE_TARGET ?? hostTarget();
	if (!LIBSQL_ADDONS[target]) return `no libsql addon is known for ${target}`;
	try {
		libsqlAddonPath(ROOT, target);
	} catch (e) {
		return (e as Error).message;
	}
	return null;
}

function bwrapUnavailable(): string | null {
	const bwrap = Bun.which("bwrap");
	if (!bwrap) return "no bwrap on PATH";
	const r = Bun.spawnSync(
		[bwrap, "--unshare-all", "--ro-bind", "/", "/", "--", "true"],
		{ stdout: "ignore", stderr: "ignore" },
	);
	return r.exitCode === 0 ? null : "bwrap cannot run here";
}

const skip = liveGate("compiled-live", compileUnavailable(), "compiled");

let base: string;
let bin: string;
let mfw: string;
let board: string;
const report: string[] = [];

function run(
	argv: string[],
	opts: { env?: Record<string, string>; cwd?: string } = {},
) {
	const started = performance.now();
	const r = Bun.spawnSync(argv, {
		cwd: opts.cwd ?? base,
		env: {
			PATH: dirname(process.execPath),
			HOME: join(base, "home"),
			MFW_HOME: join(base, "mfw-home"),
			TMPDIR: join(base, "tmp"),
			...opts.env,
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: r.exitCode,
		out: r.stdout.toString(),
		err: r.stderr.toString(),
		ms: performance.now() - started,
	};
}

describe.skipIf(skip !== null)("the compiled executables", () => {
	beforeAll(() => {
		base = realpathSync(mkdtempSync(join(tmpdir(), "mfw-compiled-")));
		for (const d of ["home", "mfw-home", "tmp", "bin"])
			mkdirSync(join(base, d));
		bin = join(base, "bin");
		// In its own process: Bun.build is unreliable inside the test runner.
		const started = performance.now();
		const built = Bun.spawnSync(
			[process.execPath, join(ROOT, "tools/compile.ts"), "--out", bin],
			{ cwd: ROOT, stdout: "pipe", stderr: "pipe" },
		);
		if (built.exitCode !== 0) {
			throw new Error(`compile failed: ${built.stderr.toString()}`);
		}
		report.push(
			`compile: ${((performance.now() - started) / 1000).toFixed(1)} s`,
		);
		mfw = join(bin, "mfw");
		board = join(bin, "mfw-board");
	}, TIMEOUT);
	afterAll(() => {
		console.log(`[compiled-live] ${report.join("; ")}`);
		if (base) rmSync(base, { recursive: true, force: true });
	});

	test("each is one self-contained file with no builder path inside", () => {
		for (const exe of [mfw, board]) {
			const bytes = readFileSync(exe);
			expect(bytes.includes(Buffer.from(ROOT))).toBe(false);
			expect(statSync(exe).mode & 0o111).not.toBe(0);
			report.push(
				`${exe.slice(bin.length + 1)}: ${(bytes.length / 1e6).toFixed(1)} MB`,
			);
		}
	});

	test("mfw version reports the build, mfw-board and the integrity hashes", () => {
		const r = run([mfw, "version"]);
		expect(r.code).toBe(0);
		expect(r.out).toMatch(
			/^mfw \d+\.\d+\.\d+ \(compiled, bun-[a-z]+-[a-z0-9]+\)\n/,
		);
		expect(r.out).toContain(`mfw-board `);
		expect(r.out).toContain(`(${board})`);
		expect(r.out).toMatch(/\ngit [0-9a-f]{40}\n/);
		expect(r.out).toMatch(/\nbuilt \d{4}-\d\d-\d\dT/);
		expect(r.out).toMatch(
			/migrations manifest [0-9a-f]{64} \(\d+ migrations, verified\)/,
		);
		expect(r.out).toMatch(/libsql addon [0-9a-f]{64}/);
		expect(r.out).toContain("install: none");
		report.push(`mfw version: ${r.ms.toFixed(0)} ms`);
	});

	test("mfw-board answers --version and board commands without a server", () => {
		const v = run([board, "--version"]);
		expect(v.code).toBe(0);
		expect(v.out).toMatch(/^mfw-board \d+\.\d+\.\d+ \(compiled\)\ngit /);
		const repo = join(base, "board-repo");
		mkdirSync(repo);
		writeFileSync(
			join(repo, "board.yaml"),
			[
				"mfw: 1",
				"types:",
				"  task:",
				"    layout: flat",
				"    dir: tasks",
				"    id: { strategy: own-sequence, key: TK }",
				"    fields:",
				"      title: {}",
				"      status: { values: [todo, done], default: todo }",
			].join("\n"),
		);
		// The board takes its lock through `flock`, so it needs the real PATH.
		const env = { PATH: process.env.PATH ?? "" };
		const created = run(
			[mfw, "board", "create", "title=from the compiled mfw"],
			{
				cwd: repo,
				env,
			},
		);
		expect(created.err).toBe("");
		expect(created.code).toBe(0);
		const listed = run([board, "list", "--json"], { cwd: repo, env });
		expect(listed.code).toBe(0);
		expect(JSON.parse(listed.out)).toEqual([
			expect.objectContaining({
				id: "TK-1",
				fields: expect.objectContaining({ title: "from the compiled mfw" }),
			}),
		]);
		const checked = run([board, "check"], { cwd: repo, env });
		expect(checked.code).toBe(0);
		const help = run([board, "--help"]);
		expect(help.out).toContain("usage: mfw-board");
		report.push(`mfw-board --help: ${help.ms.toFixed(0)} ms`);
	});

	test("the shim is refused: a compiled mfw-board is already an executable", () => {
		const r = run([board, "shim", "install", "--dir", join(base, "shim")]);
		expect(r.code).toBe(2);
		expect(r.err).toContain("already an executable");
	});

	test("doctor runs read-only and verifies the embedded migrations", () => {
		const home = join(base, "mfw-home");
		const before = readdirSync(home);
		const r = run([mfw, "doctor", "--json"]);
		const report = JSON.parse(r.out) as {
			checks: { id: string; status: string; detail: string }[];
		};
		const build = report.checks.find((c) => c.id === "install.build");
		expect(build?.status).toBe("ok");
		expect(build?.detail).toContain("compiled mfw: embedded migrations verify");
		expect(readdirSync(home)).toEqual(before);
	});

	test("the sandbox scripts come out of the executable", () => {
		for (const id of HOST_CONTENT_IDS) {
			const r = run([mfw, "__host", "emit", id]);
			expect(r.code, id).toBe(0);
			expect(r.out.length, id).toBeGreaterThan(200);
		}
		expect(run([mfw, "__host", "emit", "egress-relay"]).out).toContain(
			"egress-relay.ts",
		);
	});

	test("a host entry runs by self re-exec", () => {
		const r = run([mfw, "__host", "egress-proxy"]);
		expect(r.code).toBe(1);
		expect(r.err).toContain("usage: egress-proxy-main");
	});

	test("internal subcommands refuse unknown ids and the launcher's subtree", () => {
		expect(run([mfw, "__host", "sh"]).code).toBe(78);
		const nested = run([mfw, "__host", "agent-launcher", "/x", "--", "true"], {
			env: { MFW_HOST_ENTRY: "agent-launcher" },
		});
		expect(nested.code).toBe(78);
		expect(nested.err).toContain("never re-execs through the launcher");
		const dotenv = join(base, "dotenv");
		mkdirSync(dotenv);
		writeFileSync(join(dotenv, ".env"), "BUN_BE_BUN=1\n");
		writeFileSync(join(dotenv, "bunfig.toml"), 'preload = ["./x.ts"]\n');
		const cwdFiles = run([mfw, "version"], { cwd: dotenv });
		expect(cwdFiles.code).toBe(0);
		expect(cwdFiles.out).toStartWith("mfw ");
	});

	/**
	 * A compiled bun executable cannot refuse these (security review REL-1 M1):
	 * this pins down that fact, so no code or document claims otherwise.
	 */
	test("residual: bun runtime variables act before, or instead of, mfw's own code", () => {
		const mark = join(base, "preloaded");
		const preload = join(base, "preload.ts");
		writeFileSync(
			preload,
			`require("node:fs").writeFileSync(${JSON.stringify(mark)}, "ran");`,
		);
		const opt = run([mfw, "__host", "egress-proxy"], {
			env: { BUN_OPTIONS: `--preload ${preload}` },
		});
		expect(readFileSync(mark, "utf8")).toBe("ran");
		expect(opt.err).toContain("usage: egress-proxy-main");
		const asBun = run([mfw, "--version"], { env: { BUN_BE_BUN: "1" } });
		expect(asBun.out.trim()).toBe(Bun.version);
	});

	test("the host's spawn environment keeps them away from mfw, in TypeScript and in run.sh", () => {
		const mark = join(base, "preloaded-by-host");
		const preload = join(base, "preload-host.ts");
		writeFileSync(
			preload,
			`require("node:fs").writeFileSync(${JSON.stringify(mark)}, "ran");`,
		);
		const hostile = {
			PATH: dirname(process.execPath),
			HOME: join(base, "home"),
			BUN_OPTIONS: `--preload ${preload}`,
			BUN_BE_BUN: "1",
			LD_PRELOAD: join(base, "no-such.so"),
			NODE_OPTIONS: `--require ${preload}`,
		};
		const ts = Bun.spawnSync([mfw, "__host", "egress-proxy"], {
			env: hostSpawnEnv(hostile),
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(ts.stderr.toString()).toContain("usage: egress-proxy-main");
		const bash = Bun.which("bash") as string;
		const envBin = Bun.which("env") as string;
		const script = [
			...hostSpawnEnvShell(["BUN_OPTIONS"]),
			`${envBin} -i "\${mfw_env[@]}" ${mfw} __host egress-proxy`,
		].join("\n");
		const sh = Bun.spawnSync([bash, "-c", script], {
			env: hostile,
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(sh.stderr.toString()).toContain("usage: egress-proxy-main");
		expect(() => readFileSync(mark)).toThrow();
	});

	const noBwrap = bwrapUnavailable();
	test.skipIf(liveGate("compiled-live sandbox", noBwrap) !== null)(
		"inside a real mfw sandbox (the compiled task profile), every internal subcommand is refused",
		() => {
			const r = inRealSandbox(mfw, [
				["__host", "emit", "egress-relay"],
				["__host", "agent-launcher", "/x", "--", "true"],
			]);
			for (const one of r) {
				expect(one.out).toBe("");
				expect(one.err).toContain("inside an mfw sandbox");
				expect(one.code).toBe(78);
			}
		},
		TIMEOUT,
	);
});

/**
 * Run the compiled mfw, copied into a run's workspace, inside the sandbox the
 * real profile compiler builds for a task run: read-only root, seccomp, no
 * capabilities, the toolchain closure (bun's, which `mfw` shares), and the
 * guard the destructive live suites use. The systemd scope is left out, as in
 * those suites, because a test host often has no user manager.
 */
function inRealSandbox(
	exe: string,
	commands: string[][],
): { code: number | null; out: string; err: string }[] {
	const fixtures = join(ROOT, ".live-sandbox");
	mkdirSync(fixtures, { recursive: true });
	const root = realpathSync(mkdtempSync(join(fixtures, "compiled-")));
	try {
		const home = join(root, "fake-home");
		const work = join(root, "mfw/runs/r1/work");
		mkdirSync(home, { recursive: true });
		mkdirSync(work, { recursive: true });
		copyFileSync(exe, join(work, "mfw"));
		chmodSync(join(work, "mfw"), 0o755);
		const bwrap = Bun.which("bwrap") as string;
		const envBin = Bun.which("env") as string;
		const binaries = ["sh", "bun"];
		const pass = <T>(value: T) => ({
			ok: true as const,
			severity: "required" as const,
			value,
			detail: "ok",
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
			bwrapPath: bwrap,
			envPath: envBin,
			systemdRunPath: "/unused/systemd-run",
			toolchain: discoverToolchain({
				home,
				binaries,
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
		const profile = parseSandboxProfile({
			version: 1,
			role: "task",
			filesystem: {
				workspace: { source: work, access: "rw" },
				scratch: "tmpfs",
				toolchain: { binaries },
			},
		});
		return commands.map((args) => {
			const c = compileBwrap(
				profile,
				[`${SANDBOX_PATHS.workspace}/mfw`, ...args],
				host,
			);
			if (!c.ok) throw new Error(`compile refused: ${c.reason}`);
			const argv = assertContained(c, {
				root,
				bwrap,
				env: envBin,
				homes: realHomes(),
				hidden: [root, home],
				hostNs: hostNamespaces(),
				writable: [...BASE_WRITABLE, "/scratch", "/work"],
			});
			const bpf = join(root, "deny.bpf");
			writeFileSync(bpf, c.seccomp, { mode: 0o600 });
			const opts = join(root, "bwrap.args");
			writeFileSync(opts, c.bwrapArgs, { mode: 0o600 });
			const pins = openPinnedBinds(c.pinnedBinds);
			const stdio = [
				"ignore",
				"pipe",
				"pipe",
				Bun.file(bpf),
				Bun.file(opts),
				...pins.parentFds,
			];
			pins.release();
			const r = Bun.spawnSync(argv, { stdio: stdio as never, timeout: 30_000 });
			return {
				code: r.exitCode,
				out: r.stdout.toString(),
				err: r.stderr.toString(),
			};
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}
