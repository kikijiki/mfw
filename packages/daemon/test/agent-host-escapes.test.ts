import { afterEach, describe, expect, test } from "bun:test";
import { readlinkSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentHost } from "../src/agent-host.ts";
import { SecretEnvironment } from "../src/execution-environment.ts";
import { runProc } from "../src/proc.ts";
import {
	bwrapAvailable,
	controlRootPath,
	probeSandbox,
} from "../src/sandbox.ts";
import { runShTmux } from "./support/run-sh-tmux.ts";
import { TEST_TMUX_SOCKET } from "./support/tmux-test-socket.ts";

/**
 * Security review wave 1 (A), G1 and G2: reproductions of the reported
 * escapes. Each test plants the exploit from the report in a sandboxed driver
 * and asserts it does NOT run outside the sandbox / does not see the secret.
 * "Outside" is detected by the user namespace: bwrap's differs from the host's.
 */

const dirs: string[] = [];
afterEach(async () => {
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function usable(): Promise<string | null> {
	if (!(await bwrapAvailable())) return "no bwrap";
	const r = await probeSandbox({ mode: "bwrap", hidePaths: [] });
	return r.ok ? null : `bwrap cannot run here (${r.detail})`;
}

const hostNs = () => readlinkSync("/proc/self/ns/user");

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

describe("G1: the agent cannot extend run.sh", () => {
	test("a line appended to run.sh from inside never runs outside the sandbox", async () => {
		const why = await usable();
		if (why) return console.log(`skip: ${why}`);
		const { base, mk } = await work("mfw-g1-");
		const runDir = await mk("run");
		const cwd = await mk("wt");
		const nsOut = join(runDir, "outside-ns");
		const driverScript = join(base, "driver.ts");
		await writeFile(
			driverScript,
			`
const fs = require("node:fs");
const line = "readlink /proc/self/ns/user > ${nsOut}\\n";
try { fs.appendFileSync(${JSON.stringify(join(runDir, "run.sh"))}, line); } catch {}
process.exit(0);
`,
		);
		const { runner, procs } = runShTmux();
		const host = new AgentHost(undefined, { tmuxRunner: runner });
		await host.launch({
			runId: "g1",
			runDir,
			cwd,
			projectRoot: base,
			driverScript,
			agentArgv: ["true"],
			env: {},
			steer: false,
			approvalMode: "autonomous",
			isolation: { mode: "bwrap", hidePaths: [] },
		});
		await procs.get("mfw_g1")?.exited;
		await waitFor(async () => (await host.readExit(runDir)).kind === "exit");
		const escaped = (await exists(nsOut))
			? (await readFile(nsOut, "utf8")).trim() === hostNs()
			: false;
		expect(escaped).toBe(false);
	}, 40_000);
});

describe("G2: another run cannot reach or poison the secret FIFO", () => {
	async function launchPair(attackerBody: string) {
		const { base, mk } = await work("mfw-g2-");
		const aRun = await mk("a-run");
		const aCwd = await mk("a-wt");
		const vRun = await mk("v-run");
		const vCwd = await mk("v-wt");
		const root = tmpdir();
		const attacker = join(base, "attacker.ts");
		await writeFile(
			attacker,
			`
const fs = require("node:fs");
const path = require("node:path");
const root = ${JSON.stringify(root)};
const controlRoot = ${JSON.stringify(controlRootPath())};
const out = ${JSON.stringify(join(aRun, "loot"))};
const armed = ${JSON.stringify(join(aRun, "attacker-armed"))};
const done = ${JSON.stringify(join(aRun, "victim-launched"))};
const t0 = Date.now();
fs.writeFileSync(armed, "1");
(async () => {
  // Poll until the victim's launch has settled (the test writes \`done\`);
  // 12 s is only the backstop if that never happens.
  while (!fs.existsSync(done) && Date.now() - t0 < 12000) {
    let found = null;
    // The secret directory lives under the host control root, one level
    // below the temp dir; a sandbox that fails to mask it shows up here.
    for (const dir of [root, controlRoot]) {
      try {
        for (const d of fs.readdirSync(dir)) {
          if (d.startsWith("mfw-driver-secret-")) found = path.join(dir, d);
        }
      } catch {}
    }
    if (found) {
      fs.writeFileSync(out + ".found", found);
      try { ${attackerBody} } catch (e) { fs.appendFileSync(out + ".err", String(e)); }
      return;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
})();
`,
		);
		const victim = join(base, "victim.ts");
		await writeFile(victim, "process.exit(0);");
		// The victim starts only once the attacker is polling, so the attacker
		// is always there to see the secret directory appear.
		const armed = join(aRun, "attacker-armed");
		const { runner, procs } = runShTmux({
			mfw_vic: async () => {
				for (let i = 0; i < 1_000 && !(await exists(armed)); i++)
					await Bun.sleep(10);
			},
		});
		const host = new AgentHost(undefined, { tmuxRunner: runner });
		const common = {
			projectRoot: base,
			agentArgv: ["true"],
			steer: false,
			approvalMode: "autonomous" as const,
			isolation: { mode: "bwrap" as const, hidePaths: [] },
		};
		await host.launch({
			...common,
			runId: "att",
			runDir: aRun,
			cwd: aCwd,
			driverScript: attacker,
			env: {},
		});
		const launched = host
			.launch({
				...common,
				runId: "vic",
				runDir: vRun,
				cwd: vCwd,
				driverScript: victim,
				env: {},
				secretEnvironment: new SecretEnvironment({
					S3CRET_TOKEN: "S3CRET-VALUE",
				}),
			})
			.then(
				() => null,
				(e) => e as Error,
			);
		await launched;
		await writeFile(join(aRun, "victim-launched"), "1");
		await Promise.all([...procs.values()].map((p) => p.exited));
		// The attack must have run: an attacker that never saw the secret
		// directory would "fail" to steal anything for the wrong reason.
		return { aRun, loot: join(aRun, "loot") };
	}

	test("a concurrent run cannot read the secret", async () => {
		const why = await usable();
		if (why) return console.log(`skip: ${why}`);
		const { loot } = await launchPair(`
        fs.closeSync(fs.openSync(path.join(found, "reader-ready"), "w"));
        const fd = fs.openSync(path.join(found, "environment.fifo"), fs.constants.O_RDONLY);
        const buf = Buffer.alloc(4096);
        const n = fs.readSync(fd, buf);
        fs.writeFileSync(out, buf.subarray(0, n));`);
		const stolen = (await exists(loot)) ? await readFile(loot, "utf8") : "";
		expect(stolen).not.toContain("S3CRET-VALUE");
	}, 40_000);

	test("a concurrent run cannot inject code into the victim's outer shell", async () => {
		const why = await usable();
		if (why) return console.log(`skip: ${why}`);
		const { aRun } = await launchPair(`
        fs.writeFileSync(path.join(found, "environment.fifo"), "readlink /proc/self/ns/user > " + out + "\\n");`);
		const out = join(aRun, "loot");
		const escaped = (await exists(out))
			? (await readFile(out, "utf8")).trim() === hostNs()
			: false;
		expect(escaped).toBe(false);
	}, 40_000);
});

describe("G7: the sandbox cannot signal host processes or reach the nix daemon socket", () => {
	test("a host process of the same uid survives a kill from inside; the nix socket dir is empty", async () => {
		const why = await usable();
		if (why) return console.log(`skip: ${why}`);
		const { base, mk } = await work("mfw-g7-");
		const runDir = await mk("run");
		const cwd = await mk("wt");
		const victim = Bun.spawn(["sleep", "60"], {
			stdout: "ignore",
			stderr: "ignore",
		});
		try {
			const driverScript = join(base, "driver.ts");
			await writeFile(
				driverScript,
				`
const fs = require("node:fs");
let killed = "survived";
try { process.kill(${victim.pid}, "SIGKILL"); killed = "signalled"; } catch (e) { killed = String(e.code); }
let nix = "absent";
try { nix = fs.readdirSync("/nix/var/nix/daemon-socket").join(",") || "empty"; } catch {}
fs.writeFileSync(${JSON.stringify(join(runDir, "g7"))}, killed + "|" + nix);
process.exit(0);
`,
			);
			const { runner, procs } = runShTmux();
			const host = new AgentHost(undefined, { tmuxRunner: runner });
			await host.launch({
				runId: "g7",
				runDir,
				cwd,
				projectRoot: base,
				driverScript,
				agentArgv: ["true"],
				env: {},
				steer: false,
				approvalMode: "autonomous",
				isolation: { mode: "bwrap", hidePaths: [] },
			});
			await procs.get("mfw_g7")?.exited;
			const [killed, nix] = (await readFile(join(runDir, "g7"), "utf8")).split(
				"|",
			);
			expect(killed).toBe("ESRCH");
			expect(["absent", "empty"]).toContain(nix as string);
			expect(victim.killed).toBe(false);
			expect(victim.exitCode).toBeNull();
		} finally {
			victim.kill();
		}
	}, 40_000);
});

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

	test("with a sandbox, the direnv gate runs inside it, not in the host shell", async () => {
		const why = await usable();
		if (why) return console.log(`skip: ${why}`);
		const { base, mk } = await work("mfw-g3b-");
		const runDir = await mk("run");
		const cwd = await mk("wt");
		const driverScript = join(base, "driver.ts");
		await writeFile(driverScript, "process.exit(0);");
		const calls: string[][] = [];
		const host = new AgentHost(undefined, {
			tmuxRunner: async (args) => {
				calls.push(args);
				return {
					exitCode: 0,
					stdout: "",
					stderr: "",
					timedOut: false,
					truncated: false,
					signalCode: null,
				};
			},
		});
		await host.launch({
			runId: "g3b",
			runDir,
			cwd,
			projectRoot: base,
			driverScript,
			agentArgv: ["true"],
			env: {},
			steer: false,
			approvalMode: "autonomous",
			isolation: { mode: "bwrap", hidePaths: [] },
		});
		const command = calls.find((c) => c[0] === "new-session")?.at(-1) as string;
		const scriptPath = command.split(" ").at(-1)?.replace(/'/g, "") as string;
		const script = await readFile(scriptPath, "utf8");
		const firstDirenv = script.indexOf("direnv export");
		const bwrapAt = script.indexOf("--clearenv");
		expect(firstDirenv).toBeGreaterThan(bwrapAt);
		expect(script.split("direnv export").length - 1).toBe(1);
	});
});
