/**
 * Scoped API tokens for non-browser clients (`mfw mcp`, scripts): the closed
 * vocabulary and the pure rules. Storage and lifecycle are in `service.ts`;
 * which procedure needs which scope is declared in `@mfw/api`.
 *
 * There is deliberately no admin scope. Settings, hosts, triggers, merges,
 * approvals, passwords and token management are reachable by an owner session
 * only, whatever a token claims.
 */

export const TOKEN_SCOPES = [
	/** Health, inbox and what is running. */
	"status:read",
	/** Tasks, ADRs, clarifications and the audit stream. */
	"board:read",
	/** Text of tasks parked by hand. Cannot cause work to start or set commands. */
	"board:write",
	/** Start and stop task runs, read their transcripts, edit dispatchable tasks. */
	"runs:act",
] as const;

export type TokenScope = (typeof TOKEN_SCOPES)[number];

export const TOKEN_PREFIX = "mfwt_";
export const TOKEN_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
export const TOKEN_MAX_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const TOKEN_MIN_TTL_MS = 60 * 1000;
export const MAX_LIVE_TOKENS = 64;
export const MAX_TOKEN_STREAMS = 4;
/** Sustained requests per second, per token. */
export const TOKEN_RATE_PER_SECOND = 5;
export const TOKEN_RATE_BURST = 120;

/** `$MFW_HOME/<this>`: where `mfw mcp` looks for a token (0600). */
export const MCP_TOKEN_FILE = "mcp-token";

/** The server a saved token belongs to, unless `--origin` says otherwise. */
export const DEFAULT_TOKEN_ORIGIN = "http://localhost:7777";

/**
 * A bare origin to record beside a saved token, or null. Plain HTTP only to
 * loopback, the same rule `mfw mcp` applies before sending a token.
 */
export function normalizeTokenOrigin(text: string): string | null {
	let u: URL;
	try {
		u = new URL(text);
	} catch {
		return null;
	}
	const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
	if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback))
		return null;
	if (u.username || u.password || u.pathname !== "/" || u.search || u.hash)
		return null;
	return u.origin.length <= 180 ? u.origin : null;
}

/** `30m`, `24h` or `7d` in milliseconds, or null. */
export function parseTtl(text: string): number | null {
	const m = /^([1-9][0-9]{0,5})([mhd])$/.exec(text.trim());
	if (!m) return null;
	const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "m"];
	return Number(m[1]) * unit;
}

const TOKEN_SHAPE = /^mfwt_[A-Za-z0-9_-]{43}$/;
const NAME_SHAPE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
const PROJECT_SHAPE = /^[^\s/\\]{1,128}$/;

export function isTokenScope(value: unknown): value is TokenScope {
	return (TOKEN_SCOPES as readonly unknown[]).includes(value);
}

export type BearerHeader =
	| { kind: "none" }
	| { kind: "malformed" }
	| { kind: "token"; value: string };

/**
 * Read `Authorization`. Another scheme (a proxy's Basic auth) is not ours and
 * reads as none. A Bearer value that is not exactly one well-formed token is
 * malformed, and the caller refuses it rather than falling back to a cookie.
 */
export function parseBearer(header: string | null): BearerHeader {
	if (header === null) return { kind: "none" };
	const trimmed = header.trim();
	const at = trimmed.search(/\s/);
	const scheme = at < 0 ? trimmed : trimmed.slice(0, at);
	if (scheme.toLowerCase() !== "bearer") return { kind: "none" };
	if (at < 0) return { kind: "malformed" };
	const value = trimmed.slice(at).trim();
	return TOKEN_SHAPE.test(value)
		? { kind: "token", value }
		: { kind: "malformed" };
}

export interface TokenRequest {
	name: string;
	scopes: readonly TokenScope[];
	project: string | null;
	ttlMs: number;
}

/** Validate a create request. Returns the problem as text, or the clean value. */
export function normalizeTokenRequest(input: {
	name?: unknown;
	scopes?: unknown;
	project?: unknown;
	ttlMs?: unknown;
}): TokenRequest | string {
	const name = typeof input.name === "string" ? input.name.trim() : "";
	if (!NAME_SHAPE.test(name))
		return "name must be 1 to 64 letters, digits, spaces, dots, dashes or underscores";
	if (!Array.isArray(input.scopes) || input.scopes.length === 0)
		return `choose at least one scope: ${TOKEN_SCOPES.join(", ")}`;
	const unknownScope = input.scopes.find((s) => !isTokenScope(s));
	if (unknownScope !== undefined)
		return `unknown scope '${String(unknownScope)}' (available: ${TOKEN_SCOPES.join(", ")})`;
	const scopes = TOKEN_SCOPES.filter((s) =>
		(input.scopes as unknown[]).includes(s),
	);
	let project: string | null = null;
	if (input.project !== undefined && input.project !== null) {
		if (typeof input.project !== "string" || !PROJECT_SHAPE.test(input.project))
			return "project must be a project name";
		project = input.project;
	}
	const ttlMs = input.ttlMs ?? TOKEN_DEFAULT_TTL_MS;
	if (
		typeof ttlMs !== "number" ||
		!Number.isInteger(ttlMs) ||
		ttlMs < TOKEN_MIN_TTL_MS ||
		ttlMs > TOKEN_MAX_TTL_MS
	)
		return "expiry must be between 1 minute and 90 days";
	return { name, scopes, project, ttlMs };
}

/** A token bucket per API token. Returns 0 when allowed, else ms to wait. */
export class TokenRateLimiter {
	private readonly buckets = new Map<string, { level: number; at: number }>();

	constructor(
		private readonly perSecond = TOKEN_RATE_PER_SECOND,
		private readonly burst = TOKEN_RATE_BURST,
	) {}

	take(id: string, now: number): number {
		const b = this.buckets.get(id) ?? { level: this.burst, at: now };
		const level = Math.min(
			this.burst,
			b.level + (Math.max(0, now - b.at) / 1000) * this.perSecond,
		);
		if (level < 1) {
			this.buckets.set(id, { level, at: now });
			return Math.ceil(((1 - level) / this.perSecond) * 1000);
		}
		this.buckets.set(id, { level: level - 1, at: now });
		if (this.buckets.size > 512) this.prune(now);
		return 0;
	}

	forget(id: string): void {
		this.buckets.delete(id);
	}

	/** A bucket that has refilled holds no information. */
	private prune(now: number): void {
		const full = (this.burst / this.perSecond) * 1000;
		for (const [id, b] of this.buckets)
			if (now - b.at >= full) this.buckets.delete(id);
	}
}
