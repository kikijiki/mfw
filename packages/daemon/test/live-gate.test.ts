import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { liveGate } from "./support/live-gate.ts";

/** Wave 2 exit review, M2: a required gate must not go green on skipped suites. */

const TESTS = import.meta.dir;
const GATED_ELSEWHERE = [
	"check-sandbox-live",
	"clone-wip-e2e",
	"compile-bwrap-live",
	"critic-sandbox-live",
	"agent-bridge-conformance",
	"egress-live",
	"launch-sandbox-live",
	"oneshot-egress-ledger-live",
	"probe-live",
	"probe-sealed-fds-live",
	"probe-sealed-live",
	"role-sandbox-live",
	"sweep-no-host-exec",
	"toolchain-closure-live",
	"attestation-gate",
	"ssh-execution-target",
];
/** Named `-live` but need no sandbox capability, so they have nothing to skip. */
const NO_CAPABILITY = [
	"agent-bridge-live-gate",
	"egress-lifecycle-live",
	"run-provenance-live",
];

const testFiles = readdirSync(TESTS).filter((f) => f.endsWith(".test.ts"));
const read = (file: string) => readFileSync(join(TESTS, file), "utf8");
const usesGate = (text: string) =>
	text.includes('from "./support/live-gate.ts"') && text.includes("liveGate(");

describe("the live gate", () => {
	test("returns the reason when the capability is not required", () => {
		const saved = process.env.MFW_REQUIRE_LIVE_SCOPE;
		delete process.env.MFW_REQUIRE_LIVE_SCOPE;
		try {
			expect(liveGate("t", "no manager", "systemd-scope")).toBe("no manager");
			expect(liveGate("t", null)).toBeNull();
		} finally {
			if (saved !== undefined) process.env.MFW_REQUIRE_LIVE_SCOPE = saved;
		}
	});

	test("throws when the capability is required", () => {
		const saved = process.env.MFW_REQUIRE_LIVE_SANDBOX;
		process.env.MFW_REQUIRE_LIVE_SANDBOX = "1";
		try {
			expect(() => liveGate("t", "no bwrap")).toThrow(
				"MFW_REQUIRE_LIVE_SANDBOX is set, but no bwrap",
			);
		} finally {
			if (saved === undefined) delete process.env.MFW_REQUIRE_LIVE_SANDBOX;
			else process.env.MFW_REQUIRE_LIVE_SANDBOX = saved;
		}
	});

	test("a compiled-executable suite fails instead of skipping under MFW_REQUIRE_COMPILED", () => {
		const saved = process.env.MFW_REQUIRE_COMPILED;
		process.env.MFW_REQUIRE_COMPILED = "1";
		try {
			expect(() => liveGate("t", "cannot compile", "compiled")).toThrow(
				"MFW_REQUIRE_COMPILED is set, but cannot compile",
			);
		} finally {
			if (saved === undefined) delete process.env.MFW_REQUIRE_COMPILED;
			else process.env.MFW_REQUIRE_COMPILED = saved;
		}
		const cli = readFileSync(
			resolve(TESTS, "../../cli/test/compiled-live.test.ts"),
			"utf8",
		);
		expect(cli).toContain(
			'liveGate("compiled-live", compileUnavailable(), "compiled")',
		);
	});

	test("with compiling impossible and MFW_REQUIRE_COMPILED set, the compiled suite fails", async () => {
		const repo = resolve(TESTS, "../../..");
		const child = Bun.spawn(
			[
				process.execPath,
				"test",
				join(repo, "packages/cli/test/compiled-live.test.ts"),
			],
			{
				cwd: repo,
				env: {
					PATH: dirname(process.execPath),
					HOME: process.env.HOME ?? "/nonexistent",
					MFW_REQUIRE_COMPILED: "1",
					MFW_TEST_COMPILE_TARGET: "bun-plan9-x64",
				},
				stdout: "pipe",
				stderr: "pipe",
				stdin: "ignore",
			},
		);
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(code).not.toBe(0);
		expect(`${stdout}${stderr}`).toContain(
			"MFW_REQUIRE_COMPILED is set, but no libsql addon is known for bun-plan9-x64",
		);
	}, 60_000);

	test("CI requires the compiled suite in both jobs, and runs the compiled smoke", () => {
		const ci = readFileSync(
			resolve(TESTS, "../../../.github/workflows/ci-check.yml"),
			"utf8",
		);
		expect(ci.match(/MFW_REQUIRE_COMPILED: "1"/g)?.length).toBe(2);
		expect(ci).toContain("bun run build && bun run smoke:compiled");
	});

	test("every *-live test file uses it, or is listed as needing no capability", () => {
		const live = testFiles.filter((f) => /-live.*\.test\.ts$/.test(f));
		expect(live.length).toBeGreaterThan(0);
		for (const file of live) {
			const name = file.replace(/\.test\.ts$/, "");
			if (NO_CAPABILITY.includes(name)) {
				expect(read(file), `${file} now skips`).not.toContain(".skipIf(");
			} else {
				expect(usesGate(read(file)), `${file} must use liveGate`).toBe(true);
			}
		}
	});

	test("every suite that skips on bwrap uses it", () => {
		for (const file of testFiles) {
			const text = read(file);
			if (!text.includes(".skipIf(") || !text.includes("bwrap")) continue;
			expect(usesGate(text), `${file} must use liveGate`).toBe(true);
		}
		for (const name of GATED_ELSEWHERE) {
			expect(usesGate(read(`${name}.test.ts`)), name).toBe(true);
		}
	});

	test("no suite reads the flag itself", () => {
		for (const file of testFiles) {
			if (file === "live-gate.test.ts") continue;
			if (file === "agent-bridge-live-gate.test.ts") continue;
			expect(read(file), file).not.toContain(
				"process.env.MFW_REQUIRE_LIVE_SANDBOX",
			);
		}
	});

	test("with bwrap absent and the flag set, a suite fails instead of skipping", async () => {
		const repo = resolve(TESTS, "../../..");
		for (const name of ["probe-sealed-live", "role-sandbox-live"]) {
			const child = Bun.spawn(
				[process.execPath, "test", join(TESTS, `${name}.test.ts`)],
				{
					cwd: repo,
					env: {
						PATH: dirname(process.execPath),
						HOME: process.env.HOME ?? "/nonexistent",
						MFW_REQUIRE_LIVE_SANDBOX: "1",
					},
					stdout: "pipe",
					stderr: "pipe",
					stdin: "ignore",
				},
			);
			const [stdout, stderr, code] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect(code, name).not.toBe(0);
			expect(`${stdout}${stderr}`).toContain(
				"MFW_REQUIRE_LIVE_SANDBOX is set, but",
			);
		}
	}, 60_000);
});
