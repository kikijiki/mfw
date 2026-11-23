import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import net from "node:net";
import { join, resolve } from "node:path";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import type { CheckRunner } from "../src/containment/check-runner.ts";
import { createCheckSandbox } from "../src/containment/check-sandbox.ts";
import { git } from "../src/git.ts";
import { VerifierClones } from "../src/run-workspace/verifier-clone.ts";
import { verifyInClone } from "../src/verifier.ts";
import { cagedSteps } from "./support/caged-launch.ts";

/**
 * Hostile DoD checks under real bwrap, through the real compile, probe, gate
 * and launch. Only the systemd layer is a stand-in (see caged-launch.ts), so
 * the task and memory limits are NOT exercised here: the fork test below is
 * deliberately bounded and proves cleanup, not the cgroup limit.
 */

const FIXTURES = resolve(import.meta.dir, "../../../.work/live-sandbox");
const BWRAP = Bun.which("bwrap");

function skipReason(): string | null {
	if (process.arch !== "x64") return "seccomp is x86_64 only";
	if (!BWRAP) return "no bwrap";
	const r = Bun.spawnSync([
		BWRAP,
		"--unshare-all",
		"--unshare-user",
		"--disable-userns",
		"--ro-bind",
		"/",
		"/",
		"--proc",
		"/proc",
		"--dev",
		"/dev",
		"--",
		"true",
	]);
	return r.exitCode === 0 ? null : "bwrap cannot run here";
}
const skip = skipReason();
if (skip) console.log(`[check-sandbox-live] skipped: ${skip}`);

const dod = (run: string, timeout?: number) =>
	({
		verifier: "deterministic",
		checks: [{ run, ...(timeout ? { timeout } : {}) }],
	}) as never;

