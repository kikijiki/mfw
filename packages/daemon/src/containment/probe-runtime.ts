/**
 * The probe's runtime, carried into the sandbox as sealed descriptors (design
 * "Probe barrier").
 *
 * The probe must see the mount table the agent will get, so nothing may be
 * bound for it, and a role with no runtime of its own (trigger, reviewer) must
 * not gain one. The launcher's own bun, its ELF loader and the libraries it
 * links are therefore copied into memfds, sealed against every change, and
 * inherited by the probe process alone. They exist in the sandbox only as that
 * process's descriptors, and the agent's later launch does not receive them.
 *
 * This also stops trusting the toolchain's bun: what runs is the host's runtime,
 * and a sandbox-visible file cannot replace it.
 *
 * It needs glibc's `ld.so --preload` (2.30 or newer) and a kernel that lets a
 * memfd execute. Where either is missing the launch is refused: there is no
 * fallback to a runtime found in the sandbox.
 */

import { dlopen, FFIType, ptr } from "bun:ffi";
import {
	closeSync,
	openSync,
	readFileSync,
	realpathSync,
	writeSync,
} from "node:fs";
import { buildKind, buildStamp } from "../../../core/src/build-info.ts";
import {
	fileMismatch,
	installOfExecutable,
	installPath,
	readInstallManifest,
} from "./install-manifest.ts";

/** Every sealed descriptor's name starts with this, as `/memfd:<name>`. */
export const SEALED_PROBE_PREFIX = "mfw-probe-";

const MFD_CLOEXEC = 0x1;
const MFD_ALLOW_SEALING = 0x2;
/** Kernels before 6.3 reject this flag, and every memfd is executable there. */
const MFD_EXEC = 0x10;
const F_ADD_SEALS = 1033;
const F_GET_SEALS = 1034;
/** F_SEAL_SEAL, F_SEAL_SHRINK, F_SEAL_GROW, F_SEAL_WRITE. */
const ALL_SEALS = 0x1 | 0x2 | 0x4 | 0x8;

const PT_INTERP = 3;
const O_CLOEXEC = 0x80000;

export class ProbeRuntimeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ProbeRuntimeError";
	}
}

export interface SealedProbeRuntime {
	/** Parent descriptors, in the order the child must receive them. */
	readonly fds: readonly number[];
	/** The command that starts bun, given the child's number for `fds[0]`. */
	command(firstChildFd: number, bunArgs: readonly string[]): string[];
	/**
	 * Call right after a successful spawn. Bun owns the numbers it was given and
	 * closes them only when it finalizes the subprocess (at GC), so each is
	 * replaced, in place, by `/dev/null`: the child keeps its own inherited
	 * copy, the sealed memory is released now, and Bun's later close lands on
	 * a descriptor that is still ours. Idempotent. Throws if a descriptor cannot
	 * be replaced; the caller must then stop the child.
	 */
	release(): void;
	/** Close what is still held, e.g. after a failed spawn. Idempotent. */
	close(): void;
}

/** The ELF interpreter of a 64-bit little-endian binary; null if static. */
export function elfInterpreter(elf: Buffer): string | null {
	if (
		elf.length < 64 ||
		elf.readUInt32BE(0) !== 0x7f454c46 ||
		elf[4] !== 2 ||
		elf[5] !== 1
	) {
		throw new ProbeRuntimeError("the runtime is not a 64-bit ELF binary");
	}
	const offset = Number(elf.readBigUInt64LE(32));
	const size = elf.readUInt16LE(54);
	const count = elf.readUInt16LE(56);
	for (let i = 0; i < count; i++) {
		const header = offset + i * size;
		if (header + 56 > elf.length) {
			throw new ProbeRuntimeError("the runtime's ELF headers are truncated");
		}
		if (elf.readUInt32LE(header) !== PT_INTERP) continue;
		const start = Number(elf.readBigUInt64LE(header + 8));
		const length = Number(elf.readBigUInt64LE(header + 32));
		if (length < 2 || start + length > elf.length) {
			throw new ProbeRuntimeError("the runtime's ELF interpreter is malformed");
		}
		return elf.subarray(start, start + length - 1).toString();
	}
	return null;
}

