import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildProbeScript,
	PROBE_EXIT_CODE,
} from "../src/containment/minimal-probe.ts";
import { runProc } from "../src/proc.ts";
import {
	autonomySandboxRefusal,
	bwrapAvailable,
	maskedRuntimePaths,
	probeSandbox,
	resetSandboxProbeCache,
	wrapWithBwrap,
} from "../src/sandbox.ts";

/**
 * G2a: the minimal probe. The pure layer runs the generated script with plain
 * `sh` (no bwrap needed); the real-bwrap layer skips, with a printed reason,
 * where bwrap or user namespaces are unavailable.
 */

const base = {
	allowedEnv: ["PATH", "HOME", "PWD", "SHLVL", "_"],
	emptyDirs: [] as string[],
	noSocketDirs: [] as string[],
};

function runProbe(script: string, env: Record<string, string>) {
	return runProc(
		[
			"env",
			"-i",
			...Object.entries(env).map(([k, v]) => `${k}=${v}`),
			"sh",
			"-c",
			script,
		],
		{
			timeoutMs: 10_000,
		},
	);
}

describe("buildProbeScript (pure, run with sh)", () => {
	const script = buildProbeScript(base);

	test("passes with only allowlisted environment", async () => {
		const r = await runProbe(script, { PATH: process.env.PATH ?? "" });
		expect(r.exitCode).toBe(0);
	});

	test("a canary environment variable fails the probe with exit 78", async () => {
		const r = await runProbe(script, {
			PATH: process.env.PATH ?? "",
			MFW_CANARY_E0: "daemon-secret",
		});
		expect(r.exitCode).toBe(PROBE_EXIT_CODE);
		expect(r.stderr).toContain("MFW_CANARY_E0");
		expect(r.stderr).not.toContain("daemon-secret");
	});

	test("a non-empty masked dir fails; an empty or absent one passes", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mfw-probe-"));
		try {
			const empty = join(dir, "empty");
			await mkdir(empty);
			const full = join(dir, "full");
			await mkdir(full);
			await Bun.write(join(full, "credentials.json"), "{}");
			const env = { PATH: process.env.PATH ?? "" };
			const ok = buildProbeScript({
				...base,
				emptyDirs: [empty, join(dir, "absent")],
			});
			expect((await runProbe(ok, env)).exitCode).toBe(0);
			const bad = buildProbeScript({ ...base, emptyDirs: [full] });
			const r = await runProbe(bad, env);
			expect(r.exitCode).toBe(PROBE_EXIT_CODE);
			expect(r.stderr).toContain("is not empty");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("a reachable unix socket in a masked dir fails the probe", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mfw-probe-sock-"));
		const server = Bun.listen({
			unix: join(dir, "tmux.sock"),
			socket: { data() {} },
		});
		try {
			const r = await runProbe(
				buildProbeScript({ ...base, noSocketDirs: [dir] }),
				{ PATH: process.env.PATH ?? "" },
			);
			expect(r.exitCode).toBe(PROBE_EXIT_CODE);
			expect(r.stderr).toContain("unix socket");
		} finally {
			server.stop(true);
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("wrapWithBwrap flags (pure)", () => {
	test("is path-pinned, env-cleared, detached and probed", () => {
		if (!Bun.which("bwrap")) return console.log("skip: no bwrap on PATH");
		const w = wrapWithBwrap(
			"echo hi",
			"/work/wt",
			"/work/run",
			{
				mode: "bwrap",
				hidePaths: ["/h"],
			},
			["MFW_RUN_ID"],
		);
		expect(w).toMatch(/\/env' -i PATH=/);
		expect(w).toMatch(/'\/[^']*bwrap' '--die-with-parent'/);
		expect(w).toContain("'--new-session'");
		expect(w).toContain("'--clearenv'");
		expect(w).toContain("MFW_RUN_ID");
		expect(w).toContain("sandbox_probe_failed");
		// secrets are read from the shell at run time, never inlined
		// biome-ignore lint/suspicious/noTemplateCurlyInString: bash indirect expansion
		expect(w).toContain('"${!_n}"');
	});

	test("masks only the runtime paths that exist", () => {
		const exists = (p: string) => p === "/run/user/7" || p === "/tmp/t";
		expect(maskedRuntimePaths({ TMUX_TMPDIR: "/tmp/t" }, 7, exists)).toEqual([
			"/run/user/7",
			"/tmp/t",
		]);
		expect(maskedRuntimePaths({}, 7, () => false)).toEqual([]);
	});
});

describe("autonomySandboxRefusal", () => {
	const iso = { mode: "bwrap" as const, hidePaths: [] };
	test("interactive runs may be unsandboxed", async () => {
		expect(
			await autonomySandboxRefusal({
				approvalMode: "interactive",
				isolation: undefined,
			}),
		).toBeNull();
	});
	test("autonomous with isolation none is refused", async () => {
		expect(
			await autonomySandboxRefusal({
				approvalMode: "autonomous",
				isolation: undefined,
			}),
		).toMatchObject({ code: "sandbox_unavailable" });
	});
	test("autonomous with bwrap mocked absent is refused", async () => {
		expect(
			await autonomySandboxRefusal({
				approvalMode: "autonomous",
				isolation: iso,
				available: async () => false,
			}),
		).toMatchObject({
			code: "sandbox_unavailable",
			detail: "bwrap is not on PATH",
		});
	});
	test("a failed probe is sandbox_probe_failed", async () => {
		expect(
			await autonomySandboxRefusal({
				approvalMode: "autonomous",
				isolation: iso,
				available: async () => true,
				probe: async () => ({ ok: false, detail: "leak" }),
			}),
		).toEqual({ code: "sandbox_probe_failed", detail: "leak" });
	});
	test("a passing probe lets autonomy go", async () => {
		expect(
			await autonomySandboxRefusal({
				approvalMode: "autonomous",
				isolation: iso,
				available: async () => true,
				probe: async () => ({ ok: true }),
			}),
		).toBeNull();
	});
});

describe("probeSandbox in real bwrap", () => {
	test("passes in a clean environment, with the daemon canary absent", async () => {
		if (!(await bwrapAvailable())) return console.log("skip: no bwrap");
		resetSandboxProbeCache();
		const r = await probeSandbox(
			{ mode: "bwrap", hidePaths: [] },
			{
				env: {
					PATH: process.env.PATH ?? "",
					HOME: process.env.HOME ?? "",
					MFW_CANARY_E0: "x",
				},
			},
		);
		if (
			!r.ok &&
			/namespace|Operation not permitted|setting up uid map|Permission denied/i.test(
				r.detail,
			)
		) {
			return console.log(`skip: bwrap cannot run here (${r.detail})`);
		}
		// MFW_CANARY_E0 is not allowlisted, so it never enters the sandbox.
		expect(r).toEqual({ ok: true });
	});
});

describe("pinned host tools (review G4)", () => {
	test("a binary planted in a writable PATH entry is never selected", async () => {
		const { mkdtemp, mkdir, writeFile, chmod, symlink } = await import(
			"node:fs/promises"
		);
		const { pinnedToolIn, trustedPathEntries } = await import(
			"../src/sandbox.ts"
		);
		const root = await mkdtemp(join(tmpdir(), "mfw-pin-"));
		try {
			const home = join(root, "home");
			const planted = join(home, ".local", "bin");
			const real = join(root, "system", "bin");
			await mkdir(planted, { recursive: true });
			await mkdir(real, { recursive: true });
			for (const d of [planted, real]) {
				await writeFile(join(d, "bwrap"), "#!/bin/sh\nexit 0\n");
				await chmod(join(d, "bwrap"), 0o755);
			}
			// a profile link inside the writable root that points outside it is pinned to its target
			await symlink(real, join(home, "profile-bin"));
			const path = `${planted}:${join(home, "profile-bin")}:${real}`;
			expect(pinnedToolIn("bwrap", path, [home])).toBe(join(real, "bwrap"));
			expect(trustedPathEntries(path, [home])).toEqual([real]);
			expect(pinnedToolIn("bwrap", planted, [home])).toBeNull();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
