import { describe, expect, test } from "bun:test";
import {
	formatPoolId,
	PoolIdSchema,
	parsePoolId,
	parseQuotaRef,
	QuotaRefSchema,
} from "../src/pool-id.ts";

describe("pool id grammar", () => {
	test.each([
		"local.gpu.0",
		"local.cpu",
		"runpod.main",
		"openrouter.main",
		"codex-cli.fleet",
		"project.mfw.deploy-lock",
		"ssh.build_box",
	])("accepts %s", (id) => {
		expect(PoolIdSchema.safeParse(id).success).toBe(true);
	});

	test.each([
		"",
		"local",
		"Local.gpu",
		"local..gpu",
		".local.gpu",
		"local.gpu.",
		"local.gpu.0.extra",
		"local gpu",
		"local.gpu/brain:mfw",
		"-local.gpu",
		"local.gpu\n",
	])("rejects %p", (id) => {
		expect(PoolIdSchema.safeParse(id).success).toBe(false);
	});

	test("parses and formats round-trip", () => {
		expect(parsePoolId("local.gpu.0")).toEqual({
			plugin: "local",
			instance: "gpu",
			unit: "0",
		});
		expect(parsePoolId("runpod.main")).toEqual({
			plugin: "runpod",
			instance: "main",
		});
		expect(parsePoolId("bad")).toBeNull();
		expect(formatPoolId({ plugin: "local", instance: "gpu", unit: "0" })).toBe(
			"local.gpu.0",
		);
		expect(() => formatPoolId({ plugin: "Local", instance: "gpu" })).toThrow();
	});

	test("child quota refs", () => {
		expect(QuotaRefSchema.safeParse("openrouter.main/brain:mfw").success).toBe(
			true,
		);
		expect(QuotaRefSchema.safeParse("openrouter.main").success).toBe(true);
		expect(QuotaRefSchema.safeParse("openrouter.main/brain").success).toBe(
			false,
		);
		expect(parseQuotaRef("openrouter.main/brain:mfw")).toEqual({
			pool: "openrouter.main",
			scope: "brain",
			name: "mfw",
		});
		expect(parseQuotaRef("local.gpu.0")).toEqual({ pool: "local.gpu.0" });
		expect(parseQuotaRef("nope/brain:x")).toBeNull();
	});
});
