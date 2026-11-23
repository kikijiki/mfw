import { describe, expect, test } from "bun:test";
import { judgeAttestation } from "../src/containment/attestation-gate.ts";
import {
	ATTESTATION_VERSION,
	type Attestation,
} from "../src/containment/attestation-store.ts";
import type { CompiledSandbox } from "../src/containment/compile-bwrap.ts";
import {
	type CgroupObservation,
	evaluateProbe,
	failAll,
	PROBE_ITEMS,
	type ProbeExpectation,
	type ProbeItemId,
	type ProbeObservations,
	ProbeObservationsSchema,
	probeOutcome,
} from "../src/containment/probe-evaluate.ts";
import { sandboxFingerprint } from "../src/containment/probe-run.ts";
import {
	parseSandboxProfile,
	type SandboxProfile,
} from "../src/containment/profile.ts";

/**
 * One negative per probe item, on the pure layer: each fixture weakens exactly
 * one observation, which must fail that item and make the gate refuse.
 */

const SECRET = "canary-secret-value";
const b64 = (s: string) => Buffer.from(s, "latin1").toString("base64");

const OPTIONS = [
	"--unshare-all",
	"--unshare-user",
	"--disable-userns",
	"--die-with-parent",
	"--new-session",
	"--cap-drop",
	"ALL",
	"--seccomp",
	"3",
	"--remount-ro",
	"/",
];

const expectation = (
	over: Partial<ProbeExpectation> = {},
): ProbeExpectation => ({
	nonce: "n1",
	options: OPTIONS,
	writableMounts: ["/proc", "/tmp", "/work"],
	egress: "none",
	egressDir: "/run/mfw/egress",
	envNames: ["PATH", "HOME", "PWD"],
	secrets: [{ name: "ANTHROPIC_API_KEY", value: SECRET }],
	syscalls: [
		{ name: "bpf", expect: 1, provable: true },
		{ name: "clone3", expect: 38, provable: true },
	],
	scope: "systemd",
	limits: { tasksMax: 256, memoryMaxBytes: 1024 ** 3 },
	sweepTolerated: [],
	seccompFilters: 1,
	...over,
});

const good = (): ProbeObservations => ({
	nonce: "n1",
	network: {
		interfaces: ["lo"],
		routesV4: 0,
		routesV6: 0,
		unixNamed: [],
		loopback: "ECONNREFUSED",
		external: "ENETUNREACH",
		resolvConf: false,
	},
	egress: { present: false, entries: [], connect: null },
	proc: {
		capInh: "0000000000000000",
		capPrm: "0000000000000000",
		capEff: "0000000000000000",
		capBnd: "0000000000000000",
		capAmb: "0000000000000000",
		noNewPrivs: "1",
		seccomp: "2",
		seccompFilters: "1",
	},
	syscallControl: true,
	syscalls: [
		{ name: "bpf", errno: 1 },
		{ name: "clone3", errno: 38 },
	],
	usernsErrno: 1,
	mounts: [
		{ mountPoint: "/", options: ["ro", "nosuid"] },
		{ mountPoint: "/proc", options: ["rw", "nosuid"] },
		{ mountPoint: "/tmp", options: ["rw", "nosuid"] },
		{ mountPoint: "/work", options: ["rw", "nosuid"] },
	],
	rootWrite: "EROFS",
	absentVisible: [],
	homeVisible: [],
	sweep: {
		sockets: [],
		hostRun: [],
		unreadable: [],
		entries: 10,
		truncated: false,
	},
	pid1: {
		cmdline: b64("bwrap\0--args\x004\0"),
		environ: b64(""),
		fds: [
			{ fd: 0, target: "pipe:[1]" },
			{ fd: 4, target: "anon_inode:[eventfd]" },
		],
	},
	envNames: ["PATH", "HOME", "PWD"],
	fds: [
		{ fd: 0, target: "socket:[1]" },
		{ fd: 1, target: "pipe:[2]" },
		{ fd: 2, target: "pipe:[3]" },
		{ fd: 3, target: "/dev/urandom" },
		{ fd: 4, target: "anon_inode:[eventpoll]" },
		{ fd: 10, target: "/proc/2/statm" },
	],
	devConsole: false,
	sysPresent: false,
	cgroup: "0::/\n",
});

