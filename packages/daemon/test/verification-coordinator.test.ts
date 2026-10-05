import { describe, expect, test } from "bun:test";
import { VerificationCoordinator } from "../src/verification-coordinator.ts";

describe("VerificationCoordinator", () => {
	test("foreground preempts background and waits for it to stop", async () => {
		const coordinator = new VerificationCoordinator();
		const order: string[] = [];
		let started!: () => void;
		const isStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		const background = coordinator.backgroundWork(async (signal) => {
			order.push("background:start");
			started();
			await new Promise<void>((resolve) => {
				signal.addEventListener("abort", () => resolve(), { once: true });
			});
			order.push("background:stopped");
		});
		await isStarted;
		const foreground = coordinator.foreground(async () => {
			order.push("foreground:start");
		});
		await Promise.all([background, foreground]);
		expect(order).toEqual([
			"background:start",
			"background:stopped",
			"foreground:start",
		]);
	});

	test("foreground checks are serialized", async () => {
		const coordinator = new VerificationCoordinator();
		let active = 0;
		let peak = 0;
		await Promise.all(
			[1, 2, 3].map(() =>
				coordinator.foreground(async () => {
					active++;
					peak = Math.max(peak, active);
					await Bun.sleep(5);
					active--;
				}),
			),
		);
		expect(peak).toBe(1);
	});
});
