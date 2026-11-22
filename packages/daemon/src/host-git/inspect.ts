/**
 * Bounds on a fetched run result, checked in the throwaway bare repo with no
 * checkout. `fetchRunResult` calls the validator this module builds before any
 * object reaches the primary repo.
 *
 * Why this exists: `transfer.fsckObjects` rejects some malformed trees but
 * passes hostile content that is well formed (a symlink out of the tree, a
 * changed gitlink, an `ext::` submodule url, `filter=lfs` attributes). So the
 * result is compared with the trusted base commit, using only read-only
 * plumbing (`ls-tree`, `diff-tree`, `cat-file`) through `HostGit`. Nothing is
 * checked out and no blob is ever executed or handed to a filter.
 *
 * What is checked, for the run branch and for every WIP snapshot:
 *  - paths of every changed entry: no `..` or `.` or empty component, no
 *    absolute path, no `.git` component (also its case, NTFS and HFS spellings);
 *  - modes: only regular, executable, symlink and gitlink; a type change or an
 *    exec-bit change against the base is reported;
 *  - symlink targets: relative, inside the tree, not through `.git`;
 *  - gitlinks and `.gitmodules`: any difference from the base is refused (the
 *    base's own submodules are seeded by the host, see `submodules.ts`);
 *  - `.gitattributes` and `.lfsconfig` changes are flagged (a checkout with the
 *    host's global `filter.lfs` could send credentials to an attacker's LFS url);
 *  - LFS use, three ways, on the run branch: `filter=lfs` in any
 *    `.gitattributes`, a `.lfsconfig`, and pointer files. Refused until LFS is
 *    supported for autonomous runs.
 *
 * Findings are `refuse` or `flag`. A `refuse` stops the import; a `flag` is for
 * the caller to turn into an ask-first card.
 */
import type { FetchValidationContext } from "./fetch.ts";
import { type HostGit, HostGitError } from "./runner.ts";

export type FindingSeverity = "refuse" | "flag";

export type FindingCode =
	| "bad_path"
	| "bad_mode"
	| "bad_symlink"
	| "gitlink_changed"
	| "gitmodules_changed"
	| "special_file_symlink"
	| "special_file_unreadable"
	| "gitattributes_changed"
	| "lfsconfig_changed"
	| "type_change"
	| "mode_change"
	| "lfs"
	| "base_missing"
	| "too_large";

export interface Finding {
	severity: FindingSeverity;
	code: FindingCode;
	/** The ref inside the bare repo the finding is about. */
	ref: string;
	path?: string;
	detail: string;
}

export interface LfsEvidence {
	/** `.gitattributes` files that set `filter=lfs`. */
	attributes: string[];
	/** `.lfsconfig` files in the tree. */
	lfsconfig: string[];
	/** Paths of LFS pointer files. Capped at `maxPointerReport`. */
	pointers: string[];
	/** True when a pointer scan was cut short by `maxPointerCandidates`. */
	pointerScanTruncated: boolean;
	detected: boolean;
}

export interface InspectLimits {
	/** Largest ls-tree or diff-tree output read. Default 128 MiB. */
	maxListBytes: number;
	/** Largest `.gitattributes` / `.lfsconfig` / `.gitmodules` blob read. Default 1 MiB. */
	maxSpecialBytes: number;
	/** Largest symlink target. Default 4096, as PATH_MAX. */
	maxSymlinkBytes: number;
	/** Most small blobs read for the pointer scan. Default 50 000. */
	maxPointerCandidates: number;
}

export const DEFAULT_INSPECT_LIMITS: InspectLimits = {
	maxListBytes: 128 * 1024 * 1024,
	maxSpecialBytes: 1024 * 1024,
	maxSymlinkBytes: 4096,
	maxPointerCandidates: 50_000,
};

export interface InspectOpts {
	host: HostGit;
	/** The throwaway bare repo. */
	repo: string;
	/** The trusted base commit. It must be in the repo; a complete bundle carries it. */
	baseSha: string;
	/** The run branch ref inside the bare repo. Gets the full LFS scan. */
	headRef: string;
	/** WIP snapshot refs inside the bare repo. */
	wipRefs?: string[];
	limits?: Partial<InspectLimits>;
}

export interface InspectReport {
	findings: Finding[];
	/** LFS evidence for the run branch. */
	lfs: LfsEvidence;
	/** True when any finding is `refuse`. */
	refused: boolean;
}

