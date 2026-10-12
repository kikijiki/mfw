import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { boot, type ProjectConfig } from "../src/boot.ts";
import {
	BASE_EXECUTION_ENVIRONMENT,
	type SecretEnvironment,
} from "../src/execution-environment.ts";
import { git } from "../src/git.ts";
import { HostRegistry } from "../src/host-registry.ts";
import { silentLogger } from "../src/log.ts";
import type { ProjectServices } from "../src/services.ts";
import { RemoteTransportError } from "../src/ssh-transport.ts";

/**
 * End to end through boot, admission and the run engine, with the SSH
 * transport replaced by a local executor: placement, the host slot in the
 * coordinator, and `runs.host_id`.
 */

const roots: string[] = [];
const orchestrators: Awaited<ReturnType<typeof boot>>[] = [];
afterEach(async () => {
	for (const o of orchestrators.splice(0).reverse())
		await o.shutdown().catch(() => {});
	for (const root of roots.splice(0).reverse())
		await rm(root, { recursive: true, force: true });
});

const DRIVER = `
const dir = process.argv[2];
const { appendFileSync } = await import("node:fs");
appendFileSync(dir + "/events.jsonl", JSON.stringify({
  ts: new Date().toISOString(), seq: 1, type: "hello", provider: "test",
  capabilities: { steer: false }
}) + "\\n");
await Bun.sleep(300);
process.exit(0);
`;

/** Runs "remote" commands locally as the box user would; launch detaches. */
function localBox() {
	const transport = {
		async run(command: readonly string[]) {
			const child = Bun.spawn([...command], { stdout: "pipe", stderr: "pipe" });
			const [stdout, stderr, code] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			if (code !== 0)
				throw new RemoteTransportError(
					"remote_exit",
					stderr.slice(0, 200),
					code,
				);
			return { exitCode: 0, stdout, stderr, truncated: false };
		},
		async runWithSecrets(
			command: readonly string[],
			env: Readonly<Record<string, string>>,
			secrets: SecretEnvironment,
		) {
			Bun.spawn([...command.slice(2)], {
				env: {
					...BASE_EXECUTION_ENVIRONMENT,
					...env,
					PATH: `${dirname(process.execPath)}:${BASE_EXECUTION_ENVIRONMENT.PATH}`,
					...secrets.materializeForLaunch(),
				},
				stdout: "ignore",
				stderr: "ignore",
			});
			// Give the detached runtime time to write its pid before observe.
			await Bun.sleep(150);
			return { exitCode: 0, stdout: "", stderr: "", truncated: false };
		},
		async upload(path: string, bytes: Uint8Array) {
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, bytes);
		},
		async download(path: string) {
			try {
				return await readFile(path);
			} catch {
				throw new RemoteTransportError("remote_exit", "absent");
			}
		},
	};
	return () => transport;
}

async function repo(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "mfw-ssh-boot-repo-"));
	roots.push(root);
	await git(["init", "-q", "-b", "main"], root);
	await git(["config", "user.email", "test@example.com"], root);
	await git(["config", "user.name", "test"], root);
	await writeFile(join(root, "README.md"), "# demo\n");
	await mkdir(join(root, ".mfw"), { recursive: true });
	await writeFile(join(root, ".mfw/AGENTS.md"), "test rules\n");
	await git(["add", "-A"], root);
	await git(["commit", "-q", "-m", "init"], root);
	return root;
}

function useDriver(service: ProjectServices, path: string) {
	const adapters = (
		service.engine as unknown as {
			deps: {
				adapters: {
					driverOverride: string | null;
					buildArgv: (() => string[]) | null;
				};
			};
		}
	).deps.adapters;
	adapters.driverOverride = path;
	adapters.buildArgv = () => ["true"];
}

