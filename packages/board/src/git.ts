import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/** A failed git invocation; `stderr` is git's own message, verbatim. */
export class GitError extends Error {
	constructor(
		readonly args: readonly string[],
		readonly stderr: string,
		readonly code: number | string | undefined,
	) {
		super(`git ${args.join(" ")} failed: ${stderr || `exit ${code}`}`);
		this.name = "GitError";
	}
}

/** git's message when another process holds `.git/index.lock` (or any ref lock). */
const LOCK_HELD_RE = /\.lock'?: File exists|Unable to create '[^']*\.lock'/;
const LOCK_RETRIES = 6;

/**
 * Run `git <args>` in `cwd`; returns trimmed stdout, throws `GitError`. A held
 * `.lock` file (another git process, an editor integration) is transient, so
 * those failures are retried with a short backoff before giving up.
 */
export async function git(args: string[], cwd: string): Promise<string> {
	for (let attempt = 0; ; attempt++) {
		try {
			const { stdout } = await execFileP("git", args, {
				cwd,
				encoding: "utf8",
				env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
			});
			return stdout.trim();
		} catch (e) {
			const err = e as { stderr?: string; code?: number | string };
			const stderr = (err.stderr ?? "").trim();
			if (attempt < LOCK_RETRIES && LOCK_HELD_RE.test(stderr)) {
				await new Promise((r) => setTimeout(r, 100 * 2 ** attempt));
				continue;
			}
			throw new GitError(args, stderr, err.code);
		}
	}
}

/** Whether `dir` is inside a git work tree (false also when git is missing). */
export async function isInsideWorkTree(dir: string): Promise<boolean> {
	try {
		return (await git(["rev-parse", "--is-inside-work-tree"], dir)) === "true";
	} catch {
		return false;
	}
}

/** `<prefix>: <id>: <text or verb, first 60 chars>` (whitespace collapsed). */
export function commitMessage(
	prefix: string,
	id: string,
	verb: string,
	text?: string,
): string {
	const summary = (text ?? verb).replace(/\s+/g, " ").trim().slice(0, 60);
	return `${prefix}: ${id}: ${summary}`;
}

/**
 * Commit ONLY `file` (pathspec-limited, so other staged or unstaged changes in
 * the same checkout stay out), with `cwd` = the file's directory.
 */
export async function commitFile(
	file: string,
	message: string,
	cwd: string,
): Promise<void> {
	await git(["add", "--", file], cwd);
	await git(["commit", "-m", message, "--", file], cwd);
}

export async function push(cwd: string): Promise<void> {
	await git(["push"], cwd);
}
