/**
 * The in-sandbox WIP helper (backstage architecture.md, "Run workspace").
 *
 * A clone's work tree and gitdir are agent-writable, so the host never runs
 * git on them. To save uncommitted work it asks this helper, which runs
 * *inside* the sandbox with the sandbox's own `GIT_DIR`:
 *
 *  1. the host appends `{"type":"wip","id":"<id>"}` to `control.jsonl`;
 *  2. the helper commits the work tree (committed work, staged and unstaged
 *     edits, untracked files; ignored files stay out) to
 *     `refs/heads/mfw-wip/<runId>/<n>` without moving HEAD or the agent's
 *     index, then rewrites `outbox/result.bundle` (the run branch and every
 *     WIP ref, see `sandboxBundleArgv`);
 *  3. it answers with `outbox/wip-ack.json`;
 *  4. the host verifies and fetches the bundle (`CloneRunWorkspace.requestWip`).
 *
 * The ack is only a hint that the bundle is ready: it is written by the
 * sandbox, so nothing in it is trusted. The host re-derives every fact from
 * the verified bundle.
 *
 * The sandbox entry starts `watch` in the background and then execs the agent
 * (`wipSupervisorArgv`), so the agent keeps its pid, stdio and exit code. A
 * helper the agent kills costs only live snapshots: the host still recovers
 * the work from a fresh sandbox after the run.
 *
 * Run as `bun wip-helper.ts watch` (tail the control file) or
 * `bun wip-helper.ts snapshot` (one snapshot, no control file). Settings come
 * from `MFW_WIP_RUN_ID`, `MFW_WIP_OUTBOX` and `MFW_WIP_CONTROL`, plus the
 * `GIT_DIR` and `GIT_WORK_TREE` the sandbox sets.
 */
