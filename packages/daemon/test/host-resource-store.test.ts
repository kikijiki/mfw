import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import {
	HostResourceCoordinator,
	type HostResourceDefinition,
	HostStoreError,
	type LeaseLivenessInspector,
	type LivenessEvidence,
	openHostResourceStore,
} from "../src/host-resources/index.ts";

const homes: string[] = [];
const projectHandles: ProjectDbHandle[] = [];

afterEach(async () => {
	for (const handle of projectHandles.splice(0)) handle.close();
	for (const home of homes.splice(0))
		await rm(home, { recursive: true, force: true });
});

async function home(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "mfw-host-store-"));
	homes.push(path);
	return path;
}

const unavailable: LeaseLivenessInspector = {
	inspect: async (): Promise<LivenessEvidence> => ({
		status: "unavailable",
		checkedAt: Date.now(),
		kernelBootId: "kernel-a",
	}),
};

function definition(id: string, capacity = 1n): HostResourceDefinition {
	return {
		id,
		accounting: "slot",
		provisioning: "static",
		capacity,
		enabled: true,
		draining: false,
		version: 1n,
	};
}

async function coordinator(path: string, processBootId: string) {
	const store = await openHostResourceStore(path, {
		processBootId,
		kernelBootId: "kernel-a",
	});
	return HostResourceCoordinator.create(store, { liveness: unavailable });
}

