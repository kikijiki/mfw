import { afterEach, describe, expect, test } from "bun:test";
import {
	chmod,
	mkdtemp,
	readFile,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SecretEnvironment } from "../src/execution-environment.ts";
import { resolveExecutionTarget } from "../src/execution-target.ts";
import {
	type HostConfig,
	HostConfigSchema,
	HostRegistry,
	hostCandidate,
	hostEndpoint,
	hostSlotResourceId,
	registryPinnedPolicy,
} from "../src/host-registry.ts";
import { assessHostProbe, probeHost } from "../src/host-registry-probe.ts";
import {
	HostResourceCoordinator,
	openHostResourceStore,
} from "../src/host-resources/index.ts";
import { HostService } from "../src/host-service.ts";
import { targetHostRequirements } from "../src/project-dispatch-admission.ts";
import {
	generateEphemeralRunPodSshKey,
	loadEphemeralRunPodSshKey,
	RemoteTransportError,
	RunPodSshTransport,
	type SshProcessRunner,
	scanRunPodDirectSshHostKey,
} from "../src/remote-agent-host.ts";
import { SshTransport } from "../src/ssh-transport.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

async function transport(runner: SshProcessRunner, present = true) {
	const root = await mkdtemp(join(tmpdir(), "mfw-ssh-test-"));
	roots.push(root);
	const key = join(root, "key");
	await writeFile(key, "not-a-real-private-key");
	await chmod(key, 0o600);
	return new RunPodSshTransport({
		endpoint: {
			mode: "runpod-basic",
			podId: "pod97",
			principal: "pod97-6441103b",
			host: "ssh.runpod.io",
			privateKeyPath: key,
			hostPublicKey: `ssh-ed25519 ${Buffer.alloc(32, 7).toString("base64")}`,
		},
		carrierRoot: root,
		runner,
		isPodPresent: async () => present,
	});
}

