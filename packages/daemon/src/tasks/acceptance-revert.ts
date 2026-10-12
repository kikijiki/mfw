import { join } from "node:path";
import { acquireKernelLock, loadBoardConfig } from "@mfw/board-core";
import { openProjectDb } from "@mfw/db/client";
import { engineKv } from "@mfw/db/schema";
import { eq } from "drizzle-orm";
import { git } from "../git.ts";
import type { Logger } from "../log.ts";
import { ACCEPTANCE_MIGRATION_KEY } from "../task-service.ts";
import {
	downgradeBoardYaml,
	type MigrationReport,
	revertBodyCriteria,
} from "./acceptance.ts";
import { BoardRepo } from "./board-git.ts";

export const REVERT_COMMIT_MESSAGE =
	"mfw: move acceptance criteria back into task bodies";

/**
 * Hand a board back to a daemon that predates the `acceptance` field: every
 * task's checklist goes back into an `## Acceptance Criteria` body section,
 * the field leaves board.yaml, the once-per-board marker is cleared (so a
 * newer daemon migrates again), and the board is committed. Takes the
 * project's daemon lock, so it refuses while a daemon has the project
 * attached; refuses to touch board.yaml if any task could not be reverted.
 */
export async function revertAcceptance(opts: {
	root: string;
	boardRoot?: string;
	log: Logger;
}): Promise<MigrationReport & { committed: string | null }> {
	const mfwDir = join(opts.root, ".mfw");
	// The board sits at the root of its folder, not under `.mfw/`.
	const boardRoot = opts.boardRoot ?? opts.root;
	const boardDir = boardRoot;
	const lock = await acquireKernelLock(join(mfwDir, "daemon.lock"), {
		timeoutMs: 2_000,
		busyMessage: `an mfw daemon owns ${mfwDir}; stop it before reverting the board`,
		metadata: { pid: process.pid, tool: "board-acceptance", at: Date.now() },
	});
	try {
		const boardYaml = join(boardDir, "board.yaml");
		const report = await revertBodyCriteria(
			boardDir,
			await loadBoardConfig(boardYaml),
			join(mfwDir, ".board"),
		);
		if (report.skipped.length > 0) {
			throw new Error(
				`could not revert ${report.skipped.map((s) => `${s.id} (${s.reason})`).join(", ")}; board.yaml left as is`,
			);
		}
		await downgradeBoardYaml(boardYaml);
		const handle = await openProjectDb(mfwDir);
		try {
			await handle.db
				.delete(engineKv)
				.where(eq(engineKv.key, ACCEPTANCE_MIGRATION_KEY));
		} finally {
			handle.close();
		}
		const head = await git(
			["symbolic-ref", "--short", "-q", "HEAD"],
			boardRoot,
		);
		let committed: string | null = null;
		if (head.exitCode === 0) {
			const repo = new BoardRepo({
				projectRoot: boardRoot,
				boardDir,
				integrationBranch: head.stdout.trim(),
				log: opts.log,
			});
			if ((await repo.ensureTracked()).enabled) {
				committed = await repo.commit(REVERT_COMMIT_MESSAGE);
			}
		}
		return { ...report, committed };
	} finally {
		await lock.release();
	}
}
