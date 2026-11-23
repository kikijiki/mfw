/**
 * Pins on the files the host executes (backstage architecture.md, "Host-executed
 * paths"). The rule: the host never executes a file an agent could have written
 * unless the owner approved those exact bytes.
 *
 * `buildExecPin` runs when the owner arms a command. It statically resolves what
 * the command executes (entry script, directly sourced or imported files,
 * package scripts, the shebang interpreter) and records a hash for each.
 * `verifyExecPin` runs immediately before execution and refuses on any
 * difference. Both read through one descriptor opened with `O_NOFOLLOW`, and
 * confirm afterwards that the path still names that inode.
 *
 * A single shell-script command is executed from a sealed private copy of the
 * verified bytes, so there is no window between hash and exec.
 *
 * Residuals, stated so nobody assumes more:
 *  - Static analysis: a file reached only at run time (computed paths, `curl |
 *    sh`, a tool reading its own config, non-relative imports) is not pinned.
 *    Command substitution and shell control flow in the armed string are refused
 *    for this reason, but a pinned script can still do anything it likes.
 *  - Only a sealed entry is free of the race. Sourced files, imports and non-shell
 *    entries are verified just before spawn and re-read by the interpreter.
 *  - Bare tools on PATH are checked for location, not content.
 */
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	open,
	readFile,
	realpath,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";
import { z } from "zod";
import { runProc } from "../proc.ts";
import { requireHostTool } from "../sandbox.ts";

const MAX_PINNED_FILES = 256;
const MAX_PINNED_BYTES = 8 * 1024 * 1024;
const MAX_EXTERNAL_BYTES = 512 * 1024 * 1024;
const READ_FLAGS =
	constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

export const ExecPinSchema = z.object({
	/** The commit the repo files were tracked at; null when none are involved. */
	commit: z.string().nullable(),
	files: z.array(
		z.object({
			/** Relative to the repository root. */
			path: z.string(),
			sha256: z.string(),
			/** Git blob id of the same bytes. */
			blob: z.string(),
			/** Permission bits, so a chmod is a change. */
			mode: z.number().int(),
			role: z.enum(["entry", "source", "config"]),
		}),
	),
	/** Interpreters and absolute commands outside the repository. */
	external: z.array(
		z.object({
			path: z.string(),
			real: z.string(),
			/** Null under `/nix/store`, whose path already names the content. */
			sha256: z.string().nullable(),
		}),
	),
	/** Bare command names, re-resolved at execution and checked for location. */
	tools: z.array(z.string()),
});

export type ExecPin = z.infer<typeof ExecPinSchema>;

export type ExecRefusalCode =
	| "unanalyzable"
	| "unresolved"
	| "symlink"
	| "not_regular"
	| "world_writable"
	| "too_large"
	| "untracked"
	| "content_changed"
	| "mode_changed"
	| "swapped"
	| "missing"
	| "not_at_head"
	| "interpreter_changed"
	| "tool_in_repo";

export interface ExecRefusal {
	ok: false;
	code: ExecRefusalCode;
	path?: string;
	reason: string;
	fix: string;
}

const REARM = "Review the change, then arm the trigger again.";

function refusal(
	code: ExecRefusalCode,
	reason: string,
	fix: string,
	path?: string,
): ExecRefusal {
	return { ok: false, code, reason, fix, ...(path ? { path } : {}) };
}

class Refused extends Error {
	constructor(readonly refusal: ExecRefusal) {
		super(refusal.reason);
	}
}

function fail(
	code: ExecRefusalCode,
	reason: string,
	fix: string,
	path?: string,
): never {
	throw new Refused(refusal(code, reason, fix, path));
}

// Shell analysis

export interface ShellCommand {
	/** Words after leading assignments. A dynamic word is null. */
	words: (string | null)[];
	hasRedirect: boolean;
	hasAssignment: boolean;
}

export interface ShellAnalysis {
	commands: ShellCommand[];
	/** Why this string cannot be fully resolved statically; null when it can. */
	unanalyzable: string | null;
	/** Exactly one command, joined by nothing: eligible for a sealed exec. */
	simple: boolean;
}

