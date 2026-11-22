/**
 * Resource limits for a sandboxed run (the sandbox experiments, E9b).
 *
 * A run's whole bwrap tree is wrapped in `systemd-run --user --scope` with
 * `TasksMax`, `MemoryMax` and `MemorySwapMax=0`. The cap applies across the
 * process tree, and the scope needs no sudo. Where the host has no user
 * manager or no delegated controllers (WSL2, containers) the limits cannot be
 * enforced, so `planLimits` refuses and carries the exact fix instead of
 * quietly running unbounded.
 */

import type { Check, SystemdUserValue } from "./host-caps.ts";

export interface LimitsSpec {
	/** Maximum tasks (processes and threads) in the run's cgroup. */
	tasksMax: number;
	/** Maximum memory, such as `4G` or `512M` (systemd syntax: K, M, G, T). */
	memoryMax: string;
	/** Scope unit name without the `.scope` suffix; systemd picks one when absent. */
	unit?: string;
}

export const DEFAULT_LIMITS: LimitsSpec = { tasksMax: 2048, memoryMax: "8G" };

const MEMORY = /^[1-9][0-9]{0,8}[KMGT]$/;
const UNIT = /^[A-Za-z0-9:_.\\-]{1,200}$/;

export type LimitsPlan =
	| { ok: true; argv: string[] }
	| { ok: false; reason: string; fix: string };

/** The validated `systemd-run` prefix. Throws RangeError on an invalid spec. */
export function buildScopeArgs(
	spec: LimitsSpec,
	systemdRun = "systemd-run",
): string[] {
	if (!Number.isInteger(spec.tasksMax) || spec.tasksMax < 1) {
		throw new RangeError(
			`tasksMax must be a positive integer, got ${spec.tasksMax}`,
		);
	}
	if (!MEMORY.test(spec.memoryMax)) {
		throw new RangeError(
			`memoryMax must look like 512M or 4G, got ${spec.memoryMax}`,
		);
	}
	if (spec.unit !== undefined && !UNIT.test(spec.unit)) {
		throw new RangeError(
			`unit has characters systemd would reject: ${spec.unit}`,
		);
	}
	return [
		systemdRun,
		"--user",
		"--scope",
		"--quiet",
		...(spec.unit ? [`--unit=${spec.unit}`] : []),
		"-p",
		`TasksMax=${spec.tasksMax}`,
		"-p",
		`MemoryMax=${spec.memoryMax}`,
		"-p",
		"MemorySwapMax=0",
		"--",
	];
}

/**
 * The scope prefix for this host, or a refusal with the fix. `systemd` is the
 * `detectSystemdUser` check; a host that failed it never gets an unbounded run.
 */
export function planLimits(
	systemd: Check<SystemdUserValue>,
	spec: LimitsSpec = DEFAULT_LIMITS,
	systemdRun = "systemd-run",
): LimitsPlan {
	if (!systemd.ok) {
		return {
			ok: false,
			reason: `cannot enforce run limits: ${systemd.detail}`,
			fix:
				systemd.fix ??
				"start a systemd user session with cpu, memory and pids delegated",
		};
	}
	return { ok: true, argv: buildScopeArgs(spec, systemdRun) };
}

/** Prepend the scope to a command. */
export function wrapInScope(
	plan: Extract<LimitsPlan, { ok: true }>,
	command: string[],
): string[] {
	return [...plan.argv, ...command];
}
