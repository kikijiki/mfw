import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindContract } from "../../plugin-api/src/common.ts";
import {
	failures,
	runConformance,
} from "../../plugin-api/src/conformance/kit.ts";
import { FakeHost } from "../../plugin-api/src/fakes/fake-host.ts";
import { machineContract } from "../../plugin-api/src/machine.ts";
import { resourceContract } from "../../plugin-api/src/resource.ts";
import type { OpenRouterKeyUsage } from "../src/openrouter-client.ts";
import {
	type LocalHostConfig,
	type LocalHostFacts,
	type LocalHostLedgerView,
	LocalHostResource,
} from "../src/resources/builtin/local-host.ts";
import { OpenRouterResource } from "../src/resources/builtin/openrouter.ts";
import {
	RUNPOD_REQUEST_ATTRIBUTE,
	RunPodResource,
} from "../src/resources/builtin/runpod.ts";
import { MachineLifecycle } from "../src/resources/machines.ts";
import {
	openResourceStore,
	type ResourceStore,
} from "../src/resources/store.ts";
import type { ResourceLease } from "../src/resources/types.ts";
import { parseRunPodPod } from "../src/runpod-client.ts";
import { RUNPOD_OWNERSHIP_ENV } from "../src/runpod-ownership.ts";
import {
	FakeRunPodProvider,
	reconcilePolicy,
	reconcileRequest,
} from "./fixtures/runpod-account.ts";

const POOL = "runpod.reconcile-account";
const SSH_KEY = `ssh-ed25519 ${Buffer.alloc(32, 7).toString("base64")}`;
const shape = {
	units: 1,
	attributes: { [RUNPOD_REQUEST_ATTRIBUTE]: JSON.stringify(reconcileRequest) },
};

const GIB = 1024n ** 3n;
const facts = (over: Partial<LocalHostFacts> = {}): LocalHostFacts => ({
	cpu: { busyFraction: 0.1, runnableProcesses: 1 },
	memAvailableBytes: 12n * GIB,
	gpus: [
		{ unit: "gpu0", state: "idle", occupants: [], unexplainedDeviceUse: false },
	],
	...over,
});
const hostConfig: LocalHostConfig = {
	cpu: { permits: 8, maxBusyFraction: 0.5, maxRunnableProcesses: 16 },
	ram: { quotaMib: 16_384, safetyHeadroomMib: 2_048 },
	gpuUnits: ["gpu0"],
};
const emptyLedger: LocalHostLedgerView = {
	ramPromisedMib: 0,
	ramManagedBytes: 0n,
	managedProcesses: new Set(),
};
const localHost = (
	over: Partial<LocalHostFacts> = {},
	ledger: LocalHostLedgerView = emptyLedger,
) =>
	new LocalHostResource({
		config: hostConfig,
		probe: async () => facts(over),
		ledger: async () => ledger,
	});

const keyUsage = (
	over: Partial<OpenRouterKeyUsage> = {},
): OpenRouterKeyUsage => ({
	label: null,
	usage: 5,
	usageDaily: 1,
	usageWeekly: 2,
	usageMonthly: 3,
	byokUsage: 0,
	byokUsageDaily: 0,
	byokUsageWeekly: 0,
	byokUsageMonthly: 0,
	limit: 10,
	limitRemaining: 5,
	limitReset: null,
	includeByokInLimit: false,
	isFreeTier: false,
	isManagementKey: false,
	expiresAt: null,
	...over,
});

const runpod = (provider: FakeRunPodProvider, remoteEnabled = true) =>
	new RunPodResource({
		policy: reconcilePolicy,
		client: provider,
		remoteEnabled,
	});

describe("built-in resources pass the conformance kit", () => {
	test("local-host", async () => {
		const results = await runConformance("resource", {
			create: () => bindContract(resourceContract, localHost()),
		});
		expect(failures(results)).toEqual([]);
	});

	test("openrouter", async () => {
		const client = {
			credentialReady: async () => true,
			getCurrentKey: async () => keyUsage(),
			getCredits: async () => ({ totalCredits: 20, totalUsage: 5 }),
		};
		const results = await runConformance("resource", {
			create: () =>
				bindContract(
					resourceContract,
					new OpenRouterResource({ client, limits: { dailyUsd: 4 } }),
				),
		});
		expect(failures(results)).toEqual([]);
	});

	test("runpod, crash check included", async () => {
		const provider = new FakeRunPodProvider();
		const make = () => bindContract(machineContract, runpod(provider));
		const results = await runConformance("machine", {
			create: make,
			restart: make,
			machine: { poolId: POOL, shape },
		});
		expect(failures(results)).toEqual([]);
		expect(
			results.find(
				(r) =>
					r.name === "after a crash, inventory finds the object by its token",
			)?.status,
		).toBe("pass");
	});
});

