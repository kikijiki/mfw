import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxBundleArgv } from "../../src/host-git/fetch.ts";
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
	/** The bundle the sandbox helper wrote to the outbox, made before the clone was tampered with. */
	bundle: string;
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
	// The victim's own run branch (same name the host fetches) and packed objects,
	// so the pack and ref tampers below have something to point at.
	await plainGit(["branch", `mfw/${runId}`], secret);
	await plainGit(["gc", "-q"], secret);
	// gc packs refs; keep the victim's run ref loose so a symlink to it resolves.
	await mkdir(join(secret, ".git", "refs", "heads", "mfw"), {
		recursive: true,
	});
	await writeFile(
		join(secret, ".git", "refs", "heads", "mfw", runId),
		`${secretSha}\n`,
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

	// The in-sandbox helper's output, written while the clone is still honest.
	const outbox = join(workspaceRoot, "outbox");
	await mkdir(outbox, { recursive: true });
	const bundle = join(outbox, `${runId}.bundle`);
	await plainGit(sandboxBundleArgv(runId, bundle).slice(1), clone);

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
		bundle,
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

export type GitdirBypass =
	| "commondir"
	| "pack-symlink"
	| "pack-and-ref-symlink"
	| "decoy-dotgit";

/**
 * The four ways a tampered clone redirects which repo the host reads, each of
 * which got another repo's secret into the primary through a path fetch (the
 * security review, H1). `secretSha` ends up reachable from the run branch.
 */
export async function plantGitdirBypass(
	t: TamperedClone,
	kind: GitdirBypass,
): Promise<void> {
	const { rm, rename, symlink, readdir } = await import("node:fs/promises");
	const gitDir = join(t.clone, ".git");
	const secretGit = join(t.secret, ".git");
	const ref = join(gitDir, "refs", "heads", "mfw", t.runId);
	if (kind === "commondir") {
		await writeFile(join(gitDir, "commondir"), `${secretGit}\n`);
	} else if (kind === "pack-symlink" || kind === "pack-and-ref-symlink") {
		await rm(join(gitDir, "objects", "pack"), { recursive: true, force: true });
		await symlink(
			join(secretGit, "objects", "pack"),
			join(gitDir, "objects", "pack"),
		);
		await rm(ref, { force: true });
		if (kind === "pack-symlink") {
			await writeFile(ref, `${t.secretSha}\n`);
		} else {
			await symlink(join(secretGit, "refs", "heads", "mfw", t.runId), ref);
		}
	} else {
		// Real gitdir at the clone root (with alternates), an empty decoy .git.
		for (const name of await readdir(gitDir)) {
			await rename(join(gitDir, name), join(t.clone, name));
		}
		await plantRootAlternates(t);
		await writeFile(
			join(t.clone, "refs", "heads", "mfw", t.runId),
			`${t.secretSha}\n`,
		);
	}
}

async function plantRootAlternates(t: TamperedClone): Promise<void> {
	const dir = join(t.clone, "objects", "info");
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, "alternates"),
		`${join(t.secret, ".git", "objects")}\n`,
	);
}

/**
 * An untampered repo with the run branch, a WIP snapshot and foreign refs, for
 * building the hostile or odd bundles an agent could write to its outbox
 * without arming the canary.
 */
export async function buildHonestRepo(t: TamperedClone): Promise<string> {
	const honest = join(t.root, "honest");
	await plainGit(["clone", "-q", "--no-hardlinks", t.primary, honest], t.root);
	await plainGit(["checkout", "-q", "-b", `mfw/${t.runId}`], honest);
	await commitFile(honest, "work.txt", "honest work\n", "honest: work");
	await plainGit(["branch", `mfw-wip/${t.runId}/1`], honest);
	await plainGit(["branch", "foreign-branch"], honest);
	await plainGit(["tag", "foreign-tag"], honest);
	return honest;
}

export async function makeBundle(
	repo: string,
	out: string,
	args: string[],
): Promise<string> {
	await plainGit(["bundle", "create", out, ...args], repo);
	return out;
}
