import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import {
	openResourceStore,
	type ResourceStore,
} from "../src/resources/store.ts";
import type {
	Claim,
	PoolDefinition,
	ResourceHeld,
	ResourceLease,
} from "../src/resources/types.ts";

let home: string;
let store: ResourceStore;
let clock = 1_000_000;
const now = () => clock;

const CPU: PoolDefinition = {
	id: "local.cpu",
	title: "CPU",
	dimensions: [{ kind: "quantity", name: "permits", unit: "permit", total: 4 }],
};
const GPU: PoolDefinition = {
	id: "local.gpu.0",
	title: "GPU",
	dimensions: [{ kind: "slot", name: "slot", total: 2, units: ["u0", "u1"] }],
};
const SPEND: PoolDefinition = {
	id: "openrouter.main",
	title: "OpenRouter",
	dimensions: [
		{
			kind: "window",
			name: "usd",
			unit: "usd",
			limit: 10,
			window: { type: "rolling", seconds: 3600 },
		},
	],
};
const METER: PoolDefinition = {
	id: "claude-cli.fleet",
	title: "Claude",
	dimensions: [{ kind: "meter", name: "weekly" }],
};

const cpu = (amount = 1) => ({
	poolId: "local.cpu",
	dimension: "permits",
	amount,
});
const usd = (amount: number | null = 4) => ({
	poolId: "openrouter.main",
	dimension: "usd",
	amount,
});

let keys = 0;
async function request(
	claims: Parameters<ResourceStore["putWaiter"]>[0]["claims"],
	projectId = "p",
	scopes?: { scope: string; name: string }[],
) {
	return store.putWaiter({
		requestKey: `r${++keys}`,
		projectId,
		claims,
		...(scopes ? { scopes } : {}),
	});
}

async function granted(
	claims: Parameters<ResourceStore["putWaiter"]>[0]["claims"],
	projectId = "p",
	scopes?: { scope: string; name: string }[],
): Promise<ResourceLease> {
	const waiter = await request(claims, projectId, scopes);
	const result = await store.tryGrant(waiter.id);
	if ("kind" in result) throw new Error(`held: ${JSON.stringify(result)}`);
	return result;
}

async function active(
	claims: Parameters<ResourceStore["putWaiter"]>[0]["claims"],
	projectId = "p",
): Promise<ResourceLease> {
	const lease = await granted(claims, projectId);
	return store.activate(lease.id, lease.fence, `run-${lease.id}`, 60_000);
}

beforeEach(async () => {
	clock = 1_000_000;
	home = await mkdtemp(join(tmpdir(), "mfw-resources-"));
	store = await openResourceStore(home, { now });
	for (const pool of [CPU, GPU, SPEND, METER]) await store.definePool(pool);
});

afterEach(async () => {
	store.close();
	await rm(home, { recursive: true, force: true });
});

describe("store and host.db", () => {
	test.each([
		99, 4,
	])("refuses resource schema %d with the fix", async (version) => {
		store.close();
		const path = join(home, "host", "host.db");
		const client = createClient({ url: `file:${path}` });
		await client.execute(`UPDATE rp_schema SET version=${version}`);
		client.close();
		await expect(openResourceStore(home, { now })).rejects.toMatchObject({
			code: "INCOMPATIBLE_SCHEMA",
			message: expect.stringContaining(`delete ${path}`),
		});
		const fix = createClient({ url: `file:${path}` });
		await fix.execute("UPDATE rp_schema SET version=5");
		fix.close();
		store = await openResourceStore(home, { now });
	});

	test("an unreadable hold fails closed", async () => {
		const client = createClient({
			url: `file:${join(home, "host", "host.db")}`,
		});
		await client.executeMultiple(`PRAGMA ignore_check_constraints=ON;
			INSERT INTO rp_holds(id,pool_id,reason,actor,opened_at) VALUES('x','local.cpu','garbage','core',1);`);
		client.close();
		const waiter = await request([cpu()]);
		await expect(store.tryGrant(waiter.id)).rejects.toMatchObject({
			code: "CORRUPT",
		});
		expect(await store.liveLeases()).toEqual([]);
	});
});

