import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "@mfw/db/ids";
import { dispatchAdmissions, events, resourceSlots } from "@mfw/db/schema";
import { boot, type ProjectConfig } from "../src/boot.ts";
import { git } from "../src/git.ts";
import type { HostResourceDefinition } from "../src/host-resources/index.ts";
import { RAM_OBSERVATION_MAX_AGE_MS } from "../src/host-resources/index.ts";
import { silentLogger } from "../src/log.ts";
import {
	AdmissionCompensationPendingError,
	AdmissionHeldError,
	type AdmissionTransition,
	InjectedAdmissionCrashError,
} from "../src/project-dispatch-admission.ts";
import type { ProjectServices } from "../src/services.ts";
import { TaskOwnershipHeldError } from "../src/tasks/index.ts";

const roots: string[] = [];
const orchestrators: Awaited<ReturnType<typeof boot>>[] = [];

afterEach(async () => {
	for (const orchestrator of orchestrators.splice(0).reverse()) {
		await orchestrator.shutdown().catch(() => {});
	}
	for (const root of roots.splice(0).reverse()) {
		await rm(root, { recursive: true, force: true });
	}
});

const DRIVER = `
const dir = process.argv[2];
const { appendFileSync } = await import("node:fs");
appendFileSync(dir + "/events.jsonl", JSON.stringify({
  ts: new Date().toISOString(), seq: 1, type: "hello", provider: "test",
  capabilities: { steer: false }
}) + "\\n");
await Bun.sleep(1000);
process.exit(0);
`;

async function repo(name: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), `mfw-admission-${name}-`));
	roots.push(root);
	await git(["init", "-q", "-b", "main"], root);
	await git(["config", "user.email", "test@example.com"], root);
	await git(["config", "user.name", "test"], root);
	await writeFile(join(root, "README.md"), `# ${name}\n`);
	await mkdir(join(root, ".mfw"), { recursive: true });
	await writeFile(join(root, ".mfw/AGENTS.md"), "test rules\n");
	await git(["add", "-A"], root);
	await git(["commit", "-q", "-m", "init"], root);
	return root;
}

