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
import { assertRunId, sandboxBundleArgv } from "../host-git/fetch.ts";

const ACK_FILE = "wip-ack.json";
const BUNDLE_FILE = "result.bundle";
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** What the host appends to `control.jsonl` to ask for a snapshot. */
export interface WipControl {
	type: "wip";
	id: string;
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
		return { type: "wip", id: (v as { id: string }).id };
	}
	return null;
}

export function wipControlLine(id: string): string {
	if (!ID_RE.test(id)) throw new Error(`bad wip request id: ${id}`);
	return `${JSON.stringify({ type: "wip", id } satisfies WipControl)}\n`;
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
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, out: out.trim(), err: err.trim() };
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
				const commit = await gitOk(env, [
					"commit-tree",
					tree,
					"-p",
					head,
					"-m",
					`mfw wip: run ${env.runId}`,
				]);
				const prefix = `refs/heads/mfw-wip/${env.runId}/`;
				const have = (
					await gitOk(env, ["for-each-ref", "--format=%(refname)", prefix])
				)
					.split("\n")
					.filter(Boolean)
					.map((r) => Number(r.slice(prefix.length)))
					.filter((x) => Number.isInteger(x));
				n = Math.max(0, ...have) + 1;
				// Create-only: a concurrent snapshot never overwrites another.
				await gitOk(env, ["update-ref", `${prefix}${n}`, commit, ""]);
				sha = commit;
			}
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
		const final = join(env.outbox, BUNDLE_FILE);
		const staging = `${final}.tmp`;
		rmSync(staging, { force: true });
		const [, ...bundleArgs] = sandboxBundleArgv(env.runId, staging);
		await gitOk(env, bundleArgs);
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
 * Tail `controlPath` and answer each WIP request, one at a time. Requests
 * already in the file when the helper starts are answered too: a request is
 * never lost to a restart, and the host matches acks by id.
 */
export async function watchWip(
	env: WipHelperEnv,
	controlPath: string,
	opts: { pollMs?: number; signal?: AbortSignal } = {},
): Promise<void> {
	let offset = 0;
	let rest = "";
	const answered = new Set<string>();
	while (!opts.signal?.aborted) {
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
			writeAck(env.outbox, await snapshotWip(env, req.id));
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

if (import.meta.main) {
	const env = envFromProcess();
	const cmd = process.argv[2];
	if (cmd === "snapshot") {
		const ack = await snapshotWip(env, process.argv[3] ?? "manual");
		appendFileSync(process.stdout.fd, `${JSON.stringify(ack)}\n`);
		process.exit(ack.ok ? 0 : 1);
	} else if (cmd === "watch") {
		const control = process.env.MFW_WIP_CONTROL;
		if (!control) throw new Error("MFW_WIP_CONTROL is not set");
		await watchWip(env, control);
	} else {
		process.stderr.write("usage: wip-helper.ts snapshot [id] | watch\n");
		process.exit(2);
	}
}
