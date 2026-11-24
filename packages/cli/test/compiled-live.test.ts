import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
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
import { SANDBOX_PATHS } from "../../daemon/src/containment/compile-bwrap.ts";
import { HOST_CONTENT_IDS } from "../../daemon/src/containment/host-script.ts";
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
	const target = hostTarget();
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

	test("internal subcommands refuse unknown ids, runtime options and the launcher's subtree", () => {
		expect(run([mfw, "__host", "sh"]).code).toBe(78);
		const preload = join(base, "preload.ts");
		writeFileSync(
			preload,
			`require("node:fs").writeFileSync(${JSON.stringify(join(base, "preloaded"))}, "x");`,
		);
		const opt = run([mfw, "__host", "egress-proxy"], {
			env: { BUN_OPTIONS: `--preload ${preload}` },
		});
		expect(opt.code).toBe(78);
		expect(opt.err).toContain("BUN_OPTIONS is set");
		const nested = run([mfw, "__host", "agent-launcher", "/x", "--", "true"], {
			env: { MFW_HOST_ENTRY: "agent-launcher" },
		});
		expect(nested.code).toBe(78);
		expect(nested.err).toContain("never re-execs through the launcher");
		const dotenv = join(base, "dotenv");
		mkdirSync(dotenv);
		writeFileSync(join(dotenv, ".env"), "BUN_BE_BUN=1\n");
		writeFileSync(join(dotenv, "bunfig.toml"), `preload = ["${preload}"]\n`);
		const cwdFiles = run([mfw, "version"], { cwd: dotenv });
		expect(cwdFiles.code).toBe(0);
		expect(cwdFiles.out).toStartWith("mfw ");
	});

	const noBwrap = bwrapUnavailable();
	test.skipIf(liveGate("compiled-live sandbox", noBwrap) !== null)(
		"inside an mfw sandbox, every internal subcommand is refused",
		() => {
			const bwrap = Bun.which("bwrap") as string;
			const store = dirname(dirname(realpathSync(process.execPath)));
			const r = Bun.spawnSync(
				[
					bwrap,
					"--unshare-all",
					"--die-with-parent",
					// Whatever the executable links against, read-only.
					...["/nix", "/usr", "/lib", "/lib64"].flatMap((d) => [
						"--ro-bind-try",
						d,
						d,
					]),
					"--ro-bind",
					bin,
					"/opt/mfw",
					"--proc",
					"/proc",
					"--dev",
					"/dev",
					"--tmpfs",
					"/tmp",
					"--tmpfs",
					SANDBOX_PATHS.home,
					"--remount-ro",
					"/",
					"--setenv",
					"HOME",
					SANDBOX_PATHS.home,
					"--setenv",
					"PATH",
					`${store}/bin`,
					"--",
					"/opt/mfw/mfw",
					"__host",
					"emit",
					"egress-relay",
				],
				{ stdout: "pipe", stderr: "pipe", env: {} },
			);
			expect(r.stdout.toString()).toBe("");
			expect(r.stderr.toString()).toContain("inside an mfw sandbox");
			expect(r.exitCode).toBe(78);
		},
		TIMEOUT,
	);
});
