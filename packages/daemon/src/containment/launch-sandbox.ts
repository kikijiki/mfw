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
 * A successful `Bun.spawn` owns every numeric stdio entry and closes it at exit
 * or finalization. Closing one here as well would later close whatever reused
 * the number, so ownership moves to Bun, including a caller's stdio descriptor.
 * After a refusal or a spawn that throws, the caller's descriptors stay its own.
 *
 * The seccomp program and options live in `O_TMPFILE` files. The options carry
 * env values, and an unnamed file cannot be opened by path.
 *
 * There is no fallback. The scope is dropped only when an interactive caller
 * asks for `scope: "none"`, which also drops the resource limits. An autonomous
 * launch cannot ask for that.
 *
 * With `"pipe"`, Bun hands the child a unix socketpair rather than a FIFO. Only
 * a caller's numeric descriptor is checked to be a real pipe.
 *
 * Task and repair runs reach it through agent-launch.ts. The in-child probe
 * (probe-run.ts) verifies this contract from inside each sandbox, and
 * attestation-gate.ts refuses autonomous flags without a passing record.
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
	type LaunchAuthorization,
	redeemLaunchAuthorization,
} from "./launch-authorization.ts";
import {
	type OpenPins,
	openPinnedBinds,
	type PinIdentity,
	PinnedBindError,
	pinIdentities,
	samePins,
} from "./pinned-binds.ts";
import { RunDirLayoutError, verifyRunDirLayout } from "./run-dir.ts";

const O_TMPFILE = 0o20000000 | constants.O_DIRECTORY;

/** What `systemd-run --user` needs to find the user manager; nothing else crosses. */
const SCOPE_ENV = ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"] as const;

/** A new pipe, or an existing pipe's descriptor, which a successful launch takes. */
export type LaunchStdio = "pipe" | number;

export interface LaunchOptions {
	stdin?: LaunchStdio;
	stdout?: LaunchStdio;
	stderr?: LaunchStdio;
	/** `none` runs without the scope and its limits. Defaults to `systemd`. */
	scope?: "systemd" | "none";
	/** Where the unnamed option files are created. */
	tmpDir?: string;
	/** Told which directories were opened, before anything runs. */
	observePins?: (pins: PinIdentity[]) => void;
}

/**
 * Whether the command may act without a human, stated by every caller. There is
 * no default, because the agent host's own default is autonomous. An autonomous
 * launch needs the gate's authorization.
 */
export type LaunchApproval =
	| { approvalMode: "interactive" }
	| { approvalMode: "autonomous"; authorization: LaunchAuthorization };

export type LaunchRequest = LaunchOptions & LaunchApproval;

export type LaunchRefusalCode =
	| "invalid_approval_mode"
	| "not_authorized"
	| "scope_required"
	| "stdio_tty"
	| "stdio_not_pipe"
	| "invalid_compiled"
	| "pin_failed"
	| "pin_changed"
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
	/** The identity of each pinned bind source, in `pinnedBinds` order. */
	pins: PinIdentity[];
	/** Close them. Only valid while no successful spawn has taken them. */
	close(): void;
	/** Forget them, because a successful spawn now owns them. */
	release(): void;
}

/** Open everything the child inherits past stdio, or throw with nothing open. */
export function openSandboxFds(
	compiled: CompiledSandbox,
	tmpDir: string = tmpdir(),
): SandboxFds {
	let pins: OpenPins;
	try {
		// The pins prove which directories are mounted; this proves no other
		// user can write the run root that holds them.
		if (compiled.runDirRoot) verifyRunDirLayout(compiled.runDirRoot);
		pins = openPinnedBinds(compiled.pinnedBinds);
	} catch (err) {
		if (!(err instanceof PinnedBindError || err instanceof RunDirLayoutError)) {
			throw err;
		}
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
	return {
		fds: [...files, ...pins.parentFds],
		pins: pinIdentities(compiled.pinnedBinds, pins.parentFds),
		close,
		release: () => {
			files.length = 0;
			pins.release();
		},
	};
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
	options: LaunchRequest,
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
	if (options.approvalMode === "autonomous" && scope !== "systemd") {
		throw new SandboxLaunchError(
			"scope_required",
			"an autonomous launch must run under the systemd scope and its limits",
		);
	}
	const expectPins = approvedPins(compiled, options);

	const opened = openSandboxFds(compiled, options.tmpDir);
	if (expectPins && !samePins(expectPins, opened.pins)) {
		opened.close();
		throw new SandboxLaunchError(
			"pin_changed",
			"a bind source is not the directory the probe attested",
		);
	}
	options.observePins?.(opened.pins);
	let child: ReturnType<typeof spawnWithFds>;
	try {
		child = spawnWithFds(argv, scope, [stdin, stdout, stderr, ...opened.fds]);
	} catch (err) {
		// A spawn that throws leaves the descriptors with us.
		opened.close();
		throw new SandboxLaunchError(
			"launch_failed",
			`cannot spawn the sandbox: ${(err as Error).message}`,
		);
	}
	opened.release();
	return child;
}

/** The attested pins of an autonomous launch, null for an interactive one. */
function approvedPins(
	compiled: CompiledSandbox,
	options: LaunchApproval,
): readonly PinIdentity[] | null {
	if (options.approvalMode === "interactive") return null;
	if (options.approvalMode !== "autonomous") {
		throw new SandboxLaunchError(
			"invalid_approval_mode",
			"approvalMode must be stated as interactive or autonomous",
		);
	}
	const pins = redeemLaunchAuthorization(options.authorization, compiled);
	if (!pins) {
		throw new SandboxLaunchError(
			"not_authorized",
			"an autonomous launch needs an unused authorization for this sandbox",
		);
	}
	return pins;
}

function spawnWithFds(
	argv: string[],
	scope: "systemd" | "none",
	stdio: readonly (LaunchStdio | number)[],
) {
	return Bun.spawn(argv, {
		cwd: "/",
		env: scopeEnv(scope),
		stdio: stdio as never,
	});
}
