/** Public RunPod vocabulary shared by the daemon and the human UI. */
export const RUNPOD_CPU_FLAVORS = [
	"cpu3c",
	"cpu3g",
	"cpu3m",
	"cpu5c",
	"cpu5g",
	"cpu5m",
] as const;

export const RUNPOD_CLOUDS = ["SECURE", "COMMUNITY"] as const;

/** MFW owns this runtime contract. Operators select the profile name; the
 * provider image identity is intentionally not exposed as a form field. */
export const MFW_RUNPOD_CPU_RUNTIME = Object.freeze({
	id: "mfw-cpu-runner",
	label: "MFW CPU runner",
	image:
		"runpod/base@sha256:7530e77d6014bd6f3e1939b8d9003d8f7d2bd35a98395c4d297ac3b7a6d05b85",
	computeType: "CPU" as const,
	cpuFlavorId: "cpu3m" as const,
	vcpuCount: 2,
	memoryInGb: 16,
	shapeLabel: "Memory optimized · 2 vCPU · 16 GB RAM",
});

export function runPodImageLabel(image: string): string {
	if (image === MFW_RUNPOD_CPU_RUNTIME.image) {
		return MFW_RUNPOD_CPU_RUNTIME.label;
	}
	const withoutDigest = image.split("@", 1)[0] ?? image;
	return `Custom image · ${withoutDigest}`;
}

const CPU_FLAVOR_LABELS: Record<(typeof RUNPOD_CPU_FLAVORS)[number], string> = {
	cpu3c: "Compute optimized",
	cpu3g: "General purpose",
	cpu3m: "Memory optimized",
	cpu5c: "Compute optimized · latest generation",
	cpu5g: "General purpose · latest generation",
	cpu5m: "Memory optimized · latest generation",
};

export function runPodCpuFlavorLabel(
	flavor: (typeof RUNPOD_CPU_FLAVORS)[number],
): string {
	if (flavor === MFW_RUNPOD_CPU_RUNTIME.cpuFlavorId) {
		return MFW_RUNPOD_CPU_RUNTIME.shapeLabel;
	}
	return CPU_FLAVOR_LABELS[flavor];
}
