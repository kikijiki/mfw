import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
	AUDIT_ARCH_X86_64,
	buildDenyProgram,
	CLONE_NEWUSER,
	DENIED_ARG_MASKS,
	DENIED_SYSCALLS,
	decodeProgram,
	ENOSYS_SYSCALLS,
	generateSeccompProgram,
	SECCOMP_RET_ALLOW,
	SECCOMP_RET_ERRNO_ENOSYS,
	SECCOMP_RET_ERRNO_EPERM,
	SECCOMP_RET_KILL_PROCESS,
	SeccompUnsupportedError,
	type SockFilter,
	writeSeccompFile,
	X32_SYSCALL_BIT,
} from "../src/containment/seccomp.ts";

type Verdict = "allow" | "eperm" | "enosys" | "eafnosupport" | "kill";

/** A tiny classic-BPF interpreter over the subset the generator emits. */
function run(prog: SockFilter[], arch: number, nr: number, arg0 = 0): Verdict {
	let acc = 0;
	let pc = 0;
	for (let steps = 0; steps < 1000; steps++) {
		const i = prog[pc];
		if (!i) throw new Error(`pc ${pc} ran off the program`);
		switch (i.code) {
			case 0x20:
				acc =
					i.k === 4 ? arch : i.k === 0 ? nr : i.k === 16 ? arg0 : Number.NaN;
				if (Number.isNaN(acc)) throw new Error("bad load offset");
				pc++;
				break;
			case 0x15:
				pc += 1 + (acc === i.k ? i.jt : i.jf);
				break;
			case 0x45:
				pc += 1 + ((acc & i.k) >>> 0 !== 0 ? i.jt : i.jf);
				break;
			case 0x06:
				if (i.k === SECCOMP_RET_ALLOW) return "allow";
				if (i.k === SECCOMP_RET_ERRNO_EPERM) return "eperm";
				if (i.k === SECCOMP_RET_ERRNO_ENOSYS) return "enosys";
				if (i.k === 0x00050000 + 97) return "eafnosupport";
				if (i.k === SECCOMP_RET_KILL_PROCESS) return "kill";
				throw new Error(`unexpected return ${i.k.toString(16)}`);
			default:
				throw new Error(`unexpected opcode ${i.code.toString(16)}`);
		}
	}
	throw new Error("did not terminate");
}

