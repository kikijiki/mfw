import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";
import type {
	ExecutionOwnership,
	ProviderLeaseIntent,
} from "../src/execution-target.ts";
import { silentLogger } from "../src/log.ts";
import {
	RunPodAccountService,
	type RunPodProviderClient,
} from "../src/runpod-account-service.ts";
import {
	parseRunPodPod,
	type RunPodCreateInput,
	type RunPodPod,
} from "../src/runpod-client.ts";
import {
	encodeRunPodOwnership,
	makeRunPodOwnership,
	RUNPOD_OWNERSHIP_ENV,
} from "../src/runpod-ownership.ts";
import {
	type EnabledRunPodMachinePolicy,
	effectiveRunPodPolicy,
	enforceRunPodAccountCaps,
	enforceRunPodRequest,
	RunPodMachinePolicySchema,
	type RunPodPlacementRequest,
	RunPodPlacementRequestSchema,
	RunPodPolicyError,
	runPodShapeViolations,
} from "../src/runpod-policy.ts";

const homes: string[] = [];

afterEach(async () => {
	for (const home of homes.splice(0)) {
		await rm(home, { recursive: true, force: true });
	}
});

const machinePolicy: EnabledRunPodMachinePolicy = {
	enabled: true,
	accountId: "test-account",
	ownershipNamespace: "mfw-test-namespace",
	sshProxyAccountSuffix: "6441103b",
	sshHostPublicKey: `ssh-ed25519 ${Buffer.alloc(32, 7).toString("base64")}`,
	allowedGpuTypes: ["NVIDIA H100 80GB HBM3", "NVIDIA A40"],
	allowedCpuFlavors: ["cpu3m", "cpu5m"],
	allowedImages: ["safe/image:1"],
	allowedClouds: ["SECURE"],
	maxHourlyPrice: 2,
	maxGpuCount: 4,
	maxConcurrentPods: 2,
	maxAggregateHourlyPrice: 3,
	maxRuntimeMinutes: 60,
	maxRunSpend: 2,
};

function gpuRequest(gpuCount = 1): RunPodPlacementRequest {
	return RunPodPlacementRequestSchema.parse({
		computeType: "GPU",
		gpuTypeId: "NVIDIA H100 80GB HBM3",
		gpuCount,
		image: "safe/image:1",
		cloud: "SECURE",
		maxHourlyPrice: 1,
		maxRuntimeMinutes: 30,
		maxSpend: 1,
	});
}

function cpuRequest(
	flavor: "cpu3m" | "cpu5m" = "cpu5m",
): RunPodPlacementRequest {
	return RunPodPlacementRequestSchema.parse({
		computeType: "CPU",
		cpuFlavorId: flavor,
		vcpuCount: 16,
		memoryInGb: 128,
		image: "safe/image:1",
		cloud: "SECURE",
		maxHourlyPrice: 1,
		maxRuntimeMinutes: 30,
		maxSpend: 1,
	});
}

function owner(runId: string, projectId = "project-a"): ExecutionOwnership {
	return {
		projectId,
		projectName: projectId,
		runId,
		taskId: "MFW-test",
		attempt: 1,
		ownerKey: `${projectId}/${runId}/1`,
	};
}

function intent(
	runId: string,
	request: RunPodPlacementRequest,
	projectId = "project-a",
): ProviderLeaseIntent {
	return {
		operationId: `${projectId}/${runId}/1/prepare`,
		targetKind: "runpod",
		owner: owner(runId, projectId),
		requestedShape: request,
	};
}

class InventoryProvider implements RunPodProviderClient {
	pods: RunPodPod[] = [];
	creates = 0;
	deletes = 0;
	deleteError = false;
	createErrorAfterEffect = false;
	createErrorWithoutEffect = false;
	listError = false;
	hiddenListCalls = 0;
	price = 0.75;
	beforeCreate?: () => Promise<void>;
	beforeList?: () => Promise<void>;
	beforeDelete?: () => Promise<void>;

	async credentialReady(): Promise<boolean> {
		return true;
	}

	async getAccountBalance(): Promise<{ remainingCredits: number }> {
		return { remainingCredits: 100 };
	}

	async listPods(): Promise<RunPodPod[]> {
		await this.beforeList?.();
		if (this.listError) throw new Error("inventory unavailable");
		if (this.hiddenListCalls > 0) {
			this.hiddenListCalls--;
			return [];
		}
		return [...this.pods];
	}

