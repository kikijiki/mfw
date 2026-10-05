/**
 * One claim attempt, in its own OS process.
 *
 * The claim is a rename out of `ready/` guarded by an `O_CREAT|O_EXCL` lock
 * file — an assertion about the filesystem, not about one process's memory. An
 * in-process race (as in `board.test.ts`) cannot tell the two apart, so this
 * exists to be spawned N times at once by `board-hazards.test.ts`.
 *
 * Lives in the repo rather than being written to a temp dir at test time so
 * that `@mfw/*` workspace imports resolve.
 *
 * Usage: bun run claim-process.ts <mfwDir> <taskId> <runId>   → prints won|lost
 */
import { loadBoardConfig } from "@mfw/board-core";
import { openProjectDb } from "@mfw/db/client";
import { EventBus } from "@mfw/db/eventlog";
import { silentLogger } from "../../src/log.ts";
import { TaskService } from "../../src/task-service.ts";

const [mfwDir, taskId, runId] = process.argv.slice(2);
if (!mfwDir || !taskId || !runId) {
	console.log("lost");
	process.exit(2);
}

const handle = await openProjectDb(mfwDir);
let verdict = "lost";
try {
	const config = await loadBoardConfig(`${mfwDir}/board.yaml`);
	const svc = new TaskService({
		handle,
		bus: new EventBus(),
		mfwDir,
		config,
		taskKey: "MFW",
		log: silentLogger(),
	});
	await svc.load();
	verdict = (await svc.tryClaim(taskId, runId, 60_000)) ? "won" : "lost";
} catch {
	// Losing the race can surface as a thrown error (the file moved out from
	// under this process mid-rename); that is a loss, not a failure.
	verdict = "lost";
} finally {
	handle.close();
}
console.log(verdict);
