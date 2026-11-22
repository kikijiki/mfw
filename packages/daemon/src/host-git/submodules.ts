/**
 * Submodules of a run's trusted base commit, and the plan to seed them.
 *
 * The host never runs `git submodule` in a clone. Instead it reads the base
 * commit's `.gitmodules` and gitlinks from the primary repo (host-owned and
 * trusted), checks every url against an allowlist, and plans one fetch of the
 * recorded sha per submodule into a throwaway bare repo, with
 * `protocol.allow=never` and an override for that url's scheme only. Whatever a
 * run changes in `.gitmodules` or a gitlink is refused by `inspect.ts`, so the
 * only submodules that ever exist are the base's.
 *
 * `seedSubmodules` then runs each planned fetch through `HostGit` (`allowProtocol`,
 * one sha, an allowlisted url, a fresh bare repo under a scratch root). Nothing
 * is checked out; importing the objects into a workspace is the seeder's job.
 */
import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { type HostGit, HostGitError, urlAllowed } from "./runner.ts";

export interface SubmoduleEntry {
	/** The `[submodule "<name>"]` name. */
	name: string;
	path: string;
	url: string;
	/** The sha the base commit records for `path`. */
	sha: string;
}

export type SubmoduleRefusalCode =
	| "bad_gitmodules"
	| "bad_url"
	| "bad_scheme"
	| "not_allowlisted"
	| "update_command"
	| "no_gitlink"
	| "bad_path";

export interface SubmoduleRefusal {
	name: string;
	code: SubmoduleRefusalCode;
	detail: string;
}

/** The only url schemes a seed may enable. `ext`, `file`, `fd` and the rest are never on it. */
export type SeedScheme = "https" | "ssh" | "git";

const SCHEMES: ReadonlySet<string> = new Set(["https", "ssh", "git"]);

export interface SeedPlan {
	entry: SubmoduleEntry;
	scheme: SeedScheme;
	/** `-c protocol.<scheme>.allow=always`: the one override the fetch may add. */
	protocolOverride: string;
}

export interface SubmodulePlan {
	seeds: SeedPlan[];
	/** A non-empty list means the run must be refused: it has a submodule the host will not seed. */
	refusals: SubmoduleRefusal[];
}

const SHA_RE = /^[0-9a-f]{40}$/;
const NAME_RE = /^[A-Za-z0-9._/-]{1,200}$/;

/**
 * Parse a `.gitmodules` file. Strict on purpose: anything outside the plain
 * `[submodule "name"]` plus `key = value` shape throws, so a value git would
 * read differently than this parser cannot slip through. Returns `update`
 * because `update = !cmd` is the key that runs a program.
 */
export function parseGitmodules(
	text: string,
): { name: string; path?: string; url?: string; update?: string }[] {
	const mods: { name: string; [k: string]: string }[] = [];
	let cur: { name: string; [k: string]: string } | undefined;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
		const sec = /^\[submodule "([^"\\]+)"\]$/.exec(line);
		if (sec) {
			cur = { name: sec[1] as string };
			mods.push(cur);
			continue;
		}
		const kv = /^([A-Za-z][A-Za-z0-9-]*)[ \t]*=[ \t]*(.*)$/.exec(line);
		if (!cur || !kv) {
			throw new HostGitError("validation", "unparseable .gitmodules");
		}
		const value = (kv[2] as string).trim();
		// Quoting, escapes, continuation and inline comments change meaning in git-config.
		if (/["\\]|\s[#;]/.test(value) || value.endsWith("\\")) {
			throw new HostGitError("validation", "unsupported .gitmodules value");
		}
		cur[(kv[1] as string).toLowerCase()] = value;
	}
	return mods;
}

/**
 * The scheme a submodule url would use, or why it is not acceptable. Relative
 * urls (`./x`, `../x`) resolve against the origin and are refused, as are
 * `ext::`, `file:`, local paths and anything starting with `-`.
 */
