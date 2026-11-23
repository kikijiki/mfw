/**
 * The run directory's trust layout (design "Bridge on the host"):
 *
 *   <root>/            host-only, 0700, never bound into a sandbox
 *     meta.json, raw.log, prompt.md, ...
 *     control/         host-written, bound read-only
 *     outbox/          the only run path a sandbox can write
 *
 * Anything read from `outbox/` is a claim by the agent. The root is never
 * bound, so no sandbox can rename `control/` or `outbox/` or plant a sibling,
 * which is what makes the pinned binds of these two directories safe.
 *
 * Imported by the drivers inside the sandbox: node builtins only.
 */

import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	type Stats,
} from "node:fs";
import { basename, dirname, join } from "node:path";

export const RUN_CONTROL_DIR = "control";
export const RUN_OUTBOX_DIR = "outbox";

export interface RunDirLayout {
	root: string;
	control: string;
	outbox: string;
}

export class RunDirLayoutError extends Error {
	constructor(path: string, detail: string) {
		super(`unsafe run directory ${path}: ${detail}`);
		this.name = "RunDirLayoutError";
	}
}

export function runDirLayout(root: string): RunDirLayout {
	return {
		root,
		control: join(root, RUN_CONTROL_DIR),
		outbox: join(root, RUN_OUTBOX_DIR),
	};
}

function assertPrivateDir(path: string, st: Stats, uid: number): void {
	if (st.isSymbolicLink() || !st.isDirectory()) {
		throw new RunDirLayoutError(path, "not a real directory");
	}
	if (st.uid !== uid) {
		throw new RunDirLayoutError(path, `owned by uid ${st.uid}, not ${uid}`);
	}
	if ((st.mode & 0o077) !== 0) {
		throw new RunDirLayoutError(
			path,
			`mode ${(st.mode & 0o777).toString(8)} is open to other users`,
		);
	}
}

/** Prove the layout on disk: three real, private directories owned by us. */
export function verifyRunDirLayout(
	root: string,
	uid: number = process.getuid?.() ?? 0,
): RunDirLayout {
	const layout = runDirLayout(root);
	for (const path of [layout.root, layout.control, layout.outbox]) {
		let st: Stats;
		try {
			st = lstatSync(path);
		} catch {
			throw new RunDirLayoutError(path, "missing");
		}
		assertPrivateDir(path, st, uid);
	}
	return layout;
}

/**
 * Create or tighten the layout, then verify it. A `control` or `outbox` that
 * is already a symlink or a file is refused, never replaced: in an older flat
 * run dir the agent could have planted it.
 */
export function ensureRunDirLayout(
	root: string,
	uid: number = process.getuid?.() ?? 0,
): RunDirLayout {
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const rootStat = lstatSync(root);
	if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
		throw new RunDirLayoutError(root, "not a real directory");
	}
	if (rootStat.uid !== uid) {
		throw new RunDirLayoutError(root, `owned by uid ${rootStat.uid}`);
	}
	chmodSync(root, 0o700);
	const layout = runDirLayout(root);
	for (const path of [layout.control, layout.outbox]) {
		try {
			mkdirSync(path, { mode: 0o700 });
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		}
	}
	return verifyRunDirLayout(root, uid);
}

/** True once this run dir has been split. Never follows a planted link. */
export function isSplitRunDir(root: string): boolean {
	const layout = runDirLayout(root);
	return [layout.control, layout.outbox].every((path) => {
		try {
			return lstatSync(path).isDirectory();
		} catch {
			return false;
		}
	});
}

/**
 * The project state directory holding this run dir and the project DB, for a
 * run at `<project>/.mfw/runs/<id>`; null for any other location.
 */
export function runStateRoot(root: string): string | null {
	const runs = dirname(root);
	const state = dirname(runs);
	return basename(runs) === "runs" && basename(state) === ".mfw" ? state : null;
}

/**
 * The directory holding a run's host-written files: `control/` once the host
 * launched it split, else the flat run dir. Only for locating files. Whether a
 * file there can be trusted is decided from the run row, because an agent in
 * an older flat run dir could have created `control/driver.json` itself.
 */
export function runHostFilesDir(runDir: string): string {
	const control = join(runDir, RUN_CONTROL_DIR);
	return existsSync(join(control, "driver.json")) ? control : runDir;
}

/** Where the driver finds its host-written inputs and writes its events. */
export function driverRunPaths(runDir: string): {
	config: string;
	steer: string;
	controls: string;
	events: string;
} {
	const split = existsSync(join(runDir, RUN_CONTROL_DIR, "driver.json"));
	const input = split ? join(runDir, RUN_CONTROL_DIR) : runDir;
	return {
		config: join(input, "driver.json"),
		steer: join(input, "steer.jsonl"),
		controls: join(input, "control.jsonl"),
		events: join(split ? join(runDir, RUN_OUTBOX_DIR) : runDir, "events.jsonl"),
	};
}

/** The agent's event stream: the outbox copy, or the flat path of an older run. */
export function runEventsPath(runDir: string): string {
	const inOutbox = join(runDir, RUN_OUTBOX_DIR, "events.jsonl");
	return existsSync(inOutbox) ? inOutbox : join(runDir, "events.jsonl");
}
