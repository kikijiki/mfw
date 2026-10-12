import { resolve } from "node:path";
import { loadConfig } from "../packages/daemon/src/config.ts";
import { rootLogger } from "../packages/daemon/src/log.ts";
import { revertAcceptance } from "../packages/daemon/src/tasks/acceptance-revert.ts";

/**
 * The daemon moves acceptance criteria into the task type's `acceptance`
 * field by itself, once per board. `--revert` undoes that so the board can be
 * read by a daemon that predates the field. Stop the daemon first.
 */
const [flag, rootArg] = process.argv.slice(2);
if (flag !== "--revert" || !rootArg) {
	throw new Error(
		"Usage: bun run tools/board-acceptance.ts --revert <project-root>\n" +
			"(the forward migration is automatic at attach; this only reverts it)",
	);
}
const root = resolve(rootArg);
const project = (await loadConfig()).projects.find((p) => p.root === root);
const report = await revertAcceptance({
	root,
	boardRoot: project?.boardRoot ? resolve(project.boardRoot) : undefined,
	log: rootLogger(),
});
console.log(
	`Reverted ${report.migrated.length} task(s); ${report.committed ? `committed "${report.committed}"` : "not committed (no git, or nothing changed)"}.`,
);
