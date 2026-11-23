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
import { isUnder, resolveReal } from "./paths.ts";

export { isUnder, resolveReal };

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
	/**
	 * Address-space cap for every git child (`ulimit -v`). A 16 KiB bundle of
	 * chained deltas inflates to gigabytes inside `index-pack`, so the cap, not
	 * the bundle size, bounds host memory. Default 2 GiB; a child that hits it
	 * dies and the call fails.
	 */
	maxMemoryBytes?: number;
	/** CPU-time cap for every git child (`ulimit -t`), seconds. Default 120. */
	maxCpuSeconds?: number;
	/** Environment the child inherits from (PATH, LANG, TMPDIR only). Default `process.env`. */
	baseEnv?: NodeJS.ProcessEnv;
	/**
	 * The only urls a submodule seed may fetch from: exact urls, or `prefix/*`
	 * entries. Empty (the default) means no remote fetch is possible at all.
	 */
	submoduleAllowlist?: string[];
	/**
	 * Absolute path of `ssh`. Without it an `ssh` seed is refused, because the
	 * runner otherwise sets `GIT_SSH_COMMAND=false`.
	 */
	sshBin?: string;
}

/** The one transport a seed fetch may enable. Never `file`, `ext` or the dumb `http`. */
export type SeedProtocol = "https" | "ssh" | "git";

