import { afterEach, describe, expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
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
	LaunchExecutionRequest,
} from "../src/execution-target.ts";
import { git, gitOk } from "../src/git.ts";
import {
	type HostConfig,
	HostConfigSchema,
	type HostObservation,
	type RegisteredHost,
} from "../src/host-registry.ts";
import {
	SharedHostSecretError,
	SshExecutionTarget,
	type SshExecutionTransport,
	SshHostUnavailableError,
} from "../src/ssh-execution-target.ts";
import { RemoteTransportError } from "../src/ssh-transport.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

const owner: ExecutionOwnership = {
	projectId: "project-ssh",
	projectName: "ssh-test",
	runId: "runssh1",
	taskId: "T-1",
	attempt: 1,
	ownerKey: "project-ssh/runssh1/1",
};

/** Executes "remote" commands locally, as the box user would. */
class LocalBoxTransport implements SshExecutionTransport {
	launches = 0;
	executeLaunch = true;
	commands: string[][] = [];
	launchEnv: Record<string, string> = {};

	async run(command: readonly string[]) {
		this.commands.push([...command]);
		const child = Bun.spawn([...command], { stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		if (code !== 0)
			throw new RemoteTransportError("remote_exit", `failed: ${stderr}`, code);
		return { exitCode: 0, stdout, stderr, truncated: false };
	}

	async runWithSecrets(
		command: readonly string[],
		publicEnvironment: Readonly<Record<string, string>>,
		secrets: SecretEnvironment,
	) {
		this.launches++;
		this.launchEnv = { ...publicEnvironment };
		if (!this.executeLaunch)
			return { exitCode: 0, stdout: "", stderr: "", truncated: false };
		// Drop `setsid -f`: run the runtime synchronously so assertions see results.
		const child = Bun.spawn([...command.slice(2)], {
			env: {
				...BASE_EXECUTION_ENVIRONMENT,
				...publicEnvironment,
				PATH: `${dirname(process.execPath)}:${BASE_EXECUTION_ENVIRONMENT.PATH}`,
				...secrets.materializeForLaunch(),
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		if (exitCode !== 0)
			throw new RemoteTransportError("remote_exit", stderr, exitCode);
		return { exitCode, stdout, stderr, truncated: false };
	}

	async upload(path: string, bytes: Uint8Array) {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, bytes);
	}

	async download(path: string) {
		try {
			return await readFile(path);
		} catch {
			throw new RemoteTransportError("remote_exit", "absent");
		}
	}
}

async function fixture(
	over: Partial<HostConfig> = {},
	obs: Partial<HostObservation> = {},
) {
	const root = await mkdtemp(join(tmpdir(), "mfw-ssh-target-"));
	roots.push(root);
	const project = join(root, "project");
	await mkdir(project);
	await git(["init", "-q", "-b", "main"], project);
	await git(["config", "user.email", "test@example.invalid"], project);
	await git(["config", "user.name", "test"], project);
	await writeFile(join(project, "base.txt"), "base\n");
	await git(["add", "-A"], project);
	await git(["commit", "-q", "-m", "base"], project);
	const baseSha = await gitOk(["rev-parse", "HEAD"], project);
	const runDir = join(root, "run");
	await mkdir(runDir);
	const boxHome = join(root, "box-home");
	await mkdir(boxHome);
	const driver = join(root, "driver.ts");
	await writeFile(
		driver,
		`const runDir = process.argv[2];
const cfg = await Bun.file(runDir + "/driver.json").json();
await Bun.write(cfg.cwd + "/remote-output.txt", "from the box\\n");
await Bun.write(cfg.cwd + "/home.txt", process.env.HOME + "\\n");
const { readdirSync, existsSync } = await import("node:fs");
const runs = process.env.HOME + "/.mfw-runs";
await Bun.write(cfg.cwd + "/sandbox.json", JSON.stringify({
  sshVisible: existsSync(process.env.HOME + "/.ssh/authorized_keys"),
  otherRuns: existsSync(runs) ? readdirSync(runs).length : -1,
}));
await Bun.write(cfg.env.MFW_REPORT_PATH, JSON.stringify({ summary: "ok" }));
await Bun.write(runDir + "/events.jsonl", JSON.stringify({ type: "done" }) + "\\n");
`,
	);
	const config = HostConfigSchema.parse({
		id: "box-a",
		address: "box-a.example.invalid",
		user: "agent",
		hostKey: `ssh-ed25519 ${Buffer.alloc(32, 4).toString("base64")}`,
		trust: "owned",
		sandbox: "none",
		...over,
	});
	const observed: HostObservation = {
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
		...obs,
	};
	const host: RegisteredHost = { config, observed, keyPath: "/unused" };
	const transport = new LocalBoxTransport();
	const target = new SshExecutionTarget({
		hosts: {
			require: async (id) => {
				if (id !== host.config.id) throw new Error("unknown host");
				return host;
			},
			list: async () => [host],
		},
		projectRoot: project,
		integrationBranch: "main",
		transport: () => transport,
	});
	const prepared = await target.prepare({
		owner,
		runDir,
		projectRoot: project,
		integrationBranch: "main",
		requestedShape: { hostId: "box-a" },
		reuse: { worktreePath: project, branch: "main", baseSha },
	});
	const launch = (
		secretEnvironment?: SecretEnvironment,
	): LaunchExecutionRequest => ({
		owner,
		runDir,
		projectRoot: project,
		workspace: prepared.workspace,
		globalLeaseRef: prepared.globalLeaseRef,
		driver: {
			driverScript: driver,
			agentArgv: ["true"],
			env: { MFW_RUN_ID: owner.runId },
			model: "test",
			reasoningEffort: "medium",
			initialMessage: "go",
			steer: true,
			approvalMode: "autonomous",
			...(secretEnvironment ? { secretEnvironment } : {}),
		},
	});
	const ref = {
		owner,
		runDir,
		globalLeaseRef: prepared.globalLeaseRef,
		workspace: prepared.workspace,
	};
	return {
		root,
		project,
		boxHome,
		host,
		transport,
		target,
		prepared,
		launch,
		ref,
	};
}

describe("SSH ExecutionTarget", () => {
	test("stage, detached driver under the box user's HOME, collect back, proven delete", async () => {
		const f = await fixture();
		expect(f.prepared.globalLeaseRef).toMatch(/^ssh\.box-a\.[a-f0-9]{32}$/);
		expect(f.prepared.workspace.executionPath).toStartWith(
			join(f.boxHome, ".mfw-runs"),
		);
		await f.target.launch(f.launch());
		expect(f.transport.launches).toBe(1);
		expect(f.transport.launchEnv.HOME).toBe(f.boxHome);
		expect((await f.target.observe(f.ref)).state).toBe("exited");
		expect(
			await readFile(
				join(f.prepared.workspace.executionPath, "home.txt"),
				"utf8",
			),
		).toBe(`${f.boxHome}\n`);

		// A relaunch after a detached launch observes, never starts a second driver.
		await f.target.launch(f.launch());
		expect(f.transport.launches).toBe(1);

		await f.target.collect(f.ref);
		expect(await readFile(join(f.project, "remote-output.txt"), "utf8")).toBe(
			"from the box\n",
		);
		const disposed = await f.target.dispose(f.ref);
		expect(disposed.absenceConfirmed).toBe(true);
		await expect(
			stat(dirname(f.prepared.workspace.executionPath)),
		).rejects.toThrow();
	}, 60_000);

	test("bwrap is mandatory on shared hosts: a shared host without bwrap is refused at launch", async () => {
		const f = await fixture({ trust: "shared", sandbox: "bwrap" });
		await expect(f.target.launch(f.launch())).rejects.toBeInstanceOf(
			SshHostUnavailableError,
		);
		expect(f.transport.launches).toBe(0);
		expect(f.transport.commands).toEqual([]);
	});

	test("a shared host runs the driver in bwrap with ~/.ssh and other runs masked", async () => {
		const f = await fixture(
			{ trust: "shared", sandbox: "bwrap", secrets: ["ALLOWED_KEY"] },
			{ bwrap: true, bwrapPath: "/usr/bin/bwrap" },
		);
		f.transport.executeLaunch = false;
		await f.target.launch(
			f.launch(new SecretEnvironment({ ALLOWED_KEY: "value" })),
		);
		const root = dirname(f.prepared.workspace.executionPath);
		const config = JSON.parse(
			await readFile(join(root, "support", "runtime-config.json"), "utf8"),
		);
		const argv: string[] = config.sandboxArgv;
		expect(argv[0]).toBe("/usr/bin/bwrap");
		expect(argv.at(-1)).toBe("--");
		const pairs = (flag: string) =>
			argv.flatMap((value, i) => (value === flag ? [argv[i + 1]] : []));
		expect(pairs("--tmpfs")).toEqual([
			join(f.boxHome, ".ssh"),
			join(f.boxHome, ".mfw-runs"),
		]);
		expect(pairs("--bind")).toContain(f.prepared.workspace.executionPath);
		expect(pairs("--ro-bind")).toContain(join(root, "support"));
		// The masks come after the writable $HOME bind, the run binds after the masks.
		expect(argv.indexOf("--tmpfs")).toBeGreaterThan(argv.indexOf(f.boxHome));
		expect(argv.lastIndexOf("--bind")).toBeGreaterThan(
			argv.lastIndexOf("--tmpfs"),
		);
		expect(JSON.stringify(config)).not.toContain("value");
	});

	test("a shared host never receives a secret it does not list; push credentials never cross", async () => {
		const f = await fixture(
			{ trust: "shared", sandbox: "bwrap" },
			{ bwrap: true, bwrapPath: "/usr/bin/bwrap" },
		);
		f.transport.executeLaunch = false;
		await expect(
			f.target.launch(
				f.launch(new SecretEnvironment({ OPENROUTER_API_KEY: "sk-x" })),
			),
		).rejects.toBeInstanceOf(SharedHostSecretError);
		expect(f.transport.launches).toBe(0);

		const owned = await fixture();
		const request = owned.launch();
		request.driver.env = { ...request.driver.env, SSH_AUTH_SOCK: "/run/agent" };
		await expect(owned.target.launch(request)).rejects.toThrow(
			"credential-like names: SSH_AUTH_SOCK",
		);
	});

	test("a stale or refused host is not launched on", async () => {
		const f = await fixture({}, { checkedAt: Date.now() - 2 * 60 * 60_000 });
		await expect(f.target.launch(f.launch())).rejects.toThrow("stale probe");
		const refused = await fixture(
			{},
			{ health: "refused", problems: ["sudo"] },
		);
		await expect(refused.target.launch(refused.launch())).rejects.toThrow(
			"is refused",
		);
		expect(f.transport.launches + refused.transport.launches).toBe(0);
	});

	const bwrap = Bun.which("bwrap");
	const bwrapWorks =
		bwrap !== null &&
		Bun.spawnSync([
			bwrap,
			"--ro-bind",
			"/",
			"/",
			"--dev",
			"/dev",
			"--proc",
			"/proc",
			"true",
		]).exitCode === 0;
	test.skipIf(!bwrapWorks)(
		"the bwrap sandbox really runs the driver with ~/.ssh and other runs hidden",
		async () => {
			const f = await fixture(
				{ trust: "shared", sandbox: "bwrap" },
				{ bwrap: true, bwrapPath: bwrap as string },
			);
			await mkdir(join(f.boxHome, ".ssh"), { recursive: true });
			await writeFile(join(f.boxHome, ".ssh", "authorized_keys"), "key\n");
			await mkdir(join(f.boxHome, ".mfw-runs", "other-run"), {
				recursive: true,
			});
			await f.target.launch(f.launch());
			expect((await f.target.observe(f.ref)).state).toBe("exited");
			const seen = JSON.parse(
				await readFile(
					join(f.prepared.workspace.executionPath, "sandbox.json"),
					"utf8",
				),
			);
			// Only this run's own directory is visible under the runs root.
			expect(seen).toEqual({ sshVisible: false, otherRuns: 1 });
			expect(
				await readFile(join(f.boxHome, ".ssh", "authorized_keys"), "utf8"),
			).toBe("key\n");
		},
		60_000,
	);
});
