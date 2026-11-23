/**
 * The in-child half of the sandbox probe (design "Probe barrier").
 *
 * It only collects. Every judgement happens on the host, in probe-evaluate.ts,
 * so no secret or expected value has to enter the sandbox beyond the paths to
 * look for, and the child has no "pass" to claim.
 *
 * {@link probeChildMain} is serialized with `toString()` and run through
 * `bun -e`, so it must stay self-contained: no imports at module level, no
 * references to anything outside its own body.
 *
 * Protocol, on the pipes the launcher owns:
 *   child  -> host   `MFW-PROBE-READY\n`  (the host now reads the cgroup)
 *   host   -> child  one JSON spec, then EOF
 *   child  -> host   `MFW-PROBE-RESULT <json>\n`, then exit 0
 *
 * Descriptors are listed first, before this code opens anything of its own.
 *
 * Three traps this code exists to avoid, each seen in the sandbox experiments:
 * - `unshare(CLONE_NEWUSER)` is EINVAL in any multi-threaded process, Bun
 *   included, so it "fails" on an unprotected sandbox too. The userns check is
 *   a real `clone`, through a machine-code stub whose child exits at once
 *   (returning into JS from a forked copy of the runtime crashes it).
 * - Many denied syscalls are EPERM for an unprivileged caller anyway. The
 *   arguments are chosen by the host so that most would fail differently
 *   without the filter (see `probeSyscallPlan`).
 * - libc `syscall()` reads six arguments. All six are passed, because a
 *   register left unset holds garbage.
 */

export const PROBE_READY = "MFW-PROBE-READY";
export const PROBE_RESULT = "MFW-PROBE-RESULT";

export interface ProbeSyscall {
	name: string;
	nr: number;
	arg0: number;
	/** The errno the filter must produce. */
	expect: number;
}

/** What the host tells the child to look at. Holds no secret. */
export interface ProbeSpec {
	nonce: string;
	/** A listener on the host's loopback; reaching it means a shared network. */
	loopbackPort: number;
	/** Paths that must not exist in the sandbox. */
	absentPaths: string[];
	/** The real home, and the toolchain roots allowed to recreate part of it. */
	home: { path: string; allowedRoots: string[] };
	/** Hook directories the host's git would execute from. */
	hookDirs: string[];
	egressDir: string;
	syscalls: ProbeSyscall[];
	/** Trees the sweep does not enter. */
	sweepSkip: string[];
	maxEntries: number;
	deadlineMs: number;
}

