/**
 * Seccomp denylist generator for the bwrap sandbox (the sandbox experiments,
 * E9b, and the "Seccomp" design section).
 *
 * bwrap `--seccomp FD` takes a raw array of `struct sock_filter` (classic
 * BPF, 8 bytes each, little endian), so no libseccomp is needed. The program
 * is a denylist: the architecture is checked first (any other architecture
 * is killed, so a syscall number can never be read against the wrong table),
 * the x32 ABI is killed (its numbers carry bit 30 and would otherwise slip
 * past every `jeq`), the listed syscalls return `EPERM` (`clone3` returns `ENOSYS`, and `clone`/`unshare`
 * with `CLONE_NEWUSER` return `EPERM`, `socket` and `socketpair` outside the
 * allowed address families return `EAFNOSUPPORT`), and everything else
 * is allowed. x86_64 only; generation is refused elsewhere.
 *
 * Everything here is pure except `writeSeccompFile`, so the encoding and
 * every jump offset can be checked by a decoder on any machine.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * x86_64 syscall numbers denied with `EPERM`. Three groups:
 *
 * - kernel attack surface a build or test never needs: keyring, perf, bpf,
 *   userfaultfd, io_uring;
 * - process inspection, which would let one sandboxed process read or steer
 *   another's memory or descriptors (`ptrace`, `process_vm_*`, `kcmp`,
 *   `pidfd_getfd`) and the secret memfd;
 * - privileged system calls that only become reachable once a nested user
 *   namespace hands out capabilities: the whole mount family (old and new
 *   API), `setns`, handle-based file access (`open_by_handle_at` bypasses
 *   mount-namespace masks), module and kexec loading, `fanotify_init`.
 *
 * Plain `EPERM` is used, not `ENOSYS`, so a caller sees a clean refusal.
 * `git`, `bun`, `node`, `python` and `sh` call none of these.
 */
export const DENIED_SYSCALLS: Readonly<Record<string, number>> = {
	add_key: 248,
	request_key: 249,
	keyctl: 250,
	perf_event_open: 298,
	bpf: 321,
	userfaultfd: 323,
	io_uring_setup: 425,
	io_uring_enter: 426,
	io_uring_register: 427,
	// process inspection
	ptrace: 101,
	process_vm_readv: 310,
	process_vm_writev: 311,
	kcmp: 312,
	pidfd_getfd: 438,
	memfd_secret: 447,
	// namespaces and mounts
	setns: 308,
	mount: 165,
	umount2: 166,
	pivot_root: 155,
	move_mount: 429,
	open_tree: 428,
	fsopen: 430,
	fsconfig: 431,
	fsmount: 432,
	fspick: 433,
	mount_setattr: 442,
	// handle-based access, modules, kexec, fanotify
	open_by_handle_at: 304,
	name_to_handle_at: 303,
	kexec_load: 246,
	kexec_file_load: 320,
	init_module: 175,
	finit_module: 313,
	delete_module: 176,
	fanotify_init: 300,
};

/**
 * Syscalls answered with `ENOSYS`. `clone3` takes its flags through a struct
 * pointer that classic BPF cannot read, so `CLONE_NEWUSER` cannot be filtered
 * there. `ENOSYS` makes glibc (2.34+) and musl fall back to `clone`, whose
 * flags are in a register and are filtered below. This is the same handling
 * container runtimes use.
 */
export const ENOSYS_SYSCALLS: Readonly<Record<string, number>> = {
	clone3: 435,
};

export const CLONE_NEWUSER = 0x10000000;

/**
 * Syscalls denied with `EPERM` only when a bit of one argument is set. The
 * flag word of `clone` and `unshare` is the low 32 bits of argument 0 (a
 * `CLONE_NEWUSER` bit fits there), which classic BPF can test. This is the
 * seccomp half of "no nested user namespaces"; bwrap `--disable-userns`
 * ({@link DISABLE_USERNS_BWRAP_ARGS}) is the kernel half. `setns` is denied
 * outright above.
 */
