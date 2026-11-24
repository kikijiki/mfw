import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * Nothing in the engine starts an agent CLI on the host outside the sandbox
 * launch. Every source file that spawns a process and also handles an agent
 * command line, or names an agent CLI, is listed here with why it may; a new
 * one fails until someone decides. Agent sessions go through
 * `agentSpawnArgv`, which runs the launcher (`launchSandbox`), never the CLI.
 */

const REPO = resolve(import.meta.dir, "../../..");
const ROOTS = ["packages/daemon/src", "packages/cli/src", "packages/mcp/src"];

const SPAWNS =
	/\bBun\.spawn(?:Sync)?\(|(?<![.\w])spawn(?:Sync)?\(|\brunProc(?:Records)?\(|\bexecFile(?:Sync)?\(/;
const AGENT =
	/\b(?:agentArgv|providerArgv|bridgeArgv|agentSpawnArgv|renderHarnessArgv|builtinHarnessRegistry|byFleetCli)\b|["'`](?:claude|codex|gemini|opencode|cursor-agent|qwen|goose|aider)["'` ]/;

/** Agent sessions: they reach the CLI only through the launcher. */
const VIA_LAUNCHER: Record<string, string> = {
	"packages/daemon/src/agents/drivers/claude-driver.ts":
		"the Claude driver; every agent spawn is agentSpawnArgv",
	"packages/daemon/src/agents/bridges/claude-app-server.ts":
		"the Claude bridge on the host; the CLI is spawned through the launcher",
	"packages/daemon/src/agents/bridges/codex-app-server-bridge.ts":
		"the Codex bridge on the host; the CLI is spawned through the launcher",
	"packages/daemon/src/agents/bridges/codex-exec-bridge.ts":
		"the Codex exec bridge on the host; the CLI is spawned through the launcher",
	"packages/daemon/src/run-workspace/wip-snapshot.ts":
		"the end-of-run snapshot: the launcher, never an agent",
};

/** Not an agent session; each says why. */
const OTHER: Record<string, string> = {
	"packages/daemon/src/agent-host.ts":
		"starts tmux and the host driver; the driver reaches the agent only through the launcher",
	"packages/daemon/src/agents/drivers/app-server-driver.ts":
		"spawns the host bridge (mfw or bun), never the agent CLI",
	"packages/daemon/src/agents/bridges/acp-bridge.ts":
		"remote targets only: a local launch refuses ACP providers before any bridge starts (no sandbox profile)",
	"packages/daemon/src/codex-lane.ts":
		"`codex login status`: a login check, never a prompt or a session",
	"packages/daemon/src/usage/codex-usage.ts":
		"`codex app-server` asked for rate-limit usage only, never a turn",
	"packages/daemon/src/agents/detect.ts":
		"`--version` probes of installed CLIs, never a session",
};

function sources(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...sources(path));
		else if (/\.tsx?$/.test(entry.name)) out.push(path);
	}
	return out;
}

const sites = ROOTS.flatMap((root) => sources(join(REPO, root)))
	.filter((path) => {
		const text = readFileSync(path, "utf8");
		return SPAWNS.test(text) && AGENT.test(text);
	})
	.map((path) => relative(REPO, path))
	.sort();

describe("agent CLI spawn sites", () => {
	test("every file that could start an agent CLI is accounted for", () => {
		const unlisted = sites.filter((p) => !(p in VIA_LAUNCHER || p in OTHER));
		expect(unlisted).toEqual([]);
	});

	test("every agent session goes through the launcher", () => {
		for (const path of Object.keys(VIA_LAUNCHER)) {
			expect(readFileSync(join(REPO, path), "utf8")).toContain(
				"agentSpawnArgv(",
			);
		}
	});

	test("the allowlists name only files that still spawn", () => {
		for (const path of [...Object.keys(VIA_LAUNCHER), ...Object.keys(OTHER)]) {
			expect(sites).toContain(path);
		}
	});

	test("the host CLI inference clients are gone", () => {
		const brain = readFileSync(
			join(REPO, "packages/daemon/src/brain.ts"),
			"utf8",
		);
		for (const name of [
			"ClaudeCliInference",
			"CodexCliInference",
			"AcpInference",
		]) {
			expect(brain).not.toContain(name);
		}
		expect(SPAWNS.test(brain)).toBe(false);
	});
});
