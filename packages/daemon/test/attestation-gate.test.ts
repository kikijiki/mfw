import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import { authorizeAutonomousLaunch } from "../src/containment/attestation-gate.ts";
import {
	consumeAttestation,
	recordAttestation,
} from "../src/containment/attestation-store.ts";
import {
	type CompiledSandbox,
	type CompileHost,
	compileBwrap,
} from "../src/containment/compile-bwrap.ts";
import type { Check } from "../src/containment/host-caps.ts";
import {
	launchSandbox,
	SandboxLaunchError,
} from "../src/containment/launch-sandbox.ts";
import { PROBE_ITEMS } from "../src/containment/probe-evaluate.ts";
import { sandboxFingerprint } from "../src/containment/probe-run.ts";
import {
	parseSandboxProfile,
	type SandboxProfile,
} from "../src/containment/profile.ts";
import { discoverToolchain } from "../src/containment/toolchain.ts";

/**
 * The gate and the launcher together, on throwaway fixtures. The scope binary
 * is a stub that execs its command, because the cage has no user manager; the
 * real chain is covered (and skipped here) in probe-live.test.ts.
 */

const REPO = resolve(import.meta.dir, "../../..");
const FIXTURES = join(REPO, ".live-sandbox");
const BWRAP = Bun.which("bwrap");
const ENV = Bun.which("env");
const SH = Bun.which("sh");

function skipReason(): string | null {
	if (process.arch !== "x64") return "seccomp is x86_64 only";
	if (!BWRAP || !ENV || !SH) return "no bwrap";
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
	return r.exitCode === 0
		? null
		: `bwrap cannot run here: ${r.stderr.toString().trim()}`;
}

const skip = skipReason();
if (skip) console.log(`[attestation-gate] skipped: ${skip}`);

const pass = <T>(value: T): Check<T> => ({
	ok: true,
	severity: "required",
	value,
	detail: "ok",
});

let root: string;
let home: string;
let mfw: string;
let work: string;
let scopeStub: string;
let handle: ProjectDbHandle;

beforeEach(async () => {
	mkdirSync(FIXTURES, { recursive: true });
	root = realpathSync(mkdtempSync(join(FIXTURES, "gate-")));
	home = join(root, "fake-home");
	mfw = join(root, "mfw");
	work = join(mfw, "runs/r1/work");
	mkdirSync(home, { recursive: true });
	mkdirSync(work, { recursive: true });
	scopeStub = join(root, "systemd-run");
	writeFileSync(
		scopeStub,
		`#!${SH}\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n`,
		{ mode: 0o755 },
	);
	handle = await openProjectDb(join(root, "db"));
});

afterEach(() => {
	handle.close();
	rmSync(root, { recursive: true, force: true });
});

const compileHost = (): CompileHost => ({
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
	systemdRunPath: scopeStub,
	toolchain: discoverToolchain({
		home,
		binaries: ["sh", "touch"],
		path: process.env.PATH ?? "",
	}),
	home,
	mfwHome: mfw,
	allowedRoots: [join(mfw, "runs/r1")],
	realpath: (p) => {
		try {
			return realpathSync(p);
		} catch {
			return null;
		}
	},
});

const profile = (): SandboxProfile =>
	parseSandboxProfile({
		version: 1,
		role: "task",
		filesystem: {
			workspace: { source: work, access: "rw" },
			toolchain: { binaries: ["sh", "touch"] },
		},
	});

const compile = (script = "touch /work/ran"): CompiledSandbox => {
	const r = compileBwrap(profile(), ["sh", "-c", script], compileHost());
	if (!r.ok) throw new Error(r.reason);
	return r;
};

const pinsOf = (c: CompiledSandbox) =>
	c.pinnedBinds.map((p) => {
		const st = statSync(p.source, { bigint: true });
		return { dest: p.dest, dev: String(st.dev), ino: String(st.ino) };
	});

const record = (c: CompiledSandbox) =>
	recordAttestation(handle.db, {
		runId: "r1",
		...sandboxFingerprint(profile(), c),
		bwrapVersion: "0.13.1",
		scope: "systemd",
		outcome: "pass",
		items: PROBE_ITEMS.map((id) => ({ id, status: "pass", detail: "ok" })),
		pins: pinsOf(c),
		createdAt: new Date(),
	});

const authorize = (c: CompiledSandbox) =>
	authorizeAutonomousLaunch(handle.db, {
		runId: "r1",
		flags: ["yolo"],
		profile: profile(),
		compiled: c,
		bwrapVersion: "0.13.1",
	});

describe.skipIf(skip !== null)("single-use attestations", () => {
	test("one attestation authorizes one launch", async () => {
		const c = compile();
		await record(c);
		expect((await authorize(c)).ok).toBe(true);
		const again = await authorize(c);
		expect(again.ok).toBe(false);
		if (!again.ok) {
			expect(again.code).toBe("attestation_consumed");
			expect(again.fix.length).toBeGreaterThan(0);
		}
	});

	test("concurrent launches cannot share an attestation", async () => {
		const c = compile();
		await record(c);
		const all = await Promise.all(
			Array.from({ length: 8 }, () => authorize(c)),
		);
		expect(all.filter((d) => d.ok).length).toBe(1);
	});

	test("a failure recorded after the judgement stops the consume", async () => {
		const c = compile();
		const id = await record(c);
		await recordAttestation(handle.db, {
			runId: "r1",
			...sandboxFingerprint(profile(), c),
			bwrapVersion: "0.13.1",
			scope: "systemd",
			outcome: "fail",
			items: PROBE_ITEMS.map((i) => ({ id: i, status: "fail", detail: "x" })),
			pins: pinsOf(c),
			createdAt: new Date(),
		});
		expect(
			await consumeAttestation(handle.db, { id, runId: "r1" }, new Date()),
		).toBe(false);
	});

	test("a fresh probe authorizes the next launch", async () => {
		const c = compile();
		await record(c);
		expect((await authorize(c)).ok).toBe(true);
		await record(c);
		expect((await authorize(c)).ok).toBe(true);
	});

	test("the launcher refuses a workspace replaced after the probe", async () => {
		const c = compile();
		await record(c);
		const expectPins = pinsOf(c);
		renameSync(work, `${work}-old`);
		mkdirSync(work);
		expect(() => launchSandbox(c, { scope: "none", expectPins })).toThrow(
			SandboxLaunchError,
		);
		expect(existsSync(join(work, "ran"))).toBe(false);
	});

	test("the launcher runs a workspace that is still the probed one", async () => {
		const c = compile();
		const child = launchSandbox(c, {
			scope: "none",
			expectPins: pinsOf(c),
		});
		(child.stdin as unknown as { end(): void }).end();
		expect(await child.exited).toBe(0);
		expect(existsSync(join(work, "ran"))).toBe(true);
	});
});
