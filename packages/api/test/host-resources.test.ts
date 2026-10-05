import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	HostObservation,
	HostProbeKind,
} from "@mfw/core/host-observation";
import type { AnyHostProbeAdapter } from "@mfw/daemon/host-probes";
import {
	HostResourceCoordinator,
	type LeaseLivenessInspector,
	type LivenessEvidence,
	openHostResourceStore,
} from "@mfw/daemon/host-resources/index";
import type { Orchestrator } from "@mfw/daemon/services";
import { createCaller } from "../src/root.ts";

const homes: string[] = [];
const coordinators: HostResourceCoordinator[] = [];

afterEach(async () => {
	for (const coordinator of coordinators.splice(0))
		await coordinator.shutdown();
	for (const home of homes.splice(0)) {
		await rm(home, { recursive: true, force: true });
	}
});

class FakeLiveness implements LeaseLivenessInspector {
	evidence: LivenessEvidence = {
		status: "live",
		checkedAt: 10_000,
		kernelBootId: "kernel-a",
		detail: "pid and start time match",
	};
	inspections = 0;

	async inspect(): Promise<LivenessEvidence> {
		this.inspections++;
		return this.evidence;
	}
}

function freshProbe(
	kind: HostProbeKind,
	value: unknown,
	options: { gate?: Promise<void>; counts?: { polls: number } } = {},
): AnyHostProbeAdapter {
	let sequence = 0n;
	const observation = (): HostObservation<unknown> => ({
		kind,
		adapterVersion: "api-test-probe",
		tool: { name: "fixture", version: "1" },
		generation: {
			processBootId: "process-a",
			kernelBootId: "kernel-a",
			sequence: ++sequence,
		},
		freshness: {
			state: "fresh",
			checkedAt: new Date(10_000).toISOString(),
			expiresAt: new Date(20_000).toISOString(),
		},
		observedAt: new Date(10_000).toISOString(),
		durationMs: 1,
		result: { status: "ok", value, diagnostics: [] },
	});
	return {
		kind,
		discover: async () => {
			options.counts && options.counts.polls++;
			await options.gate;
			return observation();
		},
		sample: async () => observation(),
	};
}

async function fixture(adapters: readonly AnyHostProbeAdapter[] = []) {
	const home = await mkdtemp(join(tmpdir(), "mfw-host-api-"));
	homes.push(home);
	const liveness = new FakeLiveness();
	const store = await openHostResourceStore(home, {
		processBootId: "process-a",
		kernelBootId: "kernel-a",
		now: () => 10_000,
	});
	const hostResources = await HostResourceCoordinator.create(store, {
		liveness,
		now: () => 10_000,
		livenessMaxAgeMs: 1_000,
		observations: { adapters },
	});
	coordinators.push(hostResources);
	let projectLookups = 0;
	const orchestrator = {
		hostResources,
		projects: new Map(),
		list: () => [],
		get: () => {
			projectLookups++;
			throw new Error("no projects attached");
		},
	} as unknown as Orchestrator;
	return {
		api: createCaller({ orchestrator }),
		hostResources,
		liveness,
		projectLookups: () => projectLookups,
	};
}

const slot = {
	id: "gpu",
	accounting: "slot" as const,
	provisioning: "static" as const,
	capacity: 1n,
	quantityUnit: null,
	safetyHeadroom: null,
	enabled: true,
	draining: false,
	observationKind: null,
	ignoreObservation: false,
	cpuPressure: null,
};

