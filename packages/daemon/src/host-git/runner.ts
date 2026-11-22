/**
 * HostGit: the one way the daemon runs git against anything an agent could
 * have written to.
 *
 * Contract (the sandbox design, "Host git is fetch-only"): the host never runs
 * git with an agent-writable gitdir or work tree. Overriding `fsmonitor` and
 * `hooksPath` is not enough, since `filter.*`, `diff.*.textconv`,
 * `credential.helper`, `core.sshCommand`, `gpg.program` and `include.path` all
 * run programs. So this runner
 *
 *  - refuses a cwd, gitdir or work tree that resolves under the workspace
 *    root (symlinks resolved), and the options that could smuggle one in
 *    (`-C`, `--git-dir`, `--work-tree`, `-c`, `--upload-pack`, ...);
 *  - runs git with a scrubbed environment (no global or system config, no
 *    ssh, no prompts) and a fixed `-c` prelude owned by the runner;
 *  - only allows the `file` transport for a source inside an mfw-owned root,
 *    and refuses any url that could parse as an option.
 *
 * The only operation meant to touch a clone is a fetch run from a host-owned
 * repository; see `fetch.ts`.
 */
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { type ProcResult, runProc } from "../proc.ts";

export type HostGitErrorCode =
	| "path_under_workspace"
	| "option_injection"
	| "bad_argument"
	| "bad_run_id"
	| "precondition"
	| "alternates"
	| "bad_bundle"
	| "no_branch"
	| "fetch_failed"
	| "validation";

export class HostGitError extends Error {
	constructor(
		readonly code: HostGitErrorCode,
		message: string,
	) {
		super(message);
		this.name = "HostGitError";
	}
}

export interface HostGitOptions {
	/** Root of the agent-writable workspaces. Nothing under it is ever a cwd, gitdir or work tree. */
	workspaceRoot: string;
	/**
	 * Roots the `file` transport may read from. Always includes the workspace
	 * root (a clone is the fetch source) and the scratch root of throwaway repos.
	 */
	ownedRoots?: string[];
	/** The git binary. Tests inject a fake; default `git`. */
	gitBin?: string;
	/** Environment the child inherits from (PATH, LANG, TMPDIR only). Default `process.env`. */
	baseEnv?: NodeJS.ProcessEnv;
}

export interface HostGitRunOpts {
	/** A host-owned directory. Refused under the workspace root. */
	cwd: string;
	/** Allow the `file` transport (fetch from a mfw-owned local path). */
	allowFile?: boolean;
	/** Host-owned explicit gitdir; refused under the workspace root. */
	gitDir?: string;
	/** Host-owned explicit work tree; refused under the workspace root. */
	workTree?: string;
	timeoutMs?: number;
	maxOutputBytes?: number;
}

export interface HostGitResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	raw: ProcResult;
}

/** Options that run a program or redirect git to another repo or config. Refused before `--`. */
const FORBIDDEN_OPTIONS = [
	"-c",
	"-C",
	"--config",
	"--config-env",
	"--git-dir",
	"--work-tree",
	"--exec-path",
	"--namespace",
	"--super-prefix",
	"--upload-pack",
	"--receive-pack",
	"--exec",
	"--ssh-command",
	"--template",
	"--separate-git-dir",
];

/** Env vars inherited from the daemon. Everything else is dropped. */
const INHERITED_ENV = ["PATH", "LANG", "LC_ALL", "TMPDIR", "TZ"];

/** realpath that tolerates a missing tail: resolve the nearest existing ancestor. */
export function resolveReal(p: string): string {
	const abs = resolve(p);
	const tail: string[] = [];
	let cur = abs;
	for (;;) {
		try {
			return join(realpathSync(cur), ...tail.reverse());
		} catch {
			const parent = dirname(cur);
			if (parent === cur) return abs;
			tail.push(basename(cur));
			cur = parent;
		}
	}
}

export function isUnder(path: string, root: string): boolean {
	const p = resolveReal(path);
	const r = resolveReal(root);
	return p === r || p.startsWith(r.endsWith(sep) ? r : r + sep);
}

/** A url or path that git could parse as an option, or that is not an absolute local path. */
export function assertLocalSource(source: string): void {
	if (source.startsWith("-")) {
		throw new HostGitError(
			"option_injection",
			`refusing a source starting with "-": ${JSON.stringify(source)}`,
		);
	}
	if (source.includes("\0") || source.includes("\n")) {
		throw new HostGitError("bad_argument", "source contains a control char");
	}
	if (!isAbsolute(source)) {
		throw new HostGitError(
			"bad_argument",
			`source must be an absolute local path: ${JSON.stringify(source)}`,
		);
	}
}

export class HostGit {
	readonly workspaceRoot: string;
	readonly ownedRoots: string[];
	private readonly gitBin: string;
	private readonly baseEnv: NodeJS.ProcessEnv;

	constructor(opts: HostGitOptions) {
		if (!isAbsolute(opts.workspaceRoot)) {
			throw new HostGitError("bad_argument", "workspaceRoot must be absolute");
		}
		this.workspaceRoot = resolveReal(opts.workspaceRoot);
		this.ownedRoots = [
			this.workspaceRoot,
			...(opts.ownedRoots ?? []).map(resolveReal),
		];
		this.gitBin = opts.gitBin ?? "git";
		this.baseEnv = opts.baseEnv ?? process.env;
	}

