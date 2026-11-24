import { describe, expect, test } from "bun:test";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectDb } from "@mfw/db/client";
import { EventBus } from "@mfw/db/eventlog";
import { reviewVerdicts } from "@mfw/db/schema";
import {
	AgentReviewInference,
	ReviewerModifiedError,
} from "../src/agent-review.ts";
import { BrainService } from "../src/brain.ts";
import type { runOneShotAgent } from "../src/containment/oneshot-agent.ts";
import type { BrainCallCtx } from "../src/finalize/step-runner.ts";
import { git } from "../src/git.ts";
import { silentLogger } from "../src/log.ts";
import type { ProcResult } from "../src/proc.ts";
import { DEFAULT_REVIEW_POLICY } from "../src/review-verdict.ts";
import { RunRegistry } from "../src/run-registry.ts";
import {
	clearRunWorkspace,
	configureRunWorkspace,
} from "../src/run-workspace/factory.ts";

const BRANCH = "mfw/task/T-1/x";
const LEGACY =
	"Deliver the task goal described above (legacy implicit criterion).";

const MERGE_REPLY = [
	"VERDICT: merge",
	"```json",
	JSON.stringify({
		summary: "looks right",
		findings: [],
		criteria: [
			{
				criterion: LEGACY,
				verdict: "met",
				evidenceClass: "reproduced",
				evidence: "ran the focused test",
			},
		],
	}),
	"```",
].join("\n");

async function repo(): Promise<{
	root: string;
	runWt: string;
	base: string;
	cleanup: () => Promise<void>;
}> {
	const root = await mkdtemp(join(tmpdir(), "mfw-agent-review-"));
	await git(["init", "-q", "-b", "main"], root);
	await git(["config", "user.email", "t@t"], root);
	await git(["config", "user.name", "t"], root);
	await writeFile(join(root, "a.txt"), "base\n");
	await git(["add", "-A"], root);
	await git(["commit", "-q", "-m", "init"], root);
	const base = (await git(["rev-parse", "HEAD"], root)).stdout.trim();
	const runWt = join(root, "wt");
	await git(["worktree", "add", "-q", "-b", BRANCH, runWt], root);
	await writeFile(join(root, ".git/info/exclude"), "wt/\n.mfw/\n");
	await writeFile(join(runWt, "a.txt"), "changed\n");
	await git(["commit", "-qam", "work"], runWt);
	const workspaces = await mkdtemp(join(tmpdir(), "mfw-agent-review-ws-"));
	configureRunWorkspace(root, { workspaceRoot: workspaces });
	return {
		root,
		runWt,
		base,
		cleanup: async () => {
			clearRunWorkspace(root);
			await rm(workspaces, { recursive: true, force: true });
			await rm(root, { recursive: true, force: true });
		},
	};
}

function ok(stdout: string): ProcResult {
	return {
		exitCode: 0,
		stdout,
		stderr: "",
		timedOut: false,
		truncated: false,
		signalCode: null,
	};
}

/** A fake reviewer process: records its argv and cwd, then does `act`. */
function fakeAgent(act: (cwd: string) => Promise<void> = async () => {}) {
	const calls: { argv: string[]; cwd: string; prompt: string }[] = [];
	// Stands in for the sandboxed launch: the agent sees the clone as its cwd.
	const run: typeof runOneShotAgent = async (req) => {
		calls.push({ argv: [...req.argv], cwd: req.tree, prompt: req.prompt });
		await act(req.tree);
		return ok(JSON.stringify({ result: MERGE_REPLY, total_cost_usd: 0.01 }));
	};
	return { run, calls };
}

/** Unused by the fake launch, which is all these tests go through. */
const HOST = { mfwHome: "/nonexistent", stateDir: "/nonexistent" };

const OPTS = { model: "opus", timeoutMs: 30_000 };

