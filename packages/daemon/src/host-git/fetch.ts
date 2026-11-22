/**
 * fetchRunResult: bring a finished run's branch out of its sandbox and into the
 * primary repo's quarantine namespace, without the host ever reading the
 * agent-writable gitdir.
 *
 * Why a bundle: a path fetch makes git's `upload-pack` resolve the clone on the
 * host filesystem, and a tampered clone can redirect that resolution (a
 * `commondir` file, a symlinked `objects/pack` or ref, a decoy `.git` beside a
 * root-level gitdir with alternates), so another host repo's objects land in the
 * primary. No gitdir check can enumerate every redirection. Instead a helper
 * *inside* the sandbox writes a `git bundle` (see `sandboxBundleArgv`) to the
 * run's outbox, and the host treats that file as opaque untrusted bytes:
 *
 *  1. the injected "processes dead, cgroup gone" precondition;
 *  2. copy the file (opened O_NOFOLLOW, regular file only, size capped) into a
 *     host-owned scratch dir, so nothing else is ever read from the outbox;
 *  3. parse the bundle header (no git): refuse prerequisites, filters and too
 *     many refs;
 *  4. fetch the strict refspecs from the copy into a fresh throwaway bare repo
 *     (fsck on, so the pack is verified object by object);
 *  5. the validation hook, on the bare repo;
 *  6. fetch from the bare repo into the primary's quarantine refs.
 *
 * Every git call goes through `HostGit`.
 */
import { constants } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
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
	/** The bundle the sandbox wrote to the run's outbox. Read as bytes, never as a repo. */
	bundlePath: string;
	runId: string;
	/** Host-owned dir under which the throwaway repo is made. */
	scratchRoot: string;
	/** Throws or rejects unless every run process is dead and its cgroup gone. */
	assertProcessesDead: () => void | Promise<void>;
	/** Runs on the bare repo before anything reaches the primary. Throw to reject. */
	validate?: (ctx: FetchValidationContext) => void | Promise<void>;
	/** Refuse a bundle file larger than this. Default 1 GiB. */
	maxBundleBytes?: number;
	/** Refuse a bundle advertising more refs than this. Default 1000. */
	maxRefs?: number;
}

export interface FetchRunResultOk {
	quarantineRef: string;
	tip: string;
	wipRefs: { ref: string; sha: string }[];
}

const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const BARE_HEAD = "refs/mfw/run/head";
const BARE_WIP = "refs/mfw/run/wip/";
const HEADER_CAP = 1024 * 1024;
export const DEFAULT_MAX_BUNDLE_BYTES = 1024 * 1024 * 1024;
export const DEFAULT_MAX_REFS = 1000;

export function quarantineRef(runId: string): string {
	assertRunId(runId);
	return `refs/mfw/quarantine/${runId}`;
}

export function quarantineWipPrefix(runId: string): string {
	assertRunId(runId);
	return `refs/mfw/quarantine-wip/${runId}/`;
}

/** The ref the run's branch has inside the sandbox, and the prefix of its WIP snapshots. */
export function runHeadSourceRef(runId: string): string {
	assertRunId(runId);
	return `refs/heads/mfw/${runId}`;
}

export function wipSourcePrefix(runId: string): string {
	assertRunId(runId);
	return `refs/heads/mfw-wip/${runId}/`;
}

export function assertRunId(runId: string): void {
	if (!RUN_ID_RE.test(runId)) {
		throw new HostGitError(
			"bad_run_id",
			`run id must match ${RUN_ID_RE}: ${JSON.stringify(runId)}`,
		);
	}
}

/**
 * The command the in-sandbox helper runs to write the outbox bundle: the run
 * branch plus every WIP snapshot. Always a complete bundle (no prerequisites),
 * so the host can verify it against an empty repository.
 */
export function sandboxBundleArgv(runId: string, outPath: string): string[] {
	return [
		"git",
		"bundle",
		"create",
		outPath,
		runHeadSourceRef(runId),
		`--glob=${wipSourcePrefix(runId)}*`,
	];
}

export interface BundleHeader {
	refs: { name: string; sha: string }[];
}

/** Parse a bundle header from its leading bytes. Refuses anything but a complete, unfiltered bundle. */
export function parseBundleHeader(head: string, maxRefs: number): BundleHeader {
	const lines = head.split("\n");
	const magic = lines.shift();
	if (magic !== "# v2 git bundle" && magic !== "# v3 git bundle") {
		throw new HostGitError("bad_bundle", "not a git bundle (bad signature)");
	}
	const refs: BundleHeader["refs"] = [];
	let sawEnd = false;
	for (const line of lines) {
		if (line === "") {
			sawEnd = true;
			break;
		}
		if (line.startsWith("@")) {
			// v3 capabilities: object-format and filter change what the pack holds.
			if (line !== "@object-format=sha1") {
				throw new HostGitError("bad_bundle", `unsupported capability ${line}`);
			}
			continue;
		}
		if (line.startsWith("-")) {
			throw new HostGitError(
				"bad_bundle",
				"the bundle has prerequisites; only complete bundles are accepted",
			);
		}
		const m = /^([0-9a-f]{40}) (\S.*)$/.exec(line);
		if (!m)
			throw new HostGitError("bad_bundle", "malformed bundle header line");
		refs.push({ sha: m[1] as string, name: m[2] as string });
		if (refs.length > maxRefs) {
			throw new HostGitError(
				"bad_bundle",
				`the bundle has more than ${maxRefs} refs`,
			);
		}
	}
	if (!sawEnd)
		throw new HostGitError("bad_bundle", "bundle header is not terminated");
	return { refs };
}

