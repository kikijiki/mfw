/**
 * Which project development environment a commit declares, and the exact
 * bytes of every file that defines it (design "Dev environment runs inside the
 * sandbox").
 *
 * Read from the trusted primary's object store with host git (`ls-tree`,
 * `cat-file`), never from a work tree an agent can write, and nothing here
 * evaluates anything: the host learns which files exist and hashes them. The
 * files are evaluated only inside the env-build sandbox (dev-env-build.ts),
 * and only at a commit the owner approved (dev-env-trust.ts).
 *
 * Sources, in priority order, the first present wins:
 *
 * 1. direnv: `.envrc` (it may itself `use flake`, `use nix`, `dotenv`, ...);
 * 2. mise: `mise.toml`, `.mise.toml`, `.tool-versions` and mise's other
 *    config locations; asdf-style `.tool-versions` goes through mise;
 * 3. a plain flake dev shell: `flake.nix`;
 * 4. devenv: `devenv.nix` or `devenv.yaml`.
 *
 * Every environment file present is hashed, whichever source wins, because a
 * lower-priority file can still be read by the winning one (`use flake` reads
 * `flake.lock`). A setup mfw cannot evaluate (a lone `shell.nix`, a version
 * file only nvm or pyenv reads) is a refusal with a fix: a project is never
 * silently run without the environment it declares.
 */

import { createHash } from "node:crypto";
import { hostGitCommand } from "../git.ts";

export type EnvSourceKind = "direnv" | "mise" | "flake" | "devenv";

/** `none`: the project runs on the plain host toolchain, by the owner's choice. */
export type EnvSourceSetting = "auto" | "none" | EnvSourceKind;

/** One environment file at a commit. */
export interface EnvFile {
	/** Repository path, relative to the root. */
	path: string;
	/** The git object id of its blob. */
	oid: string;
	/** sha256 of its exact bytes. */
	sha256: string;
	/** `package.json` only: sha256 of its executing fields, what defines the environment. */
	defSha256?: string;
}

export type EnvDetection =
	| { kind: "none"; files: EnvFile[] }
	| { kind: EnvSourceKind; files: EnvFile[]; ignored: EnvSourceKind[] }
	| { kind: "unsupported"; files: EnvFile[]; reason: string; fix: string };

/** Root-level files each source reads. Exact paths, compared in this case. */
export const SOURCE_FILES: Readonly<Record<EnvSourceKind, readonly string[]>> =
	{
		direnv: [".envrc"],
		mise: [
			"mise.toml",
			".mise.toml",
			"mise.local.toml",
			".mise.local.toml",
			".config/mise.toml",
			".config/mise/config.toml",
			".mise/config.toml",
			"mise/config.toml",
			".tool-versions",
		],
		flake: ["flake.nix", "flake.lock"],
		devenv: ["devenv.nix", "devenv.yaml", "devenv.lock", "devenv.local.nix"],
	};

/** The files whose presence selects a source; a lock alone selects nothing. */
const SELECTING: Readonly<Record<EnvSourceKind, readonly string[]>> = {
	direnv: [".envrc"],
	mise: SOURCE_FILES.mise,
	flake: ["flake.nix"],
	devenv: ["devenv.nix", "devenv.yaml"],
};

export const SOURCE_PRIORITY: readonly EnvSourceKind[] = [
	"direnv",
	"mise",
	"flake",
	"devenv",
];

/**
 * Files that declare an environment mfw has no evaluator for, when nothing
 * above is present. `default.nix` is not one: it is usually a package.
 */
const UNSUPPORTED: Readonly<Record<string, string>> = {
	"shell.nix": "a shell.nix without an .envrc",
	".nvmrc": "an .nvmrc (nvm)",
	".node-version": "a .node-version file",
	".python-version": "a .python-version file (pyenv)",
	".ruby-version": "a .ruby-version file",
	".sdkmanrc": "an .sdkmanrc (SDKMAN!)",
};

/** The files some source evaluates: each is host-executed (decision-rights.ts). */
export const EVALUATED_ENV_PATHS: readonly string[] = [
	...new Set(SOURCE_PRIORITY.flatMap((k) => SOURCE_FILES[k])),
];

/**
 * Package-manager lockfiles a setup step installs from. Hashed into an
 * approval only when the project has `env.setup`, and in their own class: a
 * change to them alone needs no approval, because the install it causes runs
 * in the env-install sandbox with registry egress only (dev-env-deps.ts). Nix
 * lockfiles are not here: a changed input makes the nix daemon fetch and build
 * from a new origin outside the proxy, so they define the environment.
 */
export const PACKAGE_LOCKFILES: readonly string[] = [
	"bun.lock",
	"bun.lockb",
	"package-lock.json",
	"npm-shrinkwrap.json",
	"pnpm-lock.yaml",
	"yarn.lock",
	"Cargo.lock",
	"uv.lock",
	"poetry.lock",
	"requirements.txt",
];

