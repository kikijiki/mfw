import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentHost } from "../src/agent-host.ts";
import { runProc } from "../src/proc.ts";
import { TEST_TMUX_SOCKET } from "./support/tmux-test-socket.ts";

/**
 * Security review wave 1 (A), G3: what the host itself starts reads no
 * agent-writable startup file. The in-sandbox escapes (G1, G2, G7) are replayed
 * against the real launch path in agent-bridge-conformance and role-sandbox-live.
 */

const dirs: string[] = [];
afterEach(async () => {
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function work(prefix: string) {
	const base = await mkdtemp(join(tmpdir(), prefix));
	dirs.push(base);
	const mk = async (name: string) => {
		const p = join(base, name);
		await mkdir(p, { recursive: true });
		return p;
	};
	return { base, mk };
}

async function waitFor(cond: () => Promise<boolean>, ms = 15_000) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		if (await cond()) return true;
		await Bun.sleep(50);
	}
	return false;
}

const exists = (p: string) =>
	stat(p).then(
		() => true,
		() => false,
	);

describe("G3: agent-writable startup files do not run on the host", () => {
	test("~/.tmux.conf is not read by the tmux server the host starts", async () => {
		if (!Bun.which("tmux")) return console.log("skip: no tmux");
		const { base, mk } = await work("mfw-g3-");
		const home = await mk("home");
		const runDir = await mk("run");
		const cwd = await mk("wt");
		const marker = join(base, "tmux-conf-ran");
		await writeFile(
			join(home, ".tmux.conf"),
			`run-shell "readlink /proc/self/ns/user > ${marker}"\n`,
		);
		const driverScript = join(base, "driver.ts");
		await writeFile(driverScript, "process.exit(0);");
		const savedHome = process.env.HOME;
		process.env.HOME = home;
		const host = new AgentHost();
		try {
			// no server may be running, so this launch starts it (and reads its config)
			await runProc(["tmux", "-L", TEST_TMUX_SOCKET, "kill-server"], {
				timeoutMs: 5000,
			});
			await host.launch({
				runId: "g3a",
				runDir,
				cwd,
				projectRoot: base,
				driverScript,
				agentArgv: ["true"],
				env: {},
				steer: false,
				approvalMode: "interactive",
			});
			await waitFor(async () => (await host.readExit(runDir)).kind === "exit");
			await Bun.sleep(300);
			expect(await exists(marker)).toBe(false);
		} finally {
			process.env.HOME = savedHome;
			await runProc(["tmux", "-L", TEST_TMUX_SOCKET, "kill-server"], {
				timeoutMs: 5000,
			}).catch(() => undefined);
		}
	}, 40_000);
});
