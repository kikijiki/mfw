import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import { sql } from "drizzle-orm";
import { AgentHost } from "../src/agent-host.ts";
import {
	type AgentLaunchRequest,
	launchAgentSandbox,
} from "../src/containment/agent-launch.ts";
import { MAX_RELAY_LINE_BYTES } from "../src/containment/agent-launch-run.ts";
import {
	AGENT_BASE_TOOLS,
	TEMPORARY_FLEET_WRITABLE,
} from "../src/containment/agent-profile.ts";
import {
	ensureRunDirLayout,
	runEventsPath,
} from "../src/containment/run-dir.ts";
import { controlRootPath } from "../src/sandbox.ts";
import { type CageConfig, cagedSteps } from "./support/caged-launch.ts";
import { runShTmux } from "./support/run-sh-tmux.ts";

/**
 * Acceptance (h) and (i) of the host bridge: fake agent CLIs, launched through
 * the real probe, gate and launcher under real bwrap, try every escape the
 * earlier suites know. Fixture homes only. Each destructive scenario starts
 * with a positive canary inside the sandbox and exits 99 without acting if it
 * is not plainly contained. The systemd scope is a stand-in (see caged-launch).
 */

const BWRAP = Bun.which("bwrap");
const GIT = Bun.which("git");
const BUN = realpathSync(process.execPath);
const FIXTURES = resolve(import.meta.dir, "../../../.live-sandbox");

function skipReason(): string | null {
	if (process.arch !== "x64") return "seccomp is x86_64 only";
	if (!BWRAP || !GIT) return "no bwrap or git";
	const r = Bun.spawnSync([
		BWRAP,
		"--unshare-all",
		"--unshare-user",
		"--disable-userns",
		"--ro-bind",
		"/",
		"/",
		"--proc",
		"/proc",
		"--dev",
		"/dev",
		"--",
		"true",
	]);
	return r.exitCode === 0 ? null : "bwrap cannot run here";
}
const skip = skipReason();
if (skip) console.log(`[agent-bridge-conformance] skipped: ${skip}`);

/** The real directories of the base tools, so a fixture home cannot shadow them. */
function toolDirs(): string[] {
	const dirs = AGENT_BASE_TOOLS.flatMap((tool) => {
		const found = Bun.which(tool);
		return found ? [dirname(realpathSync(found))] : [];
	});
	return [...new Set(dirs)];
}

interface Fixture {
	base: string;
	home: string;
	mfwHome: string;
	project: string;
	stateDir: string;
	runDir: string;
	tree: string;
	gitDir: string;
	bin: string;
	cage: CageConfig;
	cageFile: string;
	handle: ProjectDbHandle;
}

let f: Fixture;