describe("RunPod basic SSH transport", () => {
	test("uses the discovered absolute host-key scanner path on non-FHS hosts", async () => {
		const keyscanPath = "/nix/store/openssh/bin/ssh-keyscan";
		const key = `ssh-ed25519 ${Buffer.alloc(32, 19).toString("base64")}`;
		expect(
			await scanRunPodDirectSshHostKey({
				host: "192.0.2.40",
				port: 22022,
				keyscanPath,
				runner: async (argv) => {
					expect(argv[0]).toBe(keyscanPath);
					return {
						exitCode: 0,
						stdout: `[192.0.2.40]:22022 ${key}\n`,
						stderr: "",
						timedOut: false,
						truncated: false,
						signalCode: null,
					};
				},
			}),
		).toBe(key);
	});

	test("generates, reloads, and disposes a 0600 per-lease Ed25519 identity", async () => {
		const root = await mkdtemp(join(tmpdir(), "mfw-ssh-key-test-"));
		roots.push(root);
		const generated = await generateEphemeralRunPodSshKey({
			identifier: "runpod_97",
			directory: join(root, "account-keys"),
			keygenPath: Bun.which("ssh-keygen") as string,
		});
		expect(generated.publicKey).toStartWith("ssh-ed25519 ");
		expect((await stat(generated.privateKeyPath)).mode & 0o777).toBe(0o600);
		const reloaded = await loadEphemeralRunPodSshKey({
			identifier: "runpod_97",
			directory: join(root, "account-keys"),
			keygenPath: Bun.which("ssh-keygen") as string,
		});
		expect(reloaded.publicKey).toBe(generated.publicKey);
		await reloaded.dispose();
		await expect(stat(generated.privateKeyPath)).rejects.toThrow();
		await expect(stat(`${generated.privateKeyPath}.pub`)).rejects.toThrow();
	});

	test("post-submission loading rejects symlinks, partial evidence, and unsafe modes without mutation", async () => {
		const root = await mkdtemp(join(tmpdir(), "mfw-ssh-attack-"));
		roots.push(root);
		const directory = join(root, "lease");
		const opts = {
			identifier: "runpod_attack",
			directory,
			keygenPath: Bun.which("ssh-keygen") as string,
		};
		const generated = await generateEphemeralRunPodSshKey(opts);
		const privateBytes = await readFile(generated.privateKeyPath);
		const publicBytes = await readFile(`${generated.privateKeyPath}.pub`);

		await chmod(generated.privateKeyPath, 0o644);
		await expect(loadEphemeralRunPodSshKey(opts)).rejects.toThrow(
			"permission-safe regular file",
		);
		expect(await readFile(generated.privateKeyPath)).toEqual(privateBytes);
		await chmod(generated.privateKeyPath, 0o600);

		await rm(`${generated.privateKeyPath}.pub`);
		await expect(loadEphemeralRunPodSshKey(opts)).rejects.toThrow(
			"permission-safe regular file",
		);
		expect(await readFile(generated.privateKeyPath)).toEqual(privateBytes);
		await writeFile(`${generated.privateKeyPath}.pub`, publicBytes, {
			mode: 0o600,
		});

		const outside = join(root, "outside-key");
		await writeFile(outside, privateBytes, { mode: 0o600 });
		await rm(generated.privateKeyPath);
		await symlink(outside, generated.privateKeyPath);
		await expect(loadEphemeralRunPodSshKey(opts)).rejects.toThrow(
			"permission-safe regular file",
		);
		expect(await readFile(outside)).toEqual(privateBytes);

		const realDirectory = join(root, "real-directory");
		const linkedDirectory = join(root, "linked-directory");
		await generateEphemeralRunPodSshKey({ ...opts, directory: realDirectory });
		await symlink(realDirectory, linkedDirectory);
		await expect(
			loadEphemeralRunPodSshKey({ ...opts, directory: linkedDirectory }),
		).rejects.toThrow("real 0700 directory");
	});

	test("pins host and Pod identity with finite OpenSSH deadlines", async () => {
		let argv: string[] = [];
		const target = await transport(async (actual) => {
			argv = actual;
			const knownHostsArg = actual.find((value) =>
				value.startsWith("UserKnownHostsFile="),
			);
			expect(knownHostsArg).toBeDefined();
			const knownHosts = await readFile(
				(knownHostsArg as string).slice("UserKnownHostsFile=".length),
				"utf8",
			);
			expect(knownHosts).toContain("mfw-runpod-pod97 ssh-ed25519");
			return {
				exitCode: 0,
				stdout: "ok\n",
				stderr: "",
				timedOut: false,
				truncated: false,
				signalCode: null,
			};
		});
		await target.run(["printf", "%s", "hello; not shell"]);
		expect(argv).toContain("StrictHostKeyChecking=yes");
		expect(argv).not.toContain("StrictHostKeyChecking=no");
		expect(argv).toContain("HostKeyAlias=mfw-runpod-pod97");
		expect(argv).toContain("pod97-6441103b@ssh.runpod.io");
		expect(argv.at(-1)).toBe("'printf' '%s' 'hello; not shell'");
	});

	test("uses RunPod's full-SSH public IP and mapped port contract", async () => {
		const root = await mkdtemp(join(tmpdir(), "mfw-direct-ssh-test-"));
		roots.push(root);
		const key = join(root, "key");
		await writeFile(key, "not-a-real-private-key");
		await chmod(key, 0o600);
		let argv: string[] = [];
		const target = new RunPodSshTransport({
			endpoint: {
				mode: "runpod-direct",
				podId: "pod97",
				principal: "root",
				host: "194.26.0.7",
				port: 40123,
				privateKeyPath: key,
				hostPublicKey: `ssh-ed25519 ${Buffer.alloc(32, 8).toString("base64")}`,
			},
			carrierRoot: root,
			runner: async (actual) => {
				argv = actual;
				return {
					exitCode: 0,
					stdout: "ok\n",
					stderr: "",
					timedOut: false,
					truncated: false,
					signalCode: null,
				};
			},
		});

		await target.run(["true"]);
		expect(argv).toContain("-p");
		expect(argv).toContain("40123");
		expect(argv).toContain("root@194.26.0.7");
		expect(argv).toContain("StrictHostKeyChecking=yes");
		expect(argv).toContain("HostKeyAlias=mfw-runpod-pod97");
		expect(argv).not.toContain("ssh.runpod.io");
	});

	test("secret values travel only on stdin and are redacted from output", async () => {
		const canary = "MFW97_REMOTE_SECRET_19v";
		let carrierPath: string | undefined;
		const target = await transport(async (argv, opts) => {
			expect(argv.join(" ")).not.toContain(canary);
			expect(opts.input).toContain(canary);
			carrierPath = argv
				.find((value) => value.startsWith("UserKnownHostsFile="))
				?.slice("UserKnownHostsFile=".length);
			return {
				exitCode: 0,
				stdout: `provider accidentally printed ${canary}`,
				stderr: canary,
				timedOut: false,
				truncated: false,
				signalCode: null,
			};
		});
		const result = await target.runWithSecrets(
			["bun", "run", "/opt/mfw/driver.ts", "/run/mfw"],
			{ MFW_RUN_ID: "run-97" },
			new SecretEnvironment({ ANTHROPIC_API_KEY: canary }),
		);
		expect(result.stdout).toContain("[REDACTED]");
		expect(result.stdout).not.toContain(canary);
		expect(result.stderr).not.toContain(canary);
		await expect(readFile(carrierPath as string)).rejects.toThrow();
	});

	test("remote setup and driver launch both materialize an empty ambient environment", async () => {
		const ambientName = "MFW97_REMOTE_AMBIENT_CANARY";
		const ambientValue = "must-never-cross-ssh";
		const remoteCommands: string[] = [];
		const target = await transport(async (argv) => {
			remoteCommands.push(argv.at(-1) as string);
			return {
				exitCode: 0,
				stdout: "",
				stderr: "",
				timedOut: false,
				truncated: false,
				signalCode: null,
			};
		});
		process.env[ambientName] = ambientValue;
		try {
			await target.runWithEnvironment(["/opt/mfw/setup"], {
				MFW_SETUP: "configured",
			});
			await target.runWithSecrets(
				["/opt/mfw/driver"],
				{ MFW_RUN_ID: "run-97" },
				new SecretEnvironment({ TOKEN: "driver-secret" }),
			);
		} finally {
			delete process.env[ambientName];
		}

		expect(remoteCommands).toHaveLength(2);
		for (const command of remoteCommands) {
			expect(command).toStartWith("'env' '-i'");
			expect(command).toContain("'HOME=/tmp/mfw-home'");
			expect(command).not.toContain(ambientName);
			expect(command).not.toContain(ambientValue);
		}
		expect(remoteCommands[0]).toContain("'MFW_SETUP=configured'");
		expect(remoteCommands[1]).toContain("'MFW_RUN_ID=run-97'");
	});

	test("distinguishes Pod absence, network loss, deadline, and remote exit", async () => {
		const result = (exitCode: number | null, timedOut = false) => ({
			exitCode,
			stdout: "provider output is not copied into errors",
			stderr: "connection detail",
			timedOut,
			truncated: false,
			signalCode: null,
		});
		const absent = await transport(async () => result(255), false);
		const lost = await transport(async () => result(255), true);
		const deadline = await transport(async () => result(null, true), true);
		const exited = await transport(async () => result(23), true);
		for (const [target, failure] of [
			[absent, "pod_absent"],
			[lost, "network_lost"],
			[deadline, "deadline_exceeded"],
			[exited, "remote_exit"],
		] as const) {
			const error = await target.run(["true"]).catch((caught) => caught);
			expect(error).toBeInstanceOf(RemoteTransportError);
			expect(error.failure).toBe(failure);
			expect(error.message).not.toContain("provider output");
		}
	});
});