describe("process-global host resources API", () => {
	test("reads the coordinator with zero attached or selected projects and rejects project scope", async () => {
		const f = await fixture();
		const model = await f.api.hostResources.read();
		expect(model.definitions).toEqual([]);
		expect(model.hostId).toBeTruthy();
		expect(f.projectLookups()).toBe(0);

		const read = f.api.hostResources.read as unknown as (
			input: unknown,
		) => Promise<unknown>;
		await expect(read({ project: "chosen-project" })).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
		expect(f.projectLookups()).toBe(0);
	});

	test("detects host capacity for review and applies every reviewed recommendation with one fence", async () => {
		const f = await fixture([
			freshProbe("linux-cpu", { logicalProcessors: 8 }),
		]);
		const detected = await f.api.hostResources.detect();
		const cpu = detected.recommendations.find((item) => item.id === "cpu");
		expect(cpu).toMatchObject({
			definitionState: "new",
			canApply: true,
			definition: {
				accounting: "quantity",
				quantityUnit: "integer",
				observationKind: "linux-cpu",
			},
		});
		const reviewed = detected.recommendations
			.filter((item) => item.canApply)
			.map((item) => ({ id: item.id, fingerprint: item.fingerprint }));
		expect(reviewed.map((item) => item.id)).toContain("cpu");
		await expect(
			(
				f.api.hostResources.applyDetected as unknown as (
					input: unknown,
				) => Promise<unknown>
			)({
				recommendations: reviewed,
				expectedGeneration: detected.generation,
				actor: "client-supplied-actor",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });

		await expect(
			f.api.hostResources.applyDetected({
				recommendations: reviewed,
				expectedGeneration: detected.generation,
			}),
		).resolves.toEqual({
			definitionsCreated: reviewed.length,
			bindingsCreated: 0,
		});
		expect(
			f.hostResources.readModel().definitions.map((item) => item.id),
		).toEqual(reviewed.map((item) => item.id));

		await expect(
			f.api.hostResources.applyDetected({
				recommendations: reviewed,
				expectedGeneration: detected.generation,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(f.projectLookups()).toBe(0);
	});

	test("fails closed when no real refresh is available and excludes stored probe data that did not participate", async () => {
		const unavailable = await fixture([]);
		await unavailable.hostResources.observations.recordHealth({
			kind: "linux-memory",
			result: "ok",
			checkedAt: 9_000,
			processBootId: "process-a",
			kernelBootId: "kernel-a",
			detail: { latest: { memTotalBytes: "17179869184" } },
		});
		await expect(unavailable.api.hostResources.detect()).rejects.toMatchObject({
			code: "PRECONDITION_FAILED",
		});

		const cpuOnly = await fixture([
			freshProbe("linux-cpu", { logicalProcessors: 8 }),
		]);
		await cpuOnly.hostResources.observations.recordHealth({
			kind: "amd-gpu",
			result: "ok",
			checkedAt: 9_000,
			processBootId: "process-a",
			kernelBootId: "kernel-a",
			detail: {
				latest: [
					{
						key: "stale-gpu",
						pciAddress: "0000:65:00.0",
						vendor: "amd",
					},
				],
			},
		});
		const detected = await cpuOnly.api.hostResources.detect();
		expect(detected.probe).toMatchObject({
			status: "fresh",
			kinds: ["linux-cpu"],
		});
		expect(detected.recommendations.map((item) => item.id)).not.toContain(
			"gpu-amd",
		);
	});

	test("coalesces concurrent detect requests onto one fresh probe", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const counts = { polls: 0 };
		const f = await fixture([
			freshProbe(
				"linux-memory",
				{ memTotalBytes: "17179869184" },
				{
					gate,
					counts,
				},
			),
		]);
		const first = f.api.hostResources.detect();
		const second = f.api.hostResources.detect();
		await Bun.sleep(0);
		expect(counts.polls).toBe(1);
		release();
		const [a, b] = await Promise.all([first, second]);
		expect(a.recommendations.map((item) => item.id)).toEqual(["ram"]);
		expect(b.recommendations.map((item) => item.id)).toEqual(["ram"]);
	});

	test("rejects stale generations and changed proposal fingerprints without writing", async () => {
		const f = await fixture([
			freshProbe("linux-cpu", { logicalProcessors: 8 }),
		]);
		const detected = await f.api.hostResources.detect();
		const cpu = detected.recommendations.find((item) => item.id === "cpu");
		if (!cpu) throw new Error("expected CPU recommendation");

		await expect(
			f.api.hostResources.applyDetected({
				recommendations: [{ id: cpu.id, fingerprint: "0".repeat(64) }],
				expectedGeneration: detected.generation,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(f.hostResources.readModel().definitions).toEqual([]);

		await f.api.hostResources.createDefinition({
			...slot,
			id: "unrelated",
			actor: "local-operator",
		});
		await expect(
			f.api.hostResources.applyDetected({
				recommendations: [{ id: cpu.id, fingerprint: cpu.fingerprint }],
				expectedGeneration: detected.generation,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(
			f.hostResources.readModel().definitions.some((item) => item.id === "cpu"),
		).toBe(false);
	});

	test("detects stable-key conflicts before apply", async () => {
		const f = await fixture([
			freshProbe("linux-cpu", { logicalProcessors: 8 }),
			freshProbe("amd-gpu", [
				{
					identity: {
						key: "gpu:amd:0000:65:00.0:uuid-a",
						pciAddress: "0000:65:00.0",
						vendor: "amd",
						partition: null,
					},
				},
			]),
		]);
		await f.hostResources.observations.recordHealth({
			kind: "amd-gpu",
			result: "ok",
			checkedAt: 10_000,
			processBootId: "process-a",
			kernelBootId: "kernel-a",
			detail: {
				latest: [
					{
						identity: {
							key: "gpu:amd:0000:65:00.0:uuid-a",
							pciAddress: "0000:65:00.0",
							vendor: "amd",
							partition: null,
						},
					},
				],
			},
		});
		const first = await f.api.hostResources.detect();
		const gpu = first.recommendations.find((item) => item.id === "gpu-amd");
		const binding = gpu?.bindings[0];
		if (!gpu || !binding) throw new Error("expected AMD GPU recommendation");
		const { version: _version, ...definitionInput } = gpu.definition;
		await f.api.hostResources.createDefinition({
			...definitionInput,
			observationKind: "amd-gpu",
			actor: "local-operator",
		});
		await f.api.hostResources.createBinding({
			id: "operator-chosen-binding-id",
			resourceId: binding.resourceId,
			stableKey: binding.stableKey,
			enabled: true,
			actor: "local-operator",
		});

		const conflicted = await f.api.hostResources.detect();
		const conflictedGpu = conflicted.recommendations.find(
			(item) => item.id === "gpu-amd",
		);
		expect(conflictedGpu).toMatchObject({
			bindingConflictIds: [binding.id],
			canApply: false,
		});
		if (!conflictedGpu) throw new Error("expected conflicted recommendation");
		await expect(
			f.api.hostResources.applyDetected({
				recommendations: [
					{ id: conflictedGpu.id, fingerprint: conflictedGpu.fingerprint },
				],
				expectedGeneration: conflicted.generation,
			}),
		).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
	});

	test("rejects project scope on every global query and action", async () => {
		const f = await fixture();
		const calls: Array<() => Promise<unknown>> = [
			() =>
				(
					f.api.hostResources.detect as unknown as (
						input: unknown,
					) => Promise<unknown>
				)({ project: "p" }),
			() =>
				(
					f.api.hostResources.applyDetected as unknown as (
						input: unknown,
					) => Promise<unknown>
				)({
					recommendationId: "cpu",
					expectedGeneration: 0n,
					actor: "a",
					project: "p",
				}),
			() =>
				(
					f.api.hostResources.audit as unknown as (
						input: unknown,
					) => Promise<unknown>
				)({ project: "p", limit: 10 }),
			() =>
				(
					f.api.hostResources.createDefinition as unknown as (
						input: unknown,
					) => Promise<unknown>
				)({ ...slot, actor: "a", project: "p" }),
			() =>
				(
					f.api.hostResources.updateDefinition as unknown as (
						input: unknown,
					) => Promise<unknown>
				)({
					...slot,
					actor: "a",
					expectedVersion: 1n,
					project: "p",
				}),
			() =>
				(
					f.api.hostResources.setDrain as unknown as (
						input: unknown,
					) => Promise<unknown>
				)({
					resourceId: "gpu",
					expectedVersion: 1n,
					draining: true,
					actor: "a",
					project: "p",
				}),
			() =>
				(
					f.api.hostResources.setEnabled as unknown as (
						input: unknown,
					) => Promise<unknown>
				)({
					resourceId: "gpu",
					expectedVersion: 1n,
					enabled: false,
					actor: "a",
					reason: "r",
					project: "p",
				}),
			() =>
				(
					f.api.hostResources.createBinding as unknown as (
						input: unknown,
					) => Promise<unknown>
				)({
					id: "b",
					resourceId: "gpu",
					stableKey: "k",
					enabled: true,
					actor: "a",
					project: "p",
				}),
			() =>
				(
					f.api.hostResources.updateBinding as unknown as (
						input: unknown,
					) => Promise<unknown>
				)({
					id: "b",
					resourceId: "gpu",
					stableKey: "k",
					enabled: true,
					expectedVersion: 1n,
					actor: "a",
					project: "p",
				}),
			() =>
				(
					f.api.hostResources.refresh as unknown as (
						input: unknown,
					) => Promise<unknown>
				)({ project: "p" }),
			() =>
				(
					f.api.hostResources.reconcile as unknown as (
						input: unknown,
					) => Promise<unknown>
				)({ project: "p" }),
			() =>
				(
					f.api.hostResources.forceRelease as unknown as (
						input: unknown,
					) => Promise<unknown>
				)({
					leaseId: "l",
					expectedFence: 1n,
					actor: "a",
					reason: "r",
					confirmed: true,
					project: "p",
				}),
		];
		for (const call of calls) {
			await expect(call()).rejects.toMatchObject({ code: "BAD_REQUEST" });
		}
		expect(f.projectLookups()).toBe(0);
		expect(f.hostResources.readModel().definitions).toEqual([]);
	});

	test("keeps project semaphore procedures unable to mutate host definitions or leases", async () => {
		const f = await fixture();
		await f.api.hostResources.createDefinition({ ...slot, actor: "operator" });
		const waiter = await f.hostResources.putWaiter({
			requestKey: "detached/host-lease",
			projectId: "detached-project",
			requirements: [{ resourceId: "gpu", amount: 1n }],
		});
		const grant = await f.hostResources.tryGrant(waiter.id, waiter.generation);
		if ("kind" in grant) throw new Error(`unexpected hold: ${grant.reason}`);
		await expect(
			f.api.resources.register({
				project: "missing",
				id: "gpu",
				maxConcurrent: 99,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			f.api.resources.forceRelease({
				project: "missing",
				resourceId: grant.id,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(f.hostResources.readModel().definitions[0]?.capacity).toBe(1n);
		expect(f.hostResources.readModel().leases[0]).toMatchObject({
			id: grant.id,
			fence: grant.fence,
			state: "provisional",
		});
	});

	test("exposes definitions, bindings, promised and effective capacity, waiters, leases and fences", async () => {
		const f = await fixture();
		const definition = await f.api.hostResources.createDefinition({
			...slot,
			actor: "ops@example",
		});
		await f.api.hostResources.createBinding({
			id: "gpu-a",
			resourceId: "gpu",
			stableKey: "0000:65:00.0/GPU-stable",
			enabled: true,
			actor: "ops@example",
		});
		const waiter = await f.hostResources.putWaiter({
			requestKey: "detached-project/run-1",
			projectId: "stable-project-id",
			requirements: [{ resourceId: "gpu", amount: 1n }],
		});
		const grant = await f.hostResources.tryGrant(waiter.id, waiter.generation);
		if ("kind" in grant) throw new Error(`unexpected hold: ${grant.reason}`);

		const model = await f.api.hostResources.read();
		expect(definition.version).toBe(1n);
		expect(model.bindings[0]).toMatchObject({
			id: "gpu-a",
			version: 1n,
		});
		expect(model.waiters[0]).toMatchObject({
			sequence: 1n,
			projectId: "stable-project-id",
			state: "granted",
		});
		expect(model.leases[0]).toMatchObject({
			id: grant.id,
			fence: grant.fence,
			state: "provisional",
		});
		expect(model.effectiveCapacities[0]).toMatchObject({
			configuredQuota: 1n,
			durablePromises: 1n,
			observedCapacity: null,
			effectiveCapacity: 0n,
			enforcement: { mode: "admission-control", kernelEnforced: false },
		});
		expect(f.projectLookups()).toBe(0);
	});

	test("returns external and unknown GPU occupants as observation-only blockers", async () => {
		const f = await fixture();
		await f.api.hostResources.createDefinition({
			...slot,
			observationKind: "nvidia-gpu",
			actor: "ops",
		});
		await f.api.hostResources.createBinding({
			id: "gpu-a",
			resourceId: "gpu",
			stableKey: "GPU-stable",
			enabled: true,
			actor: "ops",
		});
		await f.hostResources.observations.recordHealth({
			kind: "nvidia-gpu",
			result: "ok",
			checkedAt: 10_000,
			processBootId: "process-a",
			kernelBootId: "kernel-a",
			detail: {
				generation: {
					processBootId: "process-a",
					kernelBootId: "kernel-a",
					sequence: "1",
				},
			},
		});
		await f.hostResources.observations.recordSample({
			bindingId: "gpu-a",
			kind: "nvidia-gpu",
			sequence: 1n,
			result: "ok",
			processBootId: "process-a",
			kernelBootId: "kernel-a",
			observedAt: 10_000,
			durationMs: 2,
			metrics: {
				identity: { key: "GPU-stable" },
				gpuUtilization: 0.01,
				memoryUsedBytes: "18504421376",
				occupancy: {
					state: "occupied",
					blocksExclusiveAdmission: true,
					deviceEvidence: [],
				},
			},
			occupants: [
				{
					pid: 4242,
					pidStart: {
						status: "verified",
						pid: 4242,
						startTimeTicks: "100",
						kernelBootId: "kernel-a",
					},
					evidence: [
						{
							kind: "compute-context",
							source: "nvidia-smi-processes",
							admission: "blocking",
							contextKind: "compute",
						},
					],
				},
			],
			warnings: [],
			adapterVersion: "test",
		});

		const model = await f.api.hostResources.read();
		expect(model.effectiveCapacities[0]).toMatchObject({
			configuredQuota: 1n,
			observedCapacity: 0n,
			effectiveCapacity: 0n,
			holdReason: "external-occupancy",
		});
		expect(model.occupants[0]?.resourceId).toBe("gpu");
		expect(model.occupants[0]?.bindingId).toBe("gpu-a");
		expect(model.occupants[0]?.state).toBe("occupied");
		const occupant = model.occupants[0]?.occupants[0];
		expect(occupant?.pid).toBe(4242);
		expect(occupant?.attribution).toBe("external");
		expect(occupant?.runId).toBeNull();
		expect(occupant?.leaseId).toBeNull();
	});

	test("rejects repeated and stale definition and binding mutations without duplicate writes", async () => {
		const f = await fixture();
		await f.api.hostResources.createDefinition({ ...slot, actor: "alice" });
		await expect(
			f.api.hostResources.createDefinition({ ...slot, actor: "alice" }),
		).rejects.toMatchObject({ code: "CONFLICT" });

		const updated = await f.api.hostResources.updateDefinition({
			...slot,
			capacity: 2n,
			expectedVersion: 1n,
			actor: "alice",
		});
		expect(updated.version).toBe(2n);
		await expect(
			f.api.hostResources.updateDefinition({
				...slot,
				capacity: 3n,
				expectedVersion: 1n,
				actor: "alice",
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(f.hostResources.readModel().definitions[0]?.capacity).toBe(2n);

		await f.api.hostResources.createBinding({
			id: "gpu-a",
			resourceId: "gpu",
			stableKey: "stable-a",
			enabled: true,
			actor: "alice",
		});
		await f.api.hostResources.updateBinding({
			id: "gpu-a",
			resourceId: "gpu",
			stableKey: "stable-b",
			enabled: true,
			expectedVersion: 1n,
			actor: "alice",
		});
		await expect(
			f.api.hostResources.updateBinding({
				id: "gpu-a",
				resourceId: "gpu",
				stableKey: "stale",
				enabled: true,
				expectedVersion: 1n,
				actor: "alice",
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});

	test("protects live binding identity and prevents duplicate enabled GPU device bindings", async () => {
		const f = await fixture();
		await f.api.hostResources.createDefinition({ ...slot, actor: "alice" });
		await f.api.hostResources.createBinding({
			id: "gpu-a",
			resourceId: "gpu",
			stableKey: "stable-a",
			enabled: true,
			actor: "alice",
		});
		const waiter = await f.hostResources.putWaiter({
			requestKey: "bound/run",
			projectId: "bound",
			requirements: [{ resourceId: "gpu", bindingId: "gpu-a", amount: 1n }],
		});
		const grant = await f.hostResources.tryGrant(waiter.id, waiter.generation);
		if ("kind" in grant) throw new Error(`unexpected hold: ${grant.reason}`);
		await expect(
			f.api.hostResources.updateBinding({
				id: "gpu-a",
				resourceId: "gpu",
				stableKey: "changed-under-lease",
				enabled: true,
				expectedVersion: 1n,
				actor: "alice",
			}),
		).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

		for (const id of ["observed-a", "observed-b"]) {
			await f.api.hostResources.createDefinition({
				...slot,
				id,
				observationKind: "nvidia-gpu",
				actor: "alice",
			});
		}
		await f.api.hostResources.createBinding({
			id: "observed-binding-a",
			resourceId: "observed-a",
			stableKey: "same-physical-device",
			enabled: true,
			actor: "alice",
		});
		await expect(
			f.api.hostResources.createBinding({
				id: "observed-binding-b",
				resourceId: "observed-b",
				stableKey: "same-physical-device",
				enabled: true,
				actor: "alice",
			}),
		).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
	});

	test("requires drain before disable and refuses disable while promises remain", async () => {
		const f = await fixture();
		await f.api.hostResources.createDefinition({ ...slot, actor: "alice" });
		await expect(
			f.api.hostResources.setEnabled({
				resourceId: "gpu",
				expectedVersion: 1n,
				enabled: false,
				actor: "alice",
				reason: "maintenance",
			}),
		).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
		const drained = await f.api.hostResources.setDrain({
			resourceId: "gpu",
			expectedVersion: 1n,
			draining: true,
			actor: "alice",
		});
		expect(drained.version).toBe(2n);

		const waiter = await f.hostResources.putWaiter({
			requestKey: "project/run",
			projectId: "project",
			requirements: [{ resourceId: "gpu", amount: 1n }],
		});
		// Draining correctly prevents a new grant, so temporarily end drain and
		// establish a promise before proving disable cannot revoke it.
		await f.api.hostResources.setDrain({
			resourceId: "gpu",
			expectedVersion: 2n,
			draining: false,
			actor: "alice",
		});
		const grant = await f.hostResources.tryGrant(
			waiter.id,
			f.hostResources.readModel().generation,
		);
		if ("kind" in grant) throw new Error(`unexpected hold: ${grant.reason}`);
		await f.api.hostResources.setDrain({
			resourceId: "gpu",
			expectedVersion: 3n,
			draining: true,
			actor: "alice",
		});
		await expect(
			f.api.hostResources.setEnabled({
				resourceId: "gpu",
				expectedVersion: 4n,
				enabled: false,
				actor: "alice",
				reason: "maintenance",
			}),
		).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
	});

	test("cannot shrink capacity below promises or change their accounting contract", async () => {
		const f = await fixture();
		const quantity = {
			...slot,
			id: "cpu",
			accounting: "quantity" as const,
			capacity: 4n,
			quantityUnit: "integer" as const,
		};
		await f.api.hostResources.createDefinition({
			...quantity,
			actor: "alice",
		});
		const waiter = await f.hostResources.putWaiter({
			requestKey: "project/cpu-heavy",
			projectId: "project",
			requirements: [{ resourceId: "cpu", amount: 3n }],
		});
		const grant = await f.hostResources.tryGrant(waiter.id, waiter.generation);
		if ("kind" in grant) throw new Error(`unexpected hold: ${grant.reason}`);

		await expect(
			f.api.hostResources.updateDefinition({
				...quantity,
				capacity: 2n,
				expectedVersion: 1n,
				actor: "alice",
			}),
		).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
		await expect(
			f.api.hostResources.updateDefinition({
				...slot,
				id: "cpu",
				capacity: 4n,
				expectedVersion: 1n,
				actor: "alice",
			}),
		).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
		expect(f.hostResources.readModel().definitions[0]).toMatchObject({
			accounting: "quantity",
			capacity: 4n,
			version: 1n,
		});
	});

	test("guarded force requires confirmation, current fence, fresh conclusive liveness, actor and reason", async () => {
		const f = await fixture();
		await f.api.hostResources.createDefinition({ ...slot, actor: "alice" });
		const waiter = await f.hostResources.putWaiter({
			requestKey: "project/run",
			projectId: "project",
			requirements: [{ resourceId: "gpu", amount: 1n }],
		});
		const grant = await f.hostResources.tryGrant(waiter.id, waiter.generation);
		if ("kind" in grant) throw new Error(`unexpected hold: ${grant.reason}`);
		await f.hostResources.activate(grant.id, grant.fence, {
			runId: "run-1",
			runDir: "/detached/run-1",
			pid: 123,
			processStartTime: "456",
			kernelBootId: "kernel-a",
		});

		const force = f.api.hostResources.forceRelease as unknown as (
			input: Record<string, unknown>,
		) => Promise<boolean>;
		await expect(
			force({
				leaseId: grant.id,
				expectedFence: grant.fence,
				actor: "alice",
				reason: "operator verified owner state",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			force({
				leaseId: grant.id,
				expectedFence: grant.fence,
				actor: " ",
				reason: "operator verified owner state",
				confirmed: true,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			force({
				leaseId: grant.id,
				expectedFence: grant.fence,
				actor: "alice",
				reason: " ",
				confirmed: true,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			f.api.hostResources.forceRelease({
				leaseId: grant.id,
				expectedFence: grant.fence + 1n,
				actor: "alice",
				reason: "operator verified owner state",
				confirmed: true,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(f.liveness.inspections).toBe(0);

		f.liveness.evidence = {
			status: "live",
			checkedAt: 8_000,
			kernelBootId: "kernel-a",
			detail: "stale pid evidence",
		};
		await expect(
			f.api.hostResources.forceRelease({
				leaseId: grant.id,
				expectedFence: grant.fence,
				actor: "alice",
				reason: "operator verified owner state",
				confirmed: true,
			}),
		).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

		f.liveness.evidence = {
			status: "unknown",
			checkedAt: 10_000,
			kernelBootId: "kernel-a",
		};
		await expect(
			f.api.hostResources.forceRelease({
				leaseId: grant.id,
				expectedFence: grant.fence,
				actor: "alice",
				reason: "operator verified owner state",
				confirmed: true,
			}),
		).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

		f.liveness.evidence = {
			status: "live",
			checkedAt: 10_000,
			kernelBootId: "kernel-a",
			detail: "pid and start time match",
		};
		expect(
			await f.api.hostResources.forceRelease({
				leaseId: grant.id,
				expectedFence: grant.fence,
				actor: "alice",
				reason: "operator verified owner state",
				confirmed: true,
			}),
		).toBe(true);
		expect(
			await f.api.hostResources.forceRelease({
				leaseId: grant.id,
				expectedFence: grant.fence,
				actor: "alice",
				reason: "operator verified owner state",
				confirmed: true,
			}),
		).toBe(false);

		const entries = await f.api.hostResources.audit({ limit: 100 });
		const audit = entries.find(
			(entry) => entry.action === "lease.force_released",
		);
		expect(audit).toMatchObject({
			actor: "alice",
			leaseId: grant.id,
			fence: grant.fence,
		});
		expect(audit?.detail).toMatchObject({
			reason: "operator verified owner state",
			expectedFence: grant.fence.toString(),
			actualFence: grant.fence.toString(),
			liveness: {
				status: "live",
				checkedAt: 10_000,
				detail: "pid and start time match",
			},
		});
	});

	test("refresh, reconcile and audit remain global actions with no projects", async () => {
		const f = await fixture();
		const refreshed = await f.api.hostResources.refresh({});
		expect(refreshed.hostId).toBe(f.hostResources.hostId);
		expect(await f.api.hostResources.reconcile({})).toMatchObject({
			cause: "manual",
			examined: 0,
		});
		expect(await f.api.hostResources.audit({ limit: 20 })).toEqual([]);
		expect(f.projectLookups()).toBe(0);
	});

	test("pages typed audit forward without skipping older entries", async () => {
		const f = await fixture();
		await f.api.hostResources.createDefinition({ ...slot, actor: "alice" });
		await f.api.hostResources.createBinding({
			id: "gpu-a",
			resourceId: "gpu",
			stableKey: "stable-a",
			enabled: true,
			actor: "alice",
		});
		const first = await f.api.hostResources.audit({ after: 0n, limit: 1 });
		expect(first).toHaveLength(1);
		expect(first[0]?.action).toBe("definition.put");
		const second = await f.api.hostResources.audit({
			after: first[0]?.seq ?? 0n,
			limit: 1,
		});
		expect(second).toHaveLength(1);
		expect(second[0]?.action).toBe("binding.put");
	});
});
