import { describe, expect, test } from "bun:test";
import {
	effectiveLimits,
	isAllowedEnvName,
	MINIMAL_LIMITS,
	memoryBytes,
	narrowProfile,
	PROFILE_ROLES,
	ProfileRejectedError,
	parseSandboxProfile,
	type SandboxProfile,
} from "../src/containment/profile.ts";

const base = (): SandboxProfile =>
	parseSandboxProfile({
		version: 1,
		role: "task",
		filesystem: {
			workspace: { source: "/r/work", gitDir: "/r/git", access: "rw" },
			scratch: "tmpfs",
			caches: [
				{ name: "cargo", source: "/r/cargo", access: "rw" },
				{ name: "npm", source: "/r/npm", access: "rw" },
			],
			fleetConfig: {
				cli: "codex",
				source: "/r/fleet",
				writable: ["sessions", "cache"],
			},
		},
		process: { env: { CI: "1", NO_COLOR: "2" } },
		network: { mode: "proxy", socketDir: "/r/egress" },
		resources: { tasksMax: 1000, memoryMax: "4G" },
	});

const rejects = (input: unknown) =>
	expect(() => parseSandboxProfile(input)).toThrow(ProfileRejectedError);

const minimal = { version: 1, role: "task" };

describe("schema", () => {
	test("a minimal profile grants nothing", () => {
		const p = parseSandboxProfile(minimal);
		expect(p.filesystem).toBeUndefined();
		expect(p.network).toBeUndefined();
		expect(effectiveLimits(p)).toEqual({ ...MINIMAL_LIMITS });
	});

	test("rejects another version and an unknown role", () => {
		rejects({ version: 2, role: "task" });
		rejects({ role: "task" });
		rejects({ version: 1, role: "root" });
	});

	test.each([
		["top level", { ...minimal, extra: true }],
		["filesystem", { ...minimal, filesystem: { hostRoot: "/" } }],
		[
			"workspace",
			{
				...minimal,
				filesystem: {
					workspace: { source: "/a", access: "rw", target: "/etc" },
				},
			},
		],
		["process", { ...minimal, process: { privileged: true } }],
		["network", { ...minimal, network: { mode: "none", hosts: ["x"] } }],
		[
			"resources",
			{
				...minimal,
				resources: { tasksMax: 1, memoryMax: "1G", cpu: 1 },
			},
		],
		["lifecycle", { ...minimal, lifecycle: { detach: true } }],
	])("rejects an unknown key in %s", (_name, input) => rejects(input));

	test.each([
		["seccomp off", { process: { seccomp: "off" } }],
		["userns allowed", { process: { userns: "allowed" } }],
		["a terminal", { process: { terminal: "pty" } }],
		["host network", { network: { mode: "host" } }],
		["no die-with-parent", { lifecycle: { dieWithParent: false } }],
		["no new session", { lifecycle: { newSession: false } }],
		["a real home", { home: "/users/someone" }],
		["a disk scratch", { filesystem: { scratch: "/var/tmp" } }],
	])("rejects the unenforceable %s", (_name, section) =>
		rejects({ ...minimal, ...section }));

	test.each([
		"relative/path",
		"/",
		"/a/../b",
		"/a/./b",
		"/a//b",
		"/a/",
		"/a\nb",
		"/a\0b",
	])("rejects the source path %j", (source) =>
		rejects({
			...minimal,
			filesystem: { workspace: { source, access: "rw" } },
		}));

	test.each([
		"../up",
		"a/../b",
		"/abs",
		"",
		"a//b",
		"-flag",
		"a/-b",
	])("rejects the fleet directory %j", (dir) =>
		rejects({
			...minimal,
			filesystem: {
				fleetConfig: { cli: "codex", source: "/f", writable: [dir] },
			},
		}));

	test.each([
		"PATH",
		"HOME",
		"LD_PRELOAD",
		"ld_preload",
		"GIT_DIR",
		"GIT_SSH_COMMAND",
		"XDG_CONFIG_HOME",
		"NODE_OPTIONS",
		"BASH_ENV",
		"https_proxy",
		"HTTPS_PROXY",
		"all_proxy",
		"NO_PROXY",
		"no_proxy",
		"NODE_USE_ENV_PROXY",
		"CLAUDE_CONFIG_DIR",
		"CODEX_HOME",
		"MFW_HOME",
		"BAD-NAME",
		"A=B",
	])("rejects the env name %s", (name) =>
		rejects({ ...minimal, process: { env: { [name]: "x" } } }));

	test.each([
		"GCONV_PATH",
		"LOCPATH",
		"GLIBC_TUNABLES",
		"JAVA_TOOL_OPTIONS",
		"ZDOTDIR",
		"SHELLOPTS",
		"BASHOPTS",
		"NLSPATH",
		"HOSTALIASES",
		"RES_OPTIONS",
		"ANTHROPIC_BASE_URL",
		"SOME_NEW_LOADER_HOOK",
	])("rejects %s, which is not on the allowlist", (name) =>
		rejects({ ...minimal, process: { env: { [name]: "x" } } }));

	test.each([
		"CI",
		"NO_COLOR",
		"FORCE_COLOR",
		"RUST_BACKTRACE",
		"ANTHROPIC_API_KEY",
		"OPENAI_API_KEY",
		"OPENROUTER_API_KEY",
		"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
		"DISABLE_TELEMETRY",
		"DISABLE_ERROR_REPORTING",
		"DISABLE_AUTOUPDATER",
		"DO_NOT_TRACK",
		"ENABLE_CLAUDEAI_MCP_SERVERS",
		"MFW_GRANT_STRIPE_KEY",
	])("allows %s", (name) => {
		expect(
			parseSandboxProfile({ ...minimal, process: { env: { [name]: "x" } } })
				.process?.env,
		).toEqual({ [name]: "x" });
	});

	test.each([
		"MFW_GRANT_",
		"MFW_GRANT_lower",
		"mfw_grant_X",
		"MFW_HOME",
	])("rejects the malformed grant name %s", (name) =>
		rejects({ ...minimal, process: { env: { [name]: "x" } } }));

	test("rejects NUL in an env value and allows a plain variable", () => {
		rejects({ ...minimal, process: { env: { CI: "a\0b" } } });
		expect(
			parseSandboxProfile({ ...minimal, process: { env: { CI: "bar" } } })
				.process?.env,
		).toEqual({ CI: "bar" });
		expect(isAllowedEnvName("CI")).toBe(true);
		expect(isAllowedEnvName("FOO")).toBe(false);
	});

	test.each([
		"1",
		"0G",
		"1g",
		"1.5G",
		"-1G",
		"infinity",
	])("rejects the memory limit %s", (memoryMax) =>
		rejects({ ...minimal, resources: { tasksMax: 1, memoryMax } }));

	test.each([0, -1, 1.5, 2_000_000])("rejects tasksMax %d", (tasksMax) =>
		rejects({ ...minimal, resources: { tasksMax, memoryMax: "1G" } }));

	test("rejects two caches with one name", () => {
		rejects({
			...minimal,
			filesystem: {
				caches: [
					{ name: "deps", source: "/r/ro", access: "ro" },
					{ name: "deps", source: "/r/rw", access: "rw" },
				],
			},
		});
	});

	test("memoryBytes", () => {
		expect(memoryBytes("512M")).toBe(512 * 1024 ** 2);
		expect(memoryBytes("2G")).toBe(2 * 1024 ** 3);
	});
});