async function makeFixture(runId = "r1"): Promise<Fixture> {
	// Not under /tmp: the sandbox has its own /tmp, where a write to a fixture
	// path would land on a private tmpfs and look like an escape.
	mkdirSync(FIXTURES, { recursive: true });
	const base = realpathSync(mkdtempSync(join(FIXTURES, "conformance-")));
	const home = join(base, "home");
	const bin = join(home, ".local/bin");
	mkdirSync(bin, { recursive: true });
	mkdirSync(join(home, ".ssh"));
	writeFileSync(join(home, ".ssh/id_canary"), "not a real key\n");
	mkdirSync(join(home, ".config"));
	writeFileSync(join(home, ".config/canary"), "fixture config\n");
	const mfwHome = join(base, "mfw");
	mkdirSync(mfwHome);
	writeFileSync(join(mfwHome, "credentials.json"), "{}\n");
	for (const cli of ["claude", "codex"] as const) {
		for (const rel of TEMPORARY_FLEET_WRITABLE[cli]) {
			mkdirSync(join(mfwHome, "agents", cli, rel), { recursive: true });
		}
		writeFileSync(join(mfwHome, "agents", cli, "settings.json"), "{}\n");
	}
	const clone = join(mfwHome, "workspaces", runId);
	const tree = join(clone, "tree");
	const gitDir = join(clone, "git");
	mkdirSync(tree, { recursive: true });
	mkdirSync(gitDir);
	writeFileSync(join(clone, "mfw-workspace.json"), "{}");
	Bun.spawnSync([
		GIT as string,
		"--git-dir",
		gitDir,
		"init",
		"-q",
		"--template=",
	]);
	const sibling = join(mfwHome, "workspaces/other/tree");
	mkdirSync(sibling, { recursive: true });
	writeFileSync(join(sibling, "canary"), "another run\n");
	const project = join(base, "project");
	mkdirSync(project);
	writeFileSync(join(project, "primary.txt"), "primary\n");
	const stateDir = join(project, ".mfw");
	const runDir = join(stateDir, "runs", runId);
	ensureRunDirLayout(runDir);
	writeFileSync(join(runDir, "control/steer.jsonl"), "");
	writeFileSync(join(runDir, "meta.json"), "{}\n");
	const handle = await openProjectDb(stateDir);
	const shim = join(base, "systemd-run-shim");
	writeFileSync(
		shim,
		'#!/bin/sh\nwhile [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n',
	);
	chmodSync(shim, 0o755);
	const cage: CageConfig = {
		home,
		path: [
			bin,
			dirname(BUN),
			dirname(realpathSync(GIT as string)),
			...toolDirs(),
		].join(":"),
		shim,
	};
	const cageFile = join(base, "cage.json");
	writeFileSync(cageFile, JSON.stringify(cage));
	return {
		base,
		home,
		mfwHome,
		project,
		stateDir,
		runDir,
		tree,
		gitDir,
		bin,
		cage,
		cageFile,
		handle,
	};
}

function hashTree(path: string, out: string[] = []): string[] {
	const st = lstatSync(path);
	if (st.isSymbolicLink()) out.push(`${path} -> ${readlinkSync(path)}`);
	else if (st.isDirectory()) {
		out.push(`${path}/`);
		for (const name of readdirSync(path).sort()) {
			hashTree(join(path, name), out);
		}
	} else {
		const sum = createHash("sha256").update(readFileSync(path)).digest("hex");
		out.push(`${path} ${st.mode & 0o777} ${sum}`);
	}
	return out;
}

/** Everything no agent may change. The clone, outbox and DB are not in it. */
function protectedState(x: Fixture): string[] {
	return [
		x.home,
		join(x.project, "primary.txt"),
		join(x.runDir, "control"),
		join(x.runDir, "meta.json"),
		join(x.mfwHome, "credentials.json"),
		join(x.mfwHome, "workspaces/other"),
		join(x.mfwHome, "agents/claude/settings.json"),
		join(x.mfwHome, "agents/codex/settings.json"),
	].flatMap((p) => hashTree(p));
}

const request = (x: Fixture): AgentLaunchRequest => ({
	version: 1,
	runId: "r1",
	role: "task",
	approvalMode: "autonomous",
	cli: "claude",
	tree: x.tree,
	runDir: x.runDir,
	projectRoot: x.project,
	stateDir: x.stateDir,
	mfwHome: x.mfwHome,
	env: { MFW_RUN_ID: "r1", MFW_REPORT_PATH: "/work/MFW_REPORT.json" },
	secretNames: [],
});

/** The positive canary: exit 99, doing nothing, unless plainly contained. */
const guard = (x: Fixture) => `
command -v rm cat touch mv ln chmod mkdir git >/dev/null || exit 99
[ "$HOME" = /sandbox/agent ] || exit 99
[ "$(pwd)" = /work ] || exit 99
for p in ${[x.home, x.mfwHome, x.project, homedir()]
	.map((p) => `'${p}/.ssh' '${p}/.config' '${p}/credentials.json' '${p}/.mfw'`)
	.join(" ")}; do
  [ ! -e "$p" ] || exit 99
done
if touch /mfw-not-contained 2>/dev/null; then exit 99; fi
echo alive > /work/.canary || exit 99
`;

function installAgent(x: Fixture, body: string): void {
	const script = join(x.bin, "claude");
	writeFileSync(
		script,
		`#!/bin/sh\n${guard(x)}\nRESULT=/mfw-run/outbox/result\n: > "$RESULT"\n${body}\nexit 0\n`,
	);
	chmodSync(script, 0o755);
}

