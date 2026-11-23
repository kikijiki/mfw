/**
 * The host's judgement of what the in-child probe observed (design "Probe
 * barrier"). Pure, so each item has a negative test on any machine.
 *
 * Fail closed throughout: a result that does not parse, an item with nothing
 * to go on, or a value this code does not recognise is a failure. Every item in
 * {@link PROBE_ITEMS} is always reported.
 *
 * Text that came from the sandbox (file names, mount points) is stripped of
 * control characters before it can reach a detail string, because details are
 * stored and rendered. A secret's value is never echoed, only its name.
 *
 * Residuals, stated so the security review can check them:
 * - The child is trusted for the moment it runs. It runs from a read-only
 *   toolchain before any agent code, with bun's config and dotenv loading off.
 *   If the toolchain itself were hostile it could report anything.
 * - Most denied syscalls would fail differently without the filter, but
 *   `kexec_*`, `*init_module`, `delete_module`, `fanotify_init`,
 *   `open_by_handle_at` and the mount calls are EPERM for any unprivileged
 *   caller. For those the proof is the Seccomp mode plus the filter hash.
 * - With seccomp on, the filter answers first, so `--disable-userns` cannot be
 *   observed separately. `compiled_flags` checks that it was passed.
 * - The sweep skips `/nix/store`: the store is read-only and the NAR format has
 *   no socket type. A directory the sandbox cannot list is a failure, except
 *   inside a toolchain or system bind, where host-owned private directories are
 *   normal. An execute-only directory there could still hide a socket.
 * - Bun implements `stdio: "pipe"` as a unix socketpair, so 0-2 may be sockets.
 *   From here a socketpair to the launcher looks like any other connected
 *   socket. The launcher is what guarantees these are its own: it accepts only
 *   `"pipe"` or a verified FIFO. The host never calls `recvmsg` on them, so
 *   descriptors passed over them are dropped.
 * - Open descriptors above 2 may be the runtime's own anonymous inodes,
 *   `/dev/urandom` and its `statm` handle. Anything else is a failure.
 */

import { z } from "zod";

export const PROBE_ITEMS = [
	"compiled_flags",
	"net_routes",
	"net_dns",
	"net_host_reach",
	"egress_only",
	"seccomp_eperm",
	"userns_denied",
	"caps_empty",
	"no_new_privs",
	"mounts_writable",
	"root_readonly",
	"secrets_absent",
	"home_absent",
	"socket_sweep",
	"exec_sweep",
	"pid1_cmdline",
	"pid1_environ",
	"env_clean",
	"open_fds",
	"dev_console",
	"sys_absent",
	"cgroup_namespace",
	"cgroup_limits",
] as const;

export type ProbeItemId = (typeof PROBE_ITEMS)[number];

export interface ProbeItemResult {
	id: ProbeItemId;
	status: "pass" | "fail";
	detail: string;
}

const Fd = z.strictObject({ fd: z.number().int(), target: z.string() });

export const ProbeObservationsSchema = z.strictObject({
	nonce: z.string(),
	network: z.strictObject({
		interfaces: z.array(z.string()),
		routesV4: z.number().int(),
		routesV6: z.number().int(),
		unixNamed: z.array(z.string()),
		loopback: z.string(),
		external: z.string(),
		resolvConf: z.boolean(),
	}),
	egress: z.strictObject({
		present: z.boolean(),
		entries: z.array(z.strictObject({ name: z.string(), type: z.string() })),
		connect: z.string().nullable(),
	}),
	proc: z.strictObject({
		capInh: z.string(),
		capPrm: z.string(),
		capEff: z.string(),
		capBnd: z.string(),
		capAmb: z.string(),
		noNewPrivs: z.string(),
		seccomp: z.string(),
	}),
	syscallControl: z.boolean(),
	syscalls: z.array(z.strictObject({ name: z.string(), errno: z.number() })),
	usernsErrno: z.number().int(),
	mounts: z.array(
		z.strictObject({ mountPoint: z.string(), options: z.array(z.string()) }),
	),
	rootWrite: z.string(),
	absentVisible: z.array(z.string()),
	homeVisible: z.array(z.string()),
	sweep: z.strictObject({
		sockets: z.array(z.string()),
		hostRun: z.array(z.string()),
		unreadable: z.array(z.string()),
		entries: z.number().int(),
		truncated: z.boolean(),
	}),
	pid1: z.strictObject({
		cmdline: z.string().nullable(),
		environ: z.string().nullable(),
		fds: z.array(Fd).nullable(),
	}),
	envNames: z.array(z.string()),
	fds: z.array(Fd),
	devConsole: z.boolean(),
	sysPresent: z.boolean(),
	cgroup: z.string().nullable(),
});

