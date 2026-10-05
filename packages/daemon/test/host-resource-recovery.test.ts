import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Grant,
	type HostLease,
	HostResourceCoordinator,
	HostStoreError,
	type HostTransition,
	type LeaseLivenessInspector,
	type LivenessEvidence,
	openHostResourceStore,
	SystemLeaseLiveness,
} from "../src/host-resources/index.ts";

const homes: string[] = [];
afterEach(async () => {
	for (const path of homes.splice(0))
		await rm(path, { recursive: true, force: true });
});

async function home(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "mfw-host-recovery-"));
	homes.push(path);
	return path;
}

class FakeLiveness implements LeaseLivenessInspector {
	status: LivenessEvidence["status"] = "unavailable";
	checkedAt = 1_000;
	kernelBootId: string | null = "kernel-a";
	inspections = 0;

	async inspect(): Promise<LivenessEvidence> {
		this.inspections++;
		return {
			status: this.status,
			checkedAt: this.checkedAt,
			kernelBootId: this.kernelBootId,
		};
	}
}

async function openCoordinator(
	path: string,
	input: {
		process: string;
		kernel?: string | null;
		now?: () => number;
		liveness: LeaseLivenessInspector;
		afterTransition?: (transition: HostTransition, lease: HostLease) => void;
	},
) {
	const store = await openHostResourceStore(path, {
		processBootId: input.process,
		kernelBootId: input.kernel === undefined ? "kernel-a" : input.kernel,
		now: input.now,
	});
	return HostResourceCoordinator.create(store, {
		liveness: input.liveness,
		now: input.now,
		leaseMs: 100,
		livenessMaxAgeMs: 50,
		afterTransition: input.afterTransition,
	});
}

async function grant(
	c: HostResourceCoordinator,
	key: string = crypto.randomUUID(),
): Promise<Grant> {
	if (!c.readModel().definitions.some((d) => d.id === "gpu")) {
		await c.putDefinition({
			id: "gpu",
			accounting: "slot",
			provisioning: "static",
			capacity: 1n,
			enabled: true,
			draining: false,
			version: 1n,
		});
	}
	const waiter = await c.putWaiter({
		requestKey: key,
		projectId: "project-a",
		requirements: [{ resourceId: "gpu", amount: 1n }],
	});
	const result = await c.tryGrant(waiter.id, waiter.generation);
	if ("kind" in result) throw new Error(`grant held: ${result.reason}`);
	return result;
}

const run = {
	runId: "run-1",
	runDir: "/detached/project/.mfw/runs/run-1",
	sessionId: "mfw_run-1",
	pid: 123,
	processStartTime: "456",
	kernelBootId: "kernel-a",
};

