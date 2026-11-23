import {
	createHash,
	createHmac,
	randomBytes,
	randomUUID,
	timingSafeEqual,
} from "node:crypto";
import { join, resolve } from "node:path";
import { type AuthDb, openAuthDb } from "./store.ts";

/**
 * Auth v1: one owner, a first-run setup token, a password, and revocable
 * server-side sessions. Transport concerns (cookies, redirects, Origin) live in
 * the app's request guard; this module holds the rules.
 */

/** Who is acting. Later scoped tokens add kinds; audit attributes by `id`. */
export type Principal =
	| { kind: "owner"; id: string; sessionId: string }
	| { kind: "brain"; id: string; runId: string }
	/** In-process callers only (`createCaller`); never built from a request. */
	| { kind: "internal"; id: "internal" };

export interface AuthenticatedSession {
	principal: Extract<Principal, { kind: "owner" }>;
	sessionId: string;
	expiresAt: number;
	csrfToken: string;
}

export interface IssuedSession extends AuthenticatedSession {
	/** The cookie value. Returned once, stored only as a digest. */
	token: string;
}

export type AuthRefusalCode =
	| "setup_required"
	| "already_set_up"
	| "invalid_token"
	| "invalid_password"
	| "weak_password"
	| "locked";

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
/** How often an open stream re-checks its session (revocation is immediate). */
const STREAM_RECHECK_MS = 15 * 1000;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function safeEqual(a: string, b: string): boolean {
	const x = createHash("sha256").update(a).digest();
	const y = createHash("sha256").update(b).digest();
	return timingSafeEqual(x, y);
}

const csrfFor = (token: string) =>
	createHmac("sha256", token).update("mfw-csrf-v1").digest("base64url");

export function backoffMs(failures: number): number {
	if (failures < FREE_ATTEMPTS) return 0;
	const exp = Math.min(failures - FREE_ATTEMPTS, 20);
	return Math.min(BACKOFF_BASE_MS * 2 ** exp, BACKOFF_MAX_MS);
}

export interface AuthServiceOptions {
	now?: () => number;
	/** How often an open stream re-checks its session. */
	streamRecheckMs?: number;
}

