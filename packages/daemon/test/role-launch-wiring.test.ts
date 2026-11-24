import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AgentReviewInference,
	ReviewerModifiedError,
} from "../src/agent-review.ts";
import { codexMcpArgs } from "../src/agents/adapter.ts";
import type { BrainMcpServer } from "../src/brain-runtime/turn-run.ts";
import {
	rewriteBrainArgv,
	sandboxMcpServer,
} from "../src/containment/brain-launch.ts";
import { brainTranscriptStore } from "../src/containment/brain-transcript.ts";
import type { OneShotAgentRequest } from "../src/containment/oneshot-agent.ts";
import { git } from "../src/git.ts";
import type { ProcResult } from "../src/proc.ts";
import {
	clearRunWorkspace,
	configureRunWorkspace,
	createCheckClones,
} from "../src/run-workspace/factory.ts";
import { createRoleClone } from "../src/run-workspace/role-clone.ts";
import { SandboxUnavailableError } from "../src/sandbox.ts";

const HOST_SOCKET = "/host/mfw/run/b/abc/brain.sock";
const HOST_TOKEN = "/host/mfw/run/b/abc/token";

const server: BrainMcpServer = {
	name: "mfw_brain",
	command: "bun",
	args: ["run", "/host/src/mcp/main.ts", "--brain", "S1"],
	env: {
		MFW_SOCKET: HOST_SOCKET,
		MFW_BRAIN_TOKEN_FILE: HOST_TOKEN,
		MFW_BRAIN_SESSION: "S1",
		MFW_BRAIN_TURN: "R1",
	},
};

describe("a brain turn's command inside the sandbox", () => {
	test("the MCP server names sandbox paths only", () => {
		const text = JSON.stringify(sandboxMcpServer(server));
		expect(text).not.toContain("/host/");
		expect(text).toContain("/run/mfw/brain/brain.sock");
		expect(text).toContain("/mfw-run/control/mfw-mcp.js");
		expect(text).toContain("--config=/dev/null");
	});

	test("claude's config path is rewritten", () => {
		const argv = rewriteBrainArgv(
			["claude", "--mcp-config", "/host/run/control/mcp.json", "--print"],
			sandboxMcpServer(server),
		);
		expect(argv).toEqual([
			"claude",
			"--mcp-config",
			"/mfw-run/control/mcp.json",
			"--print",
		]);
	});

	test("codex's inline server is replaced once", () => {
		const inside = sandboxMcpServer(server);
		const argv = rewriteBrainArgv(
			["codex", "exec", ...codexMcpArgs(server), "--json"],
			inside,
		);
		expect(argv).toEqual(["codex", "exec", ...codexMcpArgs(inside), "--json"]);
		expect(argv.join(" ")).not.toContain("/host/");
	});

	test.each([
		"../escape",
		"a/b",
		"",
	])("the session id %j cannot name a path", (session) => {
		expect(() => brainTranscriptStore("/m", session, "claude")).toThrow(
			"invalid brain session id",
		);
	});
});

// Review P7, m1: a null here sent a clone's agent-writable path to the host.
describe("verifier clones for a project", () => {
	test("a project that never attached has none, so nothing is verified", () => {
		expect(createCheckClones("/nonexistent-project")).toBeNull();
	});
});

describe("the reviewer's sandboxed path", () => {
	const BRANCH = "mfw/task/T-1/x";
	let root: string;
	let project: string;
	let tip: string;

	const reply = (): ProcResult => ({
		exitCode: 0,
		stdout: JSON.stringify({ result: "VERDICT: merge" }),
		stderr: "",
		timedOut: false,
		truncated: false,
		signalCode: null,
	});

	beforeEach(async () => {
		root = await realpath(await mkdtemp(join(tmpdir(), "mfw-role-wire-")));
		project = join(root, "project");
		await git(["init", "-q", "-b", "main", project], root);
		await git(["config", "user.email", "t@t"], project);
		await git(["config", "user.name", "t"], project);
		writeFileSync(join(project, "a.txt"), "base\n");
		await git(["add", "-A"], project);
		await git(["commit", "-q", "-m", "init"], project);
		await git(["branch", BRANCH], project);
		tip = (await git(["rev-parse", "HEAD"], project)).stdout.trim();
		configureRunWorkspace(project, {
			workspaceRoot: join(root, "mfw/workspaces"),
		});
	});

	afterEach(async () => {
		clearRunWorkspace(project);
		await rm(root, { recursive: true, force: true });
	});

	const reviewer = (launch: (r: OneShotAgentRequest) => Promise<ProcResult>) =>
		new AgentReviewInference({
			subject: { projectRoot: project, branch: BRANCH, runWorktree: null },
			harness: "claude-cli",
			host: { mfwHome: join(root, "mfw"), stateDir: join(project, ".mfw") },
			launch: launch as never,
		});

	test("runs as the reviewer role on a private clone, prompt on stdin", async () => {
		let seen: OneShotAgentRequest | null = null;
		let content = "";
		const out = await reviewer(async (r) => {
			seen = r;
			content = readFileSync(join(r.tree, "a.txt"), "utf8");
			return reply();
		}).complete("the secret prompt", { model: "m", timeoutMs: 5000 });
		expect(out.text).toBe("VERDICT: merge");
		const req = seen as unknown as OneShotAgentRequest;
		expect(req.role).toBe("reviewer");
		expect(req.prompt).toBe("the secret prompt");
		expect(req.argv.join(" ")).not.toContain("the secret prompt");
		expect(req.argv).not.toContain("--dangerously-skip-permissions");
		expect(req.tree.startsWith(join(root, "mfw/workspaces/ro-"))).toBe(true);
		expect(content).toBe("base\n");
		expect(existsSync(req.tree)).toBe(false);
	});

	test("a moved branch discards the verdict and the clone still goes", async () => {
		let tree = "";
		await expect(
			reviewer(async (r) => {
				tree = r.tree;
				await git(["commit", "--allow-empty", "-q", "-m", "x"], project);
				await git(["update-ref", `refs/heads/${BRANCH}`, "HEAD"], project);
				return reply();
			}).complete("p", { model: "m", timeoutMs: 5000 }),
		).rejects.toBeInstanceOf(ReviewerModifiedError);
		expect(existsSync(tree)).toBe(false);
	});

	test("without host settings it refuses and nothing runs", async () => {
		let ran = false;
		const r = new AgentReviewInference({
			subject: { projectRoot: project, branch: BRANCH, runWorktree: null },
			harness: "claude-cli",
			launch: (async () => {
				ran = true;
				return reply();
			}) as never,
		});
		await expect(
			r.complete("p", { model: "m", timeoutMs: 5000 }),
		).rejects.toBeInstanceOf(SandboxUnavailableError);
		expect(ran).toBe(false);
	});

	test("a role clone holds exactly the commit and no .git entry", async () => {
		const clone = await createRoleClone(project, "wire", tip);
		expect(clone.sha).toBe(tip);
		expect(readFileSync(join(clone.tree, "a.txt"), "utf8")).toBe("base\n");
		expect(existsSync(join(clone.tree, ".git"))).toBe(false);
		expect(existsSync(join(clone.root, "mfw-workspace.json"))).toBe(true);
	});

	test("a project with no workspace settings gets no clone", async () => {
		clearRunWorkspace(project);
		await expect(createRoleClone(project, "none", tip)).rejects.toThrow(
			"no run workspace settings",
		);
	});
});
