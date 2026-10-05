import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import {
	accountFixture,
	FakeRunPodProvider,
	reconcilePolicy,
	testIntent,
	untrackedPod,
} from "./fixtures/runpod-account.ts";

const homes: string[] = [];

afterEach(async () => {
	for (const home of homes.splice(0)) {
		await rm(home, { recursive: true, force: true });
	}
});

describe("RunPod leak recovery integration", () => {
	test("three leaked Pods including missing local state converge to zero owned while foreign Pods survive", async () => {
		const provider = new FakeRunPodProvider();
		provider.pods = [
			untrackedPod("leak-a", "lost-eight-hours", "missing-project-a"),
			untrackedPod("leak-b", "lost-eleven-hours", "missing-project-b"),
			untrackedPod("leak-c", "not-in-local-db", "missing-project-c"),
			{
				...untrackedPod("foreign", "other-run", "other-project"),
				env: {},
			},
		];
		const fixture = await accountFixture(provider, {
			resolveOwner: async () => ({
				state: "unrecoverable",
				projectName: null,
				reason: "project_missing",
			}),
		});
		homes.push(fixture.home);
		await fixture.account.start();
		await fixture.account.reconcile("leak-regression");

		expect(provider.pods.map((pod) => pod.id)).toEqual(["foreign"]);
		expect(provider.deletes.sort()).toEqual(["leak-a", "leak-b", "leak-c"]);
		const model = await fixture.account.readModel();
		expect(model.inventory.fresh).toBe(true);
		expect(model.reconcile.cleanupPending).toBe(0);
		expect(model.pods.filter((pod) => pod.live)).toHaveLength(1);
		expect(model.pods.find((pod) => pod.podId === "foreign")?.ownership).toBe(
			"unknown",
		);
		expect(model.audit.some((row) => row.kind === "untracked_owned_pod")).toBe(
			true,
		);
		await fixture.account.stop();

		const secondProcess = await accountFixture(provider, {
			mfwHome: fixture.home,
		});
		await secondProcess.account.start();
		const afterRestart = await secondProcess.account.readModel();
		expect(afterRestart.pods.filter((pod) => pod.live)).toHaveLength(1);
		expect(afterRestart.reconcile.cleanupPending).toBe(0);
		await secondProcess.account.stop();
	});

	test("two project processes share one account cap and cleanup gate", async () => {
		const provider = new FakeRunPodProvider();
		const first = await accountFixture(provider, {
			policy: { ...reconcilePolicy, maxConcurrentPods: 1 },
		});
		homes.push(first.home);
		const second = await accountFixture(provider, {
			mfwHome: first.home,
			policy: { ...reconcilePolicy, maxConcurrentPods: 1 },
		});
		const [left, right] = await Promise.all([
			first.account.putLeaseIntent(testIntent("left", "project-left")),
			second.account.putLeaseIntent(testIntent("right", "project-right")),
		]);
		const outcomes = await Promise.allSettled([
			first.account.command(left.ref, "left/provision", { type: "provision" }),
			second.account.command(right.ref, "right/provision", {
				type: "provision",
			}),
		]);
		expect(
			outcomes.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		expect(provider.pods).toHaveLength(1);
		const owner = outcomes[0]?.status === "fulfilled" ? first : second;
		const lease = outcomes[0]?.status === "fulfilled" ? left : right;
		await owner.account.command(lease.ref, "winner/dispose", {
			type: "dispose",
			reason: "integration complete",
		});
		expect(provider.pods).toHaveLength(0);
		await first.account.stop();
		await second.account.stop();
	});

	test("two attempted 8x H100 escalations make no provider call and leave zero owned Pods", async () => {
		const provider = new FakeRunPodProvider();
		const fixture = await accountFixture(provider);
		homes.push(fixture.home);
		for (const run of ["escalation-one", "escalation-two"]) {
			await expect(
				fixture.account.putLeaseIntent({
					...testIntent(run, "unsafe-project"),
					requestedShape: {
						computeType: "GPU",
						gpuTypeId: "NVIDIA H100 80GB HBM3",
						gpuCount: 8,
						image: "safe/image:1",
						cloud: "SECURE",
						maxHourlyPrice: 26,
						maxRuntimeMinutes: 60,
						maxSpend: 26,
						containerDiskInGb: 50,
						volumeInGb: 0,
						allowedCudaVersions: [],
					},
				}),
			).rejects.toBeDefined();
		}
		expect(provider.creates).toBe(0);
		expect(provider.pods).toHaveLength(0);
		await fixture.account.stop();
	});
});
