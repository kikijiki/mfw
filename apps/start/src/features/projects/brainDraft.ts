import type { RouterInputs, RouterOutputs } from "../../lib/trpc";

/**
 * The project's `brain` config as an editable draft, pure. The stored shape
 * is `{routes, heartbeatMin?, rolloverTokens?, turnTimeoutMs?, maxTurnsPerHour?,
 * maxTurnsPerDay?}`; the form edits strings so a blank field means "use the
 * default", and `brainPatch` turns a draft back into exactly that shape.
 *
 * No routes means no brain: saving an empty route list writes `null`, which
 * turns the brain off (nothing is dispatched until a route is added).
 */

export type StoredBrain = NonNullable<
	RouterOutputs["settings"]["get"]["values"]["brain"]
>;
export type BrainPatch = NonNullable<
	RouterInputs["settings"]["update"]["patch"]["brain"]
>;

export const EFFORTS = [
	"none",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;
export type Effort = (typeof EFFORTS)[number];

export interface RouteDraft {
	provider: string;
	model: string;
	effort: Effort | "";
}

export interface BrainDraft {
	routes: RouteDraft[];
	heartbeatMin: string;
	rolloverTokens: string;
	turnTimeoutMin: string;
	maxTurnsPerHour: string;
	maxTurnsPerDay: string;
}

/** What the daemon uses for a blank field (`BRAIN_DEFAULTS` in the brain runtime). */
export const BRAIN_DEFAULT_HINTS = {
	heartbeatMin: 30,
	rolloverTokens: 120_000,
	turnTimeoutMin: 10,
	maxTurnsPerHour: 12,
	maxTurnsPerDay: 150,
} as const;

export const EMPTY_DRAFT: BrainDraft = {
	routes: [],
	heartbeatMin: "",
	rolloverTokens: "",
	turnTimeoutMin: "",
	maxTurnsPerHour: "",
	maxTurnsPerDay: "",
};

export function draftFromStored(
	stored: StoredBrain | null | undefined,
): BrainDraft {
	if (!stored) return { ...EMPTY_DRAFT, routes: [] };
	const num = (n: number | undefined) => (n === undefined ? "" : String(n));
	return {
		routes: stored.routes.map((r) => ({
			provider: r.provider,
			model: r.model ?? "",
			effort: (r.effort ?? "") as Effort | "",
		})),
		heartbeatMin: num(stored.heartbeatMin),
		rolloverTokens: num(stored.rolloverTokens),
		turnTimeoutMin:
			stored.turnTimeoutMs === undefined
				? ""
				: String(Math.round(stored.turnTimeoutMs / 60_000)),
		maxTurnsPerHour: num(stored.maxTurnsPerHour),
		maxTurnsPerDay: num(stored.maxTurnsPerDay),
	};
}

const NUMERIC = [
	["heartbeatMin", "Heartbeat (minutes)"],
	["rolloverTokens", "Rollover tokens"],
	["turnTimeoutMin", "Turn timeout (minutes)"],
	["maxTurnsPerHour", "Max turns per hour"],
	["maxTurnsPerDay", "Max turns per day"],
] as const satisfies readonly [keyof BrainDraft, string][];

/** Everything wrong with a draft, one sentence each; empty means it can be saved. */
export function draftProblems(draft: BrainDraft): string[] {
	const out: string[] = [];
	draft.routes.forEach((r, i) => {
		if (r.provider.trim() === "") out.push(`Route ${i + 1} needs a provider.`);
		else if (!/^[A-Za-z0-9._@-]+$/.test(r.provider.trim()))
			out.push(`Route ${i + 1}: "${r.provider}" is not a provider id.`);
	});
	for (const [key, label] of NUMERIC) {
		const v = String(draft[key]).trim();
		if (v === "") continue;
		if (!/^\d+$/.test(v) || Number(v) < 1) {
			out.push(`${label} must be a whole number of at least 1.`);
		}
	}
	return out;
}

/**
 * The patch for a draft: the stored object, or `null` to turn the brain off
 * when no route is left. Blank numbers are omitted so defaults apply.
 */
export function brainPatch(draft: BrainDraft): BrainPatch | null {
	if (draft.routes.length === 0) return null;
	const n = (v: string): number | undefined =>
		v.trim() === "" ? undefined : Number(v.trim());
	const heartbeatMin = n(draft.heartbeatMin);
	const rolloverTokens = n(draft.rolloverTokens);
	const turnTimeoutMin = n(draft.turnTimeoutMin);
	const maxTurnsPerHour = n(draft.maxTurnsPerHour);
	const maxTurnsPerDay = n(draft.maxTurnsPerDay);
	return {
		routes: draft.routes.map((r) => ({
			provider: r.provider.trim(),
			...(r.model.trim() ? { model: r.model.trim() } : {}),
			...(r.effort ? { effort: r.effort } : {}),
		})),
		...(heartbeatMin !== undefined ? { heartbeatMin } : {}),
		...(rolloverTokens !== undefined ? { rolloverTokens } : {}),
		...(turnTimeoutMin !== undefined
			? { turnTimeoutMs: turnTimeoutMin * 60_000 }
			: {}),
		...(maxTurnsPerHour !== undefined ? { maxTurnsPerHour } : {}),
		...(maxTurnsPerDay !== undefined ? { maxTurnsPerDay } : {}),
	};
}

export function isDirty(draft: BrainDraft, base: BrainDraft): boolean {
	return JSON.stringify(draft) !== JSON.stringify(base);
}

export function moveRoute(
	routes: readonly RouteDraft[],
	index: number,
	by: -1 | 1,
): RouteDraft[] {
	const to = index + by;
	if (to < 0 || to >= routes.length) return [...routes];
	const next = [...routes];
	const [moved] = next.splice(index, 1);
	if (moved) next.splice(to, 0, moved);
	return next;
}

/** One line for the section header: what is configured now. */
export function describeBrain(stored: StoredBrain | null | undefined): string {
	if (!stored || stored.routes.length === 0) {
		return "Off: no brain route, so nothing is dispatched.";
	}
	const first = stored.routes[0];
	const extra = stored.routes.length - 1;
	return `On: ${first?.provider}${first?.model ? ` · ${first.model}` : ""}${
		extra > 0 ? ` (+${extra} fallback${extra === 1 ? "" : "s"})` : ""
	}`;
}
