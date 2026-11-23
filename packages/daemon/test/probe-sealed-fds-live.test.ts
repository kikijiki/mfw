import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readlinkSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import type { CompileHost } from "../src/containment/compile-bwrap.ts";
import type { Check } from "../src/containment/host-caps.ts";
import { attestSandbox } from "../src/containment/probe-run.ts";
import { parseSandboxProfile } from "../src/containment/profile.ts";
import { discoverToolchain } from "../src/containment/toolchain.ts";

/** Security review P7, m6: 101 MB stayed open in the daemon until a later GC. */

const BWRAP = Bun.which("bwrap");
const ENV = Bun.which("env");
const usable =
	process.arch === "x64" &&
	!!BWRAP &&
	Bun.spawnSync([
		BWRAP,
		"--unshare-all",
		"--ro-bind",
		"/",
		"/",
		"--proc",
		"/proc",
		"--dev",
		"/dev",
		"--",
		"true",
	]).exitCode === 0;

const pass = <T>(value: T): Check<T> => ({
	ok: true,
	severity: "required",
	value,
	detail: "ok",
});

const sealedOpen = () =>
	readdirSync("/proc/self/fd").filter((n) => {
		try {
			return readlinkSync(`/proc/self/fd/${n}`).startsWith("/memfd:mfw-probe-");
		} catch {
			return false;
		}
	}).length;

describe.skipIf(!usable)("the probe's sealed runtime", () => {
	let root: string;
	let handle: ProjectDbHandle;

	beforeEach(async () => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "mfw-sealed-fds-")));
		mkdirSync(join(root, "home"));
		mkdirSync(join(root, "mfw"));
		handle = await openProjectDb(join(root, "db"));
	});
	afterEach(() => {
		handle.close();
		rmSync(root, { recursive: true, force: true });
	});

	const host = (): CompileHost => ({
		caps: {
			userns: pass({ unprivileged: true } as never),
			bwrap: pass({ version: "0.13.1", disableUserns: true }),
			systemd: pass({
				hostKind: "native",
				manager: true,
				delegated: ["cpu", "memory", "pids"],
				missing: [],
			}),
			arch: pass("x86_64"),
		},
		bwrapPath: BWRAP as string,
		envPath: ENV as string,
		systemdRunPath: "/unused/systemd-run",
		toolchain: discoverToolchain({
			home: join(root, "home"),
			binaries: [],
			path: "",
		}),
		home: join(root, "home"),
		mfwHome: join(root, "mfw"),
		allowedRoots: [],
		realpath: (p) => {
			try {
				return realpathSync(p);
			} catch {
				return null;
			}
		},
	});

	test("is closed when the probe returns", async () => {
		const r = await attestSandbox({
			db: handle.db,
			runId: "sealed-fds",
			profile: parseSandboxProfile({ version: 1, role: "trigger" }),
			host: host(),
			targets: {
				home: join(root, "home"),
				mfwHome: join(root, "mfw"),
				protectedPaths: [],
				fleetExecBaseline: [],
			},
			scope: "none",
			timeoutMs: 40_000,
		});
		expect(r.ok).toBe(true);
		expect(sealedOpen()).toBe(0);
	}, 45_000);
});
