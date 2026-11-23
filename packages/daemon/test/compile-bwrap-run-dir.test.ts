import { describe, expect, test } from "bun:test";
import {
	type CompiledSandbox,
	type CompileHost,
	compileBwrap,
	SANDBOX_PATHS,
} from "../src/containment/compile-bwrap.ts";
import type { Check } from "../src/containment/host-caps.ts";
import {
	narrowProfile,
	parseSandboxProfile,
	type SandboxProfile,
} from "../src/containment/profile.ts";

const pass = <T>(value: T): Check<T> => ({
	ok: true,
	severity: "required",
	value,
	detail: "ok",
});

const STATE = "/srv/project/.mfw";
const RUN = `${STATE}/runs/r1`;

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
		toolchain: { binds: [], resolved: [], unresolved: [], pathDirs: [] },
		home: "/users/owner",
		mfwHome: "/users/owner/.local/share/mfw",
		allowedRoots: [`${STATE}/runs`, "/srv/work"],
		realpath: (p) => p,
		...over,
	};
}

function profile(
	filesystem: Record<string, unknown>,
	role = "task",
): SandboxProfile {
	return parseSandboxProfile({ version: 1, role, filesystem });
}

function compiled(p: SandboxProfile, h = host()): CompiledSandbox {
	const r = compileBwrap(p, ["/bin/true"], h);
	if (!r.ok) throw new Error(r.reason);
	return r;
}

const runDir = { source: RUN, outbox: "rw" };

describe("compile: run dir section", () => {
	test("binds control read-only and outbox read-write, both pinned", () => {
		const c = compiled(profile({ runDir }));
		expect(c.pinnedBinds.map((b) => [b.source, b.dest, b.writable])).toEqual([
			[`${RUN}/control`, SANDBOX_PATHS.runControl, false],
			[`${RUN}/outbox`, SANDBOX_PATHS.runOutbox, true],
		]);
		expect(c.runDirRoot).toBe(RUN);
		expect(c.env.MFW_RUN_OUTBOX).toBe(SANDBOX_PATHS.runOutbox);
	});

	test("never mounts the run root itself", () => {
		const c = compiled(profile({ runDir }));
		expect(c.pinnedBinds.some((b) => b.source === RUN)).toBe(false);
		expect(c.bwrapArgs.toString().split("\0")).not.toContain(RUN);
	});

	test("the mount points' parent is created before the root goes read-only", () => {
		const args = compiled(profile({ runDir })).bwrapArgs.toString().split("\0");
		const dir = args.indexOf(SANDBOX_PATHS.runOutbox);
		const remount = args.findIndex(
			(a, i) => a === "--remount-ro" && args[i + 1] === "/",
		);
		expect(dir).toBeGreaterThan(-1);
		expect(dir).toBeLessThan(remount);
	});

	test("the outbox is the only run path a read-only role can write", () => {
		const c = compiled(profile({ runDir }, "reviewer"));
		expect(c.pinnedBinds.filter((b) => b.writable).map((b) => b.label)).toEqual(
			["run outbox"],
		);
		const ro = compiled(
			profile({ runDir: { source: RUN, outbox: "ro" } }, "reviewer"),
		);
		expect(ro.pinnedBinds.every((b) => !b.writable)).toBe(true);
	});

	test("a verifier role has no run directory at all", () => {
		expect(() => profile({ runDir }, "verifier")).toThrow(/run directory/);
	});

	test("narrowing can make the outbox read-only", () => {
		const narrowed = narrowProfile(profile({ runDir }), { outboxAccess: "ro" });
		expect(narrowed.filesystem?.runDir?.outbox).toBe("ro");
	});

	test("an unknown run dir key is rejected", () => {
		expect(() => profile({ runDir: { ...runDir, control: "rw" } })).toThrow();
	});

	// Outside `.mfw`, so the allowed root is legal and only the run dir check
	// can refuse. Everything is read-only, so the generic writable-overlap
	// check cannot be what catches it.
	const PLAIN = "/srv/state/runs/r1";
	for (const [name, source] of [
		["the run root", PLAIN],
		["the runs directory", "/srv/state/runs"],
		["a path inside the run root", `${PLAIN}/meta`],
		["the run's own control", `${PLAIN}/control`],
		["the run's own outbox", `${PLAIN}/outbox`],
	] as const) {
		for (const access of ["ro", "rw"] as const) {
			test(`refuses a ${access} cache bound at ${name}`, () => {
				const r = compileBwrap(
					profile({
						runDir: { source: PLAIN, outbox: "ro" },
						caches: [{ name: "c", source, access }],
					}),
					["/bin/true"],
					host({ allowedRoots: ["/srv/state"] }),
				);
				expect(r.ok).toBe(false);
				if (!r.ok) expect(r.code).toBe("bind_overlap");
			});
		}
	}

	test("a cache beside the runs directory still compiles", () => {
		const r = compileBwrap(
			profile({
				runDir: { source: PLAIN, outbox: "rw" },
				caches: [{ name: "c", source: "/srv/state/cache", access: "rw" }],
			}),
			["/bin/true"],
			host({ allowedRoots: ["/srv/state"] }),
		);
		expect(r.ok).toBe(true);
	});

	test("an allowed root containing the project state directory is refused", () => {
		const r = compileBwrap(
			profile({ runDir }),
			["/bin/true"],
			host({ allowedRoots: ["/srv/project"] }),
		);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("path_denied");
	});

	test("refuses a run root reached through a symlink", () => {
		const r = compileBwrap(
			profile({ runDir }),
			["/bin/true"],
			host({
				realpath: (p) => (p === RUN ? "/elsewhere/r1" : p),
			}),
		);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("path_not_canonical");
	});
});

describe("compile: the project DB directory is never bound", () => {
	test("refuses a bind of the state directory derived from the run dir", () => {
		const r = compileBwrap(
			profile({
				runDir,
				caches: [{ name: "c", source: STATE, access: "ro" }],
			}),
			["/bin/true"],
			host({ allowedRoots: ["/srv/project"] }),
		);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("path_denied");
	});

	test("refuses a bind of a declared DB directory or its ancestor", () => {
		for (const source of ["/srv/db/project", "/srv/db"]) {
			const r = compileBwrap(
				profile({ caches: [{ name: "c", source, access: "ro" }] }),
				["/bin/true"],
				host({
					allowedRoots: ["/srv"],
					projectDbDirs: ["/srv/db/project"],
				}),
			);
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.code).toBe("path_denied");
		}
	});
});
