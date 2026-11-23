import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectClaim } from "../src/resources/claims.ts";
import type { HostLedger } from "../src/resources/host-ledger.ts";
import { type LedgerFixture, openTestLedger } from "./support/host-ledger.ts";

/**
 * The semaphore guarantees that used to live in the scheduler, now enforced by
 * the resource core for every start path.
 */
const PROJECT = "project-a";

describe("project semaphores in the resource core", () => {
	let home: string;
	let fixture: LedgerFixture;
	let ledger: HostLedger;
	let n = 0;

	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), "mfw-semaphores-"));
		fixture = await openTestLedger(home);
		ledger = fixture.ledger;
	});

	afterEach(async () => {
		fixture.close();
		await rm(home, { recursive: true, force: true });
	});

	const request = (...names: string[]) =>
		ledger.coordinator.putWaiter({
			requestKey: `semaphore-${++n}`,
			projectId: PROJECT,
			claims: names.map((name) => projectClaim(PROJECT, name)),
		});

	test("a limit of two really grants two holders, on distinct slots", async () => {
		await ledger.syncProjectPool(PROJECT, "gpu", 2);
		const [a, b, c] = [
			await request("gpu"),
			await request("gpu"),
			await request("gpu"),
		];
		expect("kind" in (await ledger.coordinator.tryGrant(a.id))).toBe(false);
		expect("kind" in (await ledger.coordinator.tryGrant(b.id))).toBe(false);
		expect(await ledger.coordinator.tryGrant(c.id)).toMatchObject({
			kind: "held",
			status: "blocked",
		});
		const holders = await ledger.projectHolders(PROJECT, "gpu");
		expect(holders.map((h) => h.slot).sort()).toEqual([0, 1]);
	});

	test("force-unlocking a semaphore never frees the run's machine claims", async () => {
		await ledger.putDefinition({
			id: "gpu",
			accounting: "slot",
			provisioning: "static",
			capacity: 1n,
			enabled: true,
			draining: false,
			version: 1n,
		});
		await ledger.syncProjectPool(PROJECT, "serial", 1);
		const both = () =>
			ledger.coordinator.putWaiter({
				requestKey: `semaphore-${++n}`,
				projectId: PROJECT,
				claims: [ledger.claimFor("gpu"), projectClaim(PROJECT, "serial")],
			});
		const holder = await both();
		const grant = await ledger.coordinator.tryGrant(holder.id);
		if ("kind" in grant) throw new Error("expected a grant");
		await ledger.coordinator.activate(grant, { runId: "run-a" });

		expect(await ledger.forceReleaseProjectPool(PROJECT, "serial")).toEqual([
			{ slot: 0, runId: "run-a" },
		]);

		expect(await ledger.projectHolders(PROJECT, "serial")).toEqual([]);
		expect((await ledger.coordinator.store.lease(grant.id))?.state).toBe(
			"active",
		);
		const semaphoreOnly = await request("serial");
		expect(
			"kind" in (await ledger.coordinator.tryGrant(semaphoreOnly.id)),
		).toBe(false);
		const machine = await ledger.coordinator.putWaiter({
			requestKey: `semaphore-${++n}`,
			projectId: PROJECT,
			claims: [ledger.claimFor("gpu")],
		});
		expect(await ledger.coordinator.tryGrant(machine.id)).toMatchObject({
			kind: "held",
			status: "blocked",
		});
		await ledger.coordinator.release(grant, "run ended");
		expect((await ledger.coordinator.store.lease(grant.id))?.state).toBe(
			"released",
		);
	});

	test("a limit of one admits exactly one", async () => {
		await ledger.syncProjectPool(PROJECT, "serial", 1);
		const a = await request("serial");
		const b = await request("serial");
		expect("kind" in (await ledger.coordinator.tryGrant(a.id))).toBe(false);
		expect("kind" in (await ledger.coordinator.tryGrant(b.id))).toBe(true);
	});

	test("an unknown semaphore refuses instead of imposing no constraint", async () => {
		await expect(request("never-registered")).rejects.toMatchObject({
			code: "REFUSED",
		});
	});

	test("one free and one full semaphore acquires neither", async () => {
		await ledger.syncProjectPool(PROJECT, "free", 1);
		await ledger.syncProjectPool(PROJECT, "busy", 1);
		const squatter = await request("busy");
		await ledger.coordinator.tryGrant(squatter.id);
		const both = await request("free", "busy");
		expect(await ledger.coordinator.tryGrant(both.id)).toMatchObject({
			kind: "held",
		});
		expect(await ledger.projectHolders(PROJECT, "free")).toEqual([]);
	});

	test("releasing a holder gives the next waiter its slot", async () => {
		await ledger.syncProjectPool(PROJECT, "serial", 1);
		const a = await request("serial");
		const lease = await ledger.coordinator.tryGrant(a.id);
		if ("kind" in lease) throw new Error("expected a grant");
		await ledger.coordinator.activate(lease, { runId: "run-a" });
		const b = await request("serial");
		expect("kind" in (await ledger.coordinator.tryGrant(b.id))).toBe(true);
		await ledger.coordinator.release(lease, "run ended");
		expect("kind" in (await ledger.coordinator.tryGrant(b.id))).toBe(false);
	});

	test("an unregistered semaphore parks its waiters", async () => {
		await ledger.syncProjectPool(PROJECT, "gpu", 1);
		await ledger.retireProjectPool(PROJECT, "gpu");
		const waiter = await request("gpu");
		expect(await ledger.coordinator.tryGrant(waiter.id)).toMatchObject({
			kind: "held",
			status: "parked",
		});
	});
});