describe("role ceilings", () => {
	const WRITING = [
		"task",
		"repair",
		"verifier",
		"merge-verify",
		"env-build",
		"env-install",
	] as const;
	const READ_ONLY = ["reviewer", "plan", "import", "brain", "trigger"] as const;

	const roFs = {
		workspace: { source: "/r/work", gitDir: "/r/git", access: "ro" },
		scratch: "tmpfs",
		caches: [{ name: "cargo", source: "/r/cargo", access: "ro" }],
		fleetConfig: { cli: "codex", source: "/r/fleet", writable: [] },
	};
	const withRole = (role: string, filesystem: unknown = roFs) => ({
		version: 1,
		role,
		filesystem,
	});

	test("every role is classified", () => {
		expect([...WRITING, ...READ_ONLY].sort()).toEqual(
			[...PROFILE_ROLES].sort(),
		);
	});

	test.each([
		"task",
		"repair",
	] as const)("%s may hold every writable grant", (role) => {
		const p = parseSandboxProfile({ ...base(), role });
		expect(p.filesystem?.workspace?.access).toBe("rw");
		expect(p.filesystem?.fleetConfig?.writable).toEqual(["sessions", "cache"]);
	});

	// Narrowed by P7: these roles run the candidate's code.
	test.each([
		"verifier",
		"merge-verify",
	] as const)("%s may not hold a task's grants", (role) => {
		expect(() => parseSandboxProfile({ ...base(), role })).toThrow(
			ProfileRejectedError,
		);
	});

	describe.each([...READ_ONLY])("%s", (role) => {
		test("accepts a read-only profile with a tmpfs scratch", () => {
			const p = parseSandboxProfile(withRole(role));
			expect(p.filesystem?.workspace?.access).toBe("ro");
		});

		test("accepts no filesystem at all", () => {
			expect(parseSandboxProfile({ version: 1, role }).role).toBe(role);
		});

		test("rejects a writable workspace", () => {
			rejects(
				withRole(role, {
					...roFs,
					workspace: { ...roFs.workspace, access: "rw" },
				}),
			);
		});

		test("rejects a writable cache", () => {
			rejects(
				withRole(role, {
					...roFs,
					caches: [{ name: "cargo", source: "/r/cargo", access: "rw" }],
				}),
			);
		});

		test("rejects writable fleet directories", () => {
			rejects(
				withRole(role, {
					...roFs,
					fleetConfig: { ...roFs.fleetConfig, writable: ["sessions"] },
				}),
			);
		});

		test("a narrowing cannot widen it", () => {
			const p = parseSandboxProfile(withRole(role));
			for (const input of [
				{ workspaceAccess: "rw" },
				{ role: "task" },
				{ fleetWritable: ["sessions"] },
				{ readOnlyCaches: ["other"] },
			]) {
				expect(() => narrowProfile(p, input)).toThrow(ProfileRejectedError);
			}
			const narrowed = narrowProfile(p, {
				workspaceAccess: "ro",
				readOnlyCaches: ["cargo"],
				fleetWritable: [],
			});
			expect(narrowed.role).toBe(role);
			expect(narrowed.filesystem?.workspace?.access).toBe("ro");
			expect(narrowed.filesystem?.fleetConfig?.writable).toEqual([]);
		});

		test("a cast cannot carry a writable grant past a re-parse", () => {
			const p = parseSandboxProfile(withRole(role));
			const forged = structuredClone(p) as SandboxProfile;
			(forged.filesystem?.workspace as { access: string }).access = "rw";
			expect(() => narrowProfile(forged, {})).toThrow(ProfileRejectedError);
		});
	});

	test("the brain keeps its egress while read-only", () => {
		const p = parseSandboxProfile({
			...withRole("brain"),
			network: { mode: "proxy", socketDir: "/r/egress" },
		});
		expect(p.network?.mode).toBe("proxy");
	});

	test("a writing role narrowed to read-only stays valid", () => {
		const n = narrowProfile(base(), {
			workspaceAccess: "ro",
			readOnlyCaches: ["cargo", "npm"],
			fleetWritable: [],
		});
		expect(parseSandboxProfile({ ...n, role: "reviewer" }).role).toBe(
			"reviewer",
		);
	});
});

