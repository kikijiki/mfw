import { describe, expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AgentHost,
	type AgentTmuxRunner,
	type LaunchSpec,
} from "../src/agent-host.ts";
import { SecretEnvironment } from "../src/execution-environment.ts";

async function waitFor(
	cond: () => Promise<boolean>,
	timeoutMs = 5000,
): Promise<void> {
	const t0 = Date.now();
	while (Date.now() - t0 < timeoutMs) {
		if (await cond()) return;
		await Bun.sleep(50);
	}
	throw new Error("waitFor timed out");
}

/** A driver stub: emits a line to stdout (→ raw.log via pipe-pane), waits for
 *  a steer line if told to, exits with the requested code. */
const DRIVER = `
const dir = process.argv[2];
const cfg = JSON.parse(await Bun.file(dir + "/driver.json").text());
console.log("driver-started:" + cfg.model);
if (process.env.AGENT_TOKEN) console.log("secret-present");
if (cfg.initialMessage === "wait-for-steer") {
	for (let i = 0; i < 100; i++) {
		const steer = await Bun.file(dir + "/steer.jsonl").text();
		if (steer.trim()) { console.log("steered:" + JSON.parse(steer.trim().split("\\n")[0])); break; }
		await Bun.sleep(50);
	}
}
process.exit(Number(cfg.env.EXIT_CODE ?? "0"));
`;

