import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	closeSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompiledSandbox } from "../src/containment/compile-bwrap.ts";
import {
	type LaunchRefusalCode,
	launchSandbox,
	openSandboxFds,
	SandboxLaunchError,
} from "../src/containment/launch-sandbox.ts";

/** The launcher's refusals. Each throws before anything is spawned. */

let root: string;

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "launch-sandbox-")));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

const ARGV = [
	"/nonexistent/systemd-run",
	"--user",
	"--scope",
	"--",
	"/nonexistent/env",
	"-i",
	"/nonexistent/bwrap",
	"--args",
	"4",
	"--",
	"agent",
];

const compiled = (over: Partial<CompiledSandbox> = {}): CompiledSandbox => ({
	ok: true,
	argv: ARGV,
	seccomp: Buffer.from("bpf"),
	bwrapArgs: Buffer.from("--unshare-all\0"),
	pinnedBinds: [],
	env: {},
	cwd: "/work",
	...over,
});

function refusedWith(fn: () => unknown): LaunchRefusalCode {
	try {
		fn();
	} catch (err) {
		if (err instanceof SandboxLaunchError) return err.code;
		throw err;
	}
	throw new Error("expected a refusal");
}

const openFds = () => readdirSync("/proc/self/fd").length;

describe("launchSandbox refusals", () => {
	test("a regular file on stdio", () => {
		const fd = openSync(join(root, "log"), "w");
		try {
			for (const key of ["stdin", "stdout", "stderr"]) {
				expect(
					refusedWith(() =>
						launchSandbox(compiled(), {
							approvalMode: "interactive",
							[key]: fd,
						}),
					),
				).toBe("stdio_not_pipe");
			}
		} finally {
			closeSync(fd);
		}
	});

	test("a closed descriptor on stdio", () => {
		const fd = openSync(join(root, "log"), "w");
		closeSync(fd);
		expect(
			refusedWith(() =>
				launchSandbox(compiled(), { approvalMode: "interactive", stdout: fd }),
			),
		).toBe("stdio_not_pipe");
	});

	test.each([
		["no scope", ARGV.slice(4)],
		["no env -i", ARGV.filter((a) => a !== "-i")],
		["options in argv", [...ARGV.slice(0, 7), "--bind", "/", "/", "--", "x"]],
		["another args descriptor", ARGV.map((a) => (a === "4" ? "9" : a))],
		["no command", ARGV.slice(0, -1)],
	])("an argv with %s", (_name, argv) => {
		expect(
			refusedWith(() =>
				launchSandbox(compiled({ argv }), { approvalMode: "interactive" }),
			),
		).toBe("invalid_compiled");
	});

	test("a pin off its declared descriptor", () => {
		const source = join(root, "work");
		mkdirSync(source);
		const pinnedBinds = [
			{ fd: 6, source, dest: "/work", writable: true, label: "workspace" },
		];
		expect(
			refusedWith(() =>
				launchSandbox(compiled({ pinnedBinds }), {
					approvalMode: "interactive",
				}),
			),
		).toBe("invalid_compiled");
	});

	test("a source that fails to pin leaves nothing open", () => {
		const good = join(root, "good");
		mkdirSync(good);
		const pinnedBinds = [
			{ fd: 5, source: good, dest: "/a", writable: true, label: "a" },
			{
				fd: 6,
				source: join(root, "gone"),
				dest: "/b",
				writable: true,
				label: "b",
			},
		];
		const before = openFds();
		expect(
			refusedWith(() =>
				launchSandbox(compiled({ pinnedBinds }), {
					approvalMode: "interactive",
				}),
			),
		).toBe("pin_failed");
		expect(openFds()).toBe(before);
	});

	test("an unusable temporary directory leaves nothing open", () => {
		const good = join(root, "good");
		mkdirSync(good);
		const pinnedBinds = [
			{ fd: 5, source: good, dest: "/a", writable: true, label: "a" },
		];
		const before = openFds();
		expect(
			refusedWith(() =>
				openSandboxFds(compiled({ pinnedBinds }), join(root, "missing")),
			),
		).toBe("launch_failed");
		expect(openFds()).toBe(before);
	});
});
