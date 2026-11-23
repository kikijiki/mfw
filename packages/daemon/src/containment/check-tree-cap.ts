/**
 * Caps what a DoD check can write to the host disk (design "Role profiles",
 * review P7 M2). The check's tree is a host directory, because it must survive
 * no longer than the check but be large enough to build in, and neither bwrap
 * nor the scope limits its size.
 *
 * The host polls the tree and kills the check at the cap. So the cap is a
 * bound plus whatever the check writes in one polling interval, not a hard
 * quota. A directory the walk cannot read hides its contents from the
 * measurement, so it stops the check too.
 */

import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

export const DEFAULT_CHECK_TREE_MB = 20 * 1024;
const DEFAULT_POLL_MS = 2_000;
/** Empty files use no blocks, so the entry count needs its own limit. */
const MAX_TREE_ENTRIES = 2_000_000;

export type TreeMeasure = "ok" | "over" | "blind";

/** Allocated bytes under `root`, stopping as soon as the answer is known. */
export async function measureTree(
	root: string,
	maxBytes: number,
): Promise<TreeMeasure> {
	let bytes = 0;
	let entries = 0;
	const pending = [root];
	while (pending.length > 0) {
		const dir = pending.pop() as string;
		let list: Awaited<ReturnType<typeof readEntries>>;
		try {
			list = await readEntries(dir);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
			if ((err as NodeJS.ErrnoException).code === "ENOTDIR") continue;
			return "blind";
		}
		for (const entry of list) {
			if (++entries > MAX_TREE_ENTRIES) return "over";
			const path = join(dir, entry.name);
			try {
				const st = await lstat(path);
				bytes += st.blocks * 512;
				if (st.isDirectory()) pending.push(path);
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") return "blind";
			}
			if (bytes > maxBytes) return "over";
		}
	}
	return "ok";
}

const readEntries = (dir: string) => readdir(dir, { withFileTypes: true });

/** Poll until stopped. Calls `onBreach` once, then polls no more. */
export function watchTreeSize(
	root: string,
	maxBytes: number,
	onBreach: (why: Exclude<TreeMeasure, "ok">) => void,
	pollMs: number = DEFAULT_POLL_MS,
): () => void {
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | null = null;
	const tick = async () => {
		const seen = await measureTree(root, maxBytes).catch(
			(): TreeMeasure => "blind",
		);
		if (stopped) return;
		if (seen !== "ok") {
			stopped = true;
			onBreach(seen);
			return;
		}
		timer = setTimeout(tick, pollMs);
	};
	timer = setTimeout(tick, pollMs);
	return () => {
		stopped = true;
		if (timer) clearTimeout(timer);
	};
}
