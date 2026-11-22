/**
 * fetchRunResult: bring a finished run's branch out of its (agent-writable)
 * clone and into the primary repo's quarantine namespace, without ever running
 * git inside the clone or checking anything out.
 *
 * Order (the sandbox design, "Host git is fetch-only"):
 *  1. the injected "processes dead, cgroup gone" precondition;
 *  2. refuse a clone with `objects/info/alternates` or `http-alternates`
 *     (the alternates exfiltration the clone experiments found), run
 *     immediately before the fetch so a live agent cannot swap the file
 *     between check and fetch;
 *  3. fetch the strict refspecs into a fresh throwaway bare repo;
 *  4. the validation hook (HostGit validation fills it);
 *  5. fetch from the bare repo into the primary's quarantine refs.
 *
 * Every git call goes through `HostGit`, so the clone is only ever a fetch
 * source, never a cwd, gitdir or work tree.
 */
import { lstatSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { assertLocalSource, type HostGit, HostGitError } from "./runner.ts";

export interface FetchValidationContext {
	/** The throwaway bare repo holding the fetched, still-untrusted objects. */
	bareRepo: string;
	runId: string;
	/** Ref names inside the bare repo. */
	headRef: string;
	wipRefs: string[];
	host: HostGit;
}

export interface FetchRunResultOpts {
	host: HostGit;
	/** The host-owned repo that receives the quarantine refs. */
	primaryRepo: string;
	/** The run's clone (work tree dir or bare gitdir). Only ever a fetch source. */
	clonePath: string;
	runId: string;
	/** Host-owned dir under which the throwaway repo is made. */
	scratchRoot: string;
	/** Throws or rejects unless every run process is dead and its cgroup gone. */
	assertProcessesDead: () => void | Promise<void>;
	/** Runs on the bare repo before anything reaches the primary. Throw to reject. */
	validate?: (ctx: FetchValidationContext) => void | Promise<void>;
	/**
	 * Source ref prefix for WIP snapshots, `<prefix><n>`. A branch
	 * `mfw/<runId>` and a `mfw/<runId>/wip/<n>` branch cannot coexist (git
	 * ref directory/file conflict), so the default lives beside, not under, it.
	 */
	wipSourcePrefix?: string;
}

export interface FetchRunResultOk {
	quarantineRef: string;
	tip: string;
	wipRefs: { ref: string; sha: string }[];
}

const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const BARE_HEAD = "refs/mfw/run/head";
const BARE_WIP = "refs/mfw/run/wip/";

export function quarantineRef(runId: string): string {
	assertRunId(runId);
	return `refs/mfw/quarantine/${runId}`;
}

export function quarantineWipPrefix(runId: string): string {
	assertRunId(runId);
	return `refs/mfw/quarantine-wip/${runId}/`;
}

export function assertRunId(runId: string): void {
	if (!RUN_ID_RE.test(runId)) {
		throw new HostGitError(
			"bad_run_id",
			`run id must match ${RUN_ID_RE}: ${JSON.stringify(runId)}`,
		);
	}
}

/** The gitdir of a clone path, or throws when the layout is not a plain clone. */
function cloneGitDir(clonePath: string): string {
	const dotgit = join(clonePath, ".git");
	let st: ReturnType<typeof lstatSync> | undefined;
	try {
		st = lstatSync(dotgit);
	} catch {
		// no .git: a bare gitdir, checked below
	}
	if (st) {
		if (!st.isDirectory()) {
			throw new HostGitError(
				"alternates",
				`refusing a clone whose .git is not a plain directory: ${dotgit}`,
			);
		}
		return dotgit;
	}
	return clonePath;
}

/**
 * Refuse a clone that can redirect object reads: an alternates file of either
 * kind, or a symlinked objects directory. A tampered alternates made a host
 * fetch pull a secret commit from another repo into the primary.
 */
export function assertNoAlternates(clonePath: string): void {
	const gitDir = cloneGitDir(clonePath);
	for (const rel of ["objects", join("objects", "info")]) {
		let st: ReturnType<typeof lstatSync> | undefined;
		try {
			st = lstatSync(join(gitDir, rel));
		} catch {
			continue;
		}
		if (!st.isDirectory()) {
			throw new HostGitError(
				"alternates",
				`refusing a clone with a non-directory ${rel}`,
			);
		}
	}
	for (const name of ["alternates", "http-alternates"]) {
		const p = join(gitDir, "objects", "info", name);
		let present = true;
		try {
			lstatSync(p);
		} catch {
			present = false;
		}
		if (present) {
			throw new HostGitError(
				"alternates",
				`refusing a clone with objects/info/${name}`,
			);
		}
	}
}

export async function fetchRunResult(
	o: FetchRunResultOpts,
): Promise<FetchRunResultOk> {
	const { host, runId } = o;
	// Everything data-built is validated before git runs.
	assertRunId(runId);
	assertLocalSource(o.clonePath);
	assertLocalSource(o.primaryRepo);
	if (host.isWorkspacePath(o.primaryRepo)) {
		throw new HostGitError(
			"path_under_workspace",
			`refusing a primary repo under the workspace root: ${o.primaryRepo}`,
		);
	}
	if (host.isWorkspacePath(o.scratchRoot)) {
		throw new HostGitError(
			"path_under_workspace",
			`refusing a scratch root under the workspace root: ${o.scratchRoot}`,
		);
	}
	// The `file` transport is enabled for this fetch, so both ends must be ours.
	for (const [label, p] of [
		["clone", o.clonePath],
		["scratch root", o.scratchRoot],
	] as const) {
		if (!host.isOwnedPath(p)) {
			throw new HostGitError(
				"bad_argument",
				`the ${label} is not under an mfw-owned root: ${p}`,
			);
		}
	}
	const wipPrefix = o.wipSourcePrefix ?? `refs/heads/mfw-wip/${runId}/`;
	if (
		!/^refs\/[A-Za-z0-9_./-]+\/$/.test(wipPrefix) ||
		wipPrefix.includes("..")
	) {
		throw new HostGitError("bad_argument", `bad wip prefix: ${wipPrefix}`);
	}

	// 1. processes dead, cgroup gone.
	try {
		await o.assertProcessesDead();
	} catch (e) {
		throw new HostGitError(
			"precondition",
			`run processes are not confirmed dead: ${e instanceof Error ? e.message : String(e)}`,
		);
	}

	// 2. alternates, immediately before the fetch.
	assertNoAlternates(o.clonePath);

	// 3. fetch into a fresh throwaway bare repo.
	const bare = await mkdtemp(join(o.scratchRoot, `hostgit-${runId}-`));
	try {
		await host.runOk(["init", "--bare", "--quiet", "--", bare], {
			cwd: o.scratchRoot,
		});
		const headSpec = `+refs/heads/mfw/${runId}:${BARE_HEAD}`;
		const wipSpec = `+${wipPrefix}*:${BARE_WIP}*`;
		const fetchFlags = [
			"--no-tags",
			"--no-write-fetch-head",
			"--no-recurse-submodules",
			"--no-auto-gc",
			"--no-auto-maintenance",
			"--no-prune",
		];
		const first = await host.run(
			["fetch", ...fetchFlags, "--", o.clonePath, headSpec, wipSpec],
			{ cwd: bare, allowFile: true },
		);
		if (first.exitCode !== 0) {
			const missing = /couldn't find remote ref/i.test(first.stderr);
			throw new HostGitError(
				missing ? "no_branch" : "fetch_failed",
				missing
					? `the clone has no refs/heads/mfw/${runId}`
					: `fetch from the clone failed (${first.exitCode}): ${first.stderr}`,
			);
		}

		const refs = await host.runOk(
			["for-each-ref", "--format=%(refname) %(objectname)", "refs/mfw/run/"],
			{ cwd: bare },
		);
		const heads = new Map<string, string>();
		for (const line of refs.split("\n").filter(Boolean)) {
			const [name, sha] = line.split(" ") as [string, string];
			heads.set(name, sha);
		}
		const tip = heads.get(BARE_HEAD);
		if (!tip) throw new HostGitError("no_branch", "no head ref was fetched");
		const wipNames = [...heads.keys()].filter((n) => n.startsWith(BARE_WIP));

		// 4. validation hook, on the untrusted bare repo only.
		if (o.validate) {
			try {
				await o.validate({
					bareRepo: bare,
					runId,
					headRef: BARE_HEAD,
					wipRefs: wipNames,
					host,
				});
			} catch (e) {
				if (e instanceof HostGitError) throw e;
				throw new HostGitError(
					"validation",
					e instanceof Error ? e.message : String(e),
				);
			}
		}

		// 5. into the primary's quarantine namespace.
		const qHead = quarantineRef(runId);
		const qWip = quarantineWipPrefix(runId);
		await host.runOk(
			[
				"fetch",
				...fetchFlags,
				"--",
				bare,
				`+${BARE_HEAD}:${qHead}`,
				`+${BARE_WIP}*:${qWip}*`,
			],
			{ cwd: o.primaryRepo, allowFile: true },
		);
		return {
			quarantineRef: qHead,
			tip,
			wipRefs: wipNames.map((n) => ({
				ref: qWip + n.slice(BARE_WIP.length),
				sha: heads.get(n) as string,
			})),
		};
	} finally {
		await rm(bare, { recursive: true, force: true });
	}
}
