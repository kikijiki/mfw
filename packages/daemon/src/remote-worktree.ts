import { createHash } from "node:crypto";
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	readlink,
	rename,
	rm,
	symlink,
} from "node:fs/promises";
import {
	dirname,
	isAbsolute,
	join,
	normalize,
	relative,
	resolve,
	sep,
} from "node:path";
import { writeFileAtomic } from "@mfw/core/fsatomic";
import { z } from "zod";
import { ExecutionEnvironmentBuilder } from "./execution-environment.ts";
import { git } from "./git.ts";
import { runProc } from "./proc.ts";

const DEFAULT_MAX_TRANSFER_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 16 * 1024 * 1024;
const FORMAT_VERSION = 1 as const;

const EntrySchema = z.object({
	path: z.string().min(1),
	type: z.enum(["file", "symlink"]),
	mode: z.union([z.literal(0o644), z.literal(0o755), z.literal(0o777)]),
	size: z.number().int().nonnegative(),
	sha256: z.string().regex(/^[a-f0-9]{64}$/),
	content: z.string(),
	source: z.enum(["tracked", "untracked", "required"]),
});

const BundleSchema = z.object({
	version: z.literal(FORMAT_VERSION),
	kind: z.enum(["stage", "collection"]),
	branch: z.string().min(1),
	baseSha: z.string().regex(/^[a-f0-9]{40,64}$/),
	stageDigest: z
		.string()
		.regex(/^[a-f0-9]{64}$/)
		.nullable(),
	baseline: z.array(EntrySchema),
	snapshot: z.array(EntrySchema),
	digest: z.string().regex(/^[a-f0-9]{64}$/),
});

export type RemoteWorkspaceEntry = z.infer<typeof EntrySchema>;
export type RemoteWorkspaceBundle = z.infer<typeof BundleSchema>;

export interface RemoteWorkspaceLimits {
	maxTransferBytes?: number;
	maxFileBytes?: number;
}

export interface CreateRemoteStageOptions extends RemoteWorkspaceLimits {
	canonicalPath: string;
	runDir: string;
	branch: string;
	baseSha: string;
}

export interface MaterializeRemoteStageOptions extends RemoteWorkspaceLimits {
	stagePath: string;
	executionPath: string;
	/** Explicit image tool path; defaults to the conventional Linux location. */
	gitPath?: string;
	setup?: {
		argv: readonly string[];
		environment?: Readonly<Record<string, string>>;
		timeoutMs?: number;
	};
}

export interface CreateRemoteCollectionOptions extends RemoteWorkspaceLimits {
	executionPath: string;
	runDir: string;
	stagePath: string;
	/** Ignored files required by the driver, most notably MFW_REPORT.json. */
	requiredPaths?: readonly string[];
}

export interface ApplyRemoteCollectionOptions extends RemoteWorkspaceLimits {
	canonicalPath: string;
	runDir: string;
	stagePath: string;
	collectionPath: string;
}

export interface CollectionApplyResult {
	changed: string[];
	unchanged: string[];
	evidencePath: string;
	receiptPath: string;
}

export class RemoteWorkspaceError extends Error {
	constructor(
		readonly code:
			| "invalid_path"
			| "unsafe_entry"
			| "size_limit"
			| "hash_mismatch"
			| "not_fresh"
			| "setup_failed"
			| "stage_mismatch",
		message: string,
	) {
		super(message);
		this.name = "RemoteWorkspaceError";
	}
}

export class RemoteCollectionConflictError extends Error {
	constructor(
		readonly paths: string[],
		readonly evidencePath: string,
	) {
		super(
			`remote collection conflicts with local review state: ${paths.join(", ")}`,
		);
		this.name = "RemoteCollectionConflictError";
	}
}

export class RemoteCollectionPartialError extends Error {
	constructor(
		readonly appliedPaths: string[],
		readonly evidencePath: string,
	) {
		super(
			`remote collection was interrupted after ${appliedPaths.length} path(s); evidence was preserved`,
		);
		this.name = "RemoteCollectionPartialError";
	}
}