export type ProbeObservations = z.infer<typeof ProbeObservationsSchema>;

/** What the host read from the scope's cgroup while the child was alive. */
export interface CgroupObservation {
	path: string;
	memoryMax: string | null;
	pidsMax: string | null;
	swapMax: string | null;
}

export interface ProbeExpectation {
	nonce: string;
	/** The bwrap options as compiled. */
	options: readonly string[];
	writableMounts: readonly string[];
	egress: "none" | "proxy";
	egressDir: string;
	envNames: readonly string[];
	/** Values that must not appear in pid 1's command line. */
	secrets: readonly { name: string; value: string }[];
	syscalls: readonly { name: string; expect: number }[];
	scope: "systemd" | "none";
	limits: { tasksMax: number; memoryMaxBytes: number };
	/**
	 * Toolchain and system binds, in the child's escaped path form. Only here may
	 * a directory be unlistable. Anywhere else (workspace, gitDir, caches, fleet,
	 * egress, tmpfs) it could hide a socket reachable by its known name.
	 */
	sweepTolerated: readonly string[];
}

const EPERM = 1;
const ENOSPC = 28;

const clean = (s: string): string => {
	let out = "";
	for (const ch of s.slice(0, 200)) {
		const c = ch.charCodeAt(0);
		out += c < 0x20 || (c >= 0x7f && c <= 0x9f) ? "?" : ch;
	}
	return out;
};

const list = (items: readonly string[], max = 5): string => {
	const shown = items.slice(0, max).map(clean).join(", ");
	return items.length > max ? `${shown} (+${items.length - max})` : shown;
};

const under = (p: string, dir: string): boolean =>
	p === dir || p.startsWith(dir === "/" ? "/" : `${dir}/`);

type Verdict = string | null;

/** Runtime-internal descriptors a Bun process holds above stdio. */
function benignFd(target: string): boolean {
	return (
		target.startsWith("anon_inode:") ||
		target === "/dev/urandom" ||
		/^\/proc\/\d+\/statm$/.test(target)
	);
}

function checkFlags(options: readonly string[]): Verdict {
	const missing = [
		"--unshare-all",
		"--unshare-user",
		"--disable-userns",
		"--die-with-parent",
		"--new-session",
		"--seccomp",
	].filter((f) => !options.includes(f));
	const capDrop = options.indexOf("--cap-drop");
	if (capDrop < 0 || options[capDrop + 1] !== "ALL")
		missing.push("--cap-drop ALL");
	const roRoot = options.some(
		(o, i) => o === "--remount-ro" && options[i + 1] === "/",
	);
	if (!roRoot) missing.push("--remount-ro /");
	return missing.length ? `missing ${missing.join(", ")}` : null;
}

function checkEgress(o: ProbeObservations, e: ProbeExpectation): Verdict {
	if (e.egress === "none") {
		return o.egress.present ? `${e.egressDir} exists with no egress` : null;
	}
	if (!o.egress.present) return `${e.egressDir} is missing`;
	const [only, ...rest] = o.egress.entries;
	if (!only || rest.length > 0 || only.type !== "socket") {
		return `${e.egressDir} must hold exactly one socket`;
	}
	return o.egress.connect === "connected"
		? null
		: `the egress socket did not connect: ${clean(o.egress.connect ?? "none")}`;
}

function checkSockets(o: ProbeObservations, e: ProbeExpectation): Verdict {
	if (o.sweep.truncated) {
		return `the sweep stopped after ${o.sweep.entries} entries`;
	}
	const blind = o.sweep.unreadable.filter(
		(p) => !e.sweepTolerated.some((t) => under(p, t)),
	);
	if (blind.length) return `cannot sweep: ${list(blind)}`;
	const allowed =
		e.egress === "proxy" && o.egress.entries[0]?.type === "socket"
			? `${e.egressDir}/${o.egress.entries[0].name}`
			: null;
	const bad = o.sweep.sockets.filter((s) => s !== allowed);
	return bad.length ? `sockets in bound paths: ${list(bad)}` : null;
}

