import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	clampPercent,
	type UsageProbe,
	UsageProbeError,
	type UsageProbeResult,
	type UsageWindow,
	windowLabel,
} from "./types.ts";

/**
 * Codex subscription windows from the Codex app-server's own account API:
 * `account/rateLimits/read` returns `rateLimits.primary` / `.secondary`, each
 * `{ usedPercent, windowDurationMins, resetsAt }` (resetsAt in epoch seconds).
 * It is part of the app-server's documented JSON-RPC surface (the one mfw's
 * Codex bridge already speaks), costs no model call, and the numbers are the
 * ones the Codex CLI shows itself.
 *
 * A short-lived `codex app-server` is spawned per probe (about a second):
 * `initialize`, `initialized`, one `account/rateLimits/read`, kill. A
 * long-lived server would save the spawn but add a process to supervise for
 * a 60 second read; the spawn is bounded, single-flight and cheap.
 */

export const CODEX_USAGE_SOURCE = "codex-app-server";

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseWindow(label: string | null, raw: unknown): UsageWindow | null {
	if (!isRecord(raw)) return null;
	const pct = raw.usedPercent;
	if (typeof pct !== "number" || !Number.isFinite(pct)) return null;
	const mins =
		typeof raw.windowDurationMins === "number" && raw.windowDurationMins > 0
			? raw.windowDurationMins
			: null;
	const reset = raw.resetsAt;
	const resetsAt =
		typeof reset === "number" && Number.isFinite(reset)
			? reset < 1e12
				? reset * 1000
				: reset
			: null;
	return {
		label: label ?? (mins ? windowLabel(mins) : "limit"),
		usedPercent: clampPercent(pct),
		resetsAt,
		windowMinutes: mins,
		source: CODEX_USAGE_SOURCE,
	};
}

/** Pure: an `account/rateLimits/read` result into windows. Throws when none. */
export function parseCodexRateLimits(result: unknown): UsageProbeResult {
	if (!isRecord(result))
		throw new UsageProbeError("unexpected rate limit reply");
	const main = isRecord(result.rateLimits) ? result.rateLimits : null;
	const windows: UsageWindow[] = [];
	const add = (w: UsageWindow | null, prefix: string | null) => {
		if (!w) return;
		windows.push(prefix ? { ...w, label: `${w.label} ${prefix}` } : w);
	};
	if (main) {
		add(parseWindow(null, main.primary), null);
		add(parseWindow(null, main.secondary), null);
	}
	// Per-model limits, when the account has any: named buckets besides the main one.
	const mainId = main && typeof main.limitId === "string" ? main.limitId : null;
	const byId = isRecord(result.rateLimitsByLimitId)
		? result.rateLimitsByLimitId
		: {};
	for (const [id, v] of Object.entries(byId)) {
		if (id === mainId || !isRecord(v)) continue;
		const name =
			typeof v.limitName === "string" && v.limitName ? v.limitName : null;
		if (!name) continue;
		add(parseWindow(null, v.primary), name);
		add(parseWindow(null, v.secondary), name);
	}
	if (windows.length === 0)
		throw new UsageProbeError("no rate limit windows reported");
	const plan = main && typeof main.planType === "string" ? main.planType : null;
	return { accountLabel: plan, windows };
}

/** The JSON-RPC pipe to a `codex app-server`, injectable for tests. */
export interface CodexRpcTransport {
	write(line: string): void;
	/** Called once per stdout line. */
	onLine(cb: (line: string) => void): void;
	/** Called when the process exits or the pipe closes. */
	onClose(cb: () => void): void;
	kill(): void;
}

export function spawnCodexTransport(command: string): CodexRpcTransport {
	const proc = spawn(command, ["app-server"], {
		stdio: ["pipe", "pipe", "ignore"],
	});
	let buf = "";
	const lineCbs: ((l: string) => void)[] = [];
	const closeCbs: (() => void)[] = [];
	proc.stdout.on("data", (d: Buffer) => {
		buf += d.toString("utf8");
		let i = buf.indexOf("\n");
		while (i >= 0) {
			const line = buf.slice(0, i);
			buf = buf.slice(i + 1);
			for (const cb of lineCbs) cb(line);
			i = buf.indexOf("\n");
		}
	});
	const closed = () => {
		for (const cb of closeCbs) cb();
	};
	proc.on("close", closed);
	proc.on("error", closed);
	proc.stdin.on("error", () => {});
	return {
		write: (line) => {
			proc.stdin.write(`${line}\n`);
		},
		onLine: (cb) => lineCbs.push(cb),
		onClose: (cb) => closeCbs.push(cb),
		kill: () => {
			try {
				proc.kill("SIGTERM");
			} catch {
				// already gone
			}
		},
	};
}

/** Drive one `account/rateLimits/read` over a transport. */
export async function readCodexRateLimits(
	transport: CodexRpcTransport,
	signal: AbortSignal,
	timeoutMs = 15_000,
): Promise<unknown> {
	return await new Promise<unknown>((resolve, reject) => {
		let done = false;
		const finish = (fn: () => void) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			transport.kill();
			fn();
		};
		const timer = setTimeout(
			() =>
				finish(() => reject(new UsageProbeError("codex app-server timed out"))),
			timeoutMs,
		);
		signal.addEventListener(
			"abort",
			() => finish(() => reject(new UsageProbeError("probe aborted"))),
			{ once: true },
		);
		transport.onClose(() =>
			finish(() => reject(new UsageProbeError("codex app-server exited"))),
		);
		transport.onLine((line) => {
			let msg: unknown;
			try {
				msg = JSON.parse(line);
			} catch {
				return;
			}
			if (!isRecord(msg) || typeof msg.id !== "number") return;
			if (msg.id === 1) {
				if (msg.error !== undefined)
					return finish(() =>
						reject(new UsageProbeError("codex app-server refused initialize")),
					);
				transport.write(JSON.stringify({ method: "initialized", params: {} }));
				transport.write(
					JSON.stringify({ id: 2, method: "account/rateLimits/read" }),
				);
			} else if (msg.id === 2) {
				if (msg.error !== undefined || msg.result === undefined)
					return finish(() =>
						reject(
							new UsageProbeError(
								"codex has no subscription rate limits (not signed in with ChatGPT?)",
								true,
							),
						),
					);
				const result = msg.result;
				finish(() => resolve(result));
			}
		});
		transport.write(
			JSON.stringify({
				id: 1,
				method: "initialize",
				params: {
					clientInfo: { name: "mfw-usage", version: "1" },
					capabilities: {},
				},
			}),
		);
	});
}

export interface CodexUsageDeps {
	home?: string;
	/** The `codex` binary to spawn; default `codex` on PATH. */
	command?: string;
	/** Test seam: replaces the spawned process. */
	transport?: () => CodexRpcTransport;
	/** Test seam: replaces the "signed in" file check. */
	signedIn?: () => Promise<boolean>;
	timeoutMs?: number;
}

export function codexUsageProbe(deps: CodexUsageDeps = {}): UsageProbe {
	const authFile = join(deps.home ?? homedir(), ".codex", "auth.json");
	return {
		provider: "codex-cli",
		name: "Codex",
		async available() {
			if (deps.signedIn) return deps.signedIn();
			try {
				await readFile(authFile, "utf8");
				return true;
			} catch {
				return false;
			}
		},
		async run(signal) {
			const transport =
				deps.transport?.() ?? spawnCodexTransport(deps.command ?? "codex");
			const result = await readCodexRateLimits(
				transport,
				signal,
				deps.timeoutMs,
			);
			return parseCodexRateLimits(result);
		},
	};
}