const KEYWORDS = new Set([
	"if",
	"then",
	"elif",
	"else",
	"fi",
	"for",
	"while",
	"until",
	"do",
	"done",
	"case",
	"esac",
	"function",
	"select",
	"eval",
	"trap",
]);
/** Assignments that change what a later command resolves to or loads. */
const LOADER_VAR =
	/^(PATH|IFS|ENV|BASH_ENV|LD_[A-Z_]+|NODE_OPTIONS|PYTHONPATH|PYTHONSTARTUP|BUN_OPTIONS)=/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * A deliberately small POSIX word splitter. It never expands anything; whatever
 * it cannot account for sets `unanalyzable`, and arming refuses on that.
 */
export function analyzeShell(run: string): ShellAnalysis {
	const commands: ShellCommand[] = [];
	let unanalyzable: string | null = null;
	const flag = (why: string) => {
		unanalyzable ??= why;
	};
	let words: (string | null)[] = [];
	let hasRedirect = false;
	let hasAssignment = false;
	let separators = 0;
	let word = "";
	let inWord = false;
	let dynamic = false;
	let quoted = false;
	let skipNext = false;

	const endWord = () => {
		if (!inWord) return;
		const value = dynamic ? null : word;
		const bare = !quoted && value !== null;
		if (skipNext) {
			skipNext = false;
		} else if (words.length === 0 && bare && ASSIGNMENT.test(value as string)) {
			hasAssignment = true;
			if (LOADER_VAR.test(value as string)) {
				flag(`it assigns ${(value as string).split("=")[0]}`);
			}
		} else if (
			words.length === 0 &&
			!quoted &&
			!dynamic &&
			ASSIGNMENT.test(word)
		) {
			hasAssignment = true;
		} else {
			if (words.length === 0 && value === null) {
				if (ASSIGNMENT.test(word)) {
					hasAssignment = true;
					if (LOADER_VAR.test(word)) flag(`it assigns ${word.split("=")[0]}`);
					word = "";
					inWord = false;
					dynamic = false;
					quoted = false;
					return;
				}
				flag("its command name is computed at run time");
			}
			if (words.length === 0 && bare && KEYWORDS.has(value as string)) {
				flag(`it uses the shell keyword \`${value}\``);
			}
			words.push(value);
		}
		word = "";
		inWord = false;
		dynamic = false;
		quoted = false;
	};
	const endCommand = () => {
		endWord();
		if (words.length > 0 || hasRedirect || hasAssignment) {
			commands.push({ words, hasRedirect, hasAssignment });
		}
		words = [];
		hasRedirect = false;
		hasAssignment = false;
	};

	for (let i = 0; i < run.length; i++) {
		const c = run[i] as string;
		const next = run[i + 1];
		if (c === "\\") {
			if (next === "\n") {
				i++;
				continue;
			}
			word += next ?? "";
			inWord = true;
			i++;
		} else if (c === "'") {
			const end = run.indexOf("'", i + 1);
			if (end < 0) {
				flag("it has an unterminated quote");
				break;
			}
			word += run.slice(i + 1, end);
			inWord = true;
			quoted = true;
			i = end;
		} else if (c === '"') {
			inWord = true;
			quoted = true;
			let j = i + 1;
			for (; j < run.length && run[j] !== '"'; j++) {
				if (run[j] === "\\") {
					j++;
					word += run[j] ?? "";
				} else if (run[j] === "`" || (run[j] === "$" && run[j + 1] === "(")) {
					flag("it uses command substitution");
					dynamic = true;
				} else {
					if (run[j] === "$") dynamic = true;
					word += run[j];
				}
			}
			if (j >= run.length) {
				flag("it has an unterminated quote");
				break;
			}
			i = j;
		} else if (c === "`" || (c === "$" && next === "(")) {
			flag("it uses command substitution");
			dynamic = true;
			inWord = true;
		} else if (c === "$") {
			dynamic = true;
			inWord = true;
			word += c;
		} else if (c === "#" && !inWord) {
			while (i + 1 < run.length && run[i + 1] !== "\n") i++;
		} else if (c === " " || c === "\t") {
			endWord();
		} else if (c === "\n" || c === ";" || c === "|" || c === "&") {
			if (c === "&" && (run[i - 1] === ">" || run[i - 1] === "<")) {
				word = "";
				continue;
			}
			endCommand();
			separators++;
			if (next === c) i++;
		} else if (c === "(" || c === ")" || c === "{" || c === "}") {
			if ((c === "{" || c === "}") && (inWord || (next && !/\s/.test(next)))) {
				word += c;
				inWord = true;
				continue;
			}
			flag("it uses a subshell or command group");
			endCommand();
			separators++;
		} else if (c === ">" || c === "<") {
			if (next === "(") flag("it uses process substitution");
			if (inWord && /^[0-9]+$/.test(word) && !quoted) {
				word = "";
				inWord = false;
			} else {
				endWord();
			}
			hasRedirect = true;
			while (run[i + 1] === ">" || run[i + 1] === "<") i++;
			if (run[i + 1] === "&") {
				i++;
				while (run[i + 1] !== undefined && /[0-9-]/.test(run[i + 1] as string))
					i++;
			} else {
				skipNext = true;
			}
		} else {
			word += c;
			inWord = true;
		}
	}
	endCommand();
	const simple =
		unanalyzable === null &&
		separators === 0 &&
		commands.length === 1 &&
		!commands[0]?.hasRedirect &&
		!commands[0]?.hasAssignment &&
		commands[0]?.words.every((w) => w !== null) === true;
	return { commands, unanalyzable, simple };
}

