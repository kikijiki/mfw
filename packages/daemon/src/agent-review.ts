import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	InferenceClient,
	InferenceOpts,
	InferenceReply,
} from "./brain.ts";
import { claudeEnvelopeUsage } from "./brain.ts";
import { runOneShotAgent } from "./containment/oneshot-agent.ts";
import { git, gitComplete } from "./git.ts";
import { type ProcOpts, type ProcResult, runProc } from "./proc.ts";
import { createRoleClone } from "./run-workspace/role-clone.ts";
import { SandboxUnavailableError } from "./sandbox.ts";

/**
 * Agent review: a reviewer agent that can read code and run commands, in its
 * own private copy of the run branch tip.
 *
 * It must not change the work it judges, and we never trust it to say so. The
 * copy is mounted read-only in the `reviewer` role, through the same probe,
 * attestation and single-use gate as every launch (`containment/role-profiles`).
 * Before it starts we record the branch tip and the run worktree's state;
 * afterwards both must be unchanged. Any difference throws
 * `ReviewerModifiedError` and the verdict is discarded (the task goes to a
 * human).
 */

export class ReviewerModifiedError extends Error {
	constructor(readonly changes: string[]) {
		super(`the reviewer modified what it was reviewing: ${changes.join("; ")}`);
		this.name = "ReviewerModifiedError";
	}
}

export interface AgentReviewSubject {
	projectRoot: string;
	/** The run branch under review. */
	branch: string;
	/** The run's own worktree, checked for edits too; null when gone. */
	runWorktree: string | null;
}

export type AgentRunner = (
	argv: string[],
	opts: ProcOpts & { cwd: string },
) => Promise<ProcResult>;

export interface AgentReviewOpts {
	subject: AgentReviewSubject;
	harness: "claude-cli" | "codex-cli";
	bin?: string;
	/** What the reviewer role needs from the host. Required unless `sandbox` is "off". */
	host?: { mfwHome: string; stateDir: string };
	/** "auto": always the reviewer role, refusing without it; "off": never (tests). */
	sandbox?: "auto" | "off";
	/** Test seam: runs the reviewer process when `sandbox` is "off". */
	run?: AgentRunner;
	/** Test seam: the sandboxed launch. */
	launch?: typeof runOneShotAgent;
	tmpRoot?: string;
}

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

async function gitOut(args: string[], cwd: string): Promise<string> {
	const r = await git(args, cwd);
	if (r.exitCode !== 0)
		throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
	return r.stdout.trim();
}

/** HEAD plus every tracked and untracked change, as one comparable string. */
export async function worktreeState(path: string): Promise<string | null> {
	const head = await git(["rev-parse", "HEAD"], path);
	if (head.exitCode !== 0) return null;
	// The tamper check compares two of these. A status that cannot be read in
	// full is unique, so it reads as a change rather than as "nothing moved".
	const status = await gitComplete(
		["status", "--porcelain=v1", "--untracked-files=all"],
		path,
	).catch(() => `unverifiable:${randomUUID()}`);
	return `${head.stdout.trim()}\n${status}`;
}

export class AgentReviewInference implements InferenceClient {
	constructor(private readonly opts: AgentReviewOpts) {}

	async complete(prompt: string, opts: InferenceOpts): Promise<InferenceReply> {
		const { subject } = this.opts;
		const tip = await gitOut(
			["rev-parse", "--verify", `${subject.branch}^{commit}`],
			subject.projectRoot,
		);
		const runBefore = subject.runWorktree
			? await worktreeState(subject.runWorktree)
			: null;
		if (this.opts.sandbox !== "off") {
			return this.completeSandboxed(prompt, opts, tip, runBefore);
		}
		const dir = await mkdtemp(
			join(this.opts.tmpRoot ?? tmpdir(), "mfw-review-"),
		);
		await gitOut(
			["worktree", "add", "--detach", "--quiet", dir, tip],
			subject.projectRoot,
		);
		try {
			const run = this.opts.run ?? runProc;
			const result = await run(this.argv(prompt, opts), {
				cwd: dir,
				timeoutMs: opts.timeoutMs,
				maxOutputBytes: MAX_OUTPUT_BYTES,
				...(opts.signal ? { signal: opts.signal } : {}),
			});
			const reply = this.reply(result, opts);
			const changes = [
				...(await this.checkoutChanges(tip, dir)),
				...(await this.subjectChanges(tip, runBefore)),
			];
			if (changes.length > 0) throw new ReviewerModifiedError(changes);
			return reply;
		} finally {
			await git(
				["worktree", "remove", "--force", dir],
				subject.projectRoot,
			).catch(() => undefined);
			await rm(dir, { recursive: true, force: true }).catch(() => undefined);
			await git(["worktree", "prune"], subject.projectRoot).catch(
				() => undefined,
			);
		}
	}