import {
	appendFileSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// This file is installed into the sandbox as one script (`wip-helper-install.ts`),
// so it imports node builtins only. A test holds these names equal to the
// refspecs in `host-git/fetch.ts`.
const ACK_FILE = "wip-ack.json";
const BUNDLE_FILE = "result.bundle";
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/** A git call past this is killed: an agent-configured filter can hang forever. */
const GIT_TIMEOUT_MS = 60_000;
/** Older snapshots are dropped, so the bundle's ref count stays under the host's cap. */
const MAX_WIP_REFS = 64;
/** A request this close before startup may still have a host waiting on it. */
const REQUEST_GRACE_MS = 5_000;

function assertRunId(runId: string): void {
	if (!RUN_ID_RE.test(runId)) throw new Error("bad run id");
}

/** `git` arguments that write the outbox bundle: the run branch and its WIP refs. */
export function bundleArgs(runId: string, outPath: string): string[] {
	assertRunId(runId);
	return [
		"bundle",
		"create",
		outPath,
		`refs/heads/mfw/${runId}`,
		`--glob=refs/heads/mfw-wip/${runId}/*`,
	];
}

/** What the host appends to `control.jsonl` to ask for a snapshot. */
export interface WipControl {
	type: "wip";
	id: string;
	/** When the host asked (ms). A restarted helper skips what predates it. */
	at?: number;
}

/** What the helper answers in `outbox/wip-ack.json`. Sandbox-reported: a hint, not a fact. */
export interface WipAck {
	id: string;
	ok: boolean;
	/** The snapshot number, when a new commit was made. */
	n?: number;
	/** The commit the snapshot ref (or the run branch, if nothing changed) points at. */
	sha?: string;
	error?: string;
}

export function wipAckFile(): string {
	return ACK_FILE;
}

export function wipBundleFile(): string {
	return BUNDLE_FILE;
}

/** Parse one `control.jsonl` line; null unless it is a well-formed WIP request. */
export function parseWipControl(line: string): WipControl | null {
	let v: unknown;
	try {
		v = JSON.parse(line);
	} catch {
		return null;
	}
	if (
		typeof v === "object" &&
		v !== null &&
		(v as { type?: unknown }).type === "wip" &&
		typeof (v as { id?: unknown }).id === "string" &&
		ID_RE.test((v as { id: string }).id)
	) {
		const at = (v as { at?: unknown }).at;
		return {
			type: "wip",
			id: (v as { id: string }).id,
			...(typeof at === "number" ? { at } : {}),
		};
	}
	return null;
}

export function wipControlLine(id: string, at = Date.now()): string {
	if (!ID_RE.test(id)) throw new Error(`bad wip request id: ${id}`);
	return `${JSON.stringify({ type: "wip", id, at } satisfies WipControl)}\n`;
}

export interface WipHelperEnv {
	runId: string;
	gitDir: string;
	workTree: string;
	outbox: string;
	gitBin?: string;
}

async function runGit(
	env: WipHelperEnv,
	args: string[],
	extraEnv: Record<string, string> = {},
	input?: string,
): Promise<{ code: number; out: string; err: string }> {
	const proc = Bun.spawn(
		[
			env.gitBin ?? "git",
			"-c",
			"core.hooksPath=/dev/null",
			"-c",
			"core.fsmonitor=false",
			"-c",
			"core.attributesFile=/dev/null",
			"-c",
			"user.name=mfw",
			"-c",
			"user.email=mfw@localhost",
			...args,
		],
		{
			cwd: env.workTree,
			env: {
				...process.env,
				GIT_DIR: env.gitDir,
				GIT_WORK_TREE: env.workTree,
				// A planted `commondir` file must not move git to another config.
				GIT_COMMON_DIR: env.gitDir,
				GIT_ATTR_NOSYSTEM: "1",
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_CONFIG_SYSTEM: "/dev/null",
				GIT_TERMINAL_PROMPT: "0",
				...extraEnv,
			},
			stdin: input === undefined ? "ignore" : new Blob([input]),
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const timer = setTimeout(() => proc.kill("SIGKILL"), GIT_TIMEOUT_MS);
	try {
		const [out, err, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { code, out: out.trim(), err: err.trim() };
	} finally {
		clearTimeout(timer);
	}
}

async function gitOk(
	env: WipHelperEnv,
	args: string[],
	extraEnv?: Record<string, string>,
): Promise<string> {
	const r = await runGit(env, args, extraEnv);
	if (r.code !== 0) {
		throw new Error(`git ${args[0]} failed (${r.code}): ${r.err || r.out}`);
	}
	return r.out;
}

/** The commit at `ref` when it already holds `tree` on top of `head`, else null. */
async function sameSnapshot(
	env: WipHelperEnv,
	ref: string,
	tree: string,
	head: string,
): Promise<string | null> {
	const r = await runGit(env, ["log", "-1", "--format=%H %T %P", ref]);
	if (r.code !== 0) return null;
	const [sha, haveTree, parent, extra] = r.out.split(" ");
	return haveTree === tree && parent === head && !extra ? (sha ?? null) : null;
}

/**
 * Commit the work tree to the next `mfw-wip/<runId>/<n>` ref and rewrite the
 * outbox bundle. Built in a temporary copy of the index, so the agent's own
 * index and HEAD never move. When nothing changed since HEAD, no ref is made
 * and the ack names HEAD; the bundle is still refreshed.
 */
export async function snapshotWip(
	env: WipHelperEnv,
	id: string,
): Promise<WipAck> {
	try {
		assertRunId(env.runId);
		const head = await gitOk(env, ["rev-parse", "--verify", "HEAD^{commit}"]);
		const tmp = mkdtempSync(join(tmpdir(), "mfw-wip-"));
		let sha = head;
		let n: number | undefined;
		try {
			const indexFile = join(tmp, "index");
			const real = await gitOk(env, [
				"rev-parse",
				"--path-format=absolute",
				"--git-path",
				"index",
			]);
			const idx = { GIT_INDEX_FILE: indexFile };
			if (existsSync(real)) {
				// Keep the agent's index (sparse bits included) as the starting point.
				writeFileSync(indexFile, readFileSync(real));
			} else {
				await gitOk(env, ["read-tree", "HEAD"], idx);
			}
			await gitOk(env, ["add", "-A"], idx);
			const tree = await gitOk(env, ["write-tree"], idx);
			if (tree !== (await gitOk(env, ["rev-parse", "HEAD^{tree}"]))) {
				const prefix = `refs/heads/mfw-wip/${env.runId}/`;
				const have = (
					await gitOk(env, ["for-each-ref", "--format=%(refname)", prefix])
				)
					.split("\n")
					.filter(Boolean)
					.map((r) => Number(r.slice(prefix.length)))
					.filter((x) => Number.isInteger(x));
				const newest = have.length > 0 ? Math.max(...have) : null;
				const same =
					newest === null
						? null
						: await sameSnapshot(env, `${prefix}${newest}`, tree, head);
				if (same && newest !== null) {
					n = newest;
					sha = same;
				} else {
					const commit = await gitOk(env, [
						"commit-tree",
						tree,
						"-p",
						head,
						"-m",
						`mfw wip: run ${env.runId}`,
					]);
					n = (newest ?? 0) + 1;
					// Create-only: a concurrent snapshot never overwrites another.
					await gitOk(env, ["update-ref", `${prefix}${n}`, commit, ""]);
					sha = commit;
					const sorted = have.sort((a, b) => a - b);
					for (const old of sorted.slice(
						0,
						Math.max(0, sorted.length + 1 - MAX_WIP_REFS),
					)) {
						await gitOk(env, ["update-ref", "-d", `${prefix}${old}`]);
					}
				}
			}
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
		const final = join(env.outbox, BUNDLE_FILE);
		const staging = `${final}.tmp`;
		rmSync(staging, { force: true });
		await gitOk(env, bundleArgs(env.runId, staging));
		renameSync(staging, final);
		return { id, ok: true, ...(n === undefined ? {} : { n }), sha };
	} catch (e) {
		return {
			id,
			ok: false,
			error: (e instanceof Error ? e.message : String(e)).slice(0, 500),
		};
	}
}

/** Write the ack atomically, so the host never reads half of it. */
export function writeAck(outbox: string, ack: WipAck): void {
	const final = join(outbox, ACK_FILE);
	const staging = `${final}.tmp`;
	writeFileSync(staging, JSON.stringify(ack), { mode: 0o600 });
	renameSync(staging, final);
}

/**
 * Tail `controlPath` and answer each WIP request, one at a time. A request
 * from well before this helper started is skipped: its host call has timed out
 * by now, and replaying the file would redo every old snapshot.
 */
export async function watchWip(
	env: WipHelperEnv,
	controlPath: string,
	opts: { pollMs?: number; signal?: AbortSignal; parentPid?: number } = {},
): Promise<void> {
	let offset = 0;
	let rest = "";
	const answered = new Set<string>();
	const oldest = Date.now() - REQUEST_GRACE_MS;
	while (!opts.signal?.aborted) {
		if (opts.parentPid !== undefined && process.ppid !== opts.parentPid) return;
		let text = "";
		try {
			text = readFileSync(controlPath, "utf8");
		} catch {}
		if (text.length < offset) {
			offset = 0;
			rest = "";
		}
		const lines = (rest + text.slice(offset)).split("\n");
		offset = text.length;
		rest = lines.pop() ?? "";
		for (const line of lines) {
			const req = parseWipControl(line);
			if (!req || answered.has(req.id)) continue;
			answered.add(req.id);
			if (req.at !== undefined && req.at < oldest) continue;
			const ack = await snapshotWip(env, req.id);
			try {
				writeAck(env.outbox, ack);
			} catch {
				// The agent can plant anything in the outbox. The host times out
				// on the missing ack; the agent keeps running.
			}
		}
		await Bun.sleep(opts.pollMs ?? 200);
	}
}

function envFromProcess(): WipHelperEnv {
	const need = (k: string): string => {
		const v = process.env[k];
		if (!v) throw new Error(`${k} is not set`);
		return v;
	};
	return {
		runId: need("MFW_WIP_RUN_ID"),
		gitDir: need("GIT_DIR"),
		workTree: need("GIT_WORK_TREE"),
		outbox: need("MFW_WIP_OUTBOX"),
	};
}

// Run as a command only when this file is the script bun was started with. A bundled server also reports
// `import.meta.main` as true for its own entry, which must never run the helper (it exits when its env is unset).
if (import.meta.main && /wip-helper\.[cm]?[jt]s$/.test(process.argv[1] ?? "")) {
	const cmd = process.argv[2];
	const env = envFromProcess();
	if (cmd === "snapshot") {
		const ack = await snapshotWip(env, process.argv[3] ?? "manual");
		try {
			writeAck(env.outbox, ack);
		} catch {
			// The exit code still reports the outcome.
		}
		appendFileSync(process.stdout.fd, `${JSON.stringify(ack)}\n`);
		process.exit(ack.ok ? 0 : 1);
	} else if (cmd === "watch") {
		const control = process.env.MFW_WIP_CONTROL;
		if (!control) throw new Error("MFW_WIP_CONTROL is not set");
		// The parent is the agent (the entry shell exec'd it): stop when it does.
		await watchWip(env, control, { parentPid: process.ppid });
		process.exit(0);
	} else {
		process.stderr.write("usage: wip-helper.ts snapshot [id] | watch\n");
		process.exit(2);
	}
}