	async createPod(input: RunPodCreateInput): Promise<RunPodPod> {
		const envNames = Object.keys(input.createEnv).sort();
		if (
			envNames.join(",") !==
				[RUNPOD_OWNERSHIP_ENV, "SSH_PUBLIC_KEY", "PUBLIC_KEY"]
					.sort()
					.join(",") ||
			input.createEnv.PUBLIC_KEY !== input.createEnv.SSH_PUBLIC_KEY
		) {
			throw new Error("provider received an unsafe create environment");
		}
		await this.beforeCreate?.();
		this.creates++;
		if (this.createErrorWithoutEffect)
			throw new Error("ambiguous network failure");
		const request = input.request;
		const pod = parseRunPodPod({
			id: `pod-${this.creates}`,
			// Deliberately non-unique: ownership is the env metadata, never this.
			name: "same-name",
			desiredStatus: "RUNNING",
			image: request.image,
			costPerHr: this.price,
			env: input.createEnv,
			cloudType: request.cloud,
			...(request.computeType === "GPU"
				? {
						gpu: { id: request.gpuTypeId, count: request.gpuCount },
						machine: {
							gpuTypeId: request.gpuTypeId,
							secureCloud: request.cloud === "SECURE",
						},
					}
				: {
						cpuFlavorId: request.cpuFlavorId,
						vcpuCount: request.vcpuCount,
						memoryInGb: request.memoryInGb,
						machine: { secureCloud: request.cloud === "SECURE" },
					}),
		});
		this.pods.push(pod);
		if (this.createErrorAfterEffect)
			throw new Error("response lost after create");
		return pod;
	}

	async deletePod(podId: string): Promise<void> {
		await this.beforeDelete?.();
		this.deletes++;
		if (this.deleteError) throw new Error("delete unavailable");
		this.pods = this.pods.filter((pod) => pod.id !== podId);
	}
}

async function service(
	provider: InventoryProvider,
	policy: EnabledRunPodMachinePolicy = machinePolicy,
	existingHome?: string,
): Promise<RunPodAccountService> {
	const home =
		existingHome ?? (await mkdtemp(join(tmpdir(), "mfw-runpod-test-")));
	if (!existingHome) homes.push(home);
	return new RunPodAccountService({
		mfwHome: home,
		policy,
		client: provider,
		log: silentLogger(),
		absenceAttempts: 2,
		absenceDelayMs: 1,
	});
}

async function seedCreateOperation(
	account: RunPodAccountService,
	leaseRef: string,
	request: RunPodPlacementRequest,
	state: "intent" | "submitted",
): Promise<{
	createOperationId: string;
	ownershipEncoded: string;
	sshPublicKey: string;
}> {
	const db = createClient({ url: `file:${account.dbPath}` });
	const lease = await db.execute({
		sql: "SELECT create_operation_id, ownership_json, ssh_public_key FROM leases WHERE ref = ?",
		args: [leaseRef],
	});
	const createOperationId = String(lease.rows[0]?.create_operation_id);
	const ownershipEncoded = String(lease.rows[0]?.ownership_json);
	const sshPublicKey = String(lease.rows[0]?.ssh_public_key);
	const now = Date.now();
	await db.execute({
		sql: `INSERT INTO operations
			(operation_id, lease_ref, kind, state, request_json, created_at, updated_at)
			VALUES (?, ?, 'create', ?, ?, ?, ?)`,
		args: [
			createOperationId,
			leaseRef,
			state,
			JSON.stringify({
				computeType: request.computeType,
				image: request.image,
				cloud: request.cloud,
				maxHourlyPrice: request.maxHourlyPrice,
			}),
			now,
			now,
		],
	});
	db.close();
	return { createOperationId, ownershipEncoded, sshPublicKey };
}