/** Copy a regular file, refusing symlinks and oversize, into `dest`. Returns the header text. */
async function copyBundle(
	src: string,
	dest: string,
	maxBytes: number,
): Promise<string> {
	let from: Awaited<ReturnType<typeof open>>;
	try {
		from = await open(
			src,
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
	} catch (e) {
		throw new HostGitError(
			"bad_bundle",
			`cannot open the bundle (a symlink, or missing): ${e instanceof Error ? e.message : String(e)}`,
		);
	}
	try {
		const st = await from.stat();
		if (!st.isFile()) {
			throw new HostGitError("bad_bundle", "the bundle is not a regular file");
		}
		if (st.size > maxBytes) {
			throw new HostGitError(
				"bad_bundle",
				`the bundle is ${st.size} bytes, over the ${maxBytes} cap`,
			);
		}
		const to = await open(dest, "wx", 0o600);
		let header = Buffer.alloc(0);
		try {
			const buf = Buffer.allocUnsafe(1024 * 1024);
			let total = 0;
			for (;;) {
				const { bytesRead } = await from.read(buf, 0, buf.length, null);
				if (bytesRead === 0) break;
				total += bytesRead;
				if (total > maxBytes) {
					throw new HostGitError("bad_bundle", "the bundle grew past the cap");
				}
				if (header.length < HEADER_CAP) {
					header = Buffer.concat([header, buf.subarray(0, bytesRead)]).subarray(
						0,
						HEADER_CAP,
					);
				}
				await to.write(buf, 0, bytesRead);
			}
		} finally {
			await to.close();
		}
		// The header is text up to the first blank line; the pack follows.
		const text = header.toString("latin1");
		const end = text.indexOf("\n\n");
		if (end === -1) {
			throw new HostGitError("bad_bundle", "bundle header is not terminated");
		}
		return text.slice(0, end + 1) + "\n";
	} finally {
		await from.close();
	}
}

export async function fetchRunResult(
	o: FetchRunResultOpts,
): Promise<FetchRunResultOk> {
	const { host, runId } = o;
	assertRunId(runId);
	assertLocalSource(o.bundlePath);
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
	const maxBytes = o.maxBundleBytes ?? DEFAULT_MAX_BUNDLE_BYTES;
	const maxRefs = o.maxRefs ?? DEFAULT_MAX_REFS;

	// 1. processes dead, cgroup gone.
	try {
		await o.assertProcessesDead();
	} catch (e) {
		throw new HostGitError(
			"precondition",
			`run processes are not confirmed dead: ${e instanceof Error ? e.message : String(e)}`,
		);
	}

	const work = await mkdtemp(join(o.scratchRoot, `hostgit-${runId}-`));
	try {
		// 2-3. copy the file out of the outbox, parse its header.
		const copy = join(work, "run.bundle");
		const header = parseBundleHeader(
			await copyBundle(o.bundlePath, copy, maxBytes),
			maxRefs,
		);
		const headSrc = runHeadSourceRef(runId);
		const wipPrefix = wipSourcePrefix(runId);
		if (!header.refs.some((r) => r.name === headSrc)) {
			throw new HostGitError("no_branch", `the bundle has no ${headSrc}`);
		}

		// 4. into a fresh throwaway bare repo.
		const bare = join(work, "repo.git");
		await host.runOk(["init", "--bare", "--quiet", "--", bare], {
			cwd: work,
		});
		const fetchFlags = [
			"--no-tags",
			"--no-write-fetch-head",
			"--no-recurse-submodules",
			"--no-auto-gc",
			"--no-auto-maintenance",
			"--no-prune",
		];
		const imported = await host.run(
			[
				"fetch",
				...fetchFlags,
				"--",
				copy,
				`+${headSrc}:${BARE_HEAD}`,
				`+${wipPrefix}*:${BARE_WIP}*`,
			],
			// A bundle is read through the `file` transport; the source is our own copy.
			{ cwd: bare, repo: bare, allowFile: true },
		);
		if (imported.exitCode !== 0) {
			// Includes a child killed by the memory or CPU cap (a delta bomb).
			throw new HostGitError(
				"bad_bundle",
				`the bundle was rejected (${imported.raw.signalCode ?? imported.exitCode}): ${imported.stderr.slice(0, 300)}`,
			);
		}

		const refs = await host.runOk(
			[
				"for-each-ref",
				"--format=%(refname) %(objectname) %(objecttype)",
				"refs/mfw/run/",
			],
			{ cwd: bare, repo: bare },
		);
		const heads = new Map<string, string>();
		for (const line of refs.split("\n").filter(Boolean)) {
			const [name, sha, type] = line.split(" ") as [string, string, string];
			// Exactly a commit: git only enforces that under refs/heads/, and the
			// destination is refs/mfw/. A tag would also hide which commit lands.
			if (type !== "commit") {
				throw new HostGitError(
					"bad_bundle",
					`${name.slice(0, 200)} points at a ${type.slice(0, 20)}, not a commit`,
				);
			}
			heads.set(name, sha);
		}
		const tip = heads.get(BARE_HEAD);
		if (!tip) throw new HostGitError("no_branch", "no head ref was fetched");
		const wipNames = [...heads.keys()].filter((n) => n.startsWith(BARE_WIP));

		// 5. validation hook, on the untrusted bare repo only.
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

		// 6. into the primary's quarantine namespace.
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
			{ cwd: o.primaryRepo, repo: o.primaryRepo, allowFile: true },
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
		await rm(work, { recursive: true, force: true });
	}
}