const PINNED_KEY = `ssh-ed25519 ${Buffer.alloc(32, 21).toString("base64")}`;

function registryHost(overrides: Partial<HostConfig> = {}): HostConfig {
	return HostConfigSchema.parse({
		id: "box-a",
		address: "box-a.example.invalid",
		port: 2222,
		user: "agent",
		hostKey: PINNED_KEY,
		trust: "owned",
		...overrides,
	});
}

function probeOutput(fields: Record<string, string>): string {
	const base: Record<string, string> = {
		uid: "1001",
		user: "agent",
		home: "/home/agent",
		path: "/home/agent/.bun/bin:/usr/bin:/bin",
		sudo: "refused",
		"bwrap.path": "/usr/bin/bwrap",
		bwrap: "yes",
		setsid: "/usr/bin/setsid",
		bun: "/home/agent/.bun/bin/bun",
		git: "/usr/bin/git",
		"harness.claude-cli": "2.1.0 (Claude Code)",
		"auth.claude-cli": "yes",
		"harness.codex-cli": "",
		"auth.codex-cli": "no",
		gpus: "0",
		"disk.kib": "1048576",
		"mem.kib": "2097152",
		...fields,
	};
	// A chatty login shell before the marker must not count as an answer.
	return `Welcome to the box\nsudo=refused\nMFW_HOST_PROBE_V1\n${Object.entries(
		base,
	)
		.map(([k, v]) => `${k}=${v}`)
		.join("\n")}\n`;
}

