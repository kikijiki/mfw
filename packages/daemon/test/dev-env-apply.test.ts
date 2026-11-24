import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { effectiveCheckPrefix } from "../src/containment/check-sandbox.ts";
import {
	type CompileHost,
	compileBwrap,
	SANDBOX_PATHS,
} from "../src/containment/compile-bwrap.ts";
import type {
	EnvRunRequest,
	EnvRunResult,
} from "../src/containment/dev-env-build.ts";
import { loadDevEnv } from "../src/containment/dev-env-cache.ts";
import { filterDevEnv } from "../src/containment/dev-env-capture.ts";
import { resolveDevEnv } from "../src/containment/dev-env-resolve.ts";
import {
	ENV_DATA_SANDBOX_PATH,
	isEnvLoaderPrefix,
} from "../src/containment/dev-env-rules.ts";
import { allowEnv, EnvTrustStore } from "../src/containment/dev-env-trust.ts";
import type { Check } from "../src/containment/host-caps.ts";
import { parseSandboxProfile } from "../src/containment/profile.ts";
import { ENV_DATA_CACHE } from "../src/containment/role-profiles.ts";
import { git } from "../src/git.ts";

const S1 = "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-hello-2.12";
const S2 = "/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-glibc-2.42";
const S3 = "/nix/store/cccccccccccccccccccccccccccccccc-python3-3.13";
const S4 = "/nix/store/dddddddddddddddddddddddddddddddd-perl-5.40";
/** A store path that exists on this host: the bun running the tests. */
const REAL = (process.execPath.match(/^\/nix\/store\/[^/]+/) ?? [
	"/nix/store/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee-absent",
])[0];

describe("filtering a captured environment", () => {
	const hostile = {
		FIXTURE: "yes",
		LD_PRELOAD: "/work/evil.so",
		LD_LIBRARY_PATH: "/work/lib",
		DYLD_INSERT_LIBRARIES: "/x",
		BUN_INSTALL: "/x",
		BUN_CONFIG_REGISTRY: "https://evil.example",
		NODE_OPTIONS: "--require /work/evil.js",
		NODE_EXTRA_CA_CERTS: "/work/ca.pem",
		GLIBC_TUNABLES: "glibc.malloc.x=1",
		BASH_ENV: "/work/hook.sh",
		HOME: "/elsewhere",
		TMPDIR: "/tmp/nix-shell.x",
		https_proxy: "http://evil:1",
		NO_PROXY: "*",
		GIT_SSH_COMMAND: "evil",
		MFW_RUN_ID: "forged",
		ANTHROPIC_API_KEY: "sk-x",
		GH_TOKEN: "ghp_x",
		DIRENV_DIFF: "x",
		"BAD-NAME": "x",
		UNSET_ME: null,
		HUGE: "x".repeat(40_000),
		NIX_CC: `${S1}`,
		PATH: [
			`${S1}/bin`,
			"/etc/evil",
			"/work/bin",
			`${S1}/bin`,
			"/nix/store/../etc",
			"/eval/own/bin",
			"relative/bin",
			`${ENV_DATA_SANDBOX_PATH}/mise/installs/jq/1.7.1`,
		].join(":"),
	};

	test("drops every loader, runtime and malformed name, with its reason", () => {
		const f = filterDevEnv(hostile, { evaluationPath: ["/eval/own/bin"] });
		expect(f.env).toEqual({ FIXTURE: "yes", NIX_CC: S1 });
		const reasons = Object.fromEntries(
			f.dropped.map((d) => [d.name, d.reason]),
		);
		for (const n of [
			"LD_PRELOAD",
			"LD_LIBRARY_PATH",
			"DYLD_INSERT_LIBRARIES",
			"BUN_INSTALL",
			"BUN_CONFIG_REGISTRY",
			"NODE_OPTIONS",
			"NODE_EXTRA_CA_CERTS",
			"GLIBC_TUNABLES",
			"BASH_ENV",
		]) {
			expect([n, reasons[n]]).toEqual([n, "loader"]);
		}
		for (const n of [
			"HOME",
			"TMPDIR",
			"https_proxy",
			"NO_PROXY",
			"GIT_SSH_COMMAND",
			"MFW_RUN_ID",
			"ANTHROPIC_API_KEY",
			"GH_TOKEN",
			"DIRENV_DIFF",
		]) {
			expect([n, reasons[n]]).toEqual([n, "runtime"]);
		}
		expect(reasons["BAD-NAME"]).toBe("invalid_name");
		expect(reasons.UNSET_ME).toBe("unset");
		expect(reasons.HUGE).toBe("too_large");
	});

	test("PATH keeps the store, the run's tree and the env data, minus the evaluation's own", () => {
		const f = filterDevEnv(hostile, { evaluationPath: ["/eval/own/bin"] });
		expect(f.path).toEqual([
			`${S1}/bin`,
			"/work/bin",
			`${ENV_DATA_SANDBOX_PATH}/mise/installs/jq/1.7.1`,
		]);
		expect(f.droppedPath).toEqual([
			"/etc/evil",
			"/nix/store/../etc",
			"relative/bin",
		]);
		expect(f.storeRoots).toEqual([S1]);
	});

	test("the data path is the env-data cache mount", () => {
		expect(ENV_DATA_SANDBOX_PATH).toBe(
			`${SANDBOX_PATHS.caches}/${ENV_DATA_CACHE}`,
		);
	});
});

