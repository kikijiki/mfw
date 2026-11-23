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
import { randomBytes } from "node:crypto";
import { constants, lstatSync, realpathSync } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { gitComplete, gitOk } from "../git.ts";
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
	/**
	 * A host-owned directory the bundle lives under (for example the run dir).
	 * It is the trust anchor: nothing from `outboxRoot` down may be a symlink.
	 */
	outboxRoot: string;
	/** Path of the bundle below `outboxRoot`, such as `outbox/result.bundle`. Read as bytes, never as a repo. */
	bundleRel: string;
	runId: string;
	/** Host-owned dir under which the throwaway repo is made. */
	scratchRoot: string;
	/** Throws or rejects unless every run process is dead and its cgroup gone. */
	assertProcessesDead: () => void | Promise<void>;
	/**
	 * Runs on the bare repo before anything reaches the primary. Throw to reject.
	 * Required: fsck passes some hostile content (a `ext::` submodule url, a
	 * symlink out of the tree, filter or diff drivers), so an import with no
	 * validator is refused. Tests opt out with `unsafeNoValidation`.
	 */
	validate: (ctx: FetchValidationContext) => void | Promise<void>;
	/** Refuse a bundle file larger than this. Default 1 GiB. */
	maxBundleBytes?: number;
	/** Refuse a bundle advertising more refs than this. Default 1000. */
	maxRefs?: number;
	/**
	 * `live` imports a sample of a run that is still going into its own
	 * namespace, which nothing treats as the run's result. The caller's
	 * precondition then proves the outbox is host-anchored rather than that the
	 * run is dead: the bundle is copied from one opened descriptor and verified
	 * as untrusted bytes either way.
	 */
	destination?: "result" | "live";
}

/** Test-only opt-out of the mandatory validator. Never pass this in daemon code. */
export const unsafeNoValidation = (): void => {};

export interface FetchRunResultOk {
	quarantineRef: string;
	tip: string;
	wipRefs: { ref: string; sha: string }[];
}

const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const BARE_HEAD = "refs/mfw/run/head";
const BARE_WIP = "refs/mfw/run/wip/";
const INCOMING_PREFIX = "refs/mfw/incoming/";
/**
 * The WIP names the quarantine transaction accepts, one level short of the
 * runner's depth limit because `incoming/<id>/wip/` adds a component. Git
 * allows more (`a.b`); those are refused before anything reaches the primary.
 */
const WIP_NAME_RE = /^[A-Za-z0-9_-]{1,128}(?:\/[A-Za-z0-9_-]{1,128}){0,6}$/;
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