describe("local-host", () => {
	const observe = (plugin: LocalHostResource, poolId: string) =>
		plugin.observe({ poolId }, new FakeHost().context());

	test("capacity comes from the owner's config, not installed memory", async () => {
		const pools = await localHost().discover({}, new FakeHost().context());
		expect(
			pools.find((p) => p.poolId === "local.ram")?.dimensions[0],
		).toMatchObject({ total: 16_384 });
		const none = new LocalHostResource({
			config: {},
			probe: async () => facts(),
			ledger: async () => emptyLedger,
		});
		expect(await none.discover({}, new FakeHost().context())).toEqual([]);
	});

	test("RAM follows the headroom formula and counts outstanding promises", async () => {
		// 12 GiB available - 2 GiB headroom - (4 GiB promised - 1 GiB resident) = 7 GiB.
		const seen = await observe(
			localHost(
				{},
				{
					ramPromisedMib: 4_096,
					ramManagedBytes: GIB,
					managedProcesses: new Set(),
				},
			),
			"local.ram",
		);
		expect(seen.dimensions[0]).toMatchObject({ total: 4_096 + 7 * 1_024 });
	});

	test("RAM below the safety headroom admits nothing new", async () => {
		const seen = await observe(
			localHost({ memAvailableBytes: GIB }),
			"local.ram",
		);
		expect(seen.health).toBe("degraded");
		expect(seen.dimensions[0]).toMatchObject({ total: 0 });
	});

	test("CPU pressure narrows permits to zero", async () => {
		const seen = await observe(
			localHost({ cpu: { busyFraction: 0.9, runnableProcesses: 1 } }),
			"local.cpu",
		);
		expect(seen.dimensions[0]).toMatchObject({ total: 0 });
	});

	test("a GPU process owned by a live lease does not block its unit", async () => {
		const gpus = [
			{
				unit: "gpu0",
				state: "occupied" as const,
				occupants: [{ pid: 42, processStartTime: "1000" }],
				unexplainedDeviceUse: false,
			},
		];
		const mine = await observe(
			localHost(
				{ gpus },
				{ ...emptyLedger, managedProcesses: new Set(["42:1000"]) },
			),
			"local.gpu",
		);
		expect(mine.dimensions[0]).toMatchObject({ occupied: [] });
		const reused = await observe(
			localHost(
				{ gpus },
				{ ...emptyLedger, managedProcesses: new Set(["42:999"]) },
			),
			"local.gpu",
		);
		expect(reused.dimensions[0]).toMatchObject({ occupied: ["gpu0"] });
	});

	test("unknown GPU state, unexplained use and a missing device all block", async () => {
		const base = { unit: "gpu0", occupants: [], unexplainedDeviceUse: false };
		for (const gpus of [
			[{ ...base, state: "unknown" as const }],
			[{ ...base, state: "idle" as const, unexplainedDeviceUse: true }],
			[],
		]) {
			const seen = await observe(localHost({ gpus }), "local.gpu");
			expect(seen.dimensions[0]).toMatchObject({ occupied: ["gpu0"] });
		}
	});

	test("an unavailable probe holds the pool instead of reading as free", async () => {
		for (const [over, pool] of [
			[{ cpu: null }, "local.cpu"],
			[{ memAvailableBytes: null }, "local.ram"],
			[{ gpus: null }, "local.gpu"],
		] as const) {
			expect((await observe(localHost(over), pool)).health).toBe("down");
		}
	});
});

describe("openrouter", () => {
	test("an unreadable key is down with unknown figures, never zero", async () => {
		const plugin = new OpenRouterResource({
			client: {
				credentialReady: async () => true,
				getCurrentKey: async () => {
					throw new Error("offline");
				},
				getCredits: async () => ({ totalCredits: 1, totalUsage: 0 }),
			},
			limits: { dailyUsd: 4 },
		});
		const seen = await plugin.observe(
			{ poolId: plugin.poolId },
			new FakeHost().context(),
		);
		expect(seen.health).toBe("down");
		expect(seen.dimensions).toContainEqual({
			kind: "window",
			name: "daily",
			settled: null,
			remaining: null,
		});
	});

	test("reports window spend and the credits fraction", async () => {
		const plugin = new OpenRouterResource({
			client: {
				credentialReady: async () => true,
				getCurrentKey: async () => keyUsage(),
				getCredits: async () => ({ totalCredits: 20, totalUsage: 5 }),
			},
			limits: { dailyUsd: 4 },
		});
		const seen = await plugin.observe(
			{ poolId: plugin.poolId },
			new FakeHost().context(),
		);
		expect(seen.dimensions).toContainEqual({
			kind: "window",
			name: "daily",
			settled: 1,
			remaining: 3,
		});
		expect(seen.dimensions).toContainEqual({
			kind: "meter",
			name: "credits",
			fraction: 0.25,
			resetsAt: null,
		});
	});
});