const pass = <T>(value: T): Check<T> => ({
	ok: true,
	severity: "required",
	value,
	detail: "ok",
});
const R = "/users/owner/.local/share/mfw/workspaces/verify-x";
const D = "/users/owner/.local/share/mfw/env/cache/p/f";

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
			binds: [{ path: S2, source: "nix", reason: "closure", optional: false }],
			resolved: [
				{ name: "git", path: `${S2}/bin/git`, realPath: `${S2}/bin/git` },
			],
			unresolved: [],
			pathDirs: [`${S2}/bin`],
			masks: [`${S3}/bin`, `${S2}/sbin`, `${S4}/bin`],
		},
		home: "/users/owner",
		mfwHome: "/users/owner/.local/share/mfw",
		allowedRoots: ["/users/owner/.local/share/mfw/workspaces", D],
		realpath: (p) => p,
		...over,
	};
}

const devEnv = {
	env: { FIXTURE: "yes" },
	path: [`${S1}/bin`, "/work/node_modules/.bin"],
	closure: [S1, S2, S3],
	dataDir: `${D}/data`,
};

const verifier = (extra: Record<string, unknown> = {}) => ({
	version: 1,
	role: "verifier",
	filesystem: {
		workspace: {
			source: `${R}/tree`,
			gitDir: `${R}/git`,
			access: "rw",
			gitAccess: "ro",
		},
		toolchain: { binaries: ["git"] },
		devEnv,
		...extra,
	},
});

describe("a dev environment in the profile", () => {
	test("the schema checks it again: a cast cannot smuggle a loader or a foreign PATH", () => {
		expect(() => parseSandboxProfile(verifier())).not.toThrow();
		expect(() =>
			parseSandboxProfile(
				verifier({ devEnv: { ...devEnv, env: { LD_PRELOAD: "/x" } } }),
			),
		).toThrow("devEnv.env.LD_PRELOAD");
		expect(() =>
			parseSandboxProfile(
				verifier({ devEnv: { ...devEnv, path: ["/home/owner/bin"] } }),
			),
		).toThrow("outside the store closure");
		expect(() =>
			parseSandboxProfile(
				verifier({
					devEnv: {
						...devEnv,
						path: ["/nix/store/dddddddddddddddddddddddddddddddd-x/bin"],
					},
				}),
			),
		).toThrow("outside the environment's store closure");
		expect(() =>
			parseSandboxProfile({
				...verifier(),
				role: "reviewer",
				filesystem: { devEnv },
			}),
		).toThrow("a dev environment");
		expect(() =>
			parseSandboxProfile({ ...verifier(), role: "env-build" }),
		).toThrow("a dev environment");
	});

	test("compiles to its env first, its PATH first, its closure bound and unmasked", () => {
		const r = compileBwrap(parseSandboxProfile(verifier()), ["sh"], host());
		if (!r.ok) throw new Error(r.reason);
		expect(r.env.FIXTURE).toBe("yes");
		expect(r.env.HOME).toBe(SANDBOX_PATHS.home);
		expect(r.env.PATH).toBe(`${S1}/bin:/work/node_modules/.bin:${S2}/bin`);
		const opts = r.bwrapArgs.toString().split("\0");
		const pairs = opts.map((o, i) => `${o} ${opts[i + 1]} ${opts[i + 2]}`);
		expect(pairs).toContain(`--ro-bind ${S1} ${S1}`);
		expect(pairs).toContain(`--ro-bind ${S3} ${S3}`);
		// S2 is already the toolchain's; it is not bound twice.
		expect(pairs.filter((p) => p === `--ro-bind ${S2} ${S2}`).length).toBe(1);
		// A closure member is not masked; outside the closure masks still apply.
		expect(opts).not.toContain(`${S3}/bin`);
		expect(opts).not.toContain(`${S2}/sbin`);
		expect(pairs).toContain(`--tmpfs ${S4}/bin --remount-ro`);
		const data = r.pinnedBinds.find((b) => b.label === "env data");
		expect(data).toMatchObject({
			source: `${D}/data`,
			dest: ENV_DATA_SANDBOX_PATH,
			writable: false,
		});
	});

	test("a closure path the store no longer holds refuses the launch", () => {
		const r = compileBwrap(
			parseSandboxProfile(verifier()),
			["sh"],
			host({ realpath: (p) => (p === S3 ? null : p) }),
		);
		expect(r.ok).toBe(false);
		expect(!r.ok && r.code).toBe("dev_env_missing");
	});
});

