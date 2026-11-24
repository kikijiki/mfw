import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import {
	type CompileHost,
	compileBwrap,
	NIX_DAEMON_SOCKET_DIR,
} from "../src/containment/compile-bwrap.ts";
import {
	ENV_ENTRY_SCRIPT,
	runEnvStep,
} from "../src/containment/dev-env-build.ts";
import {
	DevEnvParseError,
	decodeDirenvWatches,
	parseDirenvExport,
	parseEnvNul,
	parseMiseEnv,
	parseNixDevEnv,
	watchedRepoPaths,
} from "../src/containment/dev-env-capture.ts";
import {
	envBuildAllowlist,
	envInstallAllowlist,
} from "../src/containment/dev-env-egress.ts";
import type { Check } from "../src/containment/host-caps.ts";
import { parseSandboxProfile } from "../src/containment/profile.ts";
import { git } from "../src/git.ts";

const pass = <T>(value: T): Check<T> => ({
	ok: true,
	severity: "required",
	value,
	detail: "ok",
});

const R = "/users/owner/.local/share/mfw/runs/r1";

function host(over: Partial<CompileHost> = {}): CompileHost {
	return {
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
		bwrapPath: "/bin/bwrap",
		envPath: "/bin/env",
		systemdRunPath: "/bin/systemd-run",
		toolchain: {
			binds: [
				{
					path: "/nix/store/g",
					source: "nix",
					reason: "closure",
					optional: false,
				},
				{ path: "/etc/ssl", source: "etc", reason: "etc set", optional: true },
			],
			resolved: [
				{
					name: "git",
					path: "/nix/store/g/bin/git",
					realPath: "/nix/store/g/bin/git",
				},
			],
			unresolved: [],
			pathDirs: ["/nix/store/g/bin"],
			masks: ["/nix/store/p/bin"],
		},
		home: "/users/owner",
		mfwHome: "/users/owner/.local/share/mfw",
		allowedRoots: [R],
		realpath: (p) => p,
		...over,
	};
}

const envProfile = (role: string, extra: Record<string, unknown> = {}) => ({
	version: 1,
	role,
	filesystem: {
		workspace: {
			source: `${R}/work`,
			gitDir: `${R}/git`,
			access: "rw",
			gitAccess: "ro",
		},
		toolchain: { binaries: ["git"] },
		...extra,
	},
	network: { mode: "proxy", socketDir: `${R}/egress` },
});

function options(profile: unknown, h = host()): string[] {
	const r = compileBwrap(parseSandboxProfile(profile), ["sh"], h);
	if (!r.ok) throw new Error(r.reason);
	return r.bwrapArgs.toString().slice(0, -1).split("\0");
}

describe("the env-build role's ceiling", () => {
	test("only env-build may reach the nix daemon", () => {
		expect(() =>
			parseSandboxProfile(envProfile("env-build", { nixDaemon: true })),
		).not.toThrow();
		for (const role of ["env-install", "task", "verifier", "brain"]) {
			expect(() =>
				parseSandboxProfile(envProfile(role, { nixDaemon: true })),
			).toThrow("the nix daemon");
		}
	});

	test("an env role has no agent config, no credentials and no writable gitdir", () => {
		expect(() =>
			parseSandboxProfile(
				envProfile("env-build", {
					fleetConfig: { cli: "claude", source: `${R}/fleet`, writable: [] },
				}),
			),
		).toThrow("agent config");
		expect(() =>
			parseSandboxProfile({
				...envProfile("env-install"),
				process: { env: { ANTHROPIC_API_KEY: "x" } },
			}),
		).toThrow("credentials");
		expect(() =>
			parseSandboxProfile({
				...envProfile("env-build"),
				filesystem: {
					workspace: { source: `${R}/work`, gitDir: `${R}/git`, access: "rw" },
				},
			}),
		).toThrow("a writable gitdir");
	});
});

