import { mkdir, readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { writeFileAtomic } from "@mfw/core/fsatomic";
import { deriveKey, KEY_RE } from "@mfw/db/ids";
import { parse as parseYaml } from "yaml";

/**
 * A project's task key (the prefix of every id it mints).
 *
 * Deriving from the directory name is only safe for a project with no tasks; a
 * mismatched key silently quarantines every existing file. So it is discovered,
 * in order of authority:
 *
 *   1. `.mfw/state/board.json`
 *   2. `.mfw/config.yaml` `taskKey`
 *   3. the ids on the board
 *   4. the directory name (new project)
 *
 * The winner is written back to `board.json` so it stays stable if the
 * directory is renamed or the config edited.
 */

const ID_PREFIX_RE = /^([A-Z][A-Z0-9]{1,9})-[1-9][0-9]*$/;

async function fromBoardState(mfwDir: string): Promise<string | null> {
	try {
		const raw = JSON.parse(
			await readFile(join(mfwDir, "state", "board.json"), "utf8"),
		) as { taskKey?: unknown };
		const key = typeof raw.taskKey === "string" ? raw.taskKey : null;
		return key && KEY_RE.test(key) ? key : null;
	} catch {
		return null;
	}
}

async function fromConfig(mfwDir: string): Promise<string | null> {
	try {
		const doc = parseYaml(
			await readFile(join(mfwDir, "config.yaml"), "utf8"),
		) as { taskKey?: unknown } | null;
		const key = typeof doc?.taskKey === "string" ? doc.taskKey : null;
		return key && KEY_RE.test(key) ? key : null;
	} catch {
		return null;
	}
}

/** The most common id prefix among the files on the board. */
async function fromExistingFiles(mfwDir: string): Promise<string | null> {
	const tasksDir = join(mfwDir, "tasks");
	const counts = new Map<string, number>();
	let names: string[];
	try {
		names = await readdir(tasksDir);
	} catch {
		names = [];
	}
	for (const name of names) {
		// A task is a directory (`MFW-4-slug`); a loose note keeps its `.md`.
		const stem = name.endsWith(".md") ? name.slice(0, -3) : name;
		const m = ID_PREFIX_RE.exec(stem.split("-").slice(0, 2).join("-"));
		if (!m) continue;
		const key = m[1] as string;
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	let best: string | null = null;
	let bestN = 0;
	for (const [key, n] of counts) {
		if (n > bestN) {
			best = key;
			bestN = n;
		}
	}
	return best;
}

export async function resolveTaskKey(
	mfwDir: string,
	projectRoot: string,
): Promise<string> {
	const key =
		(await fromBoardState(mfwDir)) ??
		(await fromConfig(mfwDir)) ??
		(await fromExistingFiles(mfwDir)) ??
		deriveKey(basename(projectRoot));

	// Persist, merging so the counters written by the store survive.
	const statePath = join(mfwDir, "state", "board.json");
	let current: Record<string, unknown> = {};
	try {
		current = JSON.parse(await readFile(statePath, "utf8")) as Record<
			string,
			unknown
		>;
	} catch {
		// first boot for this project
	}
	if (current.taskKey !== key) {
		await mkdir(join(mfwDir, "state"), { recursive: true });
		await writeFileAtomic(
			statePath,
			`${JSON.stringify({ ...current, taskKey: key }, null, 2)}\n`,
		);
	}
	return key;
}