async function runAgent(x: Fixture, body: string) {
	installAgent(x, body);
	const secretFree = await launchAgentSandbox(request(x), ["claude"], {
		...cagedSteps(x.cage),
		db: x.handle.db,
		secretValue: () => undefined,
		warn: () => {},
	});
	if (!secretFree.ok) {
		throw new Error(`refused: ${secretFree.code}: ${secretFree.reason}`);
	}
	const { child } = secretFree;
	(child.stdin as unknown as { end(): void }).end();
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout as never).text(),
		new Response(child.stderr as never).text(),
		child.exited,
	]);
	const resultPath = join(x.runDir, "outbox/result");
	const result = existsSync(resultPath) ? readFileSync(resultPath, "utf8") : "";
	return { code, stdout, stderr, result };
}

/** Runs a scenario and holds it to the canary and the untouched host state. */
async function attack(body: string) {
	installAgent(f, body);
	const before = protectedState(f);
	const r = await runAgent(f, body);
	expect({ code: r.code, stderr: r.code === 0 ? "" : r.stderr }).toEqual({
		code: 0,
		stderr: "",
	});
	expect(r.result).not.toContain("ESCAPED");
	expect(protectedState(f)).toEqual(before);
	return r;
}

const tryWrite = (path: string, label: string) =>
	`if ( : > '${path}' ) 2>/dev/null; then echo "ESCAPED write ${label}" >> "$RESULT"; fi`;

