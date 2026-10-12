import { readFileSync } from "node:fs";
import { whichBin } from "../agents/detect.ts";
import { claudeUsageProbe } from "./claude-usage.ts";
import { codexUsageProbe } from "./codex-usage.ts";
import { clampPercent, type UsageProbe, type UsageWindow } from "./types.ts";

export interface UsageConfig {
	/** Master switch; `MFW_USAGE_MONITOR=0` also turns it off. */
	enabled?: boolean;
	/** The unofficial Claude OAuth usage endpoint; `MFW_USAGE_CLAUDE_OAUTH=0` also turns it off. */
	claudeOauth?: boolean;
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
 * or not signed in reports itself unavailable and stays hidden.
 */
export function defaultUsageProbes(
	cfg: UsageConfig | undefined,
	env: NodeJS.ProcessEnv = process.env,
): UsageProbe[] {
	if (cfg?.probes) return [...cfg.probes];
	if (env.MFW_USAGE_FIXTURE) return fixtureUsageProbes(env.MFW_USAGE_FIXTURE);
	const probes: UsageProbe[] = [];
	const claudeOauth =
		cfg?.claudeOauth !== false && env.MFW_USAGE_CLAUDE_OAUTH !== "0";
	if (claudeOauth) {
		const claude = claudeUsageProbe({ env });
		probes.push({
			...claude,
			available: async () =>
				(await whichBin("claude", env)) !== null && (await claude.available()),
		});
	}
	const codex = codexUsageProbe();
	probes.push({
		...codex,
		available: async () =>
			(await whichBin("codex", env)) !== null && (await codex.available()),
	});
	return probes;
}