describe("RunPod policy", () => {
	test("enabled machine policy requires finite spend limits and validates legacy shape limits", () => {
		expect(() =>
			RunPodMachinePolicySchema.parse({
				...machinePolicy,
				maxHourlyPrice: Number.POSITIVE_INFINITY,
			}),
		).toThrow();
		expect(() =>
			RunPodMachinePolicySchema.parse({
				...machinePolicy,
				maxGpuCount: 1.5,
			}),
		).toThrow();
	});

	test("new machine and project policy are unrestricted by provider shape unless explicitly narrowed", () => {
		const unrestrictedMachine: EnabledRunPodMachinePolicy = {
			enabled: true,
			accountId: "unrestricted-account",
			ownershipNamespace: "mfw:unrestricted-account",
			maxHourlyPrice: 10,
			maxAggregateHourlyPrice: 20,
			maxRuntimeMinutes: 240,
			maxRunSpend: 20,
		};
		const effective = effectiveRunPodPolicy(unrestrictedMachine, {
			enabled: true,
		});
		expect(effective.allowedGpuTypes).toBeNull();
		expect(effective.allowedCpuFlavors).toBeNull();
		expect(effective.allowedImages).toBeNull();
		expect(effective.allowedClouds).toBeNull();
		expect(effective.maxGpuCount).toBeNull();
		expect(effective.maxConcurrentPods).toBeNull();
		expect(() =>
			enforceRunPodRequest(
				RunPodPlacementRequestSchema.parse({
					computeType: "GPU",
					gpuTypeId: "provider-future-gpu",
					gpuCount: 64,
					image: "provider/future-image:1",
					cloud: "COMMUNITY",
					maxHourlyPrice: 9,
					maxRuntimeMinutes: 30,
					maxSpend: 9,
				}),
				effective,
			),
		).not.toThrow();

		const explicitEmpty = effectiveRunPodPolicy(unrestrictedMachine, {
			enabled: true,
			allowedImages: [],
		});
		expect(() => enforceRunPodRequest(gpuRequest(), explicitEmpty)).toThrow(
			"image: not allowed",
		);
	});

	test("project and task policy can narrow but never widen machine choices", () => {
		const effective = effectiveRunPodPolicy(machinePolicy, {
			enabled: true,
			allowedGpuTypes: ["NVIDIA A40"],
			allowedCpuFlavors: ["cpu3m"],
			allowedImages: ["safe/image:1"],
			allowedClouds: ["SECURE"],
			maxHourlyPrice: 1,
			maxGpuCount: 1,
			maxConcurrentPods: 1,
			maxRuntimeMinutes: 30,
			maxRunSpend: 1,
		});
		expect(() => enforceRunPodRequest(gpuRequest(), effective)).toThrow(
			RunPodPolicyError,
		);
		expect(() =>
			effectiveRunPodPolicy(machinePolicy, {
				enabled: true,
				allowedGpuTypes: ["NVIDIA B200"],
			}),
		).toThrow("machine-disallowed");
	});

	test("two 8x H100 escalation attempts under a lower hard cap create nothing", async () => {
		const provider = new InventoryProvider();
		const account = await service(provider);
		await expect(
			account.putLeaseIntent(intent("run-1", gpuRequest(8))),
		).rejects.toThrow("gpuCount");
		await expect(
			account.putLeaseIntent(intent("run-2", gpuRequest(8), "project-b")),
		).rejects.toThrow("gpuCount");
		expect(provider.creates).toBe(0);
		expect(provider.pods).toHaveLength(0);
		await account.stop();
	});

	test("memory-optimized CPU placement is first-class and has exactly zero GPUs", () => {
		const policy = effectiveRunPodPolicy(machinePolicy);
		for (const flavor of ["cpu3m", "cpu5m"] as const) {
			const request = enforceRunPodRequest(cpuRequest(flavor), policy);
			expect(request.computeType).toBe("CPU");
			expect(
				runPodShapeViolations(request, {
					computeType: "CPU",
					offeringId: flavor,
					gpuCount: 0,
					image: request.image,
					cloud: request.cloud,
					hourlyPrice: 0.9,
					vcpuCount: 16,
					memoryInGb: 128,
				}),
			).toEqual([]);
		}
	});

	test("unknown live prices fail closed and account burn is independent of project caps", () => {
		const policy = effectiveRunPodPolicy(machinePolicy);
		expect(() =>
			enforceRunPodAccountCaps(
				[{ id: "unknown", hourlyPrice: null }],
				cpuRequest(),
				policy,
			),
		).toThrow("trustworthy hourly price");
		expect(() =>
			enforceRunPodAccountCaps(
				[
					{ id: "a", hourlyPrice: 1.1 },
					{ id: "b", hourlyPrice: 1.1 },
				],
				cpuRequest(),
				policy,
			),
		).toThrow(RunPodPolicyError);
	});
});

