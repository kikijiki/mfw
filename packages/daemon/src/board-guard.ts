import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * The board folder holds a `tasks` directory but no `board.yaml`: that is
 * somebody's own directory, not a board. Creating a board over it would adopt
 * (and in time rewrite) files that were never ours, so the attach refuses.
 */
export async function assertNoForeignTasksDir(
	boardFolder: string,
): Promise<void> {
	if (existsSync(join(boardFolder, "board.yaml"))) return;
	const tasks = join(boardFolder, "tasks");
	if (existsSync(tasks)) {
		throw new Error(
			`${tasks} exists but there is no board.yaml beside it, so it is not an mfw board; ` +
				"choose a separate board folder for this project, or rename or remove that directory",
		);
	}
}
