import { describe, expect, test } from "bun:test";
import {
	bindContract,
	CONTRACT_VERSIONS,
	ContractViolation,
	contractId,
	PLUGIN_KINDS,
} from "../src/common.ts";
import { BoardDocViewSchema, ExternalUpsertSchema } from "../src/connector.ts";
import { FakeHost } from "../src/fakes/fake-host.ts";
import { OwnershipTokenSchema, ProvisionResultSchema } from "../src/machine.ts";
import { NarrowedTriggerViewSchema } from "../src/notify.ts";
import {
	AccountObservationSchema,
	EndpointDeclSchema,
	isAllowedBaseUrl,
	PriceTableSchema,
} from "../src/provider.ts";
import {
	capacityRaised,
	type Dimension,
	type DimensionObservation,
	DimensionSchema,
	ObservationSchema,
	PoolProposalSchema,
	resourceContract,
	UsageReportSchema,
} from "../src/resource.ts";

describe("contract ids", () => {
	test("every kind is versioned as mfw.<kind>/v<n>", () => {
		expect(contractId("resource")).toBe("mfw.resource/v1");
		expect([...PLUGIN_KINDS].sort() as string[]).toEqual(
			(Object.keys(CONTRACT_VERSIONS) as string[]).sort(),
		);
	});
});

describe("resource schemas", () => {
	test("dimensions cover slot, quantity, window and meter", () => {
		for (const d of [
			{ kind: "slot", name: "gpu", total: 2, units: ["0", "1"] },
			{ kind: "quantity", name: "ram", unit: "gib", total: 64 },
			{
				kind: "window",
				name: "daily",
				unit: "usd",
				limit: 30,
				window: { type: "calendar", period: "day" },
			},
			{ kind: "meter", name: "weekly" },
		])
			expect(DimensionSchema.safeParse(d).success).toBe(true);
		expect(DimensionSchema.safeParse({ kind: "lock", name: "x" }).success).toBe(
			false,
		);
		expect(
			DimensionSchema.safeParse({ kind: "slot", name: "g", total: -1 }).success,
		).toBe(false);
		expect(
			DimensionSchema.safeParse({ kind: "slot", name: "g", total: 1.5 })
				.success,
		).toBe(false);
	});

	test("a proposal needs a valid pool id and at least one dimension", () => {
		const dim = { kind: "slot", name: "pods", total: 1 };
		expect(
			PoolProposalSchema.safeParse({
				poolId: "runpod.main",
				title: "t",
				dimensions: [dim],
			}).success,
		).toBe(true);
		expect(
			PoolProposalSchema.safeParse({
				poolId: "RunPod",
				title: "t",
				dimensions: [dim],
			}).success,
		).toBe(false);
		expect(
			PoolProposalSchema.safeParse({
				poolId: "runpod.main",
				title: "t",
				dimensions: [],
			}).success,
		).toBe(false);
	});

	test("unknown measurements are null, and NaN or negatives are refused", () => {
		const base = {
			poolId: "openrouter.main",
			tokens: null,
			requests: null,
			slotHours: null,
			asOf: 1,
		};
		expect(UsageReportSchema.safeParse({ ...base, usd: null }).success).toBe(
			true,
		);
		expect(UsageReportSchema.safeParse({ ...base, usd: -1 }).success).toBe(
			false,
		);
		expect(
			UsageReportSchema.safeParse({ ...base, usd: Number.NaN }).success,
		).toBe(false);
		expect(UsageReportSchema.safeParse({ ...base }).success).toBe(false);
	});

	test("a meter fraction is within [0, 1] or null", () => {
		const obs = (fraction: number | null) =>
			ObservationSchema.safeParse({
				poolId: "claude-cli.fleet",
				observedAt: 1,
				health: "ok",
				dimensions: [{ kind: "meter", name: "weekly", fraction }],
			}).success;
		expect(obs(0.4)).toBe(true);
		expect(obs(null)).toBe(true);
		expect(obs(1.2)).toBe(false);
		expect(obs(-0.1)).toBe(false);
	});

	test("capacityRaised reports only raised or invented dimensions", () => {
		const declared = [
			{ kind: "slot", name: "gpu", total: 2 },
			{ kind: "quantity", name: "ram", unit: "gib", total: 64 },
		] satisfies Dimension[];
		const obs = (gpu: number, ram: number): DimensionObservation[] => [
			{ kind: "slot", name: "gpu", total: gpu, occupied: [] },
			{ kind: "quantity", name: "ram", total: ram, used: null },
		];
		expect(capacityRaised(declared, obs(2, 64))).toEqual([]);
		expect(capacityRaised(declared, obs(1, 32))).toEqual([]);
		expect(capacityRaised(declared, obs(3, 64))).toEqual(["gpu"]);
		expect(capacityRaised(declared, obs(2, 65))).toEqual(["ram"]);
		expect(
			capacityRaised(declared, [
				{ kind: "slot", name: "invented", total: 1, occupied: [] },
			]),
		).toEqual(["invented"]);
		expect(
			capacityRaised(declared, [
				{ kind: "quantity", name: "gpu", total: 1, used: null },
			]),
		).toEqual(["gpu"]);
	});
});

