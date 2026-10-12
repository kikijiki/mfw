import { createHash } from "node:crypto";

/**
 * Native (harness-side) session ids. Claude accepts a caller-chosen uuid via
 * `--session-id`; mfw derives it from the run id so the id is known before the
 * process starts and a crashed first turn still leaves a resumable handle.
 * Codex mints its own thread id at `thread/start`; the bridge reports it as
 * the `session` event's `sessionId`, same as Claude's.
 */

/** A stable RFC 4122 uuid (version 5 layout) derived from a run id. */
export function nativeSessionUuid(runId: string): string {
	const h = createHash("sha256").update(`mfw-run-session:${runId}`).digest();
	const b = h.subarray(0, 16);
	b[6] = ((b[6] ?? 0) & 0x0f) | 0x50;
	b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
	const hex = b.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidFlag(argv: readonly string[], flag: string): string | undefined {
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] ?? "";
		const value = arg === flag ? argv[i + 1] : undefined;
		if (value && UUID_RE.test(value)) return value;
		if (arg.startsWith(`${flag}=`)) {
			const inline = arg.slice(flag.length + 1);
			if (UUID_RE.test(inline)) return inline;
		}
	}
	return undefined;
}

/** The value of `--session-id` in a provider argv, when it is a uuid. */
export function sessionIdFromArgv(argv: readonly string[]): string | undefined {
	return uuidFlag(argv, "--session-id");
}

/** The value of `--resume` (a brain turn continuing its native session), when it is a uuid. */
export function resumeIdFromArgv(argv: readonly string[]): string | undefined {
	return uuidFlag(argv, "--resume");
}
