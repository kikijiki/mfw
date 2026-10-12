import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "@mfw/core/fsatomic";

/**
 * What marks a `kind: brain` run as a project-brain TURN rather than one of
 * the advisory one-shot calls `BrainService` records (those are headless
 * subprocesses owned by `BrainService`, never observed by the supervisor).
 * Turns are real tmux runs: the supervisor observes and finalizes them.
 */
export const BRAIN_TURN_LABEL = "brain#turn";

export function isBrainTurnRun(run: {
	kind: string;
	label: string | null;
}): boolean {
	return run.kind === "brain" && run.label === BRAIN_TURN_LABEL;
}

/** The MCP server a turn's harness is given; nothing but this reaches the daemon. */
export interface BrainMcpServer {
	/** Server name the tools are exposed under (`mcp__<name>__*`). */
	name: string;
	command: string;
	args: string[];
	env: Record<string, string>;
}

/**
 * Per-turn launch facts the adapter needs and a restarted daemon must be able
 * to rebuild the invocation from: persisted in the run dir (`brain-turn.json`)
 * before the row exists, so prepare and launch agree.
 */
export interface BrainTurnLaunch {
	/** First turn of a generation: the id mfw minted for the harness's session (Claude `--session-id`). */
	sessionId?: string;
	/** A later turn: the native session to resume. */
	resumeSessionId?: string;
	/** Generated MCP config file (Claude `--mcp-config`). */
	mcpConfigPath: string;
	mcp: BrainMcpServer;
	/** Pins where Claude keeps the transcript (`CLAUDE_CODE_PROJECT_DIR_NAME`). */
	projectDirName?: string;
}

const FILE = "brain-turn.json";

export async function writeBrainTurnLaunch(
	runDir: string,
	launch: BrainTurnLaunch,
): Promise<void> {
	await mkdir(runDir, { recursive: true });
	await writeFileAtomic(
		join(runDir, FILE),
		`${JSON.stringify(launch, null, "\t")}\n`,
	);
}

export async function readBrainTurnLaunch(
	runDir: string,
): Promise<BrainTurnLaunch> {
	return JSON.parse(
		await readFile(join(runDir, FILE), "utf8"),
	) as BrainTurnLaunch;
}
