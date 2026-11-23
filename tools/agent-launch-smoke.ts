#!/usr/bin/env bun
/**
 * One sandboxed run through the PRODUCTION BUILD (review F5).
 *
 *   bun run build && MFW_REQUIRE_LIVE_SANDBOX=1 bun run smoke:agent
 *
 * The built server takes a human "Run" over HTTP and starts its real egress
 * proxy, driver, bridge, launcher and bwrap sandbox around a fake `claude`.
 * The one stand-in is the systemd scope, as in the conformance tests, so this
 * says nothing about a real scope. No real agent CLI can run: PATH holds only
 * the fake and single-tool store directories. Fixtures live in `.live-sandbox`.
 */
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { saveConfig } from "../packages/daemon/src/config.ts";
import { AGENT_BASE_TOOLS } from "../packages/daemon/src/containment/agent-profile.ts";

const ROOT = resolve(import.meta.dir, "..");
const ENTRY =
	process.env.MFW_SMOKE_ENTRY ??
	join(ROOT, "apps/start/.output/server/index.mjs");
const FIXTURES = join(ROOT, ".live-sandbox");
const SUPPORT = join(ROOT, "packages/daemon/test/support");
const BRIDGE = join(
	ROOT,
	"packages/daemon/src/agents/bridges/claude-app-server.ts",
);
const PASSWORD = "agent smoke owner passphrase";
const AGENT_CLI =
	/^(claude|codex|gemini|opencode|aider|goose|qwen|cursor-agent)$/;
const PROOF = "agent-proof.json";

const FAKE_CLAUDE = `
import { readFileSync, writeFileSync, existsSync } from "node:fs";
writeFileSync(process.cwd() + "/${PROOF}", JSON.stringify({
  cwd: process.cwd(),
  home: process.env.HOME,
  pid1: readFileSync("/proc/1/cmdline", "latin1"),
  sawMfwHome: existsSync(process.env.MFW_SMOKE_HIDDEN ?? "/nonexistent"),
  proxy: process.env.HTTPS_PROXY ?? null,
}));
let buf = "";
for await (const bytes of Bun.stdin.stream()) {
  buf += new TextDecoder().decode(bytes);
  if (!buf.includes("\\n")) continue;
  console.log(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "fake" }] } }));
  console.log(JSON.stringify({ type: "result", result: "fake done", usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0, num_turns: 1 }));
  break;
}
`;

function fail(message: string): never {
	throw new Error(message);
}

function liveSandboxOrFail(): void {
	const bwrap = Bun.which("bwrap");
	const reason = !bwrap
		? "no bwrap on PATH"
		: Bun.spawnSync([
					bwrap,
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
				]).exitCode === 0
			? null
			: "bwrap cannot run here";
	if (!reason) return;
	if (process.env.MFW_REQUIRE_LIVE_SANDBOX === "1")
		fail(`MFW_REQUIRE_LIVE_SANDBOX is set, but ${reason}`);
	console.log(`agent-smoke: skipped: ${reason}`);
	process.exit(0);
}

/** One store directory per tool, so an agent CLI elsewhere is not on PATH. */
function toolPath(bin: string): string {
	const dirs = new Set<string>([bin]);
	for (const tool of [
		...AGENT_BASE_TOOLS,
		"bun",
		"git",
		"bwrap",
		"tmux",
		"env",
		"bash",
		"sh",
		"sleep",
		"systemd-run",
		"flock",
		"setsid",
		"ps",
		"pkill",
		"grep",
		"sed",
		"awk",
	]) {
		const found = Bun.which(tool);
		if (!found) continue;
		const dir = dirname(realpathSync(found));
		if (!readdirSync(dir).some((n) => AGENT_CLI.test(n))) dirs.add(dir);
	}
	return [...dirs].join(":");
}

const freePort = () =>
	new Promise<number>((done, reject) => {
		const s = net.createServer();
		s.once("error", reject);
		s.listen(0, "127.0.0.1", () => {
			const a = s.address();
			const port = typeof a === "object" && a ? a.port : 0;
			s.close(() => done(port));
		});
	});