describe("runpod", () => {
	const provision = (plugin: RunPodResource, token: string) =>
		plugin.provision(
			{
				leaseId: "lease-1",
				poolId: POOL,
				shape,
				ownershipToken: token,
				sshPublicKey: SSH_KEY,
			},
			new FakeHost().context("prov"),
		);

	test("creation is refused unless the experimental switch is on", async () => {
		const provider = new FakeRunPodProvider();
		const result = await provision(
			runpod(provider, false),
			"mfw.token-0123456789",
		);
		expect(result.status).toBe("refused");
		expect(provider.creates).toBe(0);
	});

	test("teardown and inventory still work with the switch off", async () => {
		const provider = new FakeRunPodProvider();
		const token = "mfw.token-0123456789";
		const made = await provision(runpod(provider), token);
		if (made.status !== "created") throw new Error("expected a machine");
		const off = runpod(provider, false);
		const host = new FakeHost();
		expect((await off.inventory({ poolId: POOL }, host.context())).length).toBe(
			1,
		);
		await off.teardown(
			{ externalId: made.externalId, ownershipToken: token },
			host.context("tear"),
		);
		expect(await off.inventory({ poolId: POOL }, host.context())).toEqual([]);
	});

	test("a request outside the policy is refused before any create", async () => {
		const provider = new FakeRunPodProvider();
		const result = await runpod(provider).provision(
			{
				leaseId: "lease-1",
				poolId: POOL,
				shape: {
					units: 1,
					attributes: {
						[RUNPOD_REQUEST_ATTRIBUTE]: JSON.stringify({
							...reconcileRequest,
							image: "unlisted/image:1",
						}),
					},
				},
				ownershipToken: "mfw.token-0123456789",
				sshPublicKey: SSH_KEY,
			},
			new FakeHost().context(),
		);
		expect(result.status).toBe("refused");
		expect(provider.creates).toBe(0);
	});

	test("a foreign pod is never listed and narrows account capacity", async () => {
		const provider = new FakeRunPodProvider();
		provider.pods.push(
			parseRunPodPod({
				id: "foreign-1",
				name: "someone-elses",
				desiredStatus: "RUNNING",
				costPerHr: 1,
				adjustedCostPerHr: 1,
				env: { [RUNPOD_OWNERSHIP_ENV]: "v2:other-namespace:mfw.token-foreign" },
			}),
		);
		const plugin = runpod(provider);
		const host = new FakeHost();
		expect(await plugin.inventory({ poolId: POOL }, host.context())).toEqual(
			[],
		);
		const seen = await plugin.observe({ poolId: POOL }, host.context());
		expect(seen.dimensions).toContainEqual({
			kind: "quantity",
			name: "burn",
			total: reconcilePolicy.maxAggregateHourlyPrice - 1,
			used: 1,
		});
	});

	test("an unpriced foreign pod closes the burn dimension", async () => {
		const provider = new FakeRunPodProvider();
		provider.pods.push(
			parseRunPodPod({ id: "foreign-2", desiredStatus: "RUNNING", env: {} }),
		);
		const seen = await runpod(provider).observe(
			{ poolId: POOL },
			new FakeHost().context(),
		);
		expect(seen.health).toBe("degraded");
		expect(seen.dimensions[0]).toMatchObject({ total: 0, used: null });
	});
});

