import { describe, expect, test } from "bun:test";
import {
	BWRAP_ARGS_FD,
	type CompiledSandbox,
	type CompileHost,
	compileBwrap,
	joinUnder,
	SANDBOX_PATHS,
} from "../src/containment/compile-bwrap.ts";
import type { Check } from "../src/containment/host-caps.ts";
import {
	parseSandboxProfile,
	type SandboxProfile,
} from "../src/containment/profile.ts";
import {
	decodeProgram,
	generateSeccompProgram,
} from "../src/containment/seccomp.ts";
import type { ToolchainPlan } from "../src/containment/toolchain.ts";

const pass = <T>(value: T): Check<T> => ({
	ok: true,
	severity: "required",
	value,
	detail: "ok",
});

const toolchain: ToolchainPlan = {
	binds: [
		{ path: "/nix/store", source: "nix", reason: "git", optional: false },
		{ path: "/etc/ssl", source: "etc", reason: "etc set", optional: true },
	],
	resolved: [
		{
			name: "git",
			path: "/nix/store/g/bin/git",
			realPath: "/nix/store/g/bin/git",
		},
	],
	unresolved: [{ name: "missing", reason: "not found on PATH" }],
	pathDirs: ["/nix/store/g/bin"],
};

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
		toolchain,
		home: "/users/owner",
		mfwHome: "/users/owner/.local/share/mfw",
		allowedRoots: ["/users/owner/.local/share/mfw/runs/r1"],
		realpath: (p) => p,
		...over,
	};
}

const R = "/users/owner/.local/share/mfw/runs/r1";

const full = (): SandboxProfile =>
	parseSandboxProfile({
		version: 1,
		role: "task",
		filesystem: {
			workspace: { source: `${R}/work`, gitDir: `${R}/git`, access: "rw" },
			scratch: "tmpfs",
			caches: [{ name: "cargo", source: `${R}/cargo`, access: "ro" }],
			toolchain: { binaries: ["git"] },
			fleetConfig: {
				cli: "codex",
				source: `${R}/fleet`,
				writable: ["sessions", "cache"],
			},
		},
		process: { env: { CI: "bar" } },
		network: { mode: "proxy", socketDir: `${R}/egress` },
		resources: { tasksMax: 512, memoryMax: "2G" },
	});

const minimal = (): SandboxProfile =>
	parseSandboxProfile({ version: 1, role: "trigger" });

function compiled(
	profile: SandboxProfile,
	h: CompileHost = host(),
): CompiledSandbox {
	const r = compileBwrap(profile, ["agent", "--flag"], h);
	if (!r.ok) throw new Error(r.reason);
	return { ...r, argv: expand(r) };
}

/** The argv as bwrap sees it, with `--args 4` replaced by the option stream. */
function expand(r: CompiledSandbox): string[] {
	const at = r.argv.indexOf("--args");
	expect(r.argv[at + 1]).toBe(String(BWRAP_ARGS_FD));
	expect(r.bwrapArgs.at(-1)).toBe(0);
	const options = r.bwrapArgs.toString().slice(0, -1).split("\0");
	return [...r.argv.slice(0, at), ...options, ...r.argv.slice(at + 2)];
}

function refusal(profile: SandboxProfile, h: CompileHost = host()) {
	const r = compileBwrap(profile, ["agent"], h);
	if (r.ok) throw new Error("expected a refusal");
	expect(r.fix.length).toBeGreaterThan(0);
	return r;
}

const withFs = (fs: NonNullable<SandboxProfile["filesystem"]>) =>
	parseSandboxProfile({ version: 1, role: "task", filesystem: fs });