const SHA_RE = /^[0-9a-f]{40}$/;
/** Pointer files are under 1 KiB; the shortest valid one is about 120 bytes. */
const POINTER_MIN = 100;
const POINTER_MAX = 1024;
const POINTER_CHUNK = 200;
const MAX_POINTER_REPORT = 20;
const LFS_POINTER_RE =
	/^version https:\/\/git-lfs\.github\.com\/spec\/v1\r?\noid sha256:[0-9a-f]{64}\r?\nsize [0-9]+\r?\n/;
const MODES_ALLOWED = new Set(["100644", "100755", "120000", "160000"]);
const NULL_MODE = "000000";
const SPECIAL = new Set([".gitattributes", ".lfsconfig", ".gitmodules"]);

/** Characters HFS+ ignores when it compares names: `.g‌it` is `.git` there. */
const HFS_IGNORABLE = /[‌-‏‪-‮⁪-⁯﻿]/g;

/** True for a path component git or a filesystem would read as the `.git` directory. */
export function isDotGit(component: string): boolean {
	const c = component
		.replace(HFS_IGNORABLE, "")
		.replace(/[. ]+$/, "")
		.toLowerCase();
	return c === ".git" || c === "git~1";
}

/** Why `path` is not an acceptable tracked path, or undefined. */
export function badPathReason(path: string): string | undefined {
	if (path === "") return "empty path";
	if (path.includes("\0")) return "NUL in path";
	if (path.startsWith("/")) return "absolute path";
	if (path.includes("\\")) return "backslash in path";
	for (const c of path.split("/")) {
		if (c === "") return "empty path component";
		if (c === "." || c === "..") return `'${c}' path component`;
		if (isDotGit(c)) return "'.git' path component";
	}
	return undefined;
}

/** Why a symlink at `path` pointing at `target` is not acceptable, or undefined. */
export function badSymlinkReason(
	path: string,
	target: string,
): string | undefined {
	if (target === "") return "empty target";
	if (target.includes("\0")) return "NUL in target";
	if (target.startsWith("/")) return "absolute target";
	if (target.includes("\\")) return "backslash in target";
	const stack = path.split("/").slice(0, -1);
	for (const c of target.split("/")) {
		if (c === "" || c === ".") continue;
		if (c === "..") {
			if (stack.length === 0) return "target escapes the tree";
			stack.pop();
			continue;
		}
		if (isDotGit(c)) return "target passes through '.git'";
		stack.push(c);
	}
	return undefined;
}

interface DiffEntry {
	oldMode: string;
	newMode: string;
	oldSha: string;
	newSha: string;
	status: string;
	path: string;
}

interface TreeEntry {
	mode: string;
	type: string;
	sha: string;
	size: number | undefined;
	path: string;
}

function baseName(p: string): string {
	return p.slice(p.lastIndexOf("/") + 1);
}

/** Run a read-only git command; refuse truncated output (it is tail-kept, so it would hide the head). */
async function gitRaw(
	host: HostGit,
	repo: string,
	args: string[],
	maxBytes: number,
	input?: string,
): Promise<string> {
	const r = await host.run(args, {
		cwd: repo,
		repo,
		maxOutputBytes: maxBytes,
		...(input !== undefined ? { input } : {}),
	});
	if (r.exitCode !== 0) {
		throw new HostGitError(
			"validation",
			`git ${args[0]} failed (${r.exitCode}): ${r.stderr.slice(0, 300)}`,
		);
	}
	if (r.raw.truncated) {
		throw new HostGitError(
			"validation",
			`git ${args[0]} output is over the ${maxBytes} byte cap`,
		);
	}
	return r.raw.stdout;
}

export function parseDiffTreeZ(out: string): DiffEntry[] {
	const parts = out.split("\0");
	const entries: DiffEntry[] = [];
	for (let i = 0; i + 1 < parts.length; i += 2) {
		const meta = parts[i] as string;
		const m =
			/^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([A-Z])[0-9]*$/.exec(
				meta,
			);
		if (!m) {
			throw new HostGitError("validation", "unparseable diff-tree output");
		}
		entries.push({
			oldMode: m[1] as string,
			newMode: m[2] as string,
			oldSha: m[3] as string,
			newSha: m[4] as string,
			status: m[5] as string,
			path: parts[i + 1] as string,
		});
	}
	return entries;
}

