import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArmingStore } from "../src/triggers/arming.ts";

let home: string;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "mfw-arming-"));
});

afterEach(async () => {
	await rm(home, { recursive: true, force: true });
});

describe("concurrent arming-store writes", () => {
	test("a concurrent write never erases a disarm", async () => {
		const store = ArmingStore.at(home, "demo");
		for (let round = 0; round < 200; round++) {
			await store.arm("t", "sha256:a");
			await store.markFailing("t", "boom", false);
			await Promise.all([
				store.clearFailing("t"),
				store.autoDisarm("t", "re-arm-needed", "merged:x"),
			]);
			const record = (await store.load()).t;
			expect(record?.disarmed?.reason).toBe("re-arm-needed");
			expect(record?.failing).toBeUndefined();
		}
	});

	test("two store objects on one file share the serialization", async () => {
		const a = ArmingStore.at(home, "demo");
		const b = ArmingStore.at(home, "demo");
		for (let round = 0; round < 100; round++) {
			await a.arm("t", "sha256:a");
			await a.arm("u", "sha256:b");
			await Promise.all([
				a.autoDisarm("t", "re-arm-needed", "x"),
				b.autoDisarm("u", "re-arm-needed", "y"),
			]);
			const file = await a.load();
			expect(file.t?.disarmed).toBeDefined();
			expect(file.u?.disarmed).toBeDefined();
		}
	});

	test("a failed mutation does not block later ones", async () => {
		const store = ArmingStore.at(home, "demo");
		await store.arm("t", "sha256:a");
		await Bun.write(join(home, "triggers", "demo.json"), "{bad");
		await expect(store.clearFailing("t")).rejects.toThrow("malformed");
		await Bun.write(join(home, "triggers", "demo.json"), "{}\n");
		await store.arm("t", "sha256:b");
		expect((await store.load()).t?.hash).toBe("sha256:b");
	});
});