describe.skipIf(skip !== null)("a hostile agent under the host bridge", () => {
	beforeEach(async () => {
		f = await makeFixture();
	});
	afterEach(() => {
		f.handle.close();
		rmSync(f.base, { recursive: true, force: true });
	});

	test("the canary itself runs, and a guard failure stops the scenario", async () => {
		const ok = await runAgent(f, 'echo reached >> "$RESULT"');
		expect(ok.code).toBe(0);
		expect(ok.result).toContain("reached");
		expect(existsSync(join(f.tree, ".canary"))).toBe(true);
		// The negative control: a guard that sees a protected path never acts.
		const script = `[ -e /proc/self ] && exit 99\necho reached >> /work/after-guard\n`;
		const stopped = await runAgent(f, script);
		expect(stopped.code).toBe(99);
		expect(existsSync(join(f.tree, "after-guard"))).toBe(false);
	}, 60_000);

	test('rm -rf "$UNSET/"* destroys nothing outside the sandbox', async () => {
		// The real expansion, walking every top-level path. The large read-only
		// trees are skipped only because each file there is a slow EROFS.
		const r = await attack(`
for top in "$UNSET/"*; do
  case "$top" in /nix|/usr|/proc|/sys) continue ;; esac
  rm -rf "$top" 2>/dev/null
done
rm -rf "$UNSET"/.[!.]* 2>/dev/null
`);
		// Proof it really ran: the agent's own workspace is gone.
		expect(existsSync(join(f.tree, ".canary"))).toBe(false);
		expect(r.code).toBe(0);
		expect(readFileSync(join(f.home, ".ssh/id_canary"), "utf8")).toContain(
			"not a real key",
		);
	}, 60_000);

	test("writing outside the workspace fails everywhere", async () => {
		await attack(
			[
				tryWrite(join(f.home, "planted"), "home"),
				tryWrite(join(f.project, "planted"), "project"),
				tryWrite(join(f.stateDir, "planted"), "state"),
				tryWrite(join(f.mfwHome, "planted"), "mfw home"),
				tryWrite(join(f.mfwHome, "workspaces/other/tree/planted"), "sibling"),
				tryWrite("/etc/planted", "etc"),
				tryWrite("/usr/planted", "usr"),
				tryWrite("/planted", "root"),
				tryWrite("/run/mfw-planted", "run"),
				tryWrite("/fleet/claude/settings.json", "fleet settings"),
				tryWrite("/fleet/claude/planted", "fleet root"),
				tryWrite(`${f.bin}/planted`, "toolchain"),
			].join("\n"),
		);
		for (const p of [
			join(f.home, "planted"),
			join(f.project, "planted"),
			join(f.mfwHome, "planted"),
		]) {
			expect(existsSync(p)).toBe(false);
		}
	}, 60_000);

	test("host sockets are out of reach", async () => {
		const sockPath = join(f.project, "host.sock");
		const abstract = `\0mfw-conformance-${process.pid}`;
		let connections = 0;
		const count = (s: net.Socket) => {
			connections++;
			s.destroy();
		};
		const servers = [
			net.createServer(count),
			net.createServer(count),
			net.createServer(count),
		];
		await new Promise<void>((r) => servers[0]?.listen(sockPath, r));
		await new Promise<void>((r) => servers[1]?.listen(abstract, r));
		await new Promise<void>((r) => servers[2]?.listen(0, "127.0.0.1", r));
		const port = (servers[2]?.address() as net.AddressInfo).port;
		// Positive control: the listeners do answer from outside the sandbox.
		await new Promise<void>((r, j) =>
			net.connect(sockPath).once("connect", r).once("error", j),
		);
		await Bun.sleep(20);
		const baseline = connections;
		expect(baseline).toBe(1);
		const probe = `
const net = require("node:net");
const targets = [{ path: ${JSON.stringify(sockPath)} }, { path: ${JSON.stringify(abstract)} }, { host: "127.0.0.1", port: ${port} }];
let reached = 0;
for (const t of targets) {
  await new Promise((done) => {
    const s = net.connect(t);
    s.once("connect", () => { reached++; s.destroy(); done(); });
    s.once("error", () => done());
    setTimeout(done, 800);
  });
}
if (reached) require("node:fs").appendFileSync("/mfw-run/outbox/result", "ESCAPED socket\\n");
`;
		writeFileSync(join(f.tree, "sock.ts"), probe);
		try {
			await attack(
				"bun --config=/dev/null --no-env-file run /work/sock.ts 2>/dev/null",
			);
			expect(connections).toBe(baseline);
		} finally {
			for (const s of servers) s.close();
		}
	}, 60_000);

	test("the real config and credentials cannot be read", async () => {
		await attack(`
for p in '${f.home}/.config/canary' '${f.home}/.ssh/id_canary' '${f.mfwHome}/credentials.json' '${f.stateDir}/mfw.db'; do
  if cat "$p" >/dev/null 2>&1; then echo "ESCAPED read $p" >> "$RESULT"; fi
done
`);
	}, 60_000);

	test("host processes cannot be signalled", async () => {
		const victim = Bun.spawn(["sleep", "60"]);
		try {
			await attack(`
if kill -0 ${victim.pid} 2>/dev/null; then echo "ESCAPED sees pid" >> "$RESULT"; fi
kill -9 ${victim.pid} 2>/dev/null
kill -9 -1 2>/dev/null
`);
			await Bun.sleep(50);
			expect(victim.exitCode).toBeNull();
		} finally {
			victim.kill("SIGKILL");
		}
	}, 60_000);

	test("no terminal is reachable, and an OSC 52 stays plain bytes in a pipe", async () => {
		const r = await attack(`
[ ! -e /dev/console ] || echo "ESCAPED console" >> "$RESULT"
if ( : > /dev/tty ) 2>/dev/null; then echo "ESCAPED tty" >> "$RESULT"; fi
[ ! -t 0 ] && [ ! -t 1 ] && [ ! -t 2 ] || echo "ESCAPED stdio tty" >> "$RESULT"
printf '\\033]52;c;ZXZpbA==\\007'
printf '\\033]52;c;ZXZpbA==\\007' >&2
`);
		expect(r.stdout).toContain("]52;c;");
	}, 60_000);

	test("the control dir cannot be written, renamed or shadowed", async () => {
		await attack(`
${tryWrite("/mfw-run/control/exit", "control exit")}
${tryWrite("/mfw-run/control/steer.jsonl", "control steer")}
if mv /mfw-run/control /mfw-run/moved 2>/dev/null; then echo "ESCAPED rename" >> "$RESULT"; fi
if rm -rf /mfw-run/control/steer.jsonl 2>/dev/null && [ ! -e /mfw-run/control/steer.jsonl ]; then echo "ESCAPED delete" >> "$RESULT"; fi
if ln -s / /mfw-run/planted 2>/dev/null; then echo "ESCAPED plant" >> "$RESULT"; fi
`);
		expect(existsSync(join(f.runDir, "control/exit"))).toBe(false);
	}, 60_000);

	test("a forged exit and a planted event stream prove nothing", async () => {
		await attack(`
printf 'exit:0' > /mfw-run/outbox/exit
ln -s '${f.home}/.ssh/id_canary' /mfw-run/outbox/events.jsonl
`);
		writeFileSync(join(f.runDir, "control/driver.json"), "{}");
		writeFileSync(join(f.runDir, "control/host-bridge"), "1\n");
		const host = new AgentHost(undefined, { tmuxRunner: runShTmux().runner });
		const evidence = await host.readExitEvidence(f.runDir);
		expect(evidence.exit.kind).toBe("running");
		expect(runEventsPath(f.runDir)).toBe(join(f.runDir, "events.jsonl"));
	}, 60_000);

	test("tampering with the clone's git config stays in the clone", async () => {
		const primary = join(f.project, "primary.txt");
		const before = readFileSync(primary, "utf8");
		await attack(`
git config core.fsmonitor '/bin/sh -c "touch ${f.home}/pwned"'
git config core.hooksPath /work/hooks
git config core.sshCommand 'touch ${f.home}/pwned'
mkdir -p /work/hooks
printf '#!/bin/sh\\ntouch ${f.home}/pwned\\n' > /work/hooks/post-commit
chmod +x /work/hooks/post-commit
`);
		expect(readFileSync(join(f.gitDir, "config"), "utf8")).toContain(
			"fsmonitor",
		);
		expect(existsSync(join(f.home, "pwned"))).toBe(false);
		expect(readFileSync(primary, "utf8")).toBe(before);
	}, 60_000);

	test("an attestation is single-use across launches", async () => {
		await runAgent(f, "true");
		const [row] = await f.handle.db.all<{ n: number }>(
			sql`SELECT count(*) AS n FROM sandbox_attestation_uses WHERE run_id = 'r1'`,
		);
		expect(row?.n).toBe(1);
		await runAgent(f, "true");
		const [again] = await f.handle.db.all<{ n: number }>(
			sql`SELECT count(*) AS n FROM sandbox_attestation_uses WHERE run_id = 'r1'`,
		);
		expect(again?.n).toBe(2);
	}, 60_000);

	test("a workspace swapped after the probe is refused by its pin", async () => {
		installAgent(f, "true");
		const steps = cagedSteps(f.cage);
		const moved = `${f.tree}.moved`;
		const r = await launchAgentSandbox(request(f), ["claude"], {
			...steps,
			attest: (async (req: Parameters<typeof steps.attest>[0]) => {
				const out = await steps.attest(req);
				// Same path, different directory, after the probe recorded its pin.
				Bun.spawnSync(["mv", f.tree, moved]);
				mkdirSync(f.tree);
				return out;
			}) as typeof steps.attest,
			db: f.handle.db,
			secretValue: () => undefined,
			warn: () => {},
			launch: ((...args: Parameters<typeof steps.launch>) => {
				return steps.launch(...args);
			}) as typeof steps.launch,
		}).catch((e: Error & { code?: string }) => ({ thrown: e.code }));
		expect(r).toEqual({ thrown: "pin_changed" });
	}, 60_000);
});