export function parseLsTreeZ(out: string): TreeEntry[] {
	const entries: TreeEntry[] = [];
	for (const rec of out.split("\0")) {
		if (rec === "") continue;
		const tab = rec.indexOf("\t");
		const m =
			tab === -1
				? null
				: /^([0-7]{6}) (\w+) ([0-9a-f]{40}) +(-|[0-9]+)$/.exec(
						rec.slice(0, tab),
					);
		if (!m) throw new HostGitError("validation", "unparseable ls-tree output");
		entries.push({
			mode: m[1] as string,
			type: m[2] as string,
			sha: m[3] as string,
			size: m[4] === "-" ? undefined : Number(m[4]),
			path: rec.slice(tab + 1),
		});
	}
	return entries;
}

/** One blob's bytes as text, or undefined when it is over `maxBytes`. */
async function readBlob(
	o: InspectOpts,
	sha: string,
	maxBytes: number,
): Promise<string | undefined> {
	const r = await o.host.run(["cat-file", "-p", sha], {
		cwd: o.repo,
		repo: o.repo,
		// Room for utf-8 expansion of bytes that are not text.
		maxOutputBytes: maxBytes * 4 + 1024,
	});
	if (r.exitCode !== 0) {
		throw new HostGitError(
			"validation",
			`cannot read blob ${sha}: ${r.stderr.slice(0, 200)}`,
		);
	}
	if (r.raw.truncated || r.raw.stdout.length > maxBytes) return undefined;
	return r.raw.stdout;
}

async function checkRef(
	o: InspectOpts,
	lim: InspectLimits,
	ref: string,
	findings: Finding[],
): Promise<void> {
	const out = await gitRaw(
		o.host,
		o.repo,
		[
			"diff-tree",
			"-r",
			"-z",
			"--raw",
			"--no-renames",
			"--no-ext-diff",
			"--no-textconv",
			o.baseSha,
			ref,
		],
		lim.maxListBytes,
	);
	const add = (
		severity: FindingSeverity,
		code: FindingCode,
		path: string,
		detail: string,
	): void => {
		findings.push({ severity, code, ref, path: shown(path), detail });
	};
	for (const e of parseDiffTreeZ(out)) {
		const deleted = e.newMode === NULL_MODE;
		const name = baseName(e.path);
		const special = SPECIAL.has(name);

		// Deletions only need the special-file and gitlink rules: removing a path
		// cannot put anything dangerous into the tree.
		if (e.oldMode === "160000" || e.newMode === "160000") {
			add(
				"refuse",
				"gitlink_changed",
				e.path,
				`gitlink ${e.status === "A" ? "added" : e.status === "D" ? "removed" : "changed"} against the base`,
			);
		}
		if (name === ".gitmodules") {
			add(
				"refuse",
				"gitmodules_changed",
				e.path,
				".gitmodules differs from the base",
			);
		} else if (name === ".gitattributes") {
			add(
				"flag",
				"gitattributes_changed",
				e.path,
				".gitattributes differs from the base",
			);
		} else if (name === ".lfsconfig") {
			add(
				"flag",
				"lfsconfig_changed",
				e.path,
				".lfsconfig differs from the base",
			);
		}
		if (deleted) continue;

		const why = badPathReason(e.path);
		if (why) add("refuse", "bad_path", e.path, why);
		// git canonicalises file modes in raw diffs (100664 shows as 100644), so
		// this only fires for a type that is not a file, link or gitlink.
		if (!MODES_ALLOWED.has(e.newMode)) {
			add("refuse", "bad_mode", e.path, `mode ${e.newMode}`);
			continue;
		}
		if (special && e.newMode === "120000") {
			add("refuse", "special_file_symlink", e.path, `${name} is a symlink`);
		}
		if (e.oldMode !== NULL_MODE && e.oldMode !== e.newMode) {
			const kind = (m: string): string =>
				m === "120000" ? "symlink" : m === "160000" ? "gitlink" : "file";
			if (kind(e.oldMode) !== kind(e.newMode)) {
				add(
					"flag",
					"type_change",
					e.path,
					`${kind(e.oldMode)} became ${kind(e.newMode)}`,
				);
			} else {
				add(
					"flag",
					"mode_change",
					e.path,
					`mode ${e.oldMode} became ${e.newMode}`,
				);
			}
		}
		if (e.newMode === "120000") {
			const target = await readBlob(o, e.newSha, lim.maxSymlinkBytes);
			if (target === undefined) {
				add(
					"refuse",
					"bad_symlink",
					e.path,
					`target is over ${lim.maxSymlinkBytes} bytes`,
				);
			} else {
				const bad = badSymlinkReason(e.path, target);
				if (bad) add("refuse", "bad_symlink", e.path, bad);
			}
		}
	}
}

