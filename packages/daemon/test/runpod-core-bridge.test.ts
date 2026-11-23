import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderLease } from "../src/execution-target.ts";
import { RunPodCoreBridge } from "../src/resources/runpod-bridge.ts";
import type { ResourceLease } from "../src/resources/types.ts";
import type { RunPodAccountService } from "../src/runpod-account-service.ts";
import {
	accountFixture,
	FakeRunPodProvider,
	reconcilePolicy,
	reconcileRequest,
	testIntent,
	untrackedPod,
} from "./fixtures/runpod-account.ts";
import { type LedgerFixture, openTestLedger } from "./support/host-ledger.ts";

describe("RunPod capacity and cleanup records in the core", () => {
	let home: string;
	let fixture: LedgerFixture;
	let provider: FakeRunPodProvider;
	let bridge: RunPodCoreBridge;
	let account: RunPodAccountService;
	let n = 0;

	const coordinator = () => fixture.ledger.coordinator;
	const store = () => coordinator().store;

	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), "mfw-runpod-core-"));
		fixture = await openTestLedger(home, { processBootId: "boot-a" });
		provider = new FakeRunPodProvider();
		bridge = new RunPodCoreBridge({
			coordinator: coordinator(),
			client: provider,
			policy: reconcilePolicy,
			now: () => fixture.clock.now(),
		});
		await bridge.start();
		({ account } = await accountFixture(provider, {
			mfwHome: home,
			core: bridge,
		}));
		await account.start();
	});

	afterEach(async () => {
		await account.stop();
		fixture.close();
		await rm(home, { recursive: true, force: true });
	});

	async function admit(runId: string): Promise<ResourceLease> {
		const waiter = await coordinator().putWaiter({
			requestKey: `run-${runId}-${++n}`,
			projectId: "project-a",
			claims: bridge.claimsFor(reconcileRequest),
		});
		const grant = await coordinator().tryGrant(waiter.id);
		if ("kind" in grant) throw new Error(`held: ${grant.status}`);
		return coordinator().activate(grant, { runId });
	}

	const provision = (lease: ProviderLease, runId: string) =>
		account.command(lease.ref, `${runId}/provision`, { type: "provision" });

	const dispose = (lease: ProviderLease, runId: string) =>
		account.command(lease.ref, `${runId}/dispose`, {
			type: "dispose",
			reason: "run ended",
		});

	test("a run without a core lease never creates a pod", async () => {
		const lease = await account.putLeaseIntent(testIntent("run-free"));
		await expect(provision(lease, "run-free")).rejects.toMatchObject({
			code: "REFUSED",
		});
		expect(provider.creates).toBe(0);
		expect(await store().openCleanups()).toEqual([]);
	});

	test("the cleanup record commits before the provider create", async () => {
		await admit("run-a");
		const create = provider.createPod.bind(provider);
		let recordsAtCreate = -1;
		provider.createPod = async (input) => {
			recordsAtCreate = (await store().openCleanups()).length;
			return create(input);
		};
		const lease = await account.putLeaseIntent(testIntent("run-a"));
		await provision(lease, "run-a");
		expect(recordsAtCreate).toBe(1);
		expect(await store().openCleanups()).toMatchObject([
			{ ownershipToken: lease.ref, externalId: "created-1", state: "open" },
		]);
	});

	test("capacity stays held until an inventory proves the pod is gone", async () => {
		const held = await admit("run-a");
		const lease = await account.putLeaseIntent(testIntent("run-a"));
		await provision(lease, "run-a");

		await coordinator().release(held, "run ended");
		expect((await store().lease(held.id))?.state).toBe("releasing");

		provider.retainDeletes = true;
		await expect(dispose(lease, "run-a")).rejects.toMatchObject({
			code: "absence_not_confirmed",
		});
		expect(await store().openCleanups()).toHaveLength(1);
		expect((await store().lease(held.id))?.state).toBe("releasing");

		provider.retainDeletes = false;
		provider.pods = [];
		await dispose(lease, "run-a");
		expect(await store().openCleanups()).toEqual([]);
		expect((await store().lease(held.id))?.state).toBe("released");
	});

	test("a record never closes while the provider still lists the pod", async () => {
		await admit("run-a");
		const lease = await account.putLeaseIntent(testIntent("run-a"));
		await provision(lease, "run-a");
		await expect(
			bridge.absent(lease.ref, "not-its-owner"),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(await store().openCleanups()).toHaveLength(1);
	});

	test("after a crash, recovery closes a record the provider proves gone", async () => {
		const held = await admit("run-a");
		const lease = await account.putLeaseIntent(testIntent("run-a"));
		await provision(lease, "run-a");
		await coordinator().release(held, "run ended");

		// A fresh bridge, as after a restart, with the pod gone in the meantime.
		provider.pods = [];
		const restarted = new RunPodCoreBridge({
			coordinator: coordinator(),
			client: provider,
			policy: reconcilePolicy,
			now: () => fixture.clock.now(),
		});
		await restarted.settle(async (ref) =>
			ref === lease.ref ? "encoded" : null,
		);
		expect(await store().openCleanups()).toEqual([]);
		expect((await store().lease(held.id))?.state).toBe("released");
	});

	test("an unreachable provider leaves the record and the capacity held", async () => {
		const held = await admit("run-a");
		const lease = await account.putLeaseIntent(testIntent("run-a"));
		await provision(lease, "run-a");
		await coordinator().release(held, "run ended");
		provider.listFailure = new Error("provider down");
		await expect(bridge.absent(lease.ref, "encoded")).rejects.toThrow(
			"provider down",
		);
		expect(await store().openCleanups()).toHaveLength(1);
		expect((await store().lease(held.id))?.state).toBe("releasing");
	});

	test("the account's burn and pod ceilings are claims in the core", async () => {
		for (const run of ["run-1", "run-2", "run-3"]) await admit(run);
		const over = await coordinator().putWaiter({
			requestKey: "run-over",
			projectId: "project-b",
			claims: bridge.claimsFor(reconcileRequest),
		});
		expect(await coordinator().tryGrant(over.id)).toMatchObject({
			kind: "held",
			status: "blocked",
		});
	});

	test("a pod the core already leases is not counted again as foreign", async () => {
		await admit("run-a");
		const lease = await account.putLeaseIntent(testIntent("run-a"));
		await provision(lease, "run-a");
		fixture.clock.advance(20_000);
		await coordinator().observeAll();

		// The ceiling is three pods: the leased one plus two more still fit.
		await admit("run-b");
		await admit("run-c");
		const over = await coordinator().putWaiter({
			requestKey: "run-over",
			projectId: "project-b",
			claims: bridge.claimsFor(reconcileRequest),
		});
		expect(await coordinator().tryGrant(over.id)).toMatchObject({
			kind: "held",
			status: "blocked",
		});
	});

	test("a pod outside the core still narrows the account's capacity", async () => {
		provider.pods.push(untrackedPod("someone-elses", "other-run", "other"));
		fixture.clock.advance(20_000);
		await coordinator().observeAll();
		await admit("run-a");
		await admit("run-b");
		const over = await coordinator().putWaiter({
			requestKey: "run-over",
			projectId: "project-b",
			claims: bridge.claimsFor(reconcileRequest),
		});
		expect(await coordinator().tryGrant(over.id)).toMatchObject({
			kind: "held",
		});
	});

	test("removing an optional cap cannot stop the daemon booting", async () => {
		const { maxConcurrentPods: _removed, ...withoutPodCap } = reconcilePolicy;
		const next = new RunPodCoreBridge({
			coordinator: coordinator(),
			client: provider,
			policy: withoutPodCap,
			now: () => fixture.clock.now(),
		});
		await next.start();
		await coordinator().observeAll();
		// Claims follow the current policy, and the burn ceiling still applies.
		expect(next.claimsFor(reconcileRequest).map((c) => c.dimension)).toEqual([
			"burn",
		]);
		const waiter = await coordinator().putWaiter({
			requestKey: "after-cap-removed",
			projectId: "project-a",
			claims: next.claimsFor(reconcileRequest),
		});
		expect("kind" in (await coordinator().tryGrant(waiter.id))).toBe(false);
	});

	test("an invalid placement request refuses instead of claiming nothing", () => {
		expect(() => bridge.claimsFor({ computeType: "nope" })).toThrow(
			"placement request is invalid",
		);
	});
});
