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
import { join } from "node:path";
import { SecretEnvironment } from "../src/execution-environment.ts";
import {
	generateEphemeralRunPodSshKey,
	loadEphemeralRunPodSshKey,
	RemoteTransportError,
	RunPodSshTransport,
	type SshProcessRunner,
	scanRunPodDirectSshHostKey,
} from "../src/remote-agent-host.ts";

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