describe("host resource store", () => {
	test("uses an independent FULL/WAL host database and stable home identity", async () => {
		const path = await home();
		const first = await openHostResourceStore(path, {
			processBootId: "process-a",
			kernelBootId: "kernel-a",
		});
		const id = first.identity.hostId;
		const coordinatorId = first.identity.coordinatorId;
		const journal = await first.client.execute("PRAGMA journal_mode");
		const sync = await first.client.execute("PRAGMA synchronous");
		expect(journal.rows[0]?.[0]).toBe("wal");
		expect(sync.rows[0]?.[0]).toBe(2n); // FULL
		first.close();

		const reopened = await openHostResourceStore(path, {
			processBootId: "process-b",
			kernelBootId: "kernel-a",
		});
		expect(reopened.identity.hostId).toBe(id);
		expect(reopened.identity.coordinatorId).toBe(coordinatorId);
		expect(reopened.identity.processBootId).toBe("process-b");
		reopened.close();
	});

	test("two project DBs and independently opened clients cannot over-grant capacity one", async () => {
		const path = await home();
		// The global rows carry only ids/metadata: no cross-database FK and no
		// migration of these project-local stores into host.db.
		for (const name of ["project-a", "project-b"]) {
			const handle = await openProjectDb(join(path, name, ".mfw"));
			projectHandles.push(handle);
		}
		const a = await coordinator(path, "client-a");
		const b = await coordinator(path, "client-b");
		await a.putDefinition(definition("gpu"));
		const wa = await a.putWaiter({
			requestKey: "a/run-1",
			projectId: "project-a",
			requirements: [{ resourceId: "gpu", amount: 1n }],
		});
		const wb = await b.putWaiter({
			requestKey: "b/run-1",
			projectId: "project-b",
			requirements: [{ resourceId: "gpu", amount: 1n }],
		});
		const generation = (await a.store.readModel()).generation;

		const [ga, gb] = await Promise.all([
			a.tryGrant(wa.id, generation),
			b.tryGrant(wb.id, generation),
		]);
		const grants = [ga, gb].filter((x) => !("kind" in x));
		expect(grants).toHaveLength(1);
		const persisted = await a.store.liveLeases();
		expect(persisted).toHaveLength(1);
		expect(persisted[0]?.allocations).toEqual([
			{ resourceId: "gpu", bindingId: null, amount: 1n },
		]);
		a.close();
		b.close();
	});

	test("oldest-overlap FIFO blocks backfill while disjoint resources progress", async () => {
		const path = await home();
		const c = await coordinator(path, "process-a");
		await c.putDefinition(definition("gpu", 1n));
		await c.putDefinition(definition("cpu", 1n));

		const oldest = await c.putWaiter({
			requestKey: "old-large",
			projectId: "a",
			requirements: [{ resourceId: "gpu", amount: 2n }],
		});
		const same = await c.putWaiter({
			requestKey: "young-small",
			projectId: "b",
			requirements: [{ resourceId: "gpu", amount: 1n }],
		});
		const disjoint = await c.putWaiter({
			requestKey: "young-disjoint",
			projectId: "b",
			requirements: [{ resourceId: "cpu", amount: 1n }],
		});

		const generation = c.readModel().generation;
		expect(await c.tryGrant(oldest.id, generation)).toMatchObject({
			kind: "held",
			reason: "definition",
		});
		expect(await c.tryGrant(same.id, generation)).toMatchObject({
			kind: "held",
			reason: "fifo",
			blockedBy: ["gpu"],
		});
		expect("kind" in (await c.tryGrant(disjoint.id, generation))).toBe(false);
		c.close();
	});

	test("a multi-resource grant is all-or-none", async () => {
		const path = await home();
		const c = await coordinator(path, "process-a");
		for (const id of ["gpu", "ram", "cpu"])
			await c.putDefinition(definition(id));
		const holder = await c.putWaiter({
			requestKey: "holder",
			projectId: "a",
			requirements: [{ resourceId: "gpu", amount: 1n }],
		});
		await c.tryGrant(holder.id, holder.generation);
		const multi = await c.putWaiter({
			requestKey: "multi",
			projectId: "b",
			requirements: [
				{ resourceId: "gpu", amount: 1n },
				{ resourceId: "ram", amount: 1n },
			],
		});
		expect(await c.tryGrant(multi.id, multi.generation)).toMatchObject({
			kind: "held",
			reason: "capacity",
		});
		const disjoint = await c.putWaiter({
			requestKey: "cpu-only",
			projectId: "c",
			requirements: [{ resourceId: "cpu", amount: 1n }],
		});
		await c.tryGrant(disjoint.id, disjoint.generation);
		const allocations = (await c.store.liveLeases()).flatMap(
			(l) => l.allocations,
		);
		expect(allocations.some((a) => a.resourceId === "ram")).toBe(false);
		expect(allocations.some((a) => a.resourceId === "cpu")).toBe(true);
		c.close();
	});

	test("busy writer failure is bounded and fails closed", async () => {
		const path = await home();
		const a = await openHostResourceStore(path, {
			processBootId: "a",
			kernelBootId: "k",
			busyTimeoutMs: 30,
		});
		const b = await openHostResourceStore(path, {
			processBootId: "b",
			kernelBootId: "k",
			busyTimeoutMs: 30,
		});
		const tx = await a.client.transaction("write");
		const started = Date.now();
		try {
			await expect(b.putDefinition(definition("gpu"))).rejects.toMatchObject({
				code: "BUSY",
			});
			expect(Date.now() - started).toBeLessThan(1_000);
		} finally {
			await tx.rollback();
			a.close();
			b.close();
		}
	});

	test("detected definition and bindings apply atomically and retry after a partial write failure", async () => {
		const path = await home();
		const store = await openHostResourceStore(path, {
			processBootId: "process-a",
			kernelBootId: "kernel-a",
		});
		const detected = {
			...definition("gpu-amd", 2n),
			observationKind: "amd-gpu" as const,
		};
		const bindings = ["a", "b"].map((suffix) => ({
			id: `gpu-amd-${suffix}`,
			resourceId: "gpu-amd",
			stableKey: `gpu:amd:0000:0${suffix === "a" ? "3" : "4"}:00.0:uuid-${suffix}`,
			enabled: true,
			version: 1n,
		}));
		const generation = (await store.readModel()).generation;
		await store.client.execute(`CREATE TEMP TRIGGER fail_second_detected_binding
			BEFORE INSERT ON resource_bindings
			WHEN NEW.id = 'gpu-amd-b'
			BEGIN SELECT RAISE(ABORT, 'injected detected binding failure'); END`);

		await expect(
			store.applyDetectedResource(detected, bindings, {
				expectedGeneration: generation,
			}),
		).rejects.toThrow("injected detected binding failure");
		const rolledBack = await store.readModel();
		expect(rolledBack.generation).toBe(generation);
		expect(rolledBack.definitions).toEqual([]);
		expect(rolledBack.bindings).toEqual([]);
		expect(
			(await store.auditEntries()).filter(
				(entry) =>
					entry.action === "definition.put" || entry.action === "binding.put",
			),
		).toEqual([]);

		await store.client.execute(
			"DROP TRIGGER IF EXISTS fail_second_detected_binding",
		);
		await expect(
			store.applyDetectedResource(detected, bindings, {
				expectedGeneration: generation,
			}),
		).resolves.toEqual({ definitionCreated: true, bindingsCreated: 2 });
		const applied = await store.readModel();
		expect(applied.definitions.map((item) => item.id)).toEqual(["gpu-amd"]);
		expect(applied.bindings.map((item) => item.id)).toEqual([
			"gpu-amd-a",
			"gpu-amd-b",
		]);
		store.close();
	});

	test("a reviewed batch rolls back every resource when a later recommendation fails", async () => {
		const path = await home();
		const store = await openHostResourceStore(path, {
			processBootId: "process-a",
			kernelBootId: "kernel-a",
		});
		const generation = (await store.readModel()).generation;
		await store.client.execute(`CREATE TEMP TRIGGER fail_second_detected_resource
			BEFORE INSERT ON resource_definitions
			WHEN NEW.id = 'ram'
			BEGIN SELECT RAISE(ABORT, 'injected second recommendation failure'); END`);

		await expect(
			store.applyDetectedResources(
				[
					{ definition: definition("cpu", 8n), bindings: [] },
					{ definition: definition("ram", 32n), bindings: [] },
				],
				{ expectedGeneration: generation },
			),
		).rejects.toThrow("injected second recommendation failure");

		const rolledBack = await store.readModel();
		expect(rolledBack.generation).toBe(generation);
		expect(rolledBack.definitions).toEqual([]);
		expect(rolledBack.bindings).toEqual([]);
		expect(
			(await store.auditEntries()).filter(
				(entry) =>
					entry.action === "definition.put" || entry.action === "binding.put",
			),
		).toEqual([]);
		store.close();
	});

	test("stale fences cannot release a successor and audit is append-only", async () => {
		const path = await home();
		const c = await coordinator(path, "process-a");
		await c.putDefinition(definition("gpu"));
		const firstWaiter = await c.putWaiter({
			requestKey: "first",
			projectId: "a",
			requirements: [{ resourceId: "gpu", amount: 1n }],
		});
		const first = await c.tryGrant(firstWaiter.id, firstWaiter.generation);
		if ("kind" in first) throw new Error("expected grant");
		await c.cancelOrRelease(first.id, first.fence, "finished");
		const successorWaiter = await c.putWaiter({
			requestKey: "successor",
			projectId: "b",
			requirements: [{ resourceId: "gpu", amount: 1n }],
		});
		const successor = await c.tryGrant(
			successorWaiter.id,
			successorWaiter.generation,
		);
		if ("kind" in successor) throw new Error("expected successor grant");
		expect(successor.fence).toBeGreaterThan(first.fence);
		await expect(
			c.cancelOrRelease(successor.id, first.fence, "stale owner"),
		).rejects.toBeInstanceOf(HostStoreError);
		expect((await c.store.lease(successor.id))?.state).toBe("provisional");
		await c.activate(successor.id, successor.fence, {
			runId: "run-successor",
			runDir: "/runs/successor",
			pid: process.pid,
			processStartTime: "fixture",
			kernelBootId: "kernel-a",
		});
		const proof = {
			runId: "run-successor",
			runDir: "/runs/successor",
			pid: process.pid,
			processStartTime: "fixture",
			kernelBootId: "kernel-a",
			processBootId: "process-a",
			observedAt: 123_456,
		};
		await c.renewOrAdopt(successor.id, successor.fence, proof);
		await c.renewOrAdopt(successor.id, successor.fence, proof);

		await c.putDefinition(definition("cpu"));
		const cancelled = await c.putWaiter({
			requestKey: "cancel-retry",
			projectId: "a",
			requirements: [{ resourceId: "cpu", amount: 1n }],
		});
		await c.cancelOrRelease(cancelled.id, cancelled.generation, "ineligible");
		await c.cancelOrRelease(cancelled.id, cancelled.generation, "ineligible");
		const audit = await c.store.auditEntries();
		expect(audit.map((e) => e.action)).toContain("lease.released");
		expect(
			audit.filter(
				(e) => e.leaseId === successor.id && e.action === "lease.renewed",
			),
		).toHaveLength(1);
		expect(
			audit.filter(
				(e) => e.waiterId === cancelled.id && e.action === "waiter.cancelled",
			),
		).toHaveLength(1);
		expect(new Set(audit.map((e) => e.eventKey)).size).toBe(audit.length);
		c.close();
	});

	test("bindings, immutable waiters, observation health and latest samples survive restart", async () => {
		const path = await home();
		let c = await coordinator(path, "process-a");
		await c.putDefinition({
			...definition("gpu"),
			observationKind: "amd-gpu",
		});
		await c.putBinding({
			id: "gpu:0000:03:00.0",
			resourceId: "gpu",
			stableKey: "0000:03:00.0/uuid-a",
			enabled: true,
			version: 1n,
			metadata: { vendor: "amd" },
		});
		const waiter = await c.putWaiter({
			requestKey: "stable-request",
			projectId: "a",
			requirements: [
				{
					resourceId: "gpu",
					bindingId: "gpu:0000:03:00.0",
					amount: 1n,
				},
			],
			metadata: { run: "run-1" },
		});
		expect(
			(
				await c.putWaiter({
					requestKey: "stable-request",
					projectId: "a",
					requirements: [
						{
							resourceId: "gpu",
							bindingId: "gpu:0000:03:00.0",
							amount: 1n,
						},
					],
					metadata: { run: "run-1" },
				})
			).id,
		).toBe(waiter.id);
		await expect(
			c.putWaiter({
				requestKey: "stable-request",
				projectId: "a",
				requirements: [{ resourceId: "gpu", amount: 1n }],
			}),
		).rejects.toThrow("different immutable request");
		await c.observations.recordHealth({
			kind: "amd-gpu",
			result: "degraded",
			checkedAt: 10,
			processBootId: "process-a",
			kernelBootId: "kernel-a",
			detail: { warning: "fixture" },
		});
		await c.observations.recordSample({
			bindingId: "gpu:0000:03:00.0",
			kind: "amd-gpu",
			sequence: 7n,
			result: "ok",
			processBootId: "process-a",
			kernelBootId: "kernel-a",
			observedAt: 10,
			durationMs: 2,
			metrics: { busy: 0 },
			occupants: [],
			warnings: [],
			adapterVersion: "fixture-1",
		});
		c.close();

		c = await coordinator(path, "process-b");
		const model = c.readModel();
		expect(model.bindings[0]?.stableKey).toBe("0000:03:00.0/uuid-a");
		expect(model.waiters[0]?.id).toBe(waiter.id);
		expect(model.observations[0]).toMatchObject({
			sequence: 7n,
			processBootId: "process-a",
			result: "ok",
		});
		expect(model.health[0]).toMatchObject({
			result: "degraded",
			processBootId: "process-a",
		});
		c.close();
	});

	test("wake subscriptions are transition-driven and manual refresh coalesces", async () => {
		const path = await home();
		const c = await coordinator(path, "process-a");
		let wakes = 0;
		c.subscribe("a", () => wakes++);
		await c.putDefinition(definition("gpu"));
		await Bun.sleep(0);
		expect(wakes).toBe(1);

		let calls = 0;
		let finish!: () => void;
		const gate = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const first = c.observations.refresh(async () => {
			calls++;
			await gate;
		});
		const second = c.observations.refresh(async () => {
			calls++;
		});
		expect(first).toBe(second);
		expect(calls).toBe(1);
		finish();
		await first;
		c.close();
	});

	test("coherent observation batches are retry-idempotent and reject same-sequence conflicts", async () => {
		const path = await home();
		const c = await coordinator(path, "process-a");
		await c.putDefinition({
			...definition("gpu"),
			observationKind: "nvidia-gpu",
		});
		await c.putBinding({
			id: "gpu-0",
			resourceId: "gpu",
			stableKey: "gpu:nvidia:0000:65:00.0:GPU-synthetic",
			enabled: true,
			version: 1n,
		});
		const health = {
			kind: "nvidia-gpu",
			result: "ok" as const,
			checkedAt: 1_000,
			processBootId: "process-a",
			kernelBootId: "kernel-a",
			detail: {
				generation: {
					processBootId: "process-a",
					kernelBootId: "kernel-a",
					sequence: "1",
				},
				freshness: { state: "fresh", expiresAt: "later" },
				latest: { occupied: false },
			},
		};
		const sample = {
			bindingId: "gpu-0",
			kind: "nvidia-gpu",
			sequence: 1n,
			result: "ok" as const,
			processBootId: "process-a",
			kernelBootId: "kernel-a",
			observedAt: 999,
			durationMs: 1,
			metrics: { occupied: false },
			occupants: [],
			warnings: [],
			adapterVersion: "test-1",
		};

		const first = await c.store.recordObservationBatch(health, [sample]);
		expect(first.meaningfulChange).toBe(true);
		const generation = (await c.store.readModel()).generation;
		const auditCount = (await c.store.auditEntries()).filter(
			(entry) => entry.action === "observation.batch",
		).length;

		const [retryA, retryB] = await Promise.all([
			c.store.recordObservationBatch(structuredClone(health), [
				structuredClone(sample),
			]),
			c.store.recordObservationBatch(structuredClone(health), [
				structuredClone(sample),
			]),
		]);
		expect(retryA.meaningfulChange).toBe(false);
		expect(retryB.meaningfulChange).toBe(false);
		expect((await c.store.readModel()).generation).toBe(generation);
		expect(
			(await c.store.auditEntries()).filter(
				(entry) => entry.action === "observation.batch",
			),
		).toHaveLength(auditCount);

		await expect(
			c.store.recordObservationBatch(health, [
				{ ...sample, metrics: { occupied: true } },
			]),
		).rejects.toThrow("observation sequence conflict");
		await expect(
			c.store.recordObservationBatch(
				{
					...health,
					checkedAt: 1_500,
					detail: {
						...health.detail,
						generation: {
							processBootId: "process-a",
							kernelBootId: "kernel-a",
							sequence: "2",
						},
					},
				},
				[sample],
			),
		).rejects.toThrow("mixed generation");
		const afterConflict = await c.store.readModel();
		expect(afterConflict.generation).toBe(generation);
		expect(afterConflict.observations[0]?.metrics).toEqual({
			occupied: false,
		});

		const newer = await c.store.recordObservationBatch(
			{
				...health,
				checkedAt: 2_000,
				detail: {
					generation: {
						processBootId: "process-a",
						kernelBootId: "kernel-a",
						sequence: "2",
					},
					freshness: { state: "fresh", expiresAt: "later-still" },
					latest: { occupied: true },
				},
			},
			[
				{
					...sample,
					sequence: 2n,
					observedAt: 1_999,
					metrics: { occupied: true },
				},
			],
		);
		expect(newer.meaningfulChange).toBe(true);
		expect((await c.store.readModel()).generation).toBe(generation + 1n);
		expect(
			(await c.store.auditEntries()).filter(
				(entry) => entry.action === "observation.batch",
			),
		).toHaveLength(auditCount + 1);
		c.close();

		const restarted = await coordinator(path, "process-b");
		const restartedHealth = {
			...health,
			// A restarted process is authoritative even if NTP or RTC correction
			// moved the wall clock behind the previous process's last sample.
			checkedAt: 1_500,
			processBootId: "process-b",
			detail: {
				generation: {
					processBootId: "process-b",
					kernelBootId: "kernel-a",
					sequence: "1",
				},
				freshness: { state: "fresh", expiresAt: "after-restart" },
				latest: { occupied: false },
			},
		};
		await expect(
			restarted.store.recordObservationBatch(restartedHealth, [
				{
					...sample,
					sequence: 1n,
					processBootId: "process-b",
					observedAt: 1_499,
				},
			]),
		).resolves.toEqual({ meaningfulChange: true });
		const recovered = await restarted.store.readModel();
		expect(recovered.health[0]).toMatchObject({
			processBootId: "process-b",
			checkedAt: 1_500,
		});
		expect(recovered.observations[0]).toMatchObject({
			processBootId: "process-b",
			sequence: 1n,
		});
		expect(recovered.effectiveCapacities[0]?.holdReason).not.toBe(
			"observation-inconsistent",
		);
		restarted.close();
	});
});
