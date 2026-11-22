import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import {
	assertContained,
	BASE_WRITABLE,
	checkControlReport,
	encodeOptions,
	type GuardSpec,
	type LaunchShape,
} from "./compile-bwrap-guard.ts";

const ROOT = "/fixture/root";
const HOME = homedir();

const spec: GuardSpec = {
	root: ROOT,
	bwrap: "/b/bwrap",
	env: "/e/env",
	homes: [HOME],
	hidden: [ROOT],
	hostNs: { mnt: "mnt:[1]", user: "user:[2]", net: "net:[3]", pid: "pid:[4]" },
	writable: [...BASE_WRITABLE, "/scratch", "/work"],
};

const options = (extra: string[] = []): string[] => [
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
	"--remount-ro",
	"/",
	"--bind",
	`${ROOT}/work`,
	"/work",
	"--setenv",
	"HOME",
	"/sandbox/agent",
	"--chdir",
	"/work",
	...extra,
];

const argv = (opts: string[], command = ["sh", "-c", "true"]): LaunchShape => ({
	argv: [
		"/s/systemd-run",
		"--user",
		"--",
		"/e/env",
		"-i",
		"/b/bwrap",
		"--args",
		"4",
		"--",
		...command,
	],
	bwrapArgs: encodeOptions(opts),
});

describe("assertContained", () => {
	test("accepts the compiled shape and strips the scope", () => {
		const out = assertContained(argv(options()), spec);
		expect(out[0]).toBe("/e/env");
		expect(out.slice(-3)).toEqual(["sh", "-c", "true"]);
	});

	test("a command or env value that looks like an option is data", () => {
		assertContained(
			argv(options(["--setenv", "X", "--bind"]), ["echo", "--bind", "/", "/"]),
			spec,
		);
	});

	test.each([
		["--bind-try of the home", ["--bind-try", HOME, HOME]],
		["--bind-try inside the fixture", ["--bind-try", `${ROOT}/a`, "/work"]],
		["--dev-bind", ["--dev-bind", "/", "/"]],
		["--dev-bind-try", ["--dev-bind-try", "/", "/"]],
		["--bind-fd", ["--bind-fd", "7", "/x"]],
		["--ro-bind-fd", ["--ro-bind-fd", "7", "/x"]],
		["--overlay-src", ["--overlay-src", "/a"]],
		["--overlay", ["--overlay", "/u", "/w", "/m"]],
		["--tmp-overlay", ["--tmp-overlay", "/m"]],
		["--ro-overlay", ["--ro-overlay", "/m"]],
		["--file", ["--file", "5", "/x"]],
		["--bind-data", ["--bind-data", "5", "/x"]],
		["--symlink", ["--symlink", HOME, "/x"]],
		["--share-net", ["--share-net"]],
		["an unknown option", ["--future-option"]],
		["a tmpfs outside the set", ["--tmpfs", "/elsewhere"]],
		["a writable bind of the home", ["--bind", HOME, "/work"]],
		["a writable bind of /", ["--bind", "/", "/work"]],
		["the fixture root itself", ["--bind", ROOT, "/work"]],
		["a sibling of the fixture", ["--bind", `${ROOT}-2/x`, "/work"]],
		["a traversal out of the fixture", ["--bind", `${ROOT}/../x`, "/work"]],
		["a writable bind onto /etc", ["--bind", `${ROOT}/x`, "/etc"]],
		["a read-only bind of /", ["--ro-bind", "/", "/"]],
		["a read-only bind of the home", ["--ro-bind", HOME, "/h"]],
		["a read-only bind inside the home", ["--ro-bind", `${HOME}/.ssh`, "/h"]],
		["remounting another path", ["--remount-ro", "/work"]],
		["another seccomp fd", ["--seccomp", "9"]],
		["keeping a capability", ["--cap-add", "ALL"]],
	])("refuses %s", (_name, extra) => {
		expect(() => assertContained(argv(options(extra)), spec)).toThrow(
			"refusing to launch",
		);
	});

	test.each([
		"--unshare-all",
		"--unshare-user",
		"--disable-userns",
		"--die-with-parent",
		"--new-session",
	])("refuses an argv without %s", (flag) => {
		const without = options().filter((o) => o !== flag);
		expect(() => assertContained(argv(without), spec)).toThrow(
			"refusing to launch",
		);
	});

	test("refuses a bwrap option placed in argv", () => {
		const shape = argv(options());
		shape.argv.splice(6, 0, "--bind", HOME, "/work");
		expect(() => assertContained(shape, spec)).toThrow("refusing to launch");
	});

	test("refuses options on another fd", () => {
		const shape = argv(options());
		shape.argv[7] = "9";
		expect(() => assertContained(shape, spec)).toThrow("refusing to launch");
	});

	test("refuses an unterminated options stream", () => {
		const shape = argv(options());
		shape.bwrapArgs = shape.bwrapArgs.subarray(0, -1);
		expect(() => assertContained(shape, spec)).toThrow("refusing to launch");
	});

	test("refuses a separator inside the options stream", () => {
		expect(() => assertContained(argv(options(["--"])), spec)).toThrow(
			"refusing to launch",
		);
	});

	test("refuses a writable bind made before the root is read-only", () => {
		const o = options();
		const at = o.indexOf("--remount-ro");
		const moved = [
			...o.slice(0, at),
			"--bind",
			`${ROOT}/work`,
			"/work",
			...o.slice(at, at + 2),
			...o.slice(at + 5),
		];
		expect(() => assertContained(argv(moved), spec)).toThrow(
			"refusing to launch",
		);
	});

	test("refuses when the fixture is the home or contains it", () => {
		for (const root of [HOME, "/"]) {
			expect(() => assertContained(argv(options()), { ...spec, root })).toThrow(
				"refusing to launch",
			);
		}
	});
});

