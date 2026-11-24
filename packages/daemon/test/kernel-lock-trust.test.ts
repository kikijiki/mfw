import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockRefusal, runInitCommand } from "../src/doctor/cli.ts";
import { acquireKernelLock, KernelLockError } from "../src/kernel-lock.ts";
import {
	acquireDaemonLock,
	DaemonLockError,
} from "../src/resources/daemon-lock.ts";
import { resetBwrapAvailableCache } from "../src/sandbox.ts";
import { fixture } from "./support/doctor-fixture.ts";

const savedPath = process.env.PATH;
const dirs: string[] = [];
afterEach(() => {
	process.env.PATH = savedPath;
	resetBwrapAvailableCache();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
	const d = realpathSync(mkdtempSync(join(tmpdir(), "mfw-lock-")));
	dirs.push(d);
	return d;
};

describe("the lock helper comes from a trusted PATH", () => {
	test("the reviewer's case: a planted flock and sh never run", async () => {
		const d = tmp();
		const bin = join(d, "bin");
		mkdirSync(bin);
		const marker = join(d, "ran");
		for (const name of ["flock", "sh", "cat"]) {
			writeFileSync(join(bin, name), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
			chmodSync(join(bin, name), 0o755);
		}
		const child = Bun.spawnSync(
			[
				process.execPath,
				"-e",
				`import { acquireKernelLock } from "./packages/daemon/src/kernel-lock.ts";
				 const lock = await acquireKernelLock(process.env.TEST_LOCK);
				 await lock.release();`,
			],
			{
				cwd: join(import.meta.dir, "../../.."),
				env: {
					...process.env,
					PATH: `${bin}:${savedPath}`,
					TEST_LOCK: join(d, "x.lock"),
				},
			},
		);
		expect(child.exitCode).toBe(0);
		expect(existsSync(marker)).toBe(false);
	});

	test("no trusted flock is an error, and not a claim that the lock is held", async () => {
		const d = tmp();
		process.env.PATH = "";
		resetBwrapAvailableCache();
		const failure = await acquireKernelLock(join(d, "x.lock")).catch((e) => e);
		expect(failure).toBeInstanceOf(KernelLockError);
		expect(failure.busy).toBe(false);
	});
});

describe("only a real conflict is reported as busy", () => {
	test("a held lock is busy", async () => {
		const d = tmp();
		const held = await acquireKernelLock(join(d, "x.lock"));
		const failure = await acquireKernelLock(join(d, "x.lock")).catch((e) => e);
		expect(failure.busy).toBe(true);
		await held.release();
	});

	test("a lock path that cannot be opened is not busy", async () => {
		const d = tmp();
		mkdirSync(join(d, "x.lock"));
		chmodSync(join(d, "x.lock"), 0o000);
		const failure = await acquireKernelLock(join(d, "x.lock")).catch((e) => e);
		chmodSync(join(d, "x.lock"), 0o700);
		expect(failure).toBeInstanceOf(KernelLockError);
		expect(failure.busy).toBe(false);
	});

	test("the daemon lock keeps the distinction", async () => {
		const d = tmp();
		const held = await acquireKernelLock(join(d, "daemon.lock"));
		const failure = await acquireDaemonLock(d, {
			processBootId: "t",
			timeoutMs: 500,
		}).catch((e) => e);
		expect(failure).toBeInstanceOf(DaemonLockError);
		expect(failure.busy).toBe(true);
		await held.release();
	});
});

describe("init --write words a lock failure truthfully", () => {
	const deps = (home: string, err: string[]) => ({
		env: { PATH: "", HOST: "127.0.0.1" },
		home,
		out: () => {},
		err: (l: string) => err.push(l),
		probes: fixture({ home }),
	});
	const repo = (d: string) => {
		const r = join(d, "repo");
		mkdirSync(r);
		const p = Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: r });
		expect(p.exitCode).toBe(0);
		return r;
	};

	test("a real conflict says the server is running", async () => {
		const d = tmp();
		const home = join(d, "home");
		mkdirSync(home, { mode: 0o700 });
		const r = repo(d);
		const held = await acquireKernelLock(join(home, "daemon.lock"));
		const err: string[] = [];
		await runInitCommand(["--project", r, "--write"], deps(home, err));
		await held.release();
		expect(err.join("")).toContain("the server is running");
	});

	test("any other lock failure does not", () => {
		const text = lockRefusal(
			new DaemonLockError("/x", "flock is missing", false),
		);
		expect(text).not.toContain("the server is running");
		expect(text).toContain("could not take the server lock");
		expect(lockRefusal(new DaemonLockError("/x", "held", true))).toContain(
			"the server is running",
		);
	});
});
