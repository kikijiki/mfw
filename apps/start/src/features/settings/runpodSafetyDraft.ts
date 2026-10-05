export interface SafetyDraft {
	maxHourlyPrice: string;
	maxAggregateHourlyPrice: string;
	maxRuntimeMinutes: string;
	maxRunSpend: string;
}

export interface RunPodSafetyValues {
	enabled: true;
	maxHourlyPrice: number;
	maxAggregateHourlyPrice: number;
	maxRuntimeMinutes: number;
	maxRunSpend: number;
}

function positive(value: string, label: string, whole = false): number {
	const parsed = Number(value);
	if (
		!Number.isFinite(parsed) ||
		parsed <= 0 ||
		(whole && !Number.isInteger(parsed))
	) {
		throw new Error(
			`${label} must be ${whole ? "a positive whole number" : "greater than zero"}`,
		);
	}
	return parsed;
}

export function validateRunPodSafetyDraft(
	draft: SafetyDraft,
): RunPodSafetyValues {
	return {
		enabled: true,
		maxHourlyPrice: positive(draft.maxHourlyPrice, "Per-Pod hourly limit"),
		maxAggregateHourlyPrice: positive(
			draft.maxAggregateHourlyPrice,
			"Total hourly limit",
		),
		maxRuntimeMinutes: positive(
			draft.maxRuntimeMinutes,
			"Maximum runtime",
			true,
		),
		maxRunSpend: positive(draft.maxRunSpend, "Per-run spend limit"),
	};
}

export function runPodSafetyReview(
	proposed: RunPodSafetyValues,
	prior: RunPodSafetyValues,
	alreadyEnabled: boolean,
): string {
	const change = (next: string, before: string, equal: boolean) =>
		alreadyEnabled
			? `${next} (${equal ? "unchanged" : `was ${before}`})`
			: `${next} (new limit)`;
	return [
		`Maximum per Pod ${change(`$${proposed.maxHourlyPrice.toFixed(2)}/hr`, `$${prior.maxHourlyPrice.toFixed(2)}/hr`, proposed.maxHourlyPrice === prior.maxHourlyPrice)}`,
		`Maximum total ${change(`$${proposed.maxAggregateHourlyPrice.toFixed(2)}/hr`, `$${prior.maxAggregateHourlyPrice.toFixed(2)}/hr`, proposed.maxAggregateHourlyPrice === prior.maxAggregateHourlyPrice)}`,
		`Maximum runtime ${change(`${proposed.maxRuntimeMinutes} minutes`, `${prior.maxRuntimeMinutes} minutes`, proposed.maxRuntimeMinutes === prior.maxRuntimeMinutes)}`,
		`Maximum spend per run ${change(`$${proposed.maxRunSpend.toFixed(2)}`, `$${prior.maxRunSpend.toFixed(2)}`, proposed.maxRunSpend === prior.maxRunSpend)}`,
	].join("; ");
}

export interface RunPodSafetyDraftBinding {
	draft: SafetyDraft;
	base: SafetyDraft;
	/** The exact server version from which this draft was created. */
	baseVersion: number;
	conflicted: boolean;
}

export function safetyDraftOf(policy: {
	enabled: boolean;
	[key: string]: unknown;
}): SafetyDraft {
	return {
		maxHourlyPrice: String(policy.enabled ? policy.maxHourlyPrice : 0.5),
		maxAggregateHourlyPrice: String(
			policy.enabled ? policy.maxAggregateHourlyPrice : 1,
		),
		maxRuntimeMinutes: String(policy.enabled ? policy.maxRuntimeMinutes : 120),
		maxRunSpend: String(policy.enabled ? policy.maxRunSpend : 1),
	};
}

export function bindRunPodSafetyDraft(
	policy: Parameters<typeof safetyDraftOf>[0],
	version: number,
): RunPodSafetyDraftBinding {
	const draft = safetyDraftOf(policy);
	return { draft, base: draft, baseVersion: version, conflicted: false };
}

export function editRunPodSafetyDraft(
	binding: RunPodSafetyDraftBinding,
	key: keyof SafetyDraft,
	value: string,
): RunPodSafetyDraftBinding {
	return { ...binding, draft: { ...binding.draft, [key]: value } };
}

export function markRunPodSafetyConflict(
	binding: RunPodSafetyDraftBinding,
): RunPodSafetyDraftBinding {
	return { ...binding, conflicted: true };
}

export function runPodSafetyDraftDirty(
	binding: RunPodSafetyDraftBinding,
): boolean {
	return JSON.stringify(binding.draft) !== JSON.stringify(binding.base);
}