describe("AgentReviewInference", () => {
	test("reviews in its own checkout of the branch tip, without a permission bypass, and removes it", async () => {
		const r = await repo();
		const agent = fakeAgent();
		const t = new AgentReviewInference({
			subject: { projectRoot: r.root, branch: BRANCH, runWorktree: r.runWt },
			harness: "claude-cli",
			host: HOST,
			launch: agent.run,
		});
		const reply = await t.complete("review it", OPTS);
		expect(reply.text).toBe(MERGE_REPLY);
		expect(reply.usage).toMatchObject({ costUsd: 0.01 });
		const [call] = agent.calls;
		expect(call?.argv).not.toContain("--dangerously-skip-permissions");
		expect(call?.argv).toContain("--allowedTools");
		expect(call?.cwd).not.toBe(r.root);
		expect(call?.cwd).not.toBe(r.runWt);
		await expect(access(call?.cwd as string)).rejects.toThrow();
		const list = await git(["worktree", "list"], r.root);
		expect(list.stdout).not.toContain(call?.cwd as string);
		await r.cleanup();
	});

	test("a reviewer that edits a file in its checkout is caught", async () => {
		const r = await repo();
		const agent = fakeAgent(async (cwd) => {
			await writeFile(join(cwd, "a.txt"), "reviewer was here\n");
		});
		const t = new AgentReviewInference({
			subject: { projectRoot: r.root, branch: BRANCH, runWorktree: r.runWt },
			harness: "claude-cli",
			host: HOST,
			launch: agent.run,
		});
		await expect(t.complete("review it", OPTS)).rejects.toBeInstanceOf(
			ReviewerModifiedError,
		);
		await r.cleanup();
	});

	test("a reviewer that touches the run worktree or moves the branch is caught", async () => {
		const r = await repo();
		const touchRun = new AgentReviewInference({
			subject: { projectRoot: r.root, branch: BRANCH, runWorktree: r.runWt },
			harness: "claude-cli",
			host: HOST,
			launch: fakeAgent(async () => {
				await writeFile(join(r.runWt, "new.txt"), "stray\n");
			}).run,
		});
		await expect(touchRun.complete("x", OPTS)).rejects.toThrow(
			"the run worktree changed",
		);
		await rm(join(r.runWt, "new.txt"));
		const moveBranch = new AgentReviewInference({
			subject: { projectRoot: r.root, branch: BRANCH, runWorktree: null },
			harness: "claude-cli",
			host: HOST,
			launch: fakeAgent(async () => {
				await git(["update-ref", `refs/heads/${BRANCH}`, r.base], r.root);
			}).run,
		});
		await expect(moveBranch.complete("x", OPTS)).rejects.toThrow("moved off");
		await r.cleanup();
	});
});

describe("BrainService: agent review mode", () => {
	async function env(act?: (cwd: string) => Promise<void>) {
		const r = await repo();
		const dbDir = await mkdtemp(join(tmpdir(), "mfw-agent-review-db-"));
		const handle = await openProjectDb(dbDir);
		const bus = new EventBus();
		const registry = new RunRegistry({
			handle,
			bus,
			runsDir: join(dbDir, "runs"),
		});
		const subject = await registry.create({
			kind: "task",
			taskId: "T-1",
			label: "T-1",
			model: "sonnet",
			providerId: "claude-cli",
			reasoningEffort: "medium",
			cwd: r.runWt,
			branch: BRANCH,
		});
		const agent = fakeAgent(act);
		const brain = new BrainService({
			registry,
			handle,
			bus,
			// The one-shot transport must not be used in agent mode.
			inference: {
				complete: async () => {
					throw new Error("critic transport used in agent mode");
				},
			},
			log: silentLogger(),
			model: "sonnet",
			reviewModel: "opus",
			providerId: "claude-cli",
			reasoningEffort: "medium",
			enabled: true,
			projectRoot: r.root,
			diffs: {
				collect: async () => ({
					patch: "",
					stat: " a.txt | 2 +-",
					commits: "abc work",
					files: ["a.txt"],
				}),
			},
			review: { ...DEFAULT_REVIEW_POLICY, mode: "agent" },
			agentReview: (s) =>
				new AgentReviewInference({
					subject: { projectRoot: r.root, ...s },
					harness: "claude-cli",
					host: HOST,
					launch: agent.run,
				}),
		});
		const ctx: BrainCallCtx = {
			runId: subject.id,
			taskId: "T-1",
			workspacePath: r.runWt,
			branch: BRANCH,
			baseSha: r.base,
			verify: { passed: true, crashed: false, checks: [] },
			report: null,
		};
		return {
			brain,
			ctx,
			handle,
			agent,
			cleanup: async () => {
				handle.close();
				await rm(dbDir, { recursive: true, force: true });
				await r.cleanup();
			},
		};
	}

	test("a clean agent review yields its VERDICT line, floored and recorded as mode agent", async () => {
		const e = await env();
		const res = await e.brain.critic(e.ctx);
		expect(res).toMatchObject({
			status: "ok",
			mode: "agent",
			verdict: "merge",
			reviewer: { model: "opus" },
		});
		expect(e.agent.calls[0]?.argv.join(" ")).not.toContain("VERDICT");
		expect(e.agent.calls[0]?.prompt).toContain("VERDICT: merge|fix|reject");
		const rows = await e.handle.db.select().from(reviewVerdicts);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ mode: "agent", verdict: "merge" });
		await e.cleanup();
	});

	test("an agent review that edits a file is discarded: no verdict, cause recorded", async () => {
		const e = await env(async (cwd) => {
			await writeFile(join(cwd, "a.txt"), "fixed it myself\n");
		});
		const res = await e.brain.critic(e.ctx);
		expect(res).toMatchObject({
			status: "failed",
			mode: "agent",
			cause: "reviewer_modified_checkout",
		});
		expect(res.verdict).toBeUndefined();
		expect(await e.handle.db.select().from(reviewVerdicts)).toEqual([]);
		await e.cleanup();
	});
});