export function urlScheme(
	url: string,
): { scheme: SeedScheme } | { code: SubmoduleRefusalCode; detail: string } {
	if (url === "" || url.startsWith("-")) {
		return { code: "bad_url", detail: "empty or option-like url" };
	}
	if ([...url].some((c) => c.charCodeAt(0) <= 0x20 || c === "\x7f")) {
		return {
			code: "bad_url",
			detail: "whitespace or control character in url",
		};
	}
	const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(url);
	if (m) {
		const scheme = (m[1] as string).toLowerCase();
		if (!SCHEMES.has(scheme)) {
			return {
				code: "bad_scheme",
				detail: `scheme ${scheme}:// is not seedable`,
			};
		}
		return { scheme: scheme as SeedScheme };
	}
	if (url.startsWith("./") || url.startsWith("../") || url.startsWith("/")) {
		return { code: "bad_scheme", detail: "relative or local url" };
	}
	if (/^[A-Za-z][A-Za-z0-9+.-]*::/.test(url)) {
		return { code: "bad_scheme", detail: "transport helper url" };
	}
	if (/^[^/@:]+@[^/:]+:/.test(url)) {
		// scp-like `user@host:path` is ssh.
		return { scheme: "ssh" };
	}
	return {
		code: "bad_scheme",
		detail: "not a url git would fetch over a seedable scheme",
	};
}

export { urlAllowed };

async function show(
	host: HostGit,
	repo: string,
	spec: string,
): Promise<string | undefined> {
	const r = await host.run(["cat-file", "-p", spec], {
		cwd: repo,
		repo,
		maxOutputBytes: 1024 * 1024,
	});
	if (r.exitCode !== 0) return undefined;
	if (r.raw.truncated) {
		throw new HostGitError("validation", ".gitmodules is over 1 MiB");
	}
	return r.raw.stdout;
}

/** `path -> sha` of every gitlink in the base commit. */
async function baseGitlinks(
	host: HostGit,
	repo: string,
	baseSha: string,
): Promise<Map<string, string>> {
	const r = await host.run(["ls-tree", "-r", "-z", "--full-tree", baseSha], {
		cwd: repo,
		repo,
		maxOutputBytes: 128 * 1024 * 1024,
	});
	if (r.exitCode !== 0 || r.raw.truncated) {
		throw new HostGitError("validation", "cannot list the base tree");
	}
	const links = new Map<string, string>();
	for (const rec of r.raw.stdout.split("\0")) {
		const m = /^160000 commit ([0-9a-f]{40})\t(.+)$/s.exec(rec);
		if (m) links.set(m[2] as string, m[1] as string);
	}
	return links;
}

export interface PlanSubmoduleOpts {
	host: HostGit;
	/** The trusted, host-owned repo that has the base commit. Never a clone. */
	primaryRepo: string;
	baseSha: string;
	/** Allowed urls: exact, or `https://host/org/*`. Empty means no submodule is seeded. */
	allowlist: readonly string[];
}

/**
 * Plan the seeding of the base commit's submodules. Every submodule must be
 * seedable: one that is not (url off the allowlist, `ext::`, `update = !cmd`, a
 * gitlink with no `.gitmodules` entry, a path that is not a plain relative
 * path) lands in `refusals`, and the caller refuses the run.
 */
