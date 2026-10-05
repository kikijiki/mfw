import { describe, expect, test } from "bun:test";
import {
	MFW_RUNPOD_CPU_RUNTIME,
	runPodCpuFlavorLabel,
	runPodImageLabel,
} from "../src/runpod.ts";

describe("human RunPod catalogue", () => {
	test("keeps managed provider identifiers behind stable human labels", () => {
		expect(runPodImageLabel(MFW_RUNPOD_CPU_RUNTIME.image)).toBe(
			"MFW CPU runner",
		);
		expect(runPodCpuFlavorLabel(MFW_RUNPOD_CPU_RUNTIME.cpuFlavorId)).toBe(
			"Memory optimized · 2 vCPU · 16 GB RAM",
		);
		expect(runPodImageLabel("registry.example/team/runner:4")).toBe(
			"Custom image · registry.example/team/runner:4",
		);
	});
});