export interface ArgMaskRule {
	nr: number;
	/** Index 0..5 of the argument whose low 32 bits are tested. */
	arg: number;
	mask: number;
}

export const DENIED_ARG_MASKS: Readonly<Record<string, ArgMaskRule>> = {
	clone_newuser: { nr: 56, arg: 0, mask: CLONE_NEWUSER },
	unshare_newuser: { nr: 272, arg: 0, mask: CLONE_NEWUSER },
};

/**
 * The only address families a sandbox may open. A network namespace does not
 * isolate every family: `AF_VSOCK` reaches a hypervisor or host listener
 * without touching the proxy. `AF_NETLINK` stays because libc and libuv list
 * interfaces through it, and inside the netns it sees only loopback.
 */
export const ALLOWED_SOCKET_FAMILIES: Readonly<Record<string, number>> = {
	AF_UNIX: 1,
	AF_INET: 2,
	AF_INET6: 10,
	AF_NETLINK: 16,
};

/** Syscalls whose first argument is an address family. */
export const FAMILY_FILTERED_SYSCALLS: Readonly<Record<string, number>> = {
	socket: 41,
	socketpair: 53,
};

/**
 * Families the probe must see refused: the ones that reach past a netns or
 * expose a large kernel surface.
 */
export const PROBED_DENIED_FAMILIES: readonly number[] = [
	40, // AF_VSOCK
	17, // AF_PACKET
	38, // AF_ALG
	15, // AF_KEY
	21, // AF_RDS
	29, // AF_CAN
	30, // AF_TIPC
	31, // AF_BLUETOOTH
	44, // AF_XDP
];

// Classic BPF opcodes (linux/filter.h).
const BPF_LD_W_ABS = 0x20; // BPF_LD | BPF_W | BPF_ABS
const BPF_JMP_JEQ_K = 0x15; // BPF_JMP | BPF_JEQ | BPF_K
const BPF_JMP_JSET_K = 0x45; // BPF_JMP | BPF_JSET | BPF_K
const BPF_RET_K = 0x06; // BPF_RET | BPF_K

// seccomp_data layout: nr at 0, arch at 4.
const OFFSET_NR = 0;
const OFFSET_ARCH = 4;

export const AUDIT_ARCH_X86_64 = 0xc000003e;
/** Set in the syscall number by the x32 ABI. */
export const X32_SYSCALL_BIT = 0x40000000;
export const SECCOMP_RET_KILL_PROCESS = 0x80000000;
export const SECCOMP_RET_ALLOW = 0x7fff0000;
export const EPERM = 1;
export const SECCOMP_RET_ERRNO_EPERM = 0x00050000 | EPERM;
export const ENOSYS = 38;
export const SECCOMP_RET_ERRNO_ENOSYS = 0x00050000 | ENOSYS;
export const EAFNOSUPPORT = 97;
export const SECCOMP_RET_ERRNO_EAFNOSUPPORT = 0x00050000 | EAFNOSUPPORT;

export interface SockFilter {
	code: number;
	jt: number;
	jf: number;
	k: number;
}

export class SeccompUnsupportedError extends Error {
	constructor(arch: string) {
		super(
			`seccomp generation is x86_64 only (this host is ${arch}); autonomous runs are unsupported here`,
		);
		this.name = "SeccompUnsupportedError";
	}
}

/** Refuse to generate off x86_64 (the filter would be wrong for any other ABI). */
export function assertSeccompSupported(arch: string = process.arch): void {
	if (arch !== "x64") throw new SeccompUnsupportedError(arch);
}

const insn = (code: number, jt: number, jf: number, k: number): SockFilter => ({
	code,
	jt,
	jf,
	k,
});

export interface DenyExtras {
	/** Syscall numbers answered with ENOSYS. */
	enosys?: readonly number[];
	/** Argument-mask rules answered with EPERM. */
	argMasks?: readonly ArgMaskRule[];
	/** Syscalls limited to {@link ALLOWED_SOCKET_FAMILIES}. */
	familyFiltered?: readonly number[];
}

