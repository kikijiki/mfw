/**
 * What the owner reads before approving an environment (`mfw env allow`, the
 * card). File hashes alone do not say what runs: `flake.nix` imports
 * `nix/devshell.nix`, an `.envrc` sources a script. So the plan shows:
 *
 * - after an earlier approval: `git diff --stat` of the whole tree since that
 *   commit, and the diffs of the environment's files inline;
 * - for a first approval: the environment's files, plus every `*.nix`,
 *   `.config/mise/**` and `.envrc*` file in the tree, and every tracked path a
 *   root environment file names (a sourced script, an imported module).
 *
 * Read from the primary's objects with host git; nothing is evaluated.
 */

import { gitComplete } from "../git.ts";
import { ENV_FILE_PATHS, readCommitBlob } from "./dev-env-sources.ts";

const MAX_STAT_BYTES = 16 * 1024;
const MAX_DIFF_BYTES = 64 * 1024;
const MAX_LISTED = 400;

export interface ApprovalPlan {
	commit: string;
	/** The approved commit the diff is from, or null for a first approval. */
	previous: string | null;
	/** `git diff --stat previous..commit` of the whole tree, capped. */
	stat: string | null;
	/** The environment files' diff since `previous`, capped. */
	diff: string | null;
	/** First approval: the files that shape the environment beyond the root ones. */
	referenced: string[];
	truncated: boolean;
}

/** Whether a tracked path is one the environment could read, wherever it is. */
export function isEnvShapedPath(path: string): boolean {
	const base = path.split("/").at(-1) ?? "";
	return (
		path.endsWith(".nix") ||
		path.startsWith(".config/mise/") ||
		base.startsWith(".envrc") ||
		ENV_FILE_PATHS.includes(path)
	);
}

const cap = (text: string, max: number): { text: string; cut: boolean } =>
	text.length > max
		? { text: `${text.slice(0, max)}\n[… cut at ${max} bytes]`, cut: true }
		: { text, cut: false };

/** Tracked paths a root environment file names: words that are paths in the tree. */
export function namedPaths(
	texts: readonly string[],
	tracked: ReadonlySet<string>,
): string[] {
	const out = new Set<string>();
	for (const t of texts) {
		for (const raw of t.split(/[\s"'`=(){}[\];,:<>|&$]+/)) {
			const word = raw.replace(/^\.\//, "").replace(/\/+$/, "");
			if (word && tracked.has(word)) out.add(word);
		}
	}
	return [...out].sort();
}

export async function approvalPlan(
	root: string,
	commit: string,
	previous: string | null,
): Promise<ApprovalPlan> {
	if (previous && previous !== commit) {
		const stat = cap(
			await gitComplete(
				["diff", "--stat=200", "--no-renames", previous, commit, "--"],
				root,
			),
			MAX_STAT_BYTES,
		);
		const names = (
			await gitComplete(
				["diff", "--name-only", "--no-renames", previous, commit, "--"],
				root,
			)
		)
			.split("\n")
			.filter((p) => p && isEnvShapedPath(p));
		const diff =
			names.length > 0
				? cap(
						await gitComplete(
							[
								"diff",
								"--no-renames",
								"--no-ext-diff",
								"--no-textconv",
								previous,
								commit,
								"--",
								...names,
							],
							root,
						),
						MAX_DIFF_BYTES,
					)
				: { text: "", cut: false };
		return {
			commit,
			previous,
			stat: stat.text,
			diff: diff.text,
			referenced: [],
			truncated: stat.cut || diff.cut,
		};
	}
	const listing = await gitComplete(
		["ls-tree", "-r", "-z", "--full-tree", commit],
		root,
	);
	const tracked = new Map<string, string>();
	for (const rec of listing.split("\0")) {
		const tab = rec.indexOf("\t");
		if (tab < 0) continue;
		const [, type, oid] = rec.slice(0, tab).split(" ");
		if (type === "blob" && oid) tracked.set(rec.slice(tab + 1), oid);
	}
	const rootTexts: string[] = [];
	for (const p of ENV_FILE_PATHS) {
		const oid = tracked.get(p);
		if (oid) rootTexts.push((await readCommitBlob(root, oid)).toString("utf8"));
	}
	const all = new Set([
		...[...tracked.keys()].filter(isEnvShapedPath),
		...namedPaths(rootTexts, new Set(tracked.keys())),
	]);
	const referenced = [...all].sort();
	return {
		commit,
		previous: null,
		stat: null,
		diff: null,
		referenced: referenced.slice(0, MAX_LISTED),
		truncated: referenced.length > MAX_LISTED,
	};
}

/** The plan as lines for the CLI and the card. */
export function planLines(plan: ApprovalPlan): string[] {
	if (plan.previous) {
		return [
			`changes since the approved commit ${plan.previous.slice(0, 12)} (whole tree):`,
			...(plan.stat
				? plan.stat.split("\n").map((l) => `  ${l}`)
				: ["  (none)"]),
			...(plan.diff
				? [
						"the environment files' changes:",
						...plan.diff.split("\n").map((l) => `  ${l}`),
					]
				: ["the environment files did not change"]),
		];
	}
	return [
		"files that shape this environment (read them before approving):",
		...plan.referenced.map((p) => `  ${p}`),
		...(plan.truncated ? ["  [… more not listed]"] : []),
	];
}