describe("seccomp program", () => {
	const bytes = generateSeccompProgram("x64");
	const prog = decodeProgram(bytes);
	const denied = new Set(Object.values(DENIED_SYSCALLS));
	const enosys = new Set(Object.values(ENOSYS_SYSCALLS));
	const maskNrs = new Set(Object.values(DENIED_ARG_MASKS).map((m) => m.nr));

	test("is a whole number of 8-byte instructions and round-trips", () => {
		expect(bytes.length % 8).toBe(0);
		expect(prog.length).toBe(bytes.length / 8);
		expect(Buffer.compare(bytes, generateSeccompProgram("x64"))).toBe(0);
	});

	test("denies exactly the listed syscalls and allows every other number", () => {
		for (let nr = 0; nr < 1024; nr++) {
			// `socket` and `socketpair` are judged by family: AF_UNIX passes.
			const arg0 = nr === 41 || nr === 53 ? 1 : 0;
			expect(run(prog, AUDIT_ARCH_X86_64, nr, arg0)).toBe(
				denied.has(nr) ? "eperm" : enosys.has(nr) ? "enosys" : "allow",
			);
		}
	});

	test.each([
		["socket", 41],
		["socketpair", 53],
	])("%s is allowed only for the listed address families", (_name, nr) => {
		for (const family of [1, 2, 10, 16]) {
			expect(run(prog, AUDIT_ARCH_X86_64, nr, family)).toBe("allow");
		}
		for (let family = 0; family < 64; family++) {
			if ([1, 2, 10, 16].includes(family)) continue;
			expect([family, run(prog, AUDIT_ARCH_X86_64, nr, family)]).toEqual([
				family,
				"eafnosupport",
			]);
		}
		expect(run(prog, AUDIT_ARCH_X86_64, nr, 40)).toBe("eafnosupport"); // AF_VSOCK
	});

	test("the family filter leaves other syscalls' first argument alone", () => {
		expect(run(prog, AUDIT_ARCH_X86_64, 42, 40)).toBe("allow"); // connect(fd 40)
	});

	test("X12: process inspection, mount, handle and module calls are EPERM", () => {
		const names = [
			"ptrace",
			"process_vm_readv",
			"process_vm_writev",
			"kcmp",
			"pidfd_getfd",
			"memfd_secret",
			"setns",
			"mount",
			"umount2",
			"pivot_root",
			"move_mount",
			"open_tree",
			"fsopen",
			"fsconfig",
			"fsmount",
			"fspick",
			"open_by_handle_at",
			"name_to_handle_at",
			"kexec_load",
			"kexec_file_load",
			"init_module",
			"finit_module",
			"delete_module",
			"fanotify_init",
		];
		for (const n of names) {
			const nr = DENIED_SYSCALLS[n];
			expect(nr).toBeDefined();
			expect(run(prog, AUDIT_ARCH_X86_64, nr as number)).toBe("eperm");
		}
		expect(DENIED_SYSCALLS.ptrace).toBe(101);
		expect(DENIED_SYSCALLS.process_vm_readv).toBe(310);
		expect(DENIED_SYSCALLS.setns).toBe(308);
		expect(DENIED_SYSCALLS.open_by_handle_at).toBe(304);
	});

	test("X12: clone3 is ENOSYS so glibc falls back to the filterable clone", () => {
		expect(run(prog, AUDIT_ARCH_X86_64, 435)).toBe("enosys");
	});

	test("X12: clone and unshare are EPERM with CLONE_NEWUSER and allowed otherwise", () => {
		for (const nr of maskNrs) {
			expect(run(prog, AUDIT_ARCH_X86_64, nr, CLONE_NEWUSER)).toBe("eperm");
			// NEWUSER alongside other flags, as a real clone call would pass.
			expect(
				run(prog, AUDIT_ARCH_X86_64, nr, (CLONE_NEWUSER | 0x11) >>> 0),
			).toBe("eperm");
			// the high bit of the low word, signed-looking value
			expect(run(prog, AUDIT_ARCH_X86_64, nr, 0x00003d0f)).toBe("allow");
			expect(run(prog, AUDIT_ARCH_X86_64, nr, 0x20000000)).toBe("allow"); // CLONE_NEWNS-ish, no userns
			expect(run(prog, AUDIT_ARCH_X86_64, nr, 0)).toBe("allow");
		}
	});

	test("the argument rules do not disturb the syscalls after them", () => {
		// 57 (fork), 59 (execve) and 435's neighbours sit after the mask blocks.
		for (const nr of [57, 59, 60, 231, 273, 335])
			expect(run(prog, AUDIT_ARCH_X86_64, nr, CLONE_NEWUSER)).toBe("allow");
	});

	test("every conditional jump lands inside the program on a real target", () => {
		prog.forEach((p, idx) => {
			if (p.code !== 0x15 && p.code !== 0x45) return;
			for (const off of [p.jt, p.jf]) {
				const target = idx + 1 + off;
				expect(target).toBeLessThan(prog.length);
			}
		});
	});

	test("each rule's match target is exactly the EPERM return (no off-by-one)", () => {
		const eperm = prog.length - 3;
		expect(prog[eperm + 2]?.k).toBe(0x00050000 + 97); // EAFNOSUPPORT
		expect(prog[eperm + 1]?.k).toBe(SECCOMP_RET_ERRNO_ENOSYS);
		expect(prog[eperm]?.k).toBe(SECCOMP_RET_ERRNO_EPERM);
		expect(prog[eperm - 1]?.k).toBe(SECCOMP_RET_ALLOW);
		const plain = prog.filter(
			(p, idx) => p.code === 0x15 && denied.has(p.k) && idx >= 6,
		);
		expect(plain.length).toBe(denied.size);
		prog.forEach((p, idx) => {
			if (p.code === 0x15 && denied.has(p.k)) {
				expect(idx + 1 + p.jt).toBe(eperm);
				expect(p.jf).toBe(0);
			}
		});
	});

	test("a foreign architecture is killed, whatever the syscall number", () => {
		for (const arch of [0x40000003, 0xc00000b7, 0, 0xffffffff])
			for (const nr of [0, 425, 999]) expect(run(prog, arch, nr)).toBe("kill");
	});

	test("x32-ABI numbers are killed, so bit 30 cannot dodge the list", () => {
		for (const nr of [425, 321, 0, 1])
			expect(run(prog, AUDIT_ARCH_X86_64, nr | X32_SYSCALL_BIT)).toBe("kill");
	});

	test("the denied set is the documented one", () => {
		expect(Object.keys(DENIED_SYSCALLS)).toEqual(
			expect.arrayContaining([
				"add_key",
				"bpf",
				"io_uring_enter",
				"io_uring_register",
				"io_uring_setup",
				"keyctl",
				"perf_event_open",
				"request_key",
				"userfaultfd",
			]),
		);
		expect(Object.keys(DENIED_SYSCALLS)).toHaveLength(34);
		expect(new Set(Object.values(DENIED_SYSCALLS)).size).toBe(34);
		expect(DENIED_SYSCALLS.io_uring_setup).toBe(425);
		expect(DENIED_SYSCALLS.io_uring_enter).toBe(426);
		expect(DENIED_SYSCALLS.io_uring_register).toBe(427);
	});

	test("works for an arbitrary list, including the empty one", () => {
		for (const list of [[], [1], [5, 7, 9, 11]]) {
			const p = buildDenyProgram(list);
			for (let nr = 0; nr < 20; nr++)
				expect(run(p, AUDIT_ARCH_X86_64, nr)).toBe(
					list.includes(nr) ? "eperm" : "allow",
				);
		}
	});
});

describe("seccomp generation", () => {
	test("is refused off x86_64", () => {
		for (const arch of ["arm64", "ia32", "riscv64"])
			expect(() => generateSeccompProgram(arch)).toThrow(
				SeccompUnsupportedError,
			);
	});

	test("decoding rejects data that is not a multiple of 8 bytes", () => {
		expect(() => decodeProgram(new Uint8Array(7))).toThrow();
	});

	test.skipIf(process.arch !== "x64")(
		"the fd helper writes a private file and cleans it up",
		() => {
			const f = writeSeccompFile();
			expect(existsSync(f.path)).toBe(true);
			expect(Buffer.from(require("node:fs").readFileSync(f.path))).toEqual(
				generateSeccompProgram(),
			);
			f.cleanup();
			expect(existsSync(f.path)).toBe(false);
		},
	);
});
