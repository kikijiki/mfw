/**
 * The push after a merge.
 *
 * A push needs the operator's credentials, so it keeps their global and system
 * config. Everything the repository controls is out of the path:
 *
 *  - it runs from the host-owned landing repository, whose config is empty, so
 *    the primary's hooks, `hook.*`, `url.*`, `pushurl` and remotes are not read;
 *  - the destination is the URL the owner approved in the daemon home
 *    (`pushUrl`), never `remote.<name>.url`;
 *  - a local-path destination runs that repository's receive hooks, so it is
 *    refused unless the owner approved it (`pushAllowLocalUrl`);
 *  - the primary's config must still pass the allowlist, so a tampered
 *    repository surfaces as a refusal instead of going unnoticed.
 *
 * Hooks in the operator's own global config still run: they are theirs.
 */
import { gitOk } from "../git.ts";
import { runProc } from "../proc.ts";
import { requireHostTool } from "../sandbox.ts";
import {
	ensureLandingRepo,
	LANDING_OVERRIDES,
	landingRepoEnv,
} from "./landing.ts";
import { repoConfigRefusal } from "./repo-config.ts";

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

const PUSH_OVERRIDES = [
	"push.recurseSubmodules=no",
	"submodule.recurse=false",
	"push.gpgSign=false",
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

export interface ApprovedPushTarget {
	url: string;
	allowLocal?: boolean;
}

const SCP_URL = /^[A-Za-z0-9._-]{1,64}@[A-Za-z0-9.-]{1,253}:[^:\s][^\s]*$/;

function hasControlChar(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code < 0x20 || code === 0x7f) return true;
	}
	return false;
}

/** Why `url` may not be pushed to, or null. */
export function pushUrlRefusal(target: ApprovedPushTarget): string | null {
	const { url } = target;
	if (url.startsWith("-") || hasControlChar(url)) {
		return "the approved push URL contains an option prefix or a control character";
	}
	if (/^(?:https|ssh):\/\/[^/]/.test(url) || SCP_URL.test(url)) return null;
	const local =
		url.startsWith("/") || url.startsWith("file://") || !url.includes(":");
	if (!local) return `the approved push URL has an unsupported scheme (${url})`;
	if (!target.allowLocal) {
		return `the approved push URL is a local path, whose hooks would run on this machine (${url})`;
	}
	return null;
}

/** Push exactly `branch` to the same branch at the approved URL. Never throws. */
export async function hardenedPush(opts: {
	projectRoot: string;
	branch: string;
	target: ApprovedPushTarget | null;
	landingRoot?: string;
	environment?: NodeJS.ProcessEnv;
	timeoutMs?: number;
}): Promise<HardenedPushResult> {
	const { projectRoot, branch, target } = opts;
	if (!SAFE_NAME.test(branch)) {
		return {
			status: "refused",
			reason: `refusing to push: unsafe branch name (${JSON.stringify(branch.slice(0, 60))}). Fix: rename it to plain letters, digits, '.', '_', '/' or '-'.`,
		};
	}
	if (!target) {
		return {
			status: "refused",
			reason: `refusing to push: no approved push URL. Fix: set "pushUrl" for this project in $MFW_HOME/config.json to the URL you expect, after checking it.`,
		};
	}
	const badUrl = pushUrlRefusal(target);
	if (badUrl) {
		return {
			status: "refused",
			reason: `refusing to push: ${badUrl}. Fix: set "pushUrl" in $MFW_HOME/config.json to an https or ssh URL, or set "pushAllowLocalUrl": true if you trust that repository's hooks.`,
		};
	}
	const refused = await repoConfigRefusal(projectRoot);
	if (refused) {
		return {
			status: "refused",
			reason: `refusing to push: ${refused.message}`,
		};
	}
	try {
		const gitBin = requireHostTool("git");
		const sha = await gitOk(
			["rev-parse", "--verify", "-q", `refs/heads/${branch}^{commit}`],
			projectRoot,
		);
		const repo = await ensureLandingRepo(projectRoot, opts.landingRoot);
		const env = { ...pushEnv(opts.environment), ...landingRepoEnv(repo) };
		const argv = [gitBin, ...LANDING_OVERRIDES];
		for (const override of PUSH_OVERRIDES) argv.push("-c", override);
		argv.push(
			"push",
			"--no-verify",
			"--no-signed",
			"--no-recurse-submodules",
			"--",
			target.url,
			`${sha}:refs/heads/${branch}`,
		);
		const pushed = await runProc(argv, {
			cwd: repo.gitDir,
			env,
			timeoutMs: opts.timeoutMs ?? 5 * 60_000,
		});
		if (pushed.exitCode === 0) return { status: "pushed" };
		return {
			status: "error",
			reason: (pushed.stderr || pushed.stdout).trim().slice(-300),
		};
	} catch (e) {
		return { status: "error", reason: (e as Error).message.slice(-300) };
	}
}
