/**
 * Scripts the host runs or copies for a sandboxed run.
 *
 * A production server runs only the copies built into its own output, each
 * checked against the build's hash manifest at every lookup. It never reads
 * them from the checkout: an autonomous merge fast-forwards that checkout, so a
 * script found there would be agent-authored code running outside the sandbox.
 * A missing manifest, an unlisted script or a changed file is a refusal.
 *
 * From source the script beside the asking module is used; `source-run-guard.ts`
 * refuses that when the checkout is itself a project mfw manages.
 *
 * It never searches from the working directory or upward: a run's working
 * directory is agent-written, and a planted copy would execute on the host.
 *
 * Imported by the drivers and bridges: node builtins only. `import.meta.dir`
 * is not used because Vite's dev server does not define it.
 */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface HostScript {
	/** The file name, beside the module that asks for it when run from source. */
	file: string;
	/** Its path from the repository root. */
	fromRoot: string;
}

const CONTAINMENT = "packages/daemon/src/containment";
const AGENTS = "packages/daemon/src/agents";

export const AGENT_LAUNCHER: HostScript = {
	file: "agent-launch-main.ts",
	fromRoot: `${CONTAINMENT}/agent-launch-main.ts`,
};
export const EGRESS_PROXY: HostScript = {
	file: "containment/egress-proxy-main.ts",
	fromRoot: `${CONTAINMENT}/egress-proxy-main.ts`,
};
/** The same proxy, for a module that sits beside it in `containment/`. */
export const EGRESS_PROXY_BESIDE: HostScript = {
	...EGRESS_PROXY,
	file: "egress-proxy-main.ts",
};
export const BRAIN_TRANSCRIPT: HostScript = {
	file: "containment/brain-transcript-main.ts",
	fromRoot: `${CONTAINMENT}/brain-transcript-main.ts`,
};
export const EGRESS_RELAY: HostScript = {
	file: "egress-relay.ts",
	fromRoot: `${CONTAINMENT}/egress-relay.ts`,
};
export const WIP_HELPER: HostScript = {
	file: "wip-helper.ts",
	fromRoot: "packages/daemon/src/run-workspace/wip-helper.ts",
};
export const APP_SERVER_DRIVER: HostScript = {
	file: "drivers/app-server-driver.ts",
	fromRoot: `${AGENTS}/drivers/app-server-driver.ts`,
};
export const CLAUDE_BRIDGE: HostScript = {
	file: "bridges/claude-app-server.ts",
	fromRoot: `${AGENTS}/bridges/claude-app-server.ts`,
};
export const CODEX_BRIDGE: HostScript = {
	file: "bridges/codex-app-server-bridge.ts",
	fromRoot: `${AGENTS}/bridges/codex-app-server-bridge.ts`,
};
export const CODEX_EXEC_BRIDGE: HostScript = {
	file: "bridges/codex-exec-bridge.ts",
	fromRoot: `${AGENTS}/bridges/codex-exec-bridge.ts`,
};
export const ACP_BRIDGE: HostScript = {
	file: "bridges/acp-bridge.ts",
	fromRoot: `${AGENTS}/bridges/acp-bridge.ts`,
};
export const MCP_MAIN: HostScript = {
	file: "../../../mcp/src/main.ts",
	fromRoot: "packages/mcp/src/main.ts",
};
export const REMOTE_RUNTIME: HostScript = {
	file: "runpod-remote-runtime.ts",
	fromRoot: "packages/daemon/src/runpod-remote-runtime.ts",
};

/** Every script the build copies. A script missing here cannot launch. */
export const BUILT_HOST_SCRIPTS: readonly HostScript[] = [
	AGENT_LAUNCHER,
	EGRESS_PROXY,
	BRAIN_TRANSCRIPT,
	EGRESS_RELAY,
	WIP_HELPER,
	APP_SERVER_DRIVER,
	CLAUDE_BRIDGE,
	CODEX_BRIDGE,
	CODEX_EXEC_BRIDGE,
	ACP_BRIDGE,
	MCP_MAIN,
	REMOTE_RUNTIME,
];

