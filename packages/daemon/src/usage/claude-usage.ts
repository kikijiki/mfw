import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	clampPercent,
	type UsageProbe,
	UsageProbeError,
	type UsageProbeResult,
	type UsageWindow,
} from "./types.ts";

/**
 * Claude Code subscription windows, from the same endpoint Claude Code's own
 * `/usage` screen reads: `GET https://api.anthropic.com/api/oauth/usage` with
 * the OAuth access token the CLI stored at login.
 *
 * UNOFFICIAL: the endpoint and the `anthropic-beta: oauth-2025-04-20` header
 * are not documented. This adapter is therefore isolated here, switchable
 * (`MFW_USAGE_CLAUDE_OAUTH=0`, or `usage.claudeOauth: false`), and fails
 * closed: any surprise (shape, status, expired login) is `unavailable`, never
 * a guessed number.
 *
 * Token handling: the credential file is read inside `run`, the token goes
 * into one request header and nowhere else, and no error text, log line or
 * result field ever contains it. mfw never refreshes the token: a refresh
 * rotates the refresh token and could sign the human's own CLI out. An expired
 * access token is reported as "sign-in expired"; any `claude` run renews it.
 */

export const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const CLAUDE_USAGE_SOURCE = "claude-oauth-usage";

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function percentOf(v: unknown): number | null {
	return typeof v === "number" && Number.isFinite(v) ? clampPercent(v) : null;
}

function resetOf(v: unknown): number | null {
	if (typeof v === "number" && Number.isFinite(v))
		return v < 1e12 ? v * 1000 : v;
	if (typeof v === "string") {
		const t = Date.parse(v);
		return Number.isFinite(t) ? t : null;
	}
	return null;
}

function windowOf(
	label: string,
	percent: unknown,
	reset: unknown,
	minutes: number | null,
): UsageWindow | null {
	const usedPercent = percentOf(percent);
	if (usedPercent === null) return null;
	return {
		label,
		usedPercent,
		resetsAt: resetOf(reset),
		windowMinutes: minutes,
		source: CLAUDE_USAGE_SOURCE,
	};
}

/** Pure: the endpoint's JSON into windows. Throws when nothing usable is in it. */
export function parseClaudeUsage(body: unknown): UsageWindow[] {
	if (!isRecord(body)) throw new UsageProbeError("unexpected usage response");
	const out: UsageWindow[] = [];

	// Preferred: the `limits` list the /usage screen draws.
	if (Array.isArray(body.limits)) {
		for (const l of body.limits) {
			if (!isRecord(l)) continue;
			let label: string | null = null;
			let minutes: number | null = null;
			if (l.kind === "session") {
				label = "5h";
				minutes = 300;
			} else if (l.kind === "weekly_all") {
				label = "7d";
				minutes = 10_080;
			} else if (l.kind === "weekly_scoped") {
				const model =
					isRecord(l.scope) && isRecord(l.scope.model) ? l.scope.model : null;
				const name =
					model && typeof model.display_name === "string"
						? model.display_name
						: null;
				if (name) {
					label = `7d ${name}`;
					minutes = 10_080;
				}
			}
			if (!label) continue;
			const w = windowOf(label, l.percent, l.resets_at, minutes);
			if (w) out.push(w);
		}
	}

	// Fallback: the older flat fields.
	if (out.length === 0) {
		const flat: [string, string, number][] = [
			["five_hour", "5h", 300],
			["seven_day", "7d", 10_080],
			["seven_day_opus", "7d Opus", 10_080],
			["seven_day_sonnet", "7d Sonnet", 10_080],
		];
		for (const [key, label, minutes] of flat) {
			const v = body[key];
			if (!isRecord(v)) continue;
			const w = windowOf(label, v.utilization, v.resets_at, minutes);
			if (w) out.push(w);
		}
	}

	if (out.length === 0)
		throw new UsageProbeError("no usage windows in response");
	return out;
}

export interface ClaudeUsageDeps {
	/** `$HOME`; the credential file is `<config dir>/.credentials.json`. */
	home?: string;
	env?: NodeJS.ProcessEnv;
	fetch?: (url: string, init: RequestInit) => Promise<Response>;
	now?: () => number;
	/** Reads a file as text; rejects when absent. */
	readFile?: (path: string) => Promise<string>;
	timeoutMs?: number;
}

function credentialsPath(deps: ClaudeUsageDeps): string {
	const env = deps.env ?? process.env;
	const dir = env.CLAUDE_CONFIG_DIR || join(deps.home ?? homedir(), ".claude");
	return join(dir, ".credentials.json");
}

export function claudeUsageProbe(deps: ClaudeUsageDeps = {}): UsageProbe {
	const read = deps.readFile ?? ((p: string) => readFile(p, "utf8"));
	const now = deps.now ?? Date.now;
	const doFetch = deps.fetch ?? ((url, init) => fetch(url, init));

	async function loadOauth(): Promise<Record<string, unknown> | null> {
		let raw: string;
		try {
			raw = await read(credentialsPath(deps));
		} catch {
			return null;
		}
		try {
			const parsed: unknown = JSON.parse(raw);
			const oauth = isRecord(parsed) ? parsed.claudeAiOauth : null;
			return isRecord(oauth) ? oauth : null;
		} catch {
			return null;
		}
	}

	return {
		provider: "claude-cli",
		name: "Claude Code",
		async available() {
			return (await loadOauth()) !== null;
		},
		async run(signal): Promise<UsageProbeResult> {
			const oauth = await loadOauth();
			const token = oauth?.accessToken;
			if (!oauth || typeof token !== "string" || token === "")
				throw new UsageProbeError("not signed in", true);
			if (typeof oauth.expiresAt === "number" && oauth.expiresAt <= now())
				throw new UsageProbeError(
					"sign-in expired (run claude once to renew)",
					true,
				);
			let res: Response;
			try {
				res = await doFetch(CLAUDE_USAGE_URL, {
					method: "GET",
					headers: {
						authorization: `Bearer ${token}`,
						"anthropic-beta": "oauth-2025-04-20",
						accept: "application/json",
					},
					signal: AbortSignal.any([
						signal,
						AbortSignal.timeout(deps.timeoutMs ?? 10_000),
					]),
				});
			} catch {
				// The error object can echo request details: report only the class.
				throw new UsageProbeError("usage endpoint unreachable");
			}
			if (res.status === 401 || res.status === 403)
				throw new UsageProbeError("usage endpoint rejected the sign-in", true);
			if (res.status === 429)
				throw new UsageProbeError("usage endpoint is rate limiting");
			if (!res.ok)
				throw new UsageProbeError(`usage endpoint HTTP ${res.status}`);
			let body: unknown;
			try {
				body = await res.json();
			} catch {
				throw new UsageProbeError("usage response was not JSON");
			}
			const plan =
				typeof oauth.subscriptionType === "string" && oauth.subscriptionType
					? oauth.subscriptionType
					: null;
			return { accountLabel: plan, windows: parseClaudeUsage(body) };
		},
	};
}