describe("narrowProfile", () => {
	test("empty config changes nothing and the base is not mutated", () => {
		const b = base();
		const before = structuredClone(b);
		expect(narrowProfile(b, {})).toEqual(before);
		narrowProfile(b, { workspaceAccess: "ro", network: "none" });
		expect(b).toEqual(before);
	});

	test("removes access", () => {
		const n = narrowProfile(base(), {
			workspaceAccess: "ro",
			dropScratch: true,
			keepCaches: ["npm"],
			readOnlyCaches: ["npm"],
			fleetWritable: ["sessions"],
			deny: ["/r/secret"],
			network: "none",
			resources: { tasksMax: 10, memoryMax: "512M" },
			dropEnv: ["NO_COLOR"],
		});
		expect(n.filesystem?.workspace?.access).toBe("ro");
		expect(n.filesystem?.scratch).toBeUndefined();
		expect(n.filesystem?.caches).toEqual([
			{ name: "npm", source: "/r/npm", access: "ro" },
		]);
		expect(n.filesystem?.fleetConfig?.writable).toEqual(["sessions"]);
		expect(n.filesystem?.deny).toEqual(["/r/secret"]);
		expect(n.network).toEqual({ mode: "none" });
		expect(n.resources).toEqual({ tasksMax: 10, memoryMax: "512M" });
		expect(n.process?.env).toEqual({ CI: "1" });
	});

	test.each([
		["workspace back to rw", { workspaceAccess: "rw" }],
		["network on", { network: "proxy" }],
		["a new cache", { keepCaches: ["other"] }],
		["a new read-only cache", { readOnlyCaches: ["other"] }],
		["a new fleet directory", { fleetWritable: ["config"] }],
		["more tasks", { resources: { tasksMax: 1001 } }],
		["more memory", { resources: { memoryMax: "5G" } }],
		["more memory in other units", { resources: { memoryMax: "4097M" } }],
		["adding env", { env: { X: "1" } }],
		["a new workspace", { workspace: { source: "/x", access: "rw" } }],
		["an unknown key", { widen: true }],
		["keeping scratch explicitly", { dropScratch: false }],
	])("rejects %s", (_name, input) => {
		expect(() => narrowProfile(base(), input)).toThrow(ProfileRejectedError);
	});

	test("an omitted base resources section caps at the minimum", () => {
		const p = parseSandboxProfile(minimal);
		expect(() =>
			narrowProfile(p, {
				resources: { tasksMax: MINIMAL_LIMITS.tasksMax + 1 },
			}),
		).toThrow(ProfileRejectedError);
		expect(narrowProfile(p, { resources: { tasksMax: 8 } }).resources).toEqual({
			tasksMax: 8,
			memoryMax: MINIMAL_LIMITS.memoryMax,
		});
	});

	test("never grants a network to a profile without one", () => {
		const p = parseSandboxProfile(minimal);
		expect(narrowProfile(p, {}).network).toBeUndefined();
		expect(narrowProfile(p, { network: "none" }).network).toEqual({
			mode: "none",
		});
	});

	test("deny entries accumulate", () => {
		const once = narrowProfile(base(), { deny: ["/a"] });
		expect(
			narrowProfile(once, { deny: ["/b", "/a"] }).filesystem?.deny,
		).toEqual(["/a", "/b"]);
	});
});