/** Live samples of a running run. Never a result: the merge queue does not read them. */
export function quarantineLivePrefix(runId: string): string {
	assertRunId(runId);
	return `refs/mfw/quarantine-live/${runId}/`;
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

/** Remove what an interrupted import left under `refs/mfw/incoming/`. Call at boot, before any import. */
export async function sweepIncomingRefs(primaryRepo: string): Promise<void> {
	// Plain git in the trusted primary: an older import may have left a name
	// the HostGit transaction pattern refuses, which is why it was left behind.
	const listed = await gitComplete(
		["for-each-ref", "--format=%(refname)", INCOMING_PREFIX],
		primaryRepo,
	);
	for (const ref of listed.split("\n").filter(Boolean)) {
		if (!ref.startsWith(INCOMING_PREFIX)) continue;
		await gitOk(["update-ref", "-d", ref], primaryRepo);
	}
}

export interface BundleHeader {
	refs: { name: string; sha: string }[];
}

/** Parse a bundle header from its leading bytes. Refuses anything but a complete, unfiltered bundle. */
export function parseBundleHeader(head: string, maxRefs: number): BundleHeader {
	const lines = head.split("\n");
	const magic = lines.shift();
	// Error texts never echo the bytes: a mis-pointed read must not leak a host file.
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
				throw new HostGitError("bad_bundle", "unsupported bundle capability");
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
	} catch {
		throw new HostGitError(
			"bad_bundle",
			"cannot open the bundle (a symlink, or missing)",
		);
	}
	try {
		const st = await from.stat();
		// The path we checked is the file we opened (no swap in between).
		const seen = lstatSync(src);
		if (seen.dev !== st.dev || seen.ino !== st.ino) {
			throw new HostGitError("bad_bundle", "the bundle changed while opening");
		}
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

/**
 * `outboxRoot/bundleRel` as a path, after proving no component from the root
 * down is a symlink. `O_NOFOLLOW` only covers the last component, so an agent
 * that can swap a parent directory for a symlink could point the host at any
 * file; processes are dead by now, which makes this check stable.
 */
export function resolveBundlePath(
	outboxRoot: string,
	bundleRel: string,
): string {
	assertLocalSource(outboxRoot);
	const parts = bundleRel.split("/");
	if (
		bundleRel === "" ||
		isAbsolute(bundleRel) ||
		bundleRel.includes("\0") ||
		parts.some((c) => c === "" || c === "." || c === "..")
	) {
		throw new HostGitError(
			"bad_argument",
			"bundleRel must be a clean relative path",
		);
	}
	let cur: string;
	try {
		cur = realpathSync(outboxRoot);
	} catch {
		throw new HostGitError("bad_bundle", "the outbox root does not exist");
	}
	for (const [i, c] of parts.entries()) {
		cur = join(cur, c);
		let st: ReturnType<typeof lstatSync>;
		try {
			st = lstatSync(cur);
		} catch {
			throw new HostGitError("bad_bundle", "the bundle is missing");
		}
		if (st.isSymbolicLink()) {
			throw new HostGitError("bad_bundle", "the bundle path crosses a symlink");
		}
		if (i < parts.length - 1 && !st.isDirectory()) {
			throw new HostGitError(
				"bad_bundle",
				"the bundle path crosses a non-directory",
			);
		}
	}
	return cur;
}

export async function fetchRunResult(
	o: FetchRunResultOpts,
): Promise<FetchRunResultOk> {
	const { host, runId } = o;
	assertRunId(runId);
	assertLocalSource(o.outboxRoot);
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
	if (typeof o.validate !== "function") {
		throw new HostGitError(
			"validation",
			"refusing to import without a validator (pass one; fsck alone is not enough)",
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
			await copyBundle(
				resolveBundlePath(o.outboxRoot, o.bundleRel),
				copy,
				maxBytes,
			),
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
				imported.stderr.includes("mismatched algorithms")
					? "the primary repo's object format (sha256) is not supported"
					: `the bundle was rejected (${imported.raw.signalCode ?? imported.exitCode}): ${imported.stderr.slice(0, 300)}`,
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
		if (wipNames.some((n) => !WIP_NAME_RE.test(n.slice(BARE_WIP.length)))) {
			throw new HostGitError(
				"validation",
				"the bundle has a WIP ref whose name the host does not accept",
			);
		}
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

		// 6. into the primary's quarantine namespaces, in one transaction.
		//    The objects land under a per-attempt `incoming` namespace first (a
		//    fresh name, so it cannot conflict with an earlier attempt); then a
		//    single `update-ref --stdin` transaction moves the head and WIP refs,
		//    deletes the WIP refs an earlier attempt left, and drops `incoming`.
		//    Either the whole result replaces the previous one, or nothing moves.
		const live = o.destination === "live";
		const qHead = live
			? `${quarantineLivePrefix(runId)}head`
			: quarantineRef(runId);
		const qWip = live
			? `${quarantineLivePrefix(runId)}wip/`
			: quarantineWipPrefix(runId);
		const attempt = randomBytes(8).toString("hex");
		const inc = `refs/mfw/incoming/${attempt}/`;
		const priOpts = { cwd: o.primaryRepo, repo: o.primaryRepo };
		const incoming = [
			`${inc}head`,
			...wipNames.map((n) => inc + "wip/" + n.slice(BARE_WIP.length)),
		];
		try {
			await host.runOk(
				[
					"fetch",
					...fetchFlags,
					"--atomic",
					"--",
					bare,
					`+${BARE_HEAD}:${inc}head`,
					`+${BARE_WIP}*:${inc}wip/*`,
				],
				{ ...priOpts, allowFile: true },
			);
			const have = await host.runOk(
				["for-each-ref", "--format=%(refname)", qWip.slice(0, -1) + "/"],
				priOpts,
			);
			const keep = new Set(
				wipNames.map((n) => qWip + n.slice(BARE_WIP.length)),
			);
			const lines = ["start", `update ${qHead} ${tip}`];
			for (const n of wipNames) {
				lines.push(`update ${qWip}${n.slice(BARE_WIP.length)} ${heads.get(n)}`);
			}
			for (const stale of have.split("\n").filter(Boolean)) {
				if (!keep.has(stale)) lines.push(`delete ${stale}`);
			}
			for (const r of incoming) lines.push(`delete ${r}`);
			lines.push("prepare", "commit");
			const tx = await host.run(["update-ref", "--stdin"], {
				...priOpts,
				input: `${lines.join("\n")}\n`,
			});
			if (tx.exitCode !== 0) {
				throw new HostGitError(
					"fetch_failed",
					`the quarantine update failed: ${tx.stderr.slice(0, 300)}`,
				);
			}
		} catch (e) {
			// Leave nothing of this attempt behind; the previous result stands.
			await host
				.run(["update-ref", "--stdin"], {
					...priOpts,
					input: `${["start", ...incoming.map((r) => `delete ${r}`), "prepare", "commit"].join("\n")}\n`,
				})
				.catch(() => {});
			throw e;
		}
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
