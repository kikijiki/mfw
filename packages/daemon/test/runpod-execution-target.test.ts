import { afterEach, describe, expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	BASE_EXECUTION_ENVIRONMENT,
	SecretEnvironment,
} from "../src/execution-environment.ts";
import type {
	ExecutionOwnership,
	ProviderLease,
	ProviderLeaseCommand,
} from "../src/execution-target.ts";
import { ExecutionLaunchUncertainError } from "../src/execution-target.ts";
import { git, gitOk } from "../src/git.ts";
import { RemoteTransportError } from "../src/remote-agent-host.ts";
import type { RunPodLeaseConnection } from "../src/runpod-account-service.ts";
import { MFW_RUNPOD_CPU_IMAGE } from "../src/runpod-client.ts";
import {
	RemoteEvidenceSecretsUnavailableError,
	RemoteSecretLeakError,
	type RunPodExecutionAccount,
	RunPodExecutionTarget,
	type RunPodExecutionTransport,
} from "../src/runpod-execution-target.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

async function scanTextArtifacts(root: string): Promise<string> {
	let content = "";
	for (const entry of await readdir(root, { withFileTypes: true })) {
		if (entry.name === ".git") continue;
		const path = join(root, entry.name);
		content += entry.isDirectory()
			? await scanTextArtifacts(path)
			: await readFile(path, "utf8").catch(() => "");
	}
	return content;
}

const owner: ExecutionOwnership = {
	projectId: "project-98",
	projectName: "target-test",
	runId: "run98",
	taskId: "MFW-98",
	attempt: 1,
	ownerKey: "project-98/run98/1",
};

class FakeAccount implements RunPodExecutionAccount {
	readonly ref = "runpod_0123456789abcdef0123456789abcdef";
	readonly commands: ProviderLeaseCommand[] = [];
	disposeHook?: () => Promise<void>;
	private phase = "intent";
	requestedShape: Record<string, unknown> = { computeType: "CPU" };

	private lease(): ProviderLease {
		return {
			ref: this.ref,
			targetKind: "runpod",
			ownerKey: owner.ownerKey,
			requestedShape: this.requestedShape,
			observedShape: { phase: this.phase, providerPodId: "pod98" },
		};
	}

	async putLeaseIntent(): Promise<ProviderLease> {
		return this.lease();
	}

	async command(
		_ref: string,
		_operationId: string,
		command: ProviderLeaseCommand,
	): Promise<ProviderLease> {
		this.commands.push(command);
		if (command.type === "provision") this.phase = "ready";
		if (command.type === "phase") this.phase = command.phase;
		if (command.type === "dispose") {
			this.phase = "absent";
			await this.disposeHook?.();
		}
		return this.lease();
	}

	async observe(): Promise<ProviderLease> {
		return this.lease();
	}

	async inventory(): Promise<ProviderLease[]> {
		return [this.lease()];
	}

	async reconcile(): Promise<void> {}

	async connection(): Promise<RunPodLeaseConnection | null> {
		if (this.phase === "absent" || this.phase === "intent") return null;
		return {
			lease: this.lease(),
			endpoint: {
				mode: "runpod-basic",
				podId: "pod98",
				principal: "pod98-account98",
				host: "ssh.runpod.io",
				privateKeyPath: "/machine/account/lease-key",
				hostPublicKey: `ssh-ed25519 ${Buffer.alloc(32, 8).toString("base64")}`,
			},
		};
	}

	async podPresent(): Promise<boolean> {
		return this.phase !== "absent";
	}
}

class LocalRemoteTransport implements RunPodExecutionTransport {
	runWithSecretsCalls = 0;
	downloadCalls = 0;
	forbidDownloads = false;
	launchResponseFailure?: "network_lost" | "deadline_exceeded";
	detachLaunch = false;
	launchDone?: Promise<number>;
	runtimeReadyChecks = 0;
	runtimeBootstrapCalls = 0;
	async waitUntilReady(): Promise<void> {}

