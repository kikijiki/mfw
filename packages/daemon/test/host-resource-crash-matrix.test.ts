import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { boot, type ProjectConfig } from "../src/boot.ts";
import { git } from "../src/git.ts";
import {
	acquireDaemonLock,
	HostResourceCoordinator,
	type HostResourceDefinition,
	HostStoreError,
	openHostResourceStore,
} from "../src/host-resources/index.ts";
import { silentLogger } from "../src/log.ts";
import type { AdmissionTransition } from "../src/project-dispatch-admission.ts";
import { HostProcessHarness } from "./support/host-resource-process-harness.ts";

const FORWARD_TRANSITIONS = [
	"resolving",
	"waiting_host",
	"host_granted",
	"prepared",
	"project_acquired",
	"host_active",
	"launched",
] satisfies AdmissionTransition[];

const DRIVER = `
const dir = process.argv[2];
const { appendFileSync } = await import("node:fs");
appendFileSync(dir + "/events.jsonl", JSON.stringify({
  ts: new Date().toISOString(), seq: 1, type: "hello", provider: "process-proof",
  capabilities: { steer: false }
}) + "\\n");
await Bun.sleep(60_000);
`;

let harness: HostProcessHarness;

beforeEach(async () => {
	harness = new HostProcessHarness();
	await harness.initialize();
});

afterEach(async () => {
	await harness.cleanup();
});

function definition(capacity = 1n): HostResourceDefinition {
	return {
		id: "gpu",
		accounting: "slot",
		provisioning: "static",
		capacity,
		enabled: true,
		draining: false,
		version: 1n,
	};
}

function projectConfig(name: string, root: string): ProjectConfig {
	return {
		name,
		root,
		integrationBranch: "main",
		maxConcurrent: 4,
		maxRepairs: 0,
		assistance: {
			failureDiagnosis: "escalate",
			conflictResolution: "escalate",
			changeReview: "human",
		},
	};
}

async function createProject(name: string): Promise<string> {
	const root = harness.path(`${name}-project`);
	await mkdir(join(root, ".mfw"), { recursive: true });
	await git(["init", "-q", "-b", "main"], root);
	await git(["config", "user.email", "process-proof@example.invalid"], root);
	await git(["config", "user.name", "process proof"], root);
	await writeFile(join(root, "README.md"), `# ${name}\n`);
	await writeFile(join(root, ".mfw", "AGENTS.md"), "bounded process proof\n");
	await git(["add", "-A"], root);
	await git(["commit", "-q", "-m", "fixture"], root);
	return root;
}

async function initializeAdmissionFixture(label: string) {
	const home = harness.path(`${label}-home`);
	harness.trackHome(home);
	const root = await createProject(label);
	const config = projectConfig(label, root);
	const driverPath = harness.path(`${label}-driver.ts`);
	await writeFile(driverPath, DRIVER);
	const orchestrator = await boot({
		projects: [config],
		mfwHome: home,
		autostart: false,
		kernelBootId: "kernel-a",
		log: silentLogger(),
	});
	try {
		await orchestrator.hostResources.putDefinition(definition());
		const service = orchestrator.get(label);
		await service.resources.register({ id: "serial", maxConcurrent: 1 });
		const task = await service.tasks.create({
			title: `crash proof ${label}`,
			requiresResources: ["serial", { scope: "host", id: "gpu", amount: 1 }],
		});
		await service.tasks.move(task.id, "ready", "human");
		return {
			home,
			root,
			config,
			driverPath,
			taskId: task.id,
			hostId: orchestrator.hostResources.hostId,
			coordinatorId: orchestrator.hostResources.coordinatorId,
		};
	} finally {
		await orchestrator.shutdown();
	}
}

async function waitForLockRelease(home: string): Promise<void> {
	const deadline = performance.now() + 5_000;
	for (;;) {
		try {
			const lock = await acquireDaemonLock(home, {
				processBootId: "restart-probe",
				timeoutMs: 100,
			});
			await lock.release();
			return;
		} catch {
			if (performance.now() >= deadline) {
				throw new Error("daemon lock remained held after SIGKILL");
			}
			await Bun.sleep(10);
		}
	}
}

type SerializedAudit = {
	seq: string;
	eventKey: string;
	action: string;
	leaseId: string | null;
};

type RecoveryResult = {
	error?: string;
	recovered: {
		bootId: string;
		started: { runId: string };
		host: {
			hostId: string;
			coordinatorId: string;
			waiters: Array<{ id: string; state: string }>;
			leases: Array<{
				id: string;
				waiterId: string;
				state: string;
				run: { runId: string } | null;
			}>;
			occupants: unknown[];
			effectiveCapacities: Array<{
				resourceId: string;
				durablePromises: string;
				effectiveCapacity: string;
			}>;
		};
		admissions: Array<{ id: string; runId: string; state: string }>;
		events: Array<{
			type: string;
			payload: { admissionId?: string; to?: string } | null;
		}>;
		slots: Array<{ runId: string }>;
		runs: Array<{ id: string; state: string }>;
		auditBeforeRun: SerializedAudit[];
	};
	finalHost: { leases: Array<{ id: string; state: string }> };
	finalAudit: SerializedAudit[];
};

