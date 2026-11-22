import { describe, expect, test } from "bun:test";
import {
	effectiveLimits,
	isReservedEnvName,
	MINIMAL_LIMITS,
	memoryBytes,
	narrowProfile,
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
		process: { env: { KEEP: "1", DROP: "2" } },
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

	test("rejects NUL in an env value and allows a plain variable", () => {
		rejects({ ...minimal, process: { env: { FOO: "a\0b" } } });
		expect(
			parseSandboxProfile({ ...minimal, process: { env: { FOO: "bar" } } })
				.process?.env,
		).toEqual({ FOO: "bar" });
		expect(isReservedEnvName("FOO")).toBe(false);
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
			dropEnv: ["DROP"],
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
		expect(n.process?.env).toEqual({ KEEP: "1" });
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
