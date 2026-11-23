import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeHost } from "../../plugin-api/src/fakes/fake-host.ts";
import { FakeResource } from "../../plugin-api/src/fakes/fake-resource.ts";
import type { PoolProposal } from "../../plugin-api/src/resource.ts";
import { ResourceCoordinator } from "../src/resources/coordinator.ts";
import {
	openResourceStore,
	type ResourceStore,
} from "../src/resources/store.ts";
import type {
	Claim,
	LeaseEvidence,
	ResourceLease,
} from "../src/resources/types.ts";

const CPU: PoolProposal = {
	poolId: "local.cpu",
	title: "CPU",
	providerHardLimit: false,
	dimensions: [{ kind: "quantity", name: "permits", unit: "permit", total: 2 }],
};
const GPU: PoolProposal = {
	poolId: "local.gpu",
	title: "GPU",
	providerHardLimit: false,
	dimensions: [{ kind: "slot", name: "slot", total: 1, units: ["gpu0"] }],
};
const SPEND: PoolProposal = {
	poolId: "openrouter.main",
	title: "OpenRouter",
	providerHardLimit: false,
	dimensions: [
		{
			kind: "window",
			name: "daily",
			unit: "usd",
			limit: 10,
			window: { type: "rolling", seconds: 86_400 },
		},
	],
};

const cpu = (amount = 1): Claim => ({
	poolId: "local.cpu",
	dimension: "permits",
	amount,
});
const gpu: Claim = { poolId: "local.gpu", dimension: "slot", amount: 1 };
const usd = (amount: number | null): Claim => ({
	poolId: "openrouter.main",
	dimension: "daily",
	amount,
});

