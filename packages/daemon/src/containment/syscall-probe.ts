/**
 * Raw syscall probe through libc `syscall()` (`bun:ffi`), for the seccomp
 * tests. Run INSIDE the sandbox: `bun syscall-probe.ts <name>...` prints one
 * `<name> <errno|0>` line per syscall. Every call passes zero or invalid
 * arguments, so a syscall that is allowed fails with a harmless errno
 * (EINVAL, EFAULT) and one the filter denies fails with EPERM.
 */

import { dlopen, FFIType, read } from "bun:ffi";
import { DENIED_SYSCALLS } from "./seccomp.ts";

const EPERM = 1;

export interface SyscallResult {
	name: string;
	/** `0` when the call succeeded, else the errno. */
	errno: number;
}

/** Call a syscall by x86_64 number with all-zero arguments. */
export function probeSyscall(name: string, nr: number): SyscallResult {
	const lib = dlopen("libc.so.6", {
		syscall: {
			args: [FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64],
			returns: FFIType.i64,
		},
		__errno_location: { args: [], returns: FFIType.ptr },
	});
	try {
		const rc = Number(lib.symbols.syscall(nr, 0, 0, 0));
		if (rc >= 0) return { name, errno: 0 };
		const loc = lib.symbols.__errno_location();
		return { name, errno: loc ? read.i32(loc) : -1 };
	} finally {
		lib.close();
	}
}

export function isEperm(r: SyscallResult): boolean {
	return r.errno === EPERM;
}

if (import.meta.main) {
	const names = process.argv.slice(2);
	for (const name of names.length ? names : Object.keys(DENIED_SYSCALLS)) {
		const nr = DENIED_SYSCALLS[name];
		if (nr === undefined) {
			console.error(`unknown syscall ${name}`);
			process.exit(2);
		}
		const r = probeSyscall(name, nr);
		console.log(`${r.name} ${r.errno}`);
	}
}
