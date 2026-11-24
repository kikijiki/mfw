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
 * A compiled install has no script files at all. Each host entry is the `mfw`
 * executable re-invoking itself (`mfw __host <id>`): from inside `mfw` that is
 * its own running image, and from the server bundle it is the install's `mfw`,
 * checked against the install manifest's hash (`install-manifest.ts`). Script
 * content a sandbox needs (the egress relay, the WIP helper, the brain's MCP
 * server) is embedded in `mfw` and copied out of it. A path to a script file is
 * refused there, and so is every override.
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
import { buildKind } from "../../../core/src/build-info.ts";
import {
	fileMismatch,
	type InstallManifest,
	installPath,
	readInstallManifest,
} from "./install-manifest.ts";

export interface HostScript {
	/** The file name, beside the module that asks for it when run from source. */
	file: string;
	/** Its path from the repository root. */
	fromRoot: string;
	/** Its name for `mfw __host` in a compiled install. */
	id: HostEntryId | HostContentId;
}

/** Scripts the host runs as processes: `mfw __host <id>` when compiled. */
export const HOST_ENTRY_IDS = [
	"agent-launcher",
	"egress-proxy",
	"brain-transcript",
	"app-server-driver",
	"claude-bridge",
	"codex-bridge",
	"codex-exec-bridge",
	"acp-bridge",
] as const;
export type HostEntryId = (typeof HOST_ENTRY_IDS)[number];

/** Scripts only copied (into a sandbox, or to a remote): `mfw __host emit <id>`. */
export const HOST_CONTENT_IDS = [
	"egress-relay",
	"wip-helper",
	"mcp-main",
	"remote-runtime",
] as const;
export type HostContentId = (typeof HOST_CONTENT_IDS)[number];

/** The internal subcommand of a compiled `mfw`. */
export const HOST_SUBCOMMAND = "__host";

/** The flags for any bun process the host starts on behalf of a sandboxed run. */
export const HOST_BUN_FLAGS = ["--config=/dev/null", "--no-env-file"] as const;

const CONTAINMENT = "packages/daemon/src/containment";
const AGENTS = "packages/daemon/src/agents";

