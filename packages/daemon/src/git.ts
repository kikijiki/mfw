import { repoConfigRefusal } from "./host-git/repo-config.ts";
import { runProc } from "./proc.ts";
import { requireHostTool } from "./sandbox.ts";

/**
 * The hardened runner for host git in a repository the daemon did not create
 *. Each call refuses a
 * repository config outside the allowlist, pins the keys below, and ignores
 * `refs/replace`, so a planted replacement cannot forge what a commit contains.
 */
export const HOST_GIT_OVERRIDES: readonly string[] = [
	"-c",
	"core.hooksPath=/dev/null",
	"-c",
	"core.fsmonitor=false",
	"-c",
	"core.alternateRefsCommand=",
	"-c",
	"protocol.ext.allow=never",
];

export function hostGitEnv(
	extra?: Record<string, string>,
): Record<string, string> {
	return {
		...(process.env as Record<string, string>),
		GIT_NO_REPLACE_OBJECTS: "1",
		...extra,
	};
}

/** These read or write the config itself, or create a repository: nothing to audit. */
const UNAUDITED = new Set(["config", "init", "clone", "version"]);

function subcommand(args: readonly string[]): string | undefined {
	for (let i = 0; i < args.length; i++) {
		const a = args[i] as string;
		if (a === "-c" || a === "-C") i++;
		else if (!a.startsWith("-")) return a;
	}
	return undefined;
}

async function refusal(args: string[], cwd: string): Promise<string | null> {
	if (UNAUDITED.has(subcommand(args) ?? "")) return null;
	return (await repoConfigRefusal(cwd))?.message ?? null;
}

/** Thin git helper: run a git command in a cwd, capture stdout/exit. */
export async function git(
	args: string[],
	cwd: string,
	opts: { env?: Record<string, string> } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const refused = await refusal(args, cwd);
	if (refused) return { exitCode: 128, stdout: "", stderr: refused };
	// Git is fast and bounded; a hung invocation must not wedge a finalize
	// step, so it inherits runProc's mandatory timeout.
	const r = await runProc(
		[requireHostTool("git"), ...HOST_GIT_OVERRIDES, ...args],
		{ cwd, env: hostGitEnv(opts.env) },
	);
	return {
		exitCode: r.exitCode ?? -1,
		stdout: r.stdout.trim(),
		stderr: r.stderr.trim(),
	};
}

export async function gitOk(
	args: string[],
	cwd: string,
	opts: { env?: Record<string, string> } = {},
): Promise<string> {
	const r = await git(args, cwd, opts);
	if (r.exitCode !== 0) {
		throw new Error(
			`git ${args.join(" ")} failed (${r.exitCode}): ${r.stderr || r.stdout}`,
		);
	}
	return r.stdout;
}

/**
 * `gitOk` for an answer that backs a decision: the output is tail-kept, so a
 * listing past the cap has lost its first entries and is an error here.
 */
export async function gitComplete(
	args: string[],
	cwd: string,
	opts: { env?: Record<string, string> } = {},
): Promise<string> {
	const refused = await refusal(args, cwd);
	if (refused) throw new Error(refused);
	const r = await runProc(
		[requireHostTool("git"), ...HOST_GIT_OVERRIDES, ...args],
		{ cwd, env: hostGitEnv(opts.env) },
	);
	if (r.exitCode !== 0) {
		throw new Error(
			`git ${args[0]} failed (${r.exitCode ?? r.signalCode}): ${r.stderr.trim() || r.stdout.trim()}`,
		);
	}
	if (r.truncated) {
		throw new Error(`git ${args[0]} produced more output than the cap`);
	}
	return r.stdout.trim();
}

export interface GitRawResult {
	ok: boolean;
	exitCode: number | null;
	/** Untrimmed: porcelain and `-z` output keep their leading bytes. */
	stdout: string;
	stderr: string;
	truncated: boolean;
	timedOut: boolean;
}

/** The hardened argv and env, for a caller that must spawn git itself. Throws on a refused config. */
export async function hostGitCommand(
	args: string[],
	cwd: string,
	env?: Record<string, string>,
): Promise<{ argv: string[]; env: Record<string, string> }> {
	const refused = await refusal(args, cwd);
	if (refused) throw new Error(refused);
	return {
		argv: [requireHostTool("git"), ...HOST_GIT_OVERRIDES, ...args],
		env: hostGitEnv(env),
	};
}

/** Hardened git whose output is not trimmed. A refused config is a failed result. */
export async function gitRaw(
	args: string[],
	cwd: string,
	opts: {
		env?: Record<string, string>;
		timeoutMs?: number;
		maxOutputBytes?: number;
		input?: string;
	} = {},
): Promise<GitRawResult> {
	const refused = await refusal(args, cwd);
	if (refused) {
		return {
			ok: false,
			exitCode: 128,
			stdout: "",
			stderr: refused,
			truncated: false,
			timedOut: false,
		};
	}
	const r = await runProc(
		[requireHostTool("git"), ...HOST_GIT_OVERRIDES, ...args],
		{
			cwd,
			env: hostGitEnv(opts.env),
			...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
			...(opts.maxOutputBytes !== undefined
				? { maxOutputBytes: opts.maxOutputBytes }
				: {}),
			...(opts.input !== undefined ? { input: opts.input } : {}),
		},
	);
	return {
		ok: r.exitCode === 0 && !r.timedOut,
		exitCode: r.exitCode,
		stdout: r.stdout,
		stderr: r.stderr,
		truncated: r.truncated === true,
		timedOut: r.timedOut === true,
	};
}

export async function isGitRepo(cwd: string): Promise<boolean> {
	const r = await git(["rev-parse", "--is-inside-work-tree"], cwd);
	return r.exitCode === 0 && r.stdout === "true";
}

/** Current HEAD commit SHA. */
export async function headSha(cwd: string): Promise<string> {
	return gitOk(["rev-parse", "HEAD"], cwd);
}
