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

/**
 * The subcommands HostGit will run, each with the exact flags it accepts. This
 * is an allowlist on purpose: git expands abbreviated long options
 * (`--upload-pac=` is `--upload-pack=`) and attached short values (`grep -Oprog`),
 * so a denylist of "dangerous" options cannot be made complete. Anything that
 * starts with `-` and is not listed here, before a `--`, is refused.
 * `flags` are exact; `valued` flags take `--name=value` (value is data, never
 * a program: none of these options execute their value).
 */
interface SubcommandSpec {
	flags?: string[];
	valued?: string[];
	/** Operands must follow a `--` (anything that may be a path or url). */
	requireDashDash?: boolean;
}

const SUBCOMMANDS: Record<string, SubcommandSpec> = {
	init: { flags: ["--bare", "--quiet", "-q"], requireDashDash: true },
	fetch: {
		flags: [
			"--no-tags",
			"--no-write-fetch-head",
			"--no-recurse-submodules",
			"--no-auto-gc",
			"--no-auto-maintenance",
			"--no-prune",
			"--force",
			"--quiet",
			"-q",
		],
		requireDashDash: true,
	},
	"for-each-ref": { valued: ["--format", "--count", "--sort"] },
	"rev-parse": {
		flags: ["--verify", "--quiet", "-q", "--is-bare-repository", "--git-dir"],
	},
	"cat-file": { flags: ["-e", "-t", "-s", "-p", "--batch-check", "--batch"] },
	"rev-list": {
		flags: ["--count", "--objects", "--no-walk"],
		valued: ["--max-count"],
	},
	"show-ref": { flags: ["--verify", "--quiet", "--hash"] },
	"merge-base": { flags: ["--is-ancestor"] },
	"ls-tree": { flags: ["-r", "-z", "-l", "-t", "--name-only", "--full-tree"] },
	"diff-tree": {
		flags: [
			"-r",
			"-z",
			"--raw",
			"--name-status",
			"--name-only",
			"--numstat",
			"--no-renames",
			"--no-ext-diff",
			"--no-textconv",
		],
	},
	// read-only: lets tests and the doctor show the effective config
	config: { flags: ["--list", "--show-origin"] },
	"update-ref": { flags: ["-d", "--no-deref"] },
};

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

		const sub = args[0];
		const spec = sub ? SUBCOMMANDS[sub] : undefined;
		if (!sub || !spec) {
			throw new HostGitError(
				sub?.startsWith("-") ? "option_injection" : "bad_argument",
				`refusing git ${JSON.stringify(sub ?? "")}: not an allowlisted subcommand (global options are the runner's)`,
			);
		}
		const dd = args.indexOf("--");
		if (spec.requireDashDash && dd === -1) {
			throw new HostGitError(
				"bad_argument",
				`git ${sub}: operands must follow a "--"`,
			);
		}
		const optionPart = dd === -1 ? args.slice(1) : args.slice(1, dd);
		for (const a of optionPart) {
			if (!a.startsWith("-")) continue;
			const eq = a.indexOf("=");
			const exact = spec.flags?.includes(a) === true;
			const valued = eq > 0 && spec.valued?.includes(a.slice(0, eq)) === true;
			if (!exact && !valued) {
				throw new HostGitError(
					"option_injection",
					`refusing git ${sub} option ${JSON.stringify(a)}: not on the allowlist`,
				);
			}
		}
		for (const a of args) {
			if (a.includes("\0")) {
				throw new HostGitError("bad_argument", "argument contains NUL");
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