export interface HostGitRunOpts {
	/** A host-owned directory. Refused under the workspace root. */
	cwd: string;
	/** Allow the `file` transport (fetch from a mfw-owned local path). */
	allowFile?: boolean;
	/**
	 * A submodule seed: fetch one sha from an allowlisted url into a scratch bare
	 * repo, enabling only this scheme for the call. `fetch` only; exclusive with
	 * `allowFile`.
	 */
	allowProtocol?: SeedProtocol;
	/**
	 * The repository to act on: a bare gitdir, or a work tree with a real `.git`
	 * directory. Required for every subcommand except `init`. It is always passed
	 * as an explicit `--git-dir`, so git never discovers a repo from `cwd`.
	 */
	repo?: string;
	/** stdin; only `update-ref --stdin` takes it, and its lines are validated. */
	input?: string;
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
interface OperandCtx {
	host: HostGit;
	repo?: string;
	allowProtocol?: SeedProtocol;
	/** The flags that were passed (exact allowlisted strings or `--name=value`). */
	flags: string[];
	input?: string;
}

interface SubcommandSpec {
	flags?: string[];
	valued?: string[];
	/** Operands must follow a `--` (anything that may be a path or url). */
	requireDashDash?: boolean;
	/** Checks every operand. Absent means the subcommand takes none. */
	operands?: (ops: string[], ctx: OperandCtx) => void;
}

const ID = "[A-Za-z0-9][A-Za-z0-9_-]{0,127}";
/** The only refspecs HostGit builds, nothing wider: source in the bundle or throwaway repo, destination in refs/mfw. */
const REFSPEC_SHAPES = [
	new RegExp(`^\\+refs/heads/mfw/${ID}:refs/mfw/run/head$`),
	new RegExp(`^\\+refs/heads/mfw-wip/${ID}/\\*:refs/mfw/run/wip/\\*$`),
	// into a per-attempt namespace of the primary; a transaction then moves them
	new RegExp(`^\\+refs/mfw/run/head:refs/mfw/incoming/${ID}/head$`),
	new RegExp(`^\\+refs/mfw/run/wip/\\*:refs/mfw/incoming/${ID}/wip/\\*$`),
];
/** A seed fetches one full sha into `refs/mfw/submodule/<id>`: no branch names, no globs. */
const SEED_REFSPEC = new RegExp(`^\\+[0-9a-f]{40}:refs/mfw/submodule/${ID}$`);
const HOST = "[A-Za-z0-9][A-Za-z0-9.-]{0,252}";
const PATH_PART = "[A-Za-z0-9._~%+/-]{1,400}";
/** The urls a seed may use, per scheme. No userinfo on https or git; ssh allows a user name. */
const SEED_URL: Record<SeedProtocol, RegExp[]> = {
	https: [new RegExp(`^https://${HOST}(?::[0-9]{1,5})?/${PATH_PART}$`)],
	git: [new RegExp(`^git://${HOST}(?::[0-9]{1,5})?/${PATH_PART}$`)],
	ssh: [
		new RegExp(
			`^ssh://(?:[A-Za-z0-9._-]{1,64}@)?${HOST}(?::[0-9]{1,5})?/${PATH_PART}$`,
		),
		new RegExp(`^[A-Za-z0-9._-]{1,64}@${HOST}:${PATH_PART}$`),
	],
};

/** True when `url` is listed exactly, or starts with a `prefix/*` entry's prefix. */
export function urlAllowed(url: string, allowlist: readonly string[]): boolean {
	return allowlist.some((a) =>
		a.endsWith("/*") ? url.startsWith(a.slice(0, -1)) : url === a,
	);
}

/** Refs the host may create or delete: the quarantine namespaces, and nothing else. */
const REF_BODY = `refs/mfw/(?:quarantine|quarantine-wip|incoming)/${ID}(?:/[A-Za-z0-9_-]{1,128}){0,8}`;
const QUARANTINE_REF = new RegExp(`^${REF_BODY}$`);
/** One line of the `update-ref --stdin` transaction HostGit writes. */
const TX_LINE = new RegExp(
	`^(?:start|prepare|commit|update ${REF_BODY} [0-9a-f]{40}|delete ${REF_BODY})$`,
);
const OBJECT_NAME = /^[A-Za-z0-9_/:^~@{}%.-]{1,300}$/;
const REF_PATTERN = /^refs\/[A-Za-z0-9_/.*-]{0,300}$/;

function refuse(msg: string): never {
	throw new HostGitError("bad_argument", msg);
}

function eachOperand(ops: string[], re: RegExp, what: string): void {
	for (const o of ops) {
		if (o.startsWith("-") || !re.test(o)) {
			refuse(`refusing ${what} operand ${JSON.stringify(o.slice(0, 80))}`);
		}
	}
}

const readOperands = (ops: string[]): void =>
	eachOperand(ops, OBJECT_NAME, "object name");

const SUBCOMMANDS: Record<string, SubcommandSpec> = {
	init: {
		flags: ["--bare", "--quiet", "-q"],
		requireDashDash: true,
		operands: (ops, { host }) => {
			if (ops.length !== 1) refuse("git init takes exactly one target");
			host.assertScratchPath(ops[0] as string, "init target");
		},
	},
	fetch: {
		flags: [
			"--no-tags",
			"--no-write-fetch-head",
			"--no-recurse-submodules",
			"--no-auto-gc",
			"--no-auto-maintenance",
			"--no-prune",
			"--force",
			"--atomic",
			"--quiet",
			"-q",
		],
		requireDashDash: true,
		operands: (ops, { host, repo, allowProtocol }) => {
			if (ops.length < 2) refuse("git fetch needs a source and a refspec");
			const [source, ...specs] = ops as [string, ...string[]];
			if (allowProtocol) {
				// A submodule seed: one allowlisted url, one sha, a scratch bare repo.
				if (specs.length !== 1)
					refuse("a seed fetch takes exactly one refspec");
				if (!repo) refuse("a seed fetch needs its target repo");
				host.assertScratchPath(repo, "seed target");
				host.assertSeedSource(source, allowProtocol);
				if (!SEED_REFSPEC.test(specs[0] as string)) {
					refuse(
						`refusing seed refspec ${JSON.stringify((specs[0] as string).slice(0, 120))}`,
					);
				}
				return;
			}
			// The source is a mfw-owned scratch file or throwaway repo, never a clone.
			host.assertScratchPath(source, "fetch source");
			if (isDirectory(source)) host.resolveGitDir(source);
			for (const spec of specs) {
				if (!REFSPEC_SHAPES.some((re) => re.test(spec))) {
					refuse(`refusing refspec ${JSON.stringify(spec.slice(0, 120))}`);
				}
			}
		},
	},
	"for-each-ref": {
		valued: ["--format", "--count", "--sort"],
		operands: (ops) => eachOperand(ops, REF_PATTERN, "ref pattern"),
	},
	"rev-parse": {
		flags: ["--verify", "--quiet", "-q", "--is-bare-repository", "--git-dir"],
		operands: readOperands,
	},
	"cat-file": {
		flags: ["-e", "-t", "-s", "-p", "--batch-check", "--batch"],
		operands: readOperands,
	},
	"rev-list": {
		flags: ["--count", "--objects", "--no-walk"],
		valued: ["--max-count"],
		operands: readOperands,
	},
	"show-ref": {
		flags: ["--verify", "--quiet", "--hash"],
		operands: (ops) => eachOperand(ops, REF_PATTERN, "ref"),
	},
	"merge-base": { flags: ["--is-ancestor"], operands: readOperands },
	"ls-tree": {
		flags: ["-r", "-z", "-l", "-t", "--name-only", "--full-tree"],
		operands: readOperands,
	},
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
		operands: readOperands,
	},
	// read-only: lets tests and the doctor show the effective config
	config: {
		flags: ["--list", "--show-origin"],
		operands: (ops) => {
			if (ops.length > 0)
				refuse("git config takes no operands: it is read-only here");
		},
	},
	"update-ref": {
		flags: ["-d", "--no-deref", "--stdin"],
		operands: (ops, { flags, input }) => {
			if (flags.includes("--stdin")) {
				// A transaction the runner's typed method wrote: every line is checked.
				if (ops.length > 0 || flags.length !== 1 || input === undefined) {
					refuse("update-ref --stdin takes only stdin");
				}
				const lines = input.split("\n").filter((l) => l !== "");
				if (lines.length === 0 || lines.some((l) => !TX_LINE.test(l))) {
					refuse(
						"update-ref --stdin has a line outside the quarantine namespaces",
					);
				}
				return;
			}
			const [ref, extra] = ops;
			if (!ref || !QUARANTINE_REF.test(ref)) {
				refuse(
					`refusing to update ${JSON.stringify((ref ?? "").slice(0, 120))}: only the quarantine namespaces`,
				);
			}
			const deleting = flags.includes("-d");
			if (ops.length > 2 || (!deleting && ops.length !== 2))
				refuse("bad update-ref operands");
			if (extra !== undefined && !/^[0-9a-f]{40}$/.test(extra))
				refuse("bad object id");
		},
	},
};