	async run(
		command: readonly string[],
	): Promise<{ stdout: string; stderr: string }> {
		if (command[0] === "flock" && command[2] === "/run/mfw-bootstrap.lock") {
			this.runtimeBootstrapCalls++;
			return { stdout: "", stderr: "" };
		}
		if (command.join("\0") === "test\0-f\0/run/mfw-ready") {
			this.runtimeReadyChecks++;
			return { stdout: "", stderr: "" };
		}
		const child = Bun.spawn([...command], { stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		if (code !== 0)
			throw new RemoteTransportError(
				"remote_exit",
				`remote command failed: ${stderr}`,
				code,
			);
		return { stdout, stderr };
	}

	async runWithSecrets(
		command: readonly string[],
		publicEnvironment: Readonly<Record<string, string>>,
		secrets: SecretEnvironment,
	): Promise<{
		exitCode: number;
		stdout: string;
		stderr: string;
		truncated: boolean;
	}> {
		this.runWithSecretsCalls++;
		// Execute the detached payload synchronously in the fake so assertions see
		// deterministic artifacts; production uses the pinned SSH transport.
		const launch = [...command.slice(2)];
		launch[0] = process.execPath;
		const child = Bun.spawn(launch, {
			env: {
				...BASE_EXECUTION_ENVIRONMENT,
				PATH: `${dirname(process.execPath)}:${BASE_EXECUTION_ENVIRONMENT.PATH}`,
				...publicEnvironment,
				...secrets.materializeForLaunch(),
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		if (this.detachLaunch) {
			this.launchDone = Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]).then(([, , exitCode]) => exitCode);
			return {
				stdout: "",
				stderr: "",
				exitCode: 0,
				truncated: false,
			};
		}
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		if (exitCode !== 0) {
			throw new RemoteTransportError(
				"remote_exit",
				"secret launch failed",
				exitCode,
			);
		}
		if (this.launchResponseFailure) {
			throw new RemoteTransportError(
				this.launchResponseFailure,
				"detached launch response was lost",
			);
		}
		return { stdout, stderr, exitCode, truncated: false };
	}

	async upload(path: string, bytes: Uint8Array): Promise<void> {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, bytes);
	}

	async download(path: string): Promise<Uint8Array> {
		this.downloadCalls++;
		if (this.forbidDownloads) {
			throw new Error("evidence download must be blocked");
		}
		try {
			return await readFile(path);
		} catch (error) {
			if (
				typeof error === "object" &&
				error !== null &&
				"code" in error &&
				error.code === "ENOENT"
			) {
				throw new RemoteTransportError("remote_exit", "remote file is absent");
			}
			throw error;
		}
	}
}

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "mfw-runpod-target-"));
	roots.push(root);
	await git(["init", "-q", "-b", "main"], root);
	await git(["config", "user.email", "test@example.invalid"], root);
	await git(["config", "user.name", "test"], root);
	await writeFile(join(root, "base.txt"), "base\n");
	await git(["add", "-A"], root);
	await git(["commit", "-q", "-m", "base"], root);
	const baseSha = await gitOk(["rev-parse", "HEAD"], root);
	const runDir = join(root, "run");
	await mkdir(runDir);
	const driver = join(root, "fake-remote-driver.ts");
	await writeFile(
		driver,
		`const runDir = process.argv[2];
const cfg = await Bun.file(runDir + "/driver.json").json();
const countPath = cfg.cwd + "/driver-start-count.txt";
const count = Number(await Bun.file(countPath).text().catch(() => "0"));
await Bun.write(countPath, String(count + 1));
await Bun.write(cfg.cwd + "/remote-output.txt", "collected\\n");
await Bun.write(cfg.cwd + "/credential-ok.txt", process.env.CODEX_API_KEY && !process.env.MFW98_AMBIENT_CANARY ? "yes\\n" : "no\\n");
await Bun.write(cfg.env.MFW_REPORT_PATH, JSON.stringify({ summary: "remote complete" }));
await Bun.write(runDir + "/events.jsonl", JSON.stringify({ type: "done", reason: "complete" }) + "\\n");
`,
	);
	const account = new FakeAccount();
	account.disposeHook = () =>
		rm(join(root, "remote-machine"), { recursive: true, force: true });
	const transport = new LocalRemoteTransport();
	const target = new RunPodExecutionTarget({
		account,
		projectRoot: root,
		integrationBranch: "main",
		remoteRoot: join(root, "remote-machine"),
		remoteGitPath: Bun.which("git") as string,
		transport: () => transport,
	});
	return { root, runDir, driver, baseSha, account, transport, target };
}