describe("host resource recovery", () => {
	test("a live detached run is adopted on restart", async () => {
		const path = await home();
		const before = new FakeLiveness();
		let c = await openCoordinator(path, {
			process: "process-a",
			now: () => 1_000,
			liveness: before,
		});
		const provisional = await grant(c, "live-adopt");
		await c.activate(provisional.id, provisional.fence, run);
		c.close();

		const after = new FakeLiveness();
		after.status = "live";
		after.checkedAt = 1_010;
		c = await openCoordinator(path, {
			process: "process-b",
			now: () => 1_010,
			liveness: after,
		});
		const report = await c.reconcile("startup");
		expect(report.adopted).toBe(1);
		const adopted = await c.store.lease(provisional.id);
		expect(adopted?.state).toBe("active");
		expect(adopted?.ownerProcessBootId).toBe("process-b");
		c.close();
	});

	test("proven absence reclaims, but expiry or unavailable project state alone never does", async () => {
		const vanishedPath = await home();
		let clock = 1_000;
		let liveness = new FakeLiveness();
		let c = await openCoordinator(vanishedPath, {
			process: "a",
			now: () => clock,
			liveness,
		});
		const vanished = await grant(c, "vanished");
		await c.activate(vanished.id, vanished.fence, run);
		c.close();
		clock = 5_000; // well beyond the advisory renewal TTL
		liveness = new FakeLiveness();
		liveness.status = "absent";
		liveness.checkedAt = clock;
		c = await openCoordinator(vanishedPath, {
			process: "b",
			now: () => clock,
			liveness,
		});
		expect((await c.reconcile("startup")).reclaimed).toBe(1);
		expect((await c.store.lease(vanished.id))?.state).toBe("reclaimed");
		c.close();

		const unavailablePath = await home();
		clock = 1_000;
		liveness = new FakeLiveness();
		c = await openCoordinator(unavailablePath, {
			process: "a",
			now: () => clock,
			liveness,
		});
		const detached = await grant(c, "detached");
		await c.activate(detached.id, detached.fence, run);
		c.close();
		clock = 50_000;
		liveness = new FakeLiveness();
		liveness.status = "unavailable";
		liveness.checkedAt = clock;
		c = await openCoordinator(unavailablePath, {
			process: "b",
			now: () => clock,
			liveness,
		});
		expect((await c.reconcile("startup")).uncertain).toBe(1);
		expect((await c.store.lease(detached.id))?.state).toBe("uncertain");
		// Repeating recovery and moving the wall clock backwards still holds it.
		clock = 40_000;
		await c.reconcile("manual");
		expect((await c.store.lease(detached.id))?.state).toBe("uncertain");
		c.close();
	});

	test("changed kernel boot id proves old local processes died", async () => {
		const path = await home();
		let c = await openCoordinator(path, {
			process: "a",
			kernel: "kernel-a",
			now: () => 1_000,
			liveness: new FakeLiveness(),
		});
		const lease = await grant(c, "reboot");
		await c.activate(lease.id, lease.fence, run);
		c.close();
		const inaccessible = new FakeLiveness();
		inaccessible.status = "unavailable";
		c = await openCoordinator(path, {
			process: "b",
			kernel: "kernel-b",
			now: () => 2_000,
			liveness: inaccessible,
		});
		expect((await c.reconcile("startup")).reclaimed).toBe(1);
		expect(inaccessible.inspections).toBe(0);
		expect((await c.store.lease(lease.id))?.state).toBe("reclaimed");
		c.close();
	});

	test("system liveness proves process identity without signalling it", async () => {
		const stat = await readFile(`/proc/${process.pid}/stat`, "utf8");
		const startTime = stat
			.slice(stat.lastIndexOf(")") + 1)
			.trim()
			.split(/\s+/)[19] as string;
		const inspector = new SystemLeaseLiveness({ kernelBootId: "kernel-a" });
		const base: HostLease = {
			id: "lease",
			waiterId: "waiter",
			projectId: "project",
			state: "active",
			fence: 1n,
			allocations: [],
			run: {
				runId: "run",
				runDir: "/detached/run",
				pid: process.pid,
				processStartTime: startTime,
				kernelBootId: "kernel-a",
			},
			ownerProcessBootId: "old-process",
			grantedAt: 1,
			activatedAt: 1,
			lastRenewedAt: 1,
			expiresAt: 2,
			releaseReason: null,
		};
		const persistedRun = base.run;
		if (!persistedRun) throw new Error("test lease is missing run identity");
		expect((await inspector.inspect(base)).status).toBe("live");
		expect(
			(
				await inspector.inspect({
					...base,
					run: { ...persistedRun, processStartTime: `${startTime}-reused` },
				})
			).status,
		).toBe("absent");

		const tmuxLease = {
			...base,
			run: {
				runId: "run",
				runDir: "/detached/run",
				sessionId: "mfw_run",
				kernelBootId: "kernel-a",
			},
		};
		const tmuxLive = new SystemLeaseLiveness({
			kernelBootId: "kernel-a",
			sessions: { isAlive: async () => true },
		});
		const tmuxGone = new SystemLeaseLiveness({
			kernelBootId: "kernel-a",
			sessions: { isAlive: async () => false },
		});
		expect((await tmuxLive.inspect(tmuxLease)).status).toBe("live");
		expect((await tmuxGone.inspect(tmuxLease)).status).toBe("absent");
	});

	test("force release needs current fence, fresh conclusive liveness, actor and reason", async () => {
		const path = await home();
		let clock = 1_000;
		const liveness = new FakeLiveness();
		liveness.status = "live";
		liveness.checkedAt = clock;
		const c = await openCoordinator(path, {
			process: "a",
			now: () => clock,
			liveness,
		});
		const lease = await grant(c, "force");
		await c.activate(lease.id, lease.fence, run);
		await expect(
			c.forceRelease({
				leaseId: lease.id,
				expectedFence: lease.fence + 1n,
				actor: "operator@example",
				reason: "incident response",
			}),
		).rejects.toMatchObject({ code: "STALE_FENCE" });
		await expect(
			c.forceRelease({
				leaseId: lease.id,
				expectedFence: lease.fence,
				actor: "",
				reason: "incident response",
			}),
		).rejects.toBeInstanceOf(HostStoreError);
		clock = 2_000; // evidence is now stale
		await expect(
			c.forceRelease({
				leaseId: lease.id,
				expectedFence: lease.fence,
				actor: "operator@example",
				reason: "incident response",
			}),
		).rejects.toThrow("fresh conclusive");
		liveness.checkedAt = clock;
		expect(
			await c.forceRelease({
				leaseId: lease.id,
				expectedFence: lease.fence,
				actor: "operator@example",
				reason: "incident response",
			}),
		).toBe(true);
		expect((await c.store.lease(lease.id))?.state).toBe("force_released");
		c.close();
	});

	test("crashes after every durable transition recover without duplicate audit", async () => {
		const transitions: HostTransition[] = [
			"provisional",
			"active",
			"renewed",
			"releasing",
			"reclaimed",
		];
		for (const transition of transitions) {
			const path = await home();
			let clock = 1_000;
			const liveness = new FakeLiveness();
			liveness.checkedAt = clock;
			let armed = false;
			let c = await openCoordinator(path, {
				process: "before",
				kernel: "kernel-a",
				now: () => clock,
				liveness,
				afterTransition: (seen) => {
					if (armed && seen === transition)
						throw new Error(`crash after ${seen}`);
				},
			});
			if (!c.readModel().definitions.some((d) => d.id === "gpu")) {
				await c.putDefinition({
					id: "gpu",
					accounting: "slot",
					provisioning: "static",
					capacity: 1n,
					enabled: true,
					draining: false,
					version: 1n,
				});
			}
			const waiter = await c.putWaiter({
				requestKey: `crash-${transition}`,
				projectId: "project-a",
				requirements: [{ resourceId: "gpu", amount: 1n }],
			});
			armed = transition === "provisional";
			let lease: Grant;
			try {
				const result = await c.tryGrant(waiter.id, waiter.generation);
				if ("kind" in result) throw new Error("unexpected hold");
				lease = result;
			} catch (error) {
				if (transition !== "provisional") throw error;
				lease = (await c.store.liveLeases())[0] as Grant;
			}
			if (transition !== "provisional") {
				armed = transition === "active";
				try {
					await c.activate(lease.id, lease.fence, run);
				} catch (error) {
					if (transition !== "active") throw error;
				}
			}
			if (transition === "renewed") {
				armed = true;
				await expect(
					c.renewOrAdopt(lease.id, lease.fence, {
						...run,
						processBootId: "before",
						observedAt: ++clock,
					}),
				).rejects.toThrow("crash after renewed");
			}
			if (transition === "releasing") {
				armed = true;
				await expect(
					c.cancelOrRelease(lease.id, lease.fence, "normal finish"),
				).rejects.toThrow("crash after releasing");
			}
			if (transition === "reclaimed") {
				armed = false;
				c.close();
				c = await openCoordinator(path, {
					process: "after-reboot",
					kernel: "kernel-b",
					now: () => ++clock,
					liveness,
					afterTransition: (seen) => {
						if (seen === "reclaimed") throw new Error("crash after reclaimed");
					},
				});
				await expect(c.reconcile("startup")).rejects.toThrow(
					"crash after reclaimed",
				);
			}
			c.close();

			const recovery = new FakeLiveness();
			recovery.status =
				transition === "active" || transition === "renewed"
					? "live"
					: "unavailable";
			recovery.checkedAt = ++clock;
			c = await openCoordinator(path, {
				process: "recovery",
				kernel: transition === "reclaimed" ? "kernel-b" : "kernel-a",
				now: () => clock,
				liveness: recovery,
			});
			await c.reconcile("startup");
			await c.reconcile("manual");
			const recovered = await c.store.lease(lease.id);
			if (transition === "releasing") expect(recovered?.state).toBe("released");
			else if (transition === "reclaimed")
				expect(recovered?.state).toBe("reclaimed");
			else if (transition === "active" || transition === "renewed")
				expect(recovered?.state).toBe("active");
			else expect(recovered?.state).toBe("reclaimed");
			const audit = await c.store.auditEntries();
			expect(new Set(audit.map((entry) => entry.eventKey)).size).toBe(
				audit.length,
			);
			const terminal = audit.filter(
				(entry) =>
					entry.leaseId === lease.id &&
					entry.action === `lease.${recovered?.state}`,
			);
			expect(terminal.length).toBeLessThanOrEqual(1);
			c.close();
		}
	});
});