	/** The real path: a private clone, read-only, in the attested reviewer role. */
	private async completeSandboxed(
		prompt: string,
		opts: InferenceOpts,
		tip: string,
		runBefore: string | null,
	): Promise<InferenceReply> {
		const { subject, host } = this.opts;
		if (!host) {
			throw new SandboxUnavailableError(
				"agent review has no sandbox host settings",
			);
		}
		const id = `review-${randomUUID()}`;
		const clone = await createRoleClone(subject.projectRoot, id, tip);
		try {
			const result = await (this.opts.launch ?? runOneShotAgent)({
				role: "reviewer",
				cli: this.opts.harness === "codex-cli" ? "codex" : "claude",
				tree: clone.tree,
				projectRoot: subject.projectRoot,
				stateDir: host.stateDir,
				mfwHome: host.mfwHome,
				argv: this.stdinArgv(opts),
				prompt,
				timeoutMs: opts.timeoutMs,
				maxOutputBytes: MAX_OUTPUT_BYTES,
				...(opts.signal ? { signal: opts.signal } : {}),
			});
			const reply = this.reply(result, opts);
			const changes = await this.subjectChanges(tip, runBefore);
			if (changes.length > 0) throw new ReviewerModifiedError(changes);
			return reply;
		} finally {
			await rm(clone.root, { recursive: true, force: true }).catch(
				() => undefined,
			);
		}
	}

	/** The test seam's writable checkout; the real one is mounted read-only. */
	private async checkoutChanges(tip: string, dir: string): Promise<string[]> {
		const changes: string[] = [];
		const head = await git(["rev-parse", "HEAD"], dir);
		if (head.stdout.trim() !== tip)
			changes.push("the review checkout's HEAD moved");
		const status = await git(
			["status", "--porcelain=v1", "--untracked-files=all"],
			dir,
		);
		if (status.exitCode !== 0 || status.stdout.trim() !== "")
			changes.push(
				`files changed in the review checkout: ${status.stdout
					.trim()
					.split("\n")
					.slice(0, 5)
					.join(", ")}`,
			);
		return changes;
	}

	/** What a reviewer must never move: the branch and the run's own worktree. */
	private async subjectChanges(
		tip: string,
		runBefore: string | null,
	): Promise<string[]> {
		const { subject } = this.opts;
		const changes: string[] = [];
		const branchNow = await git(
			["rev-parse", "--verify", `${subject.branch}^{commit}`],
			subject.projectRoot,
		);
		if (branchNow.stdout.trim() !== tip)
			changes.push(`branch ${subject.branch} moved off ${tip.slice(0, 12)}`);
		if (subject.runWorktree && runBefore !== null) {
			const runAfter = await worktreeState(subject.runWorktree);
			if (runAfter !== runBefore) changes.push("the run worktree changed");
		}
		return changes;
	}

	/** The same command with the prompt on stdin, as the sandboxed launch sends it. */
	private stdinArgv(opts: InferenceOpts): string[] {
		const marker = "\0prompt";
		const argv = this.argv(marker, opts);
		const at = argv.indexOf(marker);
		if (this.opts.harness === "codex-cli") argv[at] = "-";
		else argv.splice(at, 1);
		return argv;
	}

	private argv(prompt: string, opts: InferenceOpts): string[] {
		if (this.opts.harness === "codex-cli") {
			return [
				this.opts.bin ?? "codex",
				"exec",
				"--ephemeral",
				"--sandbox",
				"read-only",
				"--color",
				"never",
				"-m",
				opts.model,
				prompt,
			];
		}
		// No permission bypass: tools outside this list are denied in -p mode.
		return [
			this.opts.bin ?? "claude",
			"-p",
			prompt,
			"--model",
			opts.model,
			"--output-format",
			"json",
			"--allowedTools",
			"Read,Grep,Glob,Bash",
			"--strict-mcp-config",
			"--no-session-persistence",
		];
	}

	private reply(r: ProcResult, opts: InferenceOpts): InferenceReply {
		if (r.timedOut) throw new Error("agent reviewer timed out");
		if (opts.signal?.aborted) throw new Error("agent reviewer aborted");
		if (r.exitCode !== 0)
			throw new Error(
				`agent reviewer failed (${r.exitCode ?? "signal"}): ${
					r.stderr.trim().slice(-400) ||
					r.stdout.trim().slice(-400) ||
					"no output"
				}`,
			);
		if (this.opts.harness === "claude-cli") {
			try {
				const o = JSON.parse(r.stdout) as Record<string, unknown>;
				if (typeof o.result === "string") {
					const usage = claudeEnvelopeUsage(o);
					return Object.keys(usage).length > 0
						? { text: o.result, usage }
						: { text: o.result };
				}
			} catch {
				// best-effort: a non-JSON envelope is still usable raw text
			}
		}
		return { text: r.stdout };
	}
}