const mount = (point: string, access: "rw" | "ro") =>
	`1 2 0:1 / ${point} ${access},nosuid - tmpfs tmpfs ${access}`;

const report = (
	over: {
		ns?: Record<string, string>;
		present?: string[];
		mounts?: string[];
	} = {},
) => {
	const ns = over.ns ?? {
		mnt: "mnt:[11]",
		user: "user:[12]",
		net: "net:[13]",
		pid: "pid:[14]",
	};
	return [
		...Object.entries(ns).map(([k, v]) => `NS ${k} ${v}`),
		...(over.present ?? []).map((p) => `PRESENT ${p}`),
		"MOUNTINFO",
		mount("/", "ro"),
		...spec.writable.map((p) => mount(p, "rw")),
		mount("/nix/store", "ro"),
		...(over.mounts ?? []),
		"",
	].join("\n");
};

describe("checkControlReport", () => {
	test("passes the exact expected sandbox", () => {
		expect(checkControlReport(report(), spec)).toEqual([]);
	});

	test.each([
		["an extra writable mount", { mounts: [mount("/stand-in", "rw")] }],
		["a writable real home", { mounts: [mount(HOME, "rw")] }],
		["a read-only real home", { mounts: [mount(HOME, "ro")] }],
		["a mount inside the real home", { mounts: [mount(`${HOME}/x`, "ro")] }],
		["a visible real home", { present: [HOME] }],
		["a writable root", { mounts: [mount("/", "rw")] }],
		[
			"the host mount namespace",
			{
				ns: {
					mnt: "mnt:[1]",
					user: "user:[12]",
					net: "net:[13]",
					pid: "pid:[14]",
				},
			},
		],
		[
			"the host network",
			{
				ns: {
					mnt: "mnt:[11]",
					user: "user:[12]",
					net: "net:[3]",
					pid: "pid:[14]",
				},
			},
		],
		[
			"a missing namespace",
			{ ns: { mnt: "mnt:[11]", user: "user:[12]", net: "net:[13]" } },
		],
	])("fails on %s", (_name, over) => {
		expect(checkControlReport(report(over), spec).length).toBeGreaterThan(0);
	});

	test("fails when an expected writable mount is missing", () => {
		const text = report().replace(`${mount("/work", "rw")}\n`, "");
		expect(checkControlReport(text, spec).join()).toContain("/work");
	});

	test("fails on an empty or truncated report", () => {
		expect(checkControlReport("", spec).length).toBeGreaterThan(0);
		expect(
			checkControlReport(report().split("MOUNTINFO")[0] as string, spec).length,
		).toBeGreaterThan(0);
	});

	test("decodes an escaped mount point before comparing", () => {
		const problems = checkControlReport(
			report({ mounts: [mount(`${HOME}/a\\040b`, "rw")] }),
			spec,
		);
		expect(problems.join()).toContain(`${HOME}/a b`);
	});
});