function git(cwd: string, ...args: string[]): void {
	const r = Bun.spawnSync(
		["git", "-c", "user.name=smoke", "-c", "user.email=s@s.invalid", ...args],
		{ cwd, stdout: "ignore", stderr: "pipe" },
	);
	if (r.exitCode !== 0) fail(`git ${args[0]}: ${r.stderr.toString()}`);
}

async function main(): Promise<number> {
	if (!existsSync(ENTRY)) fail("no production build. Fix: bun run build");
	liveSandboxOrFail();
	mkdirSync(FIXTURES, { recursive: true });
	// Not under /tmp: the sandbox has its own, so fixture paths would not line up.
	const base = realpathSync(mkdtempSync(join(FIXTURES, "agent-smoke-")));
	const home = join(base, "home");
	const bin = join(home, ".local/bin");
	const mfwHome = join(base, "mfw");
	const project = join(base, "project");
	const tmuxSocket = `mfw-agent-smoke-${process.pid}`;
	// A unix socket path has a short limit, which the fixture path would exceed.
	const tmuxDir = mkdtempSync(join(tmpdir(), "mfw-test-tmux-"));
	mkdirSync(bin, { recursive: true });
	mkdirSync(join(mfwHome, "agents/claude"), { recursive: true });
	writeFileSync(join(mfwHome, "agents/claude/settings.json"), "{}\n");
	mkdirSync(join(project, ".mfw"), { recursive: true });
	git(project, "init", "-q", "-b", "main");
	writeFileSync(join(project, "README.md"), "# smoke\n");
	writeFileSync(join(project, ".mfw/AGENTS.md"), "Disposable smoke project.\n");
	git(project, "add", "README.md", ".mfw/AGENTS.md");
	git(project, "commit", "-q", "-m", "init");

	writeFileSync(join(bin, "fake-claude.ts"), FAKE_CLAUDE);
	const fake = join(bin, "claude");
	writeFileSync(
		fake,
		`#!/bin/sh\nexec bun --config=/dev/null --no-env-file run '${join(bin, "fake-claude.ts")}' "$@"\n`,
	);
	chmodSync(fake, 0o755);
	const shim = join(base, "systemd-run-shim");
	writeFileSync(
		shim,
		'#!/bin/sh\nwhile [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n',
	);
	chmodSync(shim, 0o755);
	const path = toolPath(bin);
	const cageConfig = JSON.stringify({ home, path, shim });
	const bridge = join(base, "caged-bridge.ts");
	writeFileSync(
		bridge,
		`process.env.MFW_CAGE_CONFIG = ${JSON.stringify(cageConfig)};
await import(${JSON.stringify(join(SUPPORT, "caged-launcher-preload.ts"))});
await import(${JSON.stringify(BRIDGE)});
`,
	);

	await saveConfig(
		{
			projects: [
				{
					name: "smoke",
					root: project,
					integrationBranch: "main",
					schedulerAutostart: false,
					agentIsolation: "bwrap",
					approvalMode: "autonomous",
					runWorkspace: "clone",
					pushOnMerge: false,
					provider: { id: "claude-cli", type: "claude-cli" },
				},
			],
			dispatchPaused: false,
		} as never,
		mfwHome,
	);

	const port = await freePort();
	const origin = `http://127.0.0.1:${port}/mfw`;
	const logFile = join(base, "server.log");
	const server = Bun.spawn(
		[
			process.execPath,
			`--preload=${join(SUPPORT, "caged-server-preload.ts")}`,
			"run",
			ENTRY,
		],
		{
			cwd: ROOT,
			env: {
				PATH: path,
				HOME: home,
				MFW_HOME: mfwHome,
				HOST: "127.0.0.1",
				PORT: String(port),
				MFW_USAGE_MONITOR: "0",
				MFW_TMUX_SOCKET: tmuxSocket,
				TMUX_TMPDIR: tmuxDir,
				MFW_CAGE_CONFIG: cageConfig,
				MFW_CLAUDE_BRIDGE_SCRIPT: bridge,
			},
			stdout: Bun.file(logFile),
			stderr: Bun.file(logFile),
		},
	);
	const tail = () => {
		try {
			return readFileSync(logFile, "utf8").slice(-1800);
		} catch {
			return "(no log)";
		}
	};
	let ok = false;
	try {
		let up = false;
		for (let i = 0; i < 240 && !up; i++) {
			up = await fetch(`${origin}/api/health`)
				.then((r) => r.ok)
				.catch(() => false);
			if (!up) await Bun.sleep(100);
		}
		if (!up) fail(`server did not start:\n${tail()}`);
		const tokenFile = join(mfwHome, "setup-token");
		for (let i = 0; i < 50 && !existsSync(tokenFile); i++) await Bun.sleep(100);
		const setup = await fetch(`${origin}/api/auth/setup`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-mfw-auth": "1" },
			body: JSON.stringify({
				token: readFileSync(tokenFile, "utf8").trim(),
				password: PASSWORD,
			}),
		});
		if (!setup.ok) fail(`setup returned ${setup.status}`);
		const { requestKey } = (await setup.json()) as { requestKey: string };
		const cookie = (
			setup.headers.getSetCookie().find((c) => !c.includes("Max-Age=0")) ?? ""
		).split(";")[0] as string;
		const mutate = async <T>(procedure: string, json: unknown): Promise<T> => {
			const r = await fetch(`${origin}/api/trpc/${procedure}`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					cookie,
					"x-mfw-key": requestKey,
				},
				body: JSON.stringify({ json }),
			});
			const body = (await r.json()) as {
				result?: { data?: { json?: T } };
				error?: unknown;
			};
			if (!r.ok || body.result?.data?.json === undefined)
				fail(
					`${procedure} failed: ${JSON.stringify(body.error).slice(0, 900)}`,
				);
			return body.result.data.json as T;
		};
		const task = await mutate<{ id: string }>("tasks.create", {
			project: "smoke",
			title: "smoke task",
			body: "write nothing",
			status: "ready",
		});
		const started = await mutate<{ runId: string }>("runs.startTask", {
			project: "smoke",
			taskId: task.id,
		});
		const proofFile = join(mfwHome, "workspaces", started.runId, "tree", PROOF);
		let proof: Record<string, unknown> | null = null;
		for (let i = 0; i < 900 && !proof; i++) {
			try {
				proof = JSON.parse(readFileSync(proofFile, "utf8"));
			} catch {
				await Bun.sleep(100);
			}
		}
		if (!proof) fail(`the fake agent never ran:\n${tail()}`);
		const checks: [string, boolean][] = [
			["agent ran in the sandbox workspace", proof.cwd === "/work"],
			[
				"agent's pid 1 is the sandbox's",
				!String(proof.pid1).includes("index.mjs"),
			],
			["agent's HOME is not the host's", proof.home !== home],
			["agent reaches the network only by its relay", !!proof.proxy],
		];
		for (const [name, passed] of checks)
			console.log(`${passed ? "ok  " : "FAIL"} ${name}`);
		ok = checks.every(([, passed]) => passed);
		console.log(`agent-smoke: ${ok ? "passed" : "failed"}`);
	} finally {
		Bun.spawnSync(["tmux", "-L", tmuxSocket, "kill-server"], {
			env: { PATH: path, TMUX_TMPDIR: tmuxDir },
			stdout: "ignore",
			stderr: "ignore",
		});
		server.kill("SIGTERM");
		await Promise.race([server.exited, Bun.sleep(5000)]);
		server.kill("SIGKILL");
		await server.exited;
		rmSync(tmuxDir, { recursive: true, force: true });
		if (ok && base.startsWith(`${FIXTURES}${sep}agent-smoke-`))
			rmSync(base, { recursive: true, force: true });
		else console.log(`agent-smoke: fixture kept at ${base}`);
	}
	return ok ? 0 : 1;
}

if (import.meta.main) {
	try {
		process.exit(await main());
	} catch (e) {
		console.error(`agent-smoke: ${(e as Error).message}`);
		process.exit(1);
	}
}