describe("RunPod ExecutionTarget integration", () => {
	test("waits for the managed CPU runtime bootstrap marker before staging", async () => {
		const f = await fixture();
		f.account.requestedShape = {
			computeType: "CPU",
			image: MFW_RUNPOD_CPU_IMAGE,
		};
		const prepared = await f.target.prepare({
			owner,
			runDir: f.runDir,
			projectRoot: f.root,
			integrationBranch: "main",
			requestedShape: f.account.requestedShape,
			reuse: { worktreePath: f.root, branch: "main", baseSha: f.baseSha },
		});
		await f.target.launch({
			owner,
			runDir: f.runDir,
			projectRoot: f.root,
			workspace: prepared.workspace,
			globalLeaseRef: prepared.globalLeaseRef,
			driver: {
				driverScript: f.driver,
				agentArgv: ["true"],
				env: { MFW_RUN_ID: owner.runId },
				model: "test",
				reasoningEffort: "medium",
				initialMessage: "execute",
				steer: true,
				approvalMode: "autonomous",
			},
		});
		expect(f.transport.runtimeBootstrapCalls).toBe(1);
		expect(f.transport.runtimeReadyChecks).toBe(1);
	}, 30_000);

	for (const failure of ["network_lost", "deadline_exceeded"] as const) {
		test(`a ${failure} response after detached launch is adopted without duplicate execution`, async () => {
			const f = await fixture();
			const prepared = await f.target.prepare({
				owner,
				runDir: f.runDir,
				projectRoot: f.root,
				integrationBranch: "main",
				requestedShape: { computeType: "CPU" },
				reuse: { worktreePath: f.root, branch: "main", baseSha: f.baseSha },
			});
			const localTransport = f.transport;
			localTransport.launchResponseFailure = failure;
			const request = {
				owner,
				runDir: f.runDir,
				projectRoot: f.root,
				workspace: prepared.workspace,
				globalLeaseRef: prepared.globalLeaseRef,
				driver: {
					driverScript: f.driver,
					agentArgv: ["true"],
					env: { MFW_RUN_ID: owner.runId },
					model: "test",
					reasoningEffort: "medium" as const,
					initialMessage: "execute once",
					steer: true,
					approvalMode: "autonomous" as const,
				},
			};
			await expect(f.target.launch(request)).rejects.toBeInstanceOf(
				ExecutionLaunchUncertainError,
			);
			expect(localTransport.runWithSecretsCalls).toBe(1);
			localTransport.launchResponseFailure = undefined;
			await f.target.launch(request);
			expect(localTransport.runWithSecretsCalls).toBe(1);
			expect(
				await readFile(
					join(
						f.root,
						"remote-machine",
						f.account.ref,
						"worktree",
						"driver-start-count.txt",
					),
					"utf8",
				),
			).toBe("1");
			expect(
				(
					await f.target.observe({
						owner,
						runDir: f.runDir,
						globalLeaseRef: prepared.globalLeaseRef,
						workspace: prepared.workspace,
					})
				).state,
			).toBe("exited");
		}, 30_000);
	}

	test("intent, provision, stage, detached driver, evidence collection, and proven delete", async () => {
		const f = await fixture();
		const canary = "MFW98_REMOTE_SECRET_7uK";
		process.env.MFW98_AMBIENT_CANARY = "must-not-cross";
		const prepared = await f.target.prepare({
			owner,
			runDir: f.runDir,
			projectRoot: f.root,
			integrationBranch: "main",
			requestedShape: { computeType: "CPU" },
			reuse: { worktreePath: f.root, branch: "main", baseSha: f.baseSha },
		});
		expect(f.account.commands).toEqual([]);

		await f.target.launch({
			owner,
			runDir: f.runDir,
			projectRoot: f.root,
			workspace: prepared.workspace,
			globalLeaseRef: prepared.globalLeaseRef,
			driver: {
				driverScript: f.driver,
				agentArgv: ["true"],
				env: { MFW_RUN_ID: owner.runId },
				model: "test",
				reasoningEffort: "medium",
				initialMessage: "execute",
				steer: true,
				approvalMode: "autonomous",
				secretEnvironment: new SecretEnvironment({
					CODEX_API_KEY: canary,
				}),
			},
		});
		delete process.env.MFW98_AMBIENT_CANARY;
		expect(
			(
				await f.target.observe({
					owner,
					runDir: f.runDir,
					globalLeaseRef: prepared.globalLeaseRef,
					workspace: prepared.workspace,
				})
			).state,
		).toBe("exited");

		const ref = {
			owner,
			runDir: f.runDir,
			globalLeaseRef: prepared.globalLeaseRef,
			workspace: prepared.workspace,
			secretEnvironment: new SecretEnvironment({ CODEX_API_KEY: canary }),
		};
		await f.target.collect(ref);
		expect(await readFile(join(f.root, "remote-output.txt"), "utf8")).toBe(
			"collected\n",
		);
		expect(await readFile(join(f.root, "credential-ok.txt"), "utf8")).toBe(
			"yes\n",
		);
		expect(
			await Bun.file(
				join(f.runDir, "remote-worktree", "collection-receipt.json"),
			).exists(),
		).toBe(true);
		expect((await f.target.dispose(ref)).absenceConfirmed).toBe(true);
		expect(f.account.commands.map((command) => command.type)).toEqual([
			"provision",
			"phase",
			"phase",
			"phase",
			"dispose",
		]);
		expect(await scanTextArtifacts(f.root)).not.toContain(canary);
	}, 30_000);

	test("redacts hostile logs and events, rejects a secret-bearing collection, then tears down", async () => {
		const f = await fixture();
		const canary = "MFW98_HOSTILE_SECRET_q9L";
		await writeFile(
			f.driver,
			`const runDir = process.argv[2];
const cfg = await Bun.file(runDir + "/driver.json").json();
const secret = process.env.CODEX_API_KEY;
console.log("stdout:" + secret);
console.error("stderr:" + secret);
await Bun.write(runDir + "/events.jsonl", JSON.stringify({ type: "message", text: secret }) + "\\n");
await Bun.write(cfg.cwd + "/leaked-secret.txt", secret);
await Bun.write(cfg.env.MFW_REPORT_PATH, JSON.stringify({ summary: "hostile leak" }));
await Bun.sleep(750);
`,
		);
		f.transport.detachLaunch = true;
		const secretEnvironment = new SecretEnvironment({ CODEX_API_KEY: canary });
		const prepared = await f.target.prepare({
			owner,
			runDir: f.runDir,
			projectRoot: f.root,
			integrationBranch: "main",
			requestedShape: { computeType: "CPU" },
			reuse: { worktreePath: f.root, branch: "main", baseSha: f.baseSha },
		});
		await f.target.launch({
			owner,
			runDir: f.runDir,
			projectRoot: f.root,
			workspace: prepared.workspace,
			globalLeaseRef: prepared.globalLeaseRef,
			driver: {
				driverScript: f.driver,
				agentArgv: ["true"],
				env: { MFW_RUN_ID: owner.runId },
				model: "test",
				reasoningEffort: "medium",
				initialMessage: "leak",
				steer: true,
				approvalMode: "autonomous",
				secretEnvironment,
			},
		});
		const ref = {
			owner,
			runDir: f.runDir,
			globalLeaseRef: prepared.globalLeaseRef,
			workspace: prepared.workspace,
			secretEnvironment,
		};
		const remoteEvents = join(
			f.root,
			"remote-machine",
			f.account.ref,
			"run",
			"events.jsonl",
		);
		for (let attempt = 0; attempt < 100; attempt++) {
			if (
				(await readFile(remoteEvents, "utf8").catch(() => "")).includes(canary)
			) {
				break;
			}
			await Bun.sleep(10);
		}
		expect(await readFile(remoteEvents, "utf8")).toContain(canary);
		expect((await f.target.observe(ref)).state).toBe("running");
		const raw = await readFile(join(f.runDir, "raw.log"), "utf8");
		const events = await readFile(join(f.runDir, "events.jsonl"), "utf8");
		expect(raw).toContain("[REDACTED]");
		expect(events).toContain("[REDACTED]");
		expect(`${raw}${events}`).not.toContain(canary);
		expect(await f.transport.launchDone).toBe(0);
		await expect(f.target.collect(ref)).rejects.toBeInstanceOf(
			RemoteSecretLeakError,
		);
		expect(await Bun.file(join(f.root, "leaked-secret.txt")).exists()).toBe(
			false,
		);
		expect(
			await Bun.file(join(f.runDir, "remote-worktree", "collections")).exists(),
		).toBe(false);
		expect((await f.target.dispose(ref)).absenceConfirmed).toBe(true);
		expect(`${raw}${events}`).not.toContain(canary);
		expect(await scanTextArtifacts(f.root)).not.toContain(canary);
	}, 30_000);

	test("restart with unavailable credential values observes status only, rejects collection, and deletes", async () => {
		const f = await fixture();
		const canary = "MFW98_REVOKED_AFTER_LAUNCH";
		const prepared = await f.target.prepare({
			owner,
			runDir: f.runDir,
			projectRoot: f.root,
			integrationBranch: "main",
			requestedShape: { computeType: "CPU" },
			reuse: { worktreePath: f.root, branch: "main", baseSha: f.baseSha },
		});
		await f.target.launch({
			owner,
			runDir: f.runDir,
			projectRoot: f.root,
			workspace: prepared.workspace,
			globalLeaseRef: prepared.globalLeaseRef,
			driver: {
				driverScript: f.driver,
				agentArgv: ["true"],
				env: { MFW_RUN_ID: owner.runId },
				model: "test",
				reasoningEffort: "medium",
				initialMessage: "launch before revocation",
				steer: true,
				approvalMode: "autonomous",
				secretEnvironment: new SecretEnvironment({ CODEX_API_KEY: canary }),
			},
		});
		const restarted = new RunPodExecutionTarget({
			account: f.account,
			projectRoot: f.root,
			integrationBranch: "main",
			remoteRoot: join(f.root, "remote-machine"),
			remoteGitPath: Bun.which("git") as string,
			transport: () => f.transport,
		});
		f.transport.forbidDownloads = true;
		const ref = {
			owner,
			runDir: f.runDir,
			globalLeaseRef: prepared.globalLeaseRef,
			workspace: prepared.workspace,
			secretNames: ["CODEX_API_KEY"],
			evidenceSecretsUnavailable: true,
		};
		expect((await restarted.observe(ref)).state).toBe("exited");
		expect(f.transport.downloadCalls).toBe(0);
		expect(await Bun.file(join(f.runDir, "events.jsonl")).exists()).toBe(false);
		await expect(restarted.collect(ref)).rejects.toBeInstanceOf(
			RemoteEvidenceSecretsUnavailableError,
		);
		expect(f.transport.downloadCalls).toBe(0);
		expect((await restarted.dispose(ref)).absenceConfirmed).toBe(true);
		expect(f.account.commands.map((command) => command.type)).toContain(
			"dispose",
		);
		expect(await scanTextArtifacts(f.root)).not.toContain(canary);
	}, 30_000);
});
