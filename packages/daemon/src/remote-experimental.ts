/**
 * Remote execution targets (SSH, RunPod) are experimental in 1.0: off unless
 * explicitly enabled, and never autonomous. They still run the agent in a
 * same-uid bwrap with open egress, so they have no sandbox-profile parity.
 * Only starting new work is gated; observe, collect, dispose and reconcile keep
 * working so an existing lease can always be cleaned up.
 */

/** Environment switch that turns the experimental remote targets on. */
export const EXPERIMENTAL_REMOTE_ENV = "MFW_EXPERIMENTAL_REMOTE";

export type RemoteRefusalCode =
	| "remote_target_disabled"
	| "remote_autonomy_unsupported";

export class RemoteTargetRefusedError extends Error {
	constructor(
		readonly code: RemoteRefusalCode,
		readonly targetKind: string,
		message: string,
	) {
		super(message);
		this.name = "RemoteTargetRefusedError";
	}
}

/** Explicit option wins; otherwise the environment switch, off by default. */
export function remoteTargetEnabled(
	explicit: boolean | undefined,
	env: Record<string, string | undefined> = process.env,
): boolean {
	return explicit ?? env[EXPERIMENTAL_REMOTE_ENV] === "1";
}

export function assertRemoteTargetEnabled(
	kind: string,
	enabled: boolean,
): void {
	if (!enabled) {
		throw new RemoteTargetRefusedError(
			"remote_target_disabled",
			kind,
			`execution target '${kind}' is experimental and off by default; set ${EXPERIMENTAL_REMOTE_ENV}=1 to enable it`,
		);
	}
}

export function assertRemoteNotAutonomous(
	kind: string,
	approvalMode: "autonomous" | "interactive",
): void {
	if (approvalMode === "autonomous") {
		throw new RemoteTargetRefusedError(
			"remote_autonomy_unsupported",
			kind,
			`execution target '${kind}' cannot run autonomously: remote targets have no sandbox-profile parity yet`,
		);
	}
}
