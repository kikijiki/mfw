import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderHoldStore } from "../src/provider-holds.ts";

async function store() {
	const home = await mkdtemp(join(tmpdir(), "mfw-holds-"));
	const now = { value: 1_000_000 };
	return {
		home,
		now,
		holds: ProviderHoldStore.at(home, () => now.value),
		cleanup: () => rm(home, { recursive: true, force: true }),
	};
}

describe("ProviderHoldStore", () => {
	test("keeps the furthest until per key, and keys are independent", async () => {
		const s = await store();
		await s.holds.hold("claude-cli", { until: 5_000_000, reason: "long" });
		await s.holds.hold("claude-cli", { until: 2_000_000, reason: "short" });
		await s.holds.hold("codex-cli@local", { until: 3_000_000, reason: "x" });
		const active = await s.holds.active();
		expect(active["claude-cli"]?.reason).toBe("long");
		expect(Object.keys(active).sort()).toEqual([
			"claude-cli",
			"codex-cli@local",
		]);
		const lookup = await s.holds.snapshot();
		expect(lookup("codex-cli")).toBeNull();
		await s.cleanup();
	});

	test("expired holds vanish; concurrent writers all land (serialized mutate)", async () => {
		const s = await store();
		await Promise.all(
			["a", "b", "c", "d"].map((k, i) =>
				s.holds.hold(k, { until: 2_000_000 + i, reason: k }),
			),
		);
		expect(Object.keys(await s.holds.active()).sort()).toEqual([
			"a",
			"b",
			"c",
			"d",
		]);
		s.now.value = 3_000_000;
		expect(await s.holds.active()).toEqual({});
		await s.cleanup();
	});

	test("absent or corrupt file means no holds, and the next hold rewrites it", async () => {
		const s = await store();
		expect(await s.holds.active()).toEqual({});
		await writeFile(join(s.home, "provider-holds.json"), "{nope");
		expect(await s.holds.active()).toEqual({});
		await s.holds.hold("claude-cli", { until: 2_000_000, reason: "r" });
		const raw = JSON.parse(
			await readFile(join(s.home, "provider-holds.json"), "utf8"),
		);
		expect(raw.holds["claude-cli"].until).toBe(2_000_000);
		await s.cleanup();
	});
});
