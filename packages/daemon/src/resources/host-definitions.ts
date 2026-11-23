import { parsePoolId } from "../../../plugin-api/src/pool-id.ts";
import type { Dimension } from "../../../plugin-api/src/resource.ts";
import type {
	HostResourceBinding,
	HostResourceDefinition,
} from "./host-types.ts";
import { MAX_HOST_QUANTITY } from "./quantity.ts";
import { type Claim, ResourceError } from "./types.ts";

const MIB = 1024n * 1024n;

/** The dimension a host definition's capacity lives in. */
export function dimensionNameOf(definition: HostResourceDefinition): string {
	if (definition.accounting === "slot") return "slot";
	return definition.quantityUnit === "bytes" ? "mib" : "permits";
}

/** Owner-chosen ids keep working: anything off-grammar lives under `local.`. */
export function poolIdOf(resourceId: string): string {
	if (parsePoolId(resourceId)) return resourceId;
	const slug =
		resourceId
			.toLowerCase()
			.replace(/[^a-z0-9_-]+/g, "-")
			.replace(/^[^a-z0-9]+/, "")
			.slice(0, 64) || "x";
	return `local.${slug}`;
}

/** A binding id as a pool unit name. */
export function unitOf(bindingId: string): string {
	return bindingId
		.replace(/[^A-Za-z0-9._:/@-]+/g, "-")
		.replace(/^[^A-Za-z0-9]+/, "u");
}

function isGpu(definition: HostResourceDefinition): boolean {
	return (
		definition.observationKind === "amd-gpu" ||
		definition.observationKind === "nvidia-gpu"
	);
}

/** The pool dimension for a definition. Byte quotas round down to whole MiB. */
export function dimensionOf(
	definition: HostResourceDefinition,
	bindings: readonly HostResourceBinding[],
): Dimension {
	const name = dimensionNameOf(definition);
	if (definition.accounting === "slot") {
		if (isGpu(definition)) {
			const units = bindings.filter((b) => b.enabled).map((b) => unitOf(b.id));
			const total = Math.min(units.length, Number(definition.capacity));
			return { kind: "slot", name, total, units: units.slice(0, total) };
		}
		return { kind: "slot", name, total: Number(definition.capacity) };
	}
	if (definition.quantityUnit === "bytes") {
		return {
			kind: "quantity",
			name,
			unit: "mib",
			total: Number(definition.capacity / MIB),
		};
	}
	return {
		kind: "quantity",
		name,
		unit: "permit",
		total: Number(definition.capacity),
	};
}

/** A requirement already normalized against its definition, as a claim. */
export function claimOf(
	definition: HostResourceDefinition,
	amount: bigint,
): Claim {
	const poolId = poolIdOf(definition.id);
	const dimension = dimensionNameOf(definition);
	if (definition.quantityUnit === "bytes") {
		// Rounded up: a reservation is never understated.
		return { poolId, dimension, amount: Number((amount + MIB - 1n) / MIB) };
	}
	return { poolId, dimension, amount: Number(amount) };
}

/** The whole definition contract, checked before anything is written. */
export function assertValidDefinition(d: HostResourceDefinition): void {
	const refuse = (message: string): never => {
		throw new ResourceError(message, "REFUSED");
	};
	if (!d.id.trim() || d.capacity <= 0n || d.capacity > MAX_HOST_QUANTITY) {
		refuse("resource id and positive capacity are required");
	}
	if (
		d.accounting === "slot" &&
		(d.quantityUnit != null || d.safetyHeadroom != null)
	) {
		refuse("slot resources cannot declare a quantity unit or safety headroom");
	}
	if (
		d.accounting === "quantity" &&
		d.quantityUnit !== "integer" &&
		d.quantityUnit !== "bytes"
	) {
		refuse("quantity resources require an explicit integer or bytes base unit");
	}
	if (d.quantityUnit === "bytes") {
		if (d.observationKind !== "linux-memory") {
			refuse(
				"byte quantity resources require the linux-memory observation binding",
			);
		}
		if (
			d.safetyHeadroom == null ||
			d.safetyHeadroom < 0n ||
			d.safetyHeadroom > MAX_HOST_QUANTITY
		) {
			refuse(
				"RAM resources require an explicit non-negative safety headroom in bytes",
			);
		}
	} else if (d.safetyHeadroom != null) {
		refuse("safety headroom is valid only for byte quantity resources");
	}
	const cpu = d.cpuPressure ?? null;
	if (d.observationKind === "linux-cpu") {
		if (
			d.accounting !== "quantity" ||
			d.quantityUnit !== "integer" ||
			!cpu ||
			(cpu.maxBusyFraction === undefined &&
				cpu.maxRunnableProcesses === undefined)
		) {
			refuse(
				"linux-cpu resources require integer quantity accounting and an explicit pressure threshold",
			);
		}
		if (
			cpu &&
			((cpu.maxBusyFraction !== undefined &&
				(!Number.isFinite(cpu.maxBusyFraction) ||
					cpu.maxBusyFraction < 0 ||
					cpu.maxBusyFraction > 1)) ||
				(cpu.maxRunnableProcesses !== undefined &&
					(!Number.isSafeInteger(cpu.maxRunnableProcesses) ||
						cpu.maxRunnableProcesses < 0)))
		) {
			refuse("linux-cpu pressure thresholds are invalid");
		}
	} else if (cpu) {
		refuse("CPU pressure policy is valid only for linux-cpu resources");
	}
	if (
		d.observationKind != null &&
		!["linux-memory", "linux-cpu", "amd-gpu", "nvidia-gpu"].includes(
			d.observationKind,
		)
	) {
		refuse(`unsupported observation kind '${d.observationKind}'`);
	}
	if (isGpu(d) && d.accounting !== "slot") {
		refuse("GPU observations require exclusive slot accounting");
	}
	if (d.ignoreObservation && d.observationKind == null) {
		refuse("ignoreObservation requires an explicit observation binding");
	}
}
