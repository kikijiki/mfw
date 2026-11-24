import {
	createHash,
	randomBytes,
	randomUUID,
	timingSafeEqual,
} from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isCommonPassword } from "./common-passwords.ts";
import {
	type CeremonyKind,
	CeremonyStore,
	type CredentialDescriptor,
	ceremonyFits,
	creationOptions,
	isCeremonyFull,
	MAX_PASSKEYS,
	normalizePasskeyName,
	parseAssertionJSON,
	parseRegistrationJSON,
	requestOptions,
} from "./passkeys.ts";
import { type AuthDb, openAuthDb } from "./store.ts";
import {
	isTokenScope,
	MAX_LIVE_TOKENS,
	MAX_TOKEN_STREAMS,
	normalizeTokenRequest,
	TOKEN_PREFIX,
	TokenRateLimiter,
	type TokenScope,
} from "./tokens.ts";
import {
	fromBase64url,
	isWebAuthnError,
	type RelyingParty,
	relyingPartyError,
	toBase64url,
	verifyAssertion,
	verifyRegistration,
} from "./webauthn.ts";

/**
 * Auth v1: one owner, a first-run setup token, a password, and revocable
 * server-side sessions. Transport concerns (cookies, redirects, Origin) live in
 * the app's request guard; this module holds the rules.
 */

/** A scoped API token. Built only from a verified `Authorization: Bearer`. */
export interface TokenPrincipal {
	kind: "token";
	/** `token:<tokenId>`, the id audit records attribute actions to. */
	id: string;
	tokenId: string;
	name: string;
	scopes: readonly TokenScope[];
	/** When set, the token reaches this project and no global procedure. */
	project: string | null;
}

/** Who is acting. Audit attributes by `id`. */
export type Principal =
	| { kind: "owner"; id: string; sessionId: string }
	| {
			kind: "brain";
			id: string;
			runId: string;
			project: string;
			sessionId: string;
	  }
	| TokenPrincipal
	/** In-process callers only (`createCaller`); never built from a request. */
	| { kind: "internal"; id: "internal" };

/** What the owner sees of a token. Never the secret or its digest. */
export interface TokenInfo {
	id: string;
	name: string;
	scopes: TokenScope[];
	project: string | null;
	createdAt: number;
	expiresAt: number;
	lastUsedAt: number | null;
	revokedAt: number | null;
	status: "active" | "expired" | "revoked";
}

export type TokenAuditKind = "mutation" | "stream";

export interface TokenAuditEntry {
	id: number;
	tokenId: string;
	name: string;
	path: string;
	project: string | null;
	kind: TokenAuditKind;
	outcome: string;
	at: number;
}

export interface TokenAuditCounter {
	tokenId: string;
	name: string;
	refused: number;
	lastRefusedAt: number | null;
	lastRefusedPath: string | null;
	/** Older rows of this token removed by retention. */
	dropped: number;
}

/** What the owner sees of a registered passkey. Never its key. */
export interface PasskeyInfo {
	id: string;
	name: string;
	rpId: string;
	createdAt: number;
	lastUsedAt: number | null;
	/** The authenticator reported the credential as synced (backed up). */
	backedUp: boolean;
	/** `credProps.rk`, when the browser reported it. */
	discoverable: boolean | null;
}

/** What re-verifies the owner before a passkey is added. */
export type PasskeyProof =
	| { password: string }
	| { ceremonyId: unknown; credential: unknown };

/** Options for `navigator.credentials.create()` / `get()`, plus the ceremony to finish. */
export interface PasskeyCeremony<T> {
	ceremonyId: string;
	publicKey: T;
}

export interface AuthenticatedSession {
	principal: Extract<Principal, { kind: "owner" }>;
	sessionId: string;
	expiresAt: number;
	/** Digest of the per-session request key. Never sent to a client. */
	requestKeyHash: string;
}

export interface IssuedSession extends AuthenticatedSession {
	/** The cookie value. Returned once, stored only as a digest. */
	token: string;
	/**
	 * Required as a header on every API call. Random and independent of the
	 * cookie: cookies are shared across localhost ports, so a page on another
	 * port can capture the cookie, but not this. Returned only by setup and
	 * login, stored only as a digest.
	 */
	requestKey: string;
}

export type AuthRefusalCode =
	| "setup_required"
	| "already_set_up"
	| "invalid_token"
	| "invalid_password"
	| "weak_password"
	| "locked"
	| "busy"
	| "invalid_token_request"
	| "too_many_tokens"
	| "invalid_request"
	| "session_ended"
	| "passkey_refused"
	| "passkey_unavailable"
	| "too_many_passkeys";

export class AuthRefused extends Error {
	override readonly name = "AuthRefused";
	constructor(
		readonly code: AuthRefusalCode,
		message: string,
		readonly retryAfterMs = 0,
	) {
		super(message);
	}
}

/**
 * Use this, not `instanceof`: the production bundle can emit this module into
 * several chunks, each with its own copy of the class.
 */
export function isAuthRefused(e: unknown): e is AuthRefused {
	return (
		e instanceof Error &&
		e.name === "AuthRefused" &&
		typeof (e as { code?: unknown }).code === "string"
	);
}

export const PASSWORD_MIN = 12;
/** Bounds the work an unauthenticated caller can make the hash do. */
export const PASSWORD_MAX = 1024;
export const SETUP_TOKEN_TTL_MS = 60 * 60 * 1000;
export const SESSION_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
const TOUCH_EVERY_MS = 60 * 1000;
const MAX_SESSIONS = 16;
/** Failures allowed before backoff starts. */
export const FREE_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 1000;
export const BACKOFF_MAX_MS = 15 * 60 * 1000;
/** A quiet period this long forgets earlier failures. */
const THROTTLE_RESET_MS = 24 * 60 * 60 * 1000;
/** Global ceiling on password hashing: about ten checks a second. */
const PASSWORD_CHECK_INTERVAL_MS = 100;
/** About six seconds of waiting at that rate. */
const MAX_QUEUED_PASSWORD_CHECKS = 64;
/** Failed proxied attempts, across all clients, before pacing starts. */
export const PROXIED_FREE_FAILURES = 20;
/** Once paced, proxied attempts run at most this often. It delays, never locks. */
const PROXIED_CHECK_INTERVAL_MS = 2000;
const MAX_QUEUED_PROXIED_CHECKS = 16;
/** How often an open stream re-checks its session (revocation is immediate). */
const STREAM_RECHECK_MS = 15 * 1000;
/** A token can be revoked from the CLI, another process: notice within a second. */
const TOKEN_STREAM_RECHECK_MS = 1000;
const TOKEN_TOUCH_EVERY_MS = 60 * 1000;
/** Rows kept per token, per kind. */
const TOKEN_AUDIT_RETENTION = { mutations: 20_000, streams: 2_000 };
const TOKEN_AUDIT_PRUNE_EVERY = 64;
/** Dead tokens stay listed this long, then go. Their audit rows remain. */
const TOKEN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function safeEqual(a: string, b: string): boolean {
	const x = createHash("sha256").update(a).digest();
	const y = createHash("sha256").update(b).digest();
	return timingSafeEqual(x, y);
}

export function backoffMs(failures: number): number {
	if (failures < FREE_ATTEMPTS) return 0;
	const exp = Math.min(failures - FREE_ATTEMPTS, 20);
	return Math.min(BACKOFF_BASE_MS * 2 ** exp, BACKOFF_MAX_MS);
}

export interface AuthServiceOptions {
	now?: () => number;
	/** How often an open stream re-checks its session. */
	streamRecheckMs?: number;
	/** How often an open stream re-checks its API token. */
	tokenStreamRecheckMs?: number;
	/** Per-token request limit (tests that make many calls raise it). */
	tokenRate?: { perSecond: number; burst: number };
	/** Audit rows kept per token and kind (tests lower it). */
	tokenAuditRetention?: { mutations: number; streams: number };
	/** Minimum spacing of password hash checks, across all sources. */
	passwordCheckIntervalMs?: number;
	/** Password checks allowed to wait at once; further ones are refused. */
	maxQueuedPasswordChecks?: number;
	/** Minimum spacing of proxied attempts once the shared budget is spent. */
	proxiedCheckIntervalMs?: number;
	/** Runs after a password verifies, before anything is written (tests). */
	afterPasswordCheck?: () => Promise<void>;
	/** Where a first-run setup token is written (0600). */
	setupTokenFile?: string;
}

