import { readFileSync } from "node:fs";
import { whichBin } from "../agents/detect.ts";
import { claudeWeeklyProbe, type RateLimitObserver } from "./claude-weekly.ts";
import { codexUsageProbe } from "./codex-usage.ts";
import { clampPercent, type UsageProbe, type UsageWindow } from "./types.ts";

export interface UsageConfig {
	/** Master switch; `MFW_USAGE_MONITOR=0` also turns it off. */
	enabled?: boolean;
	/** Where the Claude weekly meter gets its observed `rate_limit_event`s; without one it reads "unknown". */
	claudeObserver?: RateLimitObserver;
	/** Replace the probes entirely (tests). */
	probes?: readonly UsageProbe[];
}

export function usageEnabled(
	cfg: UsageConfig | undefined,
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	if (cfg?.enabled === false) return false;
	return env.MFW_USAGE_MONITOR !== "0";
}

/**
 * `MFW_USAGE_FIXTURE=<file.json>`: serve a fixed usage snapshot instead of
 * probing any harness, so screenshots and demos never read a real credential.
 * The file is `{ subscriptions: [{ provider, name, accountLabel, windows:
 * [{ label, usedPercent, resetsAt, windowMinutes }] }] }`, `resetsAt` in epoch
 * ms. A development seam like `MFW_USAGE_MONITOR=0`; an unreadable file yields
 * no probes rather than falling back to the real ones.
 */
export function fixtureUsageProbes(path: string): UsageProbe[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return [];
	}
	const subs = (parsed as { subscriptions?: unknown }).subscriptions;
	if (!Array.isArray(subs)) return [];
	const probes: UsageProbe[] = [];
	for (const raw of subs) {
		const s = raw as {
			provider?: unknown;
			name?: unknown;
			accountLabel?: unknown;
			windows?: unknown;
		};
		if (typeof s.provider !== "string" || !Array.isArray(s.windows)) continue;
		const windows: UsageWindow[] = [];
		for (const w of s.windows as Array<Record<string, unknown>>) {
			if (typeof w.label !== "string" || typeof w.usedPercent !== "number")
				continue;
			windows.push({
				label: w.label,
				usedPercent: clampPercent(w.usedPercent),
				resetsAt: typeof w.resetsAt === "number" ? w.resetsAt : null,
				windowMinutes:
					typeof w.windowMinutes === "number" ? w.windowMinutes : null,
				source: "fixture",
			});
		}
		probes.push({
			provider: s.provider,
			name: typeof s.name === "string" ? s.name : s.provider,
			available: async () => true,
			run: async () => ({
				accountLabel:
					typeof s.accountLabel === "string" ? s.accountLabel : null,
				windows,
			}),
		});
	}
	return probes;
}

/**
 * The probes for the harnesses mfw knows. A probe whose CLI is not installed
 * reports itself unavailable and stays hidden.
 */
export function defaultUsageProbes(
	cfg: UsageConfig | undefined,
	env: NodeJS.ProcessEnv = process.env,
): UsageProbe[] {
	if (cfg?.probes) return [...cfg.probes];
	if (env.MFW_USAGE_FIXTURE) return fixtureUsageProbes(env.MFW_USAGE_FIXTURE);
	const probes: UsageProbe[] = [];
	// No token read and no vendor endpoint: the weekly meter is whatever the
	// CLI's own `rate_limit_event`s said, or unknown.
	const claude = claudeWeeklyProbe({ observer: cfg?.claudeObserver });
	probes.push({
		...claude,
		available: async () => (await whichBin("claude", env)) !== null,
	});
	const codex = codexUsageProbe();
	probes.push({
		...codex,
		available: async () =>
			(await whichBin("codex", env)) !== null && (await codex.available()),
	});
	return probes;
}
