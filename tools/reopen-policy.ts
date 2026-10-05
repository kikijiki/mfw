import { join, resolve } from "node:path";
import { BoardStore, loadBoardConfig } from "@mfw/board-core";
import { loadConfig } from "../packages/daemon/src/config.ts";
import { git } from "../packages/daemon/src/git.ts";
import {
	reopenDefinitionHash,
	reopenPolicyPath,
	setReopenPolicy,
} from "../packages/daemon/src/reopen-policy.ts";
import type { ReopenCondition } from "../packages/daemon/src/tasks/types.ts";

const [action, rootArg, taskId, checkout = "integration-worktree"] =
	process.argv.slice(2);
if (
	!["arm", "disarm"].includes(action ?? "") ||
	!rootArg ||
	!taskId ||
	!["integration-worktree", "primary"].includes(checkout)
) {
	throw new Error(
		"Usage: bun run tools/reopen-policy.ts arm|disarm <project-root> <task-id> [integration-worktree|primary]",
	);
}
const root = resolve(rootArg);
if (action === "disarm") {
	await setReopenPolicy(root, taskId, null);
	console.log(`Disarmed ${taskId}`);
} else {
	const config = (await loadConfig()).projects.find(
		(project) => project.root === root,
	);
	if (!config)
		throw new Error(`Project ${root} is not attached in the operator config`);
	const boardDir = join(resolve(config.boardRoot ?? root), ".mfw");
	const boardConfig = await loadBoardConfig(join(boardDir, "board.yaml"));
	const board = new BoardStore(boardDir, boardConfig);
	const doc = await board.readDocument("task", taskId);
	const reopenWhen =
		(doc?.fields.reopen_when as ReopenCondition[] | undefined) ?? [];
	if (!doc || !reopenWhen.some((condition) => "run" in condition)) {
		throw new Error(`${taskId} has no readable command reopen conditions`);
	}
	// Match attachProject's integration branch resolution when the operator
	// did not configure one explicitly.
	const head = await git(["symbolic-ref", "--short", "-q", "HEAD"], root);
	const remote =
		head.exitCode === 0
			? null
			: await git(
					["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"],
					root,
				);
	const branch =
		config.integrationBranch ??
		(head.stdout || remote?.stdout.replace(/^origin\//, "") || "main");
	const hash = reopenDefinitionHash(reopenWhen, config.checkPrefix, branch);
	await setReopenPolicy(root, taskId, {
		hash,
		checkout: checkout as "integration-worktree" | "primary",
		armedAt: Date.now(),
	});
	console.log(
		`Armed ${taskId} (${hash}) in ${checkout}; policy: ${reopenPolicyPath(root)}`,
	);
	console.log(JSON.stringify(reopenWhen, null, 2));
}