const okResult = {
	exitCode: 0,
	stdout: "",
	stderr: "",
	timedOut: false,
	truncated: false,
	signalCode: null,
};

describe("registry SSH hosts", () => {
	async function key(): Promise<string> {
		const root = await mkdtemp(join(tmpdir(), "mfw-registry-ssh-"));
		roots.push(root);
		const path = join(root, "key");
		await writeFile(path, "not-a-real-private-key");
		await chmod(path, 0o600);
		return path;
	}

	test("endpoint policy accepts a registry-pinned host and refuses an unpinned one", async () => {
		const host = registryHost();
		const policy = registryPinnedPolicy([host]);
		const privateKeyPath = await key();
		let argv: string[] = [];
		const pinned = new SshTransport({
			endpoint: hostEndpoint(host, privateKeyPath),
			policy,
			runner: async (actual) => {
				argv = actual;
				return okResult;
			},
			carrierRoot: dirname(privateKeyPath),
		});
		await pinned.run(["true"]);
		expect(argv).toContain("StrictHostKeyChecking=yes");
		expect(argv).toContain("HostKeyAlias=mfw-host-box-a");
		expect(argv).toContain("agent@box-a.example.invalid");
		expect(argv).toContain("2222");

		let ran = 0;
		const counting = async () => {
			ran++;
			return okResult;
		};
		for (const unpinned of [
			{ ...hostEndpoint(host, privateKeyPath), host: "other.example.invalid" },
			{
				...hostEndpoint(host, privateKeyPath),
				hostPublicKey: `ssh-ed25519 ${Buffer.alloc(32, 9).toString("base64")}`,
			},
			{ ...hostEndpoint(host, privateKeyPath), user: "someone" },
			{ ...hostEndpoint(host, privateKeyPath), port: 22 },
			{ ...hostEndpoint(host, privateKeyPath), alias: "mfw-host-unknown" },
		]) {
			expect(
				() =>
					new SshTransport({ endpoint: unpinned, policy, runner: counting }),
			).toThrow("not a registry-pinned host");
		}
		// A registry edit after construction is enforced on the next command.
		let registry = [host];
		const live = new SshTransport({
			endpoint: hostEndpoint(host, privateKeyPath),
			policy: (endpoint) => registryPinnedPolicy(registry)(endpoint),
			runner: counting,
		});
		registry = [registryHost({ address: "moved.example.invalid" })];
		await expect(live.run(["true"])).rejects.toThrow(
			"not a registry-pinned host",
		);
		expect(ran).toBe(0);
	});

	test("a shared host cannot opt out of bwrap and root is never a host user", () => {
		expect(() => registryHost({ trust: "shared", sandbox: "none" })).toThrow(
			"bwrap is mandatory on a shared host",
		);
		expect(registryHost({ trust: "owned", sandbox: "none" }).sandbox).toBe(
			"none",
		);
		expect(() => registryHost({ user: "root" })).toThrow(
			"never run agents as root",
		);
	});

	test("probe refuses a host where sudo -n true succeeds", async () => {
		const host = registryHost();
		const clean = assessHostProbe(host, probeOutput({}), 1_000);
		expect(clean.health).toBe("ok");
		expect(
			hostCandidate({ config: host, observed: clean }, 2_000),
		).toMatchObject({ schedulable: true, harnesses: ["claude-cli"] });

		const observed = await probeHost(host, {
			run: async (command) => {
				expect(command.join(" ")).toContain("sudo -n true");
				return { stdout: probeOutput({ sudo: "allowed" }) };
			},
		});
		expect(observed.health).toBe("refused");
		expect(observed.problems.join(" ")).toContain("sudo -n true succeeded");
		expect(
			hostCandidate({ config: host, observed }, observed.checkedAt),
		).toMatchObject({ schedulable: false });
	});

	test("bwrap is mandatory on shared hosts; root and stale probes fail closed", () => {
		const shared = registryHost({ trust: "shared" });
		const noBwrap = assessHostProbe(
			shared,
			probeOutput({ bwrap: "no" }),
			1_000,
		);
		expect(noBwrap.health).toBe("refused");
		expect(noBwrap.problems.join(" ")).toContain("bwrap is mandatory");
		expect(
			hostCandidate({ config: shared, observed: noBwrap }, 1_000).schedulable,
		).toBe(false);

		const owned = registryHost({ trust: "owned", sandbox: "none" });
		expect(
			assessHostProbe(owned, probeOutput({ bwrap: "no" }), 1_000).health,
		).toBe("ok");
		expect(
			assessHostProbe(owned, probeOutput({ uid: "0" }), 1_000).health,
		).toBe("refused");
		const fresh = assessHostProbe(owned, probeOutput({}), 1_000);
		expect(
			hostCandidate({ config: owned, observed: fresh }, 1_000 + 31 * 60_000),
		).toMatchObject({
			schedulable: false,
			reason: expect.stringContaining("stale"),
		});
		expect(
			hostCandidate({ config: owned, observed: null }, 0).schedulable,
		).toBe(false);
	});

	test("admission waits FIFO on remote.<id>.slots", async () => {
		const home = await mkdtemp(join(tmpdir(), "mfw-host-slots-"));
		roots.push(home);
		const registry = HostRegistry.at(home, {
			keygenPath: Bun.which("ssh-keygen") as string,
		});
		await registry.put({ ...registryHost(), slots: 1 });
		const coordinator = await HostResourceCoordinator.create(
			await openHostResourceStore(home, {
				processBootId: "process-a",
				kernelBootId: "kernel-a",
			}),
			{
				liveness: {
					inspect: async () => ({
						status: "unavailable",
						checkedAt: Date.now(),
						kernelBootId: "kernel-a",
					}),
				},
			},
		);
		try {
			const hosts = new HostService({ registry, ledger: coordinator });
			await hosts.syncSlots();
			expect(
				coordinator
					.readModel()
					.definitions.find((d) => d.id === "remote.box-a.slots"),
			).toMatchObject({ accounting: "slot", capacity: 1n, enabled: true });

			// The SSH target's own slot is a host requirement of the resolved target.
			const target = resolveExecutionTarget({
				kind: "ssh",
				requestedShape: { hostId: "box-a" },
				targetCapacity: [{ scope: "host", id: hostSlotResourceId("box-a") }],
			});
			const requirements = targetHostRequirements(target).map((item) => ({
				resourceId: item.id,
				amount: 1n,
			}));
			expect(requirements).toEqual([
				{ resourceId: "remote.box-a.slots", amount: 1n },
			]);
			expect(() =>
				resolveExecutionTarget({
					kind: "local",
					targetCapacity: [{ scope: "host", id: "remote.box-a.slots" }],
				}),
			).toThrow("only valid for a non-local");

			const waiter = (key: string, projectId: string) =>
				coordinator.putWaiter({ requestKey: key, projectId, requirements });
			const first = await waiter("p1/run-1", "p1");
			const second = await waiter("p2/run-2", "p2");
			const third = await waiter("p1/run-3", "p1");
			const generation = () => coordinator.readModel().generation;

			const grant = await coordinator.tryGrant(first.id, generation());
			expect("kind" in grant).toBe(false);
			expect(hosts.free("box-a")).toBe(0);
			// The youngest waiter cannot jump the queue when capacity returns.
			expect(await coordinator.tryGrant(third.id, generation())).toMatchObject({
				kind: "held",
			});
			expect(await coordinator.tryGrant(second.id, generation())).toMatchObject(
				{ kind: "held", blockedBy: ["remote.box-a.slots"] },
			);
			if ("kind" in grant) throw new Error("unreachable");
			await coordinator.cancelOrRelease(grant.id, grant.fence, "run ended");
			expect(hosts.free("box-a")).toBe(1);
			expect(await coordinator.tryGrant(third.id, generation())).toMatchObject({
				kind: "held",
				reason: "fifo",
			});
			expect(
				"kind" in (await coordinator.tryGrant(second.id, generation())),
			).toBe(false);

			// Removing a host with a run on it is refused; its slot drains after.
			await expect(hosts.remove("box-a")).rejects.toThrow("still holds 1");
		} finally {
			coordinator.close();
		}
	});

	test("an unreachable host records the transport failure, not its output", async () => {
		const observed = await probeHost(registryHost(), {
			run: async () => {
				throw new RemoteTransportError("network_lost", "lost");
			},
		});
		expect(observed.health).toBe("unreachable");
		expect(observed.problems[0]).toContain("could not connect");
	});
});