describe("process death at each durable admission boundary", () => {
	for (const crashAt of FORWARD_TRANSITIONS) {
		test(`${crashAt}: restart compensates or adopts once, then preserves the full explanation`, async () => {
			const fixture = await initializeAdmissionFixture(crashAt);
			const crashed = await harness.spawn({
				mode: "crash-daemon",
				home: fixture.home,
				projects: [fixture.config],
				driverPath: fixture.driverPath,
				taskId: fixture.taskId,
				crashAt,
				kernelBootId: "kernel-a",
			});
			const boundary = await harness.waitReady<{
				transition: AdmissionTransition;
			}>(crashed.readyPath, 30_000);
			expect(boundary.transition).toBe(crashAt);
			await harness.kill(crashed.child);
			await waitForLockRelease(fixture.home);

			const restarted = await harness.spawn({
				mode: "recover-daemon",
				home: fixture.home,
				projects: [fixture.config],
				driverPath: fixture.driverPath,
				taskId: fixture.taskId,
				kernelBootId: "kernel-a",
			});
			const result = await harness.result<RecoveryResult>(
				restarted.resultPath,
				30_000,
			);
			expect(result.error).toBeUndefined();
			expect(await harness.exit(restarted.child, 30_000)).toBe(0);

			const { recovered } = result;
			expect(recovered.host.hostId).toBe(fixture.hostId);
			expect(recovered.host.coordinatorId).toBe(fixture.coordinatorId);
			expect(
				recovered.runs
					.filter((run) => run.state === "running")
					.map((run) => ({ id: run.id, state: run.state })),
			).toEqual([{ id: recovered.started.runId, state: "running" }]);
			expect(recovered.slots).toHaveLength(1);
			const active = recovered.host.leases.filter(
				(lease) => lease.state === "active",
			);
			expect(active).toHaveLength(1);
			expect(active[0]?.run?.runId).toBe(recovered.started.runId);
			expect(recovered.host.occupants).toEqual([]);
			expect(
				recovered.host.effectiveCapacities.find(
					(capacity) => capacity.resourceId === "gpu",
				),
			).toMatchObject({
				resourceId: "gpu",
				durablePromises: "1",
				effectiveCapacity: "0",
			});

			const winningAdmission = recovered.admissions.find(
				(row) => row.runId === recovered.started.runId,
			);
			if (!winningAdmission)
				throw new Error("winning admission was not readable");
			const transitions = recovered.events
				.filter(
					(event) =>
						event.type === "admission.state_changed" &&
						event.payload?.admissionId === winningAdmission.id,
				)
				.map((event) => event.payload?.to);
			expect(transitions).toEqual(FORWARD_TRANSITIONS);
			for (const waiter of recovered.host.waiters) {
				const lease = recovered.host.leases.find(
					(candidate) => candidate.waiterId === waiter.id,
				);
				expect(lease !== undefined || waiter.state === "cancelled").toBe(true);
			}

			const finalKeys = result.finalAudit.map((entry) => entry.eventKey);
			expect(new Set(finalKeys).size).toBe(finalKeys.length);
			expect(result.finalAudit.map((entry) => BigInt(entry.seq))).toEqual(
				[...result.finalAudit]
					.map((entry) => BigInt(entry.seq))
					.sort((a, b) => (a < b ? -1 : 1)),
			);
			for (const before of recovered.auditBeforeRun) {
				expect(finalKeys).toContain(before.eventKey);
			}
			for (const lease of recovered.host.leases) {
				expect(
					result.finalAudit.some((entry) => entry.leaseId === lease.id),
				).toBe(true);
			}
			expect(
				result.finalHost.leases.filter((lease) =>
					["provisional", "active", "uncertain", "releasing"].includes(
						lease.state,
					),
				),
			).toEqual([]);
		}, 60_000);
	}
});