export const AGENT_LAUNCHER: HostScript = {
	file: "agent-launch-main.ts",
	fromRoot: `${CONTAINMENT}/agent-launch-main.ts`,
	id: "agent-launcher",
};
export const EGRESS_PROXY: HostScript = {
	file: "containment/egress-proxy-main.ts",
	fromRoot: `${CONTAINMENT}/egress-proxy-main.ts`,
	id: "egress-proxy",
};
/** The same proxy, for a module that sits beside it in `containment/`. */
export const EGRESS_PROXY_BESIDE: HostScript = {
	...EGRESS_PROXY,
	file: "egress-proxy-main.ts",
};
export const BRAIN_TRANSCRIPT: HostScript = {
	file: "containment/brain-transcript-main.ts",
	fromRoot: `${CONTAINMENT}/brain-transcript-main.ts`,
	id: "brain-transcript",
};
export const EGRESS_RELAY: HostScript = {
	file: "egress-relay.ts",
	fromRoot: `${CONTAINMENT}/egress-relay.ts`,
	id: "egress-relay",
};
export const WIP_HELPER: HostScript = {
	file: "wip-helper.ts",
	fromRoot: "packages/daemon/src/run-workspace/wip-helper.ts",
	id: "wip-helper",
};
export const APP_SERVER_DRIVER: HostScript = {
	file: "drivers/app-server-driver.ts",
	fromRoot: `${AGENTS}/drivers/app-server-driver.ts`,
	id: "app-server-driver",
};
export const CLAUDE_BRIDGE: HostScript = {
	file: "bridges/claude-app-server.ts",
	fromRoot: `${AGENTS}/bridges/claude-app-server.ts`,
	id: "claude-bridge",
};
export const CODEX_BRIDGE: HostScript = {
	file: "bridges/codex-app-server-bridge.ts",
	fromRoot: `${AGENTS}/bridges/codex-app-server-bridge.ts`,
	id: "codex-bridge",
};
export const CODEX_EXEC_BRIDGE: HostScript = {
	file: "bridges/codex-exec-bridge.ts",
	fromRoot: `${AGENTS}/bridges/codex-exec-bridge.ts`,
	id: "codex-exec-bridge",
};
export const ACP_BRIDGE: HostScript = {
	file: "bridges/acp-bridge.ts",
	fromRoot: `${AGENTS}/bridges/acp-bridge.ts`,
	id: "acp-bridge",
};
export const MCP_MAIN: HostScript = {
	file: "../../../mcp/src/main.ts",
	fromRoot: "packages/mcp/src/main.ts",
	id: "mcp-main",
};
export const REMOTE_RUNTIME: HostScript = {
	file: "runpod-remote-runtime.ts",
	fromRoot: "packages/daemon/src/runpod-remote-runtime.ts",
	id: "remote-runtime",
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
const SERVER_DIR = `${sep}server${sep}`;
/** Where a bundle's own modules sit inside its `server/` directory. */
const BUNDLE_MODULE =
	/^(?:index\.mjs|chunks\/.+\.mjs|host-scripts\/[^/]+\.js)$/;
const REBUILD = "Fix: rebuild with `bun run build` and restart the server";
const REINSTALL =
	"Fix: reinstall mfw (its files do not match its install manifest)";

/**
 * The output directory (with a trailing separator) of the bundle a module runs
 * from, or null when it runs from source. A checkout's build is recognised by
 * its path; a bundle copied anywhere else, such as a compiled install, by the
 * stamp the build gave it. A stamped bundle in a layout this does not know is
 * an error, never "source".
 */
export function bundleOutputOf(moduleFile: string): string | null {
	const inCheckout = moduleFile.lastIndexOf(BUNDLE_DIR);
	if (inCheckout >= 0)
		return moduleFile.slice(0, inCheckout + BUNDLE_DIR.length);
	if (buildKind() !== "bundle") return null;
	const at = moduleFile.lastIndexOf(SERVER_DIR);
	const rest =
		at >= 0
			? moduleFile
					.slice(at + SERVER_DIR.length)
					.split(sep)
					.join("/")
			: "";
	if (at < 0 || !BUNDLE_MODULE.test(rest)) {
		throw new Error(
			`refusing: ${moduleFile} is a production build in a layout mfw does not know. ${REBUILD}`,
		);
	}
	return moduleFile.slice(0, at + 1);
}

/** True for a module running from the production build. */
export function isBundledModule(moduleUrl: string): boolean {
	return bundleOutputOf(fileURLToPath(moduleUrl)) !== null;
}

/** True inside a compiled `mfw`, where a host entry is this executable again. */
export function selfReExecs(): boolean {
	return buildKind() === "compiled";
}

/** The install manifest of the bundle `moduleUrl` runs from, null for a plain bundle or source. */
export function compiledInstallOf(
	moduleUrl: string,
): { libDir: string; manifest: InstallManifest } | null {
	if (selfReExecs()) return null;
	const moduleFile = fileURLToPath(moduleUrl);
	// A checkout's build is never a compiled install, whatever is planted in its
	// output (security review REL-1 L6): only a stamped bundle in an install's
	// layout reads `install.json`.
	if (moduleFile.includes(BUNDLE_DIR)) return null;
	const output = bundleOutputOf(moduleFile);
	if (output === null) return null;
	const manifest = readInstallManifest(output);
	return manifest ? { libDir: output, manifest } : null;
}

/** True when host code runs only through `mfw __host`: inside `mfw`, or from a compiled install's server. */
export function runsHostEntries(moduleUrl: string): boolean {
	return selfReExecs() || compiledInstallOf(moduleUrl) !== null;
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
 * neither holds, and always in a compiled install, which has no script files.
 */
export function hostScript(moduleUrl: string, script: HostScript): string {
	if (runsHostEntries(moduleUrl)) {
		throw new Error(
			`refusing to launch: a compiled install has no script files, and runs ${script.fromRoot} only as \`mfw ${HOST_SUBCOMMAND} ${script.id}\``,
		);
	}
	const moduleFile = fileURLToPath(moduleUrl);
	const output = bundleOutputOf(moduleFile);
	if (output !== null) return verifiedBuiltScript(output, script);
	const beside = join(dirname(moduleFile), script.file);
	if (existsSync(beside)) return beside;
	throw new Error(
		`cannot locate ${script.fromRoot} from ${moduleFile}: run the server from its checkout`,
	);
}

// ---------- compiled installs: `mfw __host` ----------

const ENTRY_REF = "mfw-host:";

/** A reference to a host entry that only `hostCommand` turns into a command line. */
export function isHostEntryRef(ref: string): boolean {
	return ref.startsWith(ENTRY_REF);
}

function entryId(script: HostScript): HostEntryId {
	if (!(HOST_ENTRY_IDS as readonly string[]).includes(script.id)) {
		throw new Error(`${script.fromRoot} is not a host entry`);
	}
	return script.id as HostEntryId;
}

/**
 * What runs a host entry: the verified script path (source or bundle), or in a
 * compiled install a reference `hostCommand` expands to `mfw __host <id>`.
 */
export function hostEntry(moduleUrl: string, script: HostScript): string {
	const id = entryId(script);
	return runsHostEntries(moduleUrl)
		? `${ENTRY_REF}${id}`
		: hostScript(moduleUrl, script);
}

/**
 * The install's `mfw`, checked against the manifest at every call, so every
 * host entry starts from bytes that were just verified (REL-1 M2). The hash
 * is read through one open descriptor (`sha256OfFile`); the command line names
 * the path, because the entry starts through `run.sh` and tmux, where no
 * descriptor can follow. That window needs write access to the install, which
 * the launcher's install check refuses for autonomous runs.
 */
function verifiedInstallMfw(install: {
	libDir: string;
	manifest: InstallManifest;
}): string {
	const path = installPath(install.libDir, install.manifest.mfw);
	if (!existsSync(path)) {
		throw new Error(`refusing to launch: ${path} is missing. ${REINSTALL}`);
	}
	const problem = fileMismatch(path, install.manifest.mfw.sha256);
	if (problem) throw new Error(`refusing to launch: ${problem}. ${REINSTALL}`);
	return path;
}

/**
 * The `mfw` executable that runs host entries. Inside `mfw` it is the running
 * image itself (`/proc/self/exe`, so a file replaced on disk since is not what
 * runs); from a compiled install's server, the install's verified `mfw`.
 */
export function mfwExecutable(moduleUrl: string = import.meta.url): string {
	if (selfReExecs()) {
		return process.platform === "linux" && existsSync("/proc/self/exe")
			? "/proc/self/exe"
			: process.execPath;
	}
	const install = compiledInstallOf(moduleUrl);
	if (!install) {
		throw new Error(
			"refusing to launch: `mfw __host` is only for a compiled install",
		);
	}
	return verifiedInstallMfw(install);
}

/**
 * The command line that starts a host entry, before its own arguments. `bun`
 * runs a script path; a compiled install runs `mfw __host <id>`.
 */
export function hostCommand(
	ref: string,
	bun: string,
	moduleUrl: string = import.meta.url,
): string[] {
	if (!isHostEntryRef(ref)) return [bun, ...HOST_BUN_FLAGS, "run", ref];
	const id = ref.slice(ENTRY_REF.length);
	if (!(HOST_ENTRY_IDS as readonly string[]).includes(id)) {
		throw new Error(`refusing to launch: ${id} is not a host entry`);
	}
	return [mfwExecutable(moduleUrl), HOST_SUBCOMMAND, id];
}

/** Content a compiled `mfw` carries: built script bytes, by id. */
const EMBEDDED = Symbol.for("mfw.embeddedHostScripts");
type EmbeddedScripts = Partial<Record<HostContentId, string>>;

/** Called once by the compiled `mfw` entry, before any command runs. */
export function registerEmbeddedHostScripts(scripts: EmbeddedScripts): void {
	(globalThis as Record<symbol, unknown>)[EMBEDDED] = Object.freeze({
		...scripts,
	});
}

function embeddedScript(id: HostContentId): string {
	const scripts = (globalThis as Record<symbol, unknown>)[EMBEDDED] as
		| EmbeddedScripts
		| undefined;
	const text = scripts?.[id];
	if (typeof text !== "string") {
		throw new Error(
			`refusing to launch: this mfw carries no ${id}. Fix: rebuild it with tools/compile.ts`,
		);
	}
	return text;
}

function contentId(script: HostScript): HostContentId {
	if (!(HOST_CONTENT_IDS as readonly string[]).includes(script.id)) {
		throw new Error(`${script.fromRoot} is not copied, it is run`);
	}
	return script.id as HostContentId;
}

/**
 * The bytes of a script that is copied rather than run on the host (into a
 * sandbox, or to a remote). From source or a bundle, the file `hostScript`
 * finds; inside `mfw`, its embedded copy; from a compiled install's server, the
 * copy the verified `mfw` prints.
 */
export function hostScriptText(moduleUrl: string, script: HostScript): string {
	const id = contentId(script);
	if (selfReExecs()) return embeddedScript(id);
	if (compiledInstallOf(moduleUrl)) {
		const r = Bun.spawnSync(
			[mfwExecutable(moduleUrl), HOST_SUBCOMMAND, "emit", id],
			{
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				env: { PATH: "/nonexistent" },
			},
		);
		if (r.exitCode !== 0) {
			throw new Error(
				`refusing to launch: mfw could not provide ${id}: ${r.stderr.toString().trim()}`,
			);
		}
		return r.stdout.toString();
	}
	return readFileSync(hostScript(moduleUrl, script), "utf8");
}

/**
 * A command line written as `bun run <script or entry> ...`, as the host must
 * start it: the pinned `bun` with the host flags, or `mfw __host <id>`. Any
 * other command is left as it is.
 */
export function hostArgv(
	argv: readonly string[],
	bun: string,
	moduleUrl: string = import.meta.url,
): string[] {
	if (argv[0] !== "bun") return [...argv];
	if (argv[1] === "run" && typeof argv[2] === "string") {
		return [...hostCommand(argv[2], bun, moduleUrl), ...argv.slice(3)];
	}
	return [bun, ...HOST_BUN_FLAGS, ...argv.slice(1)];
}