const scope = (): CgroupObservation => ({
	path: "/user.slice/run-x.scope",
	memoryMax: String(1024 ** 3),
	pidsMax: "256",
	swapMax: "0",
});

interface Negative {
	item: ProbeItemId;
	name: string;
	weaken?: (o: ProbeObservations) => void;
	expect?: Partial<ProbeExpectation>;
	cgroup?: CgroupObservation | null;
}

const NEGATIVES: Negative[] = [
	{
		item: "compiled_flags",
		name: "--disable-userns was not compiled in",
		expect: { options: OPTIONS.filter((o) => o !== "--disable-userns") },
	},
	{
		item: "compiled_flags",
		name: "--cap-drop is not ALL",
		expect: {
			options: OPTIONS.map((o) => (o === "ALL" ? "CAP_CHOWN" : o)),
		},
	},
	{
		item: "net_routes",
		name: "a default route exists",
		weaken: (o) => {
			o.network.routesV4 = 1;
		},
	},
	{
		item: "net_routes",
		name: "a real interface exists",
		weaken: (o) => {
			o.network.interfaces.push("eth0");
		},
	},
	{
		item: "net_dns",
		name: "resolv.conf is visible",
		weaken: (o) => {
			o.network.resolvConf = true;
		},
	},
	{
		item: "net_host_reach",
		name: "the host loopback canary connected",
		weaken: (o) => {
			o.network.loopback = "connected";
		},
	},
	{
		item: "net_host_reach",
		name: "an external address has a route",
		weaken: (o) => {
			o.network.external = "EINPROGRESS";
		},
	},
	{
		item: "net_host_reach",
		name: "a host unix socket is listed",
		weaken: (o) => {
			o.network.unixNamed.push("/run/user/1000/bus");
		},
	},
	{
		item: "egress_only",
		name: "an egress directory exists on a no-network profile",
		weaken: (o) => {
			o.egress.present = true;
		},
	},
	{
		item: "egress_only",
		name: "the proxy socket does not connect",
		expect: { egress: "proxy" },
		weaken: (o) => {
			o.egress = {
				present: true,
				entries: [{ name: "proxy.sock", type: "socket" }],
				connect: "ECONNREFUSED",
			};
			o.sweep.sockets = ["/run/mfw/egress/proxy.sock"];
		},
	},
	{
		item: "seccomp_eperm",
		name: "a denied syscall reached the kernel",
		weaken: (o) => {
			(o.syscalls[0] as { errno: number }).errno = 22;
		},
	},
	{
		item: "seccomp_eperm",
		name: "a planned syscall was not tried",
		weaken: (o) => {
			o.syscalls.pop();
		},
	},
	{
		item: "seccomp_eperm",
		name: "a wrong result hidden by a later right one",
		weaken: (o) => {
			o.syscalls.unshift({ name: "bpf", errno: 22 });
		},
	},
	{
		item: "seccomp_eperm",
		name: "a syscall reported twice",
		weaken: (o) => {
			o.syscalls.push({ name: "bpf", errno: 1 });
		},
	},
	{
		item: "seccomp_eperm",
		name: "a syscall that was not planned",
		weaken: (o) => {
			o.syscalls.push({ name: "getpid", errno: 1 });
		},
	},
	{
		item: "seccomp_eperm",
		name: "no filter is installed",
		weaken: (o) => {
			o.proc.seccomp = "0";
		},
	},
	{
		item: "seccomp_eperm",
		name: "the filter count is not the launcher's plus one",
		weaken: (o) => {
			o.proc.seccompFilters = "0";
		},
	},
	{
		item: "seccomp_eperm",
		name: "the syscall control failed",
		weaken: (o) => {
			o.syscallControl = false;
		},
	},
	{
		item: "userns_denied",
		name: "a user namespace was created",
		weaken: (o) => {
			o.usernsErrno = 0;
		},
	},
	{
		item: "userns_denied",
		name: "EINVAL is not a denial",
		weaken: (o) => {
			o.usernsErrno = 22;
		},
	},
	{
		item: "caps_empty",
		name: "a bounding capability is held",
		weaken: (o) => {
			o.proc.capBnd = "0000000000000400";
		},
	},
	{
		item: "no_new_privs",
		name: "NoNewPrivs is off",
		weaken: (o) => {
			o.proc.noNewPrivs = "0";
		},
	},
	{
		item: "mounts_writable",
		name: "an extra writable mount",
		weaken: (o) => {
			o.mounts.push({ mountPoint: "/extra", options: ["rw", "nosuid"] });
		},
	},
	{
		item: "mounts_writable",
		name: "an expected mount is read-only",
		weaken: (o) => {
			(o.mounts[3] as { options: string[] }).options = ["ro", "nosuid"];
		},
	},
	{
		item: "mounts_writable",
		name: "a writable mount lacks nosuid",
		weaken: (o) => {
			(o.mounts[3] as { options: string[] }).options = ["rw"];
		},
	},
	{
		item: "root_readonly",
		name: "the root accepted a write",
		weaken: (o) => {
			o.rootWrite = "written";
		},
	},
	{
		item: "secrets_absent",
		name: "a protected path is visible",
		weaken: (o) => {
			o.absentVisible.push("/users/owner/.ssh");
		},
	},
	{
		item: "home_absent",
		name: "the real home shows a file outside the toolchain roots",
		weaken: (o) => {
			o.homeVisible.push("/users/owner/notes.txt");
		},
	},
	{
		item: "socket_sweep",
		name: "a host socket in a bound path",
		weaken: (o) => {
			o.sweep.sockets.push("/work/agent.sock");
		},
	},
	{
		item: "socket_sweep",
		name: "the sweep hit its budget",
		weaken: (o) => {
			o.sweep.truncated = true;
		},
	},
	{
		item: "socket_sweep",
		name: "a writable path could not be swept",
		weaken: (o) => {
			o.sweep.unreadable.push("/work/locked");
		},
	},
	{
		item: "socket_sweep",
		name: "a read-only profile bind could not be swept",
		weaken: (o) => {
			o.sweep.unreadable.push("/cache/shared/hidden");
		},
	},
	{
		item: "exec_sweep",
		name: "a planted git hook",
		weaken: (o) => {
			o.sweep.hostRun.push("/work/.git/hooks/post-checkout");
		},
	},
	{
		item: "pid1_cmdline",
		name: "pid 1's argv holds a secret",
		weaken: (o) => {
			o.pid1.cmdline = b64(`bwrap\0--setenv\0KEY\0${SECRET}\0`);
		},
	},
	{
		item: "pid1_cmdline",
		name: "pid 1's argv is unreadable",
		weaken: (o) => {
			o.pid1.cmdline = null;
		},
	},
	{
		item: "pid1_environ",
		name: "pid 1 has an environment",
		weaken: (o) => {
			o.pid1.environ = b64("DAEMON_TOKEN=x\0");
		},
	},
	{
		item: "pid1_environ",
		name: "pid 1's environment is unreadable",
		weaken: (o) => {
			o.pid1.environ = null;
		},
	},
	{
		item: "env_clean",
		name: "an unexpected variable",
		weaken: (o) => {
			o.envNames.push("DAEMON_TOKEN");
		},
	},
	{
		item: "env_clean",
		name: "an empty listing proves nothing",
		weaken: (o) => {
			o.envNames = [];
		},
	},
	{
		item: "open_fds",
		name: "an inherited file",
		weaken: (o) => {
			o.fds.push({ fd: 7, target: "/users/owner/.ssh/id_ed25519" });
		},
	},
	{
		item: "open_fds",
		name: "an inherited socket above stdio",
		weaken: (o) => {
			o.fds.push({ fd: 7, target: "socket:[9]" });
		},
	},
	{
		item: "open_fds",
		name: "stdin is a terminal",
		weaken: (o) => {
			(o.fds[0] as { target: string }).target = "/dev/pts/3";
		},
	},
	{
		item: "open_fds",
		name: "pid 1 holds a file",
		weaken: (o) => {
			o.pid1.fds?.push({ fd: 5, target: "/work" });
		},
	},
	{
		item: "dev_console",
		name: "/dev/console exists",
		weaken: (o) => {
			o.devConsole = true;
		},
	},
	{
		item: "sys_absent",
		name: "/sys is mounted",
		weaken: (o) => {
			o.sysPresent = true;
		},
	},
	{
		item: "cgroup_namespace",
		name: "the host cgroup path is visible",
		weaken: (o) => {
			o.cgroup = "0::/user.slice/user-1000.slice\n";
		},
	},
	{
		item: "cgroup_limits",
		name: "launched without the scope",
		expect: { scope: "none" },
	},
	{ item: "cgroup_limits", name: "the cgroup is unreadable", cgroup: null },
	{
		item: "cgroup_limits",
		name: "not in a scope",
		cgroup: { ...scope(), path: "/user.slice/session-1" },
	},
	{
		item: "cgroup_limits",
		name: "pids.max is wrong",
		cgroup: { ...scope(), pidsMax: "max" },
	},
	{
		item: "cgroup_limits",
		name: "memory.max is wrong",
		cgroup: { ...scope(), memoryMax: "max" },
	},
	{
		item: "cgroup_limits",
		name: "swap is allowed",
		cgroup: { ...scope(), swapMax: "max" },
	},
];

