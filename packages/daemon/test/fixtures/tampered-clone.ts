import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProc } from "../../src/proc.ts";

/**
 * A clone an agent has tampered with. Every config key and hook that can run
 * a program points at a canary script that appends a line to `canaryLog`, so a
 * test proves a host operation executed nothing by checking the log is empty.
 *
 * Layout under `root`:
 *   primary/    the host-owned repo (one commit on main)
 *   secret/     another repo holding a commit the primary must never receive
 *   workspaces/ the workspace root; `clone` lives here
 *   scratch/    host-owned scratch root for throwaway bare repos
 */
export interface TamperedClone {
	root: string;
	primary: string;
	secret: string;
	secretSha: string;
	workspaceRoot: string;
	scratchRoot: string;
	clone: string;
	runId: string;
	canary: string;
	canaryLog: string;
	/** Env for a plain, unhardened git, isolated from the real user config. */
	plainEnv: Record<string, string>;
}

const IDENT = [
	"-c",
	"user.name=fixture",
	"-c",
	"user.email=fixture@example.invalid",
];

export async function plainGit(
	args: string[],
	cwd: string,
	env: Record<string, string> = {},
): Promise<string> {
	const r = await runProc(["git", ...IDENT, ...args], {
		cwd,
		env: {
			PATH: process.env.PATH ?? "",
			HOME: "/nonexistent",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_NOSYSTEM: "1",
			...env,
		},
	});
	if (r.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")}: ${r.stderr || r.stdout}`);
	}
	return r.stdout.trim();
}

async function commitFile(
	repo: string,
	name: string,
	body: string,
	msg: string,
): Promise<string> {
	await writeFile(join(repo, name), body);
	await plainGit(["add", "--", name], repo);
	await plainGit(["commit", "-q", "-m", msg], repo);
	return plainGit(["rev-parse", "HEAD"], repo);
}

export async function buildTamperedClone(
	runId = "run1",
): Promise<TamperedClone> {
	const root = await mkdtemp(join(tmpdir(), "mfw-tampered-"));
	const primary = join(root, "primary");
	const secret = join(root, "secret");
	const workspaceRoot = join(root, "workspaces");
	const scratchRoot = join(root, "scratch");
	const clone = join(workspaceRoot, runId);
	for (const d of [primary, secret, workspaceRoot, scratchRoot]) {
		await mkdir(d, { recursive: true });
	}

	await plainGit(["init", "-q", "-b", "main"], primary);
	await commitFile(primary, "README.md", "primary\n", "primary: initial");
	await plainGit(["init", "-q", "-b", "main"], secret);
	const secretSha = await commitFile(
		secret,
		"secret.txt",
		"do not exfiltrate\n",
		"secret: initial",
	);

	await plainGit(["clone", "-q", "--no-hardlinks", primary, clone], root);
	await plainGit(["checkout", "-q", "-b", `mfw/${runId}`], clone);
	await commitFile(clone, "work.txt", "agent work\n", "agent: work");
	// A WIP snapshot beside the run branch (see wipSourcePrefix).
	await plainGit(["branch", `mfw-wip/${runId}/1`], clone);
	// Foreign refs the host must never import.
	await plainGit(["branch", "foreign-branch"], clone);
	await plainGit(["tag", "foreign-tag"], clone);
	await plainGit(["update-ref", "refs/mfw/base/other", "HEAD"], clone);
	await plainGit(["update-ref", "refs/remotes/evil/main", "HEAD"], clone);

	const canaryLog = join(root, "canary.log");
	const canary = join(root, "canary.sh");
	await writeFile(canary, `#!/bin/sh\necho "$0 $*" >> ${canaryLog}\nexit 1\n`);
	await chmod(canary, 0o755);
	await writeFile(canaryLog, "");

	// Every program-running config key the design lists.
	const include = join(clone, ".git", "evil.inc");
	await writeFile(include, `[core]\n\tfsmonitor = ${canary} include\n`);
	const cfg: [string, string][] = [
		["core.fsmonitor", `${canary} fsmonitor`],
		["core.hooksPath", join(clone, ".git", "evil-hooks")],
		["uploadpack.packObjectsHook", `${canary} packObjectsHook`],
		["filter.evil.clean", `${canary} clean`],
		["filter.evil.smudge", `${canary} smudge`],
		["filter.evil.process", `${canary} process`],
		["diff.evil.textconv", `${canary} textconv`],
		["credential.helper", `!${canary} credential`],
		["core.sshCommand", `${canary} ssh`],
		["gpg.program", `${canary} gpg`],
		["core.pager", `${canary} pager`],
		["include.path", include],
	];
	for (const [k, v] of cfg) await plainGit(["config", k, v], clone);
	await mkdir(join(clone, ".git", "evil-hooks"), { recursive: true });
	for (const dir of [
		join(clone, ".git", "hooks"),
		join(clone, ".git", "evil-hooks"),
	]) {
		await mkdir(dir, { recursive: true });
		for (const hook of [
			"post-checkout",
			"pre-commit",
			"post-commit",
			"reference-transaction",
			"post-merge",
			"pre-auto-gc",
		]) {
			const p = join(dir, hook);
			await writeFile(p, `#!/bin/sh\n${canary} hook-${hook}\n`);
			await chmod(p, 0o755);
		}
	}
	await writeFile(join(clone, ".gitattributes"), "* filter=evil diff=evil\n");

	return {
		root,
		primary,
		secret,
		secretSha,
		workspaceRoot,
		scratchRoot,
		clone,
		runId,
		canary,
		canaryLog,
		plainEnv: {
			PATH: process.env.PATH ?? "",
			HOME: "/nonexistent",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_NOSYSTEM: "1",
		},
	};
}

/** Point the clone's object lookup at the secret repo, as a tampered agent would. */
export async function plantAlternates(
	t: TamperedClone,
	kind: "alternates" | "http-alternates",
): Promise<void> {
	const dir = join(t.clone, ".git", "objects", "info");
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, kind), `${join(t.secret, ".git", "objects")}\n`);
}