	/** True when `p` is, or resolves into, the workspace root. */
	isWorkspacePath(p: string): boolean {
		return isUnder(p, this.workspaceRoot);
	}

	/** True when `p` is inside a root the `file` transport may read. */
	isOwnedPath(p: string): boolean {
		return this.ownedRoots.some((r) => isUnder(p, r));
	}

	/** The scrubbed environment every host git child gets. */
	env(): Record<string, string> {
		const env: Record<string, string> = {};
		for (const k of INHERITED_ENV) {
			const v = this.baseEnv[k];
			if (v != null) env[k] = v;
		}
		env.GIT_CONFIG_GLOBAL = "/dev/null";
		env.GIT_CONFIG_SYSTEM = "/dev/null";
		env.GIT_CONFIG_NOSYSTEM = "1";
		env.GIT_SSH_COMMAND = "false";
		env.GIT_TERMINAL_PROMPT = "0";
		env.GIT_ASKPASS = "false";
		env.GIT_ATTR_NOSYSTEM = "1";
		env.GIT_NO_REPLACE_OBJECTS = "1";
		env.GIT_OPTIONAL_LOCKS = "0";
		env.HOME = "/nonexistent";
		return env;
	}

	/** The fixed `-c` prelude: no transport, fsck on, no hooks. */
	configArgs(opts: { allowFile?: boolean }): string[] {
		const c = [
			"-c",
			"protocol.allow=never",
			"-c",
			"transfer.fsckObjects=true",
			"-c",
			"fetch.fsckObjects=true",
			"-c",
			"core.hooksPath=/dev/null",
			"-c",
			"core.fsmonitor=false",
			"-c",
			"gc.auto=0",
			"-c",
			"maintenance.auto=false",
			"-c",
			"fetch.recurseSubmodules=false",
		];
		if (opts.allowFile) c.push("-c", "protocol.file.allow=always");
		return c;
	}

	private assertHostOwned(label: string, p: string): void {
		if (this.isWorkspacePath(p)) {
			throw new HostGitError(
				"path_under_workspace",
				`refusing ${label} under the workspace root: ${p}`,
			);
		}
		// A gitfile inside an otherwise host-owned dir may point back into a clone.
		const dotgit = join(p, ".git");
		try {
			if (lstatSync(dotgit).isFile()) {
				const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotgit, "utf8"));
				const target = m?.[1]?.trim();
				if (target && this.isWorkspacePath(resolve(p, target))) {
					throw new HostGitError(
						"path_under_workspace",
						`refusing ${label} whose gitfile points under the workspace root: ${p}`,
					);
				}
			}
		} catch (e) {
			if (e instanceof HostGitError) throw e;
		}
	}

	/** Validate `args` and `opts` without running anything. Throws a HostGitError. */
	check(args: string[], opts: HostGitRunOpts): void {
		this.assertHostOwned("cwd", opts.cwd);
		if (opts.gitDir) this.assertHostOwned("gitdir", opts.gitDir);
		if (opts.workTree) this.assertHostOwned("work tree", opts.workTree);

		const dd = args.indexOf("--");
		const optionPart = dd === -1 ? args : args.slice(0, dd);
		for (const a of optionPart) {
			const flag = a.startsWith("--") ? (a.split("=")[0] as string) : a;
			if (
				FORBIDDEN_OPTIONS.includes(a) ||
				FORBIDDEN_OPTIONS.includes(flag) ||
				a.startsWith("-c") ||
				a.startsWith("-C")
			) {
				throw new HostGitError(
					"option_injection",
					`refusing git option ${JSON.stringify(a)}: the runner owns config and repo selection`,
				);
			}
		}
		// Anything after `--` is data; it still must not look like an option to a
		// shell-ish transport, and an absolute path under the workspace is only
		// ever a fetch source, never an operand of a local-repo command.
		if (dd !== -1) {
			for (const a of args.slice(dd + 1)) {
				if (a.includes("\0")) {
					throw new HostGitError("bad_argument", "argument contains NUL");
				}
			}
		}
	}

	async run(args: string[], opts: HostGitRunOpts): Promise<HostGitResult> {
		this.check(args, opts);
		const prefix: string[] = [];
		if (opts.gitDir) prefix.push(`--git-dir=${opts.gitDir}`);
		if (opts.workTree) prefix.push(`--work-tree=${opts.workTree}`);
		const raw = await runProc(
			[
				this.gitBin,
				...this.configArgs({ allowFile: opts.allowFile === true }),
				...prefix,
				...args,
			],
			{
				cwd: opts.cwd,
				env: this.env(),
				timeoutMs: opts.timeoutMs ?? 120_000,
				...(opts.maxOutputBytes ? { maxOutputBytes: opts.maxOutputBytes } : {}),
			},
		);
		return {
			exitCode: raw.exitCode ?? -1,
			stdout: raw.stdout.trim(),
			stderr: raw.stderr.trim(),
			raw,
		};
	}

	/** run + throw on a non-zero exit. */
	async runOk(args: string[], opts: HostGitRunOpts): Promise<string> {
		const r = await this.run(args, opts);
		if (r.exitCode !== 0) {
			throw new HostGitError(
				"fetch_failed",
				`git ${args.slice(0, 2).join(" ")} failed (${r.exitCode}): ${r.stderr || r.stdout}`,
			);
		}
		return r.stdout;
	}
}