const profile: SandboxProfile = parseSandboxProfile({
	version: 1,
	role: "task",
});
const compiled = {
	ok: true,
	argv: ["systemd-run", "--", "env", "-i", "bwrap", "--args", "4", "--", "x"],
	seccomp: Buffer.from("filter"),
	bwrapArgs: Buffer.from("--unshare-all\0"),
	pinnedBinds: [],
	env: {},
	cwd: "/",
} as unknown as CompiledSandbox;

const row = (items: Attestation["items"]): Attestation => ({
	id: "a1",
	runId: "r1",
	version: ATTESTATION_VERSION,
	...sandboxFingerprint(profile, compiled),
	bwrapVersion: "0.13.1",
	scope: "systemd",
	outcome: probeOutcome(items as never),
	items,
	createdAt: new Date(1_000),
});

const gate = (r: Attestation | null) =>
	judgeAttestation(
		r,
		{
			runId: "r1",
			flags: ["yolo"],
			profile,
			compiled,
			bwrapVersion: "0.13.1",
		},
		{ now: 2_000, maxAgeMs: 3_600_000 },
	);

describe("probe evaluation", () => {
	test("the honest fixture passes every item and the gate", () => {
		const items = evaluateProbe(good(), expectation(), scope());
		expect(items.filter((i) => i.status !== "pass")).toEqual([]);
		expect(items.map((i) => i.id)).toEqual([...PROBE_ITEMS]);
		expect(gate(row(items)).ok).toBe(true);
	});

	test("every probe item has at least one negative", () => {
		expect([...new Set(NEGATIVES.map((n) => n.item))].sort()).toEqual(
			[...PROBE_ITEMS].sort(),
		);
	});

	for (const n of NEGATIVES) {
		test(`${n.item}: ${n.name}`, () => {
			const o = good();
			n.weaken?.(o);
			const c = n.cgroup === undefined ? scope() : n.cgroup;
			const items = evaluateProbe(o, expectation(n.expect), c);
			const failed = items.filter((i) => i.status === "fail").map((i) => i.id);
			expect(failed).toContain(n.item);
			expect(probeOutcome(items)).toBe("fail");
			const decision = gate(row(items));
			expect(decision.ok).toBe(false);
			if (!decision.ok) {
				expect(decision.code).toBe("attestation_failed");
				expect(decision.reason).toContain(n.item);
				expect(decision.fix.length).toBeGreaterThan(0);
			}
		});
	}

	test("a secret's value never appears in a detail", () => {
		const o = good();
		o.pid1.cmdline = b64(`x\0${SECRET}\0`);
		const items = evaluateProbe(o, expectation(), scope());
		expect(JSON.stringify(items)).not.toContain(SECRET);
		expect(JSON.stringify(items)).toContain("ANTHROPIC_API_KEY");
	});

	test("sandbox-chosen names cannot put escapes in a detail", () => {
		const o = good();
		o.sweep.sockets.push("/work/\u001b]52;c;aGk=\u0007.sock");
		const items = evaluateProbe(o, expectation(), scope());
		const detail = items.find((i) => i.id === "socket_sweep")?.detail ?? "";
		expect(detail).not.toContain("\u001b");
		expect(detail).not.toContain("\u0007");
	});

	test("the proxy's own socket is the one socket allowed", () => {
		const o = good();
		o.egress = {
			present: true,
			entries: [{ name: "proxy.sock", type: "socket" }],
			connect: "connected",
		};
		o.sweep.sockets = ["/run/mfw/egress/proxy.sock"];
		const items = evaluateProbe(o, expectation({ egress: "proxy" }), scope());
		expect(items.filter((i) => i.status !== "pass")).toEqual([]);
		o.sweep.sockets.push("/run/mfw/egress/other.sock");
		const again = evaluateProbe(o, expectation({ egress: "proxy" }), scope());
		expect(again.find((i) => i.id === "socket_sweep")?.status).toBe("fail");
	});

	test("an unlistable directory is tolerated only in a toolchain bind", () => {
		const o = good();
		o.sweep.unreadable = ["/usr/lib/private"];
		const at = (tolerated: string[]) =>
			evaluateProbe(
				o,
				expectation({ sweepTolerated: tolerated }),
				scope(),
			).find((i) => i.id === "socket_sweep")?.status;
		expect(at(["/usr"])).toBe("pass");
		expect(at([])).toBe("fail");
		expect(at(["/us"])).toBe("fail");
	});

	test("a pass says how many denials the filter count alone proves", () => {
		const items = evaluateProbe(
			good(),
			expectation({
				syscalls: [
					{ name: "bpf", expect: 1, provable: false },
					{ name: "clone3", expect: 38, provable: true },
				],
			}),
			scope(),
		);
		const detail = items.find((i) => i.id === "seccomp_eperm")?.detail;
		expect(detail).toContain("1 of 2");
		expect(detail).toContain("without a filter");
	});

	test("a wrong nonce fails every item", () => {
		const o = good();
		o.nonce = "replayed";
		const items = evaluateProbe(o, expectation(), scope());
		expect(items.every((i) => i.status === "fail")).toBe(true);
	});

	test("an unknown or missing field does not parse", () => {
		expect(
			ProbeObservationsSchema.safeParse({ ...good(), verdict: "pass" }).success,
		).toBe(false);
		const { sweep: _sweep, ...partial } = good();
		expect(ProbeObservationsSchema.safeParse(partial).success).toBe(false);
	});

	test("the outcome needs every item, not just no failures", () => {
		const items = evaluateProbe(good(), expectation(), scope());
		expect(probeOutcome(items.slice(1))).toBe("fail");
		expect(probeOutcome([])).toBe("fail");
		expect(probeOutcome(failAll("x"))).toBe("fail");
	});
});