/** A path for a message: bounded and with control characters made visible. */
function shown(p: string): string {
	const s = p.length > 200 ? `${p.slice(0, 200)}…` : p;
	let out = "";
	for (const ch of s) {
		const c = ch.charCodeAt(0);
		out +=
			c < 0x20 || c === 0x7f ? `\\x${c.toString(16).padStart(2, "0")}` : ch;
	}
	return out;
}

/** LFS detection on the run branch's full tree, three ways. */
async function scanLfs(
	o: InspectOpts,
	lim: InspectLimits,
	findings: Finding[],
): Promise<LfsEvidence> {
	const lfs: LfsEvidence = {
		attributes: [],
		lfsconfig: [],
		pointers: [],
		pointerScanTruncated: false,
		detected: false,
	};
	const out = await gitRaw(
		o.host,
		o.repo,
		["ls-tree", "-r", "-z", "-l", "--full-tree", o.headRef],
		lim.maxListBytes,
	);
	const tree = parseLsTreeZ(out);
	const tooLarge = (path: string): void => {
		findings.push({
			severity: "refuse",
			code: "too_large",
			ref: o.headRef,
			path: shown(path),
			detail: `over ${lim.maxSpecialBytes} bytes, cannot be checked`,
		});
	};

	// 1 and 2: attributes and .lfsconfig. Every one in the tree, not just the root.
	for (const e of tree) {
		if (e.type !== "blob" || e.mode === "120000") continue;
		const name = baseName(e.path);
		if (name !== ".gitattributes" && name !== ".lfsconfig") continue;
		if ((e.size ?? 0) > lim.maxSpecialBytes) {
			tooLarge(e.path);
			continue;
		}
		if (name === ".lfsconfig") {
			lfs.lfsconfig.push(shown(e.path));
			continue;
		}
		const text = await readBlob(o, e.sha, lim.maxSpecialBytes);
		if (text === undefined) {
			tooLarge(e.path);
			continue;
		}
		for (const line of text.split(/\r?\n/)) {
			const l = line.trim();
			if (l === "" || l.startsWith("#")) continue;
			if (/(?:^|\s)filter=lfs(?:\s|$)/.test(l)) {
				lfs.attributes.push(shown(e.path));
				break;
			}
		}
	}

	// 3: pointer files, among the blobs small enough to be one.
	const candidates = tree.filter(
		(e) =>
			e.type === "blob" &&
			e.mode !== "120000" &&
			e.size !== undefined &&
			e.size >= POINTER_MIN &&
			e.size <= POINTER_MAX,
	);
	if (candidates.length > lim.maxPointerCandidates) {
		lfs.pointerScanTruncated = true;
	}
	const scan = candidates.slice(0, lim.maxPointerCandidates);
	for (let i = 0; i < scan.length; i += POINTER_CHUNK) {
		const chunk = scan.slice(i, i + POINTER_CHUNK);
		for (const [e, text] of await readChunk(o, chunk)) {
			if (LFS_POINTER_RE.test(text)) {
				lfs.pointers.push(shown(e.path));
			}
		}
	}
	lfs.pointers = lfs.pointers.slice(0, MAX_POINTER_REPORT);

	lfs.detected =
		lfs.attributes.length > 0 ||
		lfs.lfsconfig.length > 0 ||
		lfs.pointers.length > 0;
	if (lfs.detected) {
		const how = [
			lfs.attributes.length > 0 ? "filter=lfs attributes" : "",
			lfs.lfsconfig.length > 0 ? ".lfsconfig" : "",
			lfs.pointers.length > 0 ? "pointer files" : "",
		].filter(Boolean);
		findings.push({
			severity: "refuse",
			code: "lfs",
			ref: o.headRef,
			detail: `the repo uses LFS (${how.join(", ")}); autonomous runs are refused until LFS is supported`,
		});
	}
	return lfs;
}

/**
 * The text of a chunk of small blobs. One `cat-file --batch` call frames each
 * blob by its size; that is only sound for ASCII, because the runner decodes
 * stdout as utf-8. So every header and length is verified, and a chunk that
 * does not frame exactly is read blob by blob instead. A crafted blob that
 * looks like a header therefore cannot hide a pointer.
 */