describe("RunPod live-first account service", () => {
	test("serial concurrent duplicate provisioning adopts one Pod and creates once", async () => {
		const provider = new InventoryProvider();
		const account = await service(provider);
		const first = await account.putLeaseIntent(
			intent("same-run", gpuRequest()),
		);
		const duplicate = await account.putLeaseIntent(
			intent("same-run", gpuRequest()),
		);
		expect(duplicate.ref).toBe(first.ref);
		const [a, b] = await Promise.all([
			account.command(first.ref, "provision-a", { type: "provision" }),
			account.command(first.ref, "provision-b", { type: "provision" }),
		]);
		expect(provider.creates).toBe(1);
		expect(provider.pods).toHaveLength(1);
		expect(a.observedShape?.providerPodId).toBe("pod-1");
		expect(b.observedShape?.providerPodId).toBe("pod-1");
		expect(account.gate.status().open).toBe(true);
		await account.stop();
	});

	test("two account-service instances cannot race around the machine cap", async () => {
		const provider = new InventoryProvider();
		const home = await mkdtemp(join(tmpdir(), "mfw-runpod-two-process-"));
		homes.push(home);
		const onePodPolicy = { ...machinePolicy, maxConcurrentPods: 1 };
		const accountA = await service(provider, onePodPolicy, home);
		const accountB = await service(provider, onePodPolicy, home);
		const leaseA = await accountA.putLeaseIntent(
			intent("process-a", gpuRequest(), "project-a"),
		);
		const leaseB = await accountB.putLeaseIntent(
			intent("process-b", gpuRequest(), "project-b"),
		);
		const results = await Promise.allSettled([
			accountA.command(leaseA.ref, "provision-a", { type: "provision" }),
			accountB.command(leaseB.ref, "provision-b", { type: "provision" }),
		]);
		expect(
			results.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		expect(
			results.filter((result) => result.status === "rejected"),
		).toHaveLength(1);
		expect(provider.creates).toBe(1);
		expect(provider.pods).toHaveLength(1);
		await accountA.stop();
		await accountB.stop();
	});

	test("adopts the unique Pod after a lost create response without retrying", async () => {
		const provider = new InventoryProvider();
		provider.createErrorAfterEffect = true;
		const account = await service(provider);
		const lease = await account.putLeaseIntent(
			intent("lost-response", cpuRequest()),
		);
		const provisioned = await account.command(lease.ref, "provision", {
			type: "provision",
		});
		expect(provider.creates).toBe(1);
		expect(provisioned.observedShape).toMatchObject({
			computeType: "CPU",
			gpuCount: 0,
			offeringId: "cpu5m",
			verified: true,
		});
		await account.stop();
	});

	test("restart before the submitted boundary may make exactly one create call", async () => {
		const provider = new InventoryProvider();
		const home = await mkdtemp(join(tmpdir(), "mfw-runpod-before-submit-"));
		homes.push(home);
		const beforeCrash = await service(provider, machinePolicy, home);
		const request = gpuRequest();
		const lease = await beforeCrash.putLeaseIntent(
			intent("before-submit", request),
		);
		await seedCreateOperation(beforeCrash, lease.ref, request, "intent");
		await beforeCrash.stop();

		const restarted = await service(provider, machinePolicy, home);
		await restarted.command(lease.ref, "after-restart", {
			type: "provision",
		});
		expect(provider.creates).toBe(1);
		expect(provider.pods).toHaveLength(1);
		await restarted.stop();
	});

	test("rechecks lowered current policy before creating a persisted intent", async () => {
		const provider = new InventoryProvider();
		const home = await mkdtemp(join(tmpdir(), "mfw-runpod-lowered-intent-"));
		homes.push(home);
		const original = await service(provider, machinePolicy, home);
		const lease = await original.putLeaseIntent(
			intent("lowered-before-create", gpuRequest(2)),
		);
		await original.stop();

		const restarted = await service(
			provider,
			{ ...machinePolicy, maxGpuCount: 1 },
			home,
		);
		await expect(
			restarted.command(lease.ref, "must-recheck", { type: "provision" }),
		).rejects.toMatchObject({ code: "request_exceeds_policy" });
		expect(provider.creates).toBe(0);
		await restarted.stop();
	});

	test("commits submitted durably before entering the provider client", async () => {
		const provider = new InventoryProvider();
		const account = await service(provider);
		const lease = await account.putLeaseIntent(
			intent("submitted-is-durable", gpuRequest()),
		);
		let stateAtCall: unknown = null;
		provider.beforeCreate = async () => {
			const db = createClient({ url: `file:${account.dbPath}` });
			const operation = await db.execute({
				sql: "SELECT state FROM operations WHERE lease_ref = ? AND kind = 'create'",
				args: [lease.ref],
			});
			stateAtCall = operation.rows[0]?.state;
			db.close();
		};
		await account.command(lease.ref, "provision", { type: "provision" });
		expect(stateAtCall).toBe("submitted");
		expect(provider.creates).toBe(1);
		await account.stop();
	});

	test("restart after submission but before the call wedges without creating", async () => {
		const provider = new InventoryProvider();
		const home = await mkdtemp(join(tmpdir(), "mfw-runpod-after-submit-"));
		homes.push(home);
		const beforeCrash = await service(provider, machinePolicy, home);
		const request = gpuRequest();
		const lease = await beforeCrash.putLeaseIntent(
			intent("after-submit", request),
		);
		await seedCreateOperation(beforeCrash, lease.ref, request, "submitted");
		await beforeCrash.stop();

		const restarted = await service(provider, machinePolicy, home);
		await expect(
			restarted.command(lease.ref, "after-restart", { type: "provision" }),
		).rejects.toMatchObject({ code: "ambiguous_create" });
		expect(provider.creates).toBe(0);
		expect(restarted.gate.status().open).toBe(false);
		await restarted.stop();
	});

	test("restart after submission retains missing or partial SSH evidence and never regenerates", async () => {
		for (const damage of ["partial", "missing"] as const) {
			const provider = new InventoryProvider();
			const home = await mkdtemp(join(tmpdir(), `mfw-runpod-key-${damage}-`));
			homes.push(home);
			const beforeCrash = await service(provider, machinePolicy, home);
			const request = gpuRequest();
			const lease = await beforeCrash.putLeaseIntent(
				intent(`submitted-key-${damage}`, request),
			);
			await seedCreateOperation(beforeCrash, lease.ref, request, "submitted");
			const db = createClient({ url: `file:${beforeCrash.dbPath}` });
			const stored = await db.execute({
				sql: "SELECT ssh_private_key_path FROM leases WHERE ref = ?",
				args: [lease.ref],
			});
			const privatePath = String(stored.rows[0]?.ssh_private_key_path);
			db.close();
			await beforeCrash.stop();
			await rm(`${privatePath}.pub`, { force: true });
			if (damage === "missing") await rm(privatePath, { force: true });

			const restarted = await service(provider, machinePolicy, home);
			await expect(
				restarted.command(lease.ref, "post-submission", { type: "provision" }),
			).rejects.toMatchObject({ code: "ssh_bootstrap_invalid" });
			expect(provider.creates).toBe(0);
			expect(await Bun.file(`${privatePath}.pub`).exists()).toBe(false);
			expect(await Bun.file(privatePath).exists()).toBe(damage === "partial");
			await restarted.stop();
		}
	});

	test("restart after provider commit remains ambiguous through visibility lag, then adopts without duplication", async () => {
		const provider = new InventoryProvider();
		const home = await mkdtemp(join(tmpdir(), "mfw-runpod-after-commit-"));
		homes.push(home);
		const beforeCrash = await service(provider, machinePolicy, home);
		const request = cpuRequest();
		const lease = await beforeCrash.putLeaseIntent(
			intent("after-provider-commit", request),
		);
		const seeded = await seedCreateOperation(
			beforeCrash,
			lease.ref,
			request,
			"submitted",
		);
		await provider.createPod({
			name: "provider-committed",
			request,
			createEnv: {
				[RUNPOD_OWNERSHIP_ENV]: seeded.ownershipEncoded,
				SSH_PUBLIC_KEY: seeded.sshPublicKey,
				PUBLIC_KEY: seeded.sshPublicKey,
			},
		});
		await beforeCrash.stop();

		const restarted = await service(provider, machinePolicy, home);
		provider.hiddenListCalls = 1;
		await restarted.start();
		expect(restarted.gate.status().open).toBe(false);
		expect(provider.creates).toBe(1);

		await restarted.reconcile("provider-visible");
		expect(restarted.gate.status().open).toBe(true);
		const adopted = await restarted.command(lease.ref, "after-restart", {
			type: "provision",
		});
		expect(provider.creates).toBe(1);
		expect(provider.pods).toHaveLength(1);
		expect(adopted.observedShape?.providerPodId).toBe("pod-1");
		expect(restarted.gate.status().open).toBe(true);
		await restarted.stop();
	});

	test("ordinary account-service shutdown hands a live Pod off for restart adoption", async () => {
		const provider = new InventoryProvider();
		const home = await mkdtemp(join(tmpdir(), "mfw-runpod-shutdown-handoff-"));
		homes.push(home);
		const first = await service(provider, machinePolicy, home);
		const lease = await first.putLeaseIntent(
			intent("shutdown-handoff", cpuRequest()),
		);
		await first.command(lease.ref, "provision", { type: "provision" });
		await first.stop();
		expect(provider.pods).toHaveLength(1);
		expect(provider.deletes).toBe(0);

		const restarted = await service(provider, machinePolicy, home);
		await restarted.start();
		const adopted = await restarted.observe(lease.ref);
		expect(adopted?.observedShape).toMatchObject({
			phase: "ready",
			providerPodId: "pod-1",
		});
		await restarted.command(lease.ref, "explicit-cleanup", {
			type: "dispose",
			reason: "test",
		});
		expect(provider.pods).toHaveLength(0);
		await restarted.stop();
	});

	test("stale local absence never removes a bootstrap before fresh live inventory and proven delete", async () => {
		const provider = new InventoryProvider();
		const home = await mkdtemp(join(tmpdir(), "mfw-runpod-stale-absent-"));
		homes.push(home);
		const first = await service(provider, machinePolicy, home);
		const lease = await first.putLeaseIntent(
			intent("stale-absent", cpuRequest()),
		);
		await first.command(lease.ref, "provision", { type: "provision" });
		await first.stop();
		const keyDirectory = join(dirname(first.dbPath), "ssh", lease.ref);
		expect((await stat(keyDirectory)).isDirectory()).toBe(true);
		const db = createClient({ url: `file:${first.dbPath}` });
		await db.execute({
			sql: "UPDATE leases SET phase = 'absent' WHERE ref = ?",
			args: [lease.ref],
		});
		db.close();

		let inventorySawKey = false;
		let deleteSawKey = false;
		provider.beforeList = async () => {
			inventorySawKey = (await stat(keyDirectory)).isDirectory();
		};
		provider.beforeDelete = async () => {
			deleteSawKey = (await stat(keyDirectory)).isDirectory();
		};
		const restarted = await service(provider, machinePolicy, home);
		await restarted.start();
		expect(inventorySawKey).toBe(true);
		expect(deleteSawKey).toBe(true);
		expect(provider.pods).toHaveLength(0);
		await expect(stat(keyDirectory)).rejects.toMatchObject({ code: "ENOENT" });
		await restarted.stop();
	});

	test("never blindly retries an ambiguous create with no matching inventory", async () => {
		const provider = new InventoryProvider();
		provider.createErrorWithoutEffect = true;
		const account = await service(provider);
		const lease = await account.putLeaseIntent(
			intent("ambiguous", gpuRequest()),
		);
		await expect(
			account.command(lease.ref, "first", { type: "provision" }),
		).rejects.toMatchObject({ code: "ambiguous_create" });
		await expect(
			account.command(lease.ref, "retry", { type: "provision" }),
		).rejects.toMatchObject({ code: "ambiguous_create" });
		expect(provider.creates).toBe(1);
		expect(account.gate.status().open).toBe(false);
		await account.stop();
	});

	test("inventory failure and duplicate ownership both close the remote gate", async () => {
		const unavailable = new InventoryProvider();
		const failedAccount = await service(unavailable);
		const failedLease = await failedAccount.putLeaseIntent(
			intent("inventory-down", gpuRequest()),
		);
		unavailable.listError = true;
		await expect(
			failedAccount.command(failedLease.ref, "provision", {
				type: "provision",
			}),
		).rejects.toThrow("inventory unavailable");
		expect(unavailable.creates).toBe(0);
		expect(failedAccount.gate.status().open).toBe(false);
		await failedAccount.stop();

		const duplicate = new InventoryProvider();
		const duplicateAccount = await service(duplicate);
		const lease = await duplicateAccount.putLeaseIntent(
			intent("duplicate-owner", gpuRequest()),
		);
		await duplicateAccount.command(lease.ref, "provision", {
			type: "provision",
		});
		const first = duplicate.pods[0] as RunPodPod;
		duplicate.pods.push(parseRunPodPod({ ...first.raw, id: "pod-duplicate" }));
		await expect(duplicateAccount.observe(lease.ref)).rejects.toMatchObject({
			code: "ambiguous_ownership",
		});
		expect(duplicateAccount.gate.status().open).toBe(false);
		expect(duplicate.deletes).toBe(0);
		await duplicateAccount.stop();
	});

	test("records an untracked namespace Pod and closes the gate without mutating it", async () => {
		const provider = new InventoryProvider();
		const account = await service(provider);
		const blockedLease = await account.putLeaseIntent(
			intent("blocked-by-untracked", gpuRequest()),
		);
		const unknownOwner = owner("external-owned", "untracked-project");
		const encoded = encodeRunPodOwnership(
			makeRunPodOwnership(
				machinePolicy.ownershipNamespace,
				machinePolicy.accountId,
				unknownOwner,
				"untracked/create",
				randomUUID(),
			),
		);
		provider.pods.push(
			parseRunPodPod({
				id: "untracked-pod",
				desiredStatus: "RUNNING",
				image: "safe/image:1",
				costPerHr: 0.5,
				env: { [RUNPOD_OWNERSHIP_ENV]: encoded },
				cloudType: "SECURE",
				gpu: { id: "NVIDIA A40", count: 1 },
				machine: { gpuTypeId: "NVIDIA A40", secureCloud: true },
			}),
		);

		await expect(
			account.command(blockedLease.ref, "must-not-create", {
				type: "provision",
			}),
		).rejects.toMatchObject({ code: "untracked_owned_pod" });
		expect(provider.creates).toBe(0);
		expect(provider.deletes).toBe(0);
		expect((await account.status()).livePods).toBe(1);
		expect(account.gate.status().open).toBe(false);

		const db = createClient({ url: `file:${account.dbPath}` });
		const inventory = await db.execute({
			sql: "SELECT pod_id FROM inventory WHERE pod_id = ?",
			args: ["untracked-pod"],
		});
		const audit = await db.execute(
			"SELECT kind FROM audit WHERE kind = 'untracked_owned_pod'",
		);
		expect(inventory.rows).toHaveLength(1);
		expect(audit.rows).toHaveLength(1);
		db.close();
		await account.stop();
	});

	test("hard policy deletes a known owned orphan only after absence proof", async () => {
		const provider = new InventoryProvider();
		const account = await service(provider);
		const lease = await account.putLeaseIntent(
			intent("known-orphan", gpuRequest()),
		);
		await account.command(lease.ref, "provision", { type: "provision" });
		const db = createClient({ url: `file:${account.dbPath}` });
		const keyRow = await db.execute({
			sql: "SELECT ssh_private_key_path FROM leases WHERE ref = ?",
			args: [lease.ref],
		});
		const privatePath = String(keyRow.rows[0]?.ssh_private_key_path);
		await db.execute({
			sql: "UPDATE leases SET phase = 'absent' WHERE ref = ?",
			args: [lease.ref],
		});
		db.close();

		await account.reconcile("known-orphan-test");
		expect(provider.deletes).toBe(1);
		expect(provider.pods).toHaveLength(0);
		expect((await account.observe(lease.ref))?.observedShape?.phase).toBe(
			"absent",
		);
		expect(account.gate.status().open).toBe(true);
		expect(await Bun.file(privatePath).exists()).toBe(false);
		expect(await Bun.file(`${privatePath}.pub`).exists()).toBe(false);
		await account.stop();
	});

	test("ambiguous teardown retains SSH evidence until a retry proves Pod absence", async () => {
		const provider = new InventoryProvider();
		const account = await service(provider);
		const lease = await account.putLeaseIntent(
			intent("cleanup-key-retention", gpuRequest()),
		);
		await account.command(lease.ref, "provision", { type: "provision" });
		const db = createClient({ url: `file:${account.dbPath}` });
		const keyRow = await db.execute({
			sql: "SELECT ssh_private_key_path FROM leases WHERE ref = ?",
			args: [lease.ref],
		});
		const privatePath = String(keyRow.rows[0]?.ssh_private_key_path);
		db.close();
		provider.deleteError = true;
		await expect(
			account.command(lease.ref, "dispose-first", {
				type: "dispose",
				reason: "test",
			}),
		).rejects.toThrow("not been confirmed absent");
		expect(await Bun.file(privatePath).exists()).toBe(true);

		provider.deleteError = false;
		const disposed = await account.command(lease.ref, "dispose-second", {
			type: "dispose",
			reason: "retry",
		});
		expect(disposed.observedShape?.phase).toBe("absent");
		expect(await Bun.file(privatePath).exists()).toBe(false);
		await account.stop();
	});

	test("deletes a live Pod immediately when observed price exceeds policy and proves absence", async () => {
		const provider = new InventoryProvider();
		provider.price = 1.5;
		const account = await service(provider);
		const lease = await account.putLeaseIntent(
			intent("price-rise", gpuRequest()),
		);
		await expect(
			account.command(lease.ref, "provision", { type: "provision" }),
		).rejects.toMatchObject({ code: "live_shape_policy_violation" });
		expect(provider.deletes).toBe(1);
		expect(provider.pods).toHaveLength(0);
		expect((await account.observe(lease.ref))?.observedShape?.phase).toBe(
			"absent",
		);
		await account.stop();
	});

	test("periodic reconciliation enforces the per-run spend ceiling", async () => {
		const provider = new InventoryProvider();
		const account = await service(provider);
		const request = { ...gpuRequest(), maxSpend: 0.01 };
		const lease = await account.putLeaseIntent(intent("spend-cap", request));
		await account.command(lease.ref, "provision", { type: "provision" });
		const db = createClient({ url: `file:${account.dbPath}` });
		await db.execute({
			sql: "UPDATE leases SET created_at = ? WHERE ref = ?",
			args: [Date.now() - 2 * 60_000, lease.ref],
		});
		db.close();
		await expect(account.reconcile("periodic-test")).rejects.toMatchObject({
			code: "live_shape_policy_violation",
		});
		expect(provider.deletes).toBe(1);
		expect(provider.pods).toHaveLength(0);
		await account.stop();
	});

	test("reconciliation drains newest owned Pods after an account cap is lowered", async () => {
		const provider = new InventoryProvider();
		const home = await mkdtemp(join(tmpdir(), "mfw-runpod-lowered-cap-"));
		homes.push(home);
		const original = await service(provider, machinePolicy, home);
		for (const [run, project] of [
			["older", "project-a"],
			["newer", "project-b"],
		] as const) {
			const lease = await original.putLeaseIntent(
				intent(run, gpuRequest(), project),
			);
			await original.command(lease.ref, `provision-${run}`, {
				type: "provision",
			});
		}
		expect(provider.pods).toHaveLength(2);
		await original.stop();

		const lowered = await service(
			provider,
			{ ...machinePolicy, maxConcurrentPods: 1 },
			home,
		);
		await lowered.reconcile("lowered-cap");
		expect(provider.deletes).toBe(1);
		expect(provider.pods).toHaveLength(1);
		expect(lowered.gate.status().open).toBe(true);
		await lowered.stop();
	});

	test("uses a distinct FULL/WAL account journal and persists no credential", async () => {
		const provider = new InventoryProvider();
		provider.pods.push(
			parseRunPodPod({
				id: "unrelated-exited-pod",
				desiredStatus: "EXITED",
				costPerHr: 0.1,
				env: { UNRELATED_SECRET: "provider-env-secret" },
			}),
		);
		const account = await service(provider);
		const lease = await account.putLeaseIntent(intent("durable", cpuRequest()));
		await account.command(lease.ref, "provision", { type: "provision" });
		expect(account.dbPath).toEndWith("/runpod/test-account/account.db");

		const db = createClient({ url: `file:${account.dbPath}` });
		const mode = await db.execute("PRAGMA journal_mode");
		const sync = await db.execute("PRAGMA synchronous");
		expect(String(mode.rows[0]?.journal_mode).toLowerCase()).toBe("wal");
		expect(Number(sync.rows[0]?.synchronous)).toBe(2);
		const durable = await db.execute(
			"SELECT request_json, result_json FROM operations ORDER BY created_at",
		);
		expect(JSON.stringify(durable.rows)).not.toContain("api-key");
		expect(durable.rows.length).toBeGreaterThan(0);
		const inventory = await db.execute("SELECT observed_json FROM inventory");
		expect(JSON.stringify(inventory.rows)).not.toContain("provider-env-secret");
		db.close();
		await account.stop();
	});
});