const OFFSET_ARGS = 16; // seccomp_data.args[0], low word (little endian)

/**
 * The instruction list for the denylist, before encoding. Layout: the arch
 * and x32 prologue, one `jeq` per plain rule, a 4-instruction block per
 * argument-mask rule (`jeq nr`, load arg, `jset mask`, reload nr), a block per
 * family-filtered syscall (`jeq nr`, load arg 0, one `jeq` per family, reload
 * nr), then the ALLOW, EPERM, ENOSYS and EAFNOSUPPORT returns. With `denied` given and no `extras`, only
 * that list is denied (used by tests); with neither, the full policy.
 */
export function buildDenyProgram(
	denied?: readonly number[],
	extras?: DenyExtras,
): SockFilter[] {
	const full = denied === undefined && extras === undefined;
	const enosys = [
		...new Set(extras?.enosys ?? (full ? Object.values(ENOSYS_SYSCALLS) : [])),
	].sort((a, b) => a - b);
	const nrs = [...new Set(denied ?? Object.values(DENIED_SYSCALLS))]
		.filter((nr) => !enosys.includes(nr))
		.sort((a, b) => a - b);
	const masks =
		extras?.argMasks ?? (full ? Object.values(DENIED_ARG_MASKS) : []);
	const filtered = [
		...new Set(
			extras?.familyFiltered ??
				(full ? Object.values(FAMILY_FILTERED_SYSCALLS) : []),
		),
	].sort((a, b) => a - b);
	const families = Object.values(ALLOWED_SOCKET_FAMILIES);
	const familyBlock = 3 + families.length;
	const prog: SockFilter[] = [
		insn(BPF_LD_W_ABS, 0, 0, OFFSET_ARCH),
		insn(BPF_JMP_JEQ_K, 1, 0, AUDIT_ARCH_X86_64), // match: skip the kill
		insn(BPF_RET_K, 0, 0, SECCOMP_RET_KILL_PROCESS),
		insn(BPF_LD_W_ABS, 0, 0, OFFSET_NR),
		insn(BPF_JMP_JSET_K, 0, 1, X32_SYSCALL_BIT), // x32: fall into the kill
		insn(BPF_RET_K, 0, 0, SECCOMP_RET_KILL_PROCESS),
	];
	const start = prog.length;
	const allowAt =
		start +
		nrs.length +
		enosys.length +
		masks.length * 4 +
		filtered.length * familyBlock;
	const epermAt = allowAt + 1;
	const enosysAt = allowAt + 2;
	const eafnosupportAt = allowAt + 3;
	const jump = (from: number, to: number): number => {
		const off = to - (from + 1);
		if (off > 255) throw new Error("seccomp program too large for u8 jumps");
		return off;
	};
	for (const nr of nrs)
		prog.push(insn(BPF_JMP_JEQ_K, jump(prog.length, epermAt), 0, nr));
	for (const nr of enosys)
		prog.push(insn(BPF_JMP_JEQ_K, jump(prog.length, enosysAt), 0, nr));
	for (const m of masks) {
		prog.push(insn(BPF_JMP_JEQ_K, 0, 3, m.nr)); // other syscall: skip the block
		prog.push(insn(BPF_LD_W_ABS, 0, 0, OFFSET_ARGS + 8 * m.arg));
		prog.push(insn(BPF_JMP_JSET_K, jump(prog.length, epermAt), 0, m.mask));
		prog.push(insn(BPF_LD_W_ABS, 0, 0, OFFSET_NR));
	}
	for (const nr of filtered) {
		const reloadAt = prog.length + familyBlock - 1;
		prog.push(insn(BPF_JMP_JEQ_K, 0, familyBlock - 1, nr)); // other: skip
		prog.push(insn(BPF_LD_W_ABS, 0, 0, OFFSET_ARGS));
		families.forEach((family, i) => {
			const at = prog.length;
			// The last family's miss is the refusal.
			const miss = i === families.length - 1 ? jump(at, eafnosupportAt) : 0;
			prog.push(insn(BPF_JMP_JEQ_K, jump(at, reloadAt), miss, family));
		});
		prog.push(insn(BPF_LD_W_ABS, 0, 0, OFFSET_NR));
	}
	prog.push(insn(BPF_RET_K, 0, 0, SECCOMP_RET_ALLOW));
	prog.push(insn(BPF_RET_K, 0, 0, SECCOMP_RET_ERRNO_EPERM));
	prog.push(insn(BPF_RET_K, 0, 0, SECCOMP_RET_ERRNO_ENOSYS));
	prog.push(insn(BPF_RET_K, 0, 0, SECCOMP_RET_ERRNO_EAFNOSUPPORT));
	return prog;
}

