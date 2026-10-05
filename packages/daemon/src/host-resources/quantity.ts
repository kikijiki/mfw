import type { LinuxMemoryObservation } from "@mfw/core/host-observation";

/** Largest positive integer which can be stored exactly by SQLite INTEGER. */
export const MAX_HOST_QUANTITY = 9_223_372_036_854_775_807n;

export const RAM_OBSERVATION_MAX_AGE_MS = 30_000;
export const RAM_OBSERVATION_FUTURE_SKEW_MS = 1_000;

const IEC_UNITS = [
	["EiB", 1n << 60n],
	["PiB", 1n << 50n],
	["TiB", 1n << 40n],
	["GiB", 1n << 30n],
	["MiB", 1n << 20n],
	["KiB", 1n << 10n],
	["B", 1n],
] as const;

export class QuantityParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "QuantityParseError";
	}
}

export function checkedHostQuantity(value: bigint, label = "quantity"): bigint {
	if (value <= 0n) {
		throw new QuantityParseError(`${label} must be a positive integer`);
	}
	if (value > MAX_HOST_QUANTITY) {
		throw new QuantityParseError(
			`${label} exceeds the maximum supported integer ${MAX_HOST_QUANTITY}`,
		);
	}
	return value;
}

export function checkedQuantitySum(
	left: bigint,
	right: bigint,
	label = "quantity sum",
): bigint {
	if (left < 0n || right < 0n || left > MAX_HOST_QUANTITY) {
		throw new QuantityParseError(`${label} has an invalid integer input`);
	}
	if (right > MAX_HOST_QUANTITY - left) {
		throw new QuantityParseError(
			`${label} exceeds the maximum supported integer ${MAX_HOST_QUANTITY}`,
		);
	}
	return left + right;
}

export function parseIntegerQuantity(value: unknown, label = "amount"): bigint {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
		throw new QuantityParseError(
			`${label} must be a positive integer without a unit`,
		);
	}
	return checkedHostQuantity(BigInt(value), label);
}

/**
 * Parse the deliberately narrow RAM authoring grammar. A single ASCII space,
 * integer magnitude, and explicit IEC unit make YAML and UI round-trips
 * unambiguous; decimal/SI spellings are rejected instead of rounded.
 */
export function parseIecBytes(value: unknown, label = "RAM amount"): bigint {
	if (typeof value !== "string") {
		throw new QuantityParseError(
			`${label} must include an IEC unit such as '8 GiB'`,
		);
	}
	const match = /^([1-9][0-9]*) (B|KiB|MiB|GiB|TiB|PiB|EiB)$/.exec(value);
	if (!match) {
		throw new QuantityParseError(
			`${label} must be a positive whole number followed by B, KiB, MiB, GiB, TiB, PiB, or EiB`,
		);
	}
	const magnitude = BigInt(match[1] as string);
	const multiplier = IEC_UNITS.find(([unit]) => unit === match[2])?.[1];
	if (!multiplier)
		throw new QuantityParseError(`${label} has an invalid IEC unit`);
	if (magnitude > MAX_HOST_QUANTITY / multiplier) {
		throw new QuantityParseError(
			`${label} exceeds the maximum supported byte quantity ${MAX_HOST_QUANTITY} B`,
		);
	}
	return checkedHostQuantity(magnitude * multiplier, label);
}

export function formatIecBytes(value: bigint): string {
	if (value === 0n) return "0 B";
	checkedHostQuantity(value, "RAM bytes");
	for (const [unit, multiplier] of IEC_UNITS) {
		if (value % multiplier === 0n) return `${value / multiplier} ${unit}`;
	}
	return `${value} B`;
}

export type ManagedMemoryAttribution =
	| { state: "unavailable" }
	| {
			state: "verified";
			/** PID-reuse-safe, ownership-linked evidence; policy derives U from it. */
			residents: Array<{
				leaseId: string;
				runId: string;
				pid: number;
				processStartTime: string;
				residentBytes: bigint;
			}>;
	  };

/** Fake/adapter-injected payload. MFW-92 owns producing it from the host. */
export interface LinuxMemoryAdmissionObservation
	extends LinuxMemoryObservation {
	managedAttribution?: ManagedMemoryAttribution;
}

export interface RamFormulaInputs {
	configuredQuotaBytes: bigint;
	safetyHeadroomBytes: bigint;
	memAvailableBytes: bigint;
	durablePromisesBytes: bigint;
	attributableManagedBytes: bigint;
	requestBytes: bigint;
}

export interface RamFormulaResult extends RamFormulaInputs {
	outstandingPromiseBytes: bigint;
	quotaRemainingBytes: bigint;
	observedHeadroomBytes: bigint;
	effectiveCapacityBytes: bigint;
	allowed: boolean;
	blockedBy: "quota" | "headroom" | null;
}

function nonnegative(value: bigint, label: string): bigint {
	if (value < 0n || value > MAX_HOST_QUANTITY) {
		throw new QuantityParseError(
			`${label} must be an integer from 0 through ${MAX_HOST_QUANTITY}`,
		);
	}
	return value;
}

/** Exact C/H/A/L/U/R policy from MFW-87; no Number conversion or clamp. */
export function evaluateRamFormula(input: RamFormulaInputs): RamFormulaResult {
	const C = checkedHostQuantity(
		input.configuredQuotaBytes,
		"configured RAM quota",
	);
	const H = nonnegative(input.safetyHeadroomBytes, "RAM safety headroom");
	const A = nonnegative(input.memAvailableBytes, "observed MemAvailable");
	const L = nonnegative(input.durablePromisesBytes, "durable RAM promises");
	const R = nonnegative(input.requestBytes, "RAM request");
	if (L > C) {
		throw new QuantityParseError(
			"durable RAM promises exceed the configured quota",
		);
	}
	const rawU = nonnegative(
		input.attributableManagedBytes,
		"attributable managed RAM",
	);
	const U = rawU > L ? L : rawU;
	const outstanding = L - U;
	const quotaRemaining = C - L;
	const observedHeadroom = A - H - outstanding;
	const nonnegativeHeadroom = observedHeadroom > 0n ? observedHeadroom : 0n;
	const effective =
		quotaRemaining < nonnegativeHeadroom ? quotaRemaining : nonnegativeHeadroom;
	const quotaAllows = R <= quotaRemaining;
	const headroomAllows = R <= observedHeadroom;
	return {
		configuredQuotaBytes: C,
		safetyHeadroomBytes: H,
		memAvailableBytes: A,
		durablePromisesBytes: L,
		attributableManagedBytes: U,
		requestBytes: R,
		outstandingPromiseBytes: outstanding,
		quotaRemainingBytes: quotaRemaining,
		observedHeadroomBytes: observedHeadroom,
		effectiveCapacityBytes: effective,
		allowed: quotaAllows && headroomAllows,
		blockedBy: !quotaAllows ? "quota" : !headroomAllows ? "headroom" : null,
	};
}