/**
 * Hashed with the lockfiles when the project has `env.setup`. Only its fields
 * that make an install or a command run something define the environment (as
 * the merge gate judges it); its dependency lists change with the lockfile.
 */
export const PACKAGE_MANIFEST = "package.json";

export const DEPS_LOCKFILES: readonly string[] = [
	...PACKAGE_LOCKFILES,
	PACKAGE_MANIFEST,
];

/** The `package.json` fields that make an install or a command run something. */
export const MANIFEST_EXEC_FIELDS = [
	"scripts",
	"bin",
	"directories",
	"workspaces",
	"preinstall",
	"install",
	"postinstall",
	"prepare",
	"trustedDependencies",
] as const;

/** Key order carries no meaning in a manifest. */
export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

/** Whether a repository path is a package lockfile, which never defines the environment. */
export function isPackageLockfile(path: string): boolean {
	return PACKAGE_LOCKFILES.includes(path);
}

/**
 * What of a file defines the environment: its whole bytes, except a
 * `package.json`, whose executing fields alone count. Null for a lockfile.
 */
export function definitionHash(f: EnvFile): string | null {
	if (isPackageLockfile(f.path)) return null;
	return f.defSha256 ?? f.sha256;
}

function manifestDefinitionHash(bytes: Buffer): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(bytes.toString("utf8"));
	} catch {
		parsed = null;
	}
	// Unreadable: every byte counts, so any change asks again.
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return createHash("sha256").update(bytes).digest("hex");
	}
	const m = parsed as Record<string, unknown>;
	const fields = Object.fromEntries(
		MANIFEST_EXEC_FIELDS.map((f) => [f, m[f] ?? null]),
	);
	return createHash("sha256")
		.update(`mfw-manifest-exec:1\n${canonicalJson(fields)}`)
		.digest("hex");
}

/** Every root-level path that defines an environment, for hashing and detection. */
export const ENV_FILE_PATHS: readonly string[] = [
	...new Set([
		...SOURCE_PRIORITY.flatMap((k) => SOURCE_FILES[k]),
		...Object.keys(UNSUPPORTED),
	]),
];

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const BLOB_MODES = new Set(["100644", "100755"]);
/** An environment file larger than this is not a configuration file. */
export const MAX_ENV_FILE_BYTES = 1024 * 1024;

export class EnvSourceError extends Error {
	constructor(
		message: string,
		readonly fix: string,
	) {
		super(message);
		this.name = "EnvSourceError";
	}
}