const BUILTINS = new Set([
	":",
	"true",
	"false",
	"echo",
	"printf",
	"exit",
	"return",
	"cd",
	"pwd",
	"export",
	"unset",
	"set",
	"shift",
	"test",
	"[",
	"read",
	"wait",
	"kill",
	"umask",
	"type",
	"local",
	"readonly",
]);
const WRAPPERS = new Set(["exec", "command", "env", "nohup"]);
const PACKAGE_RUNNERS = new Set(["bun", "npm", "pnpm", "yarn"]);
const SHELLS = new Set(["sh", "bash", "dash"]);
const MAKE_FILES: Record<string, string[]> = {
	make: ["GNUmakefile", "makefile", "Makefile"],
	just: ["justfile", "Justfile", ".justfile"],
};

// Reading files

interface ReadFile {
	bytes: Buffer;
	sha256: string;
	blob: string;
	mode: number;
}

export function gitBlobId(bytes: Buffer): string {
	return createHash("sha1")
		.update(`blob ${bytes.length}\0`)
		.update(bytes)
		.digest("hex");
}

/** Refuse a symlink in any component between `root` and `rel`. */
async function assertNoSymlink(root: string, rel: string): Promise<void> {
	let cur = root;
	for (const part of rel.split(sep)) {
		cur = join(cur, part);
		let st: Awaited<ReturnType<typeof lstat>>;
		try {
			st = await lstat(cur);
		} catch {
			fail("missing", `${rel} does not exist`, REARM, rel);
		}
		if (st.isSymbolicLink()) {
			fail(
				"symlink",
				`${relative(root, cur)} is a symlink`,
				"Replace it with a regular tracked file, then arm the trigger again.",
				rel,
			);
		}
	}
}

/** One descriptor for type, mode, bytes and hash; the path must still name it after. */
async function readPinned(root: string, rel: string): Promise<ReadFile> {
	await assertNoSymlink(root, rel);
	const abs = join(root, rel);
	let fh: Awaited<ReturnType<typeof open>>;
	try {
		fh = await open(abs, READ_FLAGS);
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code;
		if (code === "ELOOP") fail("symlink", `${rel} is a symlink`, REARM, rel);
		fail("missing", `${rel} cannot be opened (${code})`, REARM, rel);
	}
	try {
		const st = await fh.stat();
		if (!st.isFile()) {
			fail("not_regular", `${rel} is not a regular file`, REARM, rel);
		}
		if (st.mode & 0o002) {
			fail(
				"world_writable",
				`${rel} is world-writable`,
				`Run chmod o-w on it. ${REARM}`,
				rel,
			);
		}
		if (st.size > MAX_PINNED_BYTES) {
			fail(
				"too_large",
				`${rel} is over the pin size limit`,
				"Execute a smaller file.",
				rel,
			);
		}
		const bytes = Buffer.alloc(st.size);
		let filled = 0;
		while (filled < st.size) {
			const { bytesRead } = await fh.read(
				bytes,
				filled,
				st.size - filled,
				filled,
			);
			if (bytesRead === 0) break;
			filled += bytesRead;
		}
		const after = await fh.stat();
		if (
			filled !== st.size ||
			after.size !== st.size ||
			after.mtimeMs !== st.mtimeMs ||
			after.ctimeMs !== st.ctimeMs
		) {
			fail("swapped", `${rel} changed while it was being read`, REARM, rel);
		}
		const named = await lstat(abs).catch(() => null);
		if (!named || named.ino !== st.ino || named.dev !== st.dev) {
			fail(
				"swapped",
				`${rel} was replaced while it was being read`,
				REARM,
				rel,
			);
		}
		return {
			bytes,
			sha256: createHash("sha256").update(bytes).digest("hex"),
			blob: gitBlobId(bytes),
			mode: st.mode & 0o777,
		};
	} finally {
		await fh.close().catch(() => {});
	}
}

