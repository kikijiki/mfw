import { describe, expect, test } from "bun:test";
import {
	detectSystemdUser,
	type HostReaders,
} from "../src/containment/host-caps.ts";
import {
	buildScopeArgs,
	DEFAULT_LIMITS,
	planLimits,
	wrapInScope,
} from "../src/containment/limits.ts";
import { runProc } from "../src/proc.ts";

/** HCAP: the systemd-run scope builder, plus one live TasksMax check that skips without a user manager. */

function sd(
	running: boolean,
	controllers: string,
): Promise<
	ReturnType<typeof detectSystemdUser> extends Promise<infer T> ? T : never
> {
	const r = {
		readFile: async () => controllers,
		exists: async () => false,
		run: async () => (running ? { code: 0, stdout: "running\n" } : undefined),
		fsInfo: async () => undefined,
		reflink: async () => undefined,
		arch: "x64",
		uid: 1000,
		user: "dev",
	} satisfies HostReaders;
	return detectSystemdUser(r);
}

describe("buildScopeArgs", () => {
	test("sets TasksMax, MemoryMax and MemorySwapMax=0 in a user scope", () => {
		expect(
			buildScopeArgs({ tasksMax: 100, memoryMax: "512M", unit: "mfw-run-1" }),
		).toEqual([
			"systemd-run",
			"--user",
			"--scope",
			"--quiet",
			"--unit=mfw-run-1",
			"-p",
			"TasksMax=100",
			"-p",
			"MemoryMax=512M",
			"-p",
			"MemorySwapMax=0",
			"--",
		]);
	});

	test("rejects values systemd would read differently or an injected property", () => {
		expect(() => buildScopeArgs({ tasksMax: 0, memoryMax: "1G" })).toThrow(
			RangeError,
		);
		expect(() => buildScopeArgs({ tasksMax: 1.5, memoryMax: "1G" })).toThrow(
			RangeError,
		);
		expect(() =>
			buildScopeArgs({ tasksMax: 10, memoryMax: "infinity" }),
		).toThrow(RangeError);
		expect(() =>
			buildScopeArgs({ tasksMax: 10, memoryMax: "1G -p Delegate=yes" }),
		).toThrow(RangeError);
		expect(() =>
			buildScopeArgs({ tasksMax: 10, memoryMax: "1G", unit: "a b" }),
		).toThrow(RangeError);
	});
});

describe("planLimits", () => {
	test("refuses without a user manager and carries the fix", async () => {
		const plan = planLimits(await sd(false, ""));
		expect(plan.ok).toBe(false);
		if (!plan.ok) {
			expect(plan.reason).toContain("cannot enforce run limits");
			expect(plan.fix.length).toBeGreaterThan(0);
		}
	});

	test("refuses without delegation", async () => {
		const plan = planLimits(await sd(true, "memory"));
		expect(plan.ok).toBe(false);
		if (!plan.ok) expect(plan.fix).toContain("Delegate=");
	});

	test("wraps a command when delegated", async () => {
		const plan = planLimits(await sd(true, "cpu memory pids"), DEFAULT_LIMITS);
		expect(plan.ok).toBe(true);
		if (plan.ok) {
			const argv = wrapInScope(plan, ["bwrap", "--version"]);
			expect(argv.slice(-3)).toEqual(["--", "bwrap", "--version"]);
			expect(argv).toContain(`TasksMax=${DEFAULT_LIMITS.tasksMax}`);
		}
	});
});

describe("live scope", () => {
	test("the cgroup under systemd-run carries the requested caps", async () => {
		const probe = await runProc(
			["systemd-run", "--user", "--scope", "--quiet", "true"],
			{
				timeoutMs: 10_000,
			},
		).catch(() => undefined);
		if (probe?.exitCode !== 0) {
			console.log(
				"skip: no systemd user manager that accepts transient scopes",
			);
			return;
		}
		const script =
			"d=/sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup); cat $d/pids.max $d/memory.max $d/memory.swap.max";
		const res = await runProc(
			[
				...buildScopeArgs({ tasksMax: 77, memoryMax: "300M" }),
				"sh",
				"-c",
				script,
			],
			{ timeoutMs: 15_000 },
		);
		if (res.exitCode !== 0) {
			console.log(
				`skip: scope not delegated here (${res.stderr.trim().slice(0, 120)})`,
			);
			return;
		}
		expect(res.stdout.trim().split("\n")).toEqual([
			"77",
			String(300 * 1024 * 1024),
			"0",
		]);
	});
});
