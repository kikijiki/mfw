import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import {
	acquireDaemonLock,
	DaemonLockError,
	type HostResourceDefinition,
	openHostResourceStore,
} from "../src/host-resources/index.ts";
import { HostProcessHarness } from "./support/host-resource-process-harness.ts";

let harness: HostProcessHarness;

type SerializedWaiter = {
	id: string;
	sequence: string;
	generation: string;
};

type GrantChildResult = {
	waiter: SerializedWaiter;
	result: {
		state?: string;
		kind?: string;
		reason?: string;
		waiterId?: string;
	};
};

type GrantReady = { waiter: SerializedWaiter };

beforeEach(async () => {
	harness = new HostProcessHarness();
	await harness.initialize();
});

afterEach(async () => {
	await harness.cleanup();
});

function slot(id: string, capacity: bigint): HostResourceDefinition {
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

function quantity(id: string, capacity: bigint): HostResourceDefinition {
	return {
		...slot(id, capacity),
		accounting: "quantity",
		quantityUnit: "integer",
	};
}

async function tryGrantCurrent(
	store: Awaited<ReturnType<typeof openHostResourceStore>>,
	waiterId: string,
	generation: bigint,
) {
	let result = await store.tryGrant(waiterId, generation);
	for (
		let retry = 0;
		"kind" in result && result.reason === "generation";
		retry++
	) {
		if (retry >= 8) throw new Error("test generation retry bound exhausted");
		result = await store.tryGrant(waiterId, result.generation);
	}
	return result;
}

async function setupHome(definitions: HostResourceDefinition[]) {
	const home = harness.path("home");
	harness.trackHome(home);
	const store = await openHostResourceStore(home, {
		processBootId: "parent-boot",
		kernelBootId: "kernel-a",
		busyTimeoutMs: 250,
	});
	for (const definition of definitions) await store.putDefinition(definition);
	for (const [id, name] of [
		["project-alpha", "alpha"],
		["project-beta", "beta"],
	] as const) {
		await store.registerProject({
			identity: { id, createdAt: 1 },
			root: `/synthetic/${name}`,
			displayName: name,
		});
	}
	return { home, store };
}

function grantConfig(
	home: string,
	barrierPath: string,
	projectId: string,
	requestKey: string,
	requirements: Array<{ resourceId: string; amount: string }>,
) {
	return {
		mode: "grant",
		home,
		barrierPath,
		processBootId: `client-${requestKey}`,
		kernelBootId: "kernel-a",
		request: { requestKey, projectId, requirements },
	};
}

describe("process-level host grant serialization", () => {
	test("two projects and independent clients cannot simultaneously over-grant capacity", async () => {
		const { home, store } = await setupHome([slot("gpu", 1n)]);
		try {
			const barrier = harness.path("grant-barrier");
			const alpha = await harness.spawn(
				grantConfig(home, barrier, "project-alpha", "alpha/gpu", [
					{ resourceId: "gpu", amount: "1" },
				]),
			);
			const beta = await harness.spawn(
				grantConfig(home, barrier, "project-beta", "beta/gpu", [
					{ resourceId: "gpu", amount: "1" },
				]),
			);
			const ready = await Promise.all([
				harness.waitReady<GrantReady>(alpha.readyPath),
				harness.waitReady<GrantReady>(beta.readyPath),
			]);
			await harness.signal(barrier);
			expect(
				await Promise.all([
					harness.exit(alpha.child),
					harness.exit(beta.child),
				]),
			).toEqual([0, 0]);
			const results = await Promise.all([
				harness.result<GrantChildResult>(alpha.resultPath),
				harness.result<GrantChildResult>(beta.resultPath),
			]);
			const grants = results.filter(
				(item) => item.result.state === "provisional",
			);
			const held = results.filter((item) => item.result.kind === "held");
			expect(grants).toHaveLength(1);
			expect(held).toHaveLength(1);
			expect(grants[0]?.waiter.sequence).toBe(
				ready
					.map((item) => BigInt(item.waiter.sequence))
					.sort((a, b) => (a < b ? -1 : 1))[0]
					?.toString(),
			);

			const model = await store.readModel();
			const promised = model.leases
				.filter((lease) => lease.state === "provisional")
				.reduce((sum, lease) => {
					const allocation = lease.allocations[0];
					if (!allocation)
						throw new Error("provisional lease has no allocation");
					return sum + allocation.amount;
				}, 0n);
			expect(promised).toBe(1n);
			const winner = model.leases.find(
				(lease) => lease.state === "provisional",
			);
			if (!winner) throw new Error("race produced no winning lease");
			await store.markReleasing(winner.id, winner.fence, "race proof complete");
			await store.finishRelease(winner.id, winner.fence);
			const loser = model.waiters.find(
				(waiter) => waiter.id === held[0]?.result.waiterId,
			);
			if (!loser) throw new Error("race produced no waiting loser");
			expect(
				await tryGrantCurrent(store, loser.id, loser.generation),
			).toMatchObject({
				state: "provisional",
			});
			const audit = await store.auditEntries({ limit: 1_000 });
			expect(
				audit.filter((entry) => entry.action === "lease.provisional"),
			).toHaveLength(2);
			expect(new Set(audit.map((entry) => entry.eventKey)).size).toBe(
				audit.length,
			);
		} finally {
			store.close();
		}
	}, 30_000);

	test("FIFO overlap and all-or-none survive a simultaneous three-client wave", async () => {
		const { home, store } = await setupHome([
			slot("gpu", 1n),
			quantity("ram-bank", 2n),
			slot("network", 1n),
		]);
		try {
			const holder = await store.putWaiter({
				requestKey: "holder/gpu",
				projectId: "project-alpha",
				requirements: [{ resourceId: "gpu", amount: 1n }],
			});
			const holderLease = await store.tryGrant(holder.id, holder.generation);
			if ("kind" in holderLease)
				throw new Error("fixture holder was not granted");

			const barrier = harness.path("wave-barrier");
			const oldMulti = await harness.spawn(
				grantConfig(home, barrier, "project-alpha", "old/multi", [
					{ resourceId: "gpu", amount: "1" },
					{ resourceId: "ram-bank", amount: "2" },
				]),
			);
			await harness.waitReady(oldMulti.readyPath);
			const newerOverlap = await harness.spawn(
				grantConfig(home, barrier, "project-beta", "newer/ram", [
					{ resourceId: "ram-bank", amount: "1" },
				]),
			);
			const disjoint = await harness.spawn(
				grantConfig(home, barrier, "project-beta", "disjoint/network", [
					{ resourceId: "network", amount: "1" },
				]),
			);
			await Promise.all([
				harness.waitReady(newerOverlap.readyPath),
				harness.waitReady(disjoint.readyPath),
			]);
			await harness.signal(barrier);
			await Promise.all(
				[oldMulti, newerOverlap, disjoint].map((item) =>
					harness.exit(item.child),
				),
			);
			const [oldResult, newerResult, disjointResult] = (await Promise.all(
				[oldMulti, newerOverlap, disjoint].map((item) =>
					harness.result(item.resultPath),
				),
			)) as [GrantChildResult, GrantChildResult, GrantChildResult];
			expect(oldResult.result).toMatchObject({
				kind: "held",
				reason: "capacity",
			});
			expect(newerResult.result).toMatchObject({
				kind: "held",
				reason: "fifo",
			});
			expect(disjointResult.result).toMatchObject({ state: "provisional" });
			expect(
				(await store.readModel()).leases.some(
					(lease) => lease.waiterId === oldResult.waiter.id,
				),
			).toBe(false);

			await store.markReleasing(
				holderLease.id,
				holderLease.fence,
				"unblock FIFO head",
			);
			await store.finishRelease(holderLease.id, holderLease.fence);
			const oldGrant = await tryGrantCurrent(
				store,
				oldResult.waiter.id,
				BigInt(oldResult.waiter.generation),
			);
			expect(oldGrant).toMatchObject({
				state: "provisional",
				allocations: [
					{ resourceId: "gpu", amount: 1n },
					{ resourceId: "ram-bank", amount: 2n },
				],
			});
		} finally {
			store.close();
		}
	}, 30_000);
});

describe("process-global store exclusion and fail-closed startup", () => {
	test("store startup retries transient writer contention", async () => {
		const { home, store } = await setupHome([slot("gpu", 1n)]);
		store.close();
		const writerRelease = harness.path("release-transient-writer");
		const writer = await harness.spawn({
			mode: "hold-write",
			home,
			releasePath: writerRelease,
		});
		await harness.waitReady(writer.readyPath);
		const release = Bun.sleep(100).then(() => harness.signal(writerRelease));
		try {
			const reopened = await openHostResourceStore(home, {
				processBootId: "retrying-contender",
				kernelBootId: "kernel-a",
				busyTimeoutMs: 1_000,
			});
			reopened.close();
			await release;
			expect(await harness.exit(writer.child)).toBe(0);
		} finally {
			await release.catch(() => {});
			await harness.signal(writerRelease);
			await harness.exit(writer.child).catch(() => {});
		}
	}, 30_000);

	test("daemon lock exclusion and SQLite busy timeout are process-bounded", async () => {
		const { home, store } = await setupHome([slot("gpu", 1n)]);
		store.close();
		const lockRelease = harness.path("release-daemon-lock");
		const lockChild = await harness.spawn({
			mode: "hold-lock",
			home,
			releasePath: lockRelease,
		});
		await harness.waitReady(lockChild.readyPath);
		await expect(
			acquireDaemonLock(home, { processBootId: "contender", timeoutMs: 250 }),
		).rejects.toBeInstanceOf(DaemonLockError);
		await harness.signal(lockRelease);
		expect(await harness.exit(lockChild.child)).toBe(0);

		const writerRelease = harness.path("release-writer");
		const writer = await harness.spawn({
			mode: "hold-write",
			home,
			releasePath: writerRelease,
		});
		await harness.waitReady(writer.readyPath);
		const started = performance.now();
		try {
			await expect(
				openHostResourceStore(home, {
					processBootId: "busy-contender",
					kernelBootId: "kernel-a",
					busyTimeoutMs: 75,
				}),
			).rejects.toMatchObject({ code: "BUSY" });
			expect(performance.now() - started).toBeLessThan(1_000);
		} finally {
			await harness.signal(writerRelease);
			expect(await harness.exit(writer.child)).toBe(0);
		}
	});

	test("corrupt and newer stores never migrate or fall back optimistically", async () => {
		const corruptHome = harness.path("corrupt-home");
		harness.trackHome(corruptHome);
		await mkdir(join(corruptHome, "host"), { recursive: true });
		await writeFile(join(corruptHome, "host", "host.db"), "not sqlite\n");
		await expect(
			openHostResourceStore(corruptHome, {
				processBootId: "corrupt",
				kernelBootId: "kernel-a",
			}),
		).rejects.toMatchObject({ code: "CORRUPT" });

		const newerHome = harness.path("newer-home");
		harness.trackHome(newerHome);
		await mkdir(join(newerHome, "host"), { recursive: true });
		const raw = createClient({
			url: `file:${join(newerHome, "host", "host.db")}`,
		});
		await raw.execute("PRAGMA user_version=999");
		raw.close();
		await expect(
			openHostResourceStore(newerHome, {
				processBootId: "newer",
				kernelBootId: "kernel-a",
			}),
		).rejects.toMatchObject({ code: "INCOMPATIBLE_SCHEMA" });
	});
});