const BASE_ENV = [
	"--setenv",
	"GIT_CONFIG_GLOBAL",
	"/dev/null",
	"--setenv",
	"GIT_CONFIG_NOSYSTEM",
	"1",
	"--setenv",
	"HOME",
	"/sandbox/agent",
	"--setenv",
	"LANG",
	"C.UTF-8",
	"--setenv",
	"LOGNAME",
	"agent",
	"--setenv",
	"PATH",
	"/nonexistent",
	"--setenv",
	"TERM",
	"dumb",
	"--setenv",
	"TMPDIR",
	"/tmp",
	"--setenv",
	"USER",
	"agent",
	"--setenv",
	"XDG_CACHE_HOME",
	"/sandbox/agent/.cache",
	"--setenv",
	"XDG_CONFIG_HOME",
	"/sandbox/agent/.config",
	"--setenv",
	"XDG_DATA_HOME",
	"/sandbox/agent/.local/share",
	"--setenv",
	"XDG_STATE_HOME",
	"/sandbox/agent/.local/state",
];

describe("argv snapshots", () => {
	test("a minimal profile: no binds, no network, smallest limits", () => {
		expect(compiled(minimal()).argv).toEqual([
			"/bin/systemd-run",
			"--user",
			"--scope",
			"--quiet",
			"-p",
			"TasksMax=256",
			"-p",
			"MemoryMax=1G",
			"-p",
			"MemorySwapMax=0",
			"--",
			"/bin/env",
			"-i",
			"/bin/bwrap",
			"--unshare-all",
			"--unshare-user",
			"--disable-userns",
			"--die-with-parent",
			"--new-session",
			"--cap-drop",
			"ALL",
			"--seccomp",
			"3",
			"--proc",
			"/proc",
			"--dev",
			"/dev",
			"--tmpfs",
			"/tmp",
			"--tmpfs",
			"/run",
			"--tmpfs",
			"/run/user",
			"--perms",
			"0700",
			"--tmpfs",
			"/sandbox/agent",
			"--remount-ro",
			"/",
			"--remount-ro",
			"/run",
			...BASE_ENV,
			"--chdir",
			"/sandbox/agent",
			"--",
			"agent",
			"--flag",
		]);
	});

	test("a full profile", () => {
		const r = compiled(full(), host({ unit: "mfw-run-r1" }));
		const setenvAt = r.argv.indexOf("--setenv");
		expect(r.argv.slice(0, setenvAt)).toEqual([
			"/bin/systemd-run",
			"--user",
			"--scope",
			"--quiet",
			"--unit=mfw-run-r1",
			"-p",
			"TasksMax=512",
			"-p",
			"MemoryMax=2G",
			"-p",
			"MemorySwapMax=0",
			"--",
			"/bin/env",
			"-i",
			"/bin/bwrap",
			"--unshare-all",
			"--unshare-user",
			"--disable-userns",
			"--die-with-parent",
			"--new-session",
			"--cap-drop",
			"ALL",
			"--seccomp",
			"3",
			"--proc",
			"/proc",
			"--dev",
			"/dev",
			"--tmpfs",
			"/tmp",
			"--tmpfs",
			"/run",
			"--tmpfs",
			"/run/user",
			"--perms",
			"0700",
			"--tmpfs",
			"/sandbox/agent",
			"--ro-bind",
			"/nix/store",
			"/nix/store",
			"--ro-bind-try",
			"/etc/ssl",
			"/etc/ssl",
			"--tmpfs",
			"/scratch",
			"--dir",
			"/work",
			"--dir",
			"/git",
			"--dir",
			"/cache/cargo",
			"--dir",
			"/fleet/codex",
			"--dir",
			"/run/mfw/egress",
			"--remount-ro",
			"/",
			"--bind",
			`${R}/work`,
			"/work",
			"--bind",
			`${R}/git`,
			"/git",
			"--ro-bind",
			`${R}/cargo`,
			"/cache/cargo",
			"--ro-bind",
			`${R}/fleet`,
			"/fleet/codex",
			"--bind",
			`${R}/fleet/cache`,
			"/fleet/codex/cache",
			"--bind",
			`${R}/fleet/sessions`,
			"/fleet/codex/sessions",
			"--ro-bind",
			`${R}/egress`,
			"/run/mfw/egress",
			"--remount-ro",
			"/run",
		]);
		expect(r.argv.slice(-5)).toEqual([
			"--chdir",
			"/work",
			"--",
			"agent",
			"--flag",
		]);
		expect(r.cwd).toBe("/work");
	});

	test("the sandbox env is complete and carries no host value", () => {
		const { env } = compiled(full());
		expect(env.HOME).toBe(SANDBOX_PATHS.home);
		expect(env.PATH).toBe("/nix/store/g/bin");
		expect(env.GIT_DIR).toBe("/git");
		expect(env.GIT_WORK_TREE).toBe("/work");
		expect(env.CODEX_HOME).toBe("/fleet/codex");
		expect(env.CI).toBe("bar");
		expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:3128");
		expect(env.https_proxy).toBe("http://127.0.0.1:3128");
		expect(env.NO_PROXY).toBe("");
		expect(env.NODE_USE_ENV_PROXY).toBe("1");
		expect(JSON.stringify(env)).not.toContain("/users/owner");
	});

	test("the claude fleet dir sets its own variable", () => {
		const { env } = compiled(
			withFs({
				fleetConfig: { cli: "claude", source: `${R}/fleet`, writable: [] },
			}),
		);
		expect(env.CLAUDE_CONFIG_DIR).toBe("/fleet/claude");
		expect(env.CODEX_HOME).toBeUndefined();
	});

	test("no proxy env without a proxy network", () => {
		const { env, argv } = compiled(minimal());
		expect(env.HTTPS_PROXY).toBeUndefined();
		expect(argv).not.toContain("--share-net");
	});

	test("a read-only workspace has no writable bind", () => {
		const { argv } = compiled(
			withFs({ workspace: { source: `${R}/work`, access: "ro" } }),
		);
		expect(argv).not.toContain("--bind");
		expect(argv).toContain("--ro-bind");
	});

	test("/run is remounted read-only after the egress bind", () => {
		const { argv } = compiled(full());
		const egress = argv.indexOf(
			"/run/mfw/egress",
			argv.indexOf("--remount-ro"),
		);
		const remount = argv.findIndex(
			(a, i) => a === "--remount-ro" && argv[i + 1] === "/run",
		);
		expect(egress).toBeGreaterThan(0);
		expect(remount).toBeGreaterThan(egress);
		expect(argv.indexOf("/run/user")).toBeLessThan(remount);
	});

	test("every writable bind comes after the root is remounted read-only", () => {
		const { argv } = compiled(full());
		const remount = argv.indexOf("--remount-ro");
		expect(argv.indexOf("--bind")).toBeGreaterThan(remount);
	});

	test("no env value reaches the process argv", () => {
		const secret = "canary-token-value";
		const profile = parseSandboxProfile({
			version: 1,
			role: "task",
			process: { env: { OPENAI_API_KEY: secret } },
		});
		const r = compileBwrap(profile, ["agent"], host());
		if (!r.ok) throw new Error(r.reason);
		expect(r.env.OPENAI_API_KEY).toBe(secret);
		expect(r.argv.join("\0")).not.toContain(secret);
		expect(r.argv.join("\0")).not.toContain("--setenv");
		expect(r.bwrapArgs.toString()).toContain(`OPENAI_API_KEY\0${secret}\0`);
	});

	test("the raw argv carries only --args before the command", () => {
		const r = compileBwrap(full(), ["agent", "--flag"], host());
		if (!r.ok) throw new Error(r.reason);
		const at = r.argv.indexOf("/bin/env");
		expect(r.argv.slice(at)).toEqual([
			"/bin/env",
			"-i",
			"/bin/bwrap",
			"--args",
			"4",
			"--",
			"agent",
			"--flag",
		]);
	});

	test("a NUL in a host-derived path cannot inject an option", () => {
		const plan: ToolchainPlan = {
			...toolchain,
			binds: [
				{
					path: "/nix/store\0--bind\0/\0/",
					source: "nix",
					reason: "git",
					optional: false,
				},
			],
		};
		const r = compileBwrap(
			withFs({ toolchain: { binaries: ["git"] } }),
			["agent"],
			host({ toolchain: plan }),
		);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("invalid_host");
	});

	test("a command that looks like a flag stays after the separator", () => {
		const r = compileBwrap(minimal(), ["--bind", "/", "/"], host());
		if (!r.ok) throw new Error(r.reason);
		const all = expand(r);
		const sep = all.lastIndexOf("--");
		expect(all.slice(sep + 1)).toEqual(["--bind", "/", "/"]);
		expect(all.slice(0, sep)).not.toContain("--bind");
	});

	test("hands over the real seccomp program", () => {
		const { seccomp } = compiled(minimal());
		expect(seccomp.equals(generateSeccompProgram("x64"))).toBe(true);
		expect(decodeProgram(seccomp).length).toBeGreaterThan(10);
	});
});