async function setup(
	over: { initialMessage?: string; env?: Record<string, string> } = {},
) {
	const base = await mkdtemp(join(tmpdir(), "mfw-host-"));
	const runDir = join(base, "run");
	const cwd = join(base, "wt");
	await mkdir(runDir, { recursive: true });
	await mkdir(cwd, { recursive: true });
	const driverScript = join(base, "driver.ts");
	await writeFile(driverScript, DRIVER);
	const host = new AgentHost();
	const runId = `t${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
	const spec: LaunchSpec = {
		runId,
		runDir,
		cwd,
		projectRoot: base,
		driverScript,
		agentArgv: ["true"],
		env: { EXIT_CODE: "0", ...over.env },
		model: "test-model",
		initialMessage: over.initialMessage ?? "",
		steer: over.initialMessage === "wait-for-steer",
	};
	return {
		base,
		host,
		runId,
		spec,
	};
}

describe("AgentHost v2", () => {
	test("launch → driver runs in tmux, raw.log captures output, exit recorded", async () => {
		const { base, host, runId, spec } = await setup();
		await host.launch(spec);
		await waitFor(
			async () => (await host.readExit(spec.runDir)).kind === "exit",
		);
		const exit = await host.readExit(spec.runDir);
		expect(exit).toEqual({ kind: "exit", code: 0 });
		await waitFor(async () =>
			(await readFile(join(spec.runDir, "raw.log"), "utf8")).includes(
				"driver-started:test-model",
			),
		);
		expect(await host.isAlive(runId)).toBe(false);
		await rm(base, { recursive: true, force: true });
	});

	test("nonzero driver exit is recorded", async () => {
		const { base, host, spec } = await setup({ env: { EXIT_CODE: "3" } });
		await host.launch(spec);
		await waitFor(
			async () => (await host.readExit(spec.runDir)).kind === "exit",
		);
		expect(await host.readExit(spec.runDir)).toEqual({ kind: "exit", code: 3 });
		await rm(base, { recursive: true, force: true });
	});

	test("steer append is O_APPEND and reaches the driver", async () => {
		const { base, host, spec } = await setup({
			initialMessage: "wait-for-steer",
		});
		await host.launch(spec);
		await host.appendSteer(spec.runDir, "hello-agent");
		await waitFor(
			async () => (await host.readExit(spec.runDir)).kind === "exit",
		);
		const raw = await readFile(join(spec.runDir, "raw.log"), "utf8");
		expect(raw).toContain("steered:hello-agent");
		await rm(base, { recursive: true, force: true });
	});

	test("kill records reason, but never overwrites a recorded exit", async () => {
		// long-running driver: kill mid-flight
		const { base, host, runId, spec } = await setup({
			initialMessage: "wait-for-steer", // driver waits → stays alive
		});
		await host.launch(spec);
		await waitFor(() => host.isAlive(runId));
		await host.kill(spec.runDir, runId, "watchdog-idle");
		await waitFor(async () => !(await host.isAlive(runId)));
		expect(await host.readExit(spec.runDir)).toEqual({
			kind: "killed",
			reason: "watchdog-idle",
		});
		// compare-and-skip: a second kill on an exited run keeps the record
		await host.kill(spec.runDir, runId, "manual");
		expect(await host.readExit(spec.runDir)).toEqual({
			kind: "killed",
			reason: "watchdog-idle",
		});
		await rm(base, { recursive: true, force: true });
	});

	test("listSessions surfaces only mfw_* sessions", async () => {
		const { base, host, runId, spec } = await setup({
			initialMessage: "wait-for-steer",
		});
		await host.launch(spec);
		await waitFor(() => host.isAlive(runId));
		const sessions = await host.listSessions();
		expect(sessions).toContain(`mfw_${runId}`);
		await host.kill(spec.runDir, runId, "manual");
		await rm(base, { recursive: true, force: true });
	});

	test("secret environment reaches only the driver and leaves no persisted canary", async () => {
		const canary = "MFW97_LOCAL_SECRET_q3h";
		const { base, host, spec } = await setup();
		spec.secretEnvironment = new SecretEnvironment({ AGENT_TOKEN: canary });
		await host.launch(spec);
		await waitFor(
			async () => (await host.readExit(spec.runDir)).kind === "exit",
		);
		await waitFor(async () =>
			(await readFile(join(spec.runDir, "raw.log"), "utf8")).includes(
				"secret-present",
			),
		);
		for await (const file of new Bun.Glob("**/*").scan({
			cwd: base,
			dot: true,
			onlyFiles: true,
		})) {
			expect(await readFile(join(base, file), "utf8")).not.toContain(canary);
		}
		await rm(base, { recursive: true, force: true });
	});

	for (const boundary of [
		"new-session",
		"pipe-pane",
		"send-keys",
		"pre-consumption",
	] as const) {
		test(`secret FIFO is empty and removed after ${boundary} failure`, async () => {
			const canary = `MFW97_FAILED_HANDOFF_${boundary}`;
			const fixture = await setup();
			const carrierRoot = join(fixture.base, "secret-carriers");
			await mkdir(carrierRoot);
			const calls: string[] = [];
			const runner: AgentTmuxRunner = async (args) => {
				calls.push(args[0] as string);
				const fails = boundary !== "pre-consumption" && args[0] === boundary;
				return {
					exitCode: fails ? 1 : 0,
					stdout: "",
					stderr: fails ? "forced tmux boundary failure" : "",
					timedOut: false,
					truncated: false,
					signalCode: null,
				};
			};
			const host = new AgentHost(undefined, {
				tmuxRunner: runner,
				secretCarrierRoot: carrierRoot,
				secretHandoffTimeoutMs: 30,
			});
			fixture.spec.secretEnvironment = new SecretEnvironment({
				AGENT_TOKEN: canary,
			});

			await expect(host.launch(fixture.spec)).rejects.toThrow();
			expect(await readdir(carrierRoot)).toEqual([]);
			expect(calls).toContain(
				boundary === "pre-consumption" ? "send-keys" : boundary,
			);
			if (boundary !== "new-session") expect(calls).toContain("kill-session");
			for await (const file of new Bun.Glob("**/*").scan({
				cwd: fixture.base,
				dot: true,
				onlyFiles: true,
			})) {
				expect(await readFile(join(fixture.base, file), "utf8")).not.toContain(
					canary,
				);
			}
			await rm(fixture.base, { recursive: true, force: true });
		});
	}

	for (const streamFailure of ["eof", "partial"] as const) {
		test(`${streamFailure} secret stream records a start failure and never invokes the driver`, async () => {
			const canary = `MFW97_${streamFailure.toUpperCase()}_CANARY_v7`;
			const fixture = await setup();
			const carrierRoot = join(fixture.base, "secret-carriers");
			await mkdir(carrierRoot);
			const host = new AgentHost(undefined, {
				secretCarrierRoot: carrierRoot,
				secretHandoffWriter: async (handle, content) => {
					const carrier = await handle.stat();
					expect(carrier.isFIFO()).toBe(true);
					expect(carrier.mode & 0o777).toBe(0o600);
					if (streamFailure === "partial") {
						const sentinelOffset = content.lastIndexOf(
							"MFW_DRIVER_SECRET_HANDOFF_COMPLETE",
						);
						await handle.writeFile(content.slice(0, sentinelOffset));
					}
					await handle.close();
				},
			});
			fixture.spec.secretEnvironment = new SecretEnvironment({
				AGENT_TOKEN: canary,
			});

			await host.launch(fixture.spec);
			await waitFor(
				async () => (await host.readExit(fixture.spec.runDir)).kind === "exit",
			);
			expect(await host.readExit(fixture.spec.runDir)).toEqual({
				kind: "exit",
				code: 78,
			});
			const raw = await readFile(join(fixture.spec.runDir, "raw.log"), "utf8");
			expect(raw).not.toContain("driver-started:");
			expect(await readdir(carrierRoot)).toEqual([]);
			for await (const file of new Bun.Glob("**/*").scan({
				cwd: fixture.base,
				dot: true,
				onlyFiles: true,
			})) {
				expect(await readFile(join(fixture.base, file), "utf8")).not.toContain(
					canary,
				);
			}
			await rm(fixture.base, { recursive: true, force: true });
		});
	}
});