function isDirectory(p: string): boolean {
	try {
		return lstatSync(p).isDirectory();
	} catch {
		return false;
	}
}

export const DEFAULT_MAX_MEMORY_BYTES = 2 * 1024 * 1024 * 1024;
export const DEFAULT_MAX_CPU_SECONDS = 120;

/** Env vars inherited from the daemon. Everything else is dropped. */
const INHERITED_ENV = ["PATH", "LANG", "LC_ALL", "TMPDIR", "TZ"];

function readSmallFile(p: string): string | undefined {
	try {
		return readFileSync(p, "utf8").slice(0, 64 * 1024);
	} catch {
		return undefined;
	}
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
	/** Owned roots outside the workspace: the only places init and fetch may use. */
	readonly scratchRoots: string[];
	private readonly gitBin: string;
	private readonly maxMemoryKiB: number;
	private readonly maxCpuSeconds: number;
	private readonly baseEnv: NodeJS.ProcessEnv;
	private readonly submoduleAllowlist: string[];
	private readonly sshBin: string | undefined;

	constructor(opts: HostGitOptions) {
		if (!isAbsolute(opts.workspaceRoot)) {
			throw new HostGitError("bad_argument", "workspaceRoot must be absolute");
		}
		this.workspaceRoot = resolveReal(opts.workspaceRoot);
		this.ownedRoots = [
			this.workspaceRoot,
			...(opts.ownedRoots ?? []).map(resolveReal),
		];
		this.scratchRoots = (opts.ownedRoots ?? [])
			.map(resolveReal)
			.filter((r) => !isUnder(r, this.workspaceRoot));
		// Resolve git once, to an absolute path: a later change to PATH cannot swap it.
		const bin =
			opts.gitBin ??
			Bun.which("git", { PATH: (opts.baseEnv ?? process.env).PATH ?? "" });
		if (!bin || !isAbsolute(bin)) {
			throw new HostGitError(
				"bad_argument",
				"cannot resolve an absolute path to git",
			);
		}
		this.gitBin = bin;
		this.maxMemoryKiB = Math.floor(
			(opts.maxMemoryBytes ?? DEFAULT_MAX_MEMORY_BYTES) / 1024,
		);
		this.maxCpuSeconds = opts.maxCpuSeconds ?? DEFAULT_MAX_CPU_SECONDS;
		if (this.maxMemoryKiB < 1 || this.maxCpuSeconds < 1) {
			throw new HostGitError("bad_argument", "limits must be positive");
		}
		this.baseEnv = opts.baseEnv ?? process.env;
		this.submoduleAllowlist = [...(opts.submoduleAllowlist ?? [])];
		if (
			opts.sshBin !== undefined &&
			!/^\/[A-Za-z0-9._/+-]{1,300}$/.test(opts.sshBin)
		) {
			throw new HostGitError(
				"bad_argument",
				"sshBin must be a plain absolute path",
			);
		}
		this.sshBin = opts.sshBin;
	}

	/** The url must be on the allowlist, well formed, and of the one scheme this call enables. */
	assertSeedSource(url: string, protocol: SeedProtocol): void {
		if (!(protocol in SEED_URL)) refuse(`refusing protocol ${protocol}`);
		if (url.startsWith("-") || url.includes("\0") || url.length > 600) {
			refuse("refusing a seed url that looks like an option");
		}
		if (!SEED_URL[protocol].some((re) => re.test(url))) {
			refuse(
				`refusing seed url ${JSON.stringify(url.slice(0, 120))} for ${protocol}`,
			);
		}
		if (!urlAllowed(url, this.submoduleAllowlist)) {
			refuse(
				`seed url ${JSON.stringify(url.slice(0, 120))} is not on the allowlist`,
			);
		}
		if (protocol === "ssh" && !this.sshBin) {
			refuse("ssh seeds are not configured (no sshBin)");
		}
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
	env(opts: { allowProtocol?: SeedProtocol } = {}): Record<string, string> {
		const env: Record<string, string> = {};
		for (const k of INHERITED_ENV) {
			const v = this.baseEnv[k];
			if (v != null) env[k] = v;
		}
		env.GIT_CONFIG_GLOBAL = "/dev/null";
		env.GIT_CONFIG_SYSTEM = "/dev/null";
		env.GIT_CONFIG_NOSYSTEM = "1";
		env.GIT_SSH_COMMAND =
			opts.allowProtocol === "ssh" && this.sshBin
				? `${this.sshBin} -F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=yes -o ClearAllForwardings=yes`
				: "false";
		env.GIT_TERMINAL_PROMPT = "0";
		env.GIT_ASKPASS = "false";
		env.GIT_ATTR_NOSYSTEM = "1";
		env.GIT_NO_REPLACE_OBJECTS = "1";
		env.GIT_OPTIONAL_LOCKS = "0";
		env.MALLOC_ARENA_MAX = "1";
		env.HOME = "/nonexistent";
		return env;
	}

	/** The fixed `-c` prelude: no transport, fsck on, no hooks. */
	configArgs(opts: {
		allowFile?: boolean;
		allowProtocol?: SeedProtocol;
	}): string[] {
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
			// One thread: under an address-space cap every extra thread reserves a
			// stack and a malloc arena, which can exhaust the cap on a many-core host.
			"-c",
			"pack.threads=1",
			"-c",
			"core.alternateRefsCommand=",
		];
		if (opts.allowFile) c.push("-c", "protocol.file.allow=always");
		if (opts.allowProtocol) {
			// Only the scheme the allowlisted url needs, and no redirect to another host.
			c.push(
				"-c",
				`protocol.${opts.allowProtocol}.allow=always`,
				"-c",
				"http.followRedirects=false",
			);
		}
		return c;
	}

	/** An absolute path inside a scratch root, outside the workspace. */
	assertScratchPath(p: string, what: string): void {
		assertLocalSource(p);
		if (this.isWorkspacePath(p)) {
			throw new HostGitError(
				"path_under_workspace",
				`refusing ${what} under the workspace root`,
			);
		}
		if (!this.scratchRoots.some((r) => isUnder(p, r))) {
			refuse(`refusing ${what} outside the scratch roots`);
		}
	}

	/** Refuse a path that is, or resolves into, the workspace root. */
	private assertHostOwned(label: string, p: string): void {
		if (this.isWorkspacePath(p)) {
			throw new HostGitError(
				"path_under_workspace",
				`refusing ${label} under the workspace root: ${p}`,
			);
		}
	}

	/**
	 * The effective gitdir for `repo`, checked end to end: a `.git` that is a
	 * symlink or a gitfile is refused (it can point at a clone), and neither the
	 * gitdir nor its common dir, alternates or the repo's own top-level entries
	 * may resolve under the workspace root.
	 */
	resolveGitDir(repo: string): string {
		this.assertHostOwned("repo", repo);
		let gitDir = repo;
		const dotgit = join(repo, ".git");
		let st: ReturnType<typeof lstatSync> | undefined;
		try {
			st = lstatSync(dotgit);
		} catch {
			// a bare gitdir
		}
		if (st) {
			if (!st.isDirectory()) {
				throw new HostGitError(
					"path_under_workspace",
					st.isSymbolicLink()
						? `refusing a repo whose .git is a symlink: ${repo}`
						: `refusing a repo whose .git is a file (a linked worktree; host repos must be plain clones): ${repo}`,
				);
			}
			gitDir = dotgit;
		}
		this.assertHostOwned("gitdir", gitDir);
		for (const rel of [
			"objects",
			"refs",
			"packed-refs",
			"config",
			"HEAD",
			"info",
			join("objects", "info"),
			join("objects", "pack"),
		]) {
			// A symlink here is fine only if it stays out of the workspace.
			this.assertHostOwned(`${rel} of the gitdir`, join(gitDir, rel));
		}
		const common = readSmallFile(join(gitDir, "commondir"));
		if (common !== undefined) {
			this.assertHostOwned("commondir", resolve(gitDir, common.trim()));
		}
		for (const alt of ["alternates", "http-alternates"]) {
			const text = readSmallFile(join(gitDir, "objects", "info", alt));
			if (text === undefined) continue;
			for (const line of text.split("\n")) {
				const l = line.trim();
				if (l === "" || l.startsWith("#")) continue;
				this.assertHostOwned(`${alt} entry`, resolve(gitDir, "objects", l));
			}
		}
		return gitDir;
	}

	/** Validate `args` and `opts` without running anything. Throws a HostGitError. */
	check(args: string[], opts: HostGitRunOpts): void {
		this.assertHostOwned("cwd", opts.cwd);
		if (opts.allowProtocol) {
			if (args[0] !== "fetch" || opts.allowFile) {
				refuse(
					"allowProtocol is for a seed fetch only, and excludes allowFile",
				);
			}
		}

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
		if (sub !== "init") {
			if (!opts.repo) {
				throw new HostGitError(
					"bad_argument",
					`git ${sub}: an explicit repo is required`,
				);
			}
			this.resolveGitDir(opts.repo);
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
		const positional =
			dd === -1
				? args.slice(1).filter((a) => !a.startsWith("-"))
				: [
						...args.slice(1, dd).filter((a) => !a.startsWith("-")),
						...args.slice(dd + 1),
					];
		if (
			spec.requireDashDash &&
			args.slice(1, dd).some((a) => !a.startsWith("-"))
		) {
			refuse(`git ${sub}: operands must follow "--"`);
		}
		if (!spec.operands && positional.length > 0) {
			refuse(`git ${sub} takes no operands`);
		}
		if (
			opts.input !== undefined &&
			!(sub === "update-ref" && optionPart.includes("--stdin"))
		) {
			refuse(`git ${sub} takes no stdin`);
		}
		spec.operands?.(positional, {
			host: this,
			flags: optionPart.filter((a) => a.startsWith("-")),
			...(opts.repo ? { repo: opts.repo } : {}),
			...(opts.allowProtocol ? { allowProtocol: opts.allowProtocol } : {}),
			...(opts.input !== undefined ? { input: opts.input } : {}),
		});
		for (const a of args) {
			if (a.includes("\0")) {
				throw new HostGitError("bad_argument", "argument contains NUL");
			}
		}
	}

	async run(args: string[], opts: HostGitRunOpts): Promise<HostGitResult> {
		this.check(args, opts);
		const prefix: string[] = [];
		if (opts.repo) prefix.push(`--git-dir=${this.resolveGitDir(opts.repo)}`);
		const raw = await runProc(
			[
				// Resource limits first, then exec git: a failed ulimit never runs git unbounded.
				"/bin/sh",
				"-c",
				'ulimit -v "$1" && ulimit -t "$2" || exit 125; shift 2; exec "$@"',
				"mfw-host-git",
				String(this.maxMemoryKiB),
				String(this.maxCpuSeconds),
				this.gitBin,
				...this.configArgs({
					allowFile: opts.allowFile === true,
					...(opts.allowProtocol ? { allowProtocol: opts.allowProtocol } : {}),
				}),
				...prefix,
				...args,
			],
			{
				cwd: opts.cwd,
				...(opts.input !== undefined ? { input: opts.input } : {}),
				// Never discover a repo above cwd (a parent `.git` symlinked into a clone).
				env: {
					...this.env(
						opts.allowProtocol ? { allowProtocol: opts.allowProtocol } : {},
					),
					GIT_CEILING_DIRECTORIES: dirname(resolve(opts.cwd)),
				},
				timeoutMs: opts.timeoutMs ?? 120_000,
				...(opts.maxOutputBytes ? { maxOutputBytes: opts.maxOutputBytes } : {}),
				hostGitChecked: true,
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
