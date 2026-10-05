import { describe, expect, test } from "bun:test";
import { detectHostResourceRecommendations } from "../src/host-resource-detection.ts";
import type { HostResourceReadModel } from "../src/host-resources/types.ts";

function model(
	overrides: Partial<HostResourceReadModel> = {},
): HostResourceReadModel {
	return {
		hostId: "host-test",
		coordinatorId: "coordinator-test",
		kernelBootId: "kernel-test",
		processBootId: "process-test",
		generation: 0n,
		definitions: [],
		bindings: [],
		waiters: [],
		leases: [],
		observations: [],
		health: [
			{
				kind: "linux-memory",
				result: "ok",
				checkedAt: 1,
				processBootId: "process-test",
				kernelBootId: "kernel-test",
				detail: { latest: { memTotalBytes: "134217728000" } },
			},
			{
				kind: "amd-gpu",
				result: "ok",
				checkedAt: 1,
				processBootId: "process-test",
				kernelBootId: "kernel-test",
				detail: {
					latest: [
						{
							identity: {
								key: "amd:0000:65:00.0:card1",
								pciAddress: "0000:65:00.0",
								vendor: "amd",
							},
						},
					],
				},
			},
		],
		effectiveCapacities: [],
		incidents: [],
		holds: [],
		occupants: [],
		...overrides,
	};
}

