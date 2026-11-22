import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
	AUDIT_ARCH_X86_64,
	buildDenyProgram,
	DENIED_SYSCALLS,
	decodeProgram,
	generateSeccompProgram,
	SECCOMP_RET_ALLOW,
	SECCOMP_RET_ERRNO_EPERM,
	SECCOMP_RET_KILL_PROCESS,
	SeccompUnsupportedError,
	type SockFilter,
	writeSeccompFile,
	X32_SYSCALL_BIT,
} from "../src/containment/seccomp.ts";

type Verdict = "allow" | "eperm" | "kill";

/** A tiny classic-BPF interpreter over the subset the generator emits. */
function run(prog: SockFilter[], arch: number, nr: number): Verdict {
	let acc = 0;
	let pc = 0;
	for (let steps = 0; steps < 1000; steps++) {
		const i = prog[pc];
		if (!i) throw new Error(`pc ${pc} ran off the program`);
		switch (i.code) {
			case 0x20:
				acc = i.k === 4 ? arch : i.k === 0 ? nr : Number.NaN;
				if (Number.isNaN(acc)) throw new Error("bad load offset");
				pc++;
				break;
			case 0x15:
				pc += 1 + (acc === i.k ? i.jt : i.jf);
				break;
			case 0x45:
				pc += 1 + ((acc & i.k) !== 0 ? i.jt : i.jf);
				break;
			case 0x06:
				if (i.k === SECCOMP_RET_ALLOW) return "allow";
				if (i.k === SECCOMP_RET_ERRNO_EPERM) return "eperm";
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

	test("is a whole number of 8-byte instructions and round-trips", () => {
		expect(bytes.length % 8).toBe(0);
		expect(prog.length).toBe(bytes.length / 8);
		expect(Buffer.compare(bytes, generateSeccompProgram("x64"))).toBe(0);
	});

	test("denies exactly the listed syscalls and allows every other number", () => {
		for (let nr = 0; nr < 1024; nr++)
			expect(run(prog, AUDIT_ARCH_X86_64, nr)).toBe(
				denied.has(nr) ? "eperm" : "allow",
			);
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
		const eperm = prog.length - 1;
		expect(prog[eperm]?.k).toBe(SECCOMP_RET_ERRNO_EPERM);
		expect(prog[eperm - 1]?.k).toBe(SECCOMP_RET_ALLOW);
		const rules = prog.filter((p) => p.code === 0x15 && denied.has(p.k));
		expect(rules.length).toBe(denied.size);
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
		expect(Object.keys(DENIED_SYSCALLS).sort()).toEqual(
			[
				"add_key",
				"bpf",
				"io_uring_enter",
				"io_uring_register",
				"io_uring_setup",
				"keyctl",
				"perf_event_open",
				"request_key",
				"userfaultfd",
			].sort(),
		);
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
