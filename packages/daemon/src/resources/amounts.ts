import type { Dimension } from "../../../plugin-api/src/resource.ts";
import { ResourceError } from "./types.ts";

/**
 * Quantities and window amounts are stored as integer millionths, so sums in
 * admission never drift. Slots are whole units and stored as they are.
 */
const SCALE = 1_000_000;

function checked(value: number, what: string): number {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new ResourceError(`${what} is out of range`, "REFUSED");
	}
	return value;
}

/** Rounds up: a reservation or charge is never understated. */
export function toStored(kind: Dimension["kind"], amount: number): number {
	if (!Number.isFinite(amount) || amount < 0) {
		throw new ResourceError("amount must be a finite non-negative", "REFUSED");
	}
	if (kind === "slot") {
		if (!Number.isInteger(amount)) {
			throw new ResourceError("slot amounts must be whole units", "REFUSED");
		}
		return checked(amount, "slot amount");
	}
	// Strip binary noise first so 0.1 stays 100000 rather than rounding up.
	const scaled = Number((amount * SCALE).toFixed(3));
	return checked(Math.ceil(scaled), "amount");
}

export function fromStored(kind: Dimension["kind"], stored: number): number {
	return kind === "slot" ? stored : stored / SCALE;
}