describe("compiling the nix daemon grant", () => {
	test("binds the whole store and the socket read-only and sets the client env", () => {
		const opts = options(envProfile("env-build", { nixDaemon: true }));
		const pairs = opts.map((o, i) => `${o} ${opts[i + 1]} ${opts[i + 2]}`);
		expect(pairs).toContain("--ro-bind /nix/store /nix/store");
		expect(pairs).toContain(
			`--ro-bind ${NIX_DAEMON_SOCKET_DIR} ${NIX_DAEMON_SOCKET_DIR}`,
		);
		// The whole store is visible, so nothing in it is masked or bound twice.
		expect(opts).not.toContain("/nix/store/p/bin");
		expect(opts).not.toContain("/nix/store/g");
		const setenv = (name: string) => opts[opts.indexOf(name) + 1];
		expect(setenv("NIX_REMOTE")).toBe("daemon");
		expect(setenv("NIX_CONFIG")).toContain("accept-flake-config = false");
	});

	test("without the grant there is no store bind, no socket and the masks apply", () => {
		const opts = options(envProfile("env-install"));
		expect(opts).not.toContain(NIX_DAEMON_SOCKET_DIR);
		expect(opts).not.toContain("NIX_REMOTE");
		expect(opts.join(" ")).toContain("--tmpfs /nix/store/p/bin");
	});

	test("a host without the daemon socket is refused, not given a partial sandbox", () => {
		const r = compileBwrap(
			parseSandboxProfile(envProfile("env-build", { nixDaemon: true })),
			["sh"],
			host({ realpath: (p) => (p === NIX_DAEMON_SOCKET_DIR ? null : p) }),
		);
		expect(r.ok).toBe(false);
		expect(!r.ok && r.code).toBe("host_unsupported");
	});
});

