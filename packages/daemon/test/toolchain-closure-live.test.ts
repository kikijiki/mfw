import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import {
	discoverToolchain,
	type ToolchainPlan,
	toolchainBwrapArgs,
} from "../src/containment/toolchain.ts";

/**
 * The closure bind under real bwrap on a real Nix store: declared tools run,
 * and tools nobody declared are absent, even by absolute path and even when
 * they are in a declared tool's closure. Every command here is harmless.
 */

const BWRAP = Bun.which("bwrap");
const DECLARED = ["git", "sh", "cat", "ls", "mkdir"];

function skipReason(): string | null {
	if (!BWRAP) return "no bwrap";
	if (!existsSync("/nix/store")) return "no Nix store";
	const r = Bun.spawnSync([
		BWRAP,
		"--unshare-all",
		"--ro-bind",
		"/",
		"/",
		"--",
		"true",
	]);
	return r.exitCode === 0 ? null : "bwrap cannot run here";
}

const skip = skipReason();
if (skip && process.env.MFW_REQUIRE_LIVE_SANDBOX === "1") {
	test("the live closure suite is required here", () => {
		throw new Error(`MFW_REQUIRE_LIVE_SANDBOX is set, but ${skip}`);
	});
} else if (skip) {
	console.log(`[toolchain-closure-live] skipped: ${skip}`);
}

function inSandbox(plan: ToolchainPlan, script: string) {
	const sh = plan.resolved.find((b) => b.name === "sh")?.path as string;
	const r = Bun.spawnSync(
		[
			BWRAP as string,
			"--unshare-all",
			"--die-with-parent",
			"--proc",
			"/proc",
			"--dev",
			"/dev",
			"--tmpfs",
			"/tmp",
			...toolchainBwrapArgs(plan),
			"--clearenv",
			"--setenv",
			"PATH",
			plan.pathDirs.join(":"),
			"--setenv",
			"HOME",
			"/tmp",
			"--chdir",
			"/tmp",
			"--",
			sh,
			"-c",
			script,
		],
		{ timeout: 30_000 },
	);
	return {
		code: r.exitCode,
		out: r.stdout.toString(),
		err: r.stderr.toString(),
	};
}

/** Host paths of a tool in the store, for the positive half of the check. */
function storeBinaries(pkg: RegExp, bin: string): string[] {
	return readdirSync("/nix/store")
		.filter((e) => pkg.test(e))
		.map((e) => `/nix/store/${e}/bin/${bin}`)
		.filter((p) => existsSync(p))
		.slice(0, 8);
}

describe.skipIf(skip !== null)("store closure under bwrap", () => {
	const plan = () =>
		discoverToolchain({
			home: homedir(),
			binaries: DECLARED,
			path: process.env.PATH ?? "",
		});

	test("declared tools work", () => {
		const p = plan();
		expect(p.unresolved).toEqual([]);
		expect(p.closureMethod).toBeDefined();
		const r = inSandbox(
			p,
			"git init -q repo && cd repo && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m x && git log --format=%s",
		);
		expect(r.err).toBe("");
		expect(r.code).toBe(0);
		expect(r.out.trim()).toBe("x");
	});

	test("the store shows the closure and not the host's whole store", () => {
		const p = plan();
		const listed = inSandbox(p, "ls /nix/store").out.trim().split("\n");
		const bound = p.binds.filter((b) => b.source === "nix").length;
		expect(listed.length).toBe(bound);
		expect(readdirSync("/nix/store").length).toBeGreaterThan(bound);
	});

	test.each([
		["curl", /-curl-\d[^/]*$/, "curl"],
		["python3", /-python3-\d[^/]*$/, "python3"],
		["ssh", /-openssh-\d[^/]*$/, "ssh"],
		["perl", /-perl-\d[^/]*$/, "perl"],
	] as const)("undeclared %s cannot run by absolute path", (_n, pkg, bin) => {
		const p = plan();
		const candidates = storeBinaries(pkg, bin);
		if (candidates.length === 0) {
			console.log(`[toolchain-closure-live] no ${bin} in this store`);
			return;
		}
		for (const path of candidates) {
			// The control proves the shell ran, so a dead sandbox cannot pass.
			const r = inSandbox(
				p,
				`echo alive; if [ -e '${path}' ]; then echo present; fi`,
			);
			expect(r.code).toBe(0);
			expect(r.out).toBe("alive\n");
		}
	});

	test("a hidden directory cannot be written", () => {
		const p = plan();
		const mask = p.masks?.[0];
		if (!mask) return;
		const r = inSandbox(
			p,
			`[ -d '${mask}' ] || exit 90; if (echo x > '${mask}/planted') 2>/dev/null; then exit 91; fi; exit 0`,
		);
		expect(r.code).toBe(0);
	});
});
