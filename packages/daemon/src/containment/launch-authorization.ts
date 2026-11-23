/**
 * The token that lets `launchSandbox` start an autonomous launch.
 *
 * It is opaque and unforgeable by shape: the launcher honours only objects
 * recorded here, each for one compiled sandbox and one launch. Only
 * attestation-gate.ts may call {@link issueLaunchAuthorization}, after a passing
 * attestation has been consumed; a test holds the codebase to that.
 */

import type { CompiledSandbox } from "./compile-bwrap.ts";
import type { PinIdentity } from "./pinned-binds.ts";

declare const brand: unique symbol;

/** Proof that the gate allowed this launch. Holds nothing a caller can read. */
export interface LaunchAuthorization {
	readonly [brand]: never;
}

interface Grant {
	compiled: CompiledSandbox;
	pins: readonly PinIdentity[];
}

const grants = new WeakMap<object, Grant>();

export function issueLaunchAuthorization(
	compiled: CompiledSandbox,
	pins: readonly PinIdentity[],
): LaunchAuthorization {
	const token = Object.freeze({}) as unknown as LaunchAuthorization;
	grants.set(token as object, { compiled, pins });
	return token;
}

/**
 * The pins this authorization covers, or null if it is not a live grant for
 * exactly this compiled sandbox. A grant is spent by the first redemption,
 * including one for the wrong sandbox.
 */
export function redeemLaunchAuthorization(
	token: unknown,
	compiled: CompiledSandbox,
): readonly PinIdentity[] | null {
	if (typeof token !== "object" || token === null) return null;
	const grant = grants.get(token);
	if (!grant) return null;
	grants.delete(token);
	return grant.compiled === compiled ? grant.pins : null;
}
