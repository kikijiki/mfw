import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	InferenceClient,
	InferenceOpts,
	InferenceReply,
} from "./brain.ts";
import { claudeEnvelopeUsage } from "./brain.ts";
import { git } from "./git.ts";
import { type ProcOpts, type ProcResult, runProc } from "./proc.ts";
import {
	bwrapCore,
	cleanEnvSetenvArgs,
	maskedRuntimePaths,
	pinnedTool,
	resolveBwrapPath,
	SANDBOX_ENV_ALLOWLIST,
	SandboxUnavailableError,
} from "./sandbox.ts";

/**
 * Agent review: a reviewer agent that can read code and run commands, in its
 * own detached checkout of the run branch tip.
 *
 * It must not change the work it judges, and we never trust it to say so.
 * Before the agent starts we record the branch tip and the run worktree's
 * state; afterwards the checkout must be clean at the same commit, the branch
 * tip unmoved, and the run worktree identical. Any difference throws
 * `ReviewerModifiedError` and the verdict is discarded (the task goes to a
 * human). The agent also runs under `bwrap` (refused without it) with the project
 * root, the checkout and the run worktree bound read-only.
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
	/** Paths masked inside bwrap (the daemon's home). */
	hidePaths?: string[];
	/** "auto": always bwrap, refusing when it is missing; "off": never (tests). */
	sandbox?: "auto" | "off";
	/** Test seam: runs the reviewer process. */
	run?: AgentRunner;
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
async function worktreeState(path: string): Promise<string | null> {
	const head = await git(["rev-parse", "HEAD"], path);
	if (head.exitCode !== 0) return null;
	const status = await git(
		["status", "--porcelain=v1", "--untracked-files=all"],
		path,
	);
	return `${head.stdout.trim()}\n${status.stdout}`;
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
		const dir = await mkdtemp(
			join(this.opts.tmpRoot ?? tmpdir(), "mfw-review-"),
		);
		await gitOut(
			["worktree", "add", "--detach", "--quiet", dir, tip],
			subject.projectRoot,
		);
		try {
			const reply = await this.runAgent(prompt, opts, dir);
			const changes = await this.postCheck(tip, dir, runBefore);
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

	/** Every way the reviewer could have changed the work, as human text. */
	private async postCheck(
		tip: string,
		dir: string,
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
		if (subject.runWorktree && runBefore !== null) {
			const runAfter = await worktreeState(subject.runWorktree);
			if (runAfter !== runBefore) changes.push("the run worktree changed");
		}
		return changes;
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

	/**
	 * Fail closed: with `sandbox: "auto"` a missing bwrap is a refusal, not an
	 * unsandboxed reviewer. The reviewer gets the same clean environment and
	 * masks as a run (`sandbox.ts`), with the checkouts bound read-only.
	 */
	private async sandboxed(argv: string[], dir: string): Promise<string[]> {
		if (this.opts.sandbox === "off") return argv;
		const bwrapPath = await resolveBwrapPath();
		if (!bwrapPath) {
			throw new SandboxUnavailableError(
				"agent review requires `bwrap`, which is not on PATH",
			);
		}
		const { subject } = this.opts;
		const readOnly = [subject.projectRoot, dir, subject.runWorktree].filter(
			(p): p is string => typeof p === "string",
		);
		const env = process.env;
		const envPath = pinnedTool("env");
		if (!envPath) {
			throw new SandboxUnavailableError("env is not on a trusted PATH");
		}
		return [
			envPath,
			"-i",
			`PATH=${env.PATH ?? "/usr/bin:/bin"}`,
			...bwrapCore({
				bwrapPath,
				cwd: dir,
				runDir: dir,
				isolation: { mode: "bwrap", hidePaths: this.opts.hidePaths ?? [] },
				readOnly,
				masks: maskedRuntimePaths(env),
			}),
			...cleanEnvSetenvArgs(env, SANDBOX_ENV_ALLOWLIST),
			"--chdir",
			dir,
			"--",
			...argv,
		];
	}

	private async runAgent(
		prompt: string,
		opts: InferenceOpts,
		dir: string,
	): Promise<InferenceReply> {
		const argv = await this.sandboxed(this.argv(prompt, opts), dir);
		const run = this.opts.run ?? runProc;
		const r = await run(argv, {
			cwd: dir,
			timeoutMs: opts.timeoutMs,
			maxOutputBytes: MAX_OUTPUT_BYTES,
			...(opts.signal ? { signal: opts.signal } : {}),
		});
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
