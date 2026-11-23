/**
 * The gate in front of autonomous flags (design "Probe barrier": no autonomous
 * flag without a passing attestation).
 *
 * Not wired into the engine's launch path yet; P5b calls
 * {@link authorizeAutonomousLaunch} where it spawns the agent. A launch with no
 * autonomous flag does not need an attestation.
 *
 * The attestation must be the run's newest, from this probe version, passing
 * on every current item, launched under the systemd scope, recent, and for the
 * same sandbox the agent is about to get: same profile, compiled options and
 * bind sources, seccomp program and bwrap version.
 *
 * Residual: the gate compares against what the caller compiled. A caller that
 * launches something other than the `compiled` it passed here bypasses it,
 * which is why P5b must route the launch through this seam.
 */

import type { ProjectDb } from "@mfw/db/client";
import {
	ATTESTATION_VERSION,
	type Attestation,
	latestAttestation,
} from "./attestation-store.ts";
import type { CompiledSandbox } from "./compile-bwrap.ts";
import { PROBE_ITEMS } from "./probe-evaluate.ts";
import { sandboxFingerprint } from "./probe-run.ts";
import type { SandboxProfile } from "./profile.ts";

/** How long a passing probe stands in for a fresh one. */
export const ATTESTATION_MAX_AGE_MS = 60 * 60 * 1000;

export type AutonomousFlag = "yolo" | "auto";

export type GateRefusalCode =
	| "attestation_missing"
	| "attestation_version"
	| "attestation_failed"
	| "attestation_incomplete"
	| "attestation_no_scope"
	| "attestation_stale"
	| "attestation_mismatch";

export type GateDecision =
	| { ok: true; attestationId: string | null }
	| { ok: false; code: GateRefusalCode; reason: string; fix: string };

export interface GateRequest {
	runId: string;
	/** The autonomous flags this launch asks for; empty needs no attestation. */
	flags: readonly AutonomousFlag[];
	profile: SandboxProfile;
	compiled: CompiledSandbox;
	bwrapVersion: string;
	now?: Date;
	maxAgeMs?: number;
}

const REPROBE = "re-run the sandbox probe for this run (see `mfw doctor`)";

/** Judge a stored record against the launch. Pure. */
export function judgeAttestation(
	row: Attestation | null,
	req: GateRequest,
): GateDecision {
	const refuse = (
		code: GateRefusalCode,
		reason: string,
		fix = REPROBE,
	): GateDecision => ({
		ok: false,
		code,
		reason: `${req.flags.join(", ")} refused for run ${req.runId}: ${reason}`,
		fix,
	});
	if (!row) return refuse("attestation_missing", "no sandbox attestation");
	if (row.version !== ATTESTATION_VERSION) {
		return refuse(
			"attestation_version",
			`the attestation is version ${row.version}, expected ${ATTESTATION_VERSION}`,
		);
	}
	if (row.outcome !== "pass") {
		const failed = row.items.filter((i) => i.status !== "pass");
		const names = failed.map((i) => i.id).join(", ");
		return refuse(
			"attestation_failed",
			`the sandbox probe failed: ${names || "no passing items"}`,
			`fix the failing items, then ${REPROBE}`,
		);
	}
	const passed = new Set(
		row.items.filter((i) => i.status === "pass").map((i) => i.id),
	);
	const missing = PROBE_ITEMS.filter((id) => !passed.has(id));
	if (missing.length > 0 || row.items.some((i) => i.status !== "pass")) {
		return refuse(
			"attestation_incomplete",
			`items not passing: ${missing.join(", ") || "unknown"}`,
		);
	}
	if (row.scope !== "systemd") {
		return refuse(
			"attestation_no_scope",
			"the probe ran without the systemd scope, so limits are unproven",
			"run on a host with a systemd user manager and delegated controllers",
		);
	}
	const now = req.now ?? new Date();
	const age = now.getTime() - row.createdAt.getTime();
	if (age < 0 || age > (req.maxAgeMs ?? ATTESTATION_MAX_AGE_MS)) {
		return refuse("attestation_stale", "the attestation is out of date");
	}
	const f = sandboxFingerprint(req.profile, req.compiled);
	const differs = [
		row.profileHash !== f.profileHash && "profile",
		row.optionsHash !== f.optionsHash && "compiled options",
		row.seccompHash !== f.seccompHash && "seccomp program",
		row.bwrapVersion !== req.bwrapVersion && "bwrap version",
	].filter(Boolean);
	if (differs.length > 0) {
		return refuse(
			"attestation_mismatch",
			`the launch differs from the attested sandbox: ${differs.join(", ")}`,
		);
	}
	return { ok: true, attestationId: row.id };
}

/** The seam P5b calls before launching an agent with autonomous flags. */
export async function authorizeAutonomousLaunch(
	db: ProjectDb,
	req: GateRequest,
): Promise<GateDecision> {
	if (req.flags.length === 0) return { ok: true, attestationId: null };
	return judgeAttestation(await latestAttestation(db, req.runId), req);
}