describe("machine lifecycle and cleanup records", () => {
	let home: string;
	let store: ResourceStore;
	let provider: FakeRunPodProvider;
	let host: FakeHost;
	let lifecycle: MachineLifecycle;

	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), "mfw-machine-lifecycle-"));
		store = await openResourceStore(home);
		provider = new FakeRunPodProvider();
		host = new FakeHost();
		const plugin = runpod(provider);
		const [proposal] = await plugin.discover({}, host.context());
		if (!proposal) throw new Error("expected a pool");
		await store.definePool({
			id: proposal.poolId,
			title: proposal.title,
			dimensions: proposal.dimensions,
		});
		lifecycle = new MachineLifecycle(store, plugin, host);
	});

	afterEach(async () => {
		store.close();
		await rm(home, { recursive: true, force: true });
	});

	async function grant(key: string): Promise<ResourceLease> {
		const waiter = await store.putWaiter({
			requestKey: key,
			projectId: "p",
			claims: [
				{ poolId: POOL, dimension: "burn", amount: 1 },
				{ poolId: POOL, dimension: "pods", amount: 1 },
			],
		});
		const lease = await store.tryGrant(waiter.id);
		if ("kind" in lease) throw new Error("expected a grant");
		return lease;
	}

	test("the record exists before provision and survives a crash there", async () => {
		const lease = await grant("crash-before-create");
		provider.createPod = async () => {
			expect(await store.openCleanups(POOL)).toHaveLength(1);
			throw new Error("connection lost");
		};
		await expect(
			lifecycle.provision({
				lease,
				poolId: POOL,
				shape,
				sshPublicKey: SSH_KEY,
			}),
		).rejects.toThrow();
		// Nothing landed, so inventory proved absence and closed the record.
		expect(await store.openCleanups(POOL)).toEqual([]);
	});

	test("an ambiguous create that landed is bound by inventory", async () => {
		const lease = await grant("ambiguous");
		const real = provider.createPod.bind(provider);
		provider.createPod = async (input) => {
			await real(input);
			throw new Error("reply lost");
		};
		const made = await lifecycle.provision({
			lease,
			poolId: POOL,
			shape,
			sshPublicKey: SSH_KEY,
		});
		expect(made.externalId).toBe("created-1");
		expect((await store.openCleanups(POOL))[0]?.externalId).toBe("created-1");
	});

	test("a lease cannot be released while its machine may exist", async () => {
		const lease = await grant("release-guard");
		const made = await lifecycle.provision({
			lease,
			poolId: POOL,
			shape,
			sshPublicKey: SSH_KEY,
		});
		await store.activate(lease.id, lease.fence, "run-1", 60_000);
		await expect(store.finishRelease(lease.id, lease.fence)).rejects.toThrow(
			/open cleanup/,
		);
		expect(await lifecycle.teardown(made.ownershipToken)).toBe(true);
		expect(await store.finishRelease(lease.id, lease.fence)).toBe(true);
	});

	test("a teardown that did not take stays open", async () => {
		const lease = await grant("lying-teardown");
		const made = await lifecycle.provision({
			lease,
			poolId: POOL,
			shape,
			sshPublicKey: SSH_KEY,
		});
		provider.retainDeletes = true;
		expect(await lifecycle.teardown(made.ownershipToken)).toBe(false);
		expect(await store.openCleanups(POOL)).toHaveLength(1);
		await expect(
			store.closeCleanup(
				made.ownershipToken,
				await provider
					.listPods()
					.then((pods) =>
						pods.map((p) => ({ externalId: p.id, ownershipToken: null })),
					),
			),
		).rejects.toThrow(/still lists/);
	});

	test("reconcile after a crash tears down a machine whose lease ended", async () => {
		const lease = await grant("crash-recovery");
		await lifecycle.provision({
			lease,
			poolId: POOL,
			shape,
			sshPublicKey: SSH_KEY,
		});
		await store.forceRelease(lease.id, lease.fence, "owner", "daemon crashed");
		const restarted = new MachineLifecycle(store, runpod(provider), host);
		const report = await restarted.reconcile(POOL);
		expect(report.tornDown).toBe(1);
		expect(provider.pods).toEqual([]);
		expect(await store.openCleanups(POOL)).toEqual([]);
	});

	test("reconcile keeps every record when the provider is unreachable", async () => {
		const lease = await grant("provider-down");
		await lifecycle.provision({
			lease,
			poolId: POOL,
			shape,
			sshPublicKey: SSH_KEY,
		});
		provider.listFailure = new Error("offline");
		await expect(lifecycle.reconcile(POOL)).rejects.toThrow("offline");
		expect(await store.openCleanups(POOL)).toHaveLength(1);
	});

	test("reconcile never deletes an object it has no record for", async () => {
		provider.pods.push(
			parseRunPodPod({
				id: "unrecorded-1",
				desiredStatus: "RUNNING",
				costPerHr: 0.5,
				env: {
					[RUNPOD_OWNERSHIP_ENV]: `v2:${reconcilePolicy.ownershipNamespace}:mfw.token-lost-record`,
				},
			}),
		);
		const report = await lifecycle.reconcile(POOL);
		expect(report.unrecorded).toEqual(["unrecorded-1"]);
		expect(provider.deletes).toEqual([]);
	});

	test("a reconcile of a dead lease reclaims only after cleanup closes", async () => {
		const lease = await grant("reclaim-guard");
		const made = await lifecycle.provision({
			lease,
			poolId: POOL,
			shape,
			sshPublicKey: SSH_KEY,
		});
		await store.activate(lease.id, lease.fence, "run-2", 60_000);
		const first = await store.reconcile(async () => "absent");
		expect(first.reclaimed).toBe(0);
		expect((await store.lease(lease.id))?.state).toBe("uncertain");
		await lifecycle.teardown(made.ownershipToken);
		const second = await store.reconcile(async () => "absent");
		expect(second.reclaimed).toBe(1);
	});
});
