import { join } from "node:path";
import type { FactProvenance, RunFactSource } from "@mfw/db/provenance";
import type { ExitFactValue } from "@mfw/db/run-facts";
import type { RunExit } from "./agent-host.ts";
import { runDirLayout } from "./containment/run-dir.ts";
import { readSmallRegularFile } from "./containment/safe-file.ts";

/**
 * Which record a run's exit was read from, and what that makes it worth.
 *
 * - `host-exit-record`: the host-only control root, written by `run.sh` on the
 *   host from the sandbox's real exit status.
 * - `control-exit`: `control/exit`, read-only in the sandbox. It counts only
 *   when the run row says the host launched this run split: in an older flat
 *   run dir an agent could have created that path itself.
 * - `flat-exit`: the run dir's own `exit`, which an agent could write in an
 *   older run and which a remote target copies back. Never host-observed.
 */
export type ExitSource = "host-exit-record" | "control-exit" | "flat-exit";

export interface ExitEvidence {
	exit: RunExit;
	/** Null while nothing is recorded. */
	source: ExitSource | null;
}

export interface ExitEvidenceHost {
	readExit(runDir: string): Promise<RunExit>;
	readExitEvidence?(runDir: string): Promise<ExitEvidence>;
}

/** A host that cannot say where its exit came from gets no credit for it. */
export async function readExitEvidence(
	host: ExitEvidenceHost,
	runDir: string,
): Promise<ExitEvidence> {
	if (host.readExitEvidence) return host.readExitEvidence(runDir);
	const exit = await host.readExit(runDir);
	return { exit, source: exit.kind === "running" ? null : "flat-exit" };
}

export function exitProvenance(
	source: ExitSource | null,
	runDirLayoutMarker: string | null | undefined,
): FactProvenance {
	if (source === "host-exit-record") return "host-observed";
	if (source === "control-exit" && runDirLayoutMarker === "split") {
		return "host-observed";
	}
	// No record at all is the host's own observation that nothing exited cleanly.
	return source === null ? "host-observed" : "sandbox-reported";
}

export function exitFactSource(source: ExitSource | null): RunFactSource {
	return source ?? "finalize";
}

const CLAIM_REASON = /^[A-Za-z0-9_.:-]{1,64}$/;

/** Parse an agent's exit claim. Anything else is recorded as invalid, never guessed at. */
export function parseExitClaim(text: string): ExitFactValue {
	const s = text.trim();
	const exit = /^exit:(\d{1,3})$/.exec(s);
	if (exit) return { kind: "exit", code: Number(exit[1]) };
	const killed = /^killed:(.+)$/.exec(s);
	if (killed && CLAIM_REASON.test(killed[1] as string)) {
		return { kind: "killed", reason: killed[1] as string };
	}
	return { kind: "invalid" };
}

/** What the agent left at `outbox/exit`, if anything. Never read for a verdict. */
export async function readOutboxExitClaim(
	runDir: string,
): Promise<ExitFactValue | null> {
	const text = await readSmallRegularFile(
		join(runDirLayout(runDir).outbox, "exit"),
	);
	return text === null ? null : parseExitClaim(text);
}