function config(name: string, root: string): ProjectConfig {
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

function useDriver(service: ProjectServices, path: string) {
	const adapters = (
		service.engine as unknown as {
			deps: {
				adapters: {
					driverOverride: string | null;
					buildArgv: (() => string[]) | null;
				};
			};
		}
	).deps.adapters;
	adapters.driverOverride = path;
	adapters.buildArgv = () => ["true"];
}

async function startFixture(
	projectNames: string[],
	afterTransition?: (transition: AdmissionTransition) => void,
) {
	const home = await mkdtemp(join(tmpdir(), "mfw-admission-home-"));
	roots.push(home);
	const driverDir = await mkdtemp(join(tmpdir(), "mfw-admission-driver-"));
	roots.push(driverDir);
	const driver = join(driverDir, "driver.ts");
	await writeFile(driver, DRIVER);
	const projects = await Promise.all(
		projectNames.map(async (name) => config(name, await repo(name))),
	);
	const orchestrator = await boot({
		projects,
		mfwHome: home,
		autostart: false,
		log: silentLogger(),
		afterAdmissionTransition: afterTransition
			? (transition) => afterTransition(transition)
			: undefined,
	});
	orchestrators.push(orchestrator);
	for (const service of orchestrator.list()) useDriver(service, driver);
	return orchestrator;
}

function slotDefinition(
	id: string,
	capacity = 1n,
	provisioning: "static" | "dynamic" = "static",
): HostResourceDefinition {
	return {
		id,
		accounting: "slot",
		provisioning,
		capacity,
		enabled: true,
		draining: false,
		version: 1n,
	};
}

function ramDefinition(
	capacity: bigint,
	safetyHeadroom: bigint,
): HostResourceDefinition {
	return {
		id: "ram",
		accounting: "quantity",
		quantityUnit: "bytes",
		capacity,
		safetyHeadroom,
		provisioning: "static",
		enabled: true,
		draining: false,
		version: 1n,
		observationKind: "linux-memory",
	};
}

async function memoryHealth(
	orchestrator: Awaited<ReturnType<typeof boot>>,
	sequence: bigint,
	memAvailableBytes: bigint,
) {
	const model = orchestrator.hostResources.readModel();
	const checkedAt = Date.now();
	await orchestrator.hostResources.observations.recordHealth({
		kind: "linux-memory",
		result: "ok",
		checkedAt,
		processBootId: model.processBootId,
		kernelBootId: model.kernelBootId,
		detail: {
			generation: {
				processBootId: model.processBootId,
				kernelBootId: model.kernelBootId,
				sequence: sequence.toString(),
			},
			freshness: {
				state: "fresh",
				checkedAt: new Date(checkedAt).toISOString(),
				expiresAt: new Date(
					checkedAt + RAM_OBSERVATION_MAX_AGE_MS,
				).toISOString(),
			},
			latest: {
				memTotalBytes: (32n << 30n).toString(),
				memAvailableBytes: memAvailableBytes.toString(),
				swapTotalBytes: "0",
				swapFreeBytes: "0",
				scope: "host",
			},
		},
	});
}

async function hostTask(service: ProjectServices, title: string) {
	const task = await service.tasks.create({
		title,
		requiresResources: ["serial", { scope: "host", id: "gpu", amount: 1 }],
	});
	await service.tasks.move(task.id, "ready", "human");
	return task;
}

async function admissions(service: ProjectServices) {
	return service.handle.db.select().from(dispatchAdmissions);
}

function projectSlotOwner(service: ProjectServices) {
	return (
		service.admission as unknown as {
			deps: {
				projectSlots: {
					release(runId: string): Promise<number>;
				};
			};
		}
	).deps.projectSlots;
}

describe("project-to-host task admission", () => {
	test("two projects share exact RAM quota/headroom without partial local acquisition", async () => {
		const orchestrator = await startFixture(["alpha", "beta"]);
		const GiB = 1n << 30n;
		await orchestrator.hostResources.putDefinition(
			ramDefinition(20n * GiB, 2n * GiB),
		);
		await memoryHealth(orchestrator, 1n, 12n * GiB);
		const services = [orchestrator.get("alpha"), orchestrator.get("beta")];
		for (const service of services) {
			await service.resources.register({ id: "serial", maxConcurrent: 1 });
			const task = await service.tasks.create({
				title: `${service.name} RAM task`,
				requiresResources: [
					"serial",
					{ scope: "host", id: "ram", amount: "6 GiB" },
				],
			});
			await service.tasks.move(task.id, "ready", "human");
		}
		const stats = await Promise.all(
			services.map((service) => service.scheduler.tick()),
		);
		expect(stats.flatMap((item) => item.started)).toHaveLength(1);
		const lease = orchestrator.hostResources
			.readModel()
			.leases.find((item) => item.state === "active");
		expect(lease?.allocations).toEqual([
			{ resourceId: "ram", bindingId: null, amount: 6n * GiB },
		]);
		const winner = stats.findIndex((item) => item.started.length === 1);
		const loser = services[winner === 0 ? 1 : 0] as ProjectServices;
		await loser.scheduler.tick();
		expect((await admissions(loser))[0]).toMatchObject({
			state: "waiting_host",
			holdCode: "headroom-exhausted",
		});
		expect(await loser.handle.db.select().from(resourceSlots)).toEqual([]);
		const heldBefore = (await loser.handle.db.select().from(events)).filter(
			(event) => event.type === "task.held_for_resource",
		).length;
		await loser.scheduler.tick();
		const heldAfter = (await loser.handle.db.select().from(events)).filter(
			(event) => event.type === "task.held_for_resource",
		).length;
		expect(heldAfter).toBe(heldBefore);
	});

	test("accounting/unit mismatches hold before claim or durable host allocation", async () => {
		const orchestrator = await startFixture(["demo"]);
		const service = orchestrator.get("demo");
		await orchestrator.hostResources.putDefinition(slotDefinition("gpu"));
		await orchestrator.hostResources.putDefinition(
			ramDefinition(16n << 30n, 2n << 30n),
		);
		await memoryHealth(orchestrator, 1n, 20n << 30n);
		for (const [title, requirement] of [
			["quantity on slot", { scope: "host", id: "gpu", amount: "1 GiB" }],
			["slot on bytes", { scope: "host", id: "ram", amount: 1 }],
			["implicit RAM amount", { scope: "host", id: "ram" }],
		] as const) {
			const task = await service.tasks.create({
				title,
				requiresResources: [requirement],
			});
			await service.tasks.move(task.id, "ready", "human");
			await expect(service.engine.startTask(task.id)).rejects.toMatchObject({
				code: "invalid_amount",
			});
			expect(await service.registry.list({ taskId: task.id })).toEqual([]);
		}
		expect(
			orchestrator.hostResources
				.readModel()
				.leases.filter((lease) => lease.state !== "released"),
		).toEqual([]);
	});

	test("post-admission RAM pressure raises one inbox incident and never kills the run", async () => {
		const orchestrator = await startFixture(["demo"]);
		const GiB = 1n << 30n;
		await orchestrator.hostResources.putDefinition(
			ramDefinition(16n * GiB, 4n * GiB),
		);
		await memoryHealth(orchestrator, 1n, 20n * GiB);
		const service = orchestrator.get("demo");
		const task = await service.tasks.create({
			title: "RAM pressure survivor",
			requiresResources: [{ scope: "host", id: "ram", amount: "8 GiB" }],
		});
		await service.tasks.move(task.id, "ready", "human");
		const started = await service.engine.startTask(task.id);
		await memoryHealth(orchestrator, 2n, 6n * GiB);
		await memoryHealth(orchestrator, 3n, 5n * GiB);
		const health = await service.health.snapshot();
		expect(health.admission).toMatchObject({
			hostIncidents: [{ key: "ram-low-headroom:ram", state: "open" }],
		});
		const inbox = (await service.inbox.list()).filter(
			(item) => item.id === "admission:host:ram-low-headroom:ram",
		);
		expect(inbox).toHaveLength(1);
		expect(inbox[0]?.detail).toContain("observed=");
		expect((await service.registry.get(started.runId))?.state).toBe("running");
		expect(
			orchestrator.hostResources
				.readModel()
				.leases.find((lease) => lease.run?.runId === started.runId)?.state,
		).toBe("active");

		await memoryHealth(orchestrator, 4n, 20n * GiB);
		expect(
			(await service.inbox.list()).some(
				(item) => item.id === "admission:host:ram-low-headroom:ram",
			),
		).toBe(false);
		expect((await service.registry.get(started.runId))?.state).toBe("running");
	});

	test("capacity one admits exactly one holder across two projects and keeps bare ids local", async () => {
		const orchestrator = await startFixture(["alpha", "beta"]);
		await orchestrator.hostResources.putDefinition(slotDefinition("gpu"));
		const alpha = orchestrator.get("alpha");
		const beta = orchestrator.get("beta");
		await Promise.all([
			alpha.resources.register({ id: "serial", maxConcurrent: 1 }),
			beta.resources.register({ id: "serial", maxConcurrent: 1 }),
		]);
		await Promise.all([
			hostTask(alpha, "alpha task"),
			hostTask(beta, "beta task"),
		]);

		const stats = await Promise.all([
			alpha.scheduler.tick(),
			beta.scheduler.tick(),
		]);
		expect(stats.flatMap((item) => item.started)).toHaveLength(1);
		expect(
			orchestrator.hostResources
				.readModel()
				.leases.filter((lease) => lease.state === "active"),
		).toHaveLength(1);
		expect(
			(await alpha.handle.db.select().from(resourceSlots)).length +
				(await beta.handle.db.select().from(resourceSlots)).length,
		).toBe(1);

		const winnerIndex = stats.findIndex((item) => item.started.length === 1);
		const waiting = winnerIndex === 0 ? beta : alpha;
		// A concurrent generation retry may legitimately change the first hold
		// reason. Once settled at capacity, unchanged ticks must remain silent.
		await waiting.scheduler.tick();
		const heldBefore = (await waiting.handle.db.select().from(events)).filter(
			(event) => event.type === "task.held_for_resource",
		).length;
		await waiting.scheduler.tick();
		const heldAfter = (await waiting.handle.db.select().from(events)).filter(
			(event) => event.type === "task.held_for_resource",
		).length;
		expect(heldAfter).toBe(heldBefore);

		await orchestrator.hostResources.putDefinition(slotDefinition("gpu", 2n));
		expect((await waiting.scheduler.tick()).started).toHaveLength(1);
		expect(
			orchestrator.hostResources
				.readModel()
				.leases.filter((lease) => lease.state === "active"),
		).toHaveLength(2);
	});

	for (const crashAt of [
		"resolving",
		"waiting_host",
		"host_granted",
		"prepared",
		"project_acquired",
		"host_active",
		"launched",
	] satisfies AdmissionTransition[]) {
		test(`retry after a crash at ${crashAt} neither leaks nor double-launches`, async () => {
			let boundary: AdmissionTransition | null = crashAt;
			const orchestrator = await startFixture(["demo"], (transition) => {
				if (transition !== boundary) return;
				boundary = null;
				throw new Error(`crash at ${transition}`);
			});
			await orchestrator.hostResources.putDefinition(slotDefinition("gpu"));
			const service = orchestrator.get("demo");
			await service.resources.register({ id: "serial", maxConcurrent: 1 });
			const task = await hostTask(service, `crash ${crashAt}`);

			await expect(service.engine.startTask(task.id)).rejects.toBeInstanceOf(
				InjectedAdmissionCrashError,
			);
			const started = await service.engine.startTask(task.id);
			expect(
				(await service.registry.list({ taskId: task.id })).map((run) => run.id),
			).toEqual([started.runId]);
			expect(await service.scheduler.heldSlots(started.runId)).toHaveLength(1);
			expect(
				orchestrator.hostResources
					.readModel()
					.leases.filter((lease) =>
						["provisional", "active", "uncertain", "releasing"].includes(
							lease.state,
						),
					),
			).toHaveLength(1);
		});
	}

	test("unknown, dynamic, and quantity-shaped host requirements fail closed before claim", async () => {
		const orchestrator = await startFixture(["demo"]);
		const service = orchestrator.get("demo");
		await orchestrator.hostResources.putDefinition(
			slotDefinition("dynamic-gpu", 1n, "dynamic"),
		);
		const inputs = [
			{ id: "missing", amount: 1 },
			{ id: "dynamic-gpu", amount: 1 },
			{ id: "dynamic-gpu", amount: "8 GiB" },
		] as const;
		for (const [index, requirement] of inputs.entries()) {
			const task = await service.tasks.create({
				title: `invalid ${index}`,
				requiresResources: [{ scope: "host", ...requirement }],
			});
			await service.tasks.move(task.id, "ready", "human");
			await expect(service.engine.startTask(task.id)).rejects.toBeInstanceOf(
				AdmissionHeldError,
			);
			expect(await service.registry.list({ taskId: task.id })).toEqual([]);
		}
		expect(
			orchestrator.hostResources
				.readModel()
				.leases.filter((lease) => lease.state !== "released"),
		).toEqual([]);
		expect(await service.admission.issues()).toHaveLength(3);
	});

	test("manual Run uses the same admission fence while retaining queue-policy bypass", async () => {
		const orchestrator = await startFixture(["demo"]);
		await orchestrator.hostResources.putDefinition(slotDefinition("gpu"));
		const service = orchestrator.get("demo");
		await service.resources.register({ id: "serial", maxConcurrent: 1 });
		const task = await hostTask(service, "manual");
		await service.scheduler.setEnabled(false, "operator pause");

		const { runId } = await service.engine.startTask(task.id, {
			actor: "human",
		});
		expect(await service.scheduler.heldSlots(runId)).toHaveLength(1);
		expect(
			orchestrator.hostResources
				.readModel()
				.leases.find((lease) => lease.run?.runId === runId)?.state,
		).toBe("active");
	});

	test("concurrent manual ownership claims reject one start and compensate its host grant", async () => {
		const orchestrator = await startFixture(["demo"]);
		await orchestrator.hostResources.putDefinition(slotDefinition("gpu", 2n));
		const service = orchestrator.get("demo");
		const first = await service.tasks.create({
			title: "first owner",
			status: "ready",
			owns: ["src/shared/**"],
			requiresResources: [{ scope: "host", id: "gpu" }],
		});
		const second = await service.tasks.create({
			title: "second owner",
			status: "ready",
			owns: ["src/shared/file.ts"],
			requiresResources: [{ scope: "host", id: "gpu" }],
		});
		const results = await Promise.allSettled([
			service.engine.startTask(first.id, { actor: "human" }),
			service.engine.startTask(second.id, { actor: "human" }),
		]);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		const failure = results.find((r) => r.status === "rejected");
		expect(failure?.status === "rejected" && failure.reason).toBeInstanceOf(
			TaskOwnershipHeldError,
		);
		const rows = await admissions(service);
		expect(rows.map((row) => row.state).sort()).toEqual(["failed", "launched"]);
		const failed = rows.find((row) => row.state === "failed");
		if (!failed) throw new Error("missing rejected admission");
		expect((await service.tasks.get(failed.taskId))?.claimedByRunId).toBeNull();
		expect(await service.registry.list({ taskId: failed.taskId })).toEqual([]);
		expect(
			orchestrator.hostResources
				.readModel()
				.leases.filter((lease) => lease.state !== "released"),
		).toHaveLength(1);
	});

	test("launch failure compensates host and project grants in reverse order", async () => {
		const orchestrator = await startFixture(["demo"]);
		await orchestrator.hostResources.putDefinition(slotDefinition("gpu"));
		const service = orchestrator.get("demo");
		await service.resources.register({ id: "serial", maxConcurrent: 1 });
		const task = await hostTask(service, "launch failure");
		const originalLaunch = service.engine.launchPreparedRun.bind(
			service.engine,
		);
		service.engine.launchPreparedRun = async () => {
			throw new Error("injected launch failure");
		};

		await expect(service.engine.startTask(task.id)).rejects.toThrow(
			"injected launch failure",
		);
		service.engine.launchPreparedRun = originalLaunch;
		expect(
			orchestrator.hostResources
				.readModel()
				.leases.filter((lease) => lease.state !== "released"),
		).toEqual([]);
		expect(await service.handle.db.select().from(resourceSlots)).toEqual([]);
		expect((await service.registry.list({ taskId: task.id }))[0]?.outcome).toBe(
			"start_failed",
		);
		expect((await service.tasks.get(task.id))?.claimedByRunId).toBeNull();
		expect((await service.tasks.get(task.id))?.status).toBe("ready");
	});

	test("host-release failure leaves compensation open and retains project capacity", async () => {
		const orchestrator = await startFixture(["demo"]);
		await orchestrator.hostResources.putDefinition(slotDefinition("gpu"));
		const service = orchestrator.get("demo");
		await service.resources.register({ id: "serial", maxConcurrent: 1 });
		const task = await hostTask(service, "host release failure");
		const originalLaunch = service.engine.launchPreparedRun.bind(
			service.engine,
		);
		const originalCancel = orchestrator.hostResources.cancelOrRelease.bind(
			orchestrator.hostResources,
		);
		let failLaunch = true;
		service.engine.launchPreparedRun = async (prepared) => {
			if (failLaunch) {
				failLaunch = false;
				throw new Error("trigger compensation");
			}
			return originalLaunch(prepared);
		};
		orchestrator.hostResources.cancelOrRelease = async () => {
			throw new Error("injected host release failure");
		};

		await expect(service.engine.startTask(task.id)).rejects.toBeInstanceOf(
			AdmissionCompensationPendingError,
		);
		expect((await admissions(service))[0]?.state).toBe("compensating");
		expect(await service.handle.db.select().from(resourceSlots)).toHaveLength(
			1,
		);
		expect((await service.tasks.get(task.id))?.claimedByRunId).not.toBeNull();
		expect(
			orchestrator.hostResources
				.readModel()
				.leases.some((lease) => lease.state === "active"),
		).toBe(true);
		expect((await service.health.snapshot()).admission).toMatchObject({
			hostDispatchReady: false,
		});
		const projectOnly = await service.tasks.create({ title: "project only" });
		await service.tasks.move(projectOnly.id, "ready", "human");
		await expect(
			service.engine.startTask(projectOnly.id),
		).resolves.toHaveProperty("runId");
		const fencedHost = await service.tasks.create({
			title: "host dispatch stays fenced",
			requiresResources: [{ scope: "host", id: "gpu", amount: 1 }],
		});
		await service.tasks.move(fencedHost.id, "ready", "human");
		await expect(service.engine.startTask(fencedHost.id)).rejects.toMatchObject(
			{
				code: "reconciliation",
			},
		);
		expect(await service.registry.list({ taskId: fencedHost.id })).toEqual([]);

		orchestrator.hostResources.cancelOrRelease = originalCancel;
		service.engine.launchPreparedRun = originalLaunch;
		await service.admission.reconcile();
		expect((await admissions(service))[0]?.state).toBe("failed");
		expect(await service.handle.db.select().from(resourceSlots)).toEqual([]);
		expect((await service.tasks.get(task.id))?.claimedByRunId).toBeNull();
		await expect(
			service.engine.startTask(fencedHost.id),
		).resolves.toHaveProperty("runId");
	});

	test("waiter-cancel failure remains retryable and never claims the task", async () => {
		const orchestrator = await startFixture(["demo"]);
		await orchestrator.hostResources.putDefinition(slotDefinition("gpu"));
		const service = orchestrator.get("demo");
		const holder = await hostTask(service, "holder");
		await service.engine.startTask(holder.id);
		const waiting = await hostTask(service, "waiting cancellation");
		await expect(service.engine.startTask(waiting.id)).rejects.toBeInstanceOf(
			AdmissionHeldError,
		);
		const originalCancel = orchestrator.hostResources.cancelOrRelease.bind(
			orchestrator.hostResources,
		);
		orchestrator.hostResources.cancelOrRelease = async () => {
			throw new Error("injected waiter cancel failure");
		};

		await expect(
			service.admission.syncEligibleTasks([holder.id]),
		).rejects.toBeInstanceOf(AdmissionCompensationPendingError);
		const row = (await admissions(service)).find(
			(item) => item.taskId === waiting.id,
		);
		expect(row?.state).toBe("compensating");
		expect((await service.tasks.get(waiting.id))?.claimedByRunId).toBeNull();
		expect(
			orchestrator.hostResources
				.readModel()
				.waiters.find((item) => item.id === row?.waiterId)?.state,
		).toBe("waiting");

		orchestrator.hostResources.cancelOrRelease = originalCancel;
		await service.admission.reconcile();
		expect(
			(await admissions(service)).find((item) => item.taskId === waiting.id)
				?.state,
		).toBe("cancelled");
	});

	test("project-slot release failure stays open after host release, then retries", async () => {
		const orchestrator = await startFixture(["demo"]);
		await orchestrator.hostResources.putDefinition(slotDefinition("gpu"));
		const service = orchestrator.get("demo");
		await service.resources.register({ id: "serial", maxConcurrent: 1 });
		const task = await hostTask(service, "project release failure");
		const slots = projectSlotOwner(service);
		const originalRelease = slots.release.bind(slots);
		const originalLaunch = service.engine.launchPreparedRun.bind(
			service.engine,
		);
		slots.release = async () => {
			throw new Error("injected project release failure");
		};
		service.engine.launchPreparedRun = async () => {
			throw new Error("trigger compensation");
		};

		await expect(service.engine.startTask(task.id)).rejects.toBeInstanceOf(
			AdmissionCompensationPendingError,
		);
		expect((await admissions(service))[0]?.state).toBe("compensating");
		expect(await service.handle.db.select().from(resourceSlots)).toHaveLength(
			1,
		);
		expect(
			orchestrator.hostResources
				.readModel()
				.leases.every((lease) => lease.state === "released"),
		).toBe(true);

		slots.release = originalRelease;
		service.engine.launchPreparedRun = originalLaunch;
		await service.admission.reconcile();
		expect((await admissions(service))[0]?.state).toBe("failed");
		expect(await service.handle.db.select().from(resourceSlots)).toEqual([]);
	});

	test("claim-abort failure stays open after both resource layers release", async () => {
		const orchestrator = await startFixture(["demo"]);
		await orchestrator.hostResources.putDefinition(slotDefinition("gpu"));
		const service = orchestrator.get("demo");
		await service.resources.register({ id: "serial", maxConcurrent: 1 });
		const task = await hostTask(service, "claim abort failure");
		const originalLaunch = service.engine.launchPreparedRun.bind(
			service.engine,
		);
		const originalAbort = service.engine.abortPreparedTaskRun.bind(
			service.engine,
		);
		service.engine.launchPreparedRun = async () => {
			throw new Error("trigger compensation");
		};
		service.engine.abortPreparedTaskRun = async () => {
			throw new Error("injected claim abort failure");
		};

		await expect(service.engine.startTask(task.id)).rejects.toBeInstanceOf(
			AdmissionCompensationPendingError,
		);
		expect((await admissions(service))[0]?.state).toBe("compensating");
		expect(await service.handle.db.select().from(resourceSlots)).toEqual([]);
		expect((await service.tasks.get(task.id))?.claimedByRunId).not.toBeNull();
		expect(
			orchestrator.hostResources
				.readModel()
				.leases.every((lease) => lease.state === "released"),
		).toBe(true);

		service.engine.abortPreparedTaskRun = originalAbort;
		service.engine.launchPreparedRun = originalLaunch;
		await service.admission.reconcile();
		expect((await admissions(service))[0]?.state).toBe("failed");
		expect((await service.tasks.get(task.id))?.claimedByRunId).toBeNull();
	});

	test("unrelated cleanup cannot reopen dispatch after renewal becomes uncertain", async () => {
		const orchestrator = await startFixture(["demo"]);
		await orchestrator.hostResources.putDefinition(slotDefinition("gpu", 2n));
		const service = orchestrator.get("demo");
		const liveTask = await service.tasks.create({
			title: "uncertain renewal owner",
			requiresResources: [{ scope: "host", id: "gpu", amount: 1 }],
		});
		await service.tasks.move(liveTask.id, "ready", "human");
		const live = await service.engine.startTask(liveTask.id);
		const cleanupTask = await service.tasks.create({
			title: "unrelated cleanup",
			requiresResources: [{ scope: "host", id: "gpu", amount: 1 }],
		});
		await service.tasks.move(cleanupTask.id, "ready", "human");
		const cleanup = await service.engine.startTask(cleanupTask.id);
		const originalRenew = orchestrator.hostResources.renewOrAdopt.bind(
			orchestrator.hostResources,
		);
		orchestrator.hostResources.renewOrAdopt = async () => {
			throw new Error("injected renewal uncertainty");
		};

		await expect(service.admission.renewRun(live.runId)).rejects.toThrow(
			"injected renewal uncertainty",
		);
		expect((await service.health.snapshot()).admission).toMatchObject({
			hostDispatchReady: false,
		});
		expect(
			(await admissions(service)).find((row) => row.runId === live.runId)
				?.holdCode,
		).toBe("renewal_uncertain");

		await service.host.kill(
			service.registry.runDir(cleanup.runId),
			cleanup.runId,
			"test cleanup",
		);
		await service.registry.recordExit(cleanup.runId, {
			outcome: "interrupted",
		});
		await service.admission.releaseRun(cleanup.runId, "unrelated run ended");
		expect((await service.health.snapshot()).admission).toMatchObject({
			hostDispatchReady: false,
		});

		orchestrator.hostResources.renewOrAdopt = originalRenew;
		await service.admission.renewRun(live.runId);
		expect((await service.health.snapshot()).admission).toMatchObject({
			hostDispatchReady: true,
		});
		expect(
			(await admissions(service)).find((row) => row.runId === live.runId)
				?.holdCode,
		).toBeNull();
	});

	test("restart retries an unfinished compensation before host dispatch reopens", async () => {
		const first = await startFixture(["demo"]);
		await first.hostResources.putDefinition(slotDefinition("gpu"));
		const before = first.get("demo");
		await before.resources.register({ id: "serial", maxConcurrent: 1 });
		const task = await hostTask(before, "restart cleanup retry");
		const slots = projectSlotOwner(before);
		slots.release = async () => {
			throw new Error("injected project release failure");
		};
		before.engine.launchPreparedRun = async () => {
			throw new Error("trigger compensation");
		};
		await expect(before.engine.startTask(task.id)).rejects.toBeInstanceOf(
			AdmissionCompensationPendingError,
		);
		expect((await admissions(before))[0]?.state).toBe("compensating");
		const home = first.mfwHome;
		const root = before.root;
		await first.shutdown();

		const restarted = await boot({
			projects: [config("demo", root)],
			mfwHome: home,
			autostart: false,
			log: silentLogger(),
		});
		orchestrators.push(restarted);
		const after = restarted.get("demo");
		expect((await admissions(after))[0]?.state).toBe("failed");
		expect(await after.handle.db.select().from(resourceSlots)).toEqual([]);
		expect((await after.tasks.get(task.id))?.claimedByRunId).toBeNull();
		expect((await after.health.snapshot()).admission).toMatchObject({
			hostDispatchReady: true,
		});
	});

	test("repair lineage releases the parent fence and reacquires capacity for the child", async () => {
		const orchestrator = await startFixture(["demo"]);
		await orchestrator.hostResources.putDefinition(slotDefinition("gpu"));
		const service = orchestrator.get("demo");
		await service.resources.register({ id: "serial", maxConcurrent: 1 });
		const task = await hostTask(service, "repair lineage");
		const parent = await service.engine.startTask(task.id);
		const childRunId = ulid();

		await service.engine.startRepair(parent.runId, childRunId);

		const leases = orchestrator.hostResources.readModel().leases;
		expect(
			leases.find((lease) => lease.run?.runId === parent.runId)?.state,
		).toBe("released");
		expect(leases.find((lease) => lease.run?.runId === childRunId)?.state).toBe(
			"active",
		);
		expect(await service.scheduler.heldSlots(parent.runId)).toEqual([]);
		expect(await service.scheduler.heldSlots(childRunId)).toHaveLength(1);
		expect((await service.tasks.get(task.id))?.claimedByRunId).toBe(childRunId);
	});

	test("restart compensates an activated pre-launch lease before dispatch resumes", async () => {
		let boundary: AdmissionTransition | null = "host_active";
		const first = await startFixture(["demo"], (transition) => {
			if (transition !== boundary) return;
			boundary = null;
			throw new Error("daemon crashed before launch");
		});
		await first.hostResources.putDefinition(slotDefinition("gpu"));
		const before = first.get("demo");
		await before.resources.register({ id: "serial", maxConcurrent: 1 });
		const task = await hostTask(before, "restart compensation");
		await expect(before.engine.startTask(task.id)).rejects.toBeInstanceOf(
			InjectedAdmissionCrashError,
		);
		const home = first.mfwHome;
		const root = before.root;
		await first.shutdown();

		const restarted = await boot({
			projects: [config("demo", root)],
			mfwHome: home,
			autostart: false,
			log: silentLogger(),
		});
		orchestrators.push(restarted);
		const after = restarted.get("demo");
		expect(
			restarted.hostResources
				.readModel()
				.leases.filter((lease) =>
					["provisional", "active", "uncertain", "releasing"].includes(
						lease.state,
					),
				),
		).toEqual([]);
		expect(await after.handle.db.select().from(resourceSlots)).toEqual([]);
		expect((await after.registry.list({ taskId: task.id }))[0]?.outcome).toBe(
			"start_failed",
		);
	});

	test("restart adopts a demonstrably live launched run and its fence", async () => {
		let boundary: AdmissionTransition | null = "launched";
		const first = await startFixture(["demo"], (transition) => {
			if (transition !== boundary) return;
			boundary = null;
			throw new Error("daemon crashed after launch");
		});
		await first.hostResources.putDefinition(slotDefinition("gpu"));
		const before = first.get("demo");
		await before.resources.register({ id: "serial", maxConcurrent: 1 });
		const task = await hostTask(before, "restart adoption");
		await expect(before.engine.startTask(task.id)).rejects.toBeInstanceOf(
			InjectedAdmissionCrashError,
		);
		const run = (await before.registry.list({ taskId: task.id }))[0];
		expect(run?.state).toBe("running");
		await before.handle.db.delete(resourceSlots);
		expect(await before.handle.db.select().from(resourceSlots)).toEqual([]);
		const home = first.mfwHome;
		const root = before.root;
		await first.shutdown();

		const restarted = await boot({
			projects: [config("demo", root)],
			mfwHome: home,
			autostart: false,
			log: silentLogger(),
		});
		orchestrators.push(restarted);
		const lease = restarted.hostResources
			.readModel()
			.leases.find((item) => item.run?.runId === run?.id);
		expect(lease?.state).toBe("active");
		expect(lease?.ownerProcessBootId).toBe(restarted.bootId);
		expect(
			await restarted.get("demo").scheduler.heldSlots(run?.id ?? ""),
		).toHaveLength(1);
	});
});
