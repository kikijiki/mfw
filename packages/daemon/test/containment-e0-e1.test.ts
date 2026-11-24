import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentHost } from "../src/agent-host.ts";
import { sandboxedSpec } from "./support/sandboxed-launch.ts";

/**
 * G2a: the sandbox experiments' E0 (daemon environment) and E1 (tmux server
 * environment and sockets) reproduced as tests. A canary is planted in the
 * daemon's own environment; the driver reports what it can see.
 */

const dirs: string[] = [];
afterEach(async () => {
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function waitExit(host: AgentHost, runDir: string) {
	const t0 = Date.now();
	while (Date.now() - t0 < 15_000) {
		if ((await host.readExit(runDir)).kind === "exit") return;
		await Bun.sleep(50);
	}
	throw new Error("run did not exit");
}

describe("E0/E1 reproductions", () => {
	test("the tmux server itself is started clean: the daemon canary is not in its global environment", async () => {
		if (!Bun.which("tmux")) return console.log("skip: no tmux");
		const base = await mkdtemp(join(tmpdir(), "mfw-e1-"));
		dirs.push(base);
		const cwd = join(base, "wt");
		await mkdir(cwd, { recursive: true });
		const canary = `canary-${Math.random().toString(36).slice(2)}`;
		process.env.MFW_G2A_CANARY = canary;
		const host = new AgentHost();
		const runId = `f${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
		const spec = await sandboxedSpec(base, runId, cwd);
		const runDir = spec.runDir;
		try {
			const driverScript = join(base, "driver.ts");
			// the host driver: the pane's inherited env is what E1 broke
			await writeFile(
				driverScript,
				`console.log("canary-visible:" + JSON.stringify(process.env).includes(${JSON.stringify(canary)})); process.exit(0);`,
			);
			await host.launch({ ...spec, driverScript, model: "m" });
			await waitExit(host, runDir);
			expect(await readFile(join(runDir, "raw.log"), "utf8")).toContain(
				"canary-visible:false",
			);
		} finally {
			delete process.env.MFW_G2A_CANARY;
		}
	});
});
