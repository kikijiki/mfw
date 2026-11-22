import { describe, expect, test } from "bun:test";
import { refusalFix } from "../src/refusal-fix.ts";
import {
	assertRemoteNotAutonomous,
	assertRemoteTargetEnabled,
	EXPERIMENTAL_REMOTE_ENV,
	type RemoteTargetRefusedError,
	remoteTargetEnabled,
} from "../src/remote-experimental.ts";
import { RunPodExecutionTarget } from "../src/runpod-execution-target.ts";
import { SshExecutionTarget } from "../src/ssh-execution-target.ts";

const prepareRequest = {
	owner: { runId: "r1", ownerKey: "k1" },
	runDir: "/unused",
	projectRoot: "/unused",
	integrationBranch: "main",
	requestedShape: { hostId: "h1" },
} as never;

function refusal(fn: () => unknown): RemoteTargetRefusedError {
	try {
		fn();
	} catch (e) {
		return e as RemoteTargetRefusedError;
	}
	throw new Error("expected a refusal");
}

describe("remote targets are experimental", () => {
	test("off unless explicitly enabled", () => {
		expect(remoteTargetEnabled(undefined, {})).toBe(false);
		expect(
			remoteTargetEnabled(undefined, { [EXPERIMENTAL_REMOTE_ENV]: "0" }),
		).toBe(false);
		expect(
			remoteTargetEnabled(undefined, { [EXPERIMENTAL_REMOTE_ENV]: "1" }),
		).toBe(true);
		expect(remoteTargetEnabled(true, {})).toBe(true);
		expect(remoteTargetEnabled(false, { [EXPERIMENTAL_REMOTE_ENV]: "1" })).toBe(
			false,
		);
	});

	test("disabled target refuses with a code", () => {
		const e = refusal(() => assertRemoteTargetEnabled("ssh", false));
		expect(e.code).toBe("remote_target_disabled");
		expect(() => assertRemoteTargetEnabled("ssh", true)).not.toThrow();
	});

	test("autonomous is refused, interactive allowed", () => {
		const e = refusal(() => assertRemoteNotAutonomous("runpod", "autonomous"));
		expect(e.code).toBe("remote_autonomy_unsupported");
		expect(() =>
			assertRemoteNotAutonomous("runpod", "interactive"),
		).not.toThrow();
	});

	test("the ssh and runpod targets refuse prepare while disabled, before any I/O", async () => {
		const ssh = new SshExecutionTarget({
			hosts: {
				require: async () => {
					throw new Error("touched the registry");
				},
				list: async () => [],
			},
			projectRoot: "/unused",
			integrationBranch: "main",
			enabled: false,
			transport: () => {
				throw new Error("touched transport");
			},
		});
		await expect(ssh.prepare(prepareRequest)).rejects.toMatchObject({
			code: "remote_target_disabled",
		});
		const runpod = new RunPodExecutionTarget({
			account: {
				putLeaseIntent: async () => {
					throw new Error("touched the account");
				},
			} as never,
			projectRoot: "/unused",
			integrationBranch: "main",
			enabled: false,
		});
		await expect(runpod.prepare(prepareRequest)).rejects.toMatchObject({
			code: "remote_target_disabled",
		});
	});

	test("launch refuses autonomous runs before touching the remote", async () => {
		const request = {
			globalLeaseRef: "x",
			driver: { env: {}, approvalMode: "autonomous" },
		} as never;
		const ssh = new SshExecutionTarget({
			hosts: {
				require: async () => {
					throw new Error("touched");
				},
				list: async () => [],
			},
			projectRoot: "/unused",
			integrationBranch: "main",
			enabled: true,
			transport: () => {
				throw new Error("touched");
			},
		});
		await expect(ssh.launch(request)).rejects.toMatchObject({
			code: "remote_autonomy_unsupported",
		});
		const runpod = new RunPodExecutionTarget({
			account: {
				command: async () => {
					throw new Error("touched");
				},
			} as never,
			projectRoot: "/unused",
			integrationBranch: "main",
			enabled: true,
		});
		await expect(runpod.launch(request)).rejects.toMatchObject({
			code: "remote_autonomy_unsupported",
		});
	});

	test("both codes have an exact fix", () => {
		for (const code of [
			"remote_target_disabled",
			"remote_autonomy_unsupported",
		]) {
			const fix = refusalFix(code);
			expect(fix.text).not.toContain("Open the task's admission details");
		}
	});
});
