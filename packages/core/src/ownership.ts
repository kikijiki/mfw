/**
 * File ownership (`owns:` in a task's frontmatter).
 *
 * A task that declares `owns` promises to edit only paths those patterns
 * cover. The scheduler uses it to keep two tasks that could touch the same
 * file from running at once, the board uses it to list unordered overlaps,
 * and finalize uses it to name files a run changed outside its scope.
 *
 * A pattern is a repository-relative path, optionally with glob segments:
 * `*` and `?` within one segment, `**` for any number of segments, `{a,b}`
 * alternatives and `[...]` classes. A pattern owns every path it matches AND
 * everything below such a path, so `src/api` and `src/api/**` are the same
 * claim. Overlap is decided conservatively: when both patterns carry a glob
 * in the same segment, or either reaches a `**`, they are treated as
 * overlapping unless a literal segment already separates them. A false
 * overlap only serializes two tasks; a missed one lets them collide.
 */

const GLOB_META = /[*?[{]/;

export type OwnsPatternError = { pattern: string; reason: string };

/** Canonical form: no leading `./`, no trailing `/`, no empty segments. */
export function normalizeOwnsPattern(raw: string): string {
	let p = raw.trim().replaceAll("\\", "/");
	while (p.startsWith("./")) p = p.slice(2);
	p = p.replace(/\/+/g, "/").replace(/\/$/, "");
	return p;
}

/** Why a pattern is unusable, or null. Absolute and `..` paths escape the repo. */
export function validateOwnsPattern(raw: string): string | null {
	const p = normalizeOwnsPattern(raw);
	if (p.length === 0) return "empty pattern";
	if (p.startsWith("/")) return "must be relative to the repository root";
	const segments = p.split("/");
	if (segments.some((s) => s === ".." || s === ".")) {
		return "may not contain '.' or '..' segments";
	}
	for (const s of segments) {
		if (s.includes("**") && s !== "**") {
			return `'**' must be a whole segment (got '${s}')`;
		}
		if (!segmentRegExp(s)) return `invalid glob syntax in '${s}'`;
	}
	return null;
}

function segments(pattern: string): string[] {
	const p = normalizeOwnsPattern(pattern);
	return p.length === 0 ? [] : p.split("/");
}

const segmentCache = new Map<string, RegExp | null>();

/** One path segment's glob as an anchored RegExp (no `/` can occur inside). */
function segmentRegExp(glob: string): RegExp | null {
	if (segmentCache.has(glob)) return segmentCache.get(glob) ?? null;
	let re: RegExp | null;
	try {
		re = compileSegment(glob);
	} catch {
		re = null;
	}
	segmentCache.set(glob, re);
	return re;
}

/** Validation and matching share this compiler, including RegExp range checks. */
function compileSegment(glob: string): RegExp {
	let out = "";
	let braceDepth = 0;
	for (let i = 0; i < glob.length; i++) {
		const ch = glob[i] as string;
		switch (ch) {
			case "*":
				out += "[^/]*";
				break;
			case "?":
				out += "[^/]";
				break;
			case "[": {
				const end = glob.indexOf("]", i + 1);
				if (end < 0) throw new Error("unclosed character class");
				let contents = glob.slice(i + 1, end);
				const negated = contents.startsWith("!") || contents.startsWith("^");
				if (negated) contents = contents.slice(1);
				if (!contents || contents.includes("[")) {
					throw new Error("empty or unsupported character class");
				}
				out += `[${negated ? "^" : ""}${contents}]`;
				i = end;
				break;
			}
			case "]":
				throw new Error("unmatched character class close");
			case "{":
				braceDepth++;
				out += "(?:";
				break;
			case "}":
				if (braceDepth === 0) throw new Error("unmatched brace close");
				braceDepth--;
				out += ")";
				break;
			case ",":
				out += braceDepth > 0 ? "|" : ",";
				break;
			default:
				out += ch.replace(/[.+^$()|\\\]]/g, "\\$&");
		}
	}
	if (braceDepth !== 0) throw new Error("unclosed brace");
	// `$` also matches before a final newline; a repository filename can end
	// with one, so require the actual end of the segment.
	return new RegExp(`^${out}(?![\\s\\S])`);
}

function isGlob(segment: string): boolean {
	return GLOB_META.test(segment);
}

function segmentMatches(glob: string, literal: string): boolean {
	return isGlob(glob)
		? (segmentRegExp(glob)?.test(literal) ?? false)
		: glob === literal;
}

/** Whether `pattern` owns `path` (matches it or one of its ancestors). */
export function ownsPath(pattern: string, path: string): boolean {
	if (validateOwnsPattern(pattern)) return false;
	const pat = segments(pattern);
	// Git paths are already repository-relative. Whitespace and backslashes
	// are filename characters, not authored-pattern formatting to normalize.
	const target = path.split("/");
	if (pat.length === 0) return false;
	const match = (i: number, j: number): boolean => {
		// Pattern exhausted: it matched `path` itself or an ancestor of it.
		if (i === pat.length) return true;
		const seg = pat[i] as string;
		if (seg === "**") {
			for (let k = j; k <= target.length; k++) {
				if (match(i + 1, k)) return true;
			}
			return false;
		}
		if (j === target.length) return false;
		return segmentMatches(seg, target[j] as string) && match(i + 1, j + 1);
	};
	return match(0, 0);
}

/** Whether some path could be owned by both patterns (conservative, see above). */
export function patternsOverlap(a: string, b: string): boolean {
	const sa = segments(a);
	const sb = segments(b);
	if (sa.length === 0 || sb.length === 0) return false;
	// Old or externally supplied invalid patterns must never crash admission or
	// accidentally authorize concurrent writers. Scope checks likewise fail closed.
	if (validateOwnsPattern(a) || validateOwnsPattern(b)) return true;
	for (let i = 0; ; i++) {
		// One pattern is an ancestor of the other: it owns everything below.
		if (i === sa.length || i === sb.length) return true;
		const x = sa[i] as string;
		const y = sb[i] as string;
		if (x === "**" || y === "**") return true;
		const gx = isGlob(x);
		const gy = isGlob(y);
		if (gx && gy) continue;
		if (gx ? !segmentMatches(x, y) : gy ? !segmentMatches(y, x) : x !== y) {
			return false;
		}
	}
}

/** Pairs `[mine, theirs]` of patterns that overlap. Empty when either side owns nothing. */
export function overlappingPatterns(
	mine: readonly string[],
	theirs: readonly string[],
): [string, string][] {
	const out: [string, string][] = [];
	for (const a of mine) {
		for (const b of theirs) {
			if (patternsOverlap(a, b)) out.push([a, b]);
		}
	}
	return out;
}

/** Files from `changed` that no pattern in `owns` covers. Empty `owns` = no scope declared. */
export function filesOutsideOwns(
	owns: readonly string[],
	changed: readonly string[],
): string[] {
	if (owns.length === 0) return [];
	return changed.filter((file) => !owns.some((p) => ownsPath(p, file)));
}

export interface OwnershipNode {
	id: string;
	owns: readonly string[];
	dependsOn: readonly string[];
}

export interface OwnershipConflict {
	a: string;
	b: string;
	/** Overlapping pattern pairs, `[a's pattern, b's pattern]`. */
	patterns: [string, string][];
}

/**
 * Unordered overlaps: pairs of tasks whose `owns` overlap while neither
 * depends (transitively) on the other, so nothing stops them from running at
 * the same time. `nodes` should be the tasks that have not landed yet.
 */
export function findOwnershipConflicts(
	nodes: readonly OwnershipNode[],
): OwnershipConflict[] {
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const reach = new Map<string, Set<string>>();
	const reachable = (id: string): Set<string> => {
		const known = reach.get(id);
		if (known) return known;
		const seen = new Set<string>();
		reach.set(id, seen); // cycle guard: a cycle is the DAG checker's problem
		const stack = [...(byId.get(id)?.dependsOn ?? [])];
		while (stack.length > 0) {
			const next = stack.pop() as string;
			if (seen.has(next)) continue;
			seen.add(next);
			stack.push(...(byId.get(next)?.dependsOn ?? []));
		}
		return seen;
	};
	const owning = nodes.filter((n) => n.owns.length > 0);
	const out: OwnershipConflict[] = [];
	for (let i = 0; i < owning.length; i++) {
		for (let j = i + 1; j < owning.length; j++) {
			const a = owning[i] as OwnershipNode;
			const b = owning[j] as OwnershipNode;
			if (reachable(a.id).has(b.id) || reachable(b.id).has(a.id)) continue;
			const patterns = overlappingPatterns(a.owns, b.owns);
			if (patterns.length > 0) out.push({ a: a.id, b: b.id, patterns });
		}
	}
	return out;
}