export class AuthService {
	private readonly now: () => number;
	private readonly streamRecheckMs: number;
	private readonly listeners = new Map<string, Set<() => void>>();
	/** Serializes throttle check-and-charge so parallel guesses cannot race it. */
	private gate: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly db: AuthDb,
		opts: AuthServiceOptions = {},
	) {
		this.now = opts.now ?? Date.now;
		this.streamRecheckMs = opts.streamRecheckMs ?? STREAM_RECHECK_MS;
	}

	static async open(
		path: string,
		opts: AuthServiceOptions = {},
	): Promise<AuthService> {
		return new AuthService(await openAuthDb(path), opts);
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
	 * Called at server start. With no owner, replaces any earlier token and
	 * returns the new one for the caller to print; only its digest is kept, so
	 * a restart before setup is the way to get a fresh one. With an owner,
	 * returns null and clears any leftover.
	 */
	async beginFirstRun(): Promise<string | null> {
		const now = this.now();
		await this.db.client.execute({
			sql: "DELETE FROM auth_sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL OR last_seen_at <= ?",
			args: [now, now - SESSION_IDLE_MS],
		});
		if (await this.hasOwner()) {
			await this.db.client.execute("DELETE FROM setup_tokens");
			return null;
		}
		const token = randomBytes(32).toString("base64url");
		await this.db.client.execute({
			sql: `INSERT INTO setup_tokens (id, token_hash, created_at, expires_at) VALUES (1, ?, ?, ?)
				ON CONFLICT (id) DO UPDATE SET token_hash = excluded.token_hash,
					created_at = excluded.created_at, expires_at = excluded.expires_at`,
			args: [sha(token), now, now + SETUP_TOKEN_TTL_MS],
		});
		return token;
	}

	/** Spend the setup token, create the owner, and sign them in. */
	async setup(setupToken: string, password: string): Promise<IssuedSession> {
		if (await this.hasOwner())
			throw new AuthRefused("already_set_up", "setup is already complete");
		await this.charge("setup");
		const now = this.now();
		const row = await this.db.client.execute(
			"SELECT token_hash, expires_at FROM setup_tokens WHERE id = 1",
		);
		const stored = row.rows[0];
		const valid =
			!!stored &&
			Number(stored.expires_at) > now &&
			safeEqual(sha(setupToken), String(stored.token_hash));
		if (!valid)
			throw new AuthRefused(
				"invalid_token",
				"that setup token is not valid; restart the server to print a new one",
			);
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
		await this.clearThrottle("setup");
		return this.issue(id);
	}

	/**
	 * Verify the password and start a NEW session. The session the browser
	 * presented, if any, is revoked: an identifier planted before login is
	 * never promoted (session fixation).
	 */
	async login(password: string, presented?: string): Promise<IssuedSession> {
		const row = await this.db.client.execute(
			"SELECT id, password_hash FROM principals WHERE kind = 'owner' LIMIT 1",
		);
		const owner = row.rows[0];
		if (!owner)
			throw new AuthRefused("setup_required", "finish first-run setup");
		// Charged before verifying: parallel guesses each consume an attempt.
		await this.charge("login");
		const ok =
			password.length > 0 &&
			password.length <= PASSWORD_MAX &&
			(await Bun.password.verify(password, String(owner.password_hash)));
		if (!ok) throw new AuthRefused("invalid_password", "wrong password");
		await this.clearThrottle("login");
		if (presented) await this.logout(presented);
		return this.issue(String(owner.id));
	}

	/** Revoke the session this token belongs to. Unknown tokens are a no-op. */
	async logout(token: string): Promise<void> {
		const r = await this.db.client.execute({
			sql: "UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL RETURNING id",
			args: [this.now(), sha(token)],
		});
		for (const row of r.rows) this.notifyEnded(String(row.id));
	}

	/** Revoke every session (for example after a credential change). */
	async revokeAll(): Promise<void> {
		const r = await this.db.client.execute({
			sql: "UPDATE auth_sessions SET revoked_at = ? WHERE revoked_at IS NULL RETURNING id",
			args: [this.now()],
		});
		for (const row of r.rows) this.notifyEnded(String(row.id));
	}

	/** The live session for a cookie value, or null. Fails closed. */
	async authenticate(
		token: string | null | undefined,
	): Promise<AuthenticatedSession | null> {
		if (!token) return null;
		const now = this.now();
		const r = await this.db.client.execute({
			sql: `SELECT id, principal_id, last_seen_at, expires_at, revoked_at
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
			csrfToken: csrfFor(token),
		};
	}

	/** Constant-time check of a request's CSRF token against its session token. */
	checkCsrf(token: string, presented: string | null | undefined): boolean {
		if (!presented) return false;
		return safeEqual(csrfFor(token), presented);
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
		const listeners = this.listeners.get(sessionId) ?? new Set<() => void>();
		this.listeners.set(sessionId, listeners);
		const release = () => {
			clearInterval(timer);
			listeners.delete(end);
			if (listeners.size === 0) this.listeners.delete(sessionId);
		};
		const end = () => {
			release();
			onEnd();
		};
		const timer = setInterval(() => {
			this.isSessionLive(sessionId).then((live) => {
				if (!live) end();
			}, end);
		}, this.streamRecheckMs);
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
		for (const end of [...(this.listeners.get(sessionId) ?? [])]) end();
	}

	private async issue(principalId: string): Promise<IssuedSession> {
		const token = randomBytes(32).toString("base64url");
		const sessionId = randomUUID();
		const now = this.now();
		const expiresAt = now + SESSION_ABSOLUTE_MS;
		await this.db.client.execute({
			sql: `INSERT INTO auth_sessions (id, token_hash, principal_id, created_at, last_seen_at, expires_at)
				VALUES (?, ?, ?, ?, ?, ?)`,
			args: [sessionId, sha(token), principalId, now, now, expiresAt],
		});
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
			csrfToken: csrfFor(token),
		};
	}

	/** Refuse while locked, otherwise record one attempt. */
	private charge(scope: string): Promise<void> {
		const run = this.gate.then(() => this.chargeNow(scope));
		this.gate = run.catch(() => undefined);
		return run;
	}

	private async chargeNow(scope: string): Promise<void> {
		const now = this.now();
		const r = await this.db.client.execute({
			sql: "SELECT failures, locked_until, last_failure_at FROM auth_throttle WHERE scope = ?",
			args: [scope],
		});
		const row = r.rows[0];
		const lockedUntil = row ? Number(row.locked_until) : 0;
		if (lockedUntil > now)
			throw new AuthRefused(
				"locked",
				"too many failed attempts; try again later",
				lockedUntil - now,
			);
		const prior =
			row && now - Number(row.last_failure_at) < THROTTLE_RESET_MS
				? Number(row.failures)
				: 0;
		const failures = prior + 1;
		const delay = backoffMs(failures);
		await this.db.client.execute({
			sql: `INSERT INTO auth_throttle (scope, failures, locked_until, last_failure_at) VALUES (?, ?, ?, ?)
				ON CONFLICT (scope) DO UPDATE SET failures = excluded.failures,
					locked_until = excluded.locked_until, last_failure_at = excluded.last_failure_at`,
			args: [scope, failures, delay ? now + delay : 0, now],
		});
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

export function assertPasswordPolicy(password: string): void {
	if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX)
		throw new AuthRefused(
			"weak_password",
			`use a password of ${PASSWORD_MIN} to ${PASSWORD_MAX} characters`,
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