describe("check prefixes that load an environment", () => {
	test("the recognised loaders", () => {
		for (const p of [
			"direnv exec .",
			"nix develop -c",
			"nix develop .#ci --command",
			"devenv shell",
			"mise exec --",
			" nix  develop  -c ",
		]) {
			expect([p, isEnvLoaderPrefix(p)]).toEqual([p, true]);
		}
		for (const p of [
			"timeout 600",
			"nix develop -c foo",
			"direnv exec /",
			undefined,
		]) {
			expect([p, isEnvLoaderPrefix(p)]).toEqual([p, false]);
		}
	});

	test("dropped with the approved environment, refused without one", () => {
		expect(effectiveCheckPrefix("nix develop -c", "ready")).toEqual({
			prefix: undefined,
		});
		expect("refuse" in effectiveCheckPrefix("nix develop -c", "none")).toBe(
			true,
		);
		expect("refuse" in effectiveCheckPrefix("nix-shell --run", "ready")).toBe(
			true,
		);
		expect(effectiveCheckPrefix("timeout 600", "none")).toEqual({
			prefix: "timeout 600",
		});
		expect(effectiveCheckPrefix(undefined, "none")).toEqual({
			prefix: undefined,
		});
	});
});

describe("the host-side cache and the resolver", () => {
	let base: string;
	let root: string;
	let mfwHome: string;
	let commit: string;
	const watchesValue = (paths: string[]) =>
		deflateSync(
			Buffer.from(
				JSON.stringify(paths.map((path) => ({ path, exists: true }))),
			),
		)
			.toString("base64")
			.replace(/\+/g, "-")
			.replace(/\//g, "_");
	let runs = 0;
	const fakeRun = async (req: EnvRunRequest): Promise<EnvRunResult> => {
		runs++;
		await Bun.sleep(20);
		expect(req.step).toBe("direnv");
		return {
			ok: true,
			output: Buffer.from(
				JSON.stringify({
					FIXTURE: "yes",
					LD_PRELOAD: "/work/evil.so",
					PATH: `/work/bin:${REAL}/bin:/eval/bin`,
					DIRENV_WATCHES: watchesValue([
						"/work/.envrc",
						"/work/env.sh",
						"/sandbox/agent/x",
					]),
				}),
			),
			log: "evaluated",
			egress: {
				version: 1,
				allowed: {},
				denied: {
					"example.com:443": { count: 1, lastReason: "not-allowlisted" },
				},
				updatedAt: 0,
			},
			sandboxPath: ["/eval/bin"],
			sandboxEnv: {},
		};
	};
	const seams = {
		run: fakeRun,
		closure: (roots: readonly string[]) => ({
			method: "nix-store" as const,
			paths: [...roots],
		}),
		gcRoots: async () => true,
	};

	beforeAll(async () => {
		base = realpathSync(mkdtempSync(join(tmpdir(), "dev-env-apply-")));
		root = join(base, "p");
		mfwHome = join(base, "mfw");
		mkdirSync(join(root, ".mfw"), { recursive: true });
		mkdirSync(mfwHome);
		await git(["init", "-q", "-b", "main", "."], root);
		await git(["config", "user.email", "t@t"], root);
		await git(["config", "user.name", "t"], root);
		writeFileSync(join(root, ".envrc"), "source_env env.sh\n");
		writeFileSync(join(root, "env.sh"), "export FIXTURE=yes\n");
		await git(["add", "-A"], root);
		await git(["commit", "-q", "-m", "one"], root);
		commit = (await git(["rev-parse", "HEAD"], root)).stdout;
	});
	afterAll(() => rmSync(base, { recursive: true, force: true }));

	const resolve = (build = true) =>
		resolveDevEnv({
			mfwHome,
			project: "p",
			root,
			config: undefined,
			rev: "main",
			build,
			seams: seams as never,
		});

	test("unapproved: refused with the exact allow command", async () => {
		const r = await resolve();
		expect(r.kind).toBe("refused");
		expect(r.kind === "refused" && r.code).toBe("env_not_approved");
		expect(r.kind === "refused" && r.fix).toContain(
			`mfw env allow p --rev ${commit}`,
		);
		expect(runs).toBe(0);
	});

	test("approved: built once, filtered, cached, and its watched files recorded", async () => {
		await allowEnv(new EnvTrustStore(mfwHome), {
			project: "p",
			root,
			commit,
			setting: "auto",
			config: undefined,
			via: "cli",
		});
		expect((await resolve(false)).kind === "refused").toBe(true);
		const [a, b] = await Promise.all([resolve(), resolve()]);
		expect(runs).toBe(1);
		expect(a.kind).toBe("ready");
		if (a.kind !== "ready" || b.kind !== "ready") return;
		expect(a.capture.env).toEqual({ FIXTURE: "yes" });
		expect(a.capture.path).toEqual(["/work/bin", `${REAL}/bin`]);
		expect(a.capture.closure).toEqual([REAL]);
		expect(a.capture.dropped).toContainEqual({
			name: "LD_PRELOAD",
			reason: "loader",
		});
		expect(a.capture.egress.denied).toEqual(["example.com:443"]);
		expect(a.capture.watches).toEqual([".envrc", "env.sh"]);
		const rec = new EnvTrustStore(mfwHome).read(root);
		expect(rec?.discovered.map((f) => f.path)).toEqual(["env.sh"]);
		// A later resolve reads the cache.
		expect((await resolve()).kind).toBe("ready");
		expect(runs).toBe(1);
		expect(await loadDevEnv(mfwHome, root, a.fingerprint)).toEqual(a.capture);
	});

	test("a tampered cache entry is not used", async () => {
		const r = await resolve();
		if (r.kind !== "ready") throw new Error("not ready");
		const file = join(mfwHome, "env/cache");
		const found = Bun.spawnSync(["find", file, "-name", "capture.json"])
			.stdout.toString()
			.trim();
		const text = readFileSync(found, "utf8");
		writeFileSync(found, text.replace('"version": 1', '"version": 2'));
		expect(await loadDevEnv(mfwHome, root, r.fingerprint)).toBeNull();
		writeFileSync(found, text);
	});

	test("a change to a sourced file drifts, even though only the evaluation named it", async () => {
		writeFileSync(join(root, "env.sh"), "export LD_PRELOAD=/x\n");
		await git(["commit", "-q", "-am", "two"], root);
		const r = await resolve();
		expect(r.kind === "refused" && r.code).toBe("env_drifted");
		expect(r.kind === "refused" && r.reason).toContain("env.sh");
	});

	test("a failed evaluation is refused with its log", async () => {
		const head = (await git(["rev-parse", "HEAD"], root)).stdout;
		await allowEnv(new EnvTrustStore(mfwHome), {
			project: "p",
			root,
			commit: head,
			setting: "auto",
			config: undefined,
			via: "cli",
		});
		const r = await resolveDevEnv({
			mfwHome,
			project: "p",
			root,
			config: undefined,
			rev: "main",
			build: true,
			seams: {
				run: async () => ({
					ok: false,
					code: "failed",
					reason: "the direnv step exited 1",
					fix: "read the log",
					log: "error: boom",
					egress: null,
				}),
			} as never,
		});
		expect(r.kind === "refused" && r.code).toBe("env_build_failed");
		expect(r.kind === "refused" && r.log).toBe("error: boom");
	});
});
