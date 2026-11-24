/**
 * Rebasing a clone run onto the moved target, in a host-owned scratch clone
 *.
 *
 * A clone run's branch is agent-writable, so the host never rebases inside the
 * run's own workspace. The merge queue instead fetches the run's quarantine
 * ref (already host-imported and verified) and the target tip into a fresh
 * clone under the scratch root, rebases there, and on success moves the
 * quarantine ref to the rebased tip. Nothing of the run's workspace is read.
 *
 * The scratch clone holds only objects that came out of the trusted primary,
 * so its repository is host-owned. Its git still runs under the HostGit
 * environment and `-c` prelude (no global config, no hooks, no fsmonitor, no
 * transport but `file`), and its config is the clone's own: no filter, merge
 * driver or textconv is defined, so `.gitattributes` in the tree cannot make a
 * rebase run a program.
 *
 * A conflict leaves everything as it was: the quarantine ref is not moved, the
 * scratch clone is deleted, and the conflicting paths are reported.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { assertRunId, quarantineRef } from "../host-git/fetch.ts";
import { HostGit } from "../host-git/runner.ts";
import { runProc } from "../proc.ts";

const GIT_TIMEOUT_MS = 120_000;

/** Where each rebase keeps the quarantine tip it replaced: `<prefix><n>`, n from 1. */
export function preRebasePrefix(runId: string): string {
	assertRunId(runId);
	return `refs/mfw/pre-rebase/${runId}/`;
}

export interface RebaseCloneOptions {
	/** `$MFW_HOME/workspaces`; the scratch clone is never under it. */
	workspaceRoot: string;
	/** The trusted primary checkout. */
	primaryRoot: string;
	/** Host-owned dir for scratch clones. Default: a sibling of `workspaceRoot`. */
	scratchRoot?: string;
	gitBin?: string;
	host?: HostGit;
}

export type RebaseCloneResult =
	| { ok: true; tip: string }
	| { ok: false; kind: "conflict"; paths: string[]; detail: string }
	| { ok: false; kind: "error"; detail: string };

/** A run with more conflicting commits than this goes to the conflict path. */
const MAX_FIREWALLED_ROUNDS = 50;

const tail = (s: string): string => s.trim().split("\n").slice(-3).join(" ");

/**
 * Rebase the run's quarantine ref onto `onto` (a commit of `targetBranch` in
 * the primary) and, on success, move the quarantine ref to the result.
 */