describe("host resource detection", () => {
	test("proposes CPU permits, RAM bytes with headroom, and exclusive GPU bindings", () => {
		const recommendations = detectHostResourceRecommendations(model(), 32);

		const cpu = recommendations.find((item) => item.id === "cpu");
		expect(cpu?.definition).toMatchObject({
			accounting: "quantity",
			capacity: 32n,
			quantityUnit: "integer",
			observationKind: "linux-cpu",
			cpuPressure: { maxBusyFraction: 0.9, maxRunnableProcesses: 64 },
		});

		const ram = recommendations.find((item) => item.id === "ram");
		expect(ram?.definition).toMatchObject({
			accounting: "quantity",
			capacity: 134217728000n,
			quantityUnit: "bytes",
			safetyHeadroom: 13421772800n,
			observationKind: "linux-memory",
		});

		const gpu = recommendations.find((item) => item.id === "gpu-amd");
		expect(gpu?.definition).toMatchObject({
			accounting: "slot",
			capacity: 1n,
			observationKind: "amd-gpu",
		});
		expect(gpu?.bindings).toEqual([
			expect.objectContaining({
				id: expect.stringMatching(/^gpu-amd-0000-65-00-0-[a-f0-9]{12}$/),
				stableKey: "amd:0000:65:00.0:card1",
			}),
		]);
	});

	test("detects the flat GPU identity shape emitted by live probe health", () => {
		const live = model();
		const amd = live.health.find((item) => item.kind === "amd-gpu");
		if (!amd) throw new Error("expected AMD health fixture");
		amd.result = "degraded";
		amd.detail = {
			latest: [
				{
					displayIndex: null,
					key: "gpu:amd:0000:c6:00.0:KFD-PCI-0000:c6:00.0",
					partition: null,
					pciAddress: "0000:c6:00.0",
					uuid: "KFD-PCI-0000:c6:00.0",
					vendor: "amd",
				},
			],
		};

		const gpu = detectHostResourceRecommendations(live, 32).find(
			(item) => item.id === "gpu-amd",
		);
		expect(gpu?.definition.capacity).toBe(1n);
		expect(gpu?.bindings[0]).toMatchObject({
			resourceId: "gpu-amd",
			stableKey: "gpu:amd:0000:c6:00.0:KFD-PCI-0000:c6:00.0",
			metadata: { pciAddress: "0000:c6:00.0" },
		});
	});

	test("never applies over an incompatible definition and only proposes missing bindings", () => {
		const recommendations = detectHostResourceRecommendations(
			model({
				definitions: [
					{
						id: "cpu",
						accounting: "slot",
						provisioning: "static",
						capacity: 1n,
						enabled: true,
						draining: false,
						version: 1n,
					},
					{
						id: "gpu-amd",
						accounting: "slot",
						provisioning: "static",
						capacity: 1n,
						enabled: true,
						draining: false,
						version: 1n,
						observationKind: "amd-gpu",
					},
				],
			}),
			32,
		);

		expect(recommendations.find((item) => item.id === "cpu")).toMatchObject({
			definitionState: "conflict",
			canApply: false,
		});
		expect(recommendations.find((item) => item.id === "gpu-amd")).toMatchObject(
			{
				definitionState: "existing",
				missingBindingIds: [
					expect.stringMatching(/^gpu-amd-0000-65-00-0-[a-f0-9]{12}$/),
				],
				canApply: true,
			},
		);
	});

	test("uses partition identities as distinct slots without also counting their parent GPU", () => {
		const partitioned = model({
			health: [
				{
					kind: "nvidia-gpu",
					result: "ok",
					checkedAt: 1,
					processBootId: "process-test",
					kernelBootId: "kernel-test",
					detail: {
						latest: [
							{
								identity: {
									key: "nvidia:GPU-parent",
									pciAddress: "0000:65:00.0",
									vendor: "nvidia",
									partition: null,
								},
							},
							...["MIG-a", "MIG-b"].map((uuid, index) => ({
								identity: {
									key: `nvidia:${uuid}`,
									pciAddress: "0000:65:00.0",
									vendor: "nvidia",
									partition: {
										id: String(index),
										uuid,
									},
								},
							})),
						],
					},
				},
			],
		});
		const gpu = detectHostResourceRecommendations(partitioned, 8).find(
			(item) => item.id === "gpu-nvidia",
		);
		expect(gpu?.definition.capacity).toBe(2n);
		expect(gpu?.bindings.map((binding) => binding.stableKey)).toEqual([
			"nvidia:MIG-a",
			"nvidia:MIG-b",
		]);
		expect(new Set(gpu?.bindings.map((binding) => binding.id)).size).toBe(2);
	});

	test("deduplicates and deterministically orders AMD partitions without counting their parent", () => {
		const identities = [
			{
				key: "gpu:amd:0000:65:00.0:parent",
				pciAddress: "0000:65:00.0",
				vendor: "amd",
				partition: null,
			},
			...[
				["partition-b", "1"],
				["partition-a", "0"],
			].map(([uuid, id]) => ({
				key: `gpu:amd:0000:65:00.0:${uuid}:${id}`,
				pciAddress: "0000:65:00.0",
				vendor: "amd",
				partition: { id, uuid },
			})),
		];
		const detected = (latest: typeof identities) =>
			detectHostResourceRecommendations(
				model({
					health: [
						{
							kind: "amd-gpu",
							result: "ok",
							checkedAt: 1,
							processBootId: "process-test",
							kernelBootId: "kernel-test",
							detail: {
								latest: latest.map((identity) => ({ identity })),
							},
						},
					],
				}),
				8,
			).find((item) => item.id === "gpu-amd");

		const first = detected([
			...identities,
			identities[2] as (typeof identities)[number],
		]);
		const second = detected([...identities].reverse());
		expect(first?.definition.capacity).toBe(2n);
		expect(first?.bindings.map((binding) => binding.stableKey)).toEqual([
			"gpu:amd:0000:65:00.0:partition-a:0",
			"gpu:amd:0000:65:00.0:partition-b:1",
		]);
		expect(first?.bindings).toEqual(second?.bindings);
		expect(first?.fingerprint).toBe(second?.fingerprint);
		expect(new Set(first?.bindings.map((binding) => binding.id)).size).toBe(2);
	});

	test("reports deterministic binding-id and stable-key conflicts", () => {
		const initial = detectHostResourceRecommendations(model(), 8).find(
			(item) => item.id === "gpu-amd",
		);
		if (!initial) throw new Error("expected detected AMD recommendation");
		const binding = initial.bindings[0];
		if (!binding) throw new Error("expected detected AMD binding");
		const definition = initial.definition;

		for (const existingBinding of [
			{ ...binding, stableKey: "gpu:amd:other-device" },
			{ ...binding, id: "operator-chosen-id" },
		]) {
			const recommendation = detectHostResourceRecommendations(
				model({
					definitions: [definition],
					bindings: [existingBinding],
				}),
				8,
			).find((item) => item.id === "gpu-amd");
			expect(recommendation).toMatchObject({
				bindingConflictIds: [binding.id],
				missingBindingIds: [],
				canApply: false,
			});
		}
	});

	test("reports safety-relevant drift instead of claiming an existing definition is configured", () => {
		for (const [capacity, safetyHeadroom] of [
			[134217727999n, 13421772800n],
			[134217728000n, 0n],
		] as const) {
			const recommendations = detectHostResourceRecommendations(
				model({
					definitions: [
						{
							id: "ram",
							accounting: "quantity",
							provisioning: "static",
							capacity,
							quantityUnit: "bytes",
							safetyHeadroom,
							enabled: true,
							draining: false,
							version: 1n,
							observationKind: "linux-memory",
						},
					],
				}),
				8,
			);
			expect(recommendations.find((item) => item.id === "ram")).toMatchObject({
				definitionState: "conflict",
				canApply: false,
			});
		}

		const cpu = detectHostResourceRecommendations(
			model({
				definitions: [
					{
						id: "cpu",
						accounting: "quantity",
						provisioning: "static",
						capacity: 8n,
						quantityUnit: "integer",
						enabled: true,
						draining: false,
						version: 1n,
						observationKind: "linux-cpu",
						cpuPressure: {
							maxBusyFraction: 0.75,
							maxRunnableProcesses: 16,
						},
					},
				],
			}),
			8,
		).find((item) => item.id === "cpu");
		expect(cpu).toMatchObject({ definitionState: "conflict", canApply: false });
	});
});