describe("autonomy gate", () => {
	const passing = () =>
		row(evaluateProbe(good(), expectation(), scope()) as Attestation["items"]);

	const cases: [string, string, (r: Attestation) => Attestation | null][] = [
		["no record", "attestation_missing", () => null],
		[
			"another probe version",
			"attestation_version",
			(r) => ({ ...r, version: ATTESTATION_VERSION + 1 }),
		],
		[
			"outcome pass over a failed item",
			"attestation_incomplete",
			(r) => ({
				...r,
				items: r.items.map((i, n) =>
					n === 0 ? { ...i, status: "fail" as const } : i,
				),
			}),
		],
		[
			"outcome pass with an item missing",
			"attestation_incomplete",
			(r) => ({ ...r, items: r.items.slice(1) }),
		],
		["no scope", "attestation_no_scope", (r) => ({ ...r, scope: "none" })],
		[
			"too old",
			"attestation_stale",
			(r) => ({ ...r, createdAt: new Date(-4_000_000) }),
		],
		[
			"from the future",
			"attestation_stale",
			(r) => ({ ...r, createdAt: new Date(9_000) }),
		],
		[
			"another profile",
			"attestation_mismatch",
			(r) => ({ ...r, profileHash: "0".repeat(64) }),
		],
		[
			"other compiled options",
			"attestation_mismatch",
			(r) => ({ ...r, optionsHash: "0".repeat(64) }),
		],
		[
			"another seccomp program",
			"attestation_mismatch",
			(r) => ({ ...r, seccompHash: "0".repeat(64) }),
		],
		[
			"another bwrap version",
			"attestation_mismatch",
			(r) => ({ ...r, bwrapVersion: "0.12.0" }),
		],
	];
	for (const [name, code, change] of cases) {
		test(`refuses with a fix: ${name}`, () => {
			const d = gate(change(passing()));
			expect(d.ok).toBe(false);
			if (!d.ok) {
				expect(d.code).toBe(code as never);
				expect(d.fix.length).toBeGreaterThan(0);
			}
		});
	}

	for (const [name, now, maxAgeMs] of [
		["an invalid clock", Number.NaN, 3_600_000],
		["a NaN maximum age", 172_800_000, Number.NaN],
		["an infinite maximum age", 172_800_000, Number.POSITIVE_INFINITY],
	] as const) {
		test(`a two-day-old record is refused with ${name}`, () => {
			const d = judgeAttestation(
				passing(),
				{
					runId: "r1",
					flags: ["yolo"],
					profile,
					compiled,
					bwrapVersion: "0.13.1",
				},
				{ now, maxAgeMs },
			);
			expect(d.ok).toBe(false);
			if (!d.ok) expect(d.code).toBe("attestation_stale");
		});
	}

	test("the fingerprint follows bind sources but not secret values", () => {
		const pin = {
			fd: 5,
			source: "/a",
			dest: "/work",
			writable: true,
			label: "workspace",
		};
		const a = { ...compiled, pinnedBinds: [pin] };
		const b = { ...compiled, pinnedBinds: [{ ...pin, source: "/b" }] };
		expect(sandboxFingerprint(profile, a).optionsHash).not.toBe(
			sandboxFingerprint(profile, b).optionsHash,
		);

		const withKey = (value: string) =>
			parseSandboxProfile({
				version: 1,
				role: "task",
				process: { env: { ANTHROPIC_API_KEY: value } },
			});
		const args = (value: string) => ({
			...compiled,
			bwrapArgs: Buffer.from(`--setenv\0ANTHROPIC_API_KEY\0${value}\0`),
		});
		expect(sandboxFingerprint(withKey("one"), args("one"))).toEqual(
			sandboxFingerprint(withKey("two"), args("two")),
		);
	});
});
