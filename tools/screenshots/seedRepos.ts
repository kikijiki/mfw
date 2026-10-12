/**
 * Builds the dummy git repositories: base history, then the work each seeded
 * run left behind (merged runs land on `main` with a merge commit, review and
 * live runs keep their branch, live runs keep a worktree with edits in it).
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseAgo, type SeedProject, type SeedRun } from "./plan.ts";
import { REPOS } from "./repos.ts";

export interface GitResult {
	code: number;
	out: string;
	err: string;
}

export async function git(
	args: string[],
	cwd: string,
	env: Record<string, string> = {},
): Promise<GitResult> {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: "0" },
	});
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, out: out.trim(), err: err.trim() };
}

async function gitOk(
	args: string[],
	cwd: string,
	env: Record<string, string> = {},
): Promise<string> {
	const r = await git(args, cwd, env);
	if (r.code !== 0)
		throw new Error(`git ${args.join(" ")} (in ${cwd}) failed: ${r.err}`);
	return r.out;
}

function splitAuthor(author: string): { name: string; email: string } {
	const m = /^(.*) <(.*)>$/.exec(author);
	return { name: m?.[1] ?? author, email: m?.[2] ?? "dev@example.com" };
}

function dateEnv(ms: number, author: string): Record<string, string> {
	const iso = new Date(ms).toISOString();
	const a = splitAuthor(author);
	return {
		GIT_AUTHOR_DATE: iso,
		GIT_COMMITTER_DATE: iso,
		GIT_AUTHOR_NAME: a.name,
		GIT_AUTHOR_EMAIL: a.email,
		GIT_COMMITTER_NAME: a.name,
		GIT_COMMITTER_EMAIL: a.email,
	};
}

async function writeFiles(
	root: string,
	files: Record<string, string | null>,
): Promise<void> {
	for (const [path, content] of Object.entries(files)) {
		const full = join(root, path);
		if (content === null) {
			await Bun.$`rm -f ${full}`.quiet();
			continue;
		}
		await mkdir(dirname(full), { recursive: true });
		await writeFile(full, content);
	}
}

async function commitAll(
	cwd: string,
	message: string,
	at: number,
	author: string,
): Promise<string> {
	await gitOk(["add", "-A"], cwd);
	await gitOk(
		["commit", "-q", "--allow-empty", "-m", message],
		cwd,
		dateEnv(at, author),
	);
	return gitOk(["rev-parse", "HEAD"], cwd);
}

/** What a run left in git. */
export interface RunGit {
	branch: string;
	baseSha: string;
	headSha: string | null;
	mergeSha: string | null;
	worktree: string | null;
	/** Epoch ms of the branch commit and the merge. */
	committedAt: number | null;
	mergedAt: number | null;
}

export interface BuiltRepo {
	root: string;
	/** Where the board lives (the repository root unless `separateBoard`). */
	boardRoot: string;
	runs: Map<string, RunGit>;
}

const RUN_AUTHOR = "mfw agent <agent@mfw.invalid>";

/**
 * Create `<reposDir>/<name>` with its base history and every run's branch.
 * `ids` maps run alias to its ULID (the branch is `mfw/<id>`).
 */
export async function buildRepo(opts: {
	project: SeedProject;
	reposDir: string;
	seedNow: number;
	runIds: Map<string, string>;
	taskTitles: Map<string, string>;
}): Promise<BuiltRepo> {
	const { project, reposDir, seedNow } = opts;
	const root = join(reposDir, project.name);
	await mkdir(root, { recursive: true });
	await gitOk(["init", "-q", "-b", "main"], root);
	await gitOk(["config", "user.name", "Mara Lindqvist"], root);
	await gitOk(["config", "user.email", "mara@example.com"], root);
	await gitOk(["config", "commit.gpgsign", "false"], root);

	const base = REPOS[project.repo];
	if (!base) throw new Error(`no repository generator '${project.repo}'`);
	for (const c of base) {
		await writeFiles(root, c.files);
		await commitAll(
			root,
			c.message,
			seedNow - parseAgo(c.ago) * 60_000,
			c.author,
		);
	}

	const runs = new Map<string, RunGit>();
	// Chronological: a later run branches from a main that already has the earlier merges.
	const withChange = project.runs
		.filter((r) => r.change || r.end === "live")
		.sort((a, b) => parseAgo(b.start) - parseAgo(a.start));
	for (const run of withChange) {
		const id = opts.runIds.get(run.alias) as string;
		runs.set(
			run.alias,
			await buildRun(root, run, id, seedNow, opts.taskTitles),
		);
	}

	const boardRoot = project.separateBoard
		? join(reposDir, `${project.name}-board`)
		: root;
	return { root, boardRoot, runs };
}

async function buildRun(
	root: string,
	run: SeedRun,
	id: string,
	seedNow: number,
	taskTitles: Map<string, string>,
): Promise<RunGit> {
	const branch = `mfw/${id}`;
	const startMs = seedNow - parseAgo(run.start) * 60_000;
	const endMs = startMs + run.minutes * 60_000;
	const baseSha = await gitOk(["rev-parse", "main"], root);
	const worktree = join(root, "worktrees", id);
	await mkdir(join(root, "worktrees"), { recursive: true });
	await gitOk(["worktree", "add", "-q", "-b", branch, worktree, baseSha], root);

	let headSha: string | null = null;
	let committedAt: number | null = null;
	if (run.change) {
		await writeFiles(worktree, run.change.files);
		committedAt = Math.min(endMs - 60_000, seedNow - 60_000);
		headSha = await commitAll(
			worktree,
			run.change.message,
			committedAt,
			RUN_AUTHOR,
		);
	}

	if (run.end === "merged") {
		const mergedAt = endMs + 90_000;
		const title = taskTitles.get(run.task) ?? run.task;
		await gitOk(
			["merge", "--no-ff", "-q", branch, "-m", `Merge ${branch}: ${title}`],
			root,
			dateEnv(mergedAt, "mfw <mfw@mfw.invalid>"),
		);
		const mergeSha = await gitOk(["rev-parse", "HEAD"], root);
		await gitOk(["worktree", "remove", "--force", worktree], root);
		await gitOk(["branch", "-q", "-d", branch], root);
		return {
			branch,
			baseSha,
			headSha,
			mergeSha,
			worktree: null,
			committedAt,
			mergedAt,
		};
	}

	if (run.end === "live") {
		// Work in progress: an uncommitted edit, as a live agent leaves it.
		const marker = join(worktree, "src", `wip-${run.alias}.ts`);
		await mkdir(dirname(marker), { recursive: true });
		await writeFile(marker, "// work in progress\nexport const todo = true;\n");
		return {
			branch,
			baseSha,
			headSha,
			mergeSha: null,
			worktree,
			committedAt,
			mergedAt: null,
		};
	}

	// Review and failed runs keep a branch for the diff; the checkout is not needed.
	await gitOk(["worktree", "remove", "--force", worktree], root);
	return {
		branch,
		baseSha,
		headSha,
		mergeSha: null,
		worktree: null,
		committedAt,
		mergedAt: null,
	};
}
