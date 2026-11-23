import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { ProjectDbHandle } from "@mfw/db/client";
import { type brainActions, engineKv, mergeJobs } from "@mfw/db/schema";
import { and, eq } from "drizzle-orm";
import { isHostExecutedPath } from "./brain-runtime/decision-rights.ts";
import { git, gitComplete } from "./git.ts";
import { ESCALATE_AFTER_SWEEPS } from "./maintenance.ts";

/**
 * The ask-first rule for merges that change what the host later executes
 * (decision rights, `host_executed_merge` and `publish_outward`). The merge
 * queue applies it to the commit about to land, from the host's own diff, so
 * it holds however the job got there.
 *
 * An approval is bound to a fingerprint of the protected content, not to a
 * branch name: a branch that moves after the owner said yes asks again. It is
 * single use, consumed in the transaction that records the merge.
 */

/** `brain_actions.tool` of a card the queue raised. Not an act tool: the brain cannot call it. */
export const HOST_MERGE_TOOL = "host_executed_merge";

/** `engine_kv` row holding the owner's approval for one run. */
export const hostMergeApprovalKey = (runId: string) =>
	`host_merge_approval:${runId}`;

export interface HostExecutedChange {
	/** The protected paths this change touches, sorted. */
	paths: string[];
	/** Identifies their exact new content. */
	fingerprint: string;
}

/** What a queue-raised card records in `effects.hostMerge`. */
export interface HostMergeHold {
	jobId: number;
	runId: string;
	fingerprint: string;
}

const SYMLINK_MODE = "120000";

interface RawEntry {
	oldMode: string;
	newMode: string;
	newOid: string;
	path: string;
}

function parseRawDiff(out: string): RawEntry[] {
	const fields = out.split("\0");
	const entries: RawEntry[] = [];
	for (let i = 0; i + 1 < fields.length; i += 2) {
		const [oldMode, newMode, , newOid] = (fields[i] ?? "")
			.replace(/^:/, "")
			.split(" ");
		const path = fields[i + 1];
		if (!oldMode || !newMode || !newOid || !path) continue;
		entries.push({ oldMode, newMode, newOid, path });
	}
	return entries;
}

/** Where the tree's protected symlinks point, as repository paths. */
async function protectedLinkTargets(
	root: string,
	commit: string,
): Promise<string[]> {
	const listing = await gitComplete(
		["ls-tree", "-r", "-z", "--full-tree", commit],
		root,
	);
	const targets: string[] = [];
	for (const record of listing.split("\0")) {
		const tab = record.indexOf("\t");
		if (tab < 0) continue;
		const [mode, , oid] = record.slice(0, tab).split(" ");
		const path = record.slice(tab + 1);
		if (mode !== SYMLINK_MODE || !oid || !isHostExecutedPath(path)) continue;
		const link = await gitComplete(["cat-file", "blob", oid], root);
		const target = posix.normalize(posix.join(posix.dirname(path), link));
		if (!target.startsWith("..")) targets.push(target);
	}
	return targets;
}

/**
 * The protected part of `from..to`, or null when there is none. A symlink
 * change always counts, and so does a change behind a protected symlink. A
 * diff too large to list counts too, bound to the exact tree.
 */
export async function hostExecutedChange(
	root: string,
	from: string,
	to: string,
): Promise<HostExecutedChange | null> {
	let entries: RawEntry[];
	let targets: string[];
	try {
		entries = parseRawDiff(
			await gitComplete(
				[
					"diff-tree",
					"-r",
					"-z",
					"--raw",
					"--no-renames",
					"--abbrev=40",
					from,
					to,
				],
				root,
			),
		);
		targets = await protectedLinkTargets(root, to);
	} catch (e) {
		const tree = await git(["rev-parse", "--verify", `${to}^{tree}`], root);
		if (tree.exitCode !== 0) throw e;
		return {
			paths: ["(the changed files could not be listed)"],
			fingerprint: `tree:${tree.stdout.trim()}`,
		};
	}
	const hit = entries
		.filter(
			(e) =>
				isHostExecutedPath(e.path) ||
				e.oldMode === SYMLINK_MODE ||
				e.newMode === SYMLINK_MODE ||
				targets.some((t) => e.path === t || e.path.startsWith(`${t}/`)),
		)
		.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	if (hit.length === 0) return null;
	const hash = createHash("sha256");
	for (const e of hit) hash.update(`${e.newMode} ${e.newOid} ${e.path}\0`);
	return {
		paths: hit.map((e) => e.path),
		fingerprint: `sha256:${hash.digest("hex")}`,
	};
}

type Tx = Parameters<Parameters<ProjectDbHandle["withTx"]>[0]>[0];

/** Record a single-use approval for this run's exact protected content. */
export async function recordHostMergeApproval(
	tx: Tx,
	runId: string,
	fingerprint: string,
	actionId: string,
): Promise<void> {
	const key = hostMergeApprovalKey(runId);
	const value = { fingerprint, actionId, at: Date.now() };
	await tx
		.insert(engineKv)
		.values({ key, value, updatedAt: new Date() })
		.onConflictDoUpdate({
			target: engineKv.key,
			set: { value, updatedAt: new Date() },
		});
}

/**
 * The job's side of the owner's answer, inside the transaction that moves the
 * card out of `held`, so an answer and its effect cannot separate.
 */
export async function applyHostMergeDecision(
	tx: Tx,
	row: Pick<typeof brainActions.$inferSelect, "id" | "effects">,
	approved: boolean,
	reason: string,
): Promise<void> {
	const hold = (row.effects as { hostMerge?: HostMergeHold } | null)?.hostMerge;
	if (!hold) throw new Error(`card ${row.id} holds no merge`);
	const now = new Date();
	if (approved) {
		await recordHostMergeApproval(tx, hold.runId, hold.fingerprint, row.id);
		await tx
			.update(mergeJobs)
			.set({ state: "queued", error: null, updatedAt: now })
			.where(and(eq(mergeJobs.id, hold.jobId), eq(mergeJobs.state, "held")));
		return;
	}
	await tx
		.update(mergeJobs)
		.set({
			state: "parked",
			// At the budget: `retryParked` must not turn a "no" into another try.
			parkRetries: ESCALATE_AFTER_SWEEPS,
			error: `the owner declined this merge of host-executed files: ${reason}`,
			updatedAt: now,
		})
		.where(and(eq(mergeJobs.id, hold.jobId), eq(mergeJobs.state, "held")));
}
