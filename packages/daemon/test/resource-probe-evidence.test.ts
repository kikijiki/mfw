import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ObservationHealth,
	StoredObservation,
} from "../src/resources/host-types.ts";
import {
	openResourceStore,
	type ResourceStore,
} from "../src/resources/store.ts";
import { type LedgerFixture, openTestLedger } from "./support/host-ledger.ts";

const BOOT = { processBootId: "process-a", kernelBootId: "kernel-a" };

function healthAt(sequence: bigint, checkedAt: number): ObservationHealth {
	return {
		kind: "nvidia-gpu",
		result: "ok",
		checkedAt,
		...BOOT,
		detail: {
			generation: { ...BOOT, sequence: sequence.toString() },
			freshness: { state: "fresh", expiresAt: "later" },
			latest: { occupied: false },
		},
	};
}

function sampleAt(sequence: bigint, observedAt: number): StoredObservation {
	return {
		bindingId: "gpu-0",
		kind: "nvidia-gpu",
		sequence,
		result: "ok",
		...BOOT,
		observedAt,
		durationMs: 1,
		metrics: { occupied: false },
		occupants: [],
		warnings: [],
		adapterVersion: "test-1",
	};
}

describe("durable probe evidence", () => {
	let home: string;
	let store: ResourceStore;

	const batches = async () =>
		(await store.auditEntries()).filter(
			(entry) => entry.action === "observation.batch",
		);

	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), "mfw-probe-evidence-"));
		store = await openResourceStore(home, { now: () => 1_000 });
	});

	afterEach(async () => {
		store.close();
		await rm(home, { recursive: true, force: true });
	});

	test("a retried batch changes nothing, even when retries race", async () => {
		const first = await store.recordProbeBatch(healthAt(1n, 1_000), [
			sampleAt(1n, 999),
		]);
		expect(first.meaningfulChange).toBe(true);
		const [a, b] = await Promise.all([
			store.recordProbeBatch(healthAt(1n, 1_000), [sampleAt(1n, 999)]),
			store.recordProbeBatch(healthAt(1n, 1_000), [sampleAt(1n, 999)]),
		]);
		expect(a.meaningfulChange).toBe(false);
		expect(b.meaningfulChange).toBe(false);
		expect(await batches()).toHaveLength(1);
	});

	test("different content under one sequence is refused and writes nothing", async () => {
		await store.recordProbeBatch(healthAt(1n, 1_000), [sampleAt(1n, 999)]);
		await expect(
			store.recordProbeBatch(healthAt(1n, 1_000), [
				{ ...sampleAt(1n, 999), metrics: { occupied: true } },
			]),
		).rejects.toThrow("observation sequence conflict");
		await expect(
			store.recordProbeBatch(healthAt(2n, 1_500), [sampleAt(1n, 999)]),
		).rejects.toThrow("mixed generation");
		const { samples, health } = await store.readProbeEvidence();
		expect(samples[0]?.metrics).toEqual({ occupied: false });
		expect(health[0]?.checkedAt).toBe(1_000);
	});

	test("an older batch of the same process is ignored", async () => {
		await store.recordProbeBatch(healthAt(5n, 2_000), [sampleAt(5n, 2_000)]);
		const older = await store.recordProbeBatch(healthAt(4n, 1_500), [
			sampleAt(4n, 1_500),
		]);
		expect(older.meaningfulChange).toBe(false);
		expect((await store.readProbeEvidence()).samples[0]?.sequence).toBe(5n);
	});

	test("a new process may restart from a lower sequence", async () => {
		await store.recordProbeBatch(healthAt(500n, 1_000), [
			sampleAt(500n, 1_000),
		]);
		const next = { processBootId: "process-b", kernelBootId: "kernel-a" };
		const health: ObservationHealth = {
			...healthAt(1n, 1_100),
			...next,
			detail: {
				generation: { ...next, sequence: "1" },
				freshness: { state: "fresh", expiresAt: "later" },
			},
		};
		await store.recordProbeBatch(health, [{ ...sampleAt(1n, 1_100), ...next }]);
		expect((await store.readProbeEvidence()).samples[0]).toMatchObject({
			processBootId: "process-b",
			sequence: 1n,
		});
	});

	test("a batch without a coherent generation is refused", async () => {
		await expect(
			store.recordProbeBatch({ ...healthAt(1n, 1_000), detail: {} }, []),
		).rejects.toMatchObject({ code: "REFUSED" });
	});
});

describe("probe evidence across a restart", () => {
	const GiB = 1n << 30n;
	let home: string;
	let fixture: LedgerFixture;

	const memoryHealth = (
		processBootId: string,
		now: number,
	): ObservationHealth => ({
		kind: "linux-memory",
		result: "ok",
		checkedAt: now,
		processBootId,
		kernelBootId: "kernel-a",
		detail: {
			adapterVersion: "mfw-linux-memory-v1",
			tool: { name: "procfs", version: "linux" },
			generation: {
				processBootId,
				kernelBootId: "kernel-a",
				sequence: "1",
			},
			freshness: {
				state: "fresh",
				checkedAt: new Date(now).toISOString(),
				expiresAt: new Date(now + 10_000).toISOString(),
			},
			diagnostics: [],
			latest: {
				memTotalBytes: (32n * GiB).toString(),
				memAvailableBytes: (20n * GiB).toString(),
				swapTotalBytes: "0",
				swapFreeBytes: "0",
				scope: "host",
			},
		},
	});

	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), "mfw-probe-restart-"));
		fixture = await openTestLedger(home, {
			processBootId: "process-a",
			kernelBootId: "kernel-a",
			now: () => 50_000,
		});
		await fixture.ledger.putDefinition({
			id: "ram",
			accounting: "quantity",
			quantityUnit: "bytes",
			capacity: 16n * GiB,
			safetyHeadroom: 4n * GiB,
			provisioning: "static",
			enabled: true,
			draining: false,
			version: 1n,
			observationKind: "linux-memory",
		});
		await fixture.ledger.observations.recordHealth(
			memoryHealth("process-a", 50_000),
		);
		await fixture.ledger.applyObservations();
	});

	afterEach(async () => {
		fixture.close();
		await rm(home, { recursive: true, force: true });
	});

	test("the operator still sees it and admission does not trust it", async () => {
		const claim = { poolId: "local.ram", dimension: "mib", amount: 1024 };
		const before = await fixture.ledger.coordinator.putWaiter({
			requestKey: "before-restart",
			projectId: "a",
			claims: [claim],
		});
		expect(
			"kind" in (await fixture.ledger.coordinator.tryGrant(before.id)),
		).toBe(false);
		fixture.close();

		fixture = await openTestLedger(home, {
			processBootId: "process-b",
			kernelBootId: "kernel-a",
			now: () => 50_000,
		});
		await fixture.ledger.applyObservations();
		const model = fixture.ledger.readModel();
		expect(model.health[0]?.processBootId).toBe("process-a");
		expect(model.health[0]?.processBootId).not.toBe(model.processBootId);

		const after = await fixture.ledger.coordinator.putWaiter({
			requestKey: "after-restart",
			projectId: "a",
			claims: [claim],
		});
		expect(await fixture.ledger.coordinator.tryGrant(after.id)).toMatchObject({
			kind: "held",
			status: "parked",
		});
	});
});
