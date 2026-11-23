import { randomUUID } from "node:crypto";
import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
	InferenceClient,
	InferenceOpts,
	InferenceReply,
} from "./brain.ts";
import { claudeEnvelopeUsage } from "./brain.ts";
import { runOneShotAgent } from "./containment/oneshot-agent.ts";
import { git, gitComplete } from "./git.ts";
import type { ProcResult } from "./proc.ts";
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

export interface AgentReviewOpts {
	subject: AgentReviewSubject;
	harness: "claude-cli" | "codex-cli";
	bin?: string;
	/** What the reviewer role needs from the host. */
	host?: { mfwHome: string; stateDir: string };
	/** Test seam: the sandboxed launch. There is no unsandboxed path. */
	launch?: typeof runOneShotAgent;
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

/** Every entry under `dir`, without following links, as one comparable string. */
async function treeState(dir: string): Promise<string> {
	const lines: string[] = [];
	const walk = async (at: string): Promise<void> => {
		const entries = await readdir(at, { withFileTypes: true });
		for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
			const path = join(at, e.name);
			const st = await lstat(path);
			lines.push(`${path}\0${st.mode}\0${st.size}\0${st.mtimeMs}`);
			if (e.isDirectory()) await walk(path);
		}
	};
	await walk(dir);
	return lines.join("\n");
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
		return this.completeSandboxed(prompt, opts, tip, runBefore);
	}

	/** A private clone, read-only, in the attested reviewer role. */
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
			const treeBefore = await treeState(clone.tree);
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
			// The mount is read-only; this catches a sandbox that failed to make it so.
			const changes = await this.subjectChanges(tip, runBefore);
			if ((await treeState(clone.tree)) !== treeBefore) {
				changes.push("files changed in the review checkout");
			}
			if (changes.length > 0) throw new ReviewerModifiedError(changes);
			return reply;
		} finally {
			await rm(clone.root, { recursive: true, force: true }).catch(
				() => undefined,
			);
		}
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
