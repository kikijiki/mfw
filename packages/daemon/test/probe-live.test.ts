import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import net from "node:net";
import { join, resolve } from "node:path";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import { authorizeAutonomousLaunch } from "../src/containment/attestation-gate.ts";
import { latestAttestation } from "../src/containment/attestation-store.ts";
import {
	type CompiledSandbox,
	type CompileHost,
	compileBwrap,
} from "../src/containment/compile-bwrap.ts";
import type { Check } from "../src/containment/host-caps.ts";
import { PROBE_READY, PROBE_RESULT } from "../src/containment/probe-child.ts";
import type {
	CgroupObservation,
	ProbeItemId,
	ProbeItemResult,
} from "../src/containment/probe-evaluate.ts";
import {
	type AttestResult,
	attestSandbox,
	buildProbePlan,
	collectProbe,
	decodeBwrapOptions,
	probeCommand,
	probeToolchainTargets,
	sandboxFingerprint,
} from "../src/containment/probe-run.ts";
import {
	parseSandboxProfile,
	type SandboxProfile,
} from "../src/containment/profile.ts";
import { discoverToolchain } from "../src/containment/toolchain.ts";

/**
 * The probe under real bwrap, against throwaway fixtures. Each negative
 * weakens the compiled sandbox in one way and must fail the matching item.
 * The weakenings only add fixture paths, drop isolation flags or add harmless
 * read-only mounts, and the probe itself writes nothing outside its sandbox.
 */

const REPO = resolve(import.meta.dir, "../../..");
const FIXTURES = join(REPO, ".live-sandbox");
const BWRAP = Bun.which("bwrap");
const ENV = Bun.which("env");
const BUN = Bun.which("bun") ?? process.execPath;

