import { loadBoardConfig } from "@mfw/board-core";
import type { ProjectDbHandle } from "@mfw/db/client";
import type { EventBus } from "@mfw/db/eventlog";
import { ensureBoardConfig } from "../../src/default-board-config.ts";
import { silentLogger } from "../../src/log.ts";
import { TaskService } from "../../src/task-service.ts";
import type { DefinitionOfDone } from "../../src/tasks/types.ts";

/**
 * What `ensureGitExclude` writes, for fixtures that never call it.
 *
 * A blanket `.mfw/` line — which several of these fixtures used to write — is
 * not a harmless simplification now that the board is tracked: git refuses to
 * re-include a file whose parent directory is excluded, so `git add` on a board
 * path would stage nothing and every board assertion would pass vacuously.
 */
export const MFW_EXCLUDE = [
	"worktrees/",
	"MFW_REPORT.json",
	"/.mfw/*",
	"!/.mfw/config.yaml",
	"!/.mfw/AGENTS.md",
	"!/.mfw/lifetime/",
	"!/.mfw/triggers/",
	"!/.mfw/templates/",
	"!/.mfw/tasks/",
	"!/.mfw/adrs/",
	"!/.mfw/board.yaml",
	"",
].join("\n");

/**
 * A TaskService wired the way `attachProject` wires one, including the initial
 * board load. Tests that skipped the load would get an empty index over a
 * populated directory — the one state the daemon itself can never be in.
 */
export async function makeTasks(
	handle: ProjectDbHandle,
	bus: EventBus,
	mfwDir: string,
	taskKey = "MFW",
	mergeChecks?: DefinitionOfDone | null,
): Promise<TaskService> {
	await ensureBoardConfig(mfwDir, taskKey);
	const config = await loadBoardConfig(`${mfwDir}/board.yaml`);
	const svc = new TaskService({
		handle,
		bus,
		mfwDir,
		config,
		taskKey,
		log: silentLogger(),
		mergeChecks,
	});
	await svc.load();
	return svc;
}