function sha256(bytes: Uint8Array | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function canonicalBundleInput(
	bundle: Omit<RemoteWorkspaceBundle, "digest">,
): string {
	return JSON.stringify(bundle);
}

function withDigest(
	bundle: Omit<RemoteWorkspaceBundle, "digest">,
): RemoteWorkspaceBundle {
	return { ...bundle, digest: sha256(canonicalBundleInput(bundle)) };
}

function checkedLimit(value: number | undefined, fallback: number): number {
	const resolved = value ?? fallback;
	if (!Number.isSafeInteger(resolved) || resolved <= 0) {
		throw new RangeError(
			"remote workspace limits must be positive safe integers",
		);
	}
	return resolved;
}

function safeRelativePath(path: string): string {
	if (
		!path ||
		path.includes("\0") ||
		isAbsolute(path) ||
		path.includes("\\") ||
		normalize(path) !== path ||
		path === "." ||
		path.split("/").some((part) => part === "" || part === "..")
	) {
		throw new RemoteWorkspaceError(
			"invalid_path",
			"workspace payload contains an invalid relative path",
		);
	}
	return path;
}

/** Board and daemon state stay excluded; delivered rules and trigger code stay visible. */
export function isRemoteWorkspacePathAllowed(path: string): boolean {
	let safe: string;
	try {
		safe = safeRelativePath(path);
	} catch {
		return false;
	}
	if (safe === ".git" || safe.startsWith(".git/")) return false;
	if (safe === ".mfw/AGENTS.md") return true;
	if (safe === ".mfw/triggers" || safe.startsWith(".mfw/triggers/")) {
		return true;
	}
	return safe !== ".mfw" && !safe.startsWith(".mfw/");
}

function assertInside(root: string, path: string): void {
	const rel = relative(root, path);
	if (
		rel === "" ||
		(!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
	) {
		return;
	}
	throw new RemoteWorkspaceError(
		"unsafe_entry",
		"workspace entry escapes its execution root",
	);
}

function isMissingPath(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "ENOENT"
	);
}

function assertSafeSymlink(path: string, target: string): void {
	if (target.includes("\0") || isAbsolute(target)) {
		throw new RemoteWorkspaceError(
			"unsafe_entry",
			`workspace symlink '${path}' has an unsafe target`,
		);
	}
	const resolved = normalize(join(dirname(path), target));
	if (
		resolved === ".." ||
		resolved.startsWith(`..${sep}`) ||
		isAbsolute(resolved)
	) {
		throw new RemoteWorkspaceError(
			"unsafe_entry",
			`workspace symlink '${path}' escapes the worktree`,
		);
	}
}

async function assertNoSymlinkParents(
	root: string,
	path: string,
): Promise<void> {
	const parts = path.split("/").slice(0, -1);
	let current = root;
	for (const part of parts) {
		current = join(current, part);
		try {
			if ((await lstat(current)).isSymbolicLink()) {
				throw new RemoteWorkspaceError(
					"unsafe_entry",
					`workspace entry '${path}' traverses a symlinked directory`,
				);
			}
		} catch (error) {
			if (error instanceof RemoteWorkspaceError) throw error;
			if (isMissingPath(error)) return;
			throw new RemoteWorkspaceError(
				"unsafe_entry",
				`workspace entry '${path}' has an unreadable parent`,
			);
		}
	}
}

function decoded(
	entry: RemoteWorkspaceEntry,
	maxFileBytes: number,
): Uint8Array {
	const bytes = Uint8Array.from(Buffer.from(entry.content, "base64"));
	if (bytes.byteLength !== entry.size || bytes.byteLength > maxFileBytes) {
		throw new RemoteWorkspaceError(
			"size_limit",
			`workspace entry '${entry.path}' violates its declared size`,
		);
	}
	if (sha256(bytes) !== entry.sha256) {
		throw new RemoteWorkspaceError(
			"hash_mismatch",
			`workspace entry '${entry.path}' failed hash verification`,
		);
	}
	return bytes;
}

function entryIdentity(entry: RemoteWorkspaceEntry | undefined): string | null {
	return entry
		? `${entry.type}:${entry.mode}:${entry.size}:${entry.sha256}`
		: null;
}

function indexEntries(
	entries: readonly RemoteWorkspaceEntry[],
): Map<string, RemoteWorkspaceEntry> {
	const index = new Map<string, RemoteWorkspaceEntry>();
	for (const entry of entries) {
		if (!isRemoteWorkspacePathAllowed(entry.path) || index.has(entry.path)) {
			throw new RemoteWorkspaceError(
				"unsafe_entry",
				"workspace payload contains a protected or duplicate path",
			);
		}
		index.set(entry.path, entry);
	}
	return index;
}

async function readEntry(
	root: string,
	path: string,
	source: RemoteWorkspaceEntry["source"],
	maxFileBytes: number,
): Promise<RemoteWorkspaceEntry | null> {
	if (!isRemoteWorkspacePathAllowed(path)) return null;
	const absolute = resolve(root, path);
	assertInside(root, absolute);
	await assertNoSymlinkParents(root, path);
	let info: Awaited<ReturnType<typeof lstat>>;
	try {
		info = await lstat(absolute);
	} catch (error) {
		if (isMissingPath(error)) return null;
		throw new RemoteWorkspaceError(
			"unsafe_entry",
			`workspace entry '${path}' cannot be inspected safely`,
		);
	}
	let bytes: Uint8Array;
	let type: RemoteWorkspaceEntry["type"];
	let mode: RemoteWorkspaceEntry["mode"];
	if (info.isSymbolicLink()) {
		const target = await readlink(absolute);
		assertSafeSymlink(path, target);
		bytes = new TextEncoder().encode(target);
		type = "symlink";
		mode = 0o777;
	} else if (info.isFile()) {
		if (info.size > maxFileBytes) {
			throw new RemoteWorkspaceError(
				"size_limit",
				`workspace entry '${path}' exceeds the per-file limit`,
			);
		}
		bytes = await readFile(absolute);
		type = "file";
		mode = (info.mode & 0o111) !== 0 ? 0o755 : 0o644;
	} else {
		throw new RemoteWorkspaceError(
			"unsafe_entry",
			`workspace entry '${path}' is not a regular file or symlink`,
		);
	}
	if (bytes.byteLength > maxFileBytes) {
		throw new RemoteWorkspaceError(
			"size_limit",
			`workspace entry '${path}' exceeds the per-file limit`,
		);
	}
	return {
		path,
		type,
		mode,
		size: bytes.byteLength,
		sha256: sha256(bytes),
		content: Buffer.from(bytes).toString("base64"),
		source,
	};
}

async function baseEntries(
	root: string,
	baseSha: string,
	maxFileBytes: number,
): Promise<RemoteWorkspaceEntry[]> {
	const parent = await mkdtemp(join(dirname(root), ".mfw-stage-base-"));
	const worktree = join(parent, "worktree");
	const added = await git(
		["worktree", "add", "--detach", worktree, baseSha],
		root,
	);
	if (added.exitCode !== 0) {
		await rm(parent, { recursive: true, force: true });
		throw new RemoteWorkspaceError(
			"stage_mismatch",
			"could not materialize the recorded base commit",
		);
	}
	try {
		const paths = await gitRaw(["ls-files", "--cached", "-z"], worktree);
		const entries: RemoteWorkspaceEntry[] = [];
		for (const path of paths.split("\0").filter(Boolean).sort()) {
			const entry = await readEntry(worktree, path, "tracked", maxFileBytes);
			if (entry) entries.push(entry);
		}
		return entries;
	} finally {
		await git(["worktree", "remove", "--force", worktree], root);
		await rm(parent, { recursive: true, force: true });
	}
}

async function gitRaw(args: string[], cwd: string): Promise<string> {
	const result = await runProc(["git", ...args], { cwd, timeoutMs: 60_000 });
	if (result.exitCode !== 0) {
		throw new RemoteWorkspaceError(
			"stage_mismatch",
			"could not enumerate workspace content",
		);
	}
	return result.stdout;
}

async function listedSnapshot(
	root: string,
	maxFileBytes: number,
	requiredPaths: readonly string[] = [],
): Promise<RemoteWorkspaceEntry[]> {
	const tracked = await gitRaw(
		["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
		root,
	);
	const trackedSet = new Set(
		(await gitRaw(["ls-files", "--cached", "-z"], root))
			.split("\0")
			.filter(Boolean),
	);
	const paths = new Map<string, RemoteWorkspaceEntry["source"]>();
	for (const path of tracked.split("\0").filter(Boolean)) {
		paths.set(path, trackedSet.has(path) ? "tracked" : "untracked");
	}
	for (const path of requiredPaths) {
		safeRelativePath(path);
		if (!isRemoteWorkspacePathAllowed(path)) {
			throw new RemoteWorkspaceError(
				"invalid_path",
				`required collection path '${path}' is protected`,
			);
		}
		paths.set(path, paths.get(path) ?? "required");
	}
	const entries: RemoteWorkspaceEntry[] = [];
	for (const [path, source] of [...paths].sort(([left], [right]) =>
		left.localeCompare(right),
	)) {
		const entry = await readEntry(root, path, source, maxFileBytes);
		if (entry) entries.push(entry);
	}
	return entries;
}

function validateBundle(
	raw: string,
	limits: RemoteWorkspaceLimits = {},
): RemoteWorkspaceBundle {
	const maxTransferBytes = checkedLimit(
		limits.maxTransferBytes,
		DEFAULT_MAX_TRANSFER_BYTES,
	);
	if (Buffer.byteLength(raw) > maxTransferBytes) {
		throw new RemoteWorkspaceError(
			"size_limit",
			"remote workspace payload exceeds the transfer limit",
		);
	}
	let bundle: RemoteWorkspaceBundle;
	try {
		bundle = BundleSchema.parse(JSON.parse(raw));
	} catch (error) {
		throw new RemoteWorkspaceError(
			"hash_mismatch",
			`remote workspace payload is malformed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const { digest, ...unsigned } = bundle;
	if (sha256(canonicalBundleInput(unsigned)) !== digest) {
		throw new RemoteWorkspaceError(
			"hash_mismatch",
			"remote workspace manifest digest does not match",
		);
	}
	const maxFileBytes = checkedLimit(
		limits.maxFileBytes,
		DEFAULT_MAX_FILE_BYTES,
	);
	let decodedBytes = 0;
	for (const entry of [...bundle.baseline, ...bundle.snapshot]) {
		safeRelativePath(entry.path);
		decodedBytes += decoded(entry, maxFileBytes).byteLength;
		if (decodedBytes > maxTransferBytes) {
			throw new RemoteWorkspaceError(
				"size_limit",
				"remote workspace decoded content exceeds the transfer limit",
			);
		}
	}
	indexEntries(bundle.baseline);
	indexEntries(bundle.snapshot);
	return bundle;
}

async function writeBundle(
	path: string,
	bundle: RemoteWorkspaceBundle,
	limits: RemoteWorkspaceLimits,
): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const raw = `${JSON.stringify(bundle)}\n`;
	validateBundle(raw, limits);
	await writeFileAtomic(path, raw, { mode: 0o600 });
}

async function loadBundle(
	path: string,
	limits: RemoteWorkspaceLimits = {},
): Promise<RemoteWorkspaceBundle> {
	return validateBundle(await readFile(path, "utf8"), limits);
}

/** Capture the canonical worktree without ignored files or protected .mfw state. */
export async function createRemoteStage(
	opts: CreateRemoteStageOptions,
): Promise<{ stagePath: string; digest: string }> {
	const maxFileBytes = checkedLimit(opts.maxFileBytes, DEFAULT_MAX_FILE_BYTES);
	const [baseline, snapshot] = await Promise.all([
		baseEntries(opts.canonicalPath, opts.baseSha, maxFileBytes),
		listedSnapshot(opts.canonicalPath, maxFileBytes),
	]);
	const bundle = withDigest({
		version: FORMAT_VERSION,
		kind: "stage",
		branch: opts.branch,
		baseSha: opts.baseSha,
		stageDigest: null,
		baseline,
		snapshot,
	});
	const stagePath = join(opts.runDir, "remote-worktree", "stage.json");
	await writeBundle(stagePath, bundle, opts);
	return { stagePath, digest: bundle.digest };
}

async function ensureFresh(path: string): Promise<void> {
	try {
		const info = await lstat(path);
		if (!info.isDirectory() || info.isSymbolicLink()) {
			throw new RemoteWorkspaceError(
				"not_fresh",
				"remote execution mirror is not a real directory",
			);
		}
		const entries = await readdir(path);
		if (entries.length > 0) {
			throw new RemoteWorkspaceError(
				"not_fresh",
				"remote execution mirror is not empty",
			);
		}
	} catch (error) {
		if (error instanceof RemoteWorkspaceError) throw error;
		if (!isMissingPath(error)) {
			throw new RemoteWorkspaceError(
				"not_fresh",
				"remote execution mirror cannot be inspected safely",
			);
		}
		await mkdir(path, { recursive: true, mode: 0o700 });
	}
}

async function materializeEntries(
	root: string,
	entries: readonly RemoteWorkspaceEntry[],
	maxFileBytes: number,
): Promise<void> {
	const regular = entries.filter((entry) => entry.type === "file");
	const links = entries.filter((entry) => entry.type === "symlink");
	for (const entry of [...regular, ...links]) {
		const destination = resolve(root, entry.path);
		assertInside(root, destination);
		await assertNoSymlinkParents(root, entry.path);
		await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
		const bytes = decoded(entry, maxFileBytes);
		if (entry.type === "file") {
			await writeFileAtomic(destination, bytes, { mode: entry.mode });
			await chmod(destination, entry.mode);
		} else {
			const target = new TextDecoder().decode(bytes);
			assertSafeSymlink(entry.path, target);
			await symlink(target, destination);
		}
	}
}

/** Materialize a genuinely empty mirror and create a clean synthetic Git root. */
export async function materializeRemoteStage(
	opts: MaterializeRemoteStageOptions,
): Promise<void> {
	const bundle = await loadBundle(opts.stagePath, opts);
	if (bundle.kind !== "stage") {
		throw new RemoteWorkspaceError("stage_mismatch", "payload is not a stage");
	}
	await ensureFresh(opts.executionPath);
	await materializeEntries(
		opts.executionPath,
		bundle.snapshot,
		checkedLimit(opts.maxFileBytes, DEFAULT_MAX_FILE_BYTES),
	);
	const environment = new ExecutionEnvironmentBuilder().build();
	const gitPath = opts.gitPath ?? "/usr/bin/git";
	if (!isAbsolute(gitPath)) {
		throw new RemoteWorkspaceError(
			"setup_failed",
			"remote Git tool path must be absolute",
		);
	}
	const commands: string[][] = [
		[gitPath, "init", "-b", bundle.branch],
		[gitPath, "config", "user.name", "mfw remote mirror"],
		[gitPath, "config", "user.email", "mfw@invalid"],
		[gitPath, "add", "-A"],
		[gitPath, "commit", "--allow-empty", "-m", `mfw staged ${bundle.baseSha}`],
	];
	for (const argv of commands) {
		const result = await runProc(argv, {
			cwd: opts.executionPath,
			env: environment,
			timeoutMs: 60_000,
		});
		if (result.exitCode !== 0) {
			throw new RemoteWorkspaceError(
				"setup_failed",
				"could not initialize remote execution mirror",
			);
		}
	}
	await mkdir(join(opts.executionPath, ".git", "mfw"), { recursive: true });
	await writeFileAtomic(
		join(opts.executionPath, ".git", "mfw", "stage.json"),
		`${JSON.stringify({
			baseSha: bundle.baseSha,
			branch: bundle.branch,
			digest: bundle.digest,
		})}\n`,
	);
	if (opts.setup) {
		if (opts.setup.argv.length === 0) {
			throw new RemoteWorkspaceError(
				"setup_failed",
				"configured worktree setup argv is empty",
			);
		}
		const setupEnvironment = new ExecutionEnvironmentBuilder(
			opts.setup.environment,
		).build();
		await mkdir(setupEnvironment.HOME as string, {
			recursive: true,
			mode: 0o700,
		});
		const result = await runProc([...opts.setup.argv], {
			cwd: opts.executionPath,
			env: setupEnvironment,
			timeoutMs: opts.setup.timeoutMs ?? 10 * 60_000,
		});
		if (result.exitCode !== 0 || result.timedOut) {
			throw new RemoteWorkspaceError(
				"setup_failed",
				result.timedOut
					? "configured worktree setup exceeded its deadline"
					: `configured worktree setup exited with code ${result.exitCode}`,
			);
		}
	}
}

/** Produce review evidence before touching the canonical merge candidate. */
export async function createRemoteCollection(
	opts: CreateRemoteCollectionOptions,
): Promise<{ collectionPath: string; digest: string }> {
	const stage = await loadBundle(opts.stagePath, opts);
	if (stage.kind !== "stage") {
		throw new RemoteWorkspaceError("stage_mismatch", "payload is not a stage");
	}
	const maxFileBytes = checkedLimit(opts.maxFileBytes, DEFAULT_MAX_FILE_BYTES);
	const snapshot = await listedSnapshot(
		opts.executionPath,
		maxFileBytes,
		opts.requiredPaths ?? ["MFW_REPORT.json"],
	);
	const bundle = withDigest({
		version: FORMAT_VERSION,
		kind: "collection",
		branch: stage.branch,
		baseSha: stage.baseSha,
		stageDigest: stage.digest,
		baseline: stage.snapshot,
		snapshot,
	});
	const collectionDir = join(opts.runDir, "remote-worktree", "collections");
	const collectionPath = join(collectionDir, `${bundle.digest}.json`);
	await writeBundle(collectionPath, bundle, opts);
	return { collectionPath, digest: bundle.digest };
}

async function currentEntryForPath(
	root: string,
	path: string,
	maxFileBytes: number,
): Promise<RemoteWorkspaceEntry | null> {
	return readEntry(root, path, "required", maxFileBytes);
}

async function replaceEntry(
	root: string,
	entry: RemoteWorkspaceEntry,
	maxFileBytes: number,
): Promise<void> {
	const destination = resolve(root, entry.path);
	assertInside(root, destination);
	await assertNoSymlinkParents(root, entry.path);
	await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
	const bytes = decoded(entry, maxFileBytes);
	if (entry.type === "file") {
		await rm(destination, { recursive: true, force: true });
		await writeFileAtomic(destination, bytes, { mode: entry.mode });
		await chmod(destination, entry.mode);
		return;
	}
	const target = new TextDecoder().decode(bytes);
	assertSafeSymlink(entry.path, target);
	const tempDir = await mkdtemp(join(dirname(destination), ".mfw-link-"));
	const temporary = join(tempDir, "link");
	try {
		await symlink(target, temporary);
		await rm(destination, { recursive: true, force: true });
		await rename(temporary, destination);
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
}

/**
 * Three-way application against the staged snapshot. A retry sees local equal
 * to remote and is a no-op; independent local+remote edits conflict before any
 * write. The downloaded collection remains as review evidence on every path.
 */
export async function applyRemoteCollection(
	opts: ApplyRemoteCollectionOptions,
): Promise<CollectionApplyResult> {
	const [stage, collection] = await Promise.all([
		loadBundle(opts.stagePath, opts),
		loadBundle(opts.collectionPath, opts),
	]);
	if (
		stage.kind !== "stage" ||
		collection.kind !== "collection" ||
		collection.stageDigest !== stage.digest ||
		collection.baseSha !== stage.baseSha ||
		collection.branch !== stage.branch
	) {
		throw new RemoteWorkspaceError(
			"stage_mismatch",
			"collection does not belong to the recorded stage",
		);
	}
	const maxFileBytes = checkedLimit(opts.maxFileBytes, DEFAULT_MAX_FILE_BYTES);
	const baseline = indexEntries(collection.baseline);
	const remote = indexEntries(collection.snapshot);
	const paths = [...new Set([...baseline.keys(), ...remote.keys()])].sort();
	const local = new Map<string, RemoteWorkspaceEntry | null>();
	for (const path of paths) {
		local.set(
			path,
			await currentEntryForPath(opts.canonicalPath, path, maxFileBytes),
		);
	}
	const conflicts: string[] = [];
	const changes: string[] = [];
	const unchanged: string[] = [];
	for (const path of paths) {
		const before = entryIdentity(baseline.get(path));
		const desired = entryIdentity(remote.get(path));
		const current = entryIdentity(local.get(path) ?? undefined);
		if (desired === current || desired === before) {
			unchanged.push(path);
			continue;
		}
		if (current === before) changes.push(path);
		else conflicts.push(path);
	}
	if (conflicts.length > 0) {
		throw new RemoteCollectionConflictError(conflicts, opts.collectionPath);
	}
	const applied: string[] = [];
	try {
		for (const path of changes) {
			const desired = remote.get(path);
			if (desired)
				await replaceEntry(opts.canonicalPath, desired, maxFileBytes);
			else {
				await assertNoSymlinkParents(opts.canonicalPath, path);
				await rm(resolve(opts.canonicalPath, path), {
					recursive: true,
					force: true,
				});
			}
			applied.push(path);
		}
	} catch {
		throw new RemoteCollectionPartialError(applied, opts.collectionPath);
	}
	const receiptPath = join(
		opts.runDir,
		"remote-worktree",
		"collection-receipt.json",
	);
	await writeFileAtomic(
		receiptPath,
		`${JSON.stringify({
			stageDigest: stage.digest,
			collectionDigest: collection.digest,
			changed: changes,
			unchanged,
		})}\n`,
		{ mode: 0o600 },
	);
	return {
		changed: changes,
		unchanged,
		evidencePath: opts.collectionPath,
		receiptPath,
	};
}