describe("machine schemas", () => {
	test("provision results are a closed union", () => {
		expect(
			ProvisionResultSchema.safeParse({ status: "created", externalId: "m-1" })
				.success,
		).toBe(true);
		expect(
			ProvisionResultSchema.safeParse({ status: "ambiguous" }).success,
		).toBe(true);
		expect(ProvisionResultSchema.safeParse({ status: "created" }).success).toBe(
			false,
		);
		expect(ProvisionResultSchema.safeParse({ status: "weird" }).success).toBe(
			false,
		);
	});

	test("ownership tokens are long enough to be unguessable", () => {
		expect(OwnershipTokenSchema.safeParse("short").success).toBe(false);
		expect(OwnershipTokenSchema.safeParse("mfw-0123456789abcdef").success).toBe(
			true,
		);
		expect(OwnershipTokenSchema.safeParse("has space 0123456789").success).toBe(
			false,
		);
	});
});

describe("provider schemas", () => {
	test.each([
		["https://openrouter.ai/api/v1", true],
		["http://127.0.0.1:8080/v1", true],
		["http://[::1]:8080/v1", true],
		["http://models.example.com/v1", false],
		["https://user:pass@models.example.com/v1", false],
		["https://models.example.com/v1#frag", false],
		["ftp://models.example.com", false],
		["not a url", false],
		["http://localhost:8080", false],
	])("baseUrl %s allowed=%p", (url, ok) => {
		expect(isAllowedBaseUrl(url)).toBe(ok);
		expect(
			EndpointDeclSchema.safeParse({
				id: "e",
				baseUrl: url,
				api: "openai-compatible",
			}).success,
		).toBe(ok);
	});

	test("pricing and account use null for unknown", () => {
		expect(
			PriceTableSchema.safeParse({
				asOf: 1,
				currency: "usd",
				models: { m: { inputPerMTok: 1, outputPerMTok: null } },
			}).success,
		).toBe(true);
		expect(
			AccountObservationSchema.safeParse({ observedAt: 1, creditsUsd: null })
				.success,
		).toBe(true);
	});
});

describe("connector, notify and action schemas", () => {
	test("a board doc view and upsert round-trip", () => {
		expect(
			BoardDocViewSchema.safeParse({
				id: "T-1",
				type: "task",
				title: "t",
				fields: {},
				body: "",
				updatedAt: 1,
			}).success,
		).toBe(true);
		expect(
			ExternalUpsertSchema.safeParse({
				docId: "T-1",
				hash: "abcdef12",
				payload: { a: 1 },
			}).success,
		).toBe(true);
		expect(
			ExternalUpsertSchema.safeParse({ docId: "T-1", hash: "x", payload: {} })
				.success,
		).toBe(false);
	});

	test("the narrowed trigger view rejects host state", () => {
		const view = {
			definitionId: "d",
			deliveryId: "x",
			projectName: "demo",
			event: { type: "merge.completed", at: 1, summary: "s" },
		};
		expect(NarrowedTriggerViewSchema.safeParse(view).success).toBe(true);
		// zod objects strip unknown keys, so projectRoot never reaches a plugin.
		const parsed = NarrowedTriggerViewSchema.parse({
			...view,
			projectRoot: "/x",
			secrets: ["k"],
		});
		expect(Object.keys(parsed)).not.toContain("projectRoot");
		expect(Object.keys(parsed)).not.toContain("secrets");
	});
});

describe("bindContract", () => {
	const host = new FakeHost();
	const proposal = {
		poolId: "local.gpu.0",
		title: "GPU 0",
		dimensions: [{ kind: "slot", name: "gpu", total: 1 }],
	};

	test("validates parameters in and results out", async () => {
		const plugin = bindContract(resourceContract, {
			discover: async () => [proposal],
			observe: async () => ({ nope: true }),
		}) as unknown as {
			discover(p: object, c: unknown): Promise<unknown[]>;
			observe(p: object, c: unknown): Promise<unknown>;
		};
		const ctx = host.context();
		const found = await plugin.discover({}, ctx);
		expect(found).toHaveLength(1);
		await expect(
			plugin.observe({ poolId: "bad id" }, ctx),
		).rejects.toBeInstanceOf(ContractViolation);
		await expect(
			plugin.observe({ poolId: "local.gpu.0" }, ctx),
		).rejects.toThrow(/result/);
	});

	test("does not bind methods the plugin lacks", () => {
		const plugin = bindContract(resourceContract, { discover: async () => [] });
		expect((plugin as Record<string, unknown>).observe).toBeUndefined();
	});
});