function checkMounts(o: ProbeObservations, e: ProbeExpectation): Verdict {
	if (o.mounts.length === 0) return "no mounts were read";
	const writable = o.mounts.filter((m) => m.options.includes("rw"));
	const seen = new Set(writable.map((m) => m.mountPoint));
	const extra = [...seen].filter((m) => !e.writableMounts.includes(m));
	const missing = e.writableMounts.filter((m) => !seen.has(m));
	if (extra.length) return `unexpected writable mounts: ${list(extra)}`;
	if (missing.length) return `expected writable mounts: ${list(missing)}`;
	const suid = writable
		.filter((m) => !m.options.includes("nosuid"))
		.map((m) => m.mountPoint);
	return suid.length ? `writable without nosuid: ${list(suid)}` : null;
}

function checkSeccomp(o: ProbeObservations, e: ProbeExpectation): Verdict {
	if (o.proc.seccomp !== "2") {
		return `Seccomp mode is ${clean(o.proc.seccomp)}, expected 2`;
	}
	if (!o.syscallControl) return "the syscall control failed";
	if (e.syscalls.length === 0) return "no syscalls were planned";
	const got = new Map(o.syscalls.map((s) => [s.name, s.errno]));
	const wrong = e.syscalls
		.filter((s) => got.get(s.name) !== s.expect)
		.map((s) => `${s.name}=${got.get(s.name) ?? "missing"}`);
	return wrong.length ? `not denied: ${list(wrong)}` : null;
}

function checkFds(o: ProbeObservations): Verdict {
	const byFd = new Map(o.fds.map((f) => [f.fd, f.target]));
	for (const fd of [0, 1, 2]) {
		const target = byFd.get(fd) ?? "closed";
		if (!target.startsWith("pipe:") && !target.startsWith("socket:")) {
			return `descriptor ${fd} is ${clean(target)}, expected a pipe or socketpair`;
		}
	}
	const own = o.fds.filter((f) => f.fd > 2 && !benignFd(f.target));
	if (own.length) {
		return `unexpected descriptors: ${list(own.map((f) => `${f.fd}=${f.target}`))}`;
	}
	if (o.pid1.fds === null) return "cannot list pid 1's descriptors";
	const init = o.pid1.fds.filter(
		(f) => f.fd > 2 && !f.target.startsWith("anon_inode:"),
	);
	return init.length
		? `pid 1 holds: ${list(init.map((f) => `${f.fd}=${f.target}`))}`
		: null;
}

function checkCmdline(o: ProbeObservations, e: ProbeExpectation): Verdict {
	if (!o.pid1.cmdline) return "cannot read /proc/1/cmdline";
	const bytes = Buffer.from(o.pid1.cmdline, "base64");
	const leaked = e.secrets
		.filter((s) => s.value !== "" && bytes.includes(Buffer.from(s.value)))
		.map((s) => s.name);
	return leaked.length ? `/proc/1/cmdline holds ${list(leaked)}` : null;
}

function checkPid1Environ(o: ProbeObservations): Verdict {
	if (o.pid1.environ === null) return "cannot read /proc/1/environ";
	const names = Buffer.from(o.pid1.environ, "base64")
		.toString("latin1")
		.split("\0")
		.filter(Boolean)
		.map((kv) => kv.split("=")[0] as string);
	// bwrap starts under `env -i`, so its own environment is empty.
	return names.length ? `/proc/1/environ holds ${list(names)}` : null;
}

function checkCgroupLimits(
	c: CgroupObservation | null,
	e: ProbeExpectation,
): Verdict {
	if (e.scope !== "systemd") return "launched without the systemd scope";
	if (!c) return "the host could not read the scope's cgroup";
	if (!c.path.endsWith(".scope")) {
		return `the sandbox is in ${clean(c.path)}, not a scope`;
	}
	if (c.pidsMax !== String(e.limits.tasksMax)) {
		return `pids.max is ${clean(c.pidsMax ?? "unreadable")}, expected ${e.limits.tasksMax}`;
	}
	if (c.memoryMax !== String(e.limits.memoryMaxBytes)) {
		return `memory.max is ${clean(c.memoryMax ?? "unreadable")}, expected ${e.limits.memoryMaxBytes}`;
	}
	if (c.swapMax !== "0") {
		return `memory.swap.max is ${clean(c.swapMax ?? "unreadable")}, expected 0`;
	}
	return null;
}

const CAPS_ZERO = /^0+$/;

const CHECKS: Record<
	ProbeItemId,
	(
		o: ProbeObservations,
		e: ProbeExpectation,
		c: CgroupObservation | null,
	) => Verdict
