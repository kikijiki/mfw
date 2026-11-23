import { describe, expect, test } from "bun:test";
import {
	detectUserns,
	type HostReaders,
	type RunResult,
} from "../src/containment/host-caps.ts";

const AA = "/proc/sys/kernel/apparmor_restrict_unprivileged_userns";
const PROBE = {
	bwrap: "/usr/bin/bwrap",
	bwrapReal: "/usr/bin/bwrap",
	trueBin: "/usr/bin/true",
};
const ARGV = "/usr/bin/bwrap --unshare-user --ro-bind / / /usr/bin/true";

function host(
	files: Record<string, string>,
	probe: RunResult | undefined,
	ran: string[] = [],
): HostReaders {
	return {
		readFile: async (p) => files[p],
		exists: async () => false,
		run: async (argv) => {
			ran.push(argv.join(" "));
			return argv.join(" ") === ARGV ? probe : undefined;
		},
		fsInfo: async () => undefined,
		reflink: async () => undefined,
		arch: "x64",
		uid: 1000,
		user: "dev",
	};
}

const works = { code: 0, stdout: "" };
const denied = { code: 1, stdout: "" };

describe("user namespaces are decided by a real probe", () => {
	test("the reviewer's case: a scoped profile with the knob still 1 passes", async () => {
		const c = await detectUserns(host({ [AA]: "1\n" }, works), PROBE);
		expect(c.ok).toBe(true);
		expect(c.value.appArmorRestricted).toBe(true);
	});

	test("the probe is the exact command, on the trusted binary", async () => {
		const ran: string[] = [];
		await detectUserns(host({}, works, ran), PROBE);
		expect(ran).toEqual([ARGV]);
	});

	test("clean knobs do not pass when the probe is denied", async () => {
		const c = await detectUserns(
			host({ "/proc/sys/user/max_user_namespaces": "63304\n" }, denied),
			PROBE,
		);
		expect(c.ok).toBe(false);
		expect(c.severity).toBe("required");
	});

	test("unreadable knobs and no probe result are unknown, not a pass", async () => {
		const c = await detectUserns(host({}, undefined), PROBE);
		expect(c.ok).toBe(false);
		expect(c.detail).toContain("could not");
	});

	test("no trusted bwrap or true is unknown, and nothing runs", async () => {
		const ran: string[] = [];
		for (const probe of [
			{ ...PROBE, bwrap: null },
			{ ...PROBE, trueBin: null },
		]) {
			const c = await detectUserns(host({}, works, ran), probe);
			expect(c.ok).toBe(false);
		}
		expect(ran).toEqual([]);
	});

	test("the AppArmor fix is a profile for the resolved bwrap, with no sysctl", async () => {
		const c = await detectUserns(host({ [AA]: "1\n" }, denied), {
			...PROBE,
			bwrap: "/usr/local/bin/bwrap",
			bwrapReal: "/opt/bubblewrap/bin/bwrap",
		});
		// The run above used a different argv, so it is a denied probe.
		expect(c.ok).toBe(false);
		expect(c.fix).toContain("profile mfw-bwrap /opt/bubblewrap/bin/bwrap");
		expect(c.fix).toContain("userns,");
		expect(c.fix).toContain(
			"sudo apparmor_parser -r /etc/apparmor.d/mfw-bwrap",
		);
		expect(c.fix).toContain("sudo test ! -e /etc/apparmor.d/mfw-bwrap");
		expect(c.fix).not.toContain("sysctl");
		expect(c.fix).not.toContain("apparmor_restrict_unprivileged_userns");
	});

	test("a bwrap path that cannot be written into a profile gets no command", async () => {
		const c = await detectUserns(host({ [AA]: "1\n" }, denied), {
			...PROBE,
			bwrapReal: "/opt/odd path/$(touch x)/bwrap",
		});
		expect(c.fix).not.toContain("$(touch");
		expect(c.fix).not.toContain("apparmor_parser");
	});

	test("enabling namespaces host-wide is labelled as what it is", async () => {
		const cases: Record<string, string>[] = [
			{ "/proc/sys/user/max_user_namespaces": "0\n" },
			{ "/proc/sys/kernel/unprivileged_userns_clone": "0\n" },
		];
		for (const files of cases) {
			const c = await detectUserns(host(files, denied), PROBE);
			expect(c.fix).toContain("host-wide");
			expect(c.fix).toContain("every program");
		}
	});
});