describe("a profile that skipped the schema", () => {
	const raw = (over: Record<string, unknown>) =>
		({ version: 1, role: "task", ...over }) as unknown as SandboxProfile;

	test.each([
		[
			"a fleet path that climbs out to the home",
			raw({
				filesystem: {
					fleetConfig: {
						cli: "codex",
						source: `${R}/fleet`,
						writable: ["../../../../../../.ssh"],
					},
				},
			}),
		],
		["a loader variable", raw({ process: { env: { LD_PRELOAD: "/x.so" } } })],
		[
			"a cache name that climbs out of /cache",
			raw({
				filesystem: {
					caches: [{ name: "../../etc", source: `${R}/c`, access: "rw" }],
				},
			}),
		],
		["an unknown key", raw({ hostRoot: true })],
		["another version", raw({ version: 2 })],
	])("refuses %s", (_name, profile) => {
		const r = compileBwrap(profile, ["agent"], host());
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("invalid_profile");
	});

	test("a joined fleet path must stay under its source", () => {
		expect(joinUnder("/f/src", "sessions/a")).toBe("/f/src/sessions/a");
		expect(joinUnder("/f/src", "../other")).toBeNull();
		expect(joinUnder("/f/src", "a/../../other")).toBeNull();
		expect(joinUnder("/f/src", "../src2")).toBeNull();
		expect(joinUnder("/f/src", ".")).toBeNull();
	});
});

