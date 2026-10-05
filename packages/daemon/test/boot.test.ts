import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { boot } from "../src/boot.ts";
import { git } from "../src/git.ts";
import { openHostResourceStore } from "../src/host-resources/index.ts";
import { silentLogger } from "../src/log.ts";

const paths: string[] = [];
afterEach(async () => {
	for (const path of paths.splice(0))
		await rm(path, { recursive: true, force: true });
});

async function temp(prefix: string): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), prefix));
	paths.push(path);
	return path;
}

async function repo(): Promise<string> {
	const root = await temp("mfw-host-boot-repo-");
	await git(["init", "-q", "-b", "main", "."], root);
	await git(["config", "user.email", "host@test"], root);
	await git(["config", "user.name", "host-test"], root);
	await writeFile(join(root, "app.ts"), "export const ok = true;\n");
	await git(["add", "-A"], root);
	await git(["commit", "-qm", "init"], root);
	return root;
}

describe("machine-wide boot foundation", () => {
	test("an independently launched second daemon is excluded before attachment", async () => {
		const home = await temp("mfw-host-lock-");
		const root = await repo();
		const first = await boot({
			projects: [{ name: "one", root }],
			mfwHome: home,
			autostart: false,
			log: silentLogger(),
		});
		expect(first.list()).toHaveLength(1);

		const child = Bun.spawn(
			[
				"bun",
				"-e",
				`import { boot } from "./packages/daemon/src/boot.ts";
				 import { silentLogger } from "./packages/daemon/src/log.ts";
				 try { await boot({projects:[],mfwHome:process.env.TEST_MFW_HOME,autostart:false,log:silentLogger()}); process.exit(9) }
				 catch (e) { console.log(e.name + ":" + e.message); process.exit(0) }`,
			],
			{
				cwd: process.cwd(),
				env: { ...process.env, TEST_MFW_HOME: home },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const output = await new Response(child.stdout).text();
		expect(await child.exited).toBe(0);
		expect(output).toContain("DaemonLockError");
		// The first daemon remains the only one that attached/dispatch-capable.
		expect(first.list()).toHaveLength(1);
		await first.shutdown();
	});

	test("different homes are independent and expose distinct coordinator identities", async () => {
		const homeA = await temp("mfw-host-a-");
		const homeB = await temp("mfw-host-b-");
		const [a, b] = await Promise.all([
			boot({
				projects: [],
				mfwHome: homeA,
				autostart: false,
				log: silentLogger(),
			}),
			boot({
				projects: [],
				mfwHome: homeB,
				autostart: false,
				log: silentLogger(),
			}),
		]);
		expect(a.hostResources.coordinatorId).not.toBe(
			b.hostResources.coordinatorId,
		);
		expect(a.hostResources.hostId).not.toBe(b.hostResources.hostId);
		expect(existsSync(join(homeA, "host", "host.db"))).toBe(true);
		expect(existsSync(join(homeB, "host", "host.db"))).toBe(true);
		await a.shutdown();
		await b.shutdown();
	});

	test("different homes cannot attach the same repository across processes, then hand it off", async () => {
		const homeA = await temp("mfw-project-owner-a-");
		const homeB = await temp("mfw-project-owner-b-");
		const root = await repo();
		const first = await boot({
			projects: [{ name: "owner", root }],
			mfwHome: homeA,
			autostart: false,
			log: silentLogger(),
		});

		const attempt = async (): Promise<{
			attached?: number;
			error?: string;
		}> => {
			const child = Bun.spawn(
				[
					"bun",
					"-e",
					`import { boot } from "./packages/daemon/src/boot.ts";
					 import { silentLogger } from "./packages/daemon/src/log.ts";
					 const orch = await boot({projects:[],mfwHome:process.env.TEST_MFW_HOME,autostart:false,log:silentLogger()});
					 try { await orch.attach({name:"contender",root:process.env.TEST_REPO}); console.log(JSON.stringify({attached:orch.list().length})); }
					 catch (error) { console.log(JSON.stringify({error:error.message})); }
					 finally { await orch.shutdown(); }`,
				],
				{
					cwd: process.cwd(),
					env: {
						...process.env,
						TEST_MFW_HOME: homeB,
						TEST_REPO: root,
					},
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const output = (await new Response(child.stdout).text()).trim();
			const stderr = await new Response(child.stderr).text();
			expect(await child.exited, stderr).toBe(0);
			return JSON.parse(output) as { attached?: number; error?: string };
		};

		const refused = await attempt();
		expect(refused.error).toContain("another mfw daemon already owns");
		expect(refused.error).toContain(join(root, ".mfw"));

		await first.shutdown();
		expect(await attempt()).toEqual({ attached: 1 });
	});

	test("coordinator identity is stable across daemon restarts", async () => {
		const home = await temp("mfw-host-stable-");
		let orchestrator = await boot({
			projects: [],
			mfwHome: home,
			autostart: false,
			log: silentLogger(),
		});
		const id = orchestrator.hostResources.coordinatorId;
		await orchestrator.shutdown();
		orchestrator = await boot({
			projects: [],
			mfwHome: home,
			autostart: false,
			log: silentLogger(),
		});
		expect(orchestrator.hostResources.coordinatorId).toBe(id);
		await orchestrator.shutdown();
	});

	test("ordinary shutdown hands off a live local session instead of tearing it down", async () => {
		const home = await temp("mfw-shutdown-handoff-");
		const root = await repo();
		const orchestrator = await boot({
			projects: [{ name: "handoff", root }],
			mfwHome: home,
			autostart: false,
			log: silentLogger(),
		});
		const svc = orchestrator.get("handoff");
		const runId = `shutdown-${Date.now()}`;
		const runDir = join(root, "shutdown-run");
		await mkdir(runDir);
		const driver = join(root, "long-driver.ts");
		await writeFile(driver, "await Bun.sleep(60_000);\n");
		await svc.host.launch({
			runId,
			runDir,
			cwd: root,
			projectRoot: root,
			driverScript: driver,
			agentArgv: ["true"],
			steer: false,
		});
		expect(await svc.host.isAlive(runId)).toBe(true);

		await orchestrator.shutdown();
		expect(await svc.host.isAlive(runId)).toBe(true);
		await svc.host.kill(runDir, runId, "test-cleanup");
	});

	test("corrupt or newer host stores fail before a project is touched", async () => {
		for (const kind of ["corrupt", "newer"] as const) {
			const home = await temp(`mfw-host-${kind}-`);
			const root = await repo();
			await mkdir(join(home, "host"), { recursive: true });
			const dbPath = join(home, "host", "host.db");
			if (kind === "corrupt") {
				await writeFile(dbPath, "not a sqlite database");
			} else {
				const store = await openHostResourceStore(home, {
					processBootId: "setup",
					kernelBootId: "kernel",
				});
				store.close();
				const client = createClient({ url: `file:${dbPath}` });
				await client.execute("PRAGMA user_version=999");
				client.close();
			}
			await expect(
				boot({
					projects: [{ name: "must-not-attach", root }],
					mfwHome: home,
					autostart: false,
					log: silentLogger(),
				}),
			).rejects.toThrow();
			expect(existsSync(join(root, ".mfw"))).toBe(false);
		}
	});
});