export async function probeChildMain(): Promise<void> {
	const fs = await import("node:fs");
	const ffi = await import("bun:ffi");

	const listFds = (pid: string) => {
		const out: { fd: number; target: string }[] = [];
		for (const name of fs.readdirSync(`/proc/${pid}/fd`)) {
			try {
				out.push({
					fd: Number(name),
					target: fs.readlinkSync(`/proc/${pid}/fd/${name}`),
				});
			} catch (err) {
				// The listing's own handle is gone by now; anything else is reported.
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
					out.push({ fd: Number(name), target: "unreadable" });
				}
			}
		}
		return out;
	};
	const fds = listFds("self");

	const write = (text: string) => {
		const bytes = Buffer.from(text);
		let off = 0;
		while (off < bytes.length) {
			try {
				off += fs.writeSync(1, bytes, off, bytes.length - off);
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "EAGAIN") throw err;
			}
		}
	};
	const readStdin = () => {
		const chunks: Buffer[] = [];
		const buf = Buffer.alloc(65_536);
		for (;;) {
			let n = 0;
			try {
				n = fs.readSync(0, buf, 0, buf.length, null);
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code;
				if (code === "EAGAIN") continue;
				if (code === "EOF") break;
				throw err;
			}
			if (n === 0) break;
			chunks.push(Buffer.from(buf.subarray(0, n)));
		}
		return Buffer.concat(chunks).toString();
	};

	write("MFW-PROBE-READY\n");
	const spec = JSON.parse(readStdin()) as ProbeSpec;

	const read = (path: string) => {
		try {
			return fs.readFileSync(path, "latin1");
		} catch {
			return null;
		}
	};
	const present = (path: string) => {
		try {
			fs.lstatSync(path);
			return true;
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			// Anything but "not there" cannot prove absence.
			return code !== "ENOENT" && code !== "ENOTDIR";
		}
	};
	const under = (p: string, dir: string) =>
		p === dir || p.startsWith(dir === "/" ? "/" : `${dir}/`);

	// File names are bytes. Decoding one as UTF-8 and using it again names a
	// different path, so everything below walks raw names and only escapes them
	// (injectively) for the report.
	const pathText = (bytes: Uint8Array) => {
		let out = "";
		for (const c of bytes) {
			if (c === 0x5c) out += "\\\\";
			else if (c >= 0x20 && c < 0x7f) out += String.fromCharCode(c);
			else out += `\\x${c.toString(16).padStart(2, "0")}`;
		}
		return out;
	};
	const listRaw = (dir: Buffer) =>
		(
			fs.readdirSync(dir, { encoding: "buffer" }) as unknown as Uint8Array[]
		).map((n) => Buffer.from(n));
	const joinRaw = (dir: Buffer, name: Buffer) =>
		Buffer.concat(
			dir.length === 1 && dir[0] === 0x2f
				? [dir, name]
				: [dir, Buffer.from("/"), name],
		);

	// ---- network
	// Routes on a real device. The loopback's own IPv6 entries are always there.
	const routesOff = (
		text: string | null,
		skip: number,
		dev: "first" | "last",
	) =>
		text === null
			? -1
			: text
					.split("\n")
					.slice(skip)
					.map((l) => l.trim().split(/\s+/))
					.filter((f) => f[0] !== "")
					.filter((f) => (dev === "first" ? f[0] : f[f.length - 1]) !== "lo")
					.length;
	const interfaces = (read("/proc/net/dev") ?? "")
		.split("\n")
		.slice(2)
		.map((l) => l.split(":")[0]?.trim() ?? "")
		.filter(Boolean);
	const unixNamed = (read("/proc/net/unix") ?? "")
		.split("\n")
		.slice(1)
		.map((l) => l.trim().split(/\s+/)[7] ?? "")
		.filter(Boolean);
	// ---- egress directory
	let egressEntries: { name: string; type: string }[] = [];
	let egressSocketPath: Buffer | null = null;
	const egressPresent = present(spec.egressDir);
	let egressConnect: string | null = null;
	if (egressPresent) {
		try {
			const dir = Buffer.from(spec.egressDir);
			egressEntries = listRaw(dir).map((name) => {
				const st = fs.lstatSync(joinRaw(dir, name));
				const type = st.isSocket()
					? "socket"
					: st.isDirectory()
						? "dir"
						: "other";
				if (type === "socket") egressSocketPath ??= joinRaw(dir, name);
				return { name: pathText(name), type };
			});
		} catch {
			egressEntries = [{ name: "(unreadable)", type: "other" }];
		}
	}

	// ---- process state
	const status = read("/proc/self/status") ?? "";
	const field = (name: string) =>
		new RegExp(`^${name}:\\s*(\\S+)`, "m").exec(status)?.[1] ?? "missing";
	const proc = {
		capInh: field("CapInh"),
		capPrm: field("CapPrm"),
		capEff: field("CapEff"),
		capBnd: field("CapBnd"),
		capAmb: field("CapAmb"),
		noNewPrivs: field("NoNewPrivs"),
		seccomp: field("Seccomp"),
	};

	// ---- mounts
	const decodeOctal = (s: string) =>
		s.replace(/\\([0-7]{3})/g, (_, o: string) =>
			String.fromCharCode(Number.parseInt(o, 8)),
		);
	const mounts = (read("/proc/self/mountinfo") ?? "")
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const f = line.split(" ");
			return {
				mountPoint: decodeOctal(f[4] ?? ""),
				options: (f[5] ?? "").split(","),
			};
		});
	const writableMounts = mounts
		.filter((m) => m.options.includes("rw"))
		.map((m) => m.mountPoint);
	const inWritable = (p: string) => writableMounts.some((m) => under(p, m));

	let rootWrite = "written";
	const marker = `/.mfw-probe-${spec.nonce}`;
	try {
		fs.mkdirSync(marker);
		fs.rmdirSync(marker);
	} catch (err) {
		rootWrite = (err as NodeJS.ErrnoException).code ?? "error";
	}

	// ---- absent paths and the real home
	const absentVisible = spec.absentPaths.filter(present);
	const homeVisible: string[] = [];
	const walkHome = (dir: string) => {
		let names: string[];
		try {
			names = fs.readdirSync(dir);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "ENOENT") homeVisible.push(`${dir} (${code})`);
			return;
		}
		for (const name of names) {
			const p = `${dir}/${name}`;
			if (spec.home.allowedRoots.some((r) => under(p, r))) continue;
			// Only a real directory on the way to an allowed root may exist.
			const onTheWay = spec.home.allowedRoots.some((r) => under(r, p));
			let isDir = false;
			try {
				isDir = fs.lstatSync(p).isDirectory();
			} catch {}
			if (onTheWay && isDir) walkHome(p);
			else homeVisible.push(p);
		}
	};
	if (present(spec.home.path)) walkHome(spec.home.path);

	// ---- socket and host-run executable sweep
	const sockets: string[] = [];
	const hostRun: string[] = [];
	const unreadable: string[] = [];
	let entries = 0;
	let truncated = false;
	const deadline = Date.now() + spec.deadlineMs;
	const stack = [Buffer.from("/")];
	while (stack.length > 0 && !truncated) {
		const dir = stack.pop() as Buffer;
		let list: Buffer[];
		try {
			list = listRaw(dir);
		} catch {
			// This directory was just listed by its parent, so even ENOENT means
			// the sweep did not see inside it.
			unreadable.push(pathText(dir));
			continue;
		}
		for (const name of list) {
			if (++entries > spec.maxEntries || Date.now() > deadline) {
				truncated = true;
				break;
			}
			const raw = joinRaw(dir, name);
			const p = pathText(raw);
			if (spec.sweepSkip.some((s) => under(p, s))) continue;
			let st: import("node:fs").Stats;
			try {
				st = fs.lstatSync(raw);
			} catch {
				unreadable.push(p);
				continue;
			}
			if (st.isSocket()) sockets.push(p);
			else if (st.isDirectory()) stack.push(raw);
			else if (st.isFile() && inWritable(p) && st.mode & 0o6000) {
				hostRun.push(`${p} (setuid)`);
			}
		}
	}
	for (const dir of spec.hookDirs) {
		const rawDir = Buffer.from(dir);
		let names: Buffer[] = [];
		try {
			names = listRaw(rawDir);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "ENOTDIR") {
				hostRun.push(`${dir} (${code})`);
			}
		}
		for (const name of names) {
			if (!name.toString("latin1").endsWith(".sample")) {
				hostRun.push(pathText(joinRaw(rawDir, name)));
			}
		}
	}

	// ---- pid 1
	const b64 = (s: string | null) =>
		s === null ? null : Buffer.from(s, "latin1").toString("base64");
	let pid1Fds: { fd: number; target: string }[] | null = null;
	try {
		pid1Fds = listFds("1");
	} catch {}
	const pid1 = {
		cmdline: b64(read("/proc/1/cmdline")),
		environ: b64(read("/proc/1/environ")),
		fds: pid1Fds,
	};
	const envNames = (read("/proc/self/environ") ?? "")
		.split("\0")
		.filter(Boolean)
		.map((kv) => kv.split("=")[0] as string);

	// ---- real syscalls, last: an unfiltered one may leave a descriptor behind
	const libc = ffi.dlopen("libc.so.6", {
		syscall: {
			args: Array(7).fill(ffi.FFIType.i64),
			returns: ffi.FFIType.i64,
		},
		__errno_location: { args: [], returns: ffi.FFIType.ptr },
	});
	const raw = (nr: number, a0 = 0, a1 = 0, a2 = 0, a3 = 0, a4 = 0, a5 = 0) => {
		const rc = Number(libc.symbols.syscall(nr, a0, a1, a2, a3, a4, a5));
		if (rc !== -1) return { rc, errno: 0 };
		const loc = libc.symbols.__errno_location();
		return { rc, errno: loc ? ffi.read.i32(loc) : -1 };
	};
	const control = raw(39).rc === process.pid;

	// Raw, because Bun's socket layer reports every failed connect as
	// ECONNREFUSED, which would hide the difference between these outcomes.
	// Loopback answers at once, so it blocks. The external attempt must not:
	// with a route it would wait for a peer that never answers.
	const rawConnect = (ip: readonly number[], port: number, block: boolean) => {
		const AF_INET = 2;
		const SOCK_STREAM = 1;
		const O_NONBLOCK = 0o4000;
		const type = block ? SOCK_STREAM : SOCK_STREAM | O_NONBLOCK;
		const sock = raw(41, AF_INET, type, 0);
		if (sock.rc < 0) return `socket:${sock.errno}`;
		const addr = Buffer.alloc(16);
		addr.writeUInt16LE(AF_INET, 0);
		addr.writeUInt16BE(port, 2);
		addr.set(ip, 4);
		const r = raw(42, sock.rc, Number(ffi.ptr(addr)), addr.length);
		raw(3, sock.rc);
		if (r.rc === 0) return "connected";
		const names: Record<number, string> = {
			101: "ENETUNREACH",
			111: "ECONNREFUSED",
			115: "EINPROGRESS",
		};
		return names[r.errno] ?? `errno:${r.errno}`;
	};
	// Bun also reports a connect the peer closes at once as refused, so the
	// egress socket is judged by the syscall too.
	const rawUnixConnect = (path: Buffer) => {
		const AF_UNIX = 1;
		const SOCK_STREAM_NONBLOCK = 1 | 0o4000;
		const sock = raw(41, AF_UNIX, SOCK_STREAM_NONBLOCK, 0);
		if (sock.rc < 0) return `socket:${sock.errno}`;
		const addr = Buffer.alloc(110);
		addr.writeUInt16LE(AF_UNIX, 0);
		const length = path.length;
		if (length > 107) {
			raw(3, sock.rc);
			return "path too long";
		}
		addr.set(path, 2);
		const r = raw(42, sock.rc, Number(ffi.ptr(addr)), 2 + length + 1);
		raw(3, sock.rc);
		return r.rc === 0 ? "connected" : `errno:${r.errno}`;
	};
	if (egressSocketPath) egressConnect = rawUnixConnect(egressSocketPath);
	const loopback = rawConnect([127, 0, 0, 1], spec.loopbackPort, true);
	// TEST-NET-1: never routable, so nothing real is contacted.
	const external = rawConnect([192, 0, 2, 1], 9, false);
	const syscalls = spec.syscalls.map((s) => ({
		name: s.name,
		errno: raw(s.nr, s.arg0).errno,
	}));

	// clone(flags, 0, 0, 0, 0); the child calls exit_group(0) without returning.
	const STUB = [
		0xb8, 0x38, 0, 0, 0, 0x31, 0xf6, 0x31, 0xd2, 0x45, 0x31, 0xd2, 0x45, 0x31,
		0xc0, 0x0f, 0x05, 0x48, 0x85, 0xc0, 0x75, 0x09, 0xb8, 0xe7, 0, 0, 0, 0x31,
		0xff, 0x0f, 0x05, 0xc3,
	];
	let usernsErrno = -1;
	const page = raw(9, 0, 4096, 3, 0x22, -1, 0).rc;
	if (page > 0) {
		ffi.toBuffer(page as never, 0, STUB.length).set(STUB);
		if (raw(10, page, 4096, 5).rc === 0) {
			const cloneStub = ffi.CFunction({
				ptr: page as never,
				args: [ffi.FFIType.i64],
				returns: ffi.FFIType.i64,
			});
			const CLONE_NEWUSER = 0x10000000;
			const SIGCHLD = 17;
			const rc = Number(cloneStub(CLONE_NEWUSER | SIGCHLD));
			if (rc > 0) {
				raw(61, rc);
				usernsErrno = 0;
			} else {
				usernsErrno = -rc;
			}
		}
	}

	const result = {
		nonce: spec.nonce,
		network: {
			interfaces,
			routesV4: routesOff(read("/proc/net/route"), 1, "first"),
			routesV6: routesOff(read("/proc/net/ipv6_route"), 0, "last"),
			unixNamed,
			loopback,
			external,
			resolvConf: present("/etc/resolv.conf"),
		},
		egress: {
			present: egressPresent,
			entries: egressEntries,
			connect: egressConnect,
		},
		proc,
		syscallControl: control,
		syscalls,
		usernsErrno,
		mounts,
		rootWrite,
		absentVisible,
		homeVisible,
		sweep: { sockets, hostRun, unreadable, entries, truncated },
		pid1,
		envNames,
		fds,
		devConsole: present("/dev/console"),
		sysPresent: present("/sys"),
		cgroup: read("/proc/self/cgroup"),
	};
	write(`MFW-PROBE-RESULT ${JSON.stringify(result)}\n`);
	process.exit(0);
}

/** The program text handed to `bun -e`. */
export function probeChildSource(): string {
	return `(${probeChildMain.toString()})().catch((e)=>{console.error(String(e));process.exit(70)});`;
}