async function hashExternal(path: string): Promise<string> {
	const st = await stat(path);
	if (st.size > MAX_EXTERNAL_BYTES) {
		fail(
			"too_large",
			`${path} is over the pin size limit`,
			"Use a smaller interpreter.",
			path,
		);
	}
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path))
		hash.update(chunk as Buffer);
	return hash.digest("hex");
}

function isInside(path: string, root: string): boolean {
	return path === root || path.startsWith(root + sep);
}

async function treeBlobs(
	gitCwd: string,
	rev: string,
	paths: string[],
): Promise<Map<string, string>> {
	const r = await runProc(
		[
			requireHostTool("git"),
			"-c",
			"core.fsmonitor=false",
			"-c",
			"core.hooksPath=/dev/null",
			"ls-tree",
			"-z",
			"--full-tree",
			rev,
			"--",
			...paths,
		],
		{ cwd: gitCwd },
	);
	if (r.exitCode !== 0) {
		fail(
			"untracked",
			`cannot read ${rev} from git: ${r.stderr.trim().slice(-200)}`,
			"Commit the files the command executes, then arm it.",
		);
	}
	const out = new Map<string, string>();
	for (const row of r.stdout.split("\0")) {
		const m = /^(\d+) blob ([0-9a-f]+)\t([\s\S]+)$/.exec(row);
		if (m && m[1] !== "120000") out.set(m[3] as string, m[2] as string);
	}
	return out;
}

/** Path to blob id at `rev`; null when git cannot read the revision. */
export async function committedBlobs(
	gitCwd: string,
	rev: string,
	paths: string[],
): Promise<Map<string, string> | null> {
	try {
		return await treeBlobs(gitCwd, rev, paths);
	} catch (e) {
		if (e instanceof Refused) return null;
		throw e;
	}
}

/** `#!` target and the first argument, or null. */
function parseShebang(bytes: Buffer): string[] | null {
	if (bytes[0] !== 0x23 || bytes[1] !== 0x21) return null;
	const end = bytes.indexOf(0x0a);
	const line = bytes.subarray(2, end < 0 ? Math.min(bytes.length, 256) : end);
	const parts = line.toString("utf8").trim().split(/\s+/).filter(Boolean);
	return parts.length > 0 ? parts : null;
}

