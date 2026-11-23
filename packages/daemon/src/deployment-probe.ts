import type { ProjectDbHandle } from "@mfw/db/client";
import { appendEvent } from "@mfw/db/eventlog";

/**
 * The host's record of a deployment or health probe it ran itself. The only
 * producer of `deployment.probed`, the event that backs "deployed" and
 * "healthy" (`claims.ts`). It is called by host code around a probe the host
 * performs: never with anything an agent reported, and its outcome comes from
 * the probe's own result, not from a caller-supplied verdict.
 */

export type ProbeKind = "deploy" | "health";

export interface ProbeRecord {
	target: string;
	probe: ProbeKind;
	ok: boolean;
	detail?: string;
}

export type ProbeRecorder = (record: ProbeRecord) => Promise<void>;

const MAX_DETAIL = 200;

/** One bounded line: a failure reason, never a log tail. */
function briefly(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	return (text.split("\n")[0] ?? "").slice(0, MAX_DETAIL);
}

/** Records into a project's audit log. The event's own timestamp is the probe time. */
export function auditProbeRecorder(
	handle: Pick<ProjectDbHandle, "withTx">,
	now: () => number = Date.now,
): ProbeRecorder {
	return async (record) => {
		await handle.withTx((tx) =>
			appendEvent(
				tx,
				{
					type: "deployment.probed",
					payload: {
						target: record.target,
						probe: record.probe,
						ok: record.ok,
						...(record.detail ? { detail: record.detail } : {}),
					},
				},
				now(),
			),
		);
	};
}

/**
 * Run a host probe and record how it ended: passing when `run` resolves,
 * failing when it throws (the error is rethrown). A failed record write never
 * turns into a pass: no event means no backing, and the write error surfaces.
 */
export async function probeAndRecord<T>(
	spec: { target: string; probe: ProbeKind; record: ProbeRecorder },
	run: () => Promise<T>,
): Promise<T> {
	let value: T;
	try {
		value = await run();
	} catch (error) {
		await spec
			.record({
				target: spec.target,
				probe: spec.probe,
				ok: false,
				detail: briefly(error),
			})
			.catch(() => {});
		throw error;
	}
	await spec.record({ target: spec.target, probe: spec.probe, ok: true });
	return value;
}

/** `--record-to <mfwDir> --target <name>`: opt-in recording; neither flag means none. */
export function parseProbeRecording(
	argv: readonly string[],
): { mfwDir: string; target: string } | null {
	const value = (flag: string) => {
		const at = argv.indexOf(flag);
		return at >= 0 ? argv[at + 1] : undefined;
	};
	const mfwDir = value("--record-to");
	const target = value("--target");
	if (mfwDir === undefined && target === undefined) return null;
	if (
		!mfwDir ||
		!target ||
		mfwDir.startsWith("--") ||
		target.startsWith("--")
	) {
		throw new Error("--record-to and --target must be given together");
	}
	return { mfwDir, target };
}
