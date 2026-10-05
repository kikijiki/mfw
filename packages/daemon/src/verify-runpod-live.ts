import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecutionEnvironmentBuilder } from "./execution-environment.ts";
import { silentLogger } from "./log.ts";
import { runProc } from "./proc.ts";
import { RunPodSshTransport } from "./remote-agent-host.ts";
import { RunPodAccountService } from "./runpod-account-service.ts";
import { MFW_RUNPOD_CPU_IMAGE, RunPodClient } from "./runpod-client.ts";
import { decodeRunPodOwnership } from "./runpod-ownership.ts";
import type { EnabledRunPodMachinePolicy } from "./runpod-policy.ts";
import {
	MFW_RUNPOD_CPU_READY_PATH,
	mfwRunPodCpuBootstrapCommand,
} from "./runpod-runtime.ts";

const MAX_HOURLY_PRICE = 0.25;
const MAX_AGGREGATE_HOURLY_PRICE = 0.6;
const MAX_RUNTIME_SECONDS = 300;
const MAX_TOTAL_SPEND = 0.022;
const CPU_FLAVOR = "cpu3m" as const;
const IMAGE = MFW_RUNPOD_CPU_IMAGE;
const ACCOUNT_ID = "mfw-live-verification";

function argument(name: string): string | null {
	const index = process.argv.indexOf(name);
	return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

function requireLiveGate(): void {
	if (
		process.env.MFW_RUNPOD_LIVE !== "1" ||
		process.env.MFW_RUNPOD_LIVE_ACK !== "I_ACCEPT_CAPPED_RUNPOD_SPEND"
	) {
		throw new Error(
			"live verification requires MFW_RUNPOD_LIVE=1 and MFW_RUNPOD_LIVE_ACK=I_ACCEPT_CAPPED_RUNPOD_SPEND",
		);
	}
	if (argument("--max-pods") !== "1") throw new Error("--max-pods must be 1");
	const runtime = Number(argument("--max-runtime-seconds"));
	if (
		!Number.isInteger(runtime) ||
		runtime <= 0 ||
		runtime > MAX_RUNTIME_SECONDS
	) {
		throw new Error(`--max-runtime-seconds must be 1-${MAX_RUNTIME_SECONDS}`);
	}
	if (!process.argv.includes("--require-zero-before")) {
		throw new Error("--require-zero-before is mandatory");
	}
	if (!process.argv.includes("--require-zero-after")) {
		throw new Error("--require-zero-after is mandatory");
	}
	if (!process.env.RUNPOD_API_KEY?.trim()) {
		throw new Error("RUNPOD_API_KEY is missing from the approved environment");
	}
}

function client(): RunPodClient {
	return new RunPodClient({
		credentials: { apiKey: async () => process.env.RUNPOD_API_KEY },
	});
}

function ownedByNamespace(
	pods: Awaited<ReturnType<RunPodClient["listPods"]>>,
	namespace: string,
) {
	return pods.filter(
		(pod) =>
			decodeRunPodOwnership(pod.env.MFW_RUNPOD_OWNERSHIP_V1)?.ns === namespace,
	);
}

async function proveAbsent(
	provider: RunPodClient,
	namespace: string,
): Promise<void> {
	for (let attempt = 1; attempt <= 12; attempt++) {
		const owned = ownedByNamespace(await provider.listPods(), namespace);
		if (owned.length === 0) return;
		if (owned.length > 1) {
			throw new Error("live namespace exceeded the hard one-Pod invariant");
		}
		await provider.deletePod(owned[0]?.id ?? "");
		await Bun.sleep(Math.min(5_000, attempt * 500));
	}
	throw new Error(
		"fresh RunPod inventory did not prove the live namespace empty",
	);
}

async function sweepOnly(namespace: string): Promise<void> {
	const provider = client();
	const owned = ownedByNamespace(await provider.listPods(), namespace);
	if (owned.length > 1) {
		throw new Error("second-process sweeper found more than one owned Pod");
	}
	for (const pod of owned) await provider.deletePod(pod.id);
	await proveAbsent(provider, namespace);
	console.log(
		JSON.stringify({
			phase: "second-process-absence-proof",
			namespace,
			ownedPods: 0,
		}),
	);
}

async function runDirectSshProof(input: {
	provider: RunPodClient;
	account: RunPodAccountService;
	leaseRef: string;
	namespace: string;
	deadline: number;
}): Promise<{ host: string; port: number }> {
	let pod: Awaited<ReturnType<RunPodClient["listPods"]>>[number] | undefined;
	let connection: Awaited<ReturnType<RunPodAccountService["connection"]>> =
		null;
	while (Date.now() < input.deadline) {
		pod = ownedByNamespace(await input.provider.listPods(), input.namespace)[0];
		connection = await input.account.connection(input.leaseRef);
		if (
			pod?.desiredStatus === "RUNNING" &&
			pod.publicIp &&
			pod.portMappings["22"] &&
			connection
		) {
			break;
		}
		await Bun.sleep(5_000);
	}
	const host = pod?.publicIp;
	const port = pod?.portMappings["22"];
	if (!host || !port || !connection) {
		throw new Error(
			"RunPod did not expose a ready direct SSH endpoint before the deadline",
		);
	}
	const keyscan = Bun.which("ssh-keyscan");
	if (!keyscan) throw new Error("OpenSSH host-key scanner is unavailable");
	const scanKeys = async (): Promise<string[]> => {
		const scan = await runProc(
			[keyscan, "-T", "10", "-p", String(port), host],
			{
				env: new ExecutionEnvironmentBuilder().build(),
				timeoutMs: 15_000,
				maxOutputBytes: 32 * 1024,
			},
		);
		if (scan.exitCode !== 0 || scan.timedOut) {
			throw new Error("direct SSH host-key scan failed");
		}
		return scan.stdout
			.split(/\r?\n/)
			.map((line) => line.trim().split(/\s+/))
			.filter(
				(parts) =>
					parts.length >= 3 &&
					/^(?:ssh-ed25519|ecdsa-sha2-nistp(?:256|384|521)|ssh-rsa)$/.test(
						parts[1] ?? "",
					) &&
					/^[A-Za-z0-9+/]+={0,2}$/.test(parts[2] ?? ""),
			)
			.map((parts) => `${parts[1]} ${parts[2]}`)
			.sort();
	};
	const firstKeys = await scanKeys();
	await Bun.sleep(1_000);
	const secondKeys = await scanKeys();
	if (
		firstKeys.length === 0 ||
		JSON.stringify(firstKeys) !== JSON.stringify(secondKeys)
	) {
		throw new Error("direct SSH host-key scans were empty or inconsistent");
	}
	if (!firstKeys.includes(connection.endpoint.hostPublicKey)) {
		throw new Error(
			"pinned SSH identity was absent from the repeated live scan",
		);
	}
	const transport = new RunPodSshTransport({
		endpoint: connection.endpoint,
		commandTimeoutMs: Math.max(1, input.deadline - Date.now()),
		maxOutputBytes: 32 * 1024,
		isPodPresent: (podId) => input.account.podPresent(podId),
	});
	await transport.waitUntilReady(input.deadline);
	await transport.run(mfwRunPodCpuBootstrapCommand(), {
		timeoutMs: Math.max(1, input.deadline - Date.now()),
	});
	const result = await transport.run([
		"/bin/bash",
		"-lc",
		`test -f ${MFW_RUNPOD_CPU_READY_PATH} && bun --version >/dev/null && git --version >/dev/null && codex --version >/dev/null && claude --version >/dev/null && printf mfw-runpod-live-ok`,
	]);
	if (result.stdout.trim() !== "mfw-runpod-live-ok") {
		throw new Error("direct SSH runtime proof returned an unexpected result");
	}
	return { host, port };
}

async function main(): Promise<void> {
	requireLiveGate();
	const sweepNamespace = argument("--sweep-only");
	if (sweepNamespace) {
		await sweepOnly(sweepNamespace);
		return;
	}
	const runtimeSeconds = Number(argument("--max-runtime-seconds"));
	const namespace = `mfw-live-${Date.now()}-${randomUUID().slice(0, 8)}`;
	const provider = client();
	const before = ownedByNamespace(await provider.listPods(), namespace);
	if (before.length !== 0)
		throw new Error("live namespace was not empty before create");
	console.log(
		JSON.stringify({ phase: "zero-before", namespace, ownedPods: 0 }),
	);

	const home = await mkdtemp(join(tmpdir(), "mfw-runpod-live-"));
	const policy: EnabledRunPodMachinePolicy = {
		enabled: true,
		accountId: ACCOUNT_ID,
		ownershipNamespace: namespace,
		allowedGpuTypes: [],
		allowedCpuFlavors: [CPU_FLAVOR],
		allowedImages: [IMAGE],
		allowedClouds: ["SECURE"],
		maxHourlyPrice: MAX_HOURLY_PRICE,
		maxAggregateHourlyPrice: MAX_AGGREGATE_HOURLY_PRICE,
		maxRuntimeMinutes: Math.ceil(runtimeSeconds / 60),
		maxRunSpend: MAX_TOTAL_SPEND,
	};
	const account = new RunPodAccountService({
		mfwHome: home,
		policy,
		client: provider,
		log: silentLogger(),
		absenceAttempts: 8,
		absenceDelayMs: 1_000,
	});
	let leaseRef: string | null = null;
	let failure: unknown = null;
	const deadline = Date.now() + runtimeSeconds * 1_000;
	try {
		await account.start();
		const lease = await account.putLeaseIntent({
			operationId: `${namespace}/create`,
			targetKind: "runpod",
			owner: {
				projectId: "runpod-live-verification",
				projectName: "runpod-live-verification",
				runId: `live-${randomUUID()}`,
				taskId: "MFW-100",
				attempt: 1,
				ownerKey: `${namespace}/owner`,
			},
			requestedShape: {
				computeType: "CPU",
				cpuFlavorId: CPU_FLAVOR,
				vcpuCount: 2,
				memoryInGb: 16,
				image: IMAGE,
				cloud: "SECURE",
				maxHourlyPrice: MAX_HOURLY_PRICE,
				maxRuntimeMinutes: Math.ceil(runtimeSeconds / 60),
				maxSpend: MAX_TOTAL_SPEND,
				containerDiskInGb: 20,
				volumeInGb: 0,
			},
		});
		leaseRef = lease.ref;
		await account.command(lease.ref, `${namespace}/provision`, {
			type: "provision",
		});
		const model = await account.readModel();
		const pod = model.pods.find(
			(candidate) => candidate.live && candidate.ownership === "owned_tracked",
		);
		if (!pod)
			throw new Error("fresh account view did not contain the owned live Pod");
		if (pod.hourlyBurn === null || pod.hourlyBurn > MAX_HOURLY_PRICE) {
			throw new Error("provider rate exceeded the compiled live-test ceiling");
		}
		if (
			pod.actualShape.computeType !== "CPU" ||
			pod.actualShape.gpuCount !== 0
		) {
			throw new Error("provider did not provision the CPU-only shape");
		}
		console.log(
			JSON.stringify({
				phase: "provisioned",
				podId: pod.podId,
				cpuFlavorId: pod.actualShape.offeringId,
				gpuCount: pod.actualShape.gpuCount,
				hourlyPrice: pod.hourlyBurn,
				maxHourlyPrice: MAX_HOURLY_PRICE,
				deadline,
			}),
		);
		const executed = await runDirectSshProof({
			provider,
			account,
			leaseRef: lease.ref,
			namespace,
			deadline,
		});
		console.log(
			JSON.stringify({
				phase: "executed",
				podId: pod.podId,
				transport: "isolated-tofu-direct-ssh",
				hostKeyApproved: true,
				port: executed.port,
			}),
		);
	} catch (error) {
		failure = error;
		const observed = await account.readModel().catch(() => null);
		if (observed) {
			const rejection = observed.audit.find(
				(entry) =>
					entry.kind === "runpod_decision" &&
					entry.detail.result === "policy_violation",
			);
			console.log(
				JSON.stringify({
					phase: "failed-closed-observation",
					code:
						error && typeof error === "object" && "code" in error
							? error.code
							: "unknown",
					violations: rejection?.detail.reason ?? null,
					sshEvidence: rejection?.detail.sshEvidence ?? null,
					pods: observed.pods.map((pod) => ({
						podId: pod.podId,
						live: pod.live,
						phase: pod.phase,
						actualShape: pod.actualShape,
					})),
				}),
			);
		}
	} finally {
		if (leaseRef) {
			await account
				.command(leaseRef, `${namespace}/finally-dispose`, {
					type: "dispose",
					reason: "live verification finally",
				})
				.catch(() => {});
		}
		await account.stop().catch(() => {});
		const child = Bun.spawn(
			[
				process.execPath,
				import.meta.path,
				"--sweep-only",
				namespace,
				"--max-pods",
				"1",
				"--max-runtime-seconds",
				String(runtimeSeconds),
				"--require-zero-before",
				"--require-zero-after",
			],
			{ env: process.env, stdout: "inherit", stderr: "inherit" },
		);
		if ((await child.exited) !== 0) {
			failure ??= new Error("fresh second-process sweeper failed");
		}
		await rm(home, { recursive: true, force: true });
	}
	if (failure) throw failure;
}

await main();
