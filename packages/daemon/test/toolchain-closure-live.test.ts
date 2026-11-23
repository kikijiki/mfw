import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
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
		.filter((p) => existsSync(p));
}

/**
 * None of `paths` exists in the sandbox. Read from a list in the sandbox's
 * stdin-free argv in batches; the control proves each shell really ran.
 */
function expectAbsent(plan: ToolchainPlan, paths: readonly string[]): void {
	for (let i = 0; i < paths.length; i += 200) {
		const batch = paths.slice(i, i + 200);
		const quoted = batch.map((f) => `'${f}'`).join(" ");
		const r = inSandbox(
			plan,
			`echo alive; for f in ${quoted}; do if [ -e "$f" ] || [ -L "$f" ]; then echo "present $f"; fi; done`,
		);
		expect(r.code).toBe(0);
		expect(r.out).toBe("alive\n");
	}
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

	test("every executable the closure hides is absent, python in git's included", () => {
		const p = plan();
		const masks = p.masks ?? [];
		expect(masks.length).toBeGreaterThan(0);
		const hidden = masks.flatMap((dir) =>
			readdirSync(dir).map((name) => `${dir}/${name}`),
		);
		expect(hidden.length).toBeGreaterThan(0);
		// git's own runtime closure carries python3, which nobody declared.
		const python = hidden.filter((f) =>
			/-python3-[^/]*\/bin\/python3$/.test(f),
		);
		expect(python.length).toBeGreaterThan(0);
		expectAbsent(p, hidden);
	});

	test("no undeclared network tool or interpreter in the store can run", () => {
		const p = plan();
		const found = [
			...storeBinaries(/-curl-\d[^/]*$/, "curl"),
			...storeBinaries(/-python3-\d[^/]*$/, "python3"),
			...storeBinaries(/-openssh-\d[^/]*$/, "ssh"),
			...storeBinaries(/-perl-\d[^/]*$/, "perl"),
		];
		expect(found.length).toBeGreaterThan(0);
		expectAbsent(p, found);
	});

	test("every shell script git ships can start, and perl and python cannot", () => {
		const p = plan();
		const git = p.resolved.find((b) => b.name === "git")?.realPath as string;
		const exec = `${git.slice(0, git.indexOf("/bin/"))}/libexec/git-core`;
		const interpreters = new Set<string>();
		for (const name of readdirSync(exec)) {
			const file = `${exec}/${name}`;
			if (!lstatSync(file).isFile()) continue;
			const head = readFileSync(file).subarray(0, 200).toString("latin1");
			const m = /^#!\s*(\S+)/.exec(head);
			if (m) interpreters.add(m[1] as string);
		}
		const shells = [...interpreters].filter((i) => /\/(ba|da)?sh$/.test(i));
		const others = [...interpreters].filter((i) => !shells.includes(i));
		expect(shells.length).toBeGreaterThan(0);
		for (const shell of shells) {
			const r = inSandbox(p, `'${shell}' -c 'echo started'`);
			expect([shell, r.out]).toEqual([shell, "started\n"]);
		}
		expect(others.some((i) => /perl|python/.test(i))).toBe(true);
		expectAbsent(p, others);
		// filter-branch also calls these by name, as an agent's toolchain provides.
		const withTools = discoverToolchain({
			home: homedir(),
			binaries: [...DECLARED, "sed", "grep"],
			path: process.env.PATH ?? "",
		});
		const filter = inSandbox(
			withTools,
			"git init -q r && cd r && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m a && FILTER_BRANCH_SQUELCH_WARNING=1 git -c user.name=t -c user.email=t@t filter-branch -f --msg-filter cat HEAD",
		);
		expect(filter.code).toBe(0);
	});

	test("a hidden directory cannot be written", () => {
		const p = plan();
		const mask = p.masks?.[0];
		expect(mask).toBeDefined();
		const r = inSandbox(
			p,
			`[ -d '${mask}' ] || exit 90; if (echo x > '${mask}/planted') 2>/dev/null; then exit 91; fi; exit 0`,
		);
		expect(r.code).toBe(0);
	});
});