/** Encode as `struct sock_filter[]`: `u16 code, u8 jt, u8 jf, u32 k`, little endian. */
export function encodeProgram(prog: readonly SockFilter[]): Buffer {
	const buf = Buffer.alloc(prog.length * 8);
	prog.forEach((p, i) => {
		buf.writeUInt16LE(p.code, i * 8);
		buf.writeUInt8(p.jt, i * 8 + 2);
		buf.writeUInt8(p.jf, i * 8 + 3);
		buf.writeUInt32LE(p.k, i * 8 + 4);
	});
	return buf;
}

/** Decode a raw program; the inverse of `encodeProgram` (used by tests). */
export function decodeProgram(buf: Uint8Array): SockFilter[] {
	if (buf.length % 8 !== 0)
		throw new Error("invalid seccomp data, must be a multiple of 8 bytes");
	const b = Buffer.from(buf.buffer, buf.byteOffset, buf.length);
	const out: SockFilter[] = [];
	for (let o = 0; o < b.length; o += 8)
		out.push({
			code: b.readUInt16LE(o),
			jt: b.readUInt8(o + 2),
			jf: b.readUInt8(o + 3),
			k: b.readUInt32LE(o + 4),
		});
	return out;
}

/** The bytes to hand to `bwrap --seccomp FD`. Throws off x86_64. */
export function generateSeccompProgram(
	arch: string = process.arch,
	denied?: readonly number[],
	extras?: DenyExtras,
): Buffer {
	assertSeccompSupported(arch);
	return encodeProgram(buildDenyProgram(denied, extras));
}

export interface SeccompFile {
	path: string;
	/** Pass as the child's fd 3: `Bun.spawn(argv, { stdio: [..., 3: file.stdio] })`. */
	stdio: ReturnType<typeof Bun.file>;
	cleanup(): void;
}

/**
 * Write the program to a private temp file and describe how to pass it as fd 3
 * (`bwrap ... --seccomp 3`). The caller owns `cleanup()`.
 */
export function writeSeccompFile(
	arch: string = process.arch,
	denied?: readonly number[],
	extras?: DenyExtras,
): SeccompFile {
	const bytes = generateSeccompProgram(arch, denied, extras);
	const dir = mkdtempSync(join(tmpdir(), "mfw-seccomp-"));
	const path = join(dir, "deny.bpf");
	writeFileSync(path, bytes, { mode: 0o600 });
	return {
		path,
		stdio: Bun.file(path),
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

/** The bwrap arguments that load the filter from fd 3. */
export const SECCOMP_BWRAP_ARGS: readonly string[] = ["--seccomp", "3"];

/**
 * Kernel-level block on creating further user namespaces inside the sandbox.
 * Must come after `--unshare-user` in the bwrap argv. Launches must pass both
 * this and {@link SECCOMP_BWRAP_ARGS}: the filter covers `clone`, `unshare`
 * and `setns`, this covers every path the filter cannot see.
 */
export const DISABLE_USERNS_BWRAP_ARGS: readonly string[] = [
	"--disable-userns",
];
