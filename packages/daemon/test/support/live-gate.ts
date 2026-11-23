/**
 * The one decision a live suite makes when its capability is missing.
 *
 * Normally it skips, with the reason printed. Where the live layer is required
 * (`MFW_REQUIRE_LIVE_SANDBOX=1`) a missing capability throws at load, so a
 * required gate can never go green with the containment tests unrun.
 *
 * A real systemd user manager is a separate capability, required by
 * `MFW_REQUIRE_LIVE_SCOPE=1`: a host or cage can run bwrap without one.
 */

export type LiveCapability = "sandbox" | "systemd-scope";

const REQUIRED_BY: Record<LiveCapability, string> = {
	sandbox: "MFW_REQUIRE_LIVE_SANDBOX",
	"systemd-scope": "MFW_REQUIRE_LIVE_SCOPE",
};

/** Returns `reason` for `skipIf`; throws instead when the capability is required. */
export function liveGate<T extends string | null>(
	suite: string,
	reason: T,
	capability: LiveCapability = "sandbox",
): T {
	if (!reason) return reason;
	const flag = REQUIRED_BY[capability];
	if (process.env[flag] === "1") {
		throw new Error(`${flag} is set, but ${reason} (${suite})`);
	}
	console.log(
		capability === "sandbox"
			? `[${suite}] skipped: ${reason}`
			: `[${suite}] real systemd scope chain NOT VERIFIED: ${reason}`,
	);
	return reason;
}
