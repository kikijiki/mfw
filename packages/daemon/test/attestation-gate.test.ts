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
import type { LaunchAuthorization } from "../src/containment/launch-authorization.ts";
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
		approvalMode: "autonomous",
		profile: profile(),
		compiled: c,
		bwrapVersion: "0.13.1",
	});

async function authorized(c: CompiledSandbox): Promise<LaunchAuthorization> {
	const d = await authorize(c);
	if (!d.ok || !d.authorization) throw new Error("the gate refused");
	return d.authorization;
}

const launchAutonomous = (
	c: CompiledSandbox,
	authorization: LaunchAuthorization,
) => launchSandbox(c, { approvalMode: "autonomous", authorization });

function codeOf(fn: () => unknown): string | null {
	try {
		fn();
		return null;
	} catch (err) {
		if (err instanceof SandboxLaunchError) return err.code;
		throw err;
	}
}

describe.skipIf(skip !== null)("the autonomy requirement", () => {
	test("an autonomous launch with no attestation is refused", async () => {
		const d = await authorizeAutonomousLaunch(handle.db, {
			runId: "no-record",
			approvalMode: "autonomous",
			flags: [],
			profile: profile(),
			compiled: compile(),
			bwrapVersion: "0.13.1",
		} as never);
		expect(d.ok).toBe(false);
	});

	for (const approvalMode of [undefined, "yolo", "AUTONOMOUS", null, 1]) {
		test(`approvalMode ${JSON.stringify(approvalMode)} is refused by the gate and the launcher`, async () => {
			const c = compile();
			await record(c);
			const d = await authorizeAutonomousLaunch(handle.db, {
				runId: "r1",
				approvalMode,
				profile: profile(),
				compiled: c,
				bwrapVersion: "0.13.1",
			} as never);
			expect(d.ok).toBe(false);
			if (!d.ok) expect(d.code).toBe("approval_mode_invalid");
			expect(codeOf(() => launchSandbox(c, { approvalMode } as never))).toBe(
				"invalid_approval_mode",
			);
		});
	}

	test("an interactive launch needs no attestation and gets no authorization", async () => {
		const d = await authorizeAutonomousLaunch(handle.db, {
			runId: "no-record",
			approvalMode: "interactive",
			profile: profile(),
			compiled: compile(),
			bwrapVersion: "0.13.1",
		});
		expect(d).toEqual({ ok: true, attestationId: null, authorization: null });
	});

	test("a look-alike authorization is refused", () => {
		for (const authorization of [{}, null, "token", Object.freeze({})]) {
			expect(
				codeOf(() =>
					launchAutonomous(
						compile(),
						authorization as unknown as LaunchAuthorization,
					),
				),
			).toBe("not_authorized");
		}
	});

	test("an authorization works once, for its own sandbox", async () => {
		const c = compile();
		await record(c);
		const authorization = await authorized(c);
		expect(codeOf(() => launchAutonomous(compile(), authorization))).toBe(
			"not_authorized",
		);
		expect(codeOf(() => launchAutonomous(c, authorization))).toBe(
			"not_authorized",
		);
	});

	test("only the gate can issue an authorization", async () => {
		const src = resolve(import.meta.dir, "../src");
		const users: string[] = [];
		for await (const rel of new Bun.Glob("**/*.ts").scan({ cwd: src })) {
			if (rel === "containment/launch-authorization.ts") continue;
			const text = await Bun.file(join(src, rel)).text();
			if (text.includes("issueLaunchAuthorization")) users.push(rel);
		}
		expect(users).toEqual(["containment/attestation-gate.ts"]);
	});

	test("the launcher refuses an autonomous launch without an authorization", () => {
		expect(() =>
			launchSandbox(compile(), {
				scope: "none",
				approvalMode: "autonomous",
			} as never),
		).toThrow(SandboxLaunchError);
		expect(existsSync(join(work, "ran"))).toBe(false);
	});
});

describe.skipIf(skip !== null)("the launch binaries and scope", () => {
	const fingerprintWith = (over: Partial<CompileHost>) => {
		const r = compileBwrap(profile(), ["sh", "-c", "true"], {
			...compileHost(),
			...over,
		});
		if (!r.ok) throw new Error(r.reason);
		return sandboxFingerprint(profile(), r).optionsHash;
	};

	test("another bwrap or env binary changes the fingerprint", () => {
		const base = fingerprintWith({});
		expect(fingerprintWith({ bwrapPath: "/tmp/not-bwrap" })).not.toBe(base);
		expect(fingerprintWith({ envPath: "/tmp/not-env" })).not.toBe(base);
	});

	test("the command itself stays out of the fingerprint", () => {
		const other = compile("touch /work/other");
		expect(sandboxFingerprint(profile(), other)).toEqual(
			sandboxFingerprint(profile(), compile()),
		);
	});

	test("an authorized launch cannot drop the scope", async () => {
		const c = compile();
		await record(c);
		const authorization = await authorized(c);
		expect(
			codeOf(() =>
				launchSandbox(c, {
					approvalMode: "autonomous",
					authorization,
					scope: "none",
				}),
			),
		).toBe("scope_required");
		expect(existsSync(join(work, "ran"))).toBe(false);
	});

	test("an authorized launch really goes through the scope binary", async () => {
		const marker = join(root, "scope-ran");
		writeFileSync(
			scopeStub,
			`#!${SH}\n: > ${marker}\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n`,
			{ mode: 0o755 },
		);
		const c = compile();
		await record(c);
		const child = launchAutonomous(c, await authorized(c));
		(child.stdin as unknown as { end(): void }).end();
		expect(await child.exited).toBe(0);
		expect(existsSync(marker)).toBe(true);
	});
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
		const authorization = await authorized(c);
		renameSync(work, `${work}-old`);
		mkdirSync(work);
		expect(codeOf(() => launchAutonomous(c, authorization))).toBe(
			"pin_changed",
		);
		expect(existsSync(join(work, "ran"))).toBe(false);
	});

	test("the launcher runs a workspace that is still the probed one", async () => {
		const c = compile();
		await record(c);
		const child = launchAutonomous(c, await authorized(c));
		(child.stdin as unknown as { end(): void }).end();
		expect(await child.exited).toBe(0);
		expect(existsSync(join(work, "ran"))).toBe(true);
	});
});
