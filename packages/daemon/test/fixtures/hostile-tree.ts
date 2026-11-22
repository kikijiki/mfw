/**
 * Builds bare repos holding trees that git itself would refuse to create
 * (`..` components, `.git` components, odd modes), by writing raw tree objects
 * with `hash-object --literally`. Only for tests of the result inspector.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TreeFile {
	mode: string;
	/** Blob content, or a fixed object id (for a gitlink). */
	content?: string;
	sha?: string;
}

export type TreeSpec = Record<string, TreeFile | string>;

const ENV = {
	PATH: process.env.PATH ?? "",
	HOME: "/nonexistent",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@example.invalid",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@example.invalid",
	GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z",
	GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z",
};

export async function git(
	repo: string,
	args: string[],
	input?: Buffer | string,
): Promise<string> {
	const p = Bun.spawn(["git", `--git-dir=${repo}`, ...args], {
		env: ENV,
		stdin: input === undefined ? "ignore" : Buffer.from(input),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([
		new Response(p.stdout).text(),
		new Response(p.stderr).text(),
		p.exited,
	]);
	if (code !== 0) throw new Error(`git ${args[0]} failed: ${err}`);
	return out.trim();
}

export async function newBareRepo(): Promise<{ root: string; repo: string }> {
	const root = await mkdtemp(join(tmpdir(), "mfw-hostile-"));
	const repo = join(root, "repo.git");
	const p = Bun.spawn(["git", "init", "--bare", "-q", repo], {
		env: ENV,
		stdout: "pipe",
		stderr: "pipe",
	});
	await p.exited;
	return { root, repo };
}

type Node = { files: Map<string, TreeFile>; dirs: Map<string, Node> };

function insert(node: Node, parts: string[], file: TreeFile): void {
	const [head, ...rest] = parts as [string, ...string[]];
	if (rest.length === 0) {
		node.files.set(head, file);
		return;
	}
	let d = node.dirs.get(head);
	if (!d) {
		d = { files: new Map(), dirs: new Map() };
		node.dirs.set(head, d);
	}
	insert(d, rest, file);
}

async function writeNode(repo: string, node: Node): Promise<string> {
	const entries: { name: string; mode: string; sha: string }[] = [];
	for (const [name, f] of node.files) {
		const sha =
			f.sha ??
			(await git(
				repo,
				["hash-object", "-w", "--stdin", "--literally"],
				f.content ?? "",
			));
		entries.push({ name, mode: f.mode, sha });
	}
	for (const [name, d] of node.dirs) {
		entries.push({ name, mode: "40000", sha: await writeNode(repo, d) });
	}
	entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	const parts: Buffer[] = [];
	for (const e of entries) {
		parts.push(Buffer.from(`${e.mode} ${e.name}\0`), Buffer.from(e.sha, "hex"));
	}
	return git(
		repo,
		["hash-object", "-t", "tree", "-w", "--stdin", "--literally"],
		Buffer.concat(parts),
	);
}

/** Write a commit whose tree is `spec` (path to content or `{mode, content}`). Returns the commit sha. */
export async function commitSpec(
	repo: string,
	spec: TreeSpec,
	opts: { parent?: string; ref?: string } = {},
): Promise<string> {
	const root: Node = { files: new Map(), dirs: new Map() };
	for (const [path, v] of Object.entries(spec)) {
		const file: TreeFile =
			typeof v === "string" ? { mode: "100644", content: v } : v;
		insert(root, path.split("/"), file);
	}
	const tree = await writeNode(repo, root);
	const sha = await git(repo, [
		"commit-tree",
		tree,
		...(opts.parent ? ["-p", opts.parent] : []),
		"-m",
		"c",
	]);
	if (opts.ref) await git(repo, ["update-ref", opts.ref, sha]);
	return sha;
}
