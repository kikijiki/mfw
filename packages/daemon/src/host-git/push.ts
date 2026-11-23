/**
 * The push after a merge (backstage architecture.md, "Host-executed paths").
 *
 * A push is the one host git operation that needs the operator's credentials,
 * so it cannot use HostGit's empty config. It keeps the operator's global and
 * system config, and treats everything the repository controls as hostile:
 *
 *  - hooks never run (`core.hooksPath=/dev/null` and `--no-verify`);
 *  - the `ext` transport, signing and submodule recursion are off;
 *  - before the push, the effective config is audited. A key that can run a
 *    program and comes from the repository (local or worktree scope, or a file
 *    inside the project reached through an include) refuses the push.
 *
 * Credential helpers and `core.sshCommand` from the operator's own config keep
 * working. The same keys in `.git/config` are refused rather than overridden,
 * because silently dropping them would turn a tampered config into a confusing
 * authentication failure.
 *
 * Residual: the audit and the push are two processes. A writer that can edit
 * `.git/config` between them (a worktree run; a clone run cannot reach it) wins
 * that race for keys the `-c` overrides below do not pin.
 */
import { isAbsolute, resolve } from "node:path";
import { isDangerousGitKey } from "../containment/git-config-scan.ts";
import { runProc } from "../proc.ts";
import { requireHostTool } from "../sandbox.ts";
import { isUnder } from "./runner.ts";

export type HardenedPushResult =
	| { status: "pushed" }
	/** Nothing was pushed, because repository content could have run a program. */
	| { status: "refused"; reason: string }
	| { status: "error"; reason: string };

/** What the push needs from the daemon's env. `GIT_*` is deliberately absent. */
const PUSH_ENV = [
	"PATH",
	"HOME",
	"LANG",
	"LC_ALL",
	"TZ",
	"TMPDIR",
	"XDG_CONFIG_HOME",
	"XDG_RUNTIME_DIR",
	"SSH_AUTH_SOCK",
	"SSL_CERT_FILE",
	"NIX_SSL_CERT_FILE",
	"HTTPS_PROXY",
	"https_proxy",
	"NO_PROXY",
	"no_proxy",
] as const;

/** Pinned by {@link PUSH_OVERRIDES}, so their repository value is inert. */
const NEUTRALIZED = new Set(["core.hookspath", "core.fsmonitor"]);

const PUSH_OVERRIDES = [
	"core.hooksPath=/dev/null",
	"core.fsmonitor=false",
	"core.alternateRefsCommand=",
	"protocol.ext.allow=never",
	"push.recurseSubmodules=no",
	"submodule.recurse=false",
	"push.gpgSign=false",
	"gc.auto=0",
	"maintenance.auto=false",
];

const SAFE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,200}$/;

export function pushEnv(
	source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const key of PUSH_ENV) {
		const value = source[key];
		if (value !== undefined) env[key] = value;
	}
	env.GIT_TERMINAL_PROMPT = "0";
	return env;
}

/**
 * The repository-controlled keys that could run a program, from the output of
 * `git config --list --show-scope --show-origin -z`. Throws on output it cannot
 * read, so an unparsable config never counts as clean.
 */
export function repoControlledExecKeys(
	listing: string,
	projectRoot: string,
): string[] {
	const fields = listing.split("\0");
	if (fields.at(-1) === "") fields.pop();
	if (fields.length % 3 !== 0) {
		throw new Error("unreadable git config listing");
	}
	const found = new Set<string>();
	for (let i = 0; i < fields.length; i += 3) {
		const scope = fields[i] as string;
		const origin = fields[i + 1] as string;
		const entry = fields[i + 2] as string;
		const newline = entry.indexOf("\n");
		const key = (newline < 0 ? entry : entry.slice(0, newline)).toLowerCase();
		if (NEUTRALIZED.has(key) || !isDangerousGitKey(key)) continue;
		if (isRepoControlled(scope, origin, projectRoot)) found.add(key);
	}
	return [...found].sort();
}

function isRepoControlled(
	scope: string,
	origin: string,
	projectRoot: string,
): boolean {
	if (scope !== "global" && scope !== "system") return true;
	if (!origin.startsWith("file:")) return true;
	const path = origin.slice("file:".length);
	return isUnder(
		isAbsolute(path) ? path : resolve(projectRoot, path),
		projectRoot,
	);
}

/** Push exactly `branch` to the same branch on `remote`. Never throws. */
export async function hardenedPush(opts: {
	projectRoot: string;
	remote: string;
	branch: string;
	environment?: NodeJS.ProcessEnv;
	timeoutMs?: number;
}): Promise<HardenedPushResult> {
	const { projectRoot, remote, branch } = opts;
	if (!SAFE_NAME.test(remote) || !SAFE_NAME.test(branch)) {
		return {
			status: "refused",
			reason: `refusing to push: unsafe remote or branch name (${JSON.stringify(remote.slice(0, 60))}, ${JSON.stringify(branch.slice(0, 60))}). Fix: rename it to plain letters, digits, '.', '_', '/' or '-'.`,
		};
	}
	let gitBin: string;
	try {
		gitBin = requireHostTool("git");
	} catch (e) {
		return { status: "error", reason: (e as Error).message };
	}
	const env = pushEnv(opts.environment);
	const audit = await runProc(
		[gitBin, "config", "--list", "--show-scope", "--show-origin", "-z"],
		{ cwd: projectRoot, env },
	);
	if (audit.exitCode !== 0 || audit.truncated) {
		return {
			status: "refused",
			reason: `refusing to push: could not audit the git config (${audit.stderr.trim().slice(-200) || "output too large"}). Fix: make \`git config --list\` succeed in the project.`,
		};
	}
	let keys: string[];
	try {
		keys = repoControlledExecKeys(audit.stdout, projectRoot);
	} catch (e) {
		return {
			status: "refused",
			reason: `refusing to push: ${(e as Error).message}. Fix: repair the project's git config.`,
		};
	}
	if (keys.length > 0) {
		return {
			status: "refused",
			reason: `refusing to push: the repository's git config sets keys that can run a program (${keys.join(", ")}). Fix: remove them from .git/config, or move them to your global git config if you set them yourself.`,
		};
	}
	const argv = [gitBin];
	for (const override of PUSH_OVERRIDES) argv.push("-c", override);
	argv.push(
		"push",
		"--no-verify",
		"--no-signed",
		"--no-recurse-submodules",
		"--",
		remote,
		`refs/heads/${branch}:refs/heads/${branch}`,
	);
	const pushed = await runProc(argv, {
		cwd: projectRoot,
		env,
		timeoutMs: opts.timeoutMs ?? 5 * 60_000,
	});
	if (pushed.exitCode === 0) return { status: "pushed" };
	return {
		status: "error",
		reason: (pushed.stderr || pushed.stdout).trim().slice(-300),
	};
}
