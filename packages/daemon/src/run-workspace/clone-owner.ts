/**
 * Who owns a host-made clone (a role clone's `mfw-workspace.json` carries it),
 * and whether that owner is provably gone. The verifier clones keep the same
 * record in `verifier-clone.ts`.
 *
 * An owner is this process's instance id (a restarted daemon is a different
 * instance), its pid, and the pid's start time, so a pid another process later
 * reused is not mistaken for the owner.
 */

import { stat } from "node:fs/promises";
import { processStartTicks } from "../containment/egress-run.ts";

/** Names this process's lifetime. */
export const INSTANCE = crypto.randomUUID();

export interface CloneOwner {
	instance: string;
	pid: number;
	/** Field 22 of `/proc/<pid>/stat`; absent in records that predate it. */
	startTicks?: string;
}

/** The record to write for a clone this process is making. */
export function ownCloneOwner(): CloneOwner {
	const startTicks = processStartTicks(process.pid);
	return {
		instance: INSTANCE,
		pid: process.pid,
		...(startTicks ? { startTicks } : {}),
	};
}

/** Whether the process that wrote `owner` is still the one running as its pid. */
export function ownerAlive(owner: CloneOwner): boolean {
	try {
		process.kill(owner.pid, 0);
	} catch (e) {
		// EPERM: it exists, we just may not signal it.
		if ((e as NodeJS.ErrnoException).code !== "EPERM") return false;
	}
	if (owner.startTicks === undefined) return true;
	return processStartTicks(owner.pid) === owner.startTicks;
}

/** A parsed owner, or null when the record is absent or malformed. */
export function readOwner(value: unknown): CloneOwner | null {
	if (typeof value !== "object" || value === null) return null;
	const o = value as Partial<CloneOwner>;
	if (typeof o.instance !== "string" || !Number.isInteger(o.pid)) return null;
	return {
		instance: o.instance,
		pid: o.pid as number,
		...(typeof o.startTicks === "string" ? { startTicks: o.startTicks } : {}),
	};
}

/** Milliseconds since `createdAt`, or since the directory changed when it has none. */
export async function cloneAgeMs(
	dir: string,
	createdAt: unknown,
	now = Date.now(),
): Promise<number> {
	const made = typeof createdAt === "string" ? Date.parse(createdAt) : NaN;
	if (Number.isFinite(made)) return now - made;
	return now - (await stat(dir)).mtimeMs;
}
