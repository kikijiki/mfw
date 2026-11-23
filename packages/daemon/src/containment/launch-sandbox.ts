/**
 * The one place that spawns a compiled sandbox.
 *
 * It owns the child's descriptor table, which is exactly:
 *
 *   0-2  pipes, never a terminal (bwrap exposes a terminal as `/dev/console`)
 *   3    the seccomp program
 *   4    the bwrap options
 *   5..  the pinned bind sources, in `pinnedBinds` order
 *
 * Bun closes every descriptor not listed in `stdio`, including ones without
 * close-on-exec and ones this process inherited; the live tests hold it to
 * that. bwrap consumes 3, 4 and the pins, so the command itself sees only 0-2.
 *
 * The seccomp program and options live in `O_TMPFILE` files. The options carry
 * env values, and an unnamed file cannot be opened by path.
 *
 * There is no fallback. The scope is dropped only when a caller asks for
 * `scope: "none"`, which also drops the resource limits.
 */

import { closeSync, constants, fstatSync, openSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { isatty } from "node:tty";
import {
	BWRAP_ARGS_FD,
	type CompiledSandbox,
	FIRST_PINNED_FD,
} from "./compile-bwrap.ts";
import {
	type OpenPins,
	openPinnedBinds,
	PinnedBindError,
} from "./pinned-binds.ts";

const O_TMPFILE = 0o20000000 | constants.O_DIRECTORY;

/** What `systemd-run --user` needs to find the user manager; nothing else crosses. */
const SCOPE_ENV = ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"] as const;

/** A new pipe, or the descriptor of an existing one. */
export type LaunchStdio = "pipe" | number;

export interface LaunchOptions {
	stdin?: LaunchStdio;
	stdout?: LaunchStdio;
	stderr?: LaunchStdio;
	/** `none` runs without the scope and its limits. Defaults to `systemd`. */
	scope?: "systemd" | "none";
	/** Where the unnamed option files are created. */
	tmpDir?: string;
}

export type LaunchRefusalCode =
	| "stdio_tty"
	| "stdio_not_pipe"
	| "invalid_compiled"
	| "pin_failed"
	| "launch_failed";

export class SandboxLaunchError extends Error {
	readonly code: LaunchRefusalCode;
	constructor(code: LaunchRefusalCode, message: string) {
		super(message);
		this.name = "SandboxLaunchError";
		this.code = code;
	}
}

function checkStdio(name: string, stdio: LaunchStdio): void {
	if (stdio === "pipe") return;
	if (isatty(stdio)) {
		throw new SandboxLaunchError(
			"stdio_tty",
			`${name} is a terminal, which would reach the sandbox as /dev/console`,
		);
	}
	let isPipe = false;
	try {
		isPipe = fstatSync(stdio).isFIFO();
	} catch {
		// A closed descriptor is refused below, like any other non-pipe.
	}
	if (!isPipe) {
		throw new SandboxLaunchError(
			"stdio_not_pipe",
			`${name} (descriptor ${stdio}) is not a pipe`,
		);
	}
}

/** The argv to spawn, after checking it has the shape the compiler produces. */
function launchArgv(
	compiled: CompiledSandbox,
	scope: "systemd" | "none",
): string[] {
	const split = compiled.argv.indexOf("--");
	const prefix = compiled.argv.slice(0, split);
	const inner = compiled.argv.slice(split + 1);
	if (
		split < 0 ||
		!prefix.includes("--scope") ||
		inner[1] !== "-i" ||
		inner[3] !== "--args" ||
		inner[4] !== String(BWRAP_ARGS_FD) ||
		inner[5] !== "--" ||
		inner.length <= 6
	) {
		throw new SandboxLaunchError(
			"invalid_compiled",
			"the argv is not a compiled scope, env -i and bwrap --args command",
		);
	}
	return scope === "none" ? inner : compiled.argv;
}

function checkPinNumbers(compiled: CompiledSandbox): void {
	compiled.pinnedBinds.forEach((pin, i) => {
		if (pin.fd !== FIRST_PINNED_FD + i) {
			throw new SandboxLaunchError(
				"invalid_compiled",
				`${pin.label} is on descriptor ${pin.fd}, expected ${FIRST_PINNED_FD + i}`,
			);
		}
	});
}

function anonymousFile(dir: string, bytes: Buffer): number {
	const fd = openSync(dir, O_TMPFILE | constants.O_RDWR, 0o600);
	try {
		let written = 0;
		// Positional, so the offset bwrap reads from stays at 0.
		while (written < bytes.length) {
			written += writeSync(fd, bytes, written, bytes.length - written, written);
		}
	} catch (err) {
		closeSync(fd);
		throw err;
	}
	return fd;
}

export interface SandboxFds {
	/** Parent descriptors for the child's 3, 4, 5, and so on. */
	fds: number[];
	close(): void;
}

/** Open everything the child inherits past stdio, or throw with nothing open. */
export function openSandboxFds(
	compiled: CompiledSandbox,
	tmpDir: string = tmpdir(),
): SandboxFds {
	let pins: OpenPins;
	try {
		pins = openPinnedBinds(compiled.pinnedBinds);
	} catch (err) {
		if (!(err instanceof PinnedBindError)) throw err;
		throw new SandboxLaunchError("pin_failed", err.message);
	}
	const files: number[] = [];
	const close = () => {
		for (const fd of files.splice(0)) closeSync(fd);
		pins.close();
	};
	try {
		files.push(anonymousFile(tmpDir, compiled.seccomp));
		files.push(anonymousFile(tmpDir, compiled.bwrapArgs));
	} catch (err) {
		close();
		throw new SandboxLaunchError(
			"launch_failed",
			`cannot create an unnamed file in ${tmpDir}: ${(err as Error).message}`,
		);
	}
	return { fds: [...files, ...pins.parentFds], close };
}

function scopeEnv(scope: "systemd" | "none"): Record<string, string> {
	const env: Record<string, string> = {};
	if (scope === "none") return env;
	for (const name of SCOPE_ENV) {
		const value = process.env[name];
		if (value !== undefined) env[name] = value;
	}
	return env;
}

/**
 * Spawn a compiled sandbox. Throws {@link SandboxLaunchError} before anything
 * runs if the launch cannot meet the descriptor contract.
 */
export function launchSandbox(
	compiled: CompiledSandbox,
	options: LaunchOptions = {},
) {
	const scope = options.scope ?? "systemd";
	const stdin = options.stdin ?? "pipe";
	const stdout = options.stdout ?? "pipe";
	const stderr = options.stderr ?? "pipe";
	checkStdio("stdin", stdin);
	checkStdio("stdout", stdout);
	checkStdio("stderr", stderr);
	const argv = launchArgv(compiled, scope);
	checkPinNumbers(compiled);

	const opened = openSandboxFds(compiled, options.tmpDir);
	try {
		return Bun.spawn(argv, {
			cwd: "/",
			env: scopeEnv(scope),
			stdio: [stdin, stdout, stderr, ...opened.fds] as never,
		});
	} catch (err) {
		throw new SandboxLaunchError(
			"launch_failed",
			`cannot spawn the sandbox: ${(err as Error).message}`,
		);
	} finally {
		// Bun.spawn has already duplicated these into the child.
		opened.close();
	}
}