describe("resource coordinator over a fake multi-resource fleet", () => {
	let home: string;
	let store: ResourceStore;
	let host: FakeHost;
	let plugin: FakeResource;
	let coordinator: ResourceCoordinator;
	let evidence: LeaseEvidence;
	let sequence = 0;

	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), "mfw-resource-coordinator-"));
		host = new FakeHost();
		store = await openResourceStore(home, { now: () => host.clock.now() });
		plugin = new FakeResource([CPU, GPU, SPEND]);
		evidence = "live";
		coordinator = new ResourceCoordinator(store, {
			host,
			plugins: [plugin],
			liveness: { inspect: async () => evidence },
		});
		await coordinator.registerPlugins();
		await coordinator.observeAll();
	});

	afterEach(async () => {
		coordinator.close();
		await rm(home, { recursive: true, force: true });
	});

	async function request(claims: Claim[], projectId = "alpha") {
		return coordinator.putWaiter({
			requestKey: `req-${++sequence}`,
			projectId,
			claims,
		});
	}

	async function granted(claims: Claim[], projectId = "alpha") {
		const waiter = await request(claims, projectId);
		const lease = await coordinator.tryGrant(waiter.id);
		if ("kind" in lease) throw new Error(`held: ${lease.status}`);
		return lease as ResourceLease;
	}

	test("a claim set across pools is granted all or nothing", async () => {
		const first = await granted([gpu, cpu()]);
		expect(first.state).toBe("provisional");
		const second = await request([gpu, cpu()]);
		expect(await coordinator.tryGrant(second.id)).toMatchObject({
			kind: "held",
			status: "blocked",
		});
		const summary = await coordinator.summaries();
		// The refused claim took nothing from the CPU pool.
		expect(
			summary.find((p) => p.poolId === "local.cpu")?.dimensions[0]?.used,
		).toBe(1);
	});

	test("a waiter on a held pool parks and does not block other work", async () => {
		await coordinator.placeOperatorHold({
			poolId: "local.gpu",
			actor: "owner",
		});
		const parked = await request([gpu, cpu()]);
		expect(await coordinator.tryGrant(parked.id)).toMatchObject({
			kind: "held",
			status: "parked",
		});
		// Younger work on the shared CPU pool passes the parked waiter.
		const younger = await granted([cpu()]);
		expect(younger.state).toBe("provisional");
	});

	test("a parked waiter resumes at its original position", async () => {
		await coordinator.placeOperatorHold({
			poolId: "local.gpu",
			actor: "owner",
		});
		const parked = await request([gpu, cpu(2)]);
		const younger = await request([cpu(2)]);
		await coordinator.clearOperatorHold("local.gpu");
		// The hold cleared: the older waiter is first again.
		expect(await coordinator.tryGrant(younger.id)).toMatchObject({
			kind: "held",
			status: "blocked",
		});
		const lease = await coordinator.tryGrant(parked.id);
		expect("kind" in lease).toBe(false);
	});

	test("the brain may add an operator hold and never clear one", async () => {
		await coordinator.placeOperatorHold({
			poolId: "local.gpu",
			actor: "brain",
		});
		await expect(
			store.clearHold("local.gpu", "operator", "brain"),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			store.clearHold("local.gpu", "operator", "core"),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(await store.holds("local.gpu")).toHaveLength(1);
	});

	test("usage windows reserve, settle actuals and refuse past the limit", async () => {
		const lease = await granted([usd(6)]);
		const over = await request([usd(6)]);
		expect(await coordinator.tryGrant(over.id)).toMatchObject({
			kind: "held",
			status: "blocked",
		});
		await coordinator.activate(lease, { runId: "run-1" });
		await coordinator.release(lease, "done", [
			{ poolId: "openrouter.main", dimension: "daily", amount: 2 },
		]);
		const next = await coordinator.tryGrant(over.id);
		expect("kind" in next).toBe(false);
	});

	test("unknown actual spend stands as the estimate, never zero", async () => {
		const lease = await granted([usd(6)]);
		await coordinator.activate(lease, { runId: "run-1" });
		await coordinator.release(lease, "done", [
			{ poolId: "openrouter.main", dimension: "daily", amount: null },
		]);
		const [entry] = await store.ledger({ leaseId: lease.id });
		expect(entry).toMatchObject({ state: "estimated", amount: 6 });
	});

	test("a window with no cost estimate is refused with a fix", async () => {
		await expect(request([usd(null)])).rejects.toMatchObject({
			code: "REFUSED",
			fix: expect.stringContaining("per-run cap"),
		});
	});

	test("a failing plugin holds its pools and live leases continue", async () => {
		const lease = await granted([cpu()]);
		await coordinator.activate(lease, { runId: "run-1" });
		const failing = plugin.observe.bind(plugin);
		plugin.observe = async () => {
			throw new Error("plugin crashed");
		};
		await coordinator.observeAll();
		const blocked = await request([cpu()]);
		expect(await coordinator.tryGrant(blocked.id)).toMatchObject({
			kind: "held",
			status: "parked",
		});
		expect((await store.lease(lease.id))?.state).toBe("active");
		plugin.observe = failing;
		await coordinator.observeAll();
		expect("kind" in (await coordinator.tryGrant(blocked.id))).toBe(false);
	});

	test("a good observation never clears an operator hold", async () => {
		await coordinator.placeOperatorHold({
			poolId: "local.cpu",
			actor: "owner",
		});
		await coordinator.observeAll();
		expect((await store.holds("local.cpu")).map((h) => h.reason)).toEqual([
			"operator",
		]);
	});

	test("an observation that raises capacity is clamped and recorded", async () => {
		plugin.observed.set("local.cpu", [
			{ kind: "quantity", name: "permits", total: 64, used: null },
		]);
		await coordinator.observeAll();
		await granted([cpu(2)]);
		const third = await request([cpu()]);
		expect(await coordinator.tryGrant(third.id)).toMatchObject({
			kind: "held",
		});
	});

	test("a stale observation holds the pool", async () => {
		host.clock.advance(31_000);
		const waiter = await request([cpu()]);
		const held = await coordinator.tryGrant(waiter.id);
		expect(held).toMatchObject({ kind: "held", status: "parked" });
		await coordinator.observeAll();
		expect("kind" in (await coordinator.tryGrant(waiter.id))).toBe(false);
	});

	test("concurrent grants never oversubscribe a pool", async () => {
		const waiters = await Promise.all(
			Array.from({ length: 12 }, () => request([cpu()])),
		);
		const results = await Promise.all(
			waiters.map((w) => coordinator.tryGrant(w.id)),
		);
		expect(results.filter((r) => !("kind" in r))).toHaveLength(2);
	});

	test("force release needs conclusive liveness evidence", async () => {
		const lease = await granted([cpu()]);
		await coordinator.activate(lease, { runId: "run-1" });
		evidence = "unknown";
		await expect(
			coordinator.forceRelease({
				leaseId: lease.id,
				expectedFence: lease.fence,
				actor: "owner",
				reason: "stuck",
			}),
		).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
		evidence = "absent";
		expect(
			await coordinator.forceRelease({
				leaseId: lease.id,
				expectedFence: lease.fence,
				actor: "owner",
				reason: "stuck",
			}),
		).toBe(true);
	});

	test("a released lease wakes other projects", async () => {
		const lease = await granted([cpu(2)]);
		await coordinator.activate(lease, { runId: "run-1" });
		let woken = 0;
		const stop = coordinator.subscribe("beta", () => {
			woken++;
		});
		await coordinator.release(lease, "done");
		await Promise.resolve();
		expect(woken).toBe(1);
		stop();
	});
});