function liveSkipReason(): string | null {
	if (process.arch !== "x64") return "seccomp is x86_64 only";
	if (!BWRAP || !ENV) return "no bwrap";
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

function systemdSkipReason(): string {
	const r = Bun.spawnSync(["systemctl", "--user", "is-system-running"]);
	const state = r.stdout.toString().trim();
	return state === "running" || state === "degraded"
		? ""
		: `no systemd user manager (${state || "unavailable"})`;
}

const skip = liveSkipReason();
if (skip) console.log(`[probe-live] skipped: ${skip}`);
const noScope = skip ?? systemdSkipReason();
if (noScope) {
	console.log(`[probe-live] real scope chain NOT VERIFIED: ${noScope}`);
}

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
let handle: ProjectDbHandle;

beforeEach(async () => {
	mkdirSync(FIXTURES, { recursive: true });
	root = realpathSync(mkdtempSync(join(FIXTURES, "probe-")));
	home = join(root, "fake-home");
	mfw = join(root, "mfw");
	work = join(mfw, "runs/r1/work");
	mkdirSync(join(home, ".ssh"), { recursive: true });
	writeFileSync(join(home, ".ssh/id_canary"), "not a real key\n");
	mkdirSync(work, { recursive: true });
	handle = await openProjectDb(join(root, "db"));
});

afterEach(() => {
	handle.close();
	rmSync(root, { recursive: true, force: true });
});

function compileHost(over: Partial<CompileHost> = {}): CompileHost {
	return {
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
		systemdRunPath: Bun.which("systemd-run") ?? "/unused/systemd-run",
		toolchain: discoverToolchain({
			home,
			binaries: ["bun"],
			path: `${resolve(BUN, "..")}:${process.env.PATH ?? ""}`,
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
		...over,
	};
}

const baseProfile = (over: Record<string, unknown> = {}): SandboxProfile =>
	parseSandboxProfile({
		version: 1,
		role: "task",
		filesystem: {
			workspace: { source: work, access: "rw" },
			toolchain: { binaries: ["bun"] },
		},
		...over,
	});

const targets = () => ({
	home,
	mfwHome: mfw,
	protectedPaths: [join(home, ".ssh")],
});

/** A host-side scope reading matching the profile's limits. */
const honestScope =
	(tasksMax = 256, memory = 1024 ** 3) =>
	(): CgroupObservation => ({
		path: "/user.slice/test.scope",
		memoryMax: String(memory),
		pidsMax: String(tasksMax),
		swapMax: "0",
	});

const encode = (options: readonly string[]) =>
	Buffer.from(options.map((o) => `${o}\0`).join(""));

/** Rewrite the bwrap options of a compiled sandbox. */
const withOptions =
	(change: (options: string[]) => string[]) =>
	(c: CompiledSandbox): CompiledSandbox => ({
		...c,
		bwrapArgs: encode(change(decodeBwrapOptions(c.bwrapArgs))),
	});

/** Add options where the root tmpfs is still writable. */
const beforeRemount = (...added: string[]) =>
	withOptions((o) => {
		const at = o.findIndex((x, i) => x === "--remount-ro" && o[i + 1] === "/");
		return [...o.slice(0, at), ...added, ...o.slice(at)];
	});

const without = (...flags: string[]) =>
	withOptions((o) => o.filter((x) => !flags.includes(x)));

const NAMESPACES_NO_NET = [
	"--unshare-user",
	"--unshare-ipc",
	"--unshare-pid",
	"--unshare-uts",
	"--unshare-cgroup",
];

async function attest(
	weaken?: (c: CompiledSandbox) => CompiledSandbox,
	profile = baseProfile(),
): Promise<AttestResult> {
	const r = await attestSandbox({
		db: handle.db,
		runId: "r1",
		profile,
		host: compileHost(),
		targets: targets(),
		// The launch has no scope in the cage. The plan still expects one, so
		// `readCgroup` is the only stand-in and every other item is real.
		scope: "none",
		timeoutMs: 40_000,
		weaken,
	});
	if (!r.ok) throw new Error(`attest refused: ${r.reason}`);
	return r;
}

const failed = (items: readonly ProbeItemResult[]) =>
	items.filter((i) => i.status === "fail").map((i) => i.id);

/** True when the child really reported, rather than every item failing as one. */
const measured = (items: readonly ProbeItemResult[]) =>
	items.some((i) => i.status === "pass");

/** Everything but the scope, which the cage cannot provide. */
const failedBesidesScope = (items: readonly ProbeItemResult[]) =>
	failed(items).filter((id) => id !== "cgroup_limits");

describe.skipIf(skip !== null)("the probe in a real sandbox", () => {
	test("an honest sandbox passes every item but the unproven scope", async () => {
		const r = await attest();
		expect(failedBesidesScope(r.items)).toEqual([]);
		expect(failed(r.items)).toEqual(["cgroup_limits"]);
		expect(r.outcome).toBe("fail");
	}, 45_000);

	test("with a host-observed scope, every item passes", async () => {
		const profile = baseProfile();
		const host = compileHost();
		const compiled = compileBwrap(
			profile,
			probeCommand(host.toolchain.resolved[0]?.path as string),
			host,
		) as CompiledSandbox;
		const server = net.createServer((s) => s.destroy());
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		const plan = buildProbePlan(
			profile,
			compiled,
			{
				...targets(),
				...probeToolchainTargets(host.toolchain),
				realpath: host.realpath,
			},
			{
				nonce: "live-nonce",
				loopbackPort: (server.address() as net.AddressInfo).port,
				scope: "systemd",
			},
		);
		const items = await collectProbe(compiled, plan, {
			scope: "none",
			readCgroup: honestScope(),
			timeoutMs: 40_000,
		});
		await new Promise<void>((r) => server.close(() => r()));
		expect(items.filter((i) => i.status !== "pass")).toEqual([]);
	}, 45_000);

	test("a toolchain root may recreate part of the home, the rest stays absent", async () => {
		const bunDir = join(home, ".bun/bin");
		mkdirSync(bunDir, { recursive: true });
		const bunHere = join(bunDir, "bun");
		writeFileSync(bunHere, readFileSync(realpathSync(BUN)), { mode: 0o755 });
		writeFileSync(join(home, "notes.txt"), "private\n");
		const host = compileHost({
			toolchain: discoverToolchain({
				home,
				binaries: ["bun"],
				path: `${bunDir}:${process.env.PATH ?? ""}`,
			}),
		});
		const ok = await attestSandbox({
			db: handle.db,
			runId: "r1",
			profile: baseProfile(),
			host,
			targets: targets(),
			scope: "none",
			timeoutMs: 40_000,
		});
		if (!ok.ok) throw new Error(ok.reason);
		expect(failedBesidesScope(ok.items)).toEqual([]);

		// The same layout with one more file of the real home bound in.
		const leaked = await attestSandbox({
			db: handle.db,
			runId: "r1",
			profile: baseProfile(),
			host,
			targets: targets(),
			scope: "none",
			timeoutMs: 40_000,
			weaken: beforeRemount(
				"--ro-bind",
				join(home, "notes.txt"),
				join(home, "notes.txt"),
			),
		});
		if (!leaked.ok) throw new Error(leaked.reason);
		expect(failed(leaked.items)).toContain("home_absent");
	}, 90_000);

	const LIVE: [
		ProbeItemId,
		string,
		() => (c: CompiledSandbox) => CompiledSandbox,
	][] = [
		["compiled_flags", "--new-session dropped", () => without("--new-session")],
		[
			"net_routes",
			"the host network is shared",
			() =>
				withOptions((o) => [
					...NAMESPACES_NO_NET,
					...o.filter((x) => x !== "--unshare-all" && x !== "--unshare-user"),
				]),
		],
		[
			"net_host_reach",
			"the host loopback is reachable",
			() =>
				withOptions((o) => [
					...NAMESPACES_NO_NET,
					...o.filter((x) => x !== "--unshare-all" && x !== "--unshare-user"),
				]),
		],
		[
			"net_dns",
			"resolv.conf is bound",
			() => {
				writeFileSync(join(root, "resolv"), "nameserver 192.0.2.1\n");
				return beforeRemount(
					"--ro-bind",
					join(root, "resolv"),
					"/etc/resolv.conf",
				);
			},
		],
		[
			"seccomp_eperm",
			"no seccomp filter",
			() =>
				withOptions((o) => {
					const at = o.indexOf("--seccomp");
					return [...o.slice(0, at), ...o.slice(at + 2)];
				}),
		],
		[
			"userns_denied",
			"neither userns barrier",
			() =>
				withOptions((o) => {
					const at = o.indexOf("--seccomp");
					return [...o.slice(0, at), ...o.slice(at + 2)].filter(
						(x) => x !== "--disable-userns",
					);
				}),
		],
		[
			"open_fds",
			"the seccomp descriptor stays open",
			() =>
				withOptions((o) => {
					const at = o.indexOf("--seccomp");
					return [...o.slice(0, at), ...o.slice(at + 2)];
				}),
		],
		[
			"caps_empty",
			"a capability is kept",
			() =>
				withOptions((o) => {
					const at = o.indexOf("--cap-drop");
					return [
						...o.slice(0, at),
						"--cap-add",
						"CAP_NET_RAW",
						...o.slice(at + 2),
					];
				}),
		],
		[
			"mounts_writable",
			"an extra writable bind",
			() => {
				mkdirSync(join(root, "extra"));
				return beforeRemount("--bind", join(root, "extra"), "/scratch-extra");
			},
		],
		[
			"root_readonly",
			"the root stays writable",
			() =>
				withOptions((o) => {
					const at = o.findIndex(
						(x, i) => x === "--remount-ro" && o[i + 1] === "/",
					);
					return [...o.slice(0, at), ...o.slice(at + 2)];
				}),
		],
		[
			"secrets_absent",
			"the fixture .ssh is bound",
			() => beforeRemount("--ro-bind", join(home, ".ssh"), join(home, ".ssh")),
		],
		[
			"home_absent",
			"a home file is bound",
			() => {
				writeFileSync(join(home, "notes.txt"), "private\n");
				return beforeRemount(
					"--ro-bind",
					join(home, "notes.txt"),
					join(home, "notes.txt"),
				);
			},
		],
		[
			"env_clean",
			"an extra variable",
			() =>
				withOptions((o) => {
					const at = o.indexOf("--setenv");
					return [
						...o.slice(0, at),
						"--setenv",
						"DAEMON_TOKEN",
						"x",
						...o.slice(at),
					];
				}),
		],
		[
			"dev_console",
			"/dev/console is bound",
			() => {
				writeFileSync(join(root, "console"), "");
				return beforeRemount(
					"--ro-bind",
					join(root, "console"),
					"/dev/console",
				);
			},
		],
		[
			"sys_absent",
			"/sys is mounted",
			() => beforeRemount("--ro-bind", "/sys", "/sys"),
		],
		[
			"cgroup_namespace",
			"the cgroup namespace is shared",
			() =>
				withOptions((o) => [
					"--unshare-user",
					"--unshare-ipc",
					"--unshare-pid",
					"--unshare-uts",
					"--unshare-net",
					...o.filter((x) => x !== "--unshare-all" && x !== "--unshare-user"),
				]),
		],
	];

	for (const [item, name, weaken] of LIVE) {
		test(`${item} fails when ${name}`, async () => {
			const r = await attest(weaken());
			// A sandbox that failed to start fails every item and proves nothing.
			expect(measured(r.items)).toBe(true);
			expect(failed(r.items)).toContain(item);
			expect(r.outcome).toBe("fail");
		}, 45_000);
	}

	test("socket_sweep finds a socket in the workspace", async () => {
		const path = join(work, "agent.sock");
		const server = net.createServer();
		await new Promise<void>((r) => server.listen(path, r));
		try {
			const r = await attest();
			expect(failed(r.items)).toContain("socket_sweep");
		} finally {
			await new Promise<void>((r) => server.close(() => r()));
		}
	}, 45_000);

	test("socket_sweep follows a directory whose name is not UTF-8", async () => {
		const plain = join(work, "plain");
		mkdirSync(plain);
		const server = net.createServer();
		await new Promise<void>((r) => server.listen(join(plain, "s.sock"), r));
		const raw = Buffer.concat([
			Buffer.from(`${work}/`),
			Buffer.from([0xff, 0xfe]),
		]);
		renameSync(plain, raw);
		try {
			const r = await attest();
			expect(measured(r.items)).toBe(true);
			expect(failed(r.items)).toContain("socket_sweep");
		} finally {
			renameSync(raw, plain);
			await new Promise<void>((r) => server.close(() => r()));
		}
	}, 45_000);

	test("socket_sweep refuses an execute-only directory in a read-only bind", async () => {
		const cache = join(mfw, "runs/r1/cache");
		const hidden = join(cache, "hidden");
		mkdirSync(hidden, { recursive: true });
		const server = net.createServer();
		await new Promise<void>((r) => server.listen(join(hidden, "s.sock"), r));
		chmodSync(hidden, 0o111);
		try {
			const r = await attest(
				undefined,
				baseProfile({
					filesystem: {
						workspace: { source: work, access: "rw" },
						caches: [{ name: "shared", source: cache, access: "ro" }],
						toolchain: { binaries: ["bun"] },
					},
				}),
			);
			expect(measured(r.items)).toBe(true);
			expect(failed(r.items)).toContain("socket_sweep");
		} finally {
			chmodSync(hidden, 0o755);
			await new Promise<void>((r) => server.close(() => r()));
		}
	}, 45_000);

	test("a symlinked home does not hide its real path", async () => {
		const realHome = join(root, "real-home");
		mkdirSync(join(realHome, ".ssh"), { recursive: true });
		writeFileSync(join(realHome, ".ssh/id_canary"), "not a real key\n");
		const linkHome = join(root, "link-home");
		symlinkSync(realHome, linkHome);
		const r = await attestSandbox({
			db: handle.db,
			runId: "r1",
			profile: baseProfile(),
			host: compileHost({
				home: linkHome,
				toolchain: discoverToolchain({
					home: linkHome,
					binaries: ["bun"],
					path: `${resolve(BUN, "..")}:${process.env.PATH ?? ""}`,
				}),
			}),
			targets: {
				home: linkHome,
				mfwHome: mfw,
				protectedPaths: [join(linkHome, ".ssh")],
			},
			scope: "none",
			timeoutMs: 40_000,
			weaken: beforeRemount(
				"--ro-bind",
				join(realHome, ".ssh"),
				join(realHome, ".ssh"),
			),
		});
		if (!r.ok) throw new Error(r.reason);
		expect(measured(r.items)).toBe(true);
		expect(failed(r.items)).toContain("secrets_absent");
		expect(failed(r.items)).toContain("home_absent");
	}, 45_000);

	test("exec_sweep finds a planted git hook", async () => {
		mkdirSync(join(work, ".git/hooks"), { recursive: true });
		writeFileSync(join(work, ".git/hooks/pre-commit.sample"), "#!/bin/sh\n");
		const clean = await attest();
		expect(failed(clean.items)).not.toContain("exec_sweep");
		writeFileSync(join(work, ".git/hooks/post-checkout"), "#!/bin/sh\n", {
			mode: 0o755,
		});
		const r = await attest();
		expect(failed(r.items)).toContain("exec_sweep");
	}, 90_000);

	test("pid1_cmdline finds a secret in the command", async () => {
		const secret = "canary-cmdline-secret";
		const r = await attest(
			(c) => ({ ...c, argv: [...c.argv, secret] }),
			baseProfile({ process: { env: { ANTHROPIC_API_KEY: secret } } }),
		);
		expect(failed(r.items)).toContain("pid1_cmdline");
		expect(JSON.stringify(r.items)).not.toContain(secret);
	}, 45_000);

	test("egress_only passes on the run's socket and fails without it", async () => {
		const dir = join(mfw, "runs/r1/egress");
		mkdirSync(dir);
		const profile = baseProfile({
			network: { mode: "proxy", socketDir: dir },
		});
		const missing = await attest(undefined, profile);
		expect(failed(missing.items)).toContain("egress_only");

		const server = net.createServer((s) => s.destroy());
		await new Promise<void>((r) => server.listen(join(dir, "proxy.sock"), r));
		try {
			const ok = await attest(undefined, profile);
			expect(failedBesidesScope(ok.items)).toEqual([]);
		} finally {
			await new Promise<void>((r) => server.close(() => r()));
		}
	}, 90_000);
});

describe.skipIf(skip !== null)("forged results", () => {
	/** A sandboxed command standing in for a compromised probe. */
	async function runForger(script: string): Promise<ProbeItemResult[]> {
		const profile = parseSandboxProfile({
			version: 1,
			role: "task",
			filesystem: {
				workspace: { source: work, access: "rw" },
				toolchain: { binaries: ["sh", "cat"] },
			},
		});
		const host = compileHost({
			toolchain: discoverToolchain({
				home,
				binaries: ["sh", "cat"],
				path: process.env.PATH ?? "",
			}),
		});
		const compiled = compileBwrap(
			profile,
			["sh", "-c", script],
			host,
		) as CompiledSandbox;
		expect(compiled.ok).toBe(true);
		const plan = buildProbePlan(
			profile,
			compiled,
			{
				...targets(),
				...probeToolchainTargets(host.toolchain),
				realpath: host.realpath,
			},
			{ nonce: "the-real-nonce", loopbackPort: 1, scope: "systemd" },
		);
		return collectProbe(compiled, plan, {
			scope: "none",
			readCgroup: honestScope(),
			timeoutMs: 10_000,
		});
	}

	const allFailed = (items: readonly ProbeItemResult[]) =>
		items.length > 0 && items.every((i) => i.status === "fail");

	test("a passing-looking result with another nonce is refused", async () => {
		const forged = JSON.stringify({ nonce: "guessed", verdict: "pass" });
		const items = await runForger(
			`echo ${PROBE_READY}; cat >/dev/null; printf '%s\\n' '${PROBE_RESULT} ${forged}'`,
		);
		expect(allFailed(items)).toBe(true);
	}, 15_000);

	test("output around the result is refused", async () => {
		const items = await runForger(
			`echo ${PROBE_READY}; cat >/dev/null; echo extra; echo '${PROBE_RESULT} {}'`,
		);
		expect(allFailed(items)).toBe(true);
	}, 15_000);

	test("a nonzero exit is refused", async () => {
		const items = await runForger(
			`echo ${PROBE_READY}; cat >/dev/null; exit 3`,
		);
		expect(allFailed(items)).toBe(true);
	}, 15_000);

	test("a child that never answers times out into a refusal", async () => {
		const profile = baseProfile();
		const host = compileHost();
		const compiled = compileBwrap(
			profile,
			[
				host.toolchain.resolved[0]?.path as string,
				"-e",
				"await Bun.sleep(60000)",
			],
			host,
		) as CompiledSandbox;
		const plan = buildProbePlan(
			profile,
			compiled,
			{
				...targets(),
				...probeToolchainTargets(host.toolchain),
				realpath: host.realpath,
			},
			{ nonce: "n", loopbackPort: 1, scope: "systemd" },
		);
		const items = await collectProbe(compiled, plan, {
			scope: "none",
			timeoutMs: 1_500,
		});
		expect(allFailed(items)).toBe(true);
		expect(items[0]?.detail).toContain("timed out");
	}, 15_000);

	test("a result file written in the workspace is ignored", async () => {
		const forged = {
			outcome: "pass",
			items: [{ id: "caps_empty", status: "pass", detail: "ok" }],
		};
		for (const name of ["probe-result.json", "attestation.json"]) {
			writeFileSync(join(work, name), JSON.stringify(forged));
		}
		const r = await attest(without("--disable-userns"));
		expect(failed(r.items)).toContain("compiled_flags");
		expect(r.outcome).toBe("fail");
		const row = await latestAttestation(handle.db, "r1");
		expect(row?.outcome).toBe("fail");
	}, 45_000);

	test("a planted bunfig preload and .env do not run in the probe", async () => {
		const marker = "/work/preload-ran";
		writeFileSync(
			join(work, "preload.ts"),
			`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x");
			console.log("${PROBE_RESULT} forged");`,
		);
		writeFileSync(
			join(work, "bunfig.toml"),
			'preload = ["./preload.ts"]\n[run]\npreload = ["./preload.ts"]\n',
		);
		writeFileSync(join(work, ".env"), "DAEMON_TOKEN=from-dotenv\n");
		const r = await attest();
		expect(existsSync(join(work, "preload-ran"))).toBe(false);
		expect(failedBesidesScope(r.items)).toEqual([]);
	}, 45_000);

	test("the positive control: without the flags that preload does run", () => {
		writeFileSync(
			join(work, "preload.ts"),
			'require("node:fs").writeFileSync("preload-ran", "x");',
		);
		writeFileSync(join(work, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
		Bun.spawnSync([BUN, "-e", "0"], { cwd: work, env: {} });
		expect(existsSync(join(work, "preload-ran"))).toBe(true);
	});

	test("the gate refuses what the caged probe recorded", async () => {
		const profile = baseProfile();
		await attest(undefined, profile);
		const host = compileHost();
		const compiled = compileBwrap(
			profile,
			["/agent", "--yolo"],
			host,
		) as CompiledSandbox;
		const d = await authorizeAutonomousLaunch(handle.db, {
			runId: "r1",
			flags: ["yolo"],
			profile,
			compiled,
			bwrapVersion: "0.13.1",
		});
		expect(d.ok).toBe(false);
		if (!d.ok) expect(d.code).toBe("attestation_failed");
	}, 45_000);

	test("the probe and the agent launch fingerprint as one sandbox", () => {
		const profile = baseProfile();
		const host = compileHost();
		const probe = compileBwrap(
			profile,
			probeCommand(host.toolchain.resolved[0]?.path as string),
			host,
		) as CompiledSandbox;
		const agent = compileBwrap(profile, ["/agent", "--yolo"], {
			...host,
			unit: "mfw-run-r1",
		}) as CompiledSandbox;
		expect(sandboxFingerprint(profile, agent)).toEqual(
			sandboxFingerprint(profile, probe),
		);
		const wider = baseProfile({
			filesystem: {
				workspace: { source: work, access: "ro" },
				toolchain: { binaries: ["bun"] },
			},
		});
		const other = compileBwrap(wider, ["/agent"], host) as CompiledSandbox;
		expect(sandboxFingerprint(wider, other).optionsHash).not.toBe(
			sandboxFingerprint(profile, probe).optionsHash,
		);
	});

	test("the serialized child survives a minified bundle", async () => {
		const entry = join(root, "entry.ts");
		const childModule = join(
			import.meta.dir,
			"../src/containment/probe-child.ts",
		);
		writeFileSync(
			entry,
			`import { probeChildSource } from ${JSON.stringify(childModule)};
			await Bun.write(process.argv[2], probeChildSource());`,
		);
		const out = join(root, "bundle.js");
		const built = await Bun.build({
			entrypoints: [entry],
			target: "bun",
			minify: true,
		});
		expect(built.success).toBe(true);
		await Bun.write(out, built.outputs[0] as Blob);
		const source = join(root, "child.js");
		expect(Bun.spawnSync([BUN, out, source], { cwd: root }).exitCode).toBe(0);
		const profile = baseProfile();
		const host = compileHost();
		const command = probeCommand(host.toolchain.resolved[0]?.path as string);
		command[command.length - 1] = readFileSync(source, "utf8");
		const compiled = compileBwrap(profile, command, host) as CompiledSandbox;
		const server = net.createServer((s) => s.destroy());
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		const plan = buildProbePlan(
			profile,
			compiled,
			{
				...targets(),
				...probeToolchainTargets(host.toolchain),
				realpath: host.realpath,
			},
			{
				nonce: "bundled",
				loopbackPort: (server.address() as net.AddressInfo).port,
				scope: "systemd",
			},
		);
		const items = await collectProbe(compiled, plan, {
			scope: "none",
			readCgroup: honestScope(),
			timeoutMs: 40_000,
		});
		await new Promise<void>((r) => server.close(() => r()));
		expect(items.filter((i) => i.status !== "pass")).toEqual([]);
	}, 45_000);

	test("a launch with no autonomous flag needs no attestation", async () => {
		const profile = baseProfile();
		const compiled = compileBwrap(
			profile,
			["/agent"],
			compileHost(),
		) as CompiledSandbox;
		const d = await authorizeAutonomousLaunch(handle.db, {
			runId: "no-record",
			flags: [],
			profile,
			compiled,
			bwrapVersion: "0.13.1",
		});
		expect(d).toEqual({ ok: true, attestationId: null });
	});

	test("a profile without bun cannot be attested", async () => {
		const r = await attestSandbox({
			db: handle.db,
			runId: "r1",
			profile: parseSandboxProfile({ version: 1, role: "task" }),
			host: compileHost(),
			targets: targets(),
			scope: "none",
		});
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.code).toBe("probe_runtime_missing");
			expect(r.fix).toContain("bun");
		}
	});
});

describe.skipIf(noScope !== "")("the real systemd scope chain", () => {
	test("a probe under the scope passes and satisfies the gate", async () => {
		const profile = baseProfile();
		const host = compileHost();
		const r = await attestSandbox({
			db: handle.db,
			runId: "r1",
			profile,
			host,
			targets: targets(),
			scope: "systemd",
			timeoutMs: 40_000,
		});
		if (!r.ok) throw new Error(r.reason);
		expect(failed(r.items)).toEqual([]);
		const compiled = compileBwrap(profile, ["/agent"], host) as CompiledSandbox;
		const d = await authorizeAutonomousLaunch(handle.db, {
			runId: "r1",
			flags: ["yolo"],
			profile,
			compiled,
			bwrapVersion: "0.13.1",
		});
		expect(d.ok).toBe(true);
	}, 45_000);
});