describe("the entry script", () => {
	test("is valid POSIX sh", () => {
		const dir = mkdtempSync(join(tmpdir(), "env-entry-"));
		try {
			writeFileSync(join(dir, "e.sh"), ENV_ENTRY_SCRIPT);
			const r = Bun.spawnSync(["sh", "-n", join(dir, "e.sh")]);
			expect(r.exitCode).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("refuses a trusting daemon before any project file is read", () => {
		const trust = ENV_ENTRY_SCRIPT.indexOf("nix store info");
		expect(trust).toBeGreaterThan(0);
		for (const tool of [
			"direnv allow",
			"mise trust",
			"nix print-dev-env",
			"devenv print-dev-env",
		]) {
			expect(ENV_ENTRY_SCRIPT.indexOf(tool)).toBeGreaterThan(trust);
		}
	});
});

describe("a trusted nix client", () => {
	test("is refused on the host, before a clone or a sandbox exists", async () => {
		const base = realpathSync(mkdtempSync(join(tmpdir(), "env-trusted-")));
		try {
			const root = join(base, "p");
			mkdirSync(join(root, ".mfw"), { recursive: true });
			await git(["init", "-q", "-b", "main", "."], root);
			const mfwHome = join(base, "mfw");
			mkdirSync(mfwHome);
			let compiled = false;
			const r = await runEnvStep({
				step: "flake",
				projectRoot: root,
				stateDir: join(root, ".mfw"),
				mfwHome,
				commit: "0".repeat(40),
				allow: [],
				dataDir: join(mfwHome, "env/data/x"),
				timeoutMs: 1000,
				nixTrust: async () => "trusted",
				steps: {
					compileHost: async () => {
						compiled = true;
						throw new Error("must not be reached");
					},
				} as never,
			});
			expect(r.ok).toBe(false);
			expect(!r.ok && r.code).toBe("nix_trusted");
			expect(!r.ok && r.fix).toContain("trusted-users");
			expect(compiled).toBe(false);
			expect(existsSync(join(mfwHome, "workspaces"))).toBe(false);
			// "unknown" is refused too: no answer is not an answer.
			const unknown = await runEnvStep({
				step: "direnv",
				projectRoot: root,
				stateDir: join(root, ".mfw"),
				mfwHome,
				commit: "0".repeat(40),
				allow: [],
				dataDir: join(mfwHome, "env/data/x"),
				timeoutMs: 1000,
				nixTrust: async () => "unknown",
			});
			expect(!unknown.ok && unknown.code).toBe("nix_trusted");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});

describe("parsing each tool's export", () => {
	test("direnv: set and unset names; empty output is no change", () => {
		expect(parseDirenvExport('{"A":"1","B":null,"C":2}')).toEqual({
			A: "1",
			B: null,
		});
		expect(parseDirenvExport("")).toEqual({});
		expect(() => parseDirenvExport("export A=1")).toThrow(DevEnvParseError);
		expect(() => parseDirenvExport("[1]")).toThrow("not a JSON object");
	});

	test("mise and nix print-dev-env", () => {
		expect(parseMiseEnv('{"PATH":"/x","N":3}')).toEqual({ PATH: "/x" });
		expect(
			parseNixDevEnv(
				JSON.stringify({
					variables: {
						A: { type: "exported", value: "1" },
						B: { type: "var", value: "2" },
						C: { type: "array", value: ["x"] },
					},
				}),
			),
		).toEqual({ A: "1" });
		expect(() => parseNixDevEnv("{}")).toThrow("no variables");
	});

	test("env -0 keeps only what differs from the baseline", () => {
		const bytes = Buffer.from("A=1\0HOME=/h\0B=x=y\0junk\0");
		expect(parseEnvNul(bytes, { HOME: "/h" })).toEqual({ A: "1", B: "x=y" });
	});

	test("an export is a prototype-free record", () => {
		const env = parseMiseEnv('{"__proto__":"x","constructor":"y"}');
		expect(Object.getPrototypeOf(env)).toBeNull();
	});

	test("direnv's watch list decodes, with a cap on what it inflates", () => {
		const encode = (v: unknown) =>
			deflateSync(Buffer.from(JSON.stringify(v)))
				.toString("base64")
				.replace(/\+/g, "-")
				.replace(/\//g, "_");
		const watches = decodeDirenvWatches(
			encode([
				{ path: "/work/.envrc", exists: true },
				{ path: "/work/sub/x.sh", exists: true },
				{ path: "/work/.direnv/flake-profile", exists: true },
				{ path: "/work/../etc/passwd", exists: true },
				{ path: "/sandbox/agent/.local/share/direnv/allow/abc", exists: true },
			]),
		);
		expect(watchedRepoPaths(watches)).toEqual([".envrc", "sub/x.sh"]);
		expect(decodeDirenvWatches(undefined)).toEqual([]);
		expect(() => decodeDirenvWatches("!!!")).toThrow(DevEnvParseError);
		// A small value that inflates past 1 MiB is refused, not expanded.
		const bomb = deflateSync(Buffer.alloc(4 * 1024 * 1024, 0x20))
			.toString("base64")
			.replace(/\+/g, "-")
			.replace(/\//g, "_");
		expect(() => decodeDirenvWatches(bomb)).toThrow(DevEnvParseError);
	});
});

describe("the env allowlists", () => {
	test("exact host:port pairs, no wildcard, deduplicated", () => {
		const allow = envBuildAllowlist(["git.example.org:443", "github.com:443"]);
		const keys = allow.map((a) => `${a.host}:${a.port}`);
		expect(new Set(keys).size).toBe(keys.length);
		expect(keys).toContain("git.example.org:443");
		expect(keys.some((k) => k.includes("*"))).toBe(false);
		expect(keys).not.toContain("cache.nixos.org:443");
	});

	test("setup reaches the registries its lockfiles select, or exactly the configured ones", () => {
		expect(envInstallAllowlist(["bun.lock"], undefined)).toEqual([
			{ host: "registry.npmjs.org", port: 443 },
		]);
		expect(
			envInstallAllowlist(["bun.lock"], ["npm.internal.example:8443"]),
		).toEqual([{ host: "npm.internal.example", port: 8443 }]);
		expect(envInstallAllowlist([], undefined)).toEqual([]);
	});
});
