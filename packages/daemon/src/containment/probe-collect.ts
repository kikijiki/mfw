/**
 * Launch the probe and judge what comes back over its pipes. Records nothing:
 * {@link collectProbe} takes an injectable cgroup reader for the tests, so only
 * `attestSandbox`, which never passes one, may turn its result into a record.
 *
 * Cgroup limits are read from the host, while the child is alive, because the
 * sandbox has no `/sys`. That path needs a real user manager and is not
 * exercised by the caged test suite.
 */

import { readFileSync } from "node:fs";
import type { CompiledSandbox } from "./compile-bwrap.ts";
import { launchSandbox } from "./launch-sandbox.ts";
import type { PinIdentity } from "./pinned-binds.ts";
import { PROBE_READY, PROBE_RESULT } from "./probe-child.ts";
import {
	type CgroupObservation,
	evaluateProbe,
	failAll,
	type ProbeItemResult,
	ProbeObservationsSchema,
} from "./probe-evaluate.ts";
import type { ProbePlan } from "./probe-run.ts";

const MAX_OUTPUT = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;

/** The scope's limits, read from the host's cgroup tree. */
export function readHostCgroup(pid: number): CgroupObservation | null {
	try {
		const line = readFileSync(`/proc/${pid}/cgroup`, "utf8").trim();
		if (!line.startsWith("0::/")) return null;
		const path = line.slice(3);
		const read = (name: string) => {
			try {
				return readFileSync(`/sys/fs/cgroup${path}/${name}`, "utf8").trim();
			} catch {
				return null;
			}
		};
		return {
			path,
			memoryMax: read("memory.max"),
			pidsMax: read("pids.max"),
			swapMax: read("memory.swap.max"),
		};
	} catch {
		return null;
	}
}

export interface CollectOptions {
	scope: "systemd" | "none";
	timeoutMs?: number;
	readCgroup?: (pid: number) => CgroupObservation | null;
	tmpDir?: string;
	observePins?: (pins: PinIdentity[]) => void;
}

/** Launch, speak the protocol, and judge. Never throws for a bad child. */
export async function collectProbe(
	compiled: CompiledSandbox,
	plan: ProbePlan,
	opts: CollectOptions,
): Promise<ProbeItemResult[]> {
	let child: ReturnType<typeof launchSandbox>;
	try {
		child = launchSandbox(compiled, {
			// The probe is host code. It grants nothing, and it is what an
			// autonomous launch needs first.
			approvalMode: "interactive",
			scope: opts.scope,
			tmpDir: opts.tmpDir,
			observePins: opts.observePins,
		});
	} catch (err) {
		return failAll(`the probe did not launch: ${(err as Error).message}`);
	}
	const stdin = child.stdin as unknown as {
		write(s: string): unknown;
		end(): unknown;
	};
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill("SIGKILL");
	}, timeoutMs);
	// Kept drained so a chatty child cannot block on a full pipe.
	const stderr = new Response(
		child.stderr as unknown as ReadableStream,
	).arrayBuffer();

	let cgroup: CgroupObservation | null = null;
	let text = "";
	let oversized = false;
	let answered = false;
	const decoder = new TextDecoder();
	try {
		for await (const chunk of child.stdout as unknown as AsyncIterable<Uint8Array>) {
			text += decoder.decode(chunk, { stream: true });
			if (text.length > MAX_OUTPUT) {
				oversized = true;
				child.kill("SIGKILL");
				break;
			}
			if (!answered && text.includes("\n")) {
				answered = true;
				if (text.startsWith(`${PROBE_READY}\n`)) {
					cgroup = (opts.readCgroup ?? readHostCgroup)(child.pid);
					stdin.write(JSON.stringify(plan.spec));
				}
				stdin.end();
			}
		}
		if (!answered) stdin.end();
	} catch {
		child.kill("SIGKILL");
	}
	const code = await child.exited;
	clearTimeout(timer);
	await stderr.catch(() => undefined);

	if (timedOut) return failAll(`the probe timed out after ${timeoutMs} ms`);
	if (oversized) return failAll("the probe's output exceeded the limit");
	if (code !== 0) return failAll(`the probe exited with ${code}`);
	const lines = text.split("\n");
	if (
		lines.length !== 3 ||
		lines[0] !== PROBE_READY ||
		lines[2] !== "" ||
		!lines[1]?.startsWith(`${PROBE_RESULT} `)
	) {
		return failAll("the probe's output is not one ready and one result line");
	}
	let json: unknown;
	try {
		json = JSON.parse((lines[1] as string).slice(PROBE_RESULT.length + 1));
	} catch {
		return failAll("the probe's result is not JSON");
	}
	const parsed = ProbeObservationsSchema.safeParse(json);
	if (!parsed.success) return failAll("the probe's result has the wrong shape");
	return evaluateProbe(parsed.data, plan.expectation, cgroup);
}
