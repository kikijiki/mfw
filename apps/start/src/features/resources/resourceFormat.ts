export function formatCapacity(
	value: bigint | null,
	unit: "integer" | "bytes" | null,
): string {
	if (value === null) return "Not observed";
	if (unit !== "bytes") return value.toString();
	const units = ["B", "KiB", "MiB", "GiB", "TiB"] as const;
	let divisor = 1n;
	let index = 0;
	while (value / divisor >= 1024n && index < units.length - 1) {
		divisor *= 1024n;
		index++;
	}
	if (index === 0) return `${value.toString()} B`;
	const tenths = (value * 10n + divisor / 2n) / divisor;
	const whole = tenths / 10n;
	const decimal = tenths % 10n;
	return `${whole.toString()}${decimal === 0n ? "" : `.${decimal.toString()}`} ${units[index]}`;
}

export function isObservationStale(reason: string | null): boolean {
	return (
		reason === "observation-stale" ||
		reason === "observation-not-current-process" ||
		reason === "observation-not-current-kernel"
	);
}

export type ObservationFreshness =
	| "fresh"
	| "stale"
	| "unavailable"
	| "ignored"
	| "not-required";

/** A small, UI-facing truth table for the live check behind effective
 * capacity. Expiry is compared with the browser clock so the label can become
 * stale even between read-model polls. */
export function observationFreshness(
	observation: {
		observedAt: number | null;
		expiresAt: number | null;
		policy: "required" | "ignored-explicitly";
	} | null,
	holdReason: string | null,
	now: number,
): ObservationFreshness {
	if (observation?.policy === "ignored-explicitly") return "ignored";
	if (
		holdReason === "observation-missing" ||
		holdReason === "observation-ambiguous" ||
		holdReason === "observation-failed" ||
		holdReason === "observation-inconsistent"
	) {
		return "unavailable";
	}
	if (!observation) return "not-required";
	if (observation.observedAt === null) return "unavailable";
	if (
		isObservationStale(holdReason) ||
		(observation.expiresAt !== null && observation.expiresAt <= now)
	) {
		return "stale";
	}
	return "fresh";
}

const HOLD_REASON_LABELS: Record<string, string> = {
	disabled: "Resource is unavailable",
	draining: "Finishing current work",
	"dynamic-unprovisioned": "Resource is not provisioned",
	"invalid-definition": "Resource configuration is invalid",
	"quota-exhausted": "Configured capacity is fully reserved",
	"observation-missing": "Hardware observation is missing",
	"observation-ambiguous": "Hardware observation is ambiguous",
	"observation-not-current-process":
		"Hardware observation is from a previous service process",
	"observation-not-current-kernel":
		"Hardware observation is from a previous system boot",
	"observation-stale": "Hardware observation is stale",
	"observation-failed": "Hardware observation failed",
	"observation-inconsistent": "Hardware observation data is inconsistent",
	"cpu-pressure": "CPU pressure is above the configured limit",
	"external-occupancy": "GPU is occupied by another application",
	"unknown-occupancy": "GPU occupancy cannot be verified",
	"headroom-exhausted": "Memory safety headroom is exhausted",
};

export function formatHoldReason(reason: string): string {
	return HOLD_REASON_LABELS[reason] ?? reason.replaceAll("-", " ");
}

export const LIVE_LEASE_STATES = new Set([
	"provisional",
	"active",
	"uncertain",
	"releasing",
]);
