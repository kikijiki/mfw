/**
 * Seccomp denylist generator for the bwrap sandbox (the sandbox experiments,
 * E9b, and the "Seccomp" design section).
 *
 * bwrap `--seccomp FD` takes a raw array of `struct sock_filter` (classic
 * BPF, 8 bytes each, little endian), so no libseccomp is needed. The program
 * is a denylist: the architecture is checked first (any other architecture
 * is killed, so a syscall number can never be read against the wrong table),
 * the x32 ABI is killed (its numbers carry bit 30 and would otherwise slip
 * past every `jeq`), the listed syscalls return `EPERM`, and everything else
 * is allowed. x86_64 only; generation is refused elsewhere.
 *
 * Everything here is pure except `writeSeccompFile`, so the encoding and
 * every jump offset can be checked by a decoder on any machine.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** x86_64 syscall numbers denied with `EPERM`. */
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
};

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

/** The instruction list for the denylist, before encoding. */
export function buildDenyProgram(
	denied: readonly number[] = Object.values(DENIED_SYSCALLS),
): SockFilter[] {
	const nrs = [...new Set(denied)].sort((a, b) => a - b);
	const n = nrs.length;
	const prog: SockFilter[] = [
		insn(BPF_LD_W_ABS, 0, 0, OFFSET_ARCH),
		insn(BPF_JMP_JEQ_K, 1, 0, AUDIT_ARCH_X86_64), // match: skip the kill
		insn(BPF_RET_K, 0, 0, SECCOMP_RET_KILL_PROCESS),
		insn(BPF_LD_W_ABS, 0, 0, OFFSET_NR),
		insn(BPF_JMP_JSET_K, 0, 1, X32_SYSCALL_BIT), // x32: fall into the kill
		insn(BPF_RET_K, 0, 0, SECCOMP_RET_KILL_PROCESS),
	];
	// The rules start at index 6; ALLOW follows the last one, then the EPERM
	// return. Rule i jumps over (n - i - 1) rules and the ALLOW: n - i.
	for (let i = 0; i < n; i++) {
		const nr = nrs[i] as number;
		prog.push(insn(BPF_JMP_JEQ_K, n - i, 0, nr));
	}
	prog.push(insn(BPF_RET_K, 0, 0, SECCOMP_RET_ALLOW));
	prog.push(insn(BPF_RET_K, 0, 0, SECCOMP_RET_ERRNO_EPERM));
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
): Buffer {
	assertSeccompSupported(arch);
	return encodeProgram(buildDenyProgram(denied));
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
): SeccompFile {
	const bytes = generateSeccompProgram(arch, denied);
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
