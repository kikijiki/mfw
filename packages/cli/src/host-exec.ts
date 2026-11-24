/**
 * `mfw __host <id> [args]`: a compiled `mfw` re-invoking itself to run one of
 * the host entries (the agent launcher, the egress proxy, the drivers and
 * bridges, the brain transcript step). It replaces the script files a bundle
 * runs, so a compiled install has nothing on disk to load host code from: the
 * executable's own integrity stands in for the host script manifest.
 *
 * `mfw __host emit <id>` prints a script a sandbox runs (the egress relay, the
 * WIP helper, the brain's MCP server), which the server copies into the run.
 *
 * It is internal and refused:
 *  - from source or a bundle: only a compiled `mfw` carries these entries;
 *  - inside an mfw sandbox, recognised by the sandbox's own mount points, which
 *    sit on a read-only root the agent cannot unmount (it has no capabilities
 *    and cannot make a user namespace);
 *  - from inside another host entry, except along the edges below, so a child
 *    never re-execs through the launcher again. This is the recursion rule of
 *    `run-child.ts` (`MFW_CHILD_DEPTH`) for self re-exec; it rides on its own
 *    variable because a driver hands its environment to an unsandboxed agent,
 *    whose `mfw board` must keep working.
 *
 * It does not refuse bun's runtime variables (`BUN_OPTIONS`, `BUN_BE_BUN`):
 * a compiled bun executable cannot, because they act before or instead of its
 * own code. The host's spawn environment (`host-spawn-env.ts`) is the control.
 *
 * None of this is a security boundary on its own: inside a sandbox an agent
 * controls every input a check could read, and `__host` there runs with the
 * sandbox's rights only. The refusals keep a confused caller from starting host
 * code in the wrong place.
 */

import { existsSync, statSync } from "node:fs";
import {
	HOST_CONTENT_IDS,
	HOST_ENTRY_IDS,
	type HostContentId,
	type HostEntryId,
} from "../../daemon/src/containment/host-script.ts";

/** Set by the dispatcher for the entry it runs; every descendant inherits it. */
export const HOST_ENTRY_ENV = "MFW_HOST_ENTRY";
/**
 * How many `__host` entries deep this process is. The longest real chain is
 * driver, bridge, launcher; a fourth level is refused, whatever the edge rule
 * says, so no configuration can turn re-exec into a process storm.
 */
export const HOST_DEPTH_ENV = "MFW_HOST_DEPTH";
export const MAX_HOST_DEPTH = 3;

/**
 * Mount points every mfw sandbox has on its read-only root (the sandbox home,
 * from `compile-bwrap.ts`'s `SANDBOX_PATHS.home`; a test keeps them equal).
 */
export const SANDBOX_MARKERS = ["/sandbox/agent"] as const;

/**
 * Which entry may start which: the driver starts a bridge (or the CLI through
 * the launcher), and a bridge starts the launcher. The launcher starts none.
 */
export const ALLOWED_CHILDREN: Partial<
	Record<HostEntryId, readonly HostEntryId[]>
> = {
	"app-server-driver": [
		"claude-bridge",
		"codex-bridge",
		"codex-exec-bridge",
		"acp-bridge",
		"agent-launcher",
	],
	"claude-bridge": ["agent-launcher"],
	"codex-bridge": ["agent-launcher"],
	"codex-exec-bridge": ["agent-launcher"],
	"acp-bridge": ["agent-launcher"],
};

export const HOST_ENTRY_MODULES: Record<HostEntryId, () => Promise<unknown>> = {
	"agent-launcher": () =>
		import("../../daemon/src/containment/agent-launch-main.ts"),
	"egress-proxy": () =>
		import("../../daemon/src/containment/egress-proxy-main.ts"),
	"brain-transcript": () =>
		import("../../daemon/src/containment/brain-transcript-main.ts"),
	"app-server-driver": () =>
		import("../../daemon/src/agents/drivers/app-server-driver.ts"),
	"claude-bridge": () =>
		import("../../daemon/src/agents/bridges/claude-app-server.ts"),
	"codex-bridge": () =>
		import("../../daemon/src/agents/bridges/codex-app-server-bridge.ts"),
	"codex-exec-bridge": () =>
		import("../../daemon/src/agents/bridges/codex-exec-bridge.ts"),
	"acp-bridge": () => import("../../daemon/src/agents/bridges/acp-bridge.ts"),
};