async function readChunk(
	o: InspectOpts,
	chunk: TreeEntry[],
): Promise<[TreeEntry, string][]> {
	const framed = await tryBatch(o, chunk);
	if (framed) return framed;
	const out: [TreeEntry, string][] = [];
	for (const e of chunk) {
		const t = await readBlob(o, e.sha, POINTER_MAX);
		if (t !== undefined) out.push([e, t]);
	}
	return out;
}

async function tryBatch(
	o: InspectOpts,
	chunk: TreeEntry[],
): Promise<[TreeEntry, string][] | undefined> {
	const out = await gitRaw(
		o.host,
		o.repo,
		["cat-file", "--batch"],
		POINTER_CHUNK * (POINTER_MAX * 4 + 200),
		`${chunk.map((e) => e.sha).join("\n")}\n`,
	).catch(() => undefined);
	if (out === undefined) return undefined;
	const res: [TreeEntry, string][] = [];
	let pos = 0;
	for (const e of chunk) {
		const header = `${e.sha} blob ${e.size}\n`;
		if (!out.startsWith(header, pos)) return undefined;
		pos += header.length;
		const text = out.slice(pos, pos + (e.size as number));
		// Exact framing: the decoded text is as long as the blob, and a newline follows.
		if (
			text.length !== e.size ||
			Buffer.byteLength(text) !== e.size ||
			out[pos + text.length] !== "\n"
		) {
			return undefined;
		}
		pos += text.length + 1;
		res.push([e, text]);
	}
	if (pos !== out.length) return undefined;
	return res;
}

export async function inspectResult(o: InspectOpts): Promise<InspectReport> {
	if (!SHA_RE.test(o.baseSha)) {
		throw new HostGitError(
			"bad_argument",
			"baseSha must be a 40-hex commit id",
		);
	}
	const lim = { ...DEFAULT_INSPECT_LIMITS, ...o.limits };
	const findings: Finding[] = [];
	const have = await o.host.run(["cat-file", "-e", `${o.baseSha}^{commit}`], {
		cwd: o.repo,
		repo: o.repo,
	});
	if (have.exitCode !== 0) {
		findings.push({
			severity: "refuse",
			code: "base_missing",
			ref: o.headRef,
			detail: "the base commit is not in the fetched result",
		});
		return {
			findings,
			refused: true,
			lfs: {
				attributes: [],
				lfsconfig: [],
				pointers: [],
				pointerScanTruncated: false,
				detected: false,
			},
		};
	}
	for (const ref of [o.headRef, ...(o.wipRefs ?? [])]) {
		await checkRef(o, lim, ref, findings);
	}
	const lfs = await scanLfs(o, lim, findings);
	return {
		findings,
		lfs,
		refused: findings.some((f) => f.severity === "refuse"),
	};
}

export interface ResultValidatorOpts {
	/** The trusted base commit, read from the primary's `refs/mfw/base/<runId>`. */
	baseSha: string | ((runId: string) => string | Promise<string>);
	limits?: Partial<InspectLimits>;
	/** Receives every finding, refused or not, so a caller can raise ask-first cards for the flags. */
	onReport?: (report: InspectReport, ctx: FetchValidationContext) => void;
}

/** The validator `fetchRunResult` requires: throws a `validation` error on any `refuse` finding. */
export function resultValidator(
	v: ResultValidatorOpts,
): (ctx: FetchValidationContext) => Promise<void> {
	return async (ctx) => {
		const baseSha =
			typeof v.baseSha === "string" ? v.baseSha : await v.baseSha(ctx.runId);
		const report = await inspectResult({
			host: ctx.host,
			repo: ctx.bareRepo,
			baseSha,
			headRef: ctx.headRef,
			wipRefs: ctx.wipRefs,
			...(v.limits ? { limits: v.limits } : {}),
		});
		v.onReport?.(report, ctx);
		if (report.refused) {
			const refusals = report.findings.filter((f) => f.severity === "refuse");
			const lines = refusals
				.slice(0, 5)
				.map((f) => `${f.code}${f.path ? ` ${f.path}` : ""}: ${f.detail}`);
			if (refusals.length > 5) lines.push(`and ${refusals.length - 5} more`);
			throw new HostGitError(
				"validation",
				`the result was refused: ${lines.join("; ")}`,
			);
		}
	};
}