describe("restart recovery evidence and guarded overrides", () => {
	test("detached/unavailable projects hold capacity; reboot and fresh absence reclaim once", async () => {
		const fixture = await initializeAdmissionFixture("detached");
		const store = await openHostResourceStore(fixture.home, {
			processBootId: "owner-a",
			kernelBootId: "kernel-a",
			now: () => 10_000,
		});
		const coordinator = await HostResourceCoordinator.create(store, {
			now: () => 10_000,
			liveness: {
				inspect: async () => ({
					status: "unavailable",
					checkedAt: 10_000,
					kernelBootId: "kernel-a",
					detail: "project database is temporarily unavailable",
				}),
			},
		});
		try {
			const waiter = await coordinator.putWaiter({
				requestKey: "detached/live",
				projectId: "detached-project",
				requirements: [{ resourceId: "gpu", amount: 1n }],
			});
			const grant = await coordinator.tryGrant(waiter.id, waiter.generation);
			if ("kind" in grant) throw new Error("detached fixture did not grant");
			await coordinator.activate(grant.id, grant.fence, {
				runId: "detached-run",
				runDir: "/synthetic/detached-run",
				pid: 999_999,
				processStartTime: "12345",
				kernelBootId: "kernel-a",
			});
			await coordinator.detachProject("detached-project");
			expect(await coordinator.reconcile("project_detached")).toMatchObject({
				uncertain: 1,
				reclaimed: 0,
			});
			expect(coordinator.readModel().leases[0]?.state).toBe("uncertain");
		} finally {
			await coordinator.shutdown();
		}

		const rebootedStore = await openHostResourceStore(fixture.home, {
			processBootId: "owner-b",
			kernelBootId: "kernel-b",
			now: () => -50_000,
		});
		let inspections = 0;
		const rebooted = await HostResourceCoordinator.create(rebootedStore, {
			now: () => -50_000,
			liveness: {
				inspect: async () => {
					inspections++;
					return {
						status: "live" as const,
						checkedAt: 500_000,
						kernelBootId: "kernel-b",
					};
				},
			},
		});
		try {
			expect(await rebooted.reconcile("startup")).toMatchObject({
				reclaimed: 1,
			});
			expect(inspections).toBe(0);
			expect(await rebooted.reconcile("manual")).toMatchObject({ examined: 0 });
			const audit = await rebooted.auditEntries({ limit: 1_000 });
			expect(
				audit.filter((entry) => entry.action === "lease.reclaimed"),
			).toHaveLength(1);
		} finally {
			await rebooted.shutdown();
		}
	});

	test("wall-clock skew cannot authorize force and current fences remain mandatory", async () => {
		const home = harness.path("force-home");
		harness.trackHome(home);
		let now = 20_000;
		const store = await openHostResourceStore(home, {
			processBootId: "force-owner",
			kernelBootId: "kernel-a",
			now: () => now,
		});
		await store.putDefinition(definition());
		const coordinator = await HostResourceCoordinator.create(store, {
			now: () => now,
			clockSkewMs: 100,
			livenessMaxAgeMs: 1_000,
			liveness: {
				inspect: async () => ({
					status: "absent",
					checkedAt: 20_000,
					kernelBootId: "kernel-a",
				}),
			},
		});
		try {
			const waiter = await coordinator.putWaiter({
				requestKey: "force/waiter",
				projectId: "force-project",
				requirements: [{ resourceId: "gpu", amount: 1n }],
			});
			const grant = await coordinator.tryGrant(waiter.id, waiter.generation);
			if ("kind" in grant) throw new Error("force fixture did not grant");
			now = 1_000;
			await expect(
				coordinator.forceRelease({
					leaseId: grant.id,
					expectedFence: grant.fence,
					actor: "operator",
					reason: "clock moved backwards",
				}),
			).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
			now = 20_000;
			await expect(
				coordinator.forceRelease({
					leaseId: grant.id,
					expectedFence: grant.fence + 1n,
					actor: "operator",
					reason: "stale override",
				}),
			).rejects.toBeInstanceOf(HostStoreError);
			expect(
				await coordinator.forceRelease({
					leaseId: grant.id,
					expectedFence: grant.fence,
					actor: "operator",
					reason: "fresh absence confirmed",
				}),
			).toBe(true);
			expect(
				await coordinator.forceRelease({
					leaseId: grant.id,
					expectedFence: grant.fence,
					actor: "operator",
					reason: "idempotent repeat",
				}),
			).toBe(false);
			const before = await coordinator.auditEntries({ limit: 1_000 });
			await coordinator.reconcile("manual");
			await coordinator.reconcile("manual");
			const after = await coordinator.auditEntries({ limit: 1_000 });
			expect(after).toEqual(before);
		} finally {
			await coordinator.shutdown();
		}
	});

	test("a temporarily unavailable project root is skipped without mutating the host audit", async () => {
		const fixture = await initializeAdmissionFixture("unavailable");
		const hidden = `${fixture.root}.offline`;
		await rename(fixture.root, hidden);
		try {
			const before = await openHostResourceStore(fixture.home, {
				processBootId: "audit-reader-a",
				kernelBootId: "kernel-a",
			});
			const auditKeys = (await before.auditEntries({ limit: 1_000 })).map(
				(entry) => entry.eventKey,
			);
			before.close();
			const unavailableBoot = await boot({
				projects: [fixture.config],
				mfwHome: fixture.home,
				autostart: false,
				kernelBootId: "kernel-a",
				log: silentLogger(),
			});
			try {
				expect(unavailableBoot.list()).toEqual([]);
				expect(
					(
						await unavailableBoot.hostResources.auditEntries({ limit: 1_000 })
					).map((entry) => entry.eventKey),
				).toEqual(auditKeys);
			} finally {
				await unavailableBoot.shutdown();
			}
		} finally {
			await rename(hidden, fixture.root);
		}
	});
});