export async function rebaseQuarantineInScratch(
	opts: RebaseCloneOptions,
	args: {
		runId: string;
		targetBranch: string;
		onto: string;
		/**
		 * Paths the merge firewall restores from the target whatever the run did
		 * (the board, mfw's own state). A conflict only there takes the target's
		 * side, which is what the firewall would land; any other conflict stops.
		 */
		isFirewalled?: (path: string) => boolean;
	},
): Promise<RebaseCloneResult> {
	assertRunId(args.runId);
	const workspaceRoot = resolve(opts.workspaceRoot);
	const scratchRoot = resolve(
		opts.scratchRoot ?? join(dirname(workspaceRoot), "workspace-scratch"),
	);
	const host =
		opts.host ??
		new HostGit({
			workspaceRoot,
			ownedRoots: [scratchRoot, resolve(opts.primaryRoot)],
			...(opts.gitBin ? { gitBin: opts.gitBin } : {}),
		});
	const gitBin = opts.gitBin ?? Bun.which("git");
	if (!gitBin || !isAbsolute(gitBin)) {
		return { ok: false, kind: "error", detail: "cannot resolve git" };
	}
	const primary = resolve(opts.primaryRoot);
	if (host.isWorkspacePath(primary) || host.isWorkspacePath(scratchRoot)) {
		return {
			ok: false,
			kind: "error",
			detail: "scratch clone would be under the workspace root",
		};
	}
	const quarantine = quarantineRef(args.runId);

	const run = (a: string[], cwd: string) =>
		runProc(
			[
				gitBin,
				...host.configArgs({ allowFile: true }),
				"-c",
				"user.name=mfw",
				"-c",
				"user.email=mfw@localhost",
				"-c",
				"commit.gpgsign=false",
				...a,
			],
			{ cwd, env: host.env(), timeoutMs: GIT_TIMEOUT_MS, hostGitChecked: true },
		);

	await mkdir(scratchRoot, { recursive: true, mode: 0o700 });
	const dir = await mkdtemp(join(scratchRoot, `rebase-${args.runId}-`));
	try {
		const work = join(dir, "work");
		const steps: string[][] = [
			["init", "-q", "work"],
			[
				"fetch",
				"-q",
				"--no-tags",
				"--",
				primary,
				`+${quarantine}:refs/heads/mfw-rebase`,
				`+refs/heads/${args.targetBranch}:refs/heads/mfw-target`,
			],
		];
		for (const [i, step] of steps.entries()) {
			const r = await run(step, i === 0 ? dir : work);
			if (r.exitCode !== 0) {
				return {
					ok: false,
					kind: "error",
					detail: `git ${step[0]} failed: ${tail(r.stderr || r.stdout)}`,
				};
			}
		}
		const target = await run(["rev-parse", "refs/heads/mfw-target"], work);
		if (target.exitCode !== 0 || target.stdout.trim() !== args.onto) {
			return {
				ok: false,
				kind: "error",
				detail: `target ${args.targetBranch} is no longer ${args.onto}`,
			};
		}
		const co = await run(["checkout", "-q", "mfw-rebase"], work);
		if (co.exitCode !== 0) {
			return {
				ok: false,
				kind: "error",
				detail: `checkout failed: ${tail(co.stderr)}`,
			};
		}
		let rebase = await run(["rebase", args.onto], work);
		for (let round = 0; rebase.exitCode !== 0; round++) {
			const unmerged = await run(
				["diff", "--name-only", "--diff-filter=U"],
				work,
			);
			const paths =
				unmerged.exitCode === 0
					? unmerged.stdout.split("\n").filter(Boolean)
					: [];
			const firewalled = args.isFirewalled;
			if (
				!firewalled ||
				paths.length === 0 ||
				round >= MAX_FIREWALLED_ROUNDS ||
				!paths.every(firewalled)
			) {
				return {
					ok: false,
					kind: "conflict",
					paths,
					detail: tail(rebase.stderr || rebase.stdout),
				};
			}
			// "ours" is the target during a rebase: keep it, or its deletion.
			for (const path of paths) {
				const kept = await run(["cat-file", "-e", `:2:${path}`], work);
				const step =
					kept.exitCode === 0
						? ["checkout", "--ours", "--", path]
						: ["rm", "-q", "--cached", "--", path];
				const r = await run(step, work);
				if (r.exitCode === 0 && kept.exitCode === 0) {
					await run(["add", "--", path], work);
				}
			}
			rebase = await run(
				["-c", "core.editor=true", "rebase", "--continue"],
				work,
			);
		}
		const head = await run(["rev-parse", "HEAD"], work);
		const tip = head.stdout.trim();
		if (head.exitCode !== 0 || !/^[0-9a-f]{40,64}$/.test(tip)) {
			return { ok: false, kind: "error", detail: "no rebased tip" };
		}
		// Keep the tip this rebase replaces, so the run's original work survives.
		const old = await run(
			["rev-parse", "--verify", "-q", `${quarantine}^{commit}`],
			primary,
		);
		if (old.exitCode === 0) {
			const kept = await run(
				["for-each-ref", "--format=%(refname)", preRebasePrefix(args.runId)],
				primary,
			);
			const n =
				Math.max(
					0,
					...kept.stdout
						.split("\n")
						.map((r) => Number(r.slice(preRebasePrefix(args.runId).length)))
						.filter(Number.isInteger),
				) + 1;
			const saved = await run(
				["update-ref", `${preRebasePrefix(args.runId)}${n}`, old.stdout.trim()],
				primary,
			);
			if (saved.exitCode !== 0) {
				return {
					ok: false,
					kind: "error",
					detail: `could not keep the pre-rebase tip: ${tail(saved.stderr)}`,
				};
			}
		}
		// Back into the primary's quarantine namespace, fscked, from a host-owned repo.
		const back = await run(
			[
				"fetch",
				"-q",
				"--no-tags",
				"--",
				work,
				`+refs/heads/mfw-rebase:${quarantine}`,
			],
			primary,
		);
		if (back.exitCode !== 0) {
			return {
				ok: false,
				kind: "error",
				detail: `could not publish the rebased tip: ${tail(back.stderr || back.stdout)}`,
			};
		}
		return { ok: true, tip };
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}