describe("registry SSH hosts through boot", () => {
	test("a task pinned to ssh:<host> is placed, holds remote.<host>.slots and records host_id", async () => {
		const home = await mkdtemp(join(tmpdir(), "mfw-ssh-boot-home-"));
		roots.push(home);
		const boxHome = join(home, "box-home");
		await mkdir(boxHome);
		const registry = HostRegistry.at(home, {
			keygenPath: Bun.which("ssh-keygen") as string,
		});
		await registry.put({
			id: "box-a",
			address: "box-a.example.invalid",
			user: "agent",
			hostKey: `ssh-ed25519 ${Buffer.alloc(32, 5).toString("base64")}`,
			trust: "owned",
			sandbox: "none",
			slots: 1,
		});
		await registry.recordObservation("box-a", {
			checkedAt: Date.now(),
			health: "ok",
			problems: [],
			uid: 1001,
			user: "agent",
			home: boxHome,
			path: `${dirname(process.execPath)}:/usr/bin:/bin`,
			bunPath: process.execPath,
			gitPath: Bun.which("git") as string,
			setsidPath: "/usr/bin/setsid",
			bwrapPath: null,
			sudo: "refused",
			bwrap: false,
			harnesses: { "claude-cli": { version: "2", auth: true } },
			gpus: 0,
			diskFreeBytes: null,
			memAvailableBytes: null,
		});
		const driverDir = await mkdtemp(join(tmpdir(), "mfw-ssh-boot-driver-"));
		roots.push(driverDir);
		const driver = join(driverDir, "driver.ts");
		await writeFile(driver, DRIVER);
		const project: ProjectConfig = {
			name: "demo",
			root: await repo(),
			integrationBranch: "main",
			maxConcurrent: 4,
			assistance: {
				changeReview: "human",
			},
		};
		const orchestrator = await boot({
			projects: [project],
			mfwHome: home,
			autostart: false,
			log: silentLogger(),
			sshTransport: localBox(),
		});
		orchestrators.push(orchestrator);
		const service = orchestrator.get("demo");
		useDriver(service, driver);
		expect(
			orchestrator.hostResources
				.readModel()
				.definitions.find((d) => d.id === "remote.box-a.slots"),
		).toMatchObject({ capacity: 1n, enabled: true });

		const first = await service.tasks.create({
			title: "remote one",
			executionTarget: "ssh:box-a",
		});
		const second = await service.tasks.create({
			title: "remote two",
			executionTarget: "ssh:box-a",
		});
		for (const task of [first, second])
			await service.tasks.move(task.id, "ready", "human");

		const { runId } = await service.engine.startTask(first.id);
		const run = await service.registry.get(runId);
		expect(run).toMatchObject({ executionTarget: "ssh", hostId: "box-a" });
		expect(run?.routing).toMatchObject({ target: "ssh", hostId: "box-a" });
		expect(run?.targetLeaseRef).toMatch(/^ssh\.box-a\./);
		const active = orchestrator.hostResources
			.readModel()
			.leases.filter((lease) => lease.state === "active");
		expect(active.flatMap((lease) => lease.allocations)).toEqual([
			{ resourceId: "remote.box-a.slots", bindingId: null, amount: 1n },
		]);
		expect(orchestrator.hosts.free("box-a")).toBe(0);

		// The second task waits for the one slot instead of starting.
		await expect(service.engine.startTask(second.id)).rejects.toThrow(
			"remote.box-a.slots",
		);
		expect(await service.registry.list({ taskId: second.id })).toEqual([]);

		// A daemon restart cannot see the remote run locally: the slot must stay
		// held (not reclaimed as "absent") and the live run is adopted again.
		await orchestrator.shutdown();
		orchestrators.splice(orchestrators.indexOf(orchestrator), 1);
		const restarted = await boot({
			projects: [project],
			mfwHome: home,
			autostart: false,
			log: silentLogger(),
			sshTransport: localBox(),
		});
		orchestrators.push(restarted);
		const after = restarted.get("demo");
		useDriver(after, driver);
		const leases = restarted.hostResources
			.readModel()
			.leases.filter((lease) => lease.run?.runId === runId);
		expect(leases.map((lease) => lease.state)).toEqual(["active"]);
		expect(restarted.hosts.free("box-a")).toBe(0);
		await expect(after.engine.startTask(second.id)).rejects.toThrow(
			"remote.box-a.slots",
		);
	}, 60_000);
});