export async function planSubmoduleSeeds(
	o: PlanSubmoduleOpts,
): Promise<SubmodulePlan> {
	if (!SHA_RE.test(o.baseSha)) {
		throw new HostGitError(
			"bad_argument",
			"baseSha must be a 40-hex commit id",
		);
	}
	const links = await baseGitlinks(o.host, o.primaryRepo, o.baseSha);
	const text = await show(o.host, o.primaryRepo, `${o.baseSha}:.gitmodules`);
	const plan: SubmodulePlan = { seeds: [], refusals: [] };
	if (text === undefined) {
		for (const path of links.keys()) {
			plan.refusals.push({
				name: path,
				code: "no_gitlink",
				detail: "a gitlink with no .gitmodules",
			});
		}
		return plan;
	}
	let mods: ReturnType<typeof parseGitmodules>;
	try {
		mods = parseGitmodules(text);
	} catch (e) {
		plan.refusals.push({
			name: ".gitmodules",
			code: "bad_gitmodules",
			detail: e instanceof Error ? e.message : String(e),
		});
		return plan;
	}
	const seen = new Set<string>();
	for (const m of mods) {
		const refuse = (code: SubmoduleRefusalCode, detail: string): void => {
			plan.refusals.push({ name: m.name, code, detail });
		};
		if (m.path !== undefined) seen.add(m.path);
		if (!NAME_RE.test(m.name) || m.name.split("/").includes("..")) {
			refuse("bad_gitmodules", "unsafe submodule name");
			continue;
		}
		if (m.update?.startsWith("!")) {
			refuse("update_command", "update = !<command> would run a program");
			continue;
		}
		const sha = m.path === undefined ? undefined : links.get(m.path);
		if (m.path === undefined || m.url === undefined) {
			refuse("bad_gitmodules", "missing path or url");
			continue;
		}
		if (
			m.path.startsWith("/") ||
			m.path.split("/").some((c) => c === ".." || c === "." || c === "")
		) {
			refuse("bad_path", "unsafe submodule path");
			continue;
		}
		if (sha === undefined) {
			refuse("no_gitlink", `no gitlink at ${m.path}`);
			continue;
		}
		const sch = urlScheme(m.url);
		if ("code" in sch) {
			refuse(sch.code, sch.detail);
			continue;
		}
		if (!urlAllowed(m.url, o.allowlist)) {
			refuse("not_allowlisted", `${m.url} is not on the allowlist`);
			continue;
		}
		plan.seeds.push({
			entry: { name: m.name, path: m.path, url: m.url, sha },
			scheme: sch.scheme,
			protocolOverride: `protocol.${sch.scheme}.allow=always`,
		});
	}
	for (const path of links.keys()) {
		if (!seen.has(path)) {
			plan.refusals.push({
				name: path,
				code: "no_gitlink",
				detail: "a gitlink with no .gitmodules entry",
			});
		}
	}
	return plan;
}

export interface SeededSubmodule {
	entry: SubmoduleEntry;
	/** A fresh bare repo under the scratch root that holds `entry.sha`. */
	bareRepo: string;
	/** The ref inside it that points at `entry.sha`. */
	ref: string;
}

/**
 * Fetch every planned submodule sha into its own throwaway bare repo. The host
 * must have been built with the same allowlist (`submoduleAllowlist`); the
 * runner checks every url again, so a plan from elsewhere cannot widen it.
 */
export async function seedSubmodules(o: {
	host: HostGit;
	plan: SubmodulePlan;
	/** A mfw-owned scratch root outside the workspace root. */
	scratchRoot: string;
}): Promise<SeededSubmodule[]> {
	if (o.plan.refusals.length > 0) {
		throw new HostGitError(
			"validation",
			`refusing to seed: ${o.plan.refusals.length} submodule(s) are not seedable`,
		);
	}
	const out: SeededSubmodule[] = [];
	for (const seed of o.plan.seeds) {
		const id = `s${randomBytes(6).toString("hex")}`;
		const dir = await mkdtemp(join(o.scratchRoot, "submodule-"));
		const bare = join(dir, "repo.git");
		await o.host.runOk(["init", "--bare", "--quiet", "--", bare], { cwd: dir });
		const ref = `refs/mfw/submodule/${id}`;
		const r = await o.host.run(
			[
				"fetch",
				"--no-tags",
				"--no-write-fetch-head",
				"--no-recurse-submodules",
				"--no-auto-gc",
				"--no-auto-maintenance",
				"--no-prune",
				"--",
				seed.entry.url,
				`+${seed.entry.sha}:${ref}`,
			],
			{ cwd: bare, repo: bare, allowProtocol: seed.scheme },
		);
		if (r.exitCode !== 0) {
			throw new HostGitError(
				"fetch_failed",
				`fetching submodule ${seed.entry.name} failed (${r.raw.signalCode ?? r.exitCode}): ${r.stderr.slice(0, 300)}`,
			);
		}
		const tip = await o.host.runOk(
			["rev-parse", "--verify", `${ref}^{commit}`],
			{
				cwd: bare,
				repo: bare,
			},
		);
		if (tip !== seed.entry.sha) {
			throw new HostGitError(
				"fetch_failed",
				`submodule ${seed.entry.name}: the remote did not return the recorded commit`,
			);
		}
		out.push({ entry: seed.entry, bareRepo: bare, ref });
	}
	return out;
}
