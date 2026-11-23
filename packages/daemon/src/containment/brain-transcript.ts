/**
 * What of a brain turn survives to the next one: its transcript, and nothing
 * else (design "Role profiles", review P7 M4).
 *
 * Each turn gets a private copy. When it ends, the host copies the newest
 * transcript into a store the sandbox never mounts and records its hash. The
 * next turn gets that file back only if the hash still matches. If it does not,
 * nothing is restored, `--resume` fails, and the runtime starts a fresh
 * generation from its durable rows.
 *
 * A turn can still write its own transcript while it runs, and the next
 * `--resume` loads that. It is inherent in resuming, and the host's taint ledger
 * and per-action rights checks do not depend on the transcript.
 */

import { createHash } from "node:crypto";
import {
	chmod,
	lstat,
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { builtinHarnessRegistry } from "@mfw/plugin-api/harness-registry";
import type { FleetCli } from "./agent-profile.ts";
import { readRegularFile } from "./safe-file.ts";

function transcriptDir(cli: FleetCli): string {
	const dir = builtinHarnessRegistry().byFleetCli(cli).fleet.transcriptDir;
	if (!dir) throw new Error(`the ${cli} manifest names no transcript dir`);
	return dir;
}

/** The one directory of each CLI that holds resumable sessions. */
export const BRAIN_TRANSCRIPT_DIR: Readonly<Record<FleetCli, string>> = {
	claude: transcriptDir("claude"),
	codex: transcriptDir("codex"),
};

const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const MAX_WALK_ENTRIES = 10_000;
const MAX_WALK_DEPTH = 6;
const TRANSCRIPT = "transcript.jsonl";
const META = "meta.json";

const sha256 = (data: Uint8Array) =>
	createHash("sha256").update(data).digest("hex");

const brainStateRoot = (mfwHome: string, session: string) => {
	if (!/^[A-Za-z0-9_-]{1,128}$/.test(session)) {
		throw new Error(`invalid brain session id ${session}`);
	}
	return join(mfwHome, "agents-state", "brain", session);
};

/** Host-only: no sandbox ever binds this directory. */
export function brainTranscriptStore(
	mfwHome: string,
	session: string,
	cli: FleetCli,
): string {
	return join(brainStateRoot(mfwHome, session), cli);
}

/** The newest real `.jsonl` under `root`. Links are neither read nor walked. */
async function newestTranscript(
	root: string,
): Promise<{ rel: string; mtimeMs: number } | null> {
	let best: { rel: string; mtimeMs: number } | null = null;
	let seen = 0;
	const pending: { dir: string; rel: string; depth: number }[] = [
		{ dir: root, rel: "", depth: 0 },
	];
	while (pending.length > 0) {
		const { dir, rel, depth } = pending.pop() as (typeof pending)[number];
		const names = await readdir(dir).catch(() => [] as string[]);
		for (const name of names) {
			if (++seen > MAX_WALK_ENTRIES) return best;
			const path = join(dir, name);
			const childRel = rel ? `${rel}/${name}` : name;
			const st = await lstat(path).catch(() => null);
			if (!st) continue;
			if (st.isDirectory() && depth < MAX_WALK_DEPTH) {
				pending.push({ dir: path, rel: childRel, depth: depth + 1 });
			} else if (
				st.isFile() &&
				name.endsWith(".jsonl") &&
				(!best || st.mtimeMs > best.mtimeMs)
			) {
				best = { rel: childRel, mtimeMs: st.mtimeMs };
			}
		}
	}
	return best;
}

/**
 * Keep the turn's transcript. Call only after its sandbox has exited. False
 * when there was none to keep, and an earlier one then stays as it was.
 */
export async function commitBrainTranscript(
	turnState: string,
	store: string,
	cli: FleetCli,
): Promise<boolean> {
	const dir = BRAIN_TRANSCRIPT_DIR[cli];
	const found = await newestTranscript(join(turnState, dir));
	if (!found) return false;
	const read = await readRegularFile(
		join(turnState, dir, found.rel),
		MAX_TRANSCRIPT_BYTES,
	);
	if (!read || read.size > MAX_TRANSCRIPT_BYTES) return false;
	await mkdir(store, { recursive: true, mode: 0o700 });
	await chmod(store, 0o700);
	const tmp = join(store, `${TRANSCRIPT}.tmp`);
	await writeFile(tmp, read.buffer, { mode: 0o600 });
	await rename(tmp, join(store, TRANSCRIPT));
	const meta = join(store, `${META}.tmp`);
	await writeFile(
		meta,
		JSON.stringify({
			version: 1,
			rel: `${dir}/${found.rel}`,
			sha256: sha256(read.buffer),
		}),
		{ mode: 0o600 },
	);
	await rename(meta, join(store, META));
	return true;
}

function safeRel(rel: unknown): rel is string {
	if (typeof rel !== "string" || rel.startsWith("/")) return false;
	const clean = normalize(rel);
	const root = clean.split("/")[0];
	return (
		clean === rel &&
		!clean.split("/").includes("..") &&
		clean.endsWith(".jsonl") &&
		Object.values(BRAIN_TRANSCRIPT_DIR).includes(root as string)
	);
}

/** Put the stored transcript into a new turn's private state. */
export async function restoreBrainTranscript(
	store: string,
	turnState: string,
): Promise<"none" | "restored" | "tampered"> {
	const rawMeta = await readRegularFile(join(store, META), 4096);
	const bytes = await readFile(join(store, TRANSCRIPT)).catch(() => null);
	if (!rawMeta && !bytes) return "none";
	if (!rawMeta || !bytes) return "tampered";
	let meta: { rel?: unknown; sha256?: unknown };
	try {
		meta = JSON.parse(rawMeta.buffer.toString("utf8"));
	} catch {
		return "tampered";
	}
	if (!safeRel(meta.rel) || meta.sha256 !== sha256(bytes)) return "tampered";
	const dest = join(turnState, meta.rel);
	await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
	await writeFile(dest, bytes, { mode: 0o600 });
	return "restored";
}

/** A session retired or rolled over: nothing of it is resumed again. */
export async function removeBrainTranscripts(
	mfwHome: string,
	session: string,
): Promise<void> {
	await rm(brainStateRoot(mfwHome, session), { recursive: true, force: true });
}
