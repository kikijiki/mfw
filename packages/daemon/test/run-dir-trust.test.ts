import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openProjectDb } from "@mfw/db/client";
import { EventBus } from "@mfw/db/eventlog";
import { AgentHost } from "../src/agent-host.ts";
import { ensureRunDirLayout } from "../src/containment/run-dir.ts";
import { RunRegistry } from "../src/run-registry.ts";
import { controlRootPath } from "../src/sandbox.ts";
import {
	baseSpec,
	fakeHome,
	installCleanup,
	mkfifoSync,
	uid,
	waitFor,
} from "./support/review-fixes.ts";
import { runShTmux } from "./support/run-sh-tmux.ts";

/** Security review wave 1 (C), X9 and X15: the host does not trust or follow files in the writable run dir. */

installCleanup();

describe("X9: the host does not trust or follow files in the writable run dir", () => {
	test("a FIFO as the exit file does not hang readExit or kill", async () => {
		const { mk } = await fakeHome();
		const runDir = mk(`xrun-fifo-${uid}`);
		mkfifoSync(join(runDir, "exit"), 0o600);
		const host = new AgentHost(undefined, { tmuxRunner: runShTmux().runner });
		const t0 = Date.now();
		expect((await host.readExit(runDir)).kind).toBe("running");
		await host.kill(runDir, `xrun-fifo-${uid}`, "test");
		expect(Date.now() - t0).toBeLessThan(5_000);
	}, 20_000);

	test("kill never writes through a dangling exit symlink", async () => {
		const { base, mk } = await fakeHome();
		const runDir = mk(`xrun-link-${uid}`);
		const target = join(base, "created-through-link");
		symlinkSync(target, join(runDir, "exit"));
		const host = new AgentHost(undefined, { tmuxRunner: runShTmux().runner });
		await host.kill(runDir, `xrun-link-${uid}`, "test");
		expect(existsSync(target)).toBe(false);
		expect((await host.readExit(runDir)).kind).toBe("killed");
	});

	test("an exit forged in the run dir does not read as completion while the run lives", async () => {
		const { base, mk } = await fakeHome();
		const runDir = mk(`xrun-forge-${uid}`);
		ensureRunDirLayout(runDir);
		const driver = join(base, "forge.ts");
		writeFileSync(
			driver,
			`
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(join(runDir, "outbox", "exit"))}, "exit:0");
fs.writeFileSync(${JSON.stringify(join(runDir, "outbox", "forged"))}, "1");
const t0 = Date.now();
while (!fs.existsSync(${JSON.stringify(join(runDir, "outbox", "release"))}) && Date.now() - t0 < 10000) await new Promise((r) => setTimeout(r, 25));
process.exit(3);
`,
		);
		const { runner, procs } = runShTmux();
		const host = new AgentHost(undefined, { tmuxRunner: runner });
		await host.launch({
			...baseSpec(base, `xrun-forge-${uid}`, runDir, mk("wt")),
			driverScript: driver,
		});
		expect(
			await waitFor(() => existsSync(join(runDir, "outbox", "forged"))),
		).toBe(true);
		expect((await host.readExit(runDir)).kind).toBe("running");
		writeFileSync(join(runDir, "outbox", "release"), "1");
		await procs.get(`mfw_xrun-forge-${uid}`)?.exited;
		expect(
			await waitFor(async () => (await host.readExit(runDir)).kind === "exit"),
		).toBe(true);
		expect(await host.readExit(runDir)).toEqual({ kind: "exit", code: 3 });
	}, 40_000);

	test("readOutput does not follow a symlink or block on a FIFO", async () => {
		const { base, mk } = await fakeHome();
		const dbDir = mk("db");
		const handle = await openProjectDb(dbDir);
		const registry = new RunRegistry({
			handle,
			bus: new EventBus(),
			runsDir: join(dbDir, "runs"),
		});
		const run = await registry.create({
			kind: "task",
			taskId: "T-1",
			label: "T-1",
			model: "sonnet",
			providerId: "claude-cli",
			reasoningEffort: "medium",
			cwd: base,
			branch: "b",
		});
		const dir = registry.runDir(run.id);
		mkdirSync(dir, { recursive: true });
		const secret = join(base, "credentials");
		writeFileSync(secret, "TOP-SECRET");
		symlinkSync(secret, join(dir, "raw.log"));
		mkfifoSync(join(dir, "events.jsonl"), 0o600);
		const t0 = Date.now();
		expect((await registry.readOutput(run.id, "raw.log")).chunk).toBe("");
		expect((await registry.readOutput(run.id, "events.jsonl")).chunk).toBe("");
		expect(Date.now() - t0).toBeLessThan(5_000);
		await handle.close();
	}, 20_000);
});

describe("X15: housekeeping", () => {
	test("the run script is removed from the control dir once the exit is observed", async () => {
		const { base, mk } = await fakeHome();
		const runDir = mk(`xrun-clean-${uid}`);
		const driver = join(base, "d.ts");
		writeFileSync(driver, "process.exit(0);");
		const { runner, procs } = runShTmux();
		const host = new AgentHost(undefined, { tmuxRunner: runner });
		await host.launch({
			...baseSpec(base, `xrun-clean-${uid}`, runDir, mk("wt")),
			driverScript: driver,
		});
		const script = join(controlRootPath(), `run-xrun-clean-${uid}.sh`);
		expect(existsSync(script)).toBe(true);
		await procs.get(`mfw_xrun-clean-${uid}`)?.exited;
		expect(
			await waitFor(async () => (await host.readExit(runDir)).kind === "exit"),
		).toBe(true);
		expect(existsSync(script)).toBe(false);
	}, 40_000);
});