/** Inside the build output, beside the server's own `node_modules`. */
export const HOST_SCRIPTS_DIR = join("server", "host-scripts");
export const HOST_SCRIPTS_MANIFEST = "manifest.json";
export const HOST_SCRIPTS_MANIFEST_VERSION = 1;

export interface HostScriptManifest {
	version: number;
	/** Built file name to the sha256 of its content. */
	scripts: Record<string, string>;
}

/** The file name of a script's built copy. */
export function builtScriptName(script: HostScript): string {
	return `${script.fromRoot.replace(/\.ts$/, "").replaceAll("/", "__")}.js`;
}

export function sha256Hex(content: string | Uint8Array): string {
	return createHash("sha256").update(content).digest("hex");
}

const BUNDLE_DIR = `${sep}apps${sep}start${sep}.output${sep}`;
const REBUILD = "Fix: rebuild with `bun run build` and restart the server";

/** True for a module running from the production build. */
export function isBundledModule(moduleUrl: string): boolean {
	return fileURLToPath(moduleUrl).includes(BUNDLE_DIR);
}

function regularFile(path: string): boolean {
	try {
		return lstatSync(path).isFile();
	} catch {
		return false;
	}
}

function readManifest(dir: string): HostScriptManifest {
	const path = join(dir, HOST_SCRIPTS_MANIFEST);
	if (!regularFile(path)) {
		throw new Error(`refusing to launch: no host script manifest. ${REBUILD}`);
	}
	let parsed: Partial<HostScriptManifest>;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		throw new Error(
			`refusing to launch: the host script manifest is unreadable. ${REBUILD}`,
		);
	}
	if (
		parsed.version !== HOST_SCRIPTS_MANIFEST_VERSION ||
		typeof parsed.scripts !== "object" ||
		parsed.scripts === null
	) {
		throw new Error(
			`refusing to launch: the host script manifest has the wrong format. ${REBUILD}`,
		);
	}
	return parsed as HostScriptManifest;
}

function verifiedBuiltScript(outputDir: string, script: HostScript): string {
	const dir = join(outputDir, HOST_SCRIPTS_DIR);
	const manifest = readManifest(dir);
	const name = builtScriptName(script);
	const expected = Object.hasOwn(manifest.scripts, name)
		? manifest.scripts[name]
		: undefined;
	if (typeof expected !== "string") {
		throw new Error(
			`refusing to launch: ${script.fromRoot} is not in the manifest. ${REBUILD}`,
		);
	}
	const path = join(dir, name);
	if (!regularFile(path)) {
		throw new Error(
			`refusing to launch: the built ${script.fromRoot} is not a regular file. ${REBUILD}`,
		);
	}
	if (sha256Hex(readFileSync(path)) !== expected) {
		throw new Error(
			`refusing to launch: the built ${script.fromRoot} does not match its manifest hash. ${REBUILD}`,
		);
	}
	return path;
}

/**
 * The script's path for the module at `moduleUrl`. From the bundle this is the
 * verified built copy; from source, the file beside the module. Throws when
 * neither holds.
 */
export function hostScript(moduleUrl: string, script: HostScript): string {
	const moduleFile = fileURLToPath(moduleUrl);
	const bundle = moduleFile.lastIndexOf(BUNDLE_DIR);
	if (bundle >= 0) {
		const output = moduleFile.slice(0, bundle + BUNDLE_DIR.length);
		return verifiedBuiltScript(output, script);
	}
	const beside = join(dirname(moduleFile), script.file);
	if (existsSync(beside)) return beside;
	throw new Error(
		`cannot locate ${script.fromRoot} from ${moduleFile}: run the server from its checkout`,
	);
}
