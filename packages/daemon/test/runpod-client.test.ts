import { describe, expect, test } from "bun:test";
import {
	MFW_RUNPOD_CPU_IMAGE,
	parseRunPodAccountBalance,
	parseRunPodPodList,
	RunPodApiError,
	RunPodClient,
} from "../src/runpod-client.ts";

const key = "rp_test_secret_that_must_never_be_reported";

function clientWith(
	responder: (url: string, init: RequestInit) => Response | Promise<Response>,
	options: { maxResponseBytes?: number; timeoutMs?: number } = {},
) {
	return new RunPodClient({
		credentials: { apiKey: async () => key },
		fetch: responder as typeof fetch,
		baseUrl: "https://runpod.invalid/v1",
		graphqlUrl: "https://runpod.invalid/graphql",
		...options,
	});
}

function response(value: unknown, status = 200): Response {
	return new Response(value === null ? null : JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("RunPod REST client", () => {
	test("parses only the documented GraphQL clientBalance contract", () => {
		expect(
			parseRunPodAccountBalance({
				data: { myself: { clientBalance: 12.34 } },
			}),
		).toEqual({ remainingCredits: 12.34 });
		for (const invalid of [
			{ data: { myself: { clientBalance: "12.34" } } },
			{ data: { myself: {} } },
			{ data: { myself: { clientBalance: 12.34 } }, errors: [{}] },
		]) {
			expect(() => parseRunPodAccountBalance(invalid)).toThrow(RunPodApiError);
		}
	});

	test("reads remaining credits through an authenticated read-only GraphQL query", async () => {
		const client = clientWith((url, init) => {
			expect(url).toBe("https://runpod.invalid/graphql");
			expect(init.method).toBe("POST");
			expect((init.headers as Record<string, string>).Authorization).toBe(
				`Bearer ${key}`,
			);
			expect(url).not.toContain(key);
			expect(JSON.parse(String(init.body))).toEqual({
				query: "query MfwAccountBalance { myself { clientBalance } }",
			});
			return response({ data: { myself: { clientBalance: 7.89 } } });
		});
		await expect(client.getAccountBalance()).resolves.toEqual({
			remainingCredits: 7.89,
		});
	});

	test("parses documented bare inventory and defensive wrapper variants", () => {
		const bare = parseRunPodPodList([
			{
				id: "gpu-1",
				name: "same-name",
				desiredStatus: "RUNNING",
				costPerHr: "1.25",
				publicIp: "194.26.0.7",
				portMappings: { "22": 40123, "8888": 48888 },
				env: { OWNER: "a" },
				machine: { gpuTypeId: "NVIDIA H100 80GB HBM3", secureCloud: true },
				gpu: { id: "NVIDIA H100 80GB HBM3", count: 8 },
			},
		]);
		expect(bare[0]?.costPerHr).toBe(1.25);
		expect(bare[0]?.env).toEqual({ OWNER: "a" });
		expect(bare[0]?.publicIp).toBe("194.26.0.7");
		expect(bare[0]?.portMappings).toEqual({ "22": 40123, "8888": 48888 });
		expect(parseRunPodPodList({ pods: [{ id: "cpu-1" }] })[0]?.id).toBe(
			"cpu-1",
		);
		expect(() => parseRunPodPodList({ items: [] })).toThrow(RunPodApiError);
		expect(() => parseRunPodPodList([{ id: "x" }, { id: "x" }])).toThrow(
			"duplicate ids",
		);
	});

	test("fetches one full inventory with bearer auth and no project filter", async () => {
		let calls = 0;
		const client = clientWith((url, init) => {
			calls++;
			expect(url).toBe("https://runpod.invalid/v1/pods?includeMachine=true");
			expect(init.method).toBe("GET");
			expect((init.headers as Record<string, string>).Authorization).toBe(
				`Bearer ${key}`,
			);
			return response([{ id: "pod-1", desiredStatus: "RUNNING" }]);
		});
		expect((await client.listPods()).map((pod) => pod.id)).toEqual(["pod-1"]);
		expect(calls).toBe(1);
	});

	test("builds distinct GPU and CPU-only requests and never accepts task env", async () => {
		const bodies: Record<string, unknown>[] = [];
		const client = clientWith((_url, init) => {
			bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
			return response({
				id: `pod-${bodies.length}`,
				desiredStatus: "RUNNING",
				costPerHr: 0.5,
			});
		});
		await client.createPod({
			name: "gpu",
			createEnv: {
				MFW_RUNPOD_OWNERSHIP_V1: "owned",
				SSH_PUBLIC_KEY: "ssh-ed25519 AAAA",
				PUBLIC_KEY: "ssh-ed25519 AAAA",
			},
			request: {
				computeType: "GPU",
				gpuTypeId: "NVIDIA H100 80GB HBM3",
				gpuCount: 2,
				image: "safe/image:1",
				cloud: "SECURE",
				maxHourlyPrice: 5,
				maxRuntimeMinutes: 30,
				maxSpend: 5,
				containerDiskInGb: 50,
				volumeInGb: 0,
				allowedCudaVersions: [],
			},
		});
		const cpuRequest = {
			computeType: "CPU" as const,
			cpuFlavorId: "cpu5m" as const,
			vcpuCount: 16,
			memoryInGb: 128,
			image: MFW_RUNPOD_CPU_IMAGE,
			cloud: "SECURE" as const,
			maxHourlyPrice: 1,
			maxRuntimeMinutes: 30,
			maxSpend: 1,
			containerDiskInGb: 50,
			volumeInGb: 0,
		};
		await client.createPod({
			name: "cpu",
			createEnv: {
				MFW_RUNPOD_OWNERSHIP_V1: "owned-cpu",
				SSH_PUBLIC_KEY: "ssh-ed25519 AAAA",
				PUBLIC_KEY: "ssh-ed25519 AAAA",
			},
			request: cpuRequest,
		});
		const rejectedEnvironments: Record<string, string>[] = [
			{ MFW_RUNPOD_OWNERSHIP_V1: "owner", PUBLIC_KEY: "wrong" },
			{
				MFW_RUNPOD_OWNERSHIP_V1: "owner",
				SSH_PUBLIC_KEY: "ssh-ed25519 AAAA",
				PUBLIC_KEY: "ssh-ed25519 BBBB",
			},
			{
				MFW_RUNPOD_OWNERSHIP_V1: "owner",
				SSH_PUBLIC_KEY: "ssh-ed25519 AAAA",
				PUBLIC_KEY: "ssh-ed25519 AAAA",
				CODEX_API_KEY: "task-secret",
			},
		];
		for (const createEnv of rejectedEnvironments) {
			await expect(
				client.createPod({ name: "rejected", createEnv, request: cpuRequest }),
			).rejects.toMatchObject({ code: "invalid_response" });
		}
		expect(bodies[0]).toMatchObject({
			computeType: "GPU",
			gpuTypeIds: ["NVIDIA H100 80GB HBM3"],
			gpuCount: 2,
		});
		expect(bodies[1]).toMatchObject({
			computeType: "CPU",
			cpuFlavorIds: ["cpu5m"],
			vcpuCount: 16,
			ports: ["22/tcp"],
			supportPublicIp: true,
		});
		expect(bodies[1]).not.toHaveProperty("dockerEntrypoint");
		expect(bodies[1]).not.toHaveProperty("dockerStartCmd");
		expect(bodies[1]).not.toHaveProperty("memoryInGb");
		expect(bodies[1]).not.toHaveProperty("gpuTypeIds");
		expect(bodies[1]).not.toHaveProperty("gpuCount");
		expect(bodies[1]?.env).toEqual({
			MFW_RUNPOD_OWNERSHIP_V1: "owned-cpu",
			SSH_PUBLIC_KEY: "ssh-ed25519 AAAA",
			PUBLIC_KEY: "ssh-ed25519 AAAA",
		});
		expect(bodies[0]).not.toHaveProperty("dockerStartCmd");
	});

	test("does not retry create and redacts provider bodies and credentials", async () => {
		let calls = 0;
		const client = clientWith(() => {
			calls++;
			return new Response(`provider echoed ${key} and request env`, {
				status: 500,
			});
		});
		let error: unknown;
		try {
			await client.createPod({
				name: "one-shot",
				createEnv: {
					MFW_RUNPOD_OWNERSHIP_V1: "owner",
					SSH_PUBLIC_KEY: "ssh-ed25519 AAAA",
					PUBLIC_KEY: "ssh-ed25519 AAAA",
				},
				request: {
					computeType: "CPU",
					cpuFlavorId: "cpu3m",
					vcpuCount: 4,
					memoryInGb: 32,
					image: "safe/image:1",
					cloud: "SECURE",
					maxHourlyPrice: 1,
					maxRuntimeMinutes: 30,
					maxSpend: 1,
					containerDiskInGb: 50,
					volumeInGb: 0,
				},
			});
		} catch (caught) {
			error = caught;
		}
		expect(calls).toBe(1);
		expect(String(error)).not.toContain(key);
		expect(String(error)).not.toContain("request env");
		expect(error).toBeInstanceOf(RunPodApiError);
	});

	test("bounds response bytes and request time", async () => {
		const large = clientWith(() => new Response("x".repeat(65)), {
			maxResponseBytes: 64,
		});
		await expect(large.listPods()).rejects.toMatchObject({
			code: "response_too_large",
		});

		const slow = clientWith(
			(_url, init) =>
				new Promise<Response>((_resolve, reject) => {
					init.signal?.addEventListener("abort", () =>
						reject(new DOMException("aborted", "AbortError")),
					);
				}),
			{ timeoutMs: 5 },
		);
		await expect(slow.listPods()).rejects.toMatchObject({ code: "timeout" });
	});

	test("treats delete 404 as already absent", async () => {
		const client = clientWith((url, init) => {
			expect(url).toEndWith("/pods/a%2Fb");
			expect(init.method).toBe("DELETE");
			return response({ error: "gone" }, 404);
		});
		await expect(client.deletePod("a/b")).resolves.toBeUndefined();
	});
});
