import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExecutionOwnership,
	ProviderLeaseIntent,
} from "../../src/execution-target.ts";
import { silentLogger } from "../../src/log.ts";
import {
	RunPodAccountService,
	type RunPodAccountServiceOptions,
	type RunPodProviderClient,
} from "../../src/runpod-account-service.ts";
import {
	parseRunPodPod,
	type RunPodCreateInput,
	type RunPodPod,
} from "../../src/runpod-client.ts";
import {
	encodeRunPodOwnership,
	makeRunPodOwnership,
	RUNPOD_OWNERSHIP_ENV,
} from "../../src/runpod-ownership.ts";
import {
	type EnabledRunPodMachinePolicy,
	type RunPodPlacementRequest,
	RunPodPlacementRequestSchema,
} from "../../src/runpod-policy.ts";

const TEST_SSH_PUBLIC_KEY = `ssh-ed25519 ${Buffer.alloc(32, 7).toString("base64")}`;

export const reconcilePolicy: EnabledRunPodMachinePolicy = {
	enabled: true,
	accountId: "reconcile-account",
	ownershipNamespace: "mfw-reconcile-tests",
	sshProxyAccountSuffix: "account1",
	sshHostPublicKey: `ssh-ed25519 ${Buffer.alloc(32, 9).toString("base64")}`,
	allowedGpuTypes: ["NVIDIA A40"],
	allowedCpuFlavors: ["cpu5m"],
	allowedImages: ["safe/image:1"],
	allowedClouds: ["SECURE"],
	maxHourlyPrice: 2,
	maxGpuCount: 1,
	maxConcurrentPods: 3,
	maxAggregateHourlyPrice: 3,
	maxRuntimeMinutes: 60,
	maxRunSpend: 2,
	reconcileIntervalMs: 1_000,
};

export const reconcileRequest: RunPodPlacementRequest =
	RunPodPlacementRequestSchema.parse({
		computeType: "CPU",
		cpuFlavorId: "cpu5m",
		vcpuCount: 16,
		memoryInGb: 128,
		image: "safe/image:1",
		cloud: "SECURE",
		maxHourlyPrice: 1,
		maxRuntimeMinutes: 30,
		maxSpend: 1,
	});

export function testOwner(
	runId: string,
	projectId = "project-a",
): ExecutionOwnership {
	return {
		projectId,
		projectName: projectId,
		runId,
		taskId: "MFW-99",
		attempt: 1,
		ownerKey: `${projectId}/${runId}/1`,
	};
}

export function testIntent(
	runId: string,
	projectId = "project-a",
): ProviderLeaseIntent {
	return {
		operationId: `${projectId}/${runId}/1/prepare`,
		targetKind: "runpod",
		owner: testOwner(runId, projectId),
		requestedShape: reconcileRequest,
	};
}

export function untrackedPod(
	id: string,
	runId: string,
	projectId = "missing-project",
	encoded?: string,
): RunPodPod {
	const owner = testOwner(runId, projectId);
	const ownership =
		encoded ??
		encodeRunPodOwnership(
			makeRunPodOwnership(
				reconcilePolicy.ownershipNamespace,
				reconcilePolicy.accountId,
				owner,
				`${owner.ownerKey}/provider-create`,
				randomUUID(),
			),
		);
	return parseRunPodPod({
		id,
		name: `mfw-${runId}`,
		desiredStatus: "RUNNING",
		image: reconcileRequest.image,
		costPerHr: 0.5,
		adjustedCostPerHr: 0.4,
		cpuFlavorId: "cpu5m",
		vcpuCount: 16,
		memoryInGb: 128,
		cloudType: "SECURE",
		machine: { secureCloud: true },
		env: {
			[RUNPOD_OWNERSHIP_ENV]: ownership,
			SSH_PUBLIC_KEY: TEST_SSH_PUBLIC_KEY,
			PROVIDER_SECRET: "must-never-be-persisted",
		},
	});
}

export class FakeRunPodProvider implements RunPodProviderClient {
	pods: RunPodPod[] = [];
	balance = 42.5;
	balanceFailure: Error | null = null;
	balanceCalls = 0;
	creates = 0;
	deletes: string[] = [];
	credential = true;
	listFailure: Error | null = null;
	malformedInventory: unknown = null;
	retainDeletes = false;
	deleteFailures = 0;
	listCalls = 0;
	injectPublicKeyAlias = false;
	publicKeyAliasTransform: (key: string) => string = (key) => key;

	async credentialReady(): Promise<boolean> {
		return this.credential;
	}

	async getAccountBalance(): Promise<{ remainingCredits: number }> {
		this.balanceCalls++;
		if (this.balanceFailure) throw this.balanceFailure;
		return { remainingCredits: this.balance };
	}

	async listPods(): Promise<RunPodPod[]> {
		this.listCalls++;
		if (this.listFailure) throw this.listFailure;
		if (this.malformedInventory !== null) {
			return this.malformedInventory as RunPodPod[];
		}
		return [...this.pods];
	}

	async createPod(input: RunPodCreateInput): Promise<RunPodPod> {
		this.creates++;
		const pod = parseRunPodPod({
			id: `created-${this.creates}`,
			name: input.name,
			desiredStatus: "RUNNING",
			image: input.request.image,
			costPerHr: 0.5,
			adjustedCostPerHr: 0.4,
			cpuFlavorId:
				input.request.computeType === "CPU" ? input.request.cpuFlavorId : null,
			vcpuCount:
				input.request.computeType === "CPU" ? input.request.vcpuCount : null,
			memoryInGb:
				input.request.computeType === "CPU" ? input.request.memoryInGb : null,
			gpu:
				input.request.computeType === "GPU"
					? {
							id: input.request.gpuTypeId,
							count: input.request.gpuCount,
						}
					: null,
			cloudType: input.request.cloud,
			machine: { secureCloud: input.request.cloud === "SECURE" },
			publicIp: "194.26.0.7",
			portMappings: { "22": 40123 },
			env: {
				...input.createEnv,
				...(this.injectPublicKeyAlias
					? {
							PUBLIC_KEY: this.publicKeyAliasTransform(
								input.createEnv.SSH_PUBLIC_KEY ?? "",
							),
						}
					: {}),
			},
		});
		this.pods.push(pod);
		return pod;
	}

	async deletePod(podId: string): Promise<void> {
		this.deletes.push(podId);
		if (this.deleteFailures > 0) {
			this.deleteFailures--;
			throw new Error("delete unavailable");
		}
		if (!this.retainDeletes) {
			this.pods = this.pods.filter((pod) => pod.id !== podId);
		}
	}
}

export async function accountFixture(
	provider: FakeRunPodProvider,
	options: Partial<RunPodAccountServiceOptions> = {},
): Promise<{ account: RunPodAccountService; home: string }> {
	const home =
		options.mfwHome ??
		(await mkdtemp(join(tmpdir(), "mfw-runpod-reconcile-test-")));
	const account = new RunPodAccountService({
		mfwHome: home,
		policy: reconcilePolicy,
		client: provider,
		log: silentLogger(),
		absenceAttempts: 2,
		absenceDelayMs: 1,
		sshKeyBootstrap: async (_identifier, directory) => ({
			privateKeyPath: join(directory, "id_ed25519"),
			publicKey: TEST_SSH_PUBLIC_KEY,
			dispose: async () => {},
		}),
		...options,
	});
	return { account, home };
}
