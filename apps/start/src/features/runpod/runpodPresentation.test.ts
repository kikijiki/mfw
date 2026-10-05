import { describe, expect, test } from "bun:test";
import {
	runPodComputeText,
	runPodDispatchStatus,
	runPodErrorText,
	runPodPhaseText,
	runPodResumeDisabledReason,
	runPodTerminationDisabledReason,
} from "./runpodPresentation";

describe("RunPod operator language", () => {
	test("translates machine failures and phases into action-oriented text", () => {
		expect(runPodErrorText("network_error")).toBe(
			"RunPod could not be reached",
		);
		expect(runPodErrorText("future_provider_code")).toBe(
			"future provider code",
		);
		expect(runPodPhaseText("collecting")).toBe("Downloading results");
		expect(runPodPhaseText("provider_new_phase")).toBe(
			"Provider state needs review",
		);
	});

	test("explains every disabled termination boundary", () => {
		expect(
			runPodTerminationDisabledReason({
				inventoryFresh: false,
				live: true,
				owned: true,
				hasFingerprint: true,
			}),
		).toBe("Check live inventory before terminating.");
		expect(
			runPodTerminationDisabledReason({
				inventoryFresh: true,
				live: true,
				owned: true,
				hasFingerprint: true,
			}),
		).toBeNull();
	});

	test("reports the effective dispatch gate and explains blocked resume", () => {
		expect(
			runPodDispatchStatus({
				gateOpen: false,
				requestedPaused: false,
				gateReason: "RunPod full inventory failed",
			}),
		).toBe("Blocked: RunPod full inventory failed");
		expect(
			runPodResumeDisabledReason({
				enabled: true,
				credentialReady: true,
				credentialValidated: true,
				inventoryFresh: false,
				reconcileError: null,
			}),
		).toBe("Check the live RunPod account before resuming.");
	});

	test("uses vCPU count for CPU Pods and GPU count for GPU Pods", () => {
		expect(
			runPodComputeText({
				computeType: "CPU",
				vcpuCount: 16,
				gpuCount: 0,
			}),
		).toBe("16 vCPU");
		expect(
			runPodComputeText({
				computeType: "GPU",
				vcpuCount: null,
				gpuCount: 2,
			}),
		).toBe("2 GPU");
	});
});