describe("claims", () => {
	test("an unknown pool refuses instead of failing open", async () => {
		await expect(
			request([{ poolId: "project.mfw.nope", dimension: "slot", amount: 1 }]),
		).rejects.toMatchObject({ code: "REFUSED" });
	});

	test("a window claim with no estimate refuses with a fix", async () => {
		const error = await request([usd(null)]).catch((e) => e);
		expect(error.code).toBe("REFUSED");
		expect(error.fix).toContain("per-run cap");
	});

	test("a meter cannot be leased", async () => {
		await expect(
			request([{ poolId: "claude-cli.fleet", dimension: "weekly", amount: 1 }]),
		).rejects.toMatchObject({ code: "REFUSED" });
	});

	test("a request key is immutable and idempotent", async () => {
		const a = await store.putWaiter({
			requestKey: "k",
			projectId: "p",
			claims: [cpu()],
		});
		const b = await store.putWaiter({
			requestKey: "k",
			projectId: "p",
			claims: [cpu()],
		});
		expect(b.id).toBe(a.id);
		await expect(
			store.putWaiter({ requestKey: "k", projectId: "p", claims: [cpu(2)] }),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});

	test("a claim set is all or nothing", async () => {
		await active([usd(8)]);
		const waiter = await request([cpu(), usd(4)]);
		const held = (await store.tryGrant(waiter.id)) as ResourceHeld;
		expect(held.kind).toBe("held");
		const [cpuPool] = (await store.summaries()).filter(
			(s) => s.poolId === "local.cpu",
		);
		expect(cpuPool?.dimensions[0]?.used).toBe(0);
	});

	test("two store handles cannot over-grant one slot", async () => {
		await store.definePool({
			id: "project.mfw.deploy-lock",
			title: "lock",
			dimensions: [{ kind: "slot", name: "slot", total: 1 }],
		});
		const other = await openResourceStore(home, { now });
		const claim = {
			poolId: "project.mfw.deploy-lock",
			dimension: "slot",
			amount: 1,
		};
		const a = await store.putWaiter({
			requestKey: "a",
			projectId: "p",
			claims: [claim],
		});
		const b = await other.putWaiter({
			requestKey: "b",
			projectId: "q",
			claims: [claim],
		});
		const results = await Promise.all([
			store.tryGrant(a.id),
			other.tryGrant(b.id),
		]);
		other.close();
		expect(results.filter((r) => !("kind" in r)).length).toBe(1);
	});

	test("named units are allocated distinctly and return on release", async () => {
		const gpu = { poolId: "local.gpu.0", dimension: "slot", amount: 1 };
		const a = await active([{ ...gpu, unit: "u0" }]);
		const blocked = await request([{ ...gpu, unit: "u0" }]);
		expect(await store.tryGrant(blocked.id)).toMatchObject({
			status: "blocked",
		});
		await store.finishRelease(a.id, a.fence);
		expect(await store.tryGrant(blocked.id)).toMatchObject({
			state: "provisional",
		});
	});
});

describe("holds and parking", () => {
	test("a parked waiter does not stall the pool it shares, then rejoins first", async () => {
		await store.placeHold({
			poolId: "openrouter.main",
			reason: "budget",
			actor: "core",
		});
		const parked = await request([cpu(), usd(1)]);
		const next = await request([cpu()]);
		expect(await store.tryGrant(parked.id)).toMatchObject({ status: "parked" });
		expect(await store.tryGrant(next.id)).toMatchObject({
			state: "provisional",
		});
		const later = await request([cpu()]);
		await store.clearHold("openrouter.main", "budget", "core");
		expect(await store.tryGrant(later.id)).toMatchObject({ status: "blocked" });
		expect(await store.tryGrant(parked.id)).toMatchObject({
			state: "provisional",
		});
	});

	test("a timed hold expires on its own", async () => {
		await store.placeHold({
			poolId: "local.cpu",
			reason: "operator",
			actor: "owner",
			until: clock + 100,
		});
		const waiter = await request([cpu()]);
		expect(await store.tryGrant(waiter.id)).toMatchObject({ status: "parked" });
		clock += 100;
		expect(await store.tryGrant(waiter.id)).toMatchObject({
			state: "provisional",
		});
	});

	test("re-placing a hold never shortens it", async () => {
		const place = (until: number | null) =>
			store.placeHold({
				poolId: "local.cpu",
				reason: "operator",
				actor: "owner",
				until,
			});
		await place(clock + 1000);
		expect((await place(clock + 10)).until).toBe(clock + 1000);
		expect((await place(null)).until).toBeNull();
		expect((await place(clock + 10)).until).toBeNull();
	});

	test("the brain may add an operator hold and may never clear one", async () => {
		await store.placeHold({
			poolId: "local.cpu",
			reason: "operator",
			actor: "brain",
		});
		await expect(
			store.clearHold("local.cpu", "operator", "brain"),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			store.placeHold({
				poolId: "local.cpu",
				reason: "budget",
				actor: "brain",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			store.clearHold("local.cpu", "operator", "core"),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(await store.clearHold("local.cpu", "operator", "owner")).toBe(true);
	});
});

describe("observations", () => {
	const observe = (poolId: string, dimensions: unknown[], health = "ok") =>
		store.recordObservation({ poolId, observedAt: clock, health, dimensions });

	test("an observation narrows capacity and can never raise it", async () => {
		const narrowed = await observe("local.cpu", [
			{ kind: "quantity", name: "permits", total: 1, used: null },
		]);
		expect(narrowed.violations).toEqual([]);
		expect(
			(await store.canAdmit({ projectId: "p", claims: [cpu(2)] })).status,
		).toBe("parked");
		const raised = await observe("local.cpu", [
			{ kind: "quantity", name: "permits", total: 99, used: null },
		]);
		expect(raised.violations).toEqual(["permits"]);
		expect(
			(await store.canAdmit({ projectId: "p", claims: [cpu(5)] })).status,
		).toBe("parked");
	});

	test("an observation cannot clear a hold", async () => {
		await store.placeHold({
			poolId: "local.cpu",
			reason: "auth",
			actor: "core",
		});
		await observe("local.cpu", [
			{ kind: "quantity", name: "permits", total: 4, used: null },
		]);
		expect(
			(await store.canAdmit({ projectId: "p", claims: [cpu()] })).status,
		).toBe("parked");
	});

	test("a stale or missing observation holds the pool, and future stamps do not help", async () => {
		await store.definePool({ ...CPU, maxObservationAgeMs: 1000 });
		const status = async () =>
			(await store.canAdmit({ projectId: "p", claims: [cpu()] })).status;
		expect(await status()).toBe("parked");
		await store.recordObservation({
			poolId: "local.cpu",
			observedAt: clock + 10_000_000,
			health: "ok",
			dimensions: [],
		});
		expect(await status()).toBe("grantable");
		clock += 1001;
		expect(await status()).toBe("parked");
	});

	test("an externally occupied unit is not granted", async () => {
		await observe("local.gpu.0", [
			{ kind: "slot", name: "slot", total: 2, occupied: ["u0"] },
		]);
		const lease = await granted([
			{ poolId: "local.gpu.0", dimension: "slot", amount: 1 },
		]);
		expect(lease.state).toBe("provisional");
		const taken = await request([
			{ poolId: "local.gpu.0", dimension: "slot", amount: 1 },
		]);
		expect(await store.tryGrant(taken.id)).toMatchObject({ status: "blocked" });
	});

	test("meters gate admission and unknown admits", async () => {
		const claims = [{ poolId: "claude-cli.fleet", dimension: "weekly" }];
		expect((await store.canAdmit({ projectId: "p", claims })).status).toBe(
			"grantable",
		);
		await observe("claude-cli.fleet", [
			{ kind: "meter", name: "weekly", fraction: 1, resetsAt: clock + 100 },
		]);
		expect((await store.canAdmit({ projectId: "p", claims })).status).toBe(
			"parked",
		);
		clock += 100;
		expect((await store.canAdmit({ projectId: "p", claims })).status).toBe(
			"grantable",
		);
	});
});

describe("ledger", () => {
	test("reservations count before spend settles, across projects", async () => {
		await active([usd(6)], "p");
		const second = await request([usd(6)], "q");
		expect(await store.tryGrant(second.id)).toMatchObject({
			status: "blocked",
		});
	});

	test("actuals replace the reservation", async () => {
		const lease = await active([usd(6)]);
		await store.finishRelease(lease.id, lease.fence, [
			{ poolId: "openrouter.main", dimension: "usd", amount: 1.5 },
		]);
		const [entry] = await store.ledger({ leaseId: lease.id });
		expect(entry).toMatchObject({
			state: "settled",
			amount: 1.5,
			reservedAmount: 6,
		});
		expect(await store.finishRelease(lease.id, lease.fence)).toBe(false);
	});

	test("an unknown actual stands as an estimated charge, never 0", async () => {
		const lease = await active([usd(6)]);
		await store.finishRelease(lease.id, lease.fence, [
			{ poolId: "openrouter.main", dimension: "usd", amount: null },
		]);
		const [entry] = await store.ledger({ leaseId: lease.id });
		expect(entry).toMatchObject({ state: "estimated", amount: 6 });
		const blocked = await request([usd(6)]);
		expect(await store.tryGrant(blocked.id)).toMatchObject({
			status: "parked",
		});
		expect(await store.settleLate(lease.id, "openrouter.main", "usd", 2)).toBe(
			true,
		);
		expect(await store.settleLate(lease.id, "openrouter.main", "usd", 2)).toBe(
			false,
		);
		await expect(
			store.settleLate(lease.id, "openrouter.main", "usd", 3),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(await store.tryGrant(blocked.id)).toMatchObject({
			state: "provisional",
		});
	});

	test("spend leaves a rolling window when it ages out", async () => {
		const lease = await active([usd(9)]);
		await store.finishRelease(lease.id, lease.fence, [
			{ poolId: "openrouter.main", dimension: "usd", amount: 9 },
		]);
		const waiter = await request([usd(5)]);
		expect(await store.tryGrant(waiter.id)).toMatchObject({ status: "parked" });
		clock += 3_600_001;
		expect(await store.tryGrant(waiter.id)).toMatchObject({
			state: "provisional",
		});
	});

	test("an in-flight reservation still counts after its window passes", async () => {
		await active([usd(9)]);
		clock += 3_600_001;
		const waiter = await request([usd(5)]);
		expect(await store.tryGrant(waiter.id)).toMatchObject({
			status: "blocked",
		});
	});

	test("project quotas narrow the pool and may overcommit as siblings", async () => {
		await store.setQuota("openrouter.main/project:p", "usd", 7);
		await store.setQuota("openrouter.main/project:q", "usd", 7);
		await expect(
			store.setQuota("openrouter.main/project:r", "usd", 11),
		).rejects.toMatchObject({ code: "REFUSED" });
		await active([usd(5)], "p");
		const overP = await request([usd(3)], "p");
		expect(await store.tryGrant(overP.id)).toMatchObject({ status: "blocked" });
		await store.cancelWaiter(overP.id, "test");
		// 7 + 7 overcommits the $10 pool, so q fits its quota up to the pool's rest.
		expect(await granted([usd(5)], "q")).toMatchObject({
			state: "provisional",
		});
		const overPool = await request([usd(1)], "q");
		expect(await store.tryGrant(overPool.id)).toMatchObject({
			status: "blocked",
			blockers: [{ code: "capacity", detail: "machine" }],
		});
	});

	test("a child scope such as a brain quota is enforced", async () => {
		await store.setQuota("openrouter.main/brain:mfw", "usd", 2);
		const scopes = [{ scope: "brain", name: "mfw" }];
		const waiter = await request([usd(3)], "p", scopes);
		expect(await store.tryGrant(waiter.id)).toMatchObject({ status: "parked" });
	});

	test("a top-up succeeds within limits and refuses past them", async () => {
		const lease = await active([usd(6)]);
		const topUp = (n: number) =>
			store.topUp(lease.id, lease.fence, "openrouter.main", "usd", n);
		expect(await topUp(3)).toBe(true);
		expect(await topUp(2)).toBe(false);
		await store.placeHold({
			poolId: "openrouter.main",
			reason: "budget",
			actor: "core",
		});
		expect(await topUp(0.5)).toBe(false);
	});

	test("an external charge is idempotent under its key", async () => {
		const charge = {
			entryKey: "run-1:reported",
			projectId: "p",
			poolId: "openrouter.main",
			dimension: "usd",
			amount: 2,
		};
		expect(await store.recordCharge(charge)).toBe(true);
		expect(await store.recordCharge(charge)).toBe(false);
		await expect(
			store.recordCharge({ ...charge, amount: 3 }),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect((await store.ledger({ projectId: "p" })).length).toBe(1);
	});
});

describe("lease lifecycle and recovery", () => {
	test("a stale fence is refused on every mutation", async () => {
		const lease = await active([cpu()]);
		const stale = lease.fence + 1;
		const code = { code: "STALE_FENCE" };
		await expect(store.activate(lease.id, stale, "x", 1)).rejects.toMatchObject(
			code,
		);
		await expect(
			store.renewOrAdopt(lease.id, stale, "x", 1),
		).rejects.toMatchObject(code);
		await expect(
			store.markReleasing(lease.id, stale, "x"),
		).rejects.toMatchObject(code);
		await expect(store.finishRelease(lease.id, stale)).rejects.toMatchObject(
			code,
		);
		await expect(
			store.forceRelease(lease.id, stale, "o", "x"),
		).rejects.toMatchObject(code);
	});

	test("TTL expiry never frees capacity", async () => {
		await active([cpu(4)]);
		clock += 10_000_000;
		const waiter = await request([cpu()]);
		expect(await store.tryGrant(waiter.id)).toMatchObject({
			status: "blocked",
		});
	});

	test("only a provably unlaunched lease voids its reservation", async () => {
		const lease = await granted([usd(6)]);
		await store.releaseUnlaunched(lease.id, lease.fence, "never launched");
		expect((await store.ledger({ leaseId: lease.id }))[0]).toMatchObject({
			state: "void",
			amount: 0,
		});
		const running = await active([usd(1)]);
		await expect(
			store.releaseUnlaunched(running.id, running.fence, "x"),
		).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
	});

	test("reconcile: unknown keeps capacity, absence reclaims and charges the estimate", async () => {
		const lease = await active([cpu(4), usd(6)]);
		const unknown = await store.reconcile(async () => "unknown");
		expect(unknown.uncertain).toBe(1);
		expect((await store.lease(lease.id))?.state).toBe("uncertain");
		expect(
			(await store.canAdmit({ projectId: "p", claims: [cpu()] })).status,
		).toBe("blocked");
		const adopted = await store.reconcile(async () => "live");
		expect(adopted.adopted).toBe(1);
		const absent = await store.reconcile(async () => "absent");
		expect(absent.reclaimed).toBe(1);
		expect((await store.lease(lease.id))?.state).toBe("reclaimed");
		expect((await store.ledger({ leaseId: lease.id }))[0]?.state).toBe(
			"estimated",
		);
		expect(
			(await store.canAdmit({ projectId: "p", claims: [cpu()] })).status,
		).toBe("grantable");
	});

	test("a throwing inspector counts as unknown, not absent", async () => {
		const lease = await active([cpu()]);
		await store.reconcile(async () => {
			throw new Error("probe failed");
		});
		expect((await store.lease(lease.id))?.state).toBe("uncertain");
	});

	test("every kill point recovers to a consistent state after reopen", async () => {
		const steps = [
			"waiter",
			"grant",
			"active",
			"releasing",
			"released",
		] as const;
		for (const stop of steps) {
			const dir = await mkdtemp(join(tmpdir(), "mfw-resources-kill-"));
			let s = await openResourceStore(dir, { now });
			await s.definePool(CPU);
			await s.definePool(SPEND);
			const claims = [cpu(4), usd(6)];
			const w = await s.putWaiter({ requestKey: "k", projectId: "p", claims });
			if (stop !== "waiter") {
				const l = (await s.tryGrant(w.id)) as ResourceLease;
				if (stop !== "grant") {
					await s.activate(l.id, l.fence, "run", 1000);
					if (stop !== "active") {
						await s.markReleasing(l.id, l.fence, "done");
						if (stop !== "releasing") await s.finishRelease(l.id, l.fence);
					}
				}
			}
			s.close(); // the crash
			s = await openResourceStore(dir, { now });
			const replay = await s.putWaiter({
				requestKey: "k",
				projectId: "p",
				claims,
			});
			expect(replay.id).toBe(w.id);
			await s.reconcile(async () => "absent");
			expect(await s.liveLeases()).toEqual([]);
			const entries = await s.ledger({ projectId: "p" });
			expect(entries.filter((e) => e.state === "reserved")).toEqual([]);
			if (stop !== "waiter") expect(entries.length).toBe(1);
			s.close();
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("summaries", () => {
	test("reports use, reservations, queue and parking per pool", async () => {
		await active([cpu(1), usd(4)]);
		await store.placeHold({
			poolId: "local.gpu.0",
			reason: "operator",
			actor: "owner",
		});
		await request([{ poolId: "local.gpu.0", dimension: "slot", amount: 1 }]);
		clock += 50;
		const byId = new Map((await store.summaries()).map((s) => [s.poolId, s]));
		expect(byId.get("openrouter.main")?.dimensions[0]).toMatchObject({
			capacity: 10,
			reserved: 4,
			settled: 0,
		});
		expect(byId.get("local.gpu.0")).toMatchObject({
			queueDepth: 1,
			parked: 1,
			oldestWaitMs: 50,
		});
		expect(byId.get("claude-cli.fleet")?.dimensions[0]?.fraction).toBeNull();
	});
});

describe("model: random claim sets, holds and releases", () => {
	function rng(seed: number) {
		let x = seed;
		return (n: number) => {
			x = (x * 48271) % 2147483647;
			return x % n;
		};
	}

	for (const seed of [7, 42, 1337, 90210]) {
		test(`invariants hold for seed ${seed}`, async () => {
			const r = rng(seed);
			const live: ResourceLease[] = [];
			const waiting: { id: string; sequence: number }[] = [];
			const pools = ["local.cpu", "openrouter.main"] as const;
			for (let step = 0; step < 150; step++) {
				const op = r(6);
				if (op <= 1) {
					const claims: Claim[] = [];
					if (r(2) === 0) claims.push(cpu(1 + r(3)));
					if (claims.length === 0 || r(2) === 0) claims.push(usd(1 + r(4)));
					const w = await request(claims);
					waiting.push({ id: w.id, sequence: w.sequence });
				} else if (op === 2 && live.length > 0) {
					const [lease] = live.splice(r(live.length), 1);
					if (lease) await store.finishRelease(lease.id, lease.fence);
				} else if (op === 3) {
					const pool = pools[r(2)] as string;
					if (r(2) === 0) {
						await store.placeHold({
							poolId: pool,
							reason: "budget",
							actor: "core",
						});
					} else {
						await store.clearHold(pool, "budget", "core");
					}
				} else if (op === 4) {
					clock += 400_000;
				}
				for (const w of [...waiting]) {
					const verdict = await store.tryGrant(w.id);
					if (!("kind" in verdict)) {
						live.push(verdict);
						waiting.splice(waiting.indexOf(w), 1);
					}
				}
				const summaries = await store.summaries();
				for (const pool of summaries) {
					for (const d of pool.dimensions) {
						if (d.capacity === null) continue;
						// Settled spend may overrun; what the core promised may not.
						expect(d.reserved).toBeLessThanOrEqual(d.capacity + 1e-9);
						if (d.kind === "quantity") {
							expect(d.used).toBeLessThanOrEqual(d.capacity);
						}
					}
				}
			}
			for (const pool of pools) await store.clearHold(pool, "budget", "core");
			for (const lease of live)
				await store.finishRelease(lease.id, lease.fence);
			clock += 7_200_000;
			// With everything released, FIFO order must drain the whole queue.
			for (const w of [...waiting].sort((a, b) => a.sequence - b.sequence)) {
				const lease = await store.tryGrant(w.id);
				expect("kind" in lease).toBe(false);
				if (!("kind" in lease))
					await store.finishRelease(lease.id, lease.fence);
				clock += 7_200_000;
			}
		});
	}
});
