import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	placementDraft,
	placementInput,
	projectPolicyDraft,
	projectPolicyInput,
	projectRunPodPatch,
} from "./ProjectConfig";

const source = readFileSync(join(import.meta.dir, "ProjectConfig.tsx"), "utf8");

describe("project RunPod human forms", () => {
	test("preserves the difference between inheriting and explicitly allowing nothing", () => {
		const inherited = projectPolicyDraft({ enabled: true });
		expect(inherited).toMatchObject({
			restrictGpuTypes: false,
			restrictCpuFlavors: false,
			restrictImages: false,
			restrictClouds: false,
		});
		expect(projectPolicyInput(inherited)).not.toHaveProperty("allowedGpuTypes");
		expect(projectPolicyInput(inherited)).not.toHaveProperty(
			"allowedCpuFlavors",
		);
		expect(projectPolicyInput(inherited)).not.toHaveProperty("allowedImages");
		expect(projectPolicyInput(inherited)).not.toHaveProperty("allowedClouds");

		const denied = projectPolicyDraft({
			enabled: true,
			allowedGpuTypes: [],
			allowedCpuFlavors: [],
			allowedImages: [],
			allowedClouds: [],
		});
		expect(denied).toMatchObject({
			restrictGpuTypes: true,
			restrictCpuFlavors: true,
			restrictImages: true,
			restrictClouds: true,
			allowedGpuTypes: "",
			allowedImages: "",
		});
		expect(projectPolicyInput(denied)).toMatchObject({
			allowedGpuTypes: [],
			allowedCpuFlavors: [],
			allowedImages: [],
			allowedClouds: [],
		});
	});

	test("disabling and re-enabling preserves project policy and placement", () => {
		const policy = projectPolicyDraft({
			enabled: true,
			allowedGpuTypes: [],
			allowedCpuFlavors: ["cpu3m"],
			allowedImages: ["runpod/pytorch:1"],
			allowedClouds: ["SECURE"],
			maxHourlyPrice: 0.2,
		});
		const targetValue = {
			computeType: "CPU",
			image: "runpod/pytorch:1",
			cloud: "SECURE",
			maxHourlyPrice: 0.2,
			maxRuntimeMinutes: 60,
			maxSpend: 0.2,
			containerDiskInGb: 20,
			volumeInGb: 0,
			cpuFlavorId: "cpu3m",
			vcpuCount: 4,
			memoryInGb: 32,
		} as const;
		const target = placementDraft(targetValue);
		const enabled = {
			runpodEnabled: true,
			runpodPolicy: policy,
			runpodTarget: target,
		};
		const disabled = { ...enabled, runpodEnabled: false };
		const disablePatch = projectRunPodPatch(disabled, enabled);

		expect(disablePatch.runpod).toMatchObject({
			enabled: false,
			allowedGpuTypes: [],
			allowedImages: ["runpod/pytorch:1"],
		});
		expect(disablePatch).not.toHaveProperty("runpodTarget");

		const storedDisabledPolicy = {
			...projectPolicyInput(policy),
			enabled: false,
		};
		const disabledRoundTrip = {
			runpodEnabled: false,
			runpodPolicy: projectPolicyDraft(storedDisabledPolicy),
			runpodTarget: placementDraft(targetValue),
		};
		const enablePatch = projectRunPodPatch(
			{ ...disabledRoundTrip, runpodEnabled: true },
			disabledRoundTrip,
		);
		expect(enablePatch.runpod).toEqual({
			...projectPolicyInput(policy),
			enabled: true,
		});
		expect(enablePatch.runpodTarget).toEqual(placementInput(target));
	});

	test("opts in unrestricted without inventing a default placement", () => {
		const base = {
			runpodEnabled: false,
			runpodPolicy: projectPolicyDraft(null),
			runpodTarget: placementDraft(null),
		};
		const patch = projectRunPodPatch({ ...base, runpodEnabled: true }, base);
		expect(patch.runpod).toEqual({ enabled: true });
		expect(patch).not.toHaveProperty("runpodTarget");
		expect(base.runpodTarget).toMatchObject({ configured: false, image: "" });
	});

	test("omits empty placement and offers named managed or observed choices", () => {
		expect(source).toContain("hasPlacementCatalogue ?");
		expect(source).toContain("providerCpuFlavors.length > 0");
		expect(source).toContain("RunPod is ready for this project");
		expect(source).toContain("Tasks may choose any");
		expect(source).toContain("Optional provider restrictions");
		expect(source).toContain(
			"Only MFW-managed or previously observed choices are offered",
		);
		expect(source).toContain("MFW_RUNPOD_CPU_RUNTIME.image");
		expect(source).toContain("runPodImageLabel(image)");
		expect(source).toContain("runPodCpuFlavorLabel(flavor)");
		expect(source).toContain("configured: Boolean(image)");
		expect(source).not.toContain(
			"can be chosen after live inventory reports one",
		);
		expect(source).not.toContain("No selectable RunPod images");
	});

	test("round-trips CPU and GPU task placement without raw JSON", () => {
		const cpu = {
			computeType: "CPU" as const,
			image: "runpod/pytorch:1",
			cloud: "SECURE" as const,
			maxHourlyPrice: 0.2,
			maxRuntimeMinutes: 60,
			maxSpend: 0.2,
			containerDiskInGb: 20,
			volumeInGb: 0,
			cpuFlavorId: "cpu3m" as const,
			vcpuCount: 4,
			memoryInGb: 32,
		};
		expect(placementInput(placementDraft(cpu))).toEqual(cpu);

		const gpu = {
			computeType: "GPU" as const,
			image: "runpod/pytorch:1",
			cloud: "COMMUNITY" as const,
			maxHourlyPrice: 0.3,
			maxRuntimeMinutes: 30,
			maxSpend: 0.15,
			containerDiskInGb: 30,
			volumeInGb: 5,
			gpuTypeId: "NVIDIA RTX A4000",
			gpuCount: 1,
			minVcpuPerGpu: 2,
			minRamPerGpu: 8,
			allowedCudaVersions: ["12.8"],
		};
		expect(placementInput(placementDraft(gpu))).toEqual(gpu);
	});

	test("rejects placement values outside the server schema bounds", () => {
		const draft = {
			...placementDraft(null),
			configured: true,
			image: "runpod/pytorch:1",
		};
		expect(() =>
			placementInput({ ...draft, containerDiskInGb: "10001" }),
		).toThrow("at most 10000 GB");
		expect(() => placementInput({ ...draft, volumeInGb: "100001" })).toThrow(
			"at most 100000 GB",
		);
		expect(() => placementInput({ ...draft, maxSpend: "0" })).toThrow(
			"must be a number greater than zero",
		);
		expect(() => placementInput({ ...draft, vcpuCount: "1.5" })).toThrow(
			"must be a whole number",
		);
		expect(() =>
			projectPolicyInput({
				...projectPolicyDraft({ enabled: true }),
				maxConcurrentPods: "0",
			}),
		).toThrow("whole number of at least 1");
	});
});
