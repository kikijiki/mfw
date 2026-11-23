/**
 * Running from source executes host scripts straight from the checkout. That
 * is fine for a development tree, and unsafe when mfw manages that same
 * repository: an autonomous merge would rewrite the scripts it launches next.
 */

import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { git } from "../git.ts";
import { isBundledModule } from "./host-script.ts";

const MARKER = join(
	"packages",
	"daemon",
	"src",
	"containment",
	"host-script.ts",
);

function checkoutOf(moduleFile: string): string | null {
	let dir = dirname(moduleFile);
	for (;;) {
		if (existsSync(join(dir, MARKER))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

async function repositoryId(path: string): Promise<string> {
	const common = await git(
		["rev-parse", "--path-format=absolute", "--git-common-dir"],
		path,
	);
	return realpathSync(common.exitCode === 0 ? common.stdout.trim() : path);
}

/** Null when this project may attach, else why it may not and the fix. */
export async function sourceRunRefusal(
	moduleUrl: string,
	projectRoot: string,
): Promise<string | null> {
	if (isBundledModule(moduleUrl)) return null;
	const checkout = checkoutOf(fileURLToPath(moduleUrl));
	if (!checkout) {
		return "refusing to attach: cannot identify the checkout this server runs from. Fix: run the production build (`bun run build`)";
	}
	if ((await repositoryId(checkout)) !== (await repositoryId(projectRoot))) {
		return null;
	}
	return `refusing to attach ${projectRoot}: this server runs from source in the same repository, so a merge would change the scripts it runs on the host. Fix: run the production build (\`bun run build\`), or set MFW_DISABLE_ORCHESTRATOR=1 for a UI-only dev server`;
}