export interface HostExecContext {
	compiled: boolean;
	env: Record<string, string | undefined>;
	/** Whether a path is a directory (the sandbox mount points). */
	isDir: (path: string) => boolean;
}

export function liveHostExecContext(compiled: boolean): HostExecContext {
	return {
		compiled,
		env: process.env,
		isDir: (p) => {
			try {
				return existsSync(p) && statSync(p).isDirectory();
			} catch {
				return false;
			}
		},
	};
}

const isEntry = (id: string): id is HostEntryId =>
	(HOST_ENTRY_IDS as readonly string[]).includes(id);
const isContent = (id: string): id is HostContentId =>
	(HOST_CONTENT_IDS as readonly string[]).includes(id);

/** Why `mfw __host <args>` must not run here, or null. */
export function hostExecRefusal(
	args: readonly string[],
	ctx: HostExecContext,
): string | null {
	if (!ctx.compiled) {
		return "`mfw __host` is internal to a compiled mfw; from a checkout the server runs its scripts directly";
	}
	const [first, second] = args;
	const emit = first === "emit";
	const id = emit ? second : first;
	if (!id || (emit ? !isContent(id) : !isEntry(id))) {
		return `\`mfw __host\` has no ${emit ? "content" : "entry"} '${id ?? ""}'`;
	}
	const marker = SANDBOX_MARKERS.find((m) => ctx.isDir(m));
	if (marker) {
		return "refusing `mfw __host` inside an mfw sandbox: host entries run only on the host";
	}
	if (emit) return null;
	const depth = Number(ctx.env[HOST_DEPTH_ENV] ?? 0);
	if (!Number.isInteger(depth) || depth < 0 || depth >= MAX_HOST_DEPTH) {
		return `refusing \`mfw __host ${id}\`: already ${ctx.env[HOST_DEPTH_ENV]} host entries deep (at most ${MAX_HOST_DEPTH})`;
	}
	const parent = ctx.env[HOST_ENTRY_ENV];
	if (parent !== undefined && parent !== "") {
		const allowed =
			isEntry(parent) &&
			(ALLOWED_CHILDREN[parent] ?? []).includes(id as HostEntryId);
		if (!allowed) {
			return `refusing \`mfw __host ${id}\` from inside ${parent}: a host entry never re-execs through ${parent === "agent-launcher" ? "the launcher" : "mfw"} again`;
		}
	}
	return null;
}

export interface HostExecDeps {
	ctx: HostExecContext;
	err: (line: string) => void;
	/** Writes emitted content to stdout. */
	write: (text: string) => void;
	/** The embedded content a sandbox runs, by id. */
	content: (id: HostContentId) => string;
}

/**
 * Runs one host entry in this process. Resolves to an exit code for a refusal
 * or an emit; an entry itself keeps the process for as long as it runs.
 */
export async function runHostEntry(
	args: string[],
	deps: HostExecDeps,
): Promise<number | null> {
	const refused = hostExecRefusal(args, deps.ctx);
	if (refused) {
		deps.err(`mfw: ${refused}`);
		return 78;
	}
	if (args[0] === "emit") {
		deps.write(deps.content(args[1] as HostContentId));
		return 0;
	}
	const id = args[0] as HostEntryId;
	const env = deps.ctx.env;
	env[HOST_ENTRY_ENV] = id;
	env[HOST_DEPTH_ENV] = String(Number(env[HOST_DEPTH_ENV] ?? 0) + 1);
	// Each entry reads its arguments from process.argv as a script would.
	process.argv = [
		process.argv[0] ?? "mfw",
		`mfw __host ${id}`,
		...args.slice(1),
	];
	await HOST_ENTRY_MODULES[id]();
	return null;
}
