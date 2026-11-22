/**
 * A vendor CLI that cannot authenticate: logged out, an expired or revoked
 * login, a failed token refresh. Retrying cannot help and hammering a
 * refresh endpoint can make it worse, so an auth failure is held fleet-wide
 * for the owner (see `holdRateLimit` in `finalize/step-runner.ts`), never
 * retried. Only the tail is scanned, as for rate limits, and only phrases the
 * CLIs print for a login problem; a bare "401" or "unauthorized" is not one
 * (a tool the agent called can return those).
 */
const SIGNALS: RegExp[] = [
	/\bnot logged in\b/i,
	/please (?:run|use) [`'"]?(?:codex|claude)(?: auth)? login\b/i,
	/\brun [`'"]?(?:codex|claude) (?:auth )?login\b/i,
	/\bcodex login\b.{0,40}\b(?:again|required)\b/i,
	/(?:access|refresh) token (?:could not be refreshed|is expired|has expired|was revoked|expired)/i,
	/refresh token (?:reused|invalid|not found)/i,
	/invalid (?:oauth )?(?:token|credentials)\b.{0,40}\b(?:log ?in|authenticate)/i,
	/authentication (?:failed|required|error)\b/i,
	/oauth token has expired/i,
	/\bapi error: 401\b.{0,200}\bauthenticat/is,
];

const TAIL_BYTES = 8192;

/** How long an auth hold lasts unless the owner clears it first. */
export const AUTH_HOLD_MS = 24 * 60 * 60_000;

/** The hold reason an auth failure is stored under. */
export const AUTH_HOLD_REASON = "auth";

export function isAuthFailure(output: string | null | undefined): boolean {
	if (!output) return false;
	const tail = output.length > TAIL_BYTES ? output.slice(-TAIL_BYTES) : output;
	return SIGNALS.some((re) => re.test(tail));
}
