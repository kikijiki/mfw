import { runProc } from "./proc.ts";

/** Thin git helper: run a git command in a cwd, capture stdout/exit. */
export async function git(
	args: string[],
	cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	// Git is fast and bounded; a hung invocation must not wedge a finalize
	// step, so it inherits runProc's mandatory timeout.
	const r = await runProc(["git", ...args], { cwd });
	return {
		exitCode: r.exitCode ?? -1,
		stdout: r.stdout.trim(),
		stderr: r.stderr.trim(),
	};
}

export async function gitOk(args: string[], cwd: string): Promise<string> {
	const r = await git(args, cwd);
	if (r.exitCode !== 0) {
		throw new Error(
			`git ${args.join(" ")} failed (${r.exitCode}): ${r.stderr || r.stdout}`,
		);
	}
	return r.stdout;
}

export async function isGitRepo(cwd: string): Promise<boolean> {
	const r = await git(["rev-parse", "--is-inside-work-tree"], cwd);
	return r.exitCode === 0 && r.stdout === "true";
}

/** Current HEAD commit SHA. */
export async function headSha(cwd: string): Promise<string> {
	return gitOk(["rev-parse", "HEAD"], cwd);
}