/** The resolved libraries from `ld.so --list`, without the loader itself. */
export function parseLoaderList(text: string, interp: string): string[] {
	const loader = realpathSync(interp);
	const out = new Set<string>();
	for (const match of text.matchAll(/=>\s+(\/\S+)\s+\(0x/g)) {
		const real = realpathSync(match[1] as string);
		if (real !== loader) out.add(real);
	}
	for (const line of text.split("\n")) {
		if (/=>\s+not found/.test(line)) {
			throw new ProbeRuntimeError(
				`the runtime has an unresolved library: ${line.trim()}`,
			);
		}
	}
	return [...out];
}

function sealFile(
	libc: ReturnType<typeof openLibc>,
	path: string,
	name: string,
): number {
	const label = Buffer.from(`${SEALED_PROBE_PREFIX}${name}\0`);
	const flags = MFD_CLOEXEC | MFD_ALLOW_SEALING;
	let fd = libc.symbols.memfd_create(ptr(label), flags | MFD_EXEC);
	if (fd < 0) fd = libc.symbols.memfd_create(ptr(label), flags);
	if (fd < 0) {
		throw new ProbeRuntimeError("memfd_create failed");
	}
	try {
		const bytes = readFileSync(path);
		let written = 0;
		while (written < bytes.length) {
			written += writeSync(fd, bytes, written, bytes.length - written);
		}
		if (
			libc.symbols.fcntl(fd, F_ADD_SEALS, BigInt(ALL_SEALS)) !== 0 ||
			libc.symbols.fcntl(fd, F_GET_SEALS, 0n) !== ALL_SEALS
		) {
			throw new ProbeRuntimeError(`could not seal ${name}`);
		}
	} catch (err) {
		closeSync(fd);
		throw err;
	}
	return fd;
}

function openLibc() {
	return dlopen("libc.so.6", {
		memfd_create: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
		fcntl: {
			args: [FFIType.i32, FFIType.i32, FFIType.i64],
			returns: FFIType.i32,
		},
		dup3: {
			args: [FFIType.i32, FFIType.i32, FFIType.i32],
			returns: FFIType.i32,
		},
	});
}

/**
 * The bun the probe runs on: the one running this code, except in a compiled
 * `mfw`, which runs only its own commands. There it is the install's pinned
 * runtime, checked against the install manifest and against the digest this
 * `mfw` was built with; a standalone `mfw` without an install has none, and the
 * launch is refused.
 */
export function defaultProbeRuntime(): string {
	if (buildKind() !== "compiled") return process.execPath;
	const { libDir } = installOfExecutable(realpathSync(process.execPath));
	let manifest: ReturnType<typeof readInstallManifest>;
	try {
		manifest = readInstallManifest(libDir);
	} catch (e) {
		throw new ProbeRuntimeError((e as Error).message);
	}
	if (!manifest) {
		throw new ProbeRuntimeError(
			"a standalone mfw has no bun to probe the sandbox with; install mfw with its runtime",
		);
	}
	const built = buildStamp()?.integrity?.runtime;
	if (built && built !== manifest.runtime.sha256) {
		throw new ProbeRuntimeError(
			"the install names another bun than this mfw was built with",
		);
	}
	let path: string;
	try {
		path = installPath(libDir, manifest.runtime);
	} catch (e) {
		throw new ProbeRuntimeError((e as Error).message);
	}
	const problem = fileMismatch(path, manifest.runtime.sha256);
	if (problem) throw new ProbeRuntimeError(problem);
	return path;
}

/**
 * The bun the launcher's toolchain is resolved against: this process's own,
 * or in a compiled `mfw` the install's verified runtime, so a sandbox binds
 * bun's store closure rather than the `mfw` executable's (REL-1 L3). A
 * standalone `mfw` has none and falls back to itself; its launch is refused
 * later, at the probe.
 */
export function launcherRuntime(): string {
	if (buildKind() !== "compiled") return process.execPath;
	try {
		return defaultProbeRuntime();
	} catch {
		return process.execPath;
	}
}

/** Seal the runtime at `runtimePath`, by default `defaultProbeRuntime()`. */
export function sealProbeRuntime(
	runtimePath: string = defaultProbeRuntime(),
): SealedProbeRuntime {
	const bun = realpathSync(runtimePath);
	const interp = elfInterpreter(readFileSync(bun));
	let libs: string[] = [];
	if (interp) {
		const listed = Bun.spawnSync([interp, "--list", bun], {
			env: {},
			stdin: "ignore",
		});
		if (listed.exitCode !== 0) {
			throw new ProbeRuntimeError(
				"the runtime's loader cannot list its libraries",
			);
		}
		libs = parseLoaderList(listed.stdout.toString(), interp);
	}
	const libc = openLibc();
	const fds: number[] = [];
	let owned = true;
	const close = () => {
		if (!owned) return;
		owned = false;
		for (const fd of fds) {
			try {
				closeSync(fd);
			} catch {
				// Already gone: closing twice must never throw.
			}
		}
	};
	try {
		if (interp) fds.push(sealFile(libc, interp, "loader"));
		fds.push(sealFile(libc, bun, "bun"));
		libs.forEach((lib, i) => {
			fds.push(sealFile(libc, lib, `lib${i}`));
		});
	} catch (err) {
		close();
		throw err;
	} finally {
		libc.close();
	}
	return {
		fds,
		command(first, bunArgs) {
			const at = (i: number) => `/proc/self/fd/${first + i}`;
			if (!interp) return [at(0), ...bunArgs];
			const preload = libs.map((_, i) => at(i + 2)).join(":");
			return [
				at(0),
				...(preload ? ["--preload", preload] : []),
				at(1),
				...bunArgs,
			];
		},
		release() {
			if (!owned) return;
			owned = false;
			// The numbers stay occupied until Bun closes them, so nothing else
			// can take one and have it closed from under it.
			const nul = openSync("/dev/null", "r");
			const libc = openLibc();
			try {
				for (const fd of fds) {
					if (libc.symbols.dup3(nul, fd, O_CLOEXEC) < 0) {
						throw new ProbeRuntimeError("could not release a sealed fd");
					}
				}
			} finally {
				libc.close();
				closeSync(nul);
			}
		},
		close,
	};
}
