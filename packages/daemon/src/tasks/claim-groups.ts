import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { acquireKernelLock, writeFileAtomic } from "@mfw/board-core";
import { openProjectDb } from "@mfw/db/client";
import { engineKv } from "@mfw/db/schema";
import { eq } from "drizzle-orm";

/**
 * The claim sidecar's holder moved from a run id to an attempt-group id
 * (`claimedByRunId` -> `claimedByGroupId`, plus a display-only `leadRunId`).
 * A group of one is named after its run, so the value never changes, only the
 * key. The rewrite runs once per board at attach, under the claim lock, with an
 * `engine_kv` marker; `revertClaimGroups` hands a board back to a daemon that
 * predates groups, as the acceptance-field upgrade has its own revert.
 */

export const CLAIM_GROUPS_MIGRATION_KEY = "claim_groups_migration";

export interface ClaimGroupsReport {
	/** Tasks whose sidecar was rewritten. */
	rewritten: string[];
	/** Reverts only: claims held by a competing group, written back as their lead run. */
	flattened: string[];
}

async function sidecars(
	stateRoot: string,
): Promise<{ id: string; path: string }[]> {
	const dir = join(stateRoot, "state", "tasks");
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return [];
	}
	return names
		.filter((n) => n.endsWith(".json") && !n.endsWith(".run.json"))
		.map((n) => ({ id: n.slice(0, -".json".length), path: join(dir, n) }));
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
	try {
		const raw = JSON.parse(await readFile(path, "utf8"));
		return raw && typeof raw === "object" ? raw : null;
	} catch {
		return null;
	}
}

/** Rewrite every legacy sidecar. The caller holds the claim lock. Idempotent. */
export async function rewriteClaimSidecars(
	stateRoot: string,
): Promise<ClaimGroupsReport> {
	const report: ClaimGroupsReport = { rewritten: [], flattened: [] };
	for (const { id, path } of await sidecars(stateRoot)) {
		const raw = await readJson(path);
		if (!raw || !("claimedByRunId" in raw)) continue;
		const { claimedByRunId, ...rest } = raw;
		await writeFileAtomic(
			path,
			`${JSON.stringify(
				{
					...rest,
					claimedByGroupId: rest.claimedByGroupId ?? claimedByRunId ?? null,
					leadRunId: rest.leadRunId ?? null,
				},
				null,
				2,
			)}\n`,
		);
		report.rewritten.push(id);
	}
	return report;
}

/**
 * Hand a board back to a daemon that predates attempt groups. Takes the
 * project's daemon lock, so it refuses while a daemon has the project attached.
 */
export async function revertClaimGroups(opts: {
	root: string;
}): Promise<ClaimGroupsReport> {
	const mfwDir = join(opts.root, ".mfw");
	const lock = await acquireKernelLock(join(mfwDir, "daemon.lock"), {
		timeoutMs: 2_000,
		busyMessage: `an mfw daemon owns ${mfwDir}; stop it before reverting claim groups`,
		metadata: { pid: process.pid, tool: "claim-groups", at: Date.now() },
	});
	try {
		const report: ClaimGroupsReport = { rewritten: [], flattened: [] };
		for (const { id, path } of await sidecars(mfwDir)) {
			const raw = await readJson(path);
			if (!raw || !("claimedByGroupId" in raw)) continue;
			const { claimedByGroupId, leadRunId, ...rest } = raw;
			const holder =
				typeof leadRunId === "string" ? leadRunId : (claimedByGroupId ?? null);
			if (typeof leadRunId === "string" && leadRunId !== claimedByGroupId) {
				report.flattened.push(id);
			}
			await writeFileAtomic(
				path,
				`${JSON.stringify({ ...rest, claimedByRunId: holder }, null, 2)}\n`,
			);
			report.rewritten.push(id);
		}
		const handle = await openProjectDb(mfwDir);
		try {
			await handle.db
				.delete(engineKv)
				.where(eq(engineKv.key, CLAIM_GROUPS_MIGRATION_KEY));
		} finally {
			handle.close();
		}
		return report;
	} finally {
		await lock.release();
	}
}
