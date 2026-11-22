/**
 * Raw syscall probe through libc `syscall()` (`bun:ffi`), for the seccomp
 * tests. Run INSIDE the sandbox: `bun syscall-probe.ts <name>...` prints one
 * `<name> <errno|0>` line per syscall. Every call passes zero or invalid
 * arguments, so a syscall that is allowed fails with a harmless errno
 * (EINVAL, EFAULT) and one the filter denies fails with EPERM.
 */

import { dlopen, FFIType, read } from "bun:ffi";
import {
	DENIED_ARG_MASKS,
	DENIED_SYSCALLS,
	ENOSYS_SYSCALLS,
} from "./seccomp.ts";

const EPERM = 1;
/** Added to a probed flag word so an unfiltered clone/unshare fails with EINVAL (CLONE_THREAD needs CLONE_SIGHAND) instead of really creating a namespace or a child. */
const CLONE_THREAD = 0x10000;

export interface SyscallResult {
	name: string;
	/** `0` when the call succeeded, else the errno. */
	errno: number;
}

/** Call a syscall by x86_64 number with all-zero arguments except `arg0`. */
export function probeSyscall(
	name: string,
	nr: number,
	arg0 = 0,
): SyscallResult {
	const lib = dlopen("libc.so.6", {
		syscall: {
			args: [FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64],
			returns: FFIType.i64,
		},
		__errno_location: { args: [], returns: FFIType.ptr },
	});
	try {
		const rc = Number(lib.symbols.syscall(nr, arg0, 0, 0));
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
		const mask = DENIED_ARG_MASKS[name];
		const nr = mask?.nr ?? DENIED_SYSCALLS[name] ?? ENOSYS_SYSCALLS[name];
		if (nr === undefined) {
			console.error(`unknown syscall ${name}`);
			process.exit(2);
		}
		const r = probeSyscall(name, nr, mask ? mask.mask | CLONE_THREAD : 0);
		console.log(`${r.name} ${r.errno}`);
	}
}
