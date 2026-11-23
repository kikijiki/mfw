import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { openTestHolds } from "./support/host-ledger.ts";

async function store() {
	const home = await mkdtemp(join(tmpdir(), "mfw-holds-"));
	const now = { value: 1_000_000 };
	return {
		home,
		now,
		holds: await openTestHolds(home, () => now.value),
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

	test("no holds reads as empty, and an unreadable hold fails closed", async () => {
		const s = await store();
		expect(await s.holds.active()).toEqual({});
		await s.holds.hold("claude-cli", { until: 2_000_000, reason: "r" });
		const client = createClient({
			url: `file:${join(s.home, "host", "host.db")}`,
		});
		await client.execute("UPDATE rp_holds SET detail='{nope'");
		client.close();
		await expect(s.holds.active()).rejects.toMatchObject({ code: "CORRUPT" });
		await expect(s.holds.snapshot()).rejects.toMatchObject({ code: "CORRUPT" });
		await s.cleanup();
	});

	test("a hold survives a restart of the store", async () => {
		const s = await store();
		await s.holds.hold("claude-cli", { until: 2_000_000, reason: "r" });
		const reopened = await openTestHolds(s.home, () => s.now.value);
		expect((await reopened.active())["claude-cli"]?.reason).toBe("r");
		await s.cleanup();
	});
});
