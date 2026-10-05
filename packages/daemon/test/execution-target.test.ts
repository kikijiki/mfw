import { describe, expect, test } from "bun:test";
import type { LaunchSpec, RunExit } from "../src/agent-host.ts";
import {
	type ExecutionOwnership,
	ExecutionTargetRegistry,
	executionOwnerKey,
	InvalidExecutionTargetRequirementsError,
	resolveExecutionTarget,
	targetOperationId,
	UnknownExecutionTargetError,
} from "../src/execution-target.ts";
import {
	type LocalExecutionHost,
	LocalExecutionTarget,
	type LocalWorktreePort,
} from "../src/local-execution-target.ts";

describe("execution target resolution", () => {
	test("separates execution-host, project semaphore, and local staging requirements", () => {
		const local = resolveExecutionTarget({
			kind: "local",
			requiresResources: [
				"serial-tests",
				{ scope: "project", id: "database" },
				{ scope: "host", id: "cpu", amount: 4 },
				{ scope: "host", id: "ram", amount: "8 GiB" },
			],
		});

		expect(local.requirements).toEqual({
			executionHost: [
				{ scope: "host", id: "cpu", amount: 4 },
				{ scope: "host", id: "ram", amount: "8 GiB" },
			],
			projectSemaphores: [
				{ scope: "project", id: "serial-tests", amount: 1 },
				{ scope: "project", id: "database", amount: 1 },
			],
			localStaging: [],
		});
	});

	test("rejects execution-host requirements for a remote target during pure resolution", () => {
		expect(() =>
			resolveExecutionTarget({
				kind: "remote-test",
				requiresResources: [{ scope: "host", id: "gpu" }],
			}),
		).toThrow(InvalidExecutionTargetRequirementsError);
	});

	test("allows explicit local staging only for remote targets", () => {
		expect(
			resolveExecutionTarget({
				kind: "remote-test",
				localStagingResources: [{ scope: "host", id: "disk-io", amount: 1 }],
			}).requirements,
		).toEqual({
			executionHost: [],
			projectSemaphores: [],
			localStaging: [{ scope: "host", id: "disk-io", amount: 1 }],
		});
		expect(() =>
			resolveExecutionTarget({
				kind: "local",
				localStagingResources: [{ scope: "host", id: "disk-io", amount: 1 }],
			}),
		).toThrow(InvalidExecutionTargetRequirementsError);
	});

	test("rejects duplicate scoped requirements before admission", () => {
		expect(() =>
			resolveExecutionTarget({
				kind: "local",
				requiresResources: ["serial", { scope: "project", id: "serial" }],
			}),
		).toThrow("duplicate project resource 'serial'");
		expect(() =>
			resolveExecutionTarget({
				kind: "local",
				requiresResources: [
					{ scope: "host", id: "ram", amount: "1 GiB" },
					{ scope: "host", id: "ram", amount: "2 GiB" },
				],
			}),
		).toThrow("duplicate host resource 'ram'");
		expect(() =>
			resolveExecutionTarget({
				kind: "remote-test",
				localStagingResources: [
					{ scope: "host", id: "disk", amount: 1 },
					{ scope: "host", id: "disk", amount: 2 },
				],
			}),
		).toThrow("duplicate host resource 'disk'");
	});

	test("keeps stable owner and operation keys and fails closed for missing adapters", () => {
		const ownerKey = executionOwnerKey("project-01", "run-01", 2);
		const owner: ExecutionOwnership = {
			projectId: "project-01",
			projectName: "demo",
			runId: "run-01",
			taskId: "MFW-95",
			attempt: 2,
			ownerKey,
		};
		expect(targetOperationId(owner, "launch/intent")).toBe(
			"project-01/run-01/2/launch/intent",
		);
		expect(() => new ExecutionTargetRegistry().require("remote-test")).toThrow(
			UnknownExecutionTargetError,
		);
	});
});

class FakeHost implements LocalExecutionHost {
	launches = 0;
	alive = false;
	exit: RunExit = { kind: "running" };
	controls: unknown[] = [];
	kills = 0;

	async launch(_spec: LaunchSpec): Promise<void> {
		this.launches++;
		this.alive = true;
	}
	async isAlive(): Promise<boolean> {
		return this.alive;
	}
	async readExit(): Promise<RunExit> {
		return this.exit;
	}
	async appendControl(_runDir: string, event: unknown): Promise<void> {
		this.controls.push(event);
	}
	async appendSteer(_runDir: string, message: string): Promise<void> {
		this.controls.push({ legacySteer: message });
	}
	async kill(): Promise<void> {
		this.kills++;
		this.alive = false;
		this.exit = { kind: "killed", reason: "test" };
	}
}

describe("LocalExecutionTarget", () => {
	test("preserves canonical worktree behavior and makes launch/control/dispose retry-safe", async () => {
		const host = new FakeHost();
		let worktreeCreates = 0;
		const worktrees: LocalWorktreePort = {
			async create(runId) {
				worktreeCreates++;
				return {
					path: `/project/worktrees/${runId}`,
					branch: `mfw/${runId}`,
					baseSha: "abc123",
				};
			},
			async remove() {},
		};
		const target = new LocalExecutionTarget({
			projectRoot: "/project",
			integrationBranch: "main",
			host,
			worktrees,
		});
		const owner: ExecutionOwnership = {
			projectId: "project-1",
			projectName: "demo",
			runId: "run-1",
			taskId: "MFW-95",
			attempt: 1,
			ownerKey: executionOwnerKey("project-1", "run-1", 1),
		};
		const prepared = await target.prepare({
			owner,
			runDir: "/runs/run-1",
			projectRoot: "/project",
			integrationBranch: "main",
			requestedShape: {},
		});
		expect(worktreeCreates).toBe(1);
		expect(host.launches).toBe(0);
		expect(prepared.workspace).toEqual({
			canonicalPath: "/project/worktrees/run-1",
			executionPath: "/project/worktrees/run-1",
			branch: "mfw/run-1",
			baseSha: "abc123",
		});

		const launch = {
			owner,
			runDir: "/runs/run-1",
			projectRoot: "/project",
			workspace: prepared.workspace,
			globalLeaseRef: null,
			driver: {
				driverScript: "/driver.ts",
				agentArgv: ["agent"],
				env: {},
				model: "test",
				reasoningEffort: "medium" as const,
				initialMessage: "go",
				steer: true,
				approvalMode: "autonomous" as const,
			},
		};
		await target.launch(launch);
		await target.launch(launch);
		expect(host.launches).toBe(1);

		const ref = {
			owner,
			runDir: launch.runDir,
			globalLeaseRef: null,
			workspace: prepared.workspace,
		};
		expect((await target.observe(ref)).state).toBe("running");
		await target.control(ref, {
			type: "steer",
			message: "continue",
			interruptCapable: true,
		});
		expect(host.controls).toEqual([{ type: "steer", message: "continue" }]);
		expect((await target.collect(ref)).observedShape).toEqual({
			host: "daemon",
			transport: "tmux",
		});
		expect((await target.inventory([ref]))[0]?.ownerKey).toBe(owner.ownerKey);
		expect((await target.reconcile([ref])).errors).toEqual([]);
		expect((await target.dispose(ref)).absenceConfirmed).toBe(true);
		expect(host.kills).toBe(1);
	});
});