describe.skipIf(skip !== null)("a DoD check in the verifier role", () => {
	let base: string;
	let home: string;
	let primary: string;
	let sha: string;
	let handle: ProjectDbHandle;
	let clones: VerifierClones;
	let runner: CheckRunner;
	let listener: net.Server;
	let port: number;
	let connections = 0;

	const canaries = () => ({
		ssh: join(home, ".ssh/id_canary"),
		config: join(home, ".config/keep"),
		primary: join(primary, "a.txt"),
	});
	const assertCanaries = () => {
		const c = canaries();
		expect(readFileSync(c.ssh, "utf8")).toBe("canary-key\n");
		expect(readFileSync(c.config, "utf8")).toBe("keep\n");
		expect(readFileSync(c.primary, "utf8")).toBe("one\n");
	};
	const check = (run: string, timeout?: number) =>
		verifyInClone(clones, sha, "live", dod(run, timeout), sha);

	beforeAll(async () => {
		mkdirSync(FIXTURES, { recursive: true });
		base = realpathSync(mkdtempSync(join(FIXTURES, "check-")));
		home = join(base, "home");
		mkdirSync(join(home, ".ssh"), { recursive: true });
		mkdirSync(join(home, ".config"), { recursive: true });
		writeFileSync(join(home, ".ssh/id_canary"), "canary-key\n");
		writeFileSync(join(home, ".config/keep"), "keep\n");
		primary = join(base, "primary");
		mkdirSync(join(primary, ".mfw"), { recursive: true });
		await git(["init", "-q", "-b", "main", "."], primary);
		await git(["config", "user.email", "t@t"], primary);
		await git(["config", "user.name", "t"], primary);
		writeFileSync(join(primary, "a.txt"), "one\n");
		await git(["add", "a.txt"], primary);
		await git(["commit", "-q", "-m", "init"], primary);
		sha = (await git(["rev-parse", "HEAD"], primary)).stdout.trim();
		handle = await openProjectDb(join(primary, ".mfw"));
		const mfwHome = join(base, "mfw");
		mkdirSync(mfwHome);
		const shim = join(base, "systemd-run-shim");
		writeFileSync(
			shim,
			'#!/bin/sh\nwhile [ "$#" -gt 0 ]; do a="$1"; shift; [ "$a" = "--" ] && break; done\nexec "$@"\n',
		);
		chmodSync(shim, 0o755);
		runner = createCheckSandbox({
			db: handle.db,
			mfwHome,
			projectRoot: primary,
			stateDir: join(primary, ".mfw"),
			steps: cagedSteps({
				home,
				path: process.env.PATH ?? "",
				shim,
			}),
		});
		clones = new VerifierClones({
			workspaceRoot: join(mfwHome, "workspaces"),
			primaryRoot: primary,
			checkRunner: runner,
		});
		listener = net.createServer((s) => {
			connections++;
			s.destroy();
		});
		await new Promise<void>((r) => listener.listen(0, "127.0.0.1", r));
		port = (listener.address() as net.AddressInfo).port;
	});

	afterAll(async () => {
		await new Promise<void>((r) => listener.close(() => r()));
		handle.close();
		rmSync(base, { recursive: true, force: true });
	});

	test("positive control: a check runs, sees its tree and can build in it", async () => {
		assertCanaries();
		const r = await check(
			'test "$(cat a.txt)" = one && mkdir -p dist && echo built > dist/out && test "$MFW_VERIFY" = 1',
		);
		expect(r.checks[0]?.detail).toBeUndefined();
		expect(r.passed).toBe(true);
	}, 60_000);

	test("a failing check is a failure of the code, not a crash", async () => {
		const r = await check("exit 3");
		expect(r.passed).toBe(false);
		expect(r.crashed).toBe(false);
		expect(r.checks[0]?.exitCode).toBe(3);
	}, 60_000);

	test("rm -rf with unset variables reaches nothing outside", async () => {
		// The mistake behind the home-wipe incident, aimed only at this fixture.
		// It refuses to run at all unless it is really inside the sandbox.
		assertCanaries();
		const r = await check(
			`test "$HOME" = /sandbox/agent && test ! -e "${home}" || exit 99; rm -rf "${home}/$UNSET" "${primary}/$UNSET" 2>/dev/null; true`,
		);
		expect(r.checks[0]?.exitCode).toBeUndefined();
		expect(r.passed).toBe(true);
		assertCanaries();
	}, 60_000);

	test("the real home is not visible", async () => {
		const r = await check(
			`test ! -e "${home}/.ssh/id_canary" && test ! -e "${primary}/a.txt"`,
		);
		expect(r.checks[0]?.detail).toBeUndefined();
		expect(r.passed).toBe(true);
	}, 60_000);

	test("it cannot reach the host's loopback or any network", async () => {
		const before = connections;
		const r = await check(
			`if command -v bun >/dev/null; then bun -e "const s=require('net').connect(${port},'127.0.0.1');s.on('connect',()=>process.exit(9));s.on('error',()=>process.exit(0));setTimeout(()=>process.exit(0),1500)"; fi`,
		);
		// A refused sandbox would also connect to nothing, so it must have run.
		expect(r.checks[0]?.detail).toBeUndefined();
		expect(r.passed).toBe(true);
		expect(connections).toBe(before);
	}, 60_000);

	test("it cannot write the clone's gitdir", async () => {
		const r = await check(
			'test -d "$GIT_DIR" && ! touch "$GIT_DIR/hooks/post-merge" 2>/dev/null && ! touch "$GIT_DIR/config" 2>/dev/null',
		);
		expect(r.checks[0]?.detail).toBeUndefined();
		expect(r.passed).toBe(true);
	}, 60_000);

	test("hooks planted in the tree never reach the primary", async () => {
		const marker = join(base, "hook-ran");
		const planted = await check(
			`mkdir -p .git/hooks && printf '#!/bin/sh\\ntouch ${marker}\\n' > .git/hooks/post-merge && chmod +x .git/hooks/post-merge`,
		);
		expect(planted.passed).toBe(true);
		const hooks = (
			await git(["rev-parse", "--git-path", "hooks"], primary)
		).stdout.trim();
		expect(existsSync(join(primary, hooks, "post-merge"))).toBe(false);
		await git(["commit", "--allow-empty", "-q", "-m", "after"], primary);
		await git(["merge", "-q", "--no-edit", "HEAD"], primary);
		expect(existsSync(marker)).toBe(false);
		await git(["reset", "-q", "--hard", sha], primary);
	}, 60_000);

	test("a process storm dies with the check", async () => {
		// Bounded on purpose: the cage has no pids cgroup to stop a real fork bomb.
		const marker = `mfw-storm-${process.pid}`;
		const r = await check(
			`for i in $(seq 1 64); do sh -c 'sleep 300; :' ${marker} & done; sleep 300`,
			2,
		);
		expect(r.checks[0]?.classification).toBe("timeout");
		// The bracket keeps this grep from matching its own command line.
		const pattern = `[m]${marker.slice(1)}`;
		const left = Bun.spawnSync([
			"sh",
			"-c",
			`grep -lsa '${pattern}' /proc/[0-9]*/cmdline | wc -l`,
		]);
		expect(left.stdout.toString().trim()).toBe("0");
	}, 60_000);

	test("the launch used a recorded, consumed attestation", async () => {
		await check("true");
		const uses = await handle.client.execute(
			"select count(*) as n from sandbox_attestation_uses",
		);
		expect(Number(uses.rows[0]?.n)).toBeGreaterThan(0);
	}, 60_000);
});