function directReferences(rel: string, text: string): string[] {
	const found: string[] = [];
	if (/\.(?:[cm]?[jt]sx?)$/.test(rel)) {
		const re =
			/(?:from\s+|import\s*\(?\s*|require\(\s*)["'](\.{1,2}\/[^"']+)["']/g;
		for (const m of text.matchAll(re)) found.push(m[1] as string);
	} else {
		const re = /^[ \t]*(?:\.|source)[ \t]+["']?([^\s"'$`;&|]+)/gm;
		for (const m of text.matchAll(re)) found.push(m[1] as string);
	}
	return found;
}

const IMPORT_SUFFIXES = [
	"",
	".ts",
	".tsx",
	".js",
	".mjs",
	".cjs",
	".json",
	"/index.ts",
	"/index.js",
];

async function isRegular(path: string): Promise<boolean> {
	try {
		return (await lstat(path)).isFile();
	} catch {
		return false;
	}
}

// Building a pin

export interface BuildPinOptions {
	/** The repository root the command runs from. */
	root: string;
	run: string;
	/** `PATH` the command will see. */
	pathVar?: string;
}

export type BuildPinResult = { ok: true; pin: ExecPin } | ExecRefusal;

class PinBuilder {
	readonly files = new Map<string, ExecPin["files"][number]>();
	readonly external = new Map<string, ExecPin["external"][number]>();
	readonly tools = new Set<string>();
	private readonly seenScripts = new Set<string>();
	/** The working directory of the command being resolved. */
	private commandDir: string;

	constructor(
		private readonly root: string,
		private readonly pathVar: string,
	) {
		this.commandDir = root;
	}

	async addCommandString(run: string, baseDir: string): Promise<void> {
		const analysis = analyzeShell(run);
		if (analysis.unanalyzable) {
			fail(
				"unanalyzable",
				`the command cannot be pinned because ${analysis.unanalyzable}`,
				"Move the logic into a tracked script and run that script.",
			);
		}
		let dir = baseDir;
		for (const command of analysis.commands) {
			this.commandDir = dir;
			dir = await this.addCommand(command, dir);
		}
	}

	private async addCommand(
		command: ShellCommand,
		baseDir: string,
	): Promise<string> {
		let words = command.words;
		while (words.length > 1 && WRAPPERS.has(words[0] ?? "")) {
			let next = 1;
			while (
				next < words.length &&
				(words[next]?.startsWith("-") || ASSIGNMENT.test(words[next] ?? ""))
			) {
				if (LOADER_VAR.test(words[next] ?? "")) {
					fail(
						"unanalyzable",
						`the command cannot be pinned because it assigns ${words[next]?.split("=")[0]}`,
						"Set it inside a tracked script.",
					);
				}
				next++;
			}
			words = words.slice(next);
		}
		const head = words[0];
		if (head === undefined) return baseDir;
		if (head === null) {
			fail(
				"unanalyzable",
				"the command cannot be pinned because its command name is computed",
				"Run a tracked script by its path.",
			);
		}
		if (head === "cd") {
			const target = words[1];
			if (typeof target !== "string") {
				fail(
					"unanalyzable",
					"the command cannot be pinned because it changes to a computed directory",
					"Use a literal path.",
				);
			}
			return resolve(baseDir, target);
		}
		if (head === "." || head === "source") {
			const target = words[1];
			if (typeof target !== "string") {
				fail(
					"unanalyzable",
					"the command cannot be pinned because it sources a computed path",
					"Source a literal tracked path.",
				);
			}
			await this.addPath(resolve(baseDir, target), "source");
			return baseDir;
		}
		if (head !== "[" && /[*?[]/.test(head)) {
			fail(
				"unanalyzable",
				"the command cannot be pinned because its path is a glob",
				"Name one tracked script.",
			);
		}
		if (SHELLS.has(basename(head))) {
			const rest = words.slice(1);
			if (rest.some((w) => typeof w === "string" && /^-[a-zA-Z]*c/.test(w))) {
				fail(
					"unanalyzable",
					"the command cannot be pinned because it runs an inline shell string",
					"Put the commands in a tracked script and run that.",
				);
			}
			const target = rest.find((w) => w === null || !w.startsWith("-"));
			if (target === undefined || target === null || /[*?[]/.test(target)) {
				fail(
					"unanalyzable",
					"the command cannot be pinned because its shell reads a script that is not a literal path (stdin, a variable or a glob)",
					"Run one tracked script by its path.",
				);
			}
		}
		if (!BUILTINS.has(head)) {
			if (head.includes("/")) {
				await this.addPath(resolve(baseDir, head), "entry");
			} else {
				const found = Bun.which(head, { PATH: this.pathVar, cwd: baseDir });
				if (!found) {
					fail(
						"unresolved",
						`\`${head}\` is not on PATH`,
						"Install it or use a tracked script.",
						head,
					);
				}
				this.tools.add(head);
				await this.assertToolOutsideRepo(head, found);
			}
		}
		for (const arg of words.slice(1)) {
			if (typeof arg !== "string" || arg.startsWith("-")) continue;
			const abs = resolve(baseDir, arg);
			if (
				isInside(abs, this.root) &&
				abs !== this.root &&
				(await existsNoFollow(abs))
			) {
				if (!(await lstat(abs)).isDirectory())
					await this.addPath(abs, "source");
			}
		}
		if (PACKAGE_RUNNERS.has(head)) await this.addPackageScript(words, baseDir);
		for (const name of MAKE_FILES[head] ?? []) {
			const abs = join(baseDir, name);
			if (await existsNoFollow(abs)) {
				await this.addPath(abs, "config");
				break;
			}
		}
		return baseDir;
	}

	private async assertToolOutsideRepo(
		name: string,
		found: string,
	): Promise<void> {
		const real = await realpath(found);
		if (isInside(real, this.root) || isInside(resolve(found), this.root)) {
			fail(
				"tool_in_repo",
				`\`${name}\` resolves inside the repository`,
				"Run it by its repo path so it is pinned.",
				name,
			);
		}
	}

	private async addPackageScript(
		words: (string | null)[],
		baseDir: string,
	): Promise<void> {
		const args = words
			.slice(1)
			.filter((w): w is string => typeof w === "string" && !w.startsWith("-"));
		const name = args[0] === "run" ? args[1] : args[0];
		if (!name) return;
		const pkg = join(baseDir, "package.json");
		if (!isInside(pkg, this.root) || !(await existsNoFollow(pkg))) return;
		let scripts: Record<string, unknown> = {};
		try {
			const parsed = JSON.parse(await readFile(pkg, "utf8")) as {
				scripts?: Record<string, unknown>;
			};
			scripts = parsed.scripts ?? {};
		} catch {
			fail(
				"unanalyzable",
				"package.json cannot be parsed",
				"Fix package.json, then arm again.",
				"package.json",
			);
		}
		const script = scripts[name];
		if (typeof script !== "string") return;
		await this.addPath(pkg, "config");
		const key = `${pkg}#${name}`;
		if (this.seenScripts.has(key)) return;
		this.seenScripts.add(key);
		await this.addCommandString(script, baseDir);
	}

	async addPath(
		abs: string,
		role: "entry" | "source" | "config",
	): Promise<void> {
		if (!isInside(abs, this.root)) {
			await this.addExternal(abs);
			return;
		}
		const rel = relative(this.root, abs);
		const existing = this.files.get(rel);
		if (existing) {
			if (role === "entry") existing.role = "entry";
			return;
		}
		if (this.files.size >= MAX_PINNED_FILES) {
			fail(
				"too_large",
				"the command reaches too many files to pin",
				"Execute a smaller set of files.",
			);
		}
		const file = await readPinned(this.root, rel);
		this.files.set(rel, {
			path: rel,
			sha256: file.sha256,
			blob: file.blob,
			mode: file.mode,
			role,
		});
		const shebang = parseShebang(file.bytes);
		if (shebang) await this.addInterpreter(shebang, abs);
		const text = file.bytes.toString("utf8");
		// A shell resolves `. a/b` against its working directory, a module import
		// against the importing file. A script may be run from either, so for
		// shell both candidates are pinned when both exist.
		const dirs = /\.(?:[cm]?[jt]sx?)$/.test(rel)
			? [dirname(abs)]
			: [this.commandDir, dirname(abs)];
		for (const ref of directReferences(rel, text)) {
			for (const dir of new Set(dirs)) {
				const target = await this.resolveReference(ref, dir);
				if (target) await this.addPath(target, "source");
			}
		}
	}

	private async resolveReference(
		ref: string,
		dir: string,
	): Promise<string | null> {
		for (const suffix of IMPORT_SUFFIXES) {
			const candidate = resolve(dir, ref + suffix);
			if (await isRegular(candidate)) return candidate;
			if (
				suffix === "" &&
				(await lstat(candidate).catch(() => null))?.isSymbolicLink()
			) {
				return candidate; // refused with a clear reason by addPath
			}
		}
		return null;
	}

	private async addInterpreter(
		shebang: string[],
		script: string,
	): Promise<void> {
		const target = shebang[0] as string;
		if (!isAbsolute(target)) {
			fail(
				"unresolved",
				`the shebang of ${relative(this.root, script)} is not an absolute path`,
				"Use an absolute interpreter or /usr/bin/env.",
			);
		}
		await this.addPath(target, "source");
		if (basename(target) !== "env") return;
		const name = shebang.slice(1).find((w) => !w.startsWith("-"));
		if (!name) return;
		const found = Bun.which(name, { PATH: this.pathVar });
		if (!found) {
			fail(
				"unresolved",
				`interpreter \`${name}\` is not on PATH`,
				"Install it, then arm again.",
				name,
			);
		}
		await this.addExternal(found);
	}

	private async addExternal(path: string): Promise<void> {
		if (this.external.has(path)) return;
		let real: string;
		try {
			real = await realpath(path);
		} catch {
			fail("missing", `${path} does not exist`, REARM, path);
		}
		if (isInside(real, this.root)) {
			fail(
				"symlink",
				`${path} resolves into the repository`,
				"Run it by its repo path.",
				path,
			);
		}
		const st = await stat(real);
		if (!st.isFile())
			fail("not_regular", `${path} is not a regular file`, REARM, path);
		if (st.mode & 0o002) {
			fail(
				"world_writable",
				`${path} is world-writable`,
				"Run chmod o-w on it.",
				path,
			);
		}
		this.external.set(path, {
			path,
			real,
			sha256: real.startsWith("/nix/store/") ? null : await hashExternal(real),
		});
	}
}

async function existsNoFollow(path: string): Promise<boolean> {
	return (await lstat(path).catch(() => null)) !== null;
}

/** Resolve and hash everything `run` executes from `root`. Never throws for a refusal. */
export async function buildExecPin(
	opts: BuildPinOptions,
): Promise<BuildPinResult> {
	try {
		const root = await realpath(opts.root);
		const builder = new PinBuilder(
			root,
			opts.pathVar ?? process.env.PATH ?? "",
		);
		await builder.addCommandString(opts.run, root);
		const files = [...builder.files.values()].sort((a, b) =>
			a.path.localeCompare(b.path),
		);
		let commit: string | null = null;
		if (files.length > 0) {
			const head = await runProc(
				[requireHostTool("git"), "rev-parse", "--verify", "HEAD^{commit}"],
				{ cwd: root },
			);
			if (head.exitCode !== 0) {
				return refusal(
					"untracked",
					"the repository has no commit to pin against",
					"Commit the files the command executes, then arm it.",
				);
			}
			commit = head.stdout.trim();
			const blobs = await treeBlobs(
				root,
				commit,
				files.map((f) => f.path),
			);
			for (const file of files) {
				const blob = blobs.get(file.path);
				if (!blob) {
					return refusal(
						"untracked",
						`${file.path} is not tracked at ${commit.slice(0, 12)}`,
						"Commit it, then arm the trigger.",
						file.path,
					);
				}
				if (blob !== file.blob) {
					return refusal(
						"untracked",
						`${file.path} has uncommitted changes`,
						"Commit or discard them, then arm the trigger.",
						file.path,
					);
				}
			}
		}
		return {
			ok: true,
			pin: {
				commit,
				files,
				external: [...builder.external.values()].sort((a, b) =>
					a.path.localeCompare(b.path),
				),
				tools: [...builder.tools].sort(),
			},
		};
	} catch (e) {
		if (e instanceof Refused) return e.refusal;
		throw e;
	}
}

// Verifying a pin

export interface VerifyPinOptions {
	/** The tree the command will run in. */
	root: string;
	/** Run `git ls-tree` here to compare the committed blobs. */
	gitCwd?: string;
	/** Revision the tree should hold. Omitted skips the committed-blob check. */
	rev?: string;
	pathVar?: string;
	/** Test seam for the time between verifying and executing. */
	afterVerify?: () => Promise<void>;
}

export type VerifyPinResult =
	| { ok: true; entry: { path: string; bytes: Buffer; mode: number } | null }
	| ExecRefusal;

/** Re-read and compare everything in `pin`. Never throws for a refusal. */
export async function verifyExecPin(
	pin: ExecPin,
	opts: VerifyPinOptions,
): Promise<VerifyPinResult> {
	try {
		const root = await realpath(opts.root);
		let entry: { path: string; bytes: Buffer; mode: number } | null = null;
		for (const file of pin.files) {
			const read = await readPinned(root, file.path);
			if (read.sha256 !== file.sha256) {
				fail(
					"content_changed",
					`${file.path} changed since it was armed`,
					REARM,
					file.path,
				);
			}
			if (read.mode !== file.mode) {
				fail(
					"mode_changed",
					`the permissions of ${file.path} changed since it was armed`,
					REARM,
					file.path,
				);
			}
			if (file.role === "entry")
				entry = { path: file.path, bytes: read.bytes, mode: read.mode };
		}
		if (pin.files.length > 0 && opts.rev && opts.gitCwd) {
			const blobs = await treeBlobs(
				opts.gitCwd,
				opts.rev,
				pin.files.map((f) => f.path),
			);
			for (const file of pin.files) {
				if (blobs.get(file.path) !== file.blob) {
					fail(
						"not_at_head",
						`${file.path} at ${opts.rev} is not the armed version`,
						REARM,
						file.path,
					);
				}
			}
		}
		for (const ext of pin.external) {
			const real = await realpath(ext.path).catch(() => null);
			if (real !== ext.real) {
				fail(
					"interpreter_changed",
					`${ext.path} now resolves elsewhere`,
					REARM,
					ext.path,
				);
			}
			const st = await stat(real);
			if (st.mode & 0o002) {
				fail(
					"world_writable",
					`${ext.path} is world-writable`,
					"Run chmod o-w on it.",
					ext.path,
				);
			}
			if (ext.sha256 !== null && (await hashExternal(real)) !== ext.sha256) {
				fail(
					"interpreter_changed",
					`${ext.path} changed since it was armed`,
					REARM,
					ext.path,
				);
			}
		}
		const pathVar = opts.pathVar ?? process.env.PATH ?? "";
		for (const tool of pin.tools) {
			const found = Bun.which(tool, { PATH: pathVar, cwd: root });
			if (!found)
				fail("missing", `\`${tool}\` is no longer on PATH`, REARM, tool);
			const real = await realpath(found);
			if (isInside(real, root) || isInside(resolve(found), root)) {
				fail(
					"tool_in_repo",
					`\`${tool}\` now resolves inside the repository`,
					REARM,
					tool,
				);
			}
			if ((await stat(real)).mode & 0o002) {
				fail(
					"world_writable",
					`\`${tool}\` is world-writable`,
					"Run chmod o-w on it.",
					tool,
				);
			}
		}
		await opts.afterVerify?.();
		return { ok: true, entry };
	} catch (e) {
		if (e instanceof Refused) return e.refusal;
		throw e;
	}
}

// Sealed execution

export interface SealedExec {
	argv: string[];
	env: Record<string, string>;
	dispose(): Promise<void>;
}

/**
 * For a single shell-script command, an argv that runs the verified bytes from a
 * private read-only copy, keeping `$0` and the arguments as written. Null when
 * the command is not eligible; the caller then runs it normally, after the
 * verification, with the race the module header lists.
 */
export async function sealShellEntry(
	run: string,
	entry: { path: string; bytes: Buffer } | null,
	pin: ExecPin,
	cwd: string,
	sealRoot: string,
): Promise<SealedExec | null> {
	if (!entry) return null;
	const analysis = analyzeShell(run);
	const words = analysis.commands[0]?.words as string[] | undefined;
	if (!analysis.simple || !words?.[0]) return null;
	const root = await realpath(cwd);
	if (relative(root, resolve(root, words[0])) !== entry.path) return null;
	const shebang = parseShebang(entry.bytes);
	if (!shebang) return null;
	let interpreter = shebang[0] as string;
	let extra = shebang.slice(1);
	if (basename(interpreter) === "env") {
		const name = extra[0];
		if (!name || extra.length !== 1) return null;
		const resolved = pin.external.find(
			(e) => basename(e.real) === name || basename(e.path) === name,
		);
		if (!resolved) return null;
		interpreter = resolved.path;
		extra = [];
	}
	if (extra.length > 0 || !SHELLS.has(basename(interpreter))) return null;
	await mkdir(sealRoot, { recursive: true, mode: 0o700 });
	await chmod(sealRoot, 0o700);
	const dir = await mkdtemp(join(sealRoot, "x-"));
	const file = join(dir, "entry");
	await writeFile(file, entry.bytes, { mode: 0o400, flag: "wx" });
	return {
		argv: [
			interpreter,
			"-c",
			'. "$MFW_SEALED_ENTRY"',
			words[0],
			...words.slice(1),
		],
		env: { MFW_SEALED_ENTRY: file },
		dispose: () => rm(dir, { recursive: true, force: true }),
	};
}