> = {
	compiled_flags: (_o, e) => checkFlags(e.options),
	net_routes: (o) => {
		const n = o.network;
		if (n.routesV4 !== 0 || n.routesV6 !== 0) {
			return `routes present: ${n.routesV4} IPv4, ${n.routesV6} IPv6`;
		}
		const other = n.interfaces.filter((i) => i !== "lo");
		if (n.interfaces.length === 0) return "cannot read the interfaces";
		return other.length ? `interfaces: ${list(other)}` : null;
	},
	net_dns: (o) => (o.network.resolvConf ? "/etc/resolv.conf is present" : null),
	net_host_reach: (o) => {
		if (o.network.loopback !== "ECONNREFUSED") {
			return `host loopback canary: ${clean(o.network.loopback)}`;
		}
		if (o.network.external !== "ENETUNREACH") {
			return `external address: ${clean(o.network.external)}`;
		}
		return o.network.unixNamed.length
			? `named unix sockets: ${list(o.network.unixNamed)}`
			: null;
	},
	egress_only: checkEgress,
	seccomp_eperm: checkSeccomp,
	userns_denied: (o) =>
		o.usernsErrno === EPERM || o.usernsErrno === ENOSPC
			? null
			: o.usernsErrno === 0
				? "a user namespace was created"
				: `clone returned errno ${o.usernsErrno}`,
	caps_empty: (o) => {
		const p = o.proc;
		const held = Object.entries({
			CapInh: p.capInh,
			CapPrm: p.capPrm,
			CapEff: p.capEff,
			CapBnd: p.capBnd,
			CapAmb: p.capAmb,
		}).filter(([, v]) => !CAPS_ZERO.test(v));
		return held.length ? `held: ${list(held.map(([k]) => k))}` : null;
	},
	no_new_privs: (o) =>
		o.proc.noNewPrivs === "1"
			? null
			: `NoNewPrivs is ${clean(o.proc.noNewPrivs)}`,
	mounts_writable: checkMounts,
	root_readonly: (o) =>
		o.rootWrite === "EROFS" ? null : `writing / gave ${clean(o.rootWrite)}`,
	secrets_absent: (o) =>
		o.absentVisible.length ? `visible: ${list(o.absentVisible)}` : null,
	home_absent: (o) =>
		o.homeVisible.length ? `visible: ${list(o.homeVisible)}` : null,
	socket_sweep: checkSockets,
	exec_sweep: (o) => {
		if (o.sweep.truncated) return "the sweep did not finish";
		return o.sweep.hostRun.length
			? `host-run executables: ${list(o.sweep.hostRun)}`
			: null;
	},
	pid1_cmdline: checkCmdline,
	pid1_environ: checkPid1Environ,
	env_clean: (o, e) => {
		if (o.envNames.length === 0) return "the environment could not be read";
		const extra = o.envNames.filter((n) => !e.envNames.includes(n));
		return extra.length ? `unexpected variables: ${list(extra)}` : null;
	},
	open_fds: checkFds,
	dev_console: (o) => (o.devConsole ? "/dev/console is present" : null),
	sys_absent: (o) => (o.sysPresent ? "/sys is mounted" : null),
	cgroup_namespace: (o) =>
		o.cgroup === "0::/\n"
			? null
			: `/proc/self/cgroup is ${clean(o.cgroup ?? "unreadable")}`,
	cgroup_limits: (_o, e, c) => checkCgroupLimits(c, e),
};

/** Judge one observation. A wrong nonce fails every item. */
export function evaluateProbe(
	observed: ProbeObservations,
	expected: ProbeExpectation,
	cgroup: CgroupObservation | null,
): ProbeItemResult[] {
	if (observed.nonce !== expected.nonce) {
		return failAll("the result does not carry this launch's nonce");
	}
	return PROBE_ITEMS.map((id) => {
		const problem = CHECKS[id](observed, expected, cgroup);
		return problem === null
			? { id, status: "pass", detail: "ok" }
			: { id, status: "fail", detail: problem };
	});
}

/** Every item failed for one reason, such as a probe that produced no result. */
export function failAll(reason: string): ProbeItemResult[] {
	return PROBE_ITEMS.map((id) => ({
		id,
		status: "fail",
		detail: clean(reason),
	}));
}

export function probeOutcome(
	items: readonly ProbeItemResult[],
): "pass" | "fail" {
	const passed = new Set(
		items.filter((i) => i.status === "pass").map((i) => i.id),
	);
	return PROBE_ITEMS.every((id) => passed.has(id)) &&
		items.every((i) => i.status === "pass")
		? "pass"
		: "fail";
}