/** Eight 16-bit groups, or null when this is not an IPv6 address. */
function ipv6Groups(raw: string): number[] | null {
	let text = raw;
	const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
	if (dotted) {
		const [a, b, c, d] = dotted.slice(1).map(Number) as [
			number,
			number,
			number,
			number,
		];
		if ([a, b, c, d].some((n) => n > 255)) return null;
		text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
	}
	const halves = text.split("::");
	if (halves.length > 2) return null;
	const left = halves[0] ? (halves[0] as string).split(":") : [];
	const right = halves[1] ? (halves[1] as string).split(":") : [];
	const missing = 8 - left.length - right.length;
	if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
	const all = [
		...left,
		...Array<string>(halves.length === 2 ? missing : 0).fill("0"),
		...right,
	];
	if (!all.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
	return all.map((g) => Number.parseInt(g, 16));
}

/** The one throttle bucket for every loopback address. */
export const LOOPBACK_SOURCE = "loopback";

/**
 * A socket peer, or a client address reported by a trusted proxy. The second
 * can be forged by anything able to connect from the proxy's address (a local
 * process, when the proxy is on loopback), so per-address limits alone do not
 * bound it: every proxied attempt also draws on one shared budget.
 */
export type AuthSource = string | { address: string; viaProxy: true };

/** Not addresses, so no client can land in these buckets by choosing one. */
const PROXIED_LOGIN_SCOPE = "login:via-proxy";
const PROXIED_SETUP_SCOPE = "setup:via-proxy";

const sourceAddress = (source: AuthSource | undefined) =>
	typeof source === "object" ? source.address : source;
const isProxied = (source: AuthSource | undefined) =>
	typeof source === "object";

/**
 * Addresses to one throttle key. All of loopback is ONE source: any local
 * process can bind any 127.x address, so separate keys would let it rotate past
 * the lock. Agents therefore share the owner's bucket until their network
 * namespace lands (E7b); `mfw auth unlock` is the owner's way back in.
 * IPv4-mapped IPv6 becomes IPv4, and IPv6 its /64 (one host commonly controls a
 * whole /64), except Tailscale's range, which is keyed by full address. A missing or unparseable address is one shared bucket. Behind a
 * trusted proxy this receives the forwarded client (see `AuthSource`).
 */
export function throttleSource(address: string | null | undefined): string {
	const raw = address
		?.trim()
		.toLowerCase()
		.replace(/^\[|\]$/g, "")
		.replace(/%.*$/, "");
	if (!raw) return "unknown";
	if (!raw.includes(":")) {
		const v4 = /^(\d{1,3})\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.exec(raw);
		if (!v4) return "unknown";
		return v4[1] === "127" ? LOOPBACK_SOURCE : raw;
	}
	const g = ipv6Groups(raw);
	if (!g) return "unknown";
	const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [
		number,
		number,
		number,
		number,
		number,
		number,
		number,
		number,
	];
	if (g0 + g1 + g2 + g3 + g4 + g5 + g6 === 0 && g7 === 1)
		return LOOPBACK_SOURCE;
	if (g0 + g1 + g2 + g3 + g4 === 0 && g5 === 0xffff) {
		const first = g6 >> 8;
		if (first === 127) return LOOPBACK_SOURCE;
		return `${first}.${g6 & 255}.${g7 >> 8}.${g7 & 255}`;
	}
	// Tailscale allocates every node from this /48, so nodes normally share a
	// /64 and one must not be able to lock out the owner's other devices.
	if (g0 === 0xfd7a && g1 === 0x115c && g2 === 0xa1e0)
		return g.map((n) => n.toString(16)).join(":");
	return `${g
		.slice(0, 4)
		.map((n) => n.toString(16))
		.join(":")}::/64`;
}

/**
 * One password check at a time, in arrival order, at a bounded rate. A full
 * queue refuses the NEW request with a retry time; anything already queued,
 * including a correct password, still gets its turn.
 */
class PasswordCheckQueue {
	private tail: Promise<unknown> = Promise.resolve();
	private last = 0;
	private pending = 0;

	constructor(
		private readonly intervalMs: number,
		private readonly maxPending: number,
	) {}

	run<T>(check: () => Promise<T>): Promise<T> {
		if (this.pending >= this.maxPending)
			return Promise.reject(
				new AuthRefused(
					"busy",
					"too many sign-in attempts are waiting; try again shortly",
					Math.max(1000, this.pending * this.intervalMs),
				),
			);
		this.pending++;
		const turn = this.tail.then(async () => {
			const wait = this.last + this.intervalMs - performance.now();
			if (wait > 0) await Bun.sleep(wait);
			this.last = performance.now();
			return check();
		});
		const settled = turn.finally(() => {
			this.pending--;
		});
		this.tail = settled.catch(() => undefined);
		return settled;
	}
}

export class AuthService {
	private readonly now: () => number;
	private readonly streamRecheckMs: number;
	private readonly tokenStreamRecheckMs: number;
	private readonly tokenRate: TokenRateLimiter;
	private readonly tokenAuditRetention: { mutations: number; streams: number };
	private readonly tokenAuditInserts = new Map<string, number>();
	private readonly listeners = new Map<string, Set<() => void>>();
	/** The 0600 file holding a pending setup token, under the masked `$MFW_HOME`. */
	readonly setupTokenFile: string | null;
	private readonly afterPasswordCheck: (() => Promise<void>) | undefined;
	private readonly passwordChecks: PasswordCheckQueue;
	private readonly proxiedChecks: PasswordCheckQueue;
	/** Proxied attempts started and not yet recorded. */
	private readonly proxiedInFlight = { setup: 0, login: 0 };
	/** Throttle scopes with an attempt in flight: one per source at a time. */
	private readonly inFlight = new Set<string>();
	/** Pending passkey challenges: this process only, single use, short-lived. */
	private readonly ceremonies: CeremonyStore;

	constructor(
		private readonly db: AuthDb,
		opts: AuthServiceOptions = {},
	) {
		this.now = opts.now ?? Date.now;
		this.streamRecheckMs = opts.streamRecheckMs ?? STREAM_RECHECK_MS;
		this.tokenStreamRecheckMs =
			opts.tokenStreamRecheckMs ?? TOKEN_STREAM_RECHECK_MS;
		this.tokenAuditRetention =
			opts.tokenAuditRetention ?? TOKEN_AUDIT_RETENTION;
		this.tokenRate = new TokenRateLimiter(
			opts.tokenRate?.perSecond,
			opts.tokenRate?.burst,
		);
		this.ceremonies = new CeremonyStore(this.now);
		this.setupTokenFile = opts.setupTokenFile ?? null;
		this.afterPasswordCheck = opts.afterPasswordCheck;
		this.passwordChecks = new PasswordCheckQueue(
			opts.passwordCheckIntervalMs ?? PASSWORD_CHECK_INTERVAL_MS,
			opts.maxQueuedPasswordChecks ?? MAX_QUEUED_PASSWORD_CHECKS,
		);
		this.proxiedChecks = new PasswordCheckQueue(
			opts.proxiedCheckIntervalMs ?? PROXIED_CHECK_INTERVAL_MS,
			MAX_QUEUED_PROXIED_CHECKS,
		);
	}

	static async open(
		path: string,
		opts: AuthServiceOptions = {},
	): Promise<AuthService> {
		return new AuthService(await openAuthDb(path), {
			setupTokenFile: join(dirname(path), "setup-token"),
			...opts,
		});
	}

	close(): void {
		this.db.close();
	}

	async hasOwner(): Promise<boolean> {
		const r = await this.db.client.execute(
			"SELECT 1 FROM principals WHERE kind = 'owner' LIMIT 1",
		);
		return r.rows.length > 0;
	}

	/**
	 * Called at server start. With no owner, issues a token (see
	 * `issueSetupToken`). With an owner, returns null and clears any leftover.
	 */
	async beginFirstRun(): Promise<string | null> {
		const now = this.now();
		await this.db.client.execute({
			sql: "DELETE FROM auth_sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL OR last_seen_at <= ?",
			args: [now, now - SESSION_IDLE_MS],
		});
		if (await this.hasOwner()) {
			await this.db.client.execute("DELETE FROM setup_tokens");
			this.removeSetupTokenFile();
			return null;
		}
		return this.issueSetupToken();
	}

	/**
	 * Replace any setup token with a new one, written to a 0600 file. It must
	 * never go to a log: agents can read the system journal on some hosts, and
	 * this token claims the whole install. Only its digest is stored.
	 */
	async issueSetupToken(): Promise<string> {
		if (await this.hasOwner())
			throw new AuthRefused("already_set_up", "setup is already complete");
		const now = this.now();
		const token = randomBytes(32).toString("base64url");
		await this.db.client.execute({
			sql: `INSERT INTO setup_tokens (id, token_hash, created_at, expires_at) VALUES (1, ?, ?, ?)
				ON CONFLICT (id) DO UPDATE SET token_hash = excluded.token_hash,
					created_at = excluded.created_at, expires_at = excluded.expires_at`,
			args: [sha(token), now, now + SETUP_TOKEN_TTL_MS],
		});
		// A new token is a new secret: guesses at the old one no longer count.
		await this.db.client.execute(
			"DELETE FROM auth_throttle WHERE scope LIKE 'setup:%'",
		);
		if (this.setupTokenFile) {
			// A fresh exclusive file, renamed in: never written through a planted link.
			const temp = `${this.setupTokenFile}.${randomBytes(6).toString("hex")}`;
			writeFileSync(temp, `${token}\n`, { mode: 0o600, flag: "wx" });
			renameSync(temp, this.setupTokenFile);
		}
		return token;
	}

	private removeSetupTokenFile(): void {
		if (this.setupTokenFile) rmSync(this.setupTokenFile, { force: true });
	}

	/**
	 * Remove the owner and everything that authenticates them. Only for
	 * `mfw auth reset`, which first proves no agent can race the next setup.
	 */
	async resetOwner(): Promise<void> {
		const live = await this.db.client.execute(
			"SELECT id FROM auth_sessions WHERE revoked_at IS NULL UNION ALL SELECT id FROM api_tokens WHERE revoked_at IS NULL",
		);
		await this.db.client.batch(
			[
				"DELETE FROM api_tokens",
				"DELETE FROM passkeys",
				"DELETE FROM auth_sessions",
				"DELETE FROM principals",
				"DELETE FROM setup_tokens",
				"DELETE FROM auth_throttle",
			],
			"write",
		);
		this.removeSetupTokenFile();
		this.ceremonies.clear();
		for (const row of live.rows) this.notifyEnded(String(row.id));
	}

	/** Spend the setup token, create the owner, and sign them in. */
	async setup(
		setupToken: string,
		password: string,
		source?: AuthSource,
	): Promise<IssuedSession> {
		if (await this.hasOwner())
			throw new AuthRefused("already_set_up", "setup is already complete");
		const scope = `setup:${throttleSource(sourceAddress(source))}`;
		return this.oneAtATime("setup", scope, source, async () => {
			const now = this.now();
			const row = await this.db.client.execute(
				"SELECT token_hash, expires_at FROM setup_tokens WHERE id = 1",
			);
			const stored = row.rows[0];
			const valid =
				!!stored &&
				Number(stored.expires_at) > now &&
				safeEqual(sha(setupToken), String(stored.token_hash));
			if (!valid) {
				await this.recordFailure(scope);
				if (isProxied(source)) await this.recordFailure(PROXIED_SETUP_SCOPE);
				throw new AuthRefused(
					"invalid_token",
					"that setup token is not valid; run `mfw auth setup-token` for a new one",
				);
			}
			// Checked after the token, so the policy is not an oracle for strangers.
			assertPasswordPolicy(password);
			const hash = await Bun.password.hash(password, { algorithm: "argon2id" });
			const id = randomUUID();
			// One atomic step: the token is spent only if this call created the owner.
			const [created] = await this.db.client.batch(
				[
					{
						sql: `INSERT INTO principals (id, kind, display_name, password_hash, created_at, updated_at)
							SELECT ?, 'owner', 'Owner', ?, ?, ?
							WHERE EXISTS (SELECT 1 FROM setup_tokens WHERE id = 1 AND token_hash = ? AND expires_at > ?)
							AND NOT EXISTS (SELECT 1 FROM principals WHERE kind = 'owner')`,
						args: [id, hash, now, now, sha(setupToken), now],
					},
					{
						sql: "DELETE FROM setup_tokens WHERE id = 1 AND token_hash = ?",
						args: [sha(setupToken)],
					},
				],
				"write",
			);
			if (created?.rowsAffected !== 1)
				throw new AuthRefused("already_set_up", "setup is already complete");
			await this.clearThrottle(scope);
			this.removeSetupTokenFile();
			return this.issue(id, 0);
		});
	}

	/**
	 * Verify the password and start a NEW session. The session the browser
	 * presented, if any, is revoked: an identifier planted before login is
	 * never promoted (session fixation). Failures count against `source` only,
	 * so one address cannot lock out another.
	 */
	async login(
		password: string,
		presented?: string,
		source?: AuthSource,
	): Promise<IssuedSession> {
		if (!(await this.hasOwner()))
			throw new AuthRefused("setup_required", "finish first-run setup");
		const scope = `login:${throttleSource(sourceAddress(source))}`;
		return this.oneAtATime("login", scope, source, async () => {
			const owner = await this.checkOwnerPassword(password);
			if (!owner) {
				await this.recordFailure(scope);
				if (isProxied(source)) await this.recordFailure(PROXIED_LOGIN_SCOPE);
				throw new AuthRefused("invalid_password", "wrong password");
			}
			await this.afterPasswordCheck?.();
			const issued = await this.issue(owner.id, owner.epoch);
			await this.clearThrottle(scope);
			if (presented) await this.logout(presented);
			return issued;
		});
	}

	/**
	 * Verify against the CURRENT hash, read inside the queue turn together with
	 * its epoch. A request that waited behind a change sees the new password.
	 */
	private async checkOwnerPassword(
		password: string,
	): Promise<{ id: string; epoch: number } | null> {
		if (password.length === 0 || password.length > PASSWORD_MAX) return null;
		return this.passwordChecks.run(async () => {
			const row = await this.db.client.execute(
				"SELECT id, password_hash, credential_epoch FROM principals WHERE kind = 'owner' LIMIT 1",
			);
			const owner = row.rows[0];
			if (!owner) return null;
			const ok = await Bun.password.verify(
				password,
				String(owner.password_hash),
			);
			return ok
				? { id: String(owner.id), epoch: Number(owner.credential_epoch) }
				: null;
		});
	}

	/**
	 * Change the password, proving the current one, and revoke every session
	 * except `keepSessionId`. This is how the owner evicts a stolen session.
	 */
	async changePassword(
		current: string,
		next: string,
		keepSessionId: string,
		source?: AuthSource,
	): Promise<void> {
		if (!(await this.hasOwner()))
			throw new AuthRefused("setup_required", "finish first-run setup");
		const scope = `login:${throttleSource(sourceAddress(source))}`;
		await this.oneAtATime("login", scope, source, async () => {
			const owner = await this.checkOwnerPassword(current);
			if (!owner) {
				await this.recordFailure(scope);
				if (isProxied(source)) await this.recordFailure(PROXIED_LOGIN_SCOPE);
				throw new AuthRefused("invalid_password", "wrong password");
			}
			await this.afterPasswordCheck?.();
			await this.clearThrottle(scope);
			assertPasswordPolicy(next);
			const hash = await Bun.password.hash(next, { algorithm: "argon2id" });
			const now = this.now();
			// One atomic step, and only from the epoch that was verified: the
			// revocation applies only if this call's update did.
			const [updated, revoked, revokedTokens] = await this.db.client.batch(
				[
					{
						sql: `UPDATE principals SET password_hash = ?, updated_at = ?,
							credential_epoch = credential_epoch + 1
							WHERE id = ? AND credential_epoch = ?`,
						args: [hash, now, owner.id, owner.epoch],
					},
					{
						sql: `UPDATE auth_sessions SET revoked_at = ?
							WHERE revoked_at IS NULL AND id != ?
							AND EXISTS (SELECT 1 FROM principals WHERE id = ? AND credential_epoch = ? AND password_hash = ?)
							RETURNING id`,
						args: [now, keepSessionId, owner.id, owner.epoch + 1, hash],
					},
					// A stolen session could have minted one: eviction must reach it.
					{
						sql: `UPDATE api_tokens SET revoked_at = ?
							WHERE revoked_at IS NULL
							AND EXISTS (SELECT 1 FROM principals WHERE id = ? AND credential_epoch = ? AND password_hash = ?)
							RETURNING id`,
						args: [now, owner.id, owner.epoch + 1, hash],
					},
				],
				"write",
			);
			if (updated?.rowsAffected !== 1)
				throw new AuthRefused(
					"invalid_password",
					"the password was just changed; use the new one",
				);
			for (const r of revoked?.rows ?? []) this.notifyEnded(String(r.id));
			for (const r of revokedTokens?.rows ?? []) this.endToken(String(r.id));
		});
	}

	/** Clear every failed-attempt record. The owner's way back in (`mfw auth unlock`). */
	async unlock(): Promise<void> {
		await this.db.client.execute("DELETE FROM auth_throttle");
	}

	/** Revoke the session this token belongs to. Unknown tokens are a no-op. */
	async logout(token: string): Promise<void> {
		const r = await this.db.client.execute({
			sql: "UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL RETURNING id",
			args: [this.now(), sha(token)],
		});
		for (const row of r.rows) this.notifyEnded(String(row.id));
	}

	/**
	 * Revoke every session and API token, and bump the epoch so a login already
	 * past its password check cannot create a new session afterwards.
	 */
	async revokeAll(): Promise<void> {
		const now = this.now();
		const [, revoked, revokedTokens] = await this.db.client.batch(
			[
				"UPDATE principals SET credential_epoch = credential_epoch + 1",
				{
					sql: "UPDATE auth_sessions SET revoked_at = ? WHERE revoked_at IS NULL RETURNING id",
					args: [now],
				},
				{
					sql: "UPDATE api_tokens SET revoked_at = ? WHERE revoked_at IS NULL RETURNING id",
					args: [now],
				},
			],
			"write",
		);
		for (const row of revoked?.rows ?? []) this.notifyEnded(String(row.id));
		for (const row of revokedTokens?.rows ?? []) this.endToken(String(row.id));
	}

	// ------------------------------------------------------------ passkeys

	private async ownerRow(): Promise<{ id: string; epoch: number } | null> {
		const r = await this.db.client.execute(
			"SELECT id, credential_epoch FROM principals WHERE kind = 'owner' LIMIT 1",
		);
		const row = r.rows[0];
		return row
			? { id: String(row.id), epoch: Number(row.credential_epoch) }
			: null;
	}

	private beginCeremony(
		kind: CeremonyKind,
		rp: RelyingParty,
		owner: { scope: string; proxied: boolean } | { sessionId: string },
	) {
		const why = relyingPartyError(rp);
		if (why) throw new AuthRefused("passkey_unavailable", why);
		try {
			return this.ceremonies.begin(kind, rp, owner);
		} catch (e) {
			if (isCeremonyFull(e))
				throw new AuthRefused("busy", e.message, e.retryAfterMs);
			throw e;
		}
	}

	/** Descriptors of the owner's credentials for this RP ID. */
	private async descriptors(rpId: string): Promise<{
		all: CredentialDescriptor[];
		allDiscoverable: boolean;
	}> {
		const r = await this.db.client.execute({
			sql: "SELECT credential_id, transports, discoverable FROM passkeys WHERE rp_id = ? ORDER BY created_at, rowid",
			args: [rpId],
		});
		return {
			all: r.rows.map((row) => ({
				type: "public-key",
				id: String(row.credential_id),
				transports: parseTransports(row.transports),
			})),
			allDiscoverable: r.rows.every((row) => Number(row.discoverable) === 1),
		};
	}

	/**
	 * Verify a passkey assertion against a ceremony taken by the caller, and
	 * advance its counter. Null when anything about it is wrong: the caller
	 * charges the throttle. The counter update is compare-and-set, so two
	 * uses of one counter value cannot both succeed.
	 */
	private async verifyPasskeyUse(
		ceremony: ReturnType<CeremonyStore["take"]>,
		kind: CeremonyKind,
		credential: unknown,
		rp: RelyingParty,
		ownerId: string,
		sessionId: string | null,
	): Promise<{ passkeyId: string } | null> {
		if (!ceremonyFits(ceremony, kind, sessionId, rp)) return null;
		const parsed = parseAssertionJSON(credential);
		if (!parsed) return null;
		const r = await this.db.client.execute({
			sql: `SELECT id, name, public_key, alg, rp_id, sign_count FROM passkeys
				WHERE credential_id = ? AND principal_id = ?`,
			args: [toBase64url(parsed.rawId), ownerId],
		});
		const row = r.rows[0];
		if (!row || String(row.rp_id) !== ceremony.rp.rpId) return null;
		if (
			parsed.userHandle &&
			toBase64url(parsed.userHandle) !== ownerUserHandle(ownerId)
		)
			return null;
		const stored = {
			alg: Number(row.alg),
			publicKeySpki: fromBase64url(String(row.public_key)) ?? new Uint8Array(),
			signCount: Number(row.sign_count),
		};
		let verified: ReturnType<typeof verifyAssertion>;
		try {
			verified = verifyAssertion(parsed, stored, {
				challenge: ceremony.challenge,
				rp: ceremony.rp,
			});
		} catch (e) {
			if (!isWebAuthnError(e)) throw e;
			// The one refusal the owner must hear about. Names only, no key material.
			if (e.reason === "counter")
				console.warn(
					`[mfw] passkey '${String(row.name)}' (${String(row.id)}) was refused: its signature counter went backwards, so another authenticator may hold a copy of it. Revoke it if this was not you.`,
				);
			return null;
		}
		const updated = await this.db.client.execute({
			sql: `UPDATE passkeys SET sign_count = ?, backed_up = ?, last_used_at = ?
				WHERE id = ? AND sign_count = ?`,
			args: [
				verified.signCount,
				verified.backedUp ? 1 : 0,
				this.now(),
				String(row.id),
				stored.signCount,
			],
		});
		return updated.rowsAffected === 1 ? { passkeyId: String(row.id) } : null;
	}

	/**
	 * Start a passkey sign-in. Public, so it is charged like a password
	 * attempt: a locked source gets no challenge, and each source holds only a
	 * few at a time.
	 */
	async beginPasskeyLogin(
		rp: RelyingParty,
		source?: AuthSource,
	): Promise<PasskeyCeremony<ReturnType<typeof requestOptions>>> {
		if (!(await this.hasOwner()))
			throw new AuthRefused("setup_required", "finish first-run setup");
		const scope = `login:${throttleSource(sourceAddress(source))}`;
		await this.assertNotLocked(scope);
		const ceremony = this.beginCeremony("login", rp, {
			scope,
			proxied: isProxied(source),
		});
		// Discoverable credentials need no list, and an empty one reveals nothing.
		const { all, allDiscoverable } = await this.descriptors(rp.rpId);
		return {
			ceremonyId: ceremony.id,
			publicKey: requestOptions(ceremony, allDiscoverable ? [] : all),
		};
	}

	/**
	 * Finish a passkey sign-in: the SAME session and request key as a password
	 * login. It shares the password's throttle scope, one-at-a-time rule and
	 * proxied budget, but not the password hashing queue, so a passkey flood
	 * cannot hold up a password sign-in there.
	 */
	async passkeyLogin(
		ceremonyId: unknown,
		credential: unknown,
		rp: RelyingParty,
		presented?: string,
		source?: AuthSource,
	): Promise<IssuedSession> {
		if (!(await this.hasOwner()))
			throw new AuthRefused("setup_required", "finish first-run setup");
		const scope = `login:${throttleSource(sourceAddress(source))}`;
		return this.oneAtATime("login", scope, source, async () => {
			// Taken first: a ceremony is spent by any attempt, good or bad.
			const ceremony = this.ceremonies.take(ceremonyId);
			const owner = await this.ownerRow();
			const ok =
				owner &&
				(await this.verifyPasskeyUse(
					ceremony,
					"login",
					credential,
					rp,
					owner.id,
					null,
				));
			if (!owner || !ok) {
				await this.recordFailure(scope);
				if (isProxied(source)) await this.recordFailure(PROXIED_LOGIN_SCOPE);
				throw new AuthRefused(
					"passkey_refused",
					"that passkey was not accepted; try again",
				);
			}
			await this.afterPasswordCheck?.();
			// The epoch read BEFORE verifying: a change since then refuses this.
			const issued = await this.issue(owner.id, owner.epoch, ok.passkeyId);
			await this.clearThrottle(scope);
			if (presented) await this.logout(presented);
			return issued;
		});
	}

	/** A re-verification challenge for a signed-in session, over its own passkeys. */
	async beginPasskeyReauth(
		sessionId: string,
		rp: RelyingParty,
	): Promise<PasskeyCeremony<ReturnType<typeof requestOptions>>> {
		if (!(await this.isSessionLive(sessionId)))
			throw new AuthRefused(
				"session_ended",
				"this session has ended; sign in again",
			);
		const { all } = await this.descriptors(rp.rpId);
		if (all.length === 0)
			throw new AuthRefused(
				"passkey_refused",
				"no passkey is registered for this address; confirm with the password",
			);
		const ceremony = this.beginCeremony("reauth", rp, { sessionId });
		return {
			ceremonyId: ceremony.id,
			publicKey: requestOptions(ceremony, all),
		};
	}

	/**
	 * Start adding a passkey. The session alone is not enough: the owner proves
	 * the password or an existing passkey again, so a stolen session cannot
	 * plant a lasting way back in. Failed proofs are charged like sign-ins.
	 */
	async beginPasskeyRegistration(
		sessionId: string,
		rp: RelyingParty,
		proof: PasskeyProof,
		source?: AuthSource,
	): Promise<PasskeyCeremony<ReturnType<typeof creationOptions>>> {
		const why = relyingPartyError(rp);
		if (why) throw new AuthRefused("passkey_unavailable", why);
		const scope = `login:${throttleSource(sourceAddress(source))}`;
		return this.oneAtATime("login", scope, source, async () => {
			const charge = async () => {
				await this.recordFailure(scope);
				if (isProxied(source)) await this.recordFailure(PROXIED_LOGIN_SCOPE);
			};
			let owner: { id: string } | null;
			if ("password" in proof) {
				owner = await this.checkOwnerPassword(proof.password);
				if (!owner) {
					await charge();
					throw new AuthRefused("invalid_password", "wrong password");
				}
			} else {
				owner = await this.ownerRow();
				const ceremony = this.ceremonies.take(proof.ceremonyId);
				const ok =
					owner &&
					(await this.verifyPasskeyUse(
						ceremony,
						"reauth",
						proof.credential,
						rp,
						owner.id,
						sessionId,
					));
				if (!ok) {
					await charge();
					throw new AuthRefused(
						"passkey_refused",
						"that passkey was not accepted; try again",
					);
				}
			}
			await this.clearThrottle(scope);
			if (!owner || !(await this.isSessionLive(sessionId)))
				throw new AuthRefused(
					"session_ended",
					"this session has ended; sign in again",
				);
			const count = await this.db.client.execute(
				"SELECT COUNT(*) AS n FROM passkeys",
			);
			if (Number(count.rows[0]?.n) >= MAX_PASSKEYS)
				throw new AuthRefused(
					"too_many_passkeys",
					`at most ${MAX_PASSKEYS} passkeys; revoke one first`,
				);
			const ceremony = this.beginCeremony("register", rp, { sessionId });
			const { all } = await this.descriptors(rp.rpId);
			return {
				ceremonyId: ceremony.id,
				publicKey: creationOptions(
					ceremony,
					{ id: ownerUserHandle(owner.id) },
					all,
				),
			};
		});
	}

	/** Store a new passkey from a registration ceremony of this session. */
	async finishPasskeyRegistration(
		sessionId: string,
		rp: RelyingParty,
		ceremonyId: unknown,
		credential: unknown,
		rawName: unknown,
	): Promise<PasskeyInfo> {
		const ceremony = this.ceremonies.take(ceremonyId);
		if (!ceremonyFits(ceremony, "register", sessionId, rp))
			throw new AuthRefused(
				"passkey_refused",
				"that registration expired or belongs to another session; start again",
			);
		const name = normalizePasskeyName(rawName);
		if (name === null)
			throw new AuthRefused(
				"invalid_request",
				"name the passkey in 1 to 64 printable characters",
			);
		const parsed = parseRegistrationJSON(credential);
		if (!parsed)
			throw new AuthRefused(
				"invalid_request",
				"malformed passkey registration",
			);
		let verified: ReturnType<typeof verifyRegistration>;
		try {
			verified = verifyRegistration(parsed, {
				challenge: ceremony.challenge,
				rp: ceremony.rp,
			});
		} catch (e) {
			if (!isWebAuthnError(e)) throw e;
			throw new AuthRefused(
				"passkey_refused",
				"the authenticator's response was not accepted; user verification (PIN or biometric) is required",
			);
		}
		const owner = await this.ownerRow();
		if (!owner)
			throw new AuthRefused("setup_required", "finish first-run setup");
		const now = this.now();
		const id = `pk_${randomUUID()}`;
		const credentialId = toBase64url(verified.credentialId);
		// One statement: only while this session is live, under the cap, and
		// never a second row for one credential.
		const inserted = await this.db.client.execute({
			sql: `INSERT INTO passkeys (id, principal_id, credential_id, public_key, alg, rp_id, name,
					sign_count, discoverable, backup_eligible, backed_up, transports, created_at)
				SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
				WHERE EXISTS (SELECT 1 FROM auth_sessions WHERE id = ? AND revoked_at IS NULL AND expires_at > ?)
				AND (SELECT COUNT(*) FROM passkeys) < ?
				AND NOT EXISTS (SELECT 1 FROM passkeys WHERE credential_id = ?)`,
			args: [
				id,
				owner.id,
				credentialId,
				toBase64url(verified.publicKeySpki),
				verified.alg,
				ceremony.rp.rpId,
				name,
				verified.signCount,
				parsed.discoverable === null ? null : parsed.discoverable ? 1 : 0,
				verified.backupEligible ? 1 : 0,
				verified.backedUp ? 1 : 0,
				JSON.stringify(parsed.transports),
				now,
				sessionId,
				now,
				MAX_PASSKEYS,
				credentialId,
			],
		});
		if (inserted.rowsAffected !== 1) {
			if (!(await this.isSessionLive(sessionId)))
				throw new AuthRefused(
					"session_ended",
					"this session has ended; sign in again",
				);
			const dup = await this.db.client.execute({
				sql: "SELECT 1 FROM passkeys WHERE credential_id = ?",
				args: [credentialId],
			});
			throw dup.rows.length
				? new AuthRefused(
						"passkey_refused",
						"that passkey is already registered",
					)
				: new AuthRefused(
						"too_many_passkeys",
						`at most ${MAX_PASSKEYS} passkeys; revoke one first`,
					);
		}
		return {
			id,
			name,
			rpId: ceremony.rp.rpId,
			createdAt: now,
			lastUsedAt: null,
			backedUp: verified.backedUp,
			discoverable: parsed.discoverable,
		};
	}

	/** Registered passkeys, oldest first. Never key material or credential ids. */
	async listPasskeys(): Promise<PasskeyInfo[]> {
		const r = await this.db.client.execute(
			`SELECT id, name, rp_id, created_at, last_used_at, backed_up, discoverable
				FROM passkeys ORDER BY created_at, rowid`,
		);
		return r.rows.map((row) => ({
			id: String(row.id),
			name: String(row.name),
			rpId: String(row.rp_id),
			createdAt: Number(row.created_at),
			lastUsedAt: row.last_used_at === null ? null : Number(row.last_used_at),
			backedUp: Number(row.backed_up) === 1,
			discoverable:
				row.discoverable === null ? null : Number(row.discoverable) === 1,
		}));
	}

	/**
	 * Remove a passkey and end every session it signed in. Other sessions and
	 * API tokens stay; sign out everywhere for those. False if it did not exist.
	 */
	async revokePasskey(id: string): Promise<boolean> {
		const [deleted, revoked] = await this.db.client.batch(
			[
				{ sql: "DELETE FROM passkeys WHERE id = ? RETURNING id", args: [id] },
				{
					sql: "UPDATE auth_sessions SET revoked_at = ? WHERE passkey_id = ? AND revoked_at IS NULL RETURNING id",
					args: [this.now(), id],
				},
			],
			"write",
		);
		for (const row of revoked?.rows ?? []) this.notifyEnded(String(row.id));
		return (deleted?.rows.length ?? 0) > 0;
	}

	/** Pending passkey ceremonies (tests). */
	get pendingPasskeyCeremonies(): number {
		return this.ceremonies.size;
	}

	/**
	 * Create a scoped token. The secret is returned once and stored as a digest.
	 * With `sessionId`, the insert happens only while that session is live, in
	 * one statement, so a sign-out-everywhere cannot miss a token being minted.
	 * Only owner paths call this: no route that accepts a token reaches it.
	 */
	async createToken(
		input: {
			name?: unknown;
			scopes?: unknown;
			project?: unknown;
			ttlMs?: unknown;
		},
		opts: { sessionId?: string } = {},
	): Promise<{ token: string; info: TokenInfo }> {
		const request = normalizeTokenRequest(input);
		if (typeof request === "string")
			throw new AuthRefused("invalid_token_request", request);
		const owner = await this.db.client.execute(
			"SELECT id FROM principals WHERE kind = 'owner' LIMIT 1",
		);
		const ownerId = owner.rows[0]?.id;
		if (ownerId === undefined || ownerId === null)
			throw new AuthRefused("setup_required", "finish first-run setup");
		const now = this.now();
		await this.db.client.execute({
			sql: "DELETE FROM api_tokens WHERE (revoked_at IS NOT NULL AND revoked_at < ?) OR expires_at < ?",
			args: [now - TOKEN_RETENTION_MS, now - TOKEN_RETENTION_MS],
		});
		const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
		const id = `tok_${randomUUID()}`;
		const expiresAt = now + request.ttlMs;
		const sessionClause = opts.sessionId
			? "AND EXISTS (SELECT 1 FROM auth_sessions WHERE id = ? AND revoked_at IS NULL AND expires_at > ?)"
			: "";
		const inserted = await this.db.client.execute({
			sql: `INSERT INTO api_tokens (id, name, token_hash, principal_id, scopes, project, created_at, expires_at)
				SELECT ?, ?, ?, ?, ?, ?, ?, ?
				WHERE (SELECT COUNT(*) FROM api_tokens WHERE revoked_at IS NULL AND expires_at > ?) < ?
				${sessionClause}`,
			args: [
				id,
				request.name,
				sha(token),
				String(ownerId),
				JSON.stringify(request.scopes),
				request.project,
				now,
				expiresAt,
				now,
				MAX_LIVE_TOKENS,
				...(opts.sessionId ? [opts.sessionId, now] : []),
			],
		});
		if (inserted.rowsAffected !== 1)
			throw new AuthRefused(
				"too_many_tokens",
				opts.sessionId && !(await this.isSessionLive(opts.sessionId))
					? "this session has ended; sign in again"
					: `at most ${MAX_LIVE_TOKENS} live tokens; revoke one first`,
			);
		return {
			token,
			info: {
				id,
				name: request.name,
				scopes: [...request.scopes],
				project: request.project,
				createdAt: now,
				expiresAt,
				lastUsedAt: null,
				revokedAt: null,
				status: "active",
			},
		};
	}

	/** Every token the owner can still see, newest first. Never a secret. */
	async listTokens(): Promise<TokenInfo[]> {
		const r = await this.db.client.execute(
			`SELECT id, name, scopes, project, created_at, expires_at, last_used_at, revoked_at
				FROM api_tokens ORDER BY created_at DESC, rowid DESC`,
		);
		const now = this.now();
		return r.rows.map((row) => {
			const revokedAt = row.revoked_at === null ? null : Number(row.revoked_at);
			const expiresAt = Number(row.expires_at);
			return {
				id: String(row.id),
				name: String(row.name),
				scopes: parseScopes(row.scopes) ?? [],
				project: row.project === null ? null : String(row.project),
				createdAt: Number(row.created_at),
				expiresAt,
				lastUsedAt: row.last_used_at === null ? null : Number(row.last_used_at),
				revokedAt,
				status:
					revokedAt !== null
						? "revoked"
						: expiresAt <= now
							? "expired"
							: "active",
			};
		});
	}

	/** Revoke one token and end its open streams. False if it was not live. */
	async revokeToken(id: string): Promise<boolean> {
		const r = await this.db.client.execute({
			sql: "UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL RETURNING id",
			args: [this.now(), id],
		});
		if (r.rows.length === 0) return false;
		this.endToken(id);
		return true;
	}

	private endToken(id: string): void {
		this.tokenRate.forget(id);
		this.notifyEnded(id);
	}

	/** The principal for a presented bearer token, or null. Fails closed. */
	async authenticateToken(
		token: string | null | undefined,
	): Promise<TokenPrincipal | null> {
		if (!token) return null;
		const now = this.now();
		const r = await this.db.client.execute({
			sql: `SELECT id, name, scopes, project, expires_at, last_used_at, revoked_at
				FROM api_tokens WHERE token_hash = ?`,
			args: [sha(token)],
		});
		const row = r.rows[0];
		if (!row || row.revoked_at !== null || Number(row.expires_at) <= now)
			return null;
		const scopes = parseScopes(row.scopes);
		if (!scopes) return null;
		const tokenId = String(row.id);
		if (
			row.last_used_at === null ||
			now - Number(row.last_used_at) >= TOKEN_TOUCH_EVERY_MS
		)
			await this.db.client.execute({
				sql: "UPDATE api_tokens SET last_used_at = ? WHERE id = ?",
				args: [now, tokenId],
			});
		return {
			kind: "token",
			id: `token:${tokenId}`,
			tokenId,
			name: String(row.name),
			scopes,
			project: row.project === null ? null : String(row.project),
		};
	}

	/** Charge one request to a token. 0 when allowed, else ms until retry. */
	takeTokenRate(tokenId: string): number {
		return this.tokenRate.take(tokenId, this.now());
	}

	/** True while the token exists, is unrevoked and unexpired. */
	async isTokenLive(tokenId: string): Promise<boolean> {
		const r = await this.db.client.execute({
			sql: "SELECT expires_at, revoked_at FROM api_tokens WHERE id = ?",
			args: [tokenId],
		});
		const row = r.rows[0];
		return (
			!!row && row.revoked_at === null && Number(row.expires_at) > this.now()
		);
	}

	/** True when this token may open another stream. */
	tokenStreamAvailable(tokenId: string): boolean {
		return (this.listeners.get(tokenId)?.size ?? 0) < MAX_TOKEN_STREAMS;
	}

	/**
	 * Watch a token's long-lived response: `onEnd` runs at once on revocation in
	 * this process, and within a second on expiry or a revocation by the CLI.
	 */
	watchToken(tokenId: string, onEnd: () => void): () => void {
		return this.watch(
			tokenId,
			() => this.isTokenLive(tokenId),
			this.tokenStreamRecheckMs,
			onEnd,
		);
	}

	/** Record a token's action before it runs. Throws if it cannot be recorded. */
	async beginTokenAction(entry: {
		tokenId: string;
		name: string;
		path: string;
		project: string | null;
		kind?: TokenAuditKind;
		outcome?: string;
	}): Promise<number> {
		const kind = entry.kind ?? "mutation";
		const r = await this.db.client.execute({
			sql: `INSERT INTO token_audit (token_id, token_name, path, project, kind, outcome, at)
				VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
			args: [
				entry.tokenId,
				entry.name,
				entry.path,
				entry.project,
				kind,
				entry.outcome ?? "started",
				this.now(),
			],
		});
		const id = Number(r.rows[0]?.id);
		const keep =
			kind === "stream"
				? this.tokenAuditRetention.streams
				: this.tokenAuditRetention.mutations;
		// Counted per token and kind: the shared row id could skip one forever.
		const key = `${entry.tokenId}:${kind}`;
		const inserts = (this.tokenAuditInserts.get(key) ?? 0) + 1;
		if (inserts >= Math.min(TOKEN_AUDIT_PRUNE_EVERY, keep)) {
			this.tokenAuditInserts.delete(key);
			await this.pruneTokenAudit(entry.tokenId, entry.name, kind, keep);
		} else this.tokenAuditInserts.set(key, inserts);
		return id;
	}

	/**
	 * Retention is per token and per kind, so no token's volume can erase
	 * another's record or its own mutations with cheap calls. What a token's
	 * own mutations do push out is counted, so the loss is visible.
	 */
	private async pruneTokenAudit(
		tokenId: string,
		name: string,
		kind: TokenAuditKind,
		keep: number,
	): Promise<void> {
		const r = await this.db.client.execute({
			sql: `DELETE FROM token_audit WHERE token_id = ? AND kind = ? AND id <= (
					SELECT id FROM token_audit WHERE token_id = ? AND kind = ?
					ORDER BY id DESC LIMIT 1 OFFSET ?
				)`,
			args: [tokenId, kind, tokenId, kind, keep],
		});
		if (r.rowsAffected === 0) return;
		await this.db.client.execute({
			sql: `INSERT INTO token_audit_counters (token_id, token_name, dropped) VALUES (?, ?, ?)
				ON CONFLICT (token_id) DO UPDATE SET dropped = dropped + excluded.dropped`,
			args: [tokenId, name, r.rowsAffected],
		});
	}

	async finishTokenAction(id: number, outcome: string): Promise<void> {
		await this.db.client.execute({
			sql: "UPDATE token_audit SET outcome = ? WHERE id = ?",
			args: [outcome, id],
		});
	}

	/** Count a refused call. One row per token, however many refusals. */
	async recordTokenRefusal(entry: {
		tokenId: string;
		name: string;
		path: string;
	}): Promise<void> {
		const now = this.now();
		await this.db.client.execute({
			sql: `INSERT INTO token_audit_counters (token_id, token_name, refused, last_refused_at, last_refused_path)
				VALUES (?, ?, 1, ?, ?)
				ON CONFLICT (token_id) DO UPDATE SET refused = refused + 1,
					last_refused_at = excluded.last_refused_at,
					last_refused_path = excluded.last_refused_path`,
			args: [entry.tokenId, entry.name, now, entry.path],
		});
	}

	/** Mutations and stream opens, newest first. */
	async listTokenAudit(
		opts: { limit?: number; tokenId?: string } = {},
	): Promise<TokenAuditEntry[]> {
		const limit = Math.min(Math.max(1, opts.limit ?? 100), 1000);
		const r = await this.db.client.execute({
			sql: `SELECT id, token_id, token_name, path, project, kind, outcome, at
				FROM token_audit ${opts.tokenId ? "WHERE token_id = ?" : ""}
				ORDER BY id DESC LIMIT ?`,
			args: opts.tokenId ? [opts.tokenId, limit] : [limit],
		});
		return r.rows.map((row) => ({
			id: Number(row.id),
			tokenId: String(row.token_id),
			name: String(row.token_name),
			path: String(row.path),
			project: row.project === null ? null : String(row.project),
			kind: row.kind === "stream" ? "stream" : "mutation",
			outcome: String(row.outcome),
			at: Number(row.at),
		}));
	}

	/** Per-token refusal and retention counts. */
	async tokenAuditCounters(): Promise<TokenAuditCounter[]> {
		const r = await this.db.client.execute(
			`SELECT token_id, token_name, refused, last_refused_at, last_refused_path, dropped
				FROM token_audit_counters ORDER BY token_name, token_id`,
		);
		return r.rows.map((row) => ({
			tokenId: String(row.token_id),
			name: String(row.token_name),
			refused: Number(row.refused),
			lastRefusedAt:
				row.last_refused_at === null ? null : Number(row.last_refused_at),
			lastRefusedPath:
				row.last_refused_path === null ? null : String(row.last_refused_path),
			dropped: Number(row.dropped),
		}));
	}

	/** The live session for a cookie value, or null. Fails closed. */
	async authenticate(
		token: string | null | undefined,
	): Promise<AuthenticatedSession | null> {
		if (!token) return null;
		const now = this.now();
		const r = await this.db.client.execute({
			sql: `SELECT id, principal_id, last_seen_at, expires_at, revoked_at, request_key_hash
				FROM auth_sessions WHERE token_hash = ?`,
			args: [sha(token)],
		});
		const row = r.rows[0];
		if (!row || !isLive(row, now)) return null;
		if (now - Number(row.last_seen_at) >= TOUCH_EVERY_MS)
			await this.db.client.execute({
				sql: "UPDATE auth_sessions SET last_seen_at = ? WHERE id = ?",
				args: [now, String(row.id)],
			});
		const sessionId = String(row.id);
		return {
			principal: { kind: "owner", id: String(row.principal_id), sessionId },
			sessionId,
			expiresAt: Math.min(
				Number(row.expires_at),
				Math.max(now, Number(row.last_seen_at)) + SESSION_IDLE_MS,
			),
			requestKeyHash: String(row.request_key_hash),
		};
	}

	/** Constant-time check of a request's key against its session. */
	checkRequestKey(
		session: Pick<AuthenticatedSession, "requestKeyHash">,
		presented: string | null | undefined,
	): boolean {
		if (!presented || !session.requestKeyHash) return false;
		return safeEqual(sha(presented), session.requestKeyHash);
	}

	/** True while the session exists, is unrevoked and unexpired. No touch. */
	async isSessionLive(sessionId: string): Promise<boolean> {
		const r = await this.db.client.execute({
			sql: "SELECT last_seen_at, expires_at, revoked_at FROM auth_sessions WHERE id = ?",
			args: [sessionId],
		});
		const row = r.rows[0];
		return !!row && isLive(row, this.now());
	}

	/**
	 * Watch a long-lived response's session: `onEnd` runs once, at once on
	 * revocation and within one recheck of expiry. A failed recheck ends it too.
	 * The returned function stops the watch without calling `onEnd`.
	 */
	watchSession(sessionId: string, onEnd: () => void): () => void {
		return this.watch(
			sessionId,
			() => this.isSessionLive(sessionId),
			this.streamRecheckMs,
			onEnd,
		);
	}

	private watch(
		key: string,
		isLive: () => Promise<boolean>,
		recheckMs: number,
		onEnd: () => void,
	): () => void {
		const listeners = this.listeners.get(key) ?? new Set<() => void>();
		this.listeners.set(key, listeners);
		let ended = false;
		const release = () => {
			clearInterval(timer);
			listeners.delete(end);
			if (listeners.size === 0 && this.listeners.get(key) === listeners)
				this.listeners.delete(key);
		};
		const end = () => {
			if (ended) return;
			ended = true;
			release();
			onEnd();
		};
		const timer = setInterval(() => {
			isLive().then((live) => {
				if (!live) end();
			}, end);
		}, recheckMs);
		(timer as unknown as { unref?: () => void }).unref?.();
		listeners.add(end);
		return release;
	}

	/** Open stream watches (tests and status). */
	get watchedStreams(): number {
		let n = 0;
		for (const l of this.listeners.values()) n += l.size;
		return n;
	}

	private notifyEnded(sessionId: string): void {
		this.ceremonies.dropSession(sessionId);
		for (const end of [...(this.listeners.get(sessionId) ?? [])]) end();
	}

	/**
	 * Create a session, only if the credentials are still those that were
	 * verified. The check and the insert are one statement, so a change is
	 * either seen here or revokes this row.
	 */
	private async issue(
		principalId: string,
		epoch: number,
		/** The passkey that signed in: revoking it ends this session. */
		passkeyId: string | null = null,
	): Promise<IssuedSession> {
		const token = randomBytes(32).toString("base64url");
		const requestKey = randomBytes(32).toString("base64url");
		const requestKeyHash = sha(requestKey);
		const sessionId = randomUUID();
		const now = this.now();
		const expiresAt = now + SESSION_ABSOLUTE_MS;
		const inserted = await this.db.client.execute({
			sql: `INSERT INTO auth_sessions (id, token_hash, principal_id, created_at, last_seen_at, expires_at, request_key_hash, passkey_id)
				SELECT ?, ?, ?, ?, ?, ?, ?, ?
				WHERE EXISTS (SELECT 1 FROM principals WHERE id = ? AND credential_epoch = ?)
				${passkeyId ? "AND EXISTS (SELECT 1 FROM passkeys WHERE id = ? AND principal_id = ?)" : ""}`,
			args: [
				sessionId,
				sha(token),
				principalId,
				now,
				now,
				expiresAt,
				requestKeyHash,
				passkeyId,
				principalId,
				epoch,
				...(passkeyId ? [passkeyId, principalId] : []),
			],
		});
		if (inserted.rowsAffected !== 1)
			throw new AuthRefused(
				"invalid_password",
				"the credentials just changed; sign in again",
			);
		// Keep the newest live sessions; anything older is revoked, not just hidden.
		const stale = await this.db.client.execute({
			sql: `UPDATE auth_sessions SET revoked_at = ? WHERE revoked_at IS NULL AND principal_id = ?
				AND id NOT IN (SELECT id FROM auth_sessions WHERE revoked_at IS NULL AND principal_id = ?
					ORDER BY created_at DESC, rowid DESC LIMIT ?) RETURNING id`,
			args: [now, principalId, principalId, MAX_SESSIONS],
		});
		for (const row of stale.rows) this.notifyEnded(String(row.id));
		return {
			token,
			principal: { kind: "owner", id: principalId, sessionId },
			sessionId,
			expiresAt: Math.min(expiresAt, now + SESSION_IDLE_MS),
			requestKey,
			requestKeyHash,
		};
	}

	/** A source has one attempt in flight, so parallel guesses cannot race its count. */
	private async oneAtATime<T>(
		kind: "setup" | "login",
		scope: string,
		source: AuthSource | undefined,
		run: () => Promise<T>,
	): Promise<T> {
		if (this.inFlight.has(scope))
			throw new AuthRefused(
				"locked",
				"another attempt from this address is in progress",
				1000,
			);
		this.inFlight.add(scope);
		const proxied = isProxied(source);
		// Taken before the first await: every earlier attempt is either counted
		// here or already recorded, so concurrent requests cannot overshoot.
		const earlier = proxied ? this.proxiedInFlight[kind]++ : 0;
		try {
			await this.assertNotLocked(scope);
			if (proxied) await this.paceProxied(kind, earlier);
			return await run();
		} finally {
			if (proxied) this.proxiedInFlight[kind]--;
			this.inFlight.delete(scope);
		}
	}

	/**
	 * Forged client addresses each get a fresh per-address bucket, so proxied
	 * attempts share one failure count. Past it they are spaced out rather than
	 * locked: a lock here would let a forger keep the real owner out.
	 */
	private async paceProxied(
		kind: "setup" | "login",
		inFlightBefore: number,
	): Promise<void> {
		const r = await this.db.client.execute({
			sql: "SELECT failures, last_failure_at FROM auth_throttle WHERE scope = ?",
			args: [kind === "setup" ? PROXIED_SETUP_SCOPE : PROXIED_LOGIN_SCOPE],
		});
		const row = r.rows[0];
		const recorded =
			row && this.now() - Number(row.last_failure_at) < THROTTLE_RESET_MS
				? Number(row.failures)
				: 0;
		if (recorded + inFlightBefore >= PROXIED_FREE_FAILURES)
			await this.proxiedChecks.run(async () => undefined);
	}

	private async assertNotLocked(scope: string): Promise<void> {
		const r = await this.db.client.execute({
			sql: "SELECT locked_until FROM auth_throttle WHERE scope = ?",
			args: [scope],
		});
		const lockedUntil = Number(r.rows[0]?.locked_until ?? 0);
		const now = this.now();
		if (lockedUntil > now)
			throw new AuthRefused(
				"locked",
				"too many failed attempts from this address; try again later, or run `mfw auth unlock` on the server",
				lockedUntil - now,
			);
	}

	private async recordFailure(scope: string): Promise<void> {
		const now = this.now();
		const r = await this.db.client.execute({
			sql: "SELECT failures, last_failure_at FROM auth_throttle WHERE scope = ?",
			args: [scope],
		});
		const row = r.rows[0];
		const prior =
			row && now - Number(row.last_failure_at) < THROTTLE_RESET_MS
				? Number(row.failures)
				: 0;
		const failures = prior + 1;
		const delay = backoffMs(failures);
		await this.db.client.batch(
			[
				{
					sql: `INSERT INTO auth_throttle (scope, failures, locked_until, last_failure_at) VALUES (?, ?, ?, ?)
						ON CONFLICT (scope) DO UPDATE SET failures = excluded.failures,
							locked_until = excluded.locked_until, last_failure_at = excluded.last_failure_at`,
					args: [scope, failures, delay ? now + delay : 0, now],
				},
				// Per-source rows must not grow without bound.
				{
					sql: "DELETE FROM auth_throttle WHERE last_failure_at < ? AND locked_until < ?",
					args: [now - THROTTLE_RESET_MS, now],
				},
			],
			"write",
		);
	}

	private async clearThrottle(scope: string): Promise<void> {
		await this.db.client.execute({
			sql: "DELETE FROM auth_throttle WHERE scope = ?",
			args: [scope],
		});
	}
}

function isLive(row: Record<string, unknown>, now: number): boolean {
	return (
		row.revoked_at === null &&
		Number(row.expires_at) > now &&
		now - Number(row.last_seen_at) < SESSION_IDLE_MS
	);
}

/** The WebAuthn user handle: the owner's id, which carries nothing personal. */
const ownerUserHandle = (principalId: string) =>
	Buffer.from(principalId, "utf8").toString("base64url");

function parseTransports(raw: unknown): string[] {
	try {
		const parsed: unknown = JSON.parse(String(raw));
		return Array.isArray(parsed)
			? parsed.filter((t): t is string => typeof t === "string")
			: [];
	} catch {
		return [];
	}
}

/** Stored scopes, or null if anything is outside the closed set. */
function parseScopes(raw: unknown): TokenScope[] | null {
	try {
		const parsed: unknown = JSON.parse(String(raw));
		return Array.isArray(parsed) &&
			parsed.length > 0 &&
			parsed.every(isTokenScope)
			? parsed
			: null;
	} catch {
		return null;
	}
}

export function assertPasswordPolicy(password: string): void {
	if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX)
		throw new AuthRefused(
			"weak_password",
			`use a password of ${PASSWORD_MIN} to ${PASSWORD_MAX} characters`,
		);
	if (isCommonPassword(password))
		throw new AuthRefused(
			"weak_password",
			"that password is too common or repetitive; choose another",
		);
}

export const authDbPath = (home: string) => join(resolve(home), "auth.db");

const KEY = Symbol.for("mfw.authService");
type Holder = { [KEY]?: Map<string, Promise<AuthService>> };

/**
 * The one service for a home, on `globalThis` for the same reason as the
 * orchestrator: the production bundle can emit this module into several chunks.
 */
export function authServiceFor(home: string): Promise<AuthService> {
	const holder = globalThis as unknown as Holder;
	holder[KEY] ??= new Map();
	const all = holder[KEY];
	const path = authDbPath(home);
	let service = all.get(path);
	if (!service) {
		service = AuthService.open(path);
		all.set(path, service);
		service.catch(() => all.delete(path));
	}
	return service;
}