describe.skipIf(skip !== null)("the launcher process", () => {
	beforeEach(async () => {
		f = await makeFixture();
	});
	afterEach(() => {
		f.handle.close();
		rmSync(f.base, { recursive: true, force: true });
	});

	function spawnCaged(body: string) {
		installAgent(f, body);
		const dir = mkdtempSync(join(f.base, "req-"));
		chmodSync(dir, 0o700);
		const requestPath = join(dir, "request.json");
		writeFileSync(requestPath, JSON.stringify(request(f)), { mode: 0o600 });
		return Bun.spawn(
			[
				process.execPath,
				"--config=/dev/null",
				"--no-env-file",
				"run",
				resolve(import.meta.dir, "support/caged-launcher.ts"),
				requestPath,
				"--",
				"claude",
			],
			{
				cwd: dir,
				env: {
					PATH: process.env.PATH ?? "",
					MFW_CAGE_CONFIG: readFileSync(f.cageFile, "utf8"),
				},
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
	}

	async function waitForFile(path: string, ms = 20_000) {
		const start = Date.now();
		while (Date.now() - start < ms) {
			if (existsSync(path)) return true;
			await Bun.sleep(25);
		}
		return false;
	}

	/** True when the file stopped growing, so its writer is dead. */
	async function stoppedGrowing(path: string) {
		await Bun.sleep(400);
		const first = readFileSync(path, "utf8").length;
		await Bun.sleep(700);
		return readFileSync(path, "utf8").length === first;
	}

	const HEARTBEAT = `
trap '' HUP TERM INT
echo up > /work/started
while :; do echo beat >> /work/heartbeat; sleep 0.05; done
`;

	test.each([
		"SIGHUP",
		"SIGTERM",
		"SIGKILL",
	] as const)("%s to the launcher ends an agent that ignores signals", async (signal) => {
		const child = spawnCaged(HEARTBEAT);
		const up = await waitForFile(join(f.tree, "started"));
		expect(up).toBe(true);
		await waitForFile(join(f.tree, "heartbeat"));
		child.kill(signal);
		await child.exited;
		expect(await stoppedGrowing(join(f.tree, "heartbeat"))).toBe(true);
	}, 40_000);

	test("a line with no newline is cut off before it can fill the host", async () => {
		writeFileSync(
			join(f.tree, "flood.ts"),
			`const chunk = new Uint8Array(1024 * 1024).fill(0x41);
for (let i = 0; i < 64; i++) await Bun.write(Bun.stdout, chunk);
require("node:fs").writeFileSync("/work/flood-finished", "1");`,
		);
		const child = spawnCaged(
			"bun --config=/dev/null --no-env-file run /work/flood.ts",
		);
		(child.stdin as unknown as { end(): void }).end();
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).arrayBuffer(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(code).toBe(78);
		expect(stderr).toContain("was stopped");
		expect(stdout.byteLength).toBeLessThanOrEqual(MAX_RELAY_LINE_BYTES);
		expect(existsSync(join(f.tree, "flood-finished"))).toBe(false);
	}, 40_000);

	test("long output with newlines passes through whole", async () => {
		writeFileSync(
			join(f.tree, "lines.ts"),
			`const line = "x".repeat(1023) + "\\n";
const chunk = new TextEncoder().encode(line.repeat(1024));
for (let i = 0; i < 24; i++) await Bun.write(Bun.stdout, chunk);`,
		);
		const child = spawnCaged(
			"bun --config=/dev/null --no-env-file run /work/lines.ts",
		);
		(child.stdin as unknown as { end(): void }).end();
		const [stdout, code] = await Promise.all([
			new Response(child.stdout).arrayBuffer(),
			child.exited,
		]);
		expect(code).toBe(0);
		expect(stdout.byteLength).toBe(24 * 1024 * 1024);
	}, 40_000);
});

/**
 * The real chain, with nothing stood in: `systemd-run --user --scope`, real
 * cgroup limits read from the host, the real launcher. It needs a user manager,
 * so it cannot run in a cage. It must pass on a real host before the default
 * flips.
 */
const managerState = Bun.spawnSync(["systemctl", "--user", "is-system-running"])
	.stdout.toString()
	.trim();
const noManager =
	skip ??
	(managerState === "running" || managerState === "degraded"
		? null
		: `no systemd user manager (${managerState || "unavailable"})`);
if (noManager) {
	console.log(
		`[agent-bridge-conformance] real systemd scope chain NOT VERIFIED: ${noManager}`,
	);
}

describe.skipIf(noManager !== null)("the real systemd scope chain", () => {
	beforeEach(async () => {
		f = await makeFixture();
	});
	afterEach(() => {
		f.handle.close();
		rmSync(f.base, { recursive: true, force: true });
	});

	test("the real launcher attests, consumes and runs under a scope", async () => {
		const dir = mkdtempSync(join(f.base, "req-"));
		chmodSync(dir, 0o700);
		const requestPath = join(dir, "request.json");
		writeFileSync(requestPath, JSON.stringify(request(f)), { mode: 0o600 });
		const child = Bun.spawn(
			[
				process.execPath,
				"--config=/dev/null",
				"--no-env-file",
				"run",
				resolve(import.meta.dir, "../src/containment/agent-launch-main.ts"),
				requestPath,
				"--",
				"sh",
				"-c",
				"echo contained > /work/scope-proof",
			],
			{ cwd: dir, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
		);
		const [stderr, code] = await Promise.all([
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect({ code, stderr: code === 0 ? "" : stderr }).toEqual({
			code: 0,
			stderr: "",
		});
		expect(readFileSync(join(f.tree, "scope-proof"), "utf8")).toBe(
			"contained\n",
		);
		const [row] = await f.handle.db.all<{ n: number }>(
			sql`SELECT count(*) AS n FROM sandbox_attestation_uses WHERE run_id = 'r1'`,
		);
		expect(row?.n).toBe(1);
	}, 60_000);
});

const FAKE_CLAUDE = `
import { writeFileSync } from "node:fs";
writeFileSync("/work/agent-proof.json", JSON.stringify({
  home: process.env.HOME, cwd: process.cwd(), config: process.env.CLAUDE_CONFIG_DIR,
  report: process.env.MFW_REPORT_PATH, argv: process.argv.slice(2),
}));
let buf = "";
for await (const bytes of Bun.stdin.stream()) {
  buf += new TextDecoder().decode(bytes);
  let at;
  while ((at = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, at); buf = buf.slice(at + 1);
    if (!line.trim()) continue;
    console.log(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hello from the fake" }] } }));
    console.log(JSON.stringify({ type: "result", result: "fake done", usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0, num_turns: 1 }));
  }
}
`;

describe.skipIf(skip !== null)("the real drivers and bridges", () => {
	beforeEach(async () => {
		f = await makeFixture();
	});
	afterEach(async () => {
		f.handle.close();
		rmSync(f.base, { recursive: true, force: true });
	});
	afterAll(() => {
		for (const name of ["agent-launch-r1.json", "run-r1.sh", "exit-r1"]) {
			rmSync(join(controlRootPath(), name), { force: true });
		}
	});

	const preload = resolve(import.meta.dir, "support/caged-launcher-preload.ts");
	const src = resolve(import.meta.dir, "../src/agents");

	async function runBridged(cli: "claude" | "codex") {
		const bridge = join(
			src,
			"bridges",
			cli === "claude" ? "claude-app-server.ts" : "codex-app-server-bridge.ts",
		);
		const providerArgv =
			cli === "claude"
				? ["claude", "--print", "--dangerously-skip-permissions"]
				: ["codex", "app-server"];
		const { runner, procs } = runShTmux(
			{},
			{ MFW_CAGE_CONFIG: readFileSync(f.cageFile, "utf8").trim() },
		);
		const host = new AgentHost(undefined, { tmuxRunner: runner });
		await host.launch({
			runId: "r1",
			runDir: f.runDir,
			cwd: f.tree,
			projectRoot: f.project,
			driverScript: join(src, "drivers/app-server-driver.ts"),
			agentArgv: providerArgv,
			bridgeArgv: ["bun", "run", `--preload=${preload}`, bridge],
			providerArgv,
			env: {
				MFW_RUN_ID: "r1",
				MFW_REPORT_PATH: join(f.tree, "MFW_REPORT.json"),
			},
			model: "fake",
			reasoningEffort: "high",
			initialMessage: "hello",
			steer: false,
			approvalMode: "autonomous",
			isolation: { mode: "bwrap", hidePaths: [f.mfwHome], mfwHome: f.mfwHome },
			runKind: "task",
			providerId: `${cli}-cli`,
		});
		await procs.get("mfw_r1")?.exited;
		const exit = await host.readExit(f.runDir);
		const raw = readFileSync(join(f.runDir, "raw.log"), "utf8");
		const eventsPath = runEventsPath(f.runDir);
		const events = existsSync(eventsPath)
			? readFileSync(eventsPath, "utf8")
					.trim()
					.split("\n")
					.map((l) => JSON.parse(l) as { type: string; reason?: string })
			: [];
		return { exit, raw, events, eventsPath };
	}

	test("claude runs under the bridge, in the sandbox", async () => {
		writeFileSync(join(f.bin, "fake-claude.ts"), FAKE_CLAUDE);
		const script = join(f.bin, "claude");
		writeFileSync(
			script,
			`#!/bin/sh\nexec bun --config=/dev/null --no-env-file run '${join(f.bin, "fake-claude.ts")}' "$@"\n`,
		);
		chmodSync(script, 0o755);
		const r = await runBridged("claude");
		expect({
			exit: r.exit,
			raw: r.exit.kind === "exit" && r.exit.code === 0 ? "" : r.raw,
		}).toEqual({
			exit: { kind: "exit", code: 0 },
			raw: "",
		});
		expect(r.eventsPath).toBe(join(f.runDir, "events.jsonl"));
		expect(r.events.at(-1)).toMatchObject({ type: "done", reason: "complete" });
		const proof = JSON.parse(
			readFileSync(join(f.tree, "agent-proof.json"), "utf8"),
		);
		expect(proof).toMatchObject({
			home: "/sandbox/agent",
			cwd: "/work",
			config: "/fleet/claude",
			report: "/work/MFW_REPORT.json",
		});
		expect(proof.argv).toContain("--dangerously-skip-permissions");
		const [row] = await f.handle.db.all<{ n: number }>(
			sql`SELECT count(*) AS n FROM sandbox_attestation_uses WHERE run_id = 'r1'`,
		);
		expect(row?.n).toBe(1);
	}, 90_000);

	test("codex runs under the bridge, in the sandbox", async () => {
		copyFileSync(
			resolve(import.meta.dir, "fixtures/fake-codex-app-server.ts"),
			join(f.bin, "fake-codex.ts"),
		);
		const script = join(f.bin, "codex");
		writeFileSync(
			script,
			`#!/bin/sh\necho "$HOME $(pwd) $CODEX_HOME" > /work/agent-proof.txt\nexec bun --config=/dev/null --no-env-file run '${join(f.bin, "fake-codex.ts")}'\n`,
		);
		chmodSync(script, 0o755);
		const r = await runBridged("codex");
		expect({
			exit: r.exit,
			raw: r.exit.kind === "exit" && r.exit.code === 0 ? "" : r.raw,
		}).toEqual({
			exit: { kind: "exit", code: 0 },
			raw: "",
		});
		expect(r.events.at(-1)).toMatchObject({ type: "done", reason: "complete" });
		expect(readFileSync(join(f.tree, "agent-proof.txt"), "utf8").trim()).toBe(
			"/sandbox/agent /work /fleet/codex",
		);
	}, 90_000);

	test("the real launcher refuses on a host without a user manager", async () => {
		const noManager = Bun.spawnSync([
			"systemctl",
			"--user",
			"is-system-running",
		]);
		const state = noManager.stdout.toString().trim();
		if (state === "running" || state === "degraded") {
			return console.log("skip: this host has a user manager");
		}
		const dir = mkdtempSync(join(f.base, "req-"));
		chmodSync(dir, 0o700);
		const requestPath = join(dir, "request.json");
		writeFileSync(requestPath, JSON.stringify(request(f)), { mode: 0o600 });
		const script = join(f.bin, "claude");
		writeFileSync(script, `#!/bin/sh\ntouch '${join(f.base, "agent-ran")}'\n`);
		chmodSync(script, 0o755);
		const child = Bun.spawn(
			[
				process.execPath,
				"--config=/dev/null",
				"--no-env-file",
				"run",
				resolve(import.meta.dir, "../src/containment/agent-launch-main.ts"),
				requestPath,
				"--",
				script,
			],
			{ cwd: dir, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
		);
		const [stderr, code] = await Promise.all([
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(code).toBe(78);
		expect(stderr).toContain("mfw sandbox refused");
		expect(existsSync(join(f.base, "agent-ran"))).toBe(false);
	}, 60_000);
});