async function spawnGit(
	root: string,
	args: string[],
	maxBytes: number,
): Promise<Buffer> {
	const { argv, env } = await hostGitCommand(args, root);
	const child = Bun.spawn(argv, {
		cwd: root,
		env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
	try {
		const chunks: Buffer[] = [];
		let total = 0;
		for await (const chunk of child.stdout as unknown as AsyncIterable<Uint8Array>) {
			total += chunk.byteLength;
			if (total > maxBytes) {
				child.kill("SIGKILL");
				throw new EnvSourceError(
					`git ${args[0]} produced more than ${maxBytes} bytes`,
					"keep environment files under 1 MiB",
				);
			}
			chunks.push(Buffer.from(chunk));
		}
		const code = await child.exited;
		if (code !== 0) {
			const err = (await new Response(child.stderr).text()).trim();
			throw new EnvSourceError(
				`git ${args[0]} failed (${code}): ${err.slice(0, 300)}`,
				"check that the commit exists in the project's repository",
			);
		}
		return Buffer.concat(chunks);
	} finally {
		clearTimeout(timer);
	}
}

/** Resolve `rev` in the primary to a full commit id. */
export async function resolveCommit(
	root: string,
	rev: string,
): Promise<string> {
	if (rev.startsWith("-") || rev.includes("\0")) {
		throw new EnvSourceError(
			`invalid revision ${rev}`,
			"pass a commit or branch",
		);
	}
	const out = (
		await spawnGit(
			root,
			["rev-parse", "--verify", "-q", "--end-of-options", `${rev}^{commit}`],
			4096,
		)
	)
		.toString("utf8")
		.trim();
	if (!OBJECT_ID.test(out)) {
		throw new EnvSourceError(
			`${rev} is not a commit`,
			"pass a commit or branch",
		);
	}
	return out;
}

interface TreeEntry {
	mode: string;
	type: string;
	oid: string;
	path: string;
}

/** The named paths as they are in `commit`. */
async function listPaths(
	root: string,
	commit: string,
	paths: readonly string[],
): Promise<TreeEntry[]> {
	const out = await spawnGit(
		root,
		["ls-tree", "-z", "--full-tree", commit, "--", ...paths],
		1024 * 1024,
	);
	const entries: TreeEntry[] = [];
	for (const record of out.toString("utf8").split("\0")) {
		if (!record) continue;
		const tab = record.indexOf("\t");
		const [mode, type, oid] = record.slice(0, tab).split(" ");
		if (!mode || !type || !oid || tab < 0) continue;
		entries.push({ mode, type, oid, path: record.slice(tab + 1) });
	}
	return entries;
}

/**
 * Hash the named repository files at `commit`. Absent paths are skipped. A
 * path that is a symlink, a submodule or a directory is refused: an
 * environment file is a plain file, so that its bytes are what was approved.
 */
export async function hashCommitFiles(
	root: string,
	commit: string,
	paths: readonly string[],
): Promise<EnvFile[]> {
	if (!OBJECT_ID.test(commit)) {
		throw new EnvSourceError(
			`${commit} is not a full commit id`,
			"resolve it first",
		);
	}
	const wanted = [...new Set(paths)].sort();
	if (wanted.length === 0) return [];
	for (const p of wanted) {
		if (
			p === "" ||
			p.startsWith("/") ||
			p.includes("\0") ||
			p.split("/").some((s) => s === "" || s === "." || s === "..")
		) {
			throw new EnvSourceError(
				`environment file ${JSON.stringify(p)} is not a repository path`,
				"name files relative to the repository root",
			);
		}
	}
	// Directories (".config/mise.toml" lives in one) are listed one level down.
	const entries = await listPaths(root, commit, wanted);
	const files: EnvFile[] = [];
	for (const e of entries) {
		if (!wanted.includes(e.path)) continue;
		if (e.type !== "blob" || !BLOB_MODES.has(e.mode)) {
			throw new EnvSourceError(
				`environment file ${e.path} is a ${e.mode === "120000" ? "symlink" : e.type} at ${commit.slice(0, 12)}`,
				"make it a regular file: an environment file must be its own bytes",
			);
		}
		if (!OBJECT_ID.test(e.oid)) continue;
		const bytes = await spawnGit(
			root,
			["cat-file", "blob", e.oid],
			MAX_ENV_FILE_BYTES,
		);
		files.push({
			path: e.path,
			oid: e.oid,
			sha256: createHash("sha256").update(bytes).digest("hex"),
			...(e.path === PACKAGE_MANIFEST
				? { defSha256: manifestDefinitionHash(bytes) }
				: {}),
		});
	}
	return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Pure: pick the source from the files present. */
export function classifySource(
	present: readonly string[],
	setting: EnvSourceSetting = "auto",
): Omit<EnvDetection, "files"> &
	(
		| { kind: "none" }
		| { kind: EnvSourceKind; ignored: EnvSourceKind[] }
		| {
				kind: "unsupported";
				reason: string;
				fix: string;
		  }
	) {
	const has = (k: EnvSourceKind) =>
		SELECTING[k].some((f) => present.includes(f));
	if (setting === "none") return { kind: "none" };
	if (setting !== "auto") {
		if (!has(setting)) {
			return {
				kind: "unsupported",
				reason: `the project's env.source is ${setting}, but the commit has none of ${SELECTING[setting].join(", ")}`,
				fix: `add the ${setting} configuration, or set env.source to "auto" or "none" in this project's entry in $MFW_HOME/config.json`,
			};
		}
		return {
			kind: setting,
			ignored: SOURCE_PRIORITY.filter((k) => k !== setting && has(k)),
		};
	}
	const found = SOURCE_PRIORITY.filter(has);
	const [first, ...rest] = found;
	if (first) return { kind: first, ignored: rest };
	const odd = Object.keys(UNSUPPORTED).filter((f) => present.includes(f));
	if (odd.length > 0) {
		return {
			kind: "unsupported",
			reason: `the project declares its environment with ${odd.map((f) => UNSUPPORTED[f]).join(" and ")}, which mfw cannot evaluate on its own`,
			fix: `add an .envrc (for example \`use nix\` for a shell.nix) or a mise.toml that declares the same tools, or set env.source to "none" in this project's entry in $MFW_HOME/config.json to run it on the plain host toolchain`,
		};
	}
	return { kind: "none" };
}

/** The environment `commit` declares, with every environment file hashed. */
export async function detectEnvSource(
	root: string,
	commit: string,
	setting: EnvSourceSetting = "auto",
	opts: { lockfiles?: boolean } = {},
): Promise<EnvDetection> {
	const files = await hashCommitFiles(root, commit, [
		...ENV_FILE_PATHS,
		...(opts.lockfiles ? DEPS_LOCKFILES : []),
	]);
	const picked = classifySource(
		files.map((f) => f.path),
		setting,
	);
	return { ...picked, files } as EnvDetection;
}