describe("refusals", () => {
	test.each([
		"userns",
		"bwrap",
		"systemd",
		"arch",
	] as const)("a failed %s capability refuses with its fix", (cap) => {
		const h = host();
		(h.caps[cap] as Check<unknown>) = {
			...h.caps[cap],
			ok: false,
			detail: `${cap} broken`,
			fix: `fix ${cap}`,
		};
		const r = refusal(minimal(), h);
		expect(r.code).toBe("host_unsupported");
		expect(r.fix).toBe(`fix ${cap}`);
	});

	test("aarch64 passes detection but has no filter, so it refuses", () => {
		const h = host();
		h.caps.arch = pass("aarch64");
		expect(refusal(minimal(), h).code).toBe("host_unsupported");
	});

	test.each([[[]], [[""]], [["a", "b\0c"]]])("the command %j", (command) => {
		const r = compileBwrap(minimal(), command, host());
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("invalid_command");
	});

	test.each([
		"bwrapPath",
		"envPath",
		"systemdRunPath",
		"home",
		"mfwHome",
	] as const)("a relative %s", (key) => {
		expect(refusal(minimal(), host({ [key]: "relative" })).code).toBe(
			"invalid_host",
		);
	});

	test("an invalid scope unit", () => {
		expect(refusal(minimal(), host({ unit: "bad unit" })).code).toBe(
			"invalid_host",
		);
	});

	test("a source outside the allowed roots", () => {
		expect(
			refusal(withFs({ workspace: { source: "/srv/repo", access: "rw" } }))
				.code,
		).toBe("path_outside_roots");
	});

	test("the allowed root itself is not a valid source", () => {
		expect(
			refusal(withFs({ workspace: { source: R, access: "rw" } })).code,
		).toBe("path_outside_roots");
	});

	test("a sibling that shares the root's prefix is outside it", () => {
		expect(
			refusal(withFs({ workspace: { source: `${R}2/work`, access: "rw" } }))
				.code,
		).toBe("path_outside_roots");
	});

	test.each([
		"/users/owner",
		"/users",
		"/users/owner/.local/share/mfw",
	])("binding the protected %s", (source) => {
		const h = host({ allowedRoots: ["/"] as never });
		h.realpath = (p) => p;
		expect(
			refusal(withFs({ workspace: { source, access: "ro" } }), h).code,
		).toBe("path_denied");
	});

	test("an allowed root that contains HOME", () => {
		expect(refusal(minimal(), host({ allowedRoots: ["/users"] })).code).toBe(
			"path_denied",
		);
	});

	test("an allowed root that contains the resolved HOME", () => {
		const h = host({
			allowedRoots: ["/data"],
			realpath: (p) => (p === "/users/owner" ? "/data/owner" : p),
		});
		expect(refusal(minimal(), h).code).toBe("path_denied");
	});

	test("an allowed root that is a symlink", () => {
		const h = host({
			realpath: (p) => (p === R ? "/elsewhere" : p),
		});
		expect(refusal(minimal(), h).code).toBe("path_not_canonical");
	});

	test("deny wins over a bind, in both directions", () => {
		for (const deny of [`${R}/work`, `${R}/work/sub`, R]) {
			expect(
				refusal(
					withFs({
						workspace: { source: `${R}/work`, access: "ro" },
						deny: [deny],
					}),
				).code,
			).toBe("path_denied");
		}
	});

	test("a deny entry that is a symlink protects its target", () => {
		const h = host({
			realpath: (p) => (p === `${R}/link` ? `${R}/real` : p),
		});
		const r = refusal(
			withFs({
				caches: [{ name: "c", source: `${R}/real`, access: "rw" }],
				deny: [`${R}/link`],
			}),
			h,
		);
		expect(r.code).toBe("path_denied");
	});

	test("a symlinked deny entry also covers paths under its target", () => {
		const h = host({
			realpath: (p) => (p === `${R}/link` ? `${R}/real` : p),
		});
		expect(
			refusal(
				withFs({
					caches: [{ name: "c", source: `${R}/real/sub`, access: "ro" }],
					deny: [`${R}/link`],
				}),
				h,
			).code,
		).toBe("path_denied");
	});

	test("a missing deny entry resolves through its parent", () => {
		const h = host({
			realpath: (p) => {
				if (p === `${R}/link/gone`) return null;
				return p === `${R}/link` ? `${R}/real` : p;
			},
		});
		expect(
			refusal(
				withFs({
					caches: [{ name: "c", source: `${R}/real/gone`, access: "rw" }],
					deny: [`${R}/link/gone`],
				}),
				h,
			).code,
		).toBe("path_denied");
	});

	test("a deny entry whose parent cannot be resolved is refused", () => {
		const h = host({
			realpath: (p) => (p.startsWith("/gone") ? null : p),
		});
		const r = refusal(withFs({ deny: ["/gone/a/b"] }), h);
		expect(r.code).toBe("path_denied");
		expect(r.reason).toContain("/gone/a/b");
	});

	test("a deny entry resolving onto a toolchain bind refuses it", () => {
		const h = host({
			realpath: (p) => (p === "/opt/link" ? "/nix/store/g" : p),
		});
		expect(
			refusal(
				withFs({
					toolchain: { binaries: ["git"] },
					deny: ["/opt/link"],
				}),
				h,
			).code,
		).toBe("path_denied");
	});

	test("an unrelated missing deny entry does not refuse", () => {
		const h = host({
			realpath: (p) => (p === "/opt/absent" ? null : p),
		});
		compiled(withFs({ deny: ["/opt/absent"] }), h);
	});

	test("deny wins over a toolchain bind", () => {
		expect(
			refusal(
				withFs({
					toolchain: { binaries: ["git"] },
					deny: ["/nix/store/g"],
				}),
			).code,
		).toBe("path_denied");
	});

	test("a missing source", () => {
		const h = host({
			realpath: (p) => (p === `${R}/work` ? null : p),
		});
		expect(
			refusal(withFs({ workspace: { source: `${R}/work`, access: "rw" } }), h)
				.code,
		).toBe("path_not_canonical");
	});

	test("a source that is a symlink", () => {
		const h = host({
			realpath: (p) => (p === `${R}/work` ? "/users/owner/.ssh" : p),
		});
		expect(
			refusal(withFs({ workspace: { source: `${R}/work`, access: "rw" } }), h)
				.code,
		).toBe("path_not_canonical");
	});

	test("a writable fleet directory that is a symlink", () => {
		const h = host({
			realpath: (p) => (p === `${R}/fleet/sessions` ? "/users/owner/.ssh" : p),
		});
		expect(
			refusal(
				withFs({
					fleetConfig: {
						cli: "codex",
						source: `${R}/fleet`,
						writable: ["sessions"],
					},
				}),
				h,
			).code,
		).toBe("path_not_canonical");
	});

	test("a writable alias of a read-only tree", () => {
		expect(
			refusal(
				withFs({
					workspace: { source: `${R}/work`, access: "ro" },
					caches: [{ name: "c", source: `${R}/work/cache`, access: "rw" }],
				}),
			).code,
		).toBe("bind_overlap");
	});

	test("a git dir inside a writable work tree", () => {
		expect(
			refusal(
				withFs({
					workspace: {
						source: `${R}/work`,
						gitDir: `${R}/work/.git`,
						access: "rw",
					},
				}),
			).code,
		).toBe("bind_overlap");
	});

	test("the egress socket dir inside a writable workspace", () => {
		const p = parseSandboxProfile({
			version: 1,
			role: "task",
			filesystem: { workspace: { source: `${R}/work`, access: "rw" } },
			network: { mode: "proxy", socketDir: `${R}/work/egress` },
		});
		expect(refusal(p).code).toBe("bind_overlap");
	});

	test("two read-only binds may overlap", () => {
		compiled(
			withFs({
				workspace: { source: `${R}/work`, access: "ro" },
				caches: [{ name: "c", source: `${R}/work/cache`, access: "ro" }],
			}),
		);
	});

	test("a declared binary that did not resolve", () => {
		const r = refusal(withFs({ toolchain: { binaries: ["git", "missing"] } }));
		expect(r.code).toBe("toolchain_unresolved");
		expect(r.reason).toContain("not found on PATH");
	});

	test("a toolchain bind that contains HOME", () => {
		const plan: ToolchainPlan = {
			...toolchain,
			binds: [{ path: "/users", source: "home", reason: "x", optional: true }],
		};
		expect(
			refusal(
				withFs({ toolchain: { binaries: ["git"] } }),
				host({ toolchain: plan }),
			).code,
		).toBe("path_denied");
	});

	test("a toolchain bind inside MFW_HOME", () => {
		const plan: ToolchainPlan = {
			...toolchain,
			binds: [
				{
					path: "/users/owner/.local/share/mfw/bin",
					source: "home",
					reason: "x",
					optional: true,
				},
			],
		};
		expect(
			refusal(
				withFs({ toolchain: { binaries: ["git"] } }),
				host({ toolchain: plan }),
			).code,
		).toBe("path_denied");
	});

	test("a toolchain root inside the real home is allowed", () => {
		const plan: ToolchainPlan = {
			...toolchain,
			binds: [
				{
					path: "/users/owner/.bun",
					source: "home",
					reason: "bun",
					optional: false,
				},
			],
		};
		compiled(
			withFs({ toolchain: { binaries: ["git"] } }),
			host({ toolchain: plan }),
		);
	});

	test("an empty binary list refuses a plan that resolved binaries", () => {
		expect(refusal(withFs({ toolchain: { binaries: [] } })).code).toBe(
			"toolchain_undeclared",
		);
	});

	test("a plan with a binary the profile did not declare is refused", () => {
		const plan: ToolchainPlan = {
			...toolchain,
			resolved: [
				...toolchain.resolved,
				{
					name: "curl",
					path: "/nix/store/c/bin/curl",
					realPath: "/nix/store/c/bin/curl",
				},
			],
			pathDirs: ["/nix/store/g/bin", "/nix/store/c/bin"],
		};
		const r = refusal(
			withFs({ toolchain: { binaries: ["git"] } }),
			host({ toolchain: plan }),
		);
		expect(r.code).toBe("toolchain_undeclared");
		expect(r.reason).toContain("curl");
	});

	test("an empty binary list with an empty plan binds nothing", () => {
		const plan: ToolchainPlan = {
			binds: [
				{
					path: "/usr",
					source: "system",
					reason: "system root",
					optional: true,
				},
				{ path: "/etc/ssl", source: "etc", reason: "etc set", optional: true },
			],
			resolved: [],
			unresolved: [],
			pathDirs: [],
		};
		const { argv, env } = compiled(
			withFs({ toolchain: { binaries: [] } }),
			host({ toolchain: plan }),
		);
		expect(argv).not.toContain("/usr");
		expect(argv).not.toContain("/etc/ssl");
		expect(env.PATH).toBe("/nonexistent");
	});

	test("PATH comes from the declared binaries, not the plan's list", () => {
		const plan: ToolchainPlan = {
			...toolchain,
			pathDirs: ["/evil/bin", "/nix/store/g/bin"],
		};
		const { env } = compiled(
			withFs({ toolchain: { binaries: ["git"] } }),
			host({ toolchain: plan }),
		);
		expect(env.PATH).toBe("/nix/store/g/bin");
	});

	test("PATH follows the declared order without duplicates", () => {
		const plan: ToolchainPlan = {
			...toolchain,
			resolved: [
				{
					name: "a",
					path: "/nix/store/a/bin/a",
					realPath: "/nix/store/a/bin/a",
				},
				{
					name: "b",
					path: "/nix/store/b/bin/b",
					realPath: "/nix/store/b/bin/b",
				},
				{
					name: "c",
					path: "/nix/store/a/bin/c",
					realPath: "/nix/store/a/bin/c",
				},
			],
		};
		const { env } = compiled(
			withFs({ toolchain: { binaries: ["b", "c", "a"] } }),
			host({ toolchain: plan }),
		);
		expect(env.PATH).toBe("/nix/store/b/bin:/nix/store/a/bin");
	});

	test("a home toolchain root no declared binary needs is not bound", () => {
		const plan: ToolchainPlan = {
			...toolchain,
			binds: [
				...toolchain.binds,
				{
					path: "/users/owner/.rustup",
					source: "home",
					reason: "home toolchain root",
					optional: true,
				},
			],
		};
		const { argv } = compiled(
			withFs({ toolchain: { binaries: ["git"] } }),
			host({ toolchain: plan }),
		);
		expect(argv).toContain("/nix/store");
		expect(argv).toContain("/etc/ssl");
		expect(argv).not.toContain("/users/owner/.rustup");
	});

	test("a home toolchain root a declared binary lives in is bound", () => {
		const plan: ToolchainPlan = {
			...toolchain,
			binds: [
				{
					path: "/users/owner/.bun",
					source: "home",
					reason: "git",
					optional: false,
				},
			],
		};
		const { argv } = compiled(
			withFs({ toolchain: { binaries: ["git"] } }),
			host({ toolchain: plan }),
		);
		expect(argv).toContain("/users/owner/.bun");
	});

	test("without a toolchain section nothing from the plan is bound", () => {
		const { argv, env } = compiled(minimal());
		expect(argv).not.toContain("/nix/store");
		expect(env.PATH).toBe("/nonexistent");
	});
});
