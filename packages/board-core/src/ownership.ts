/**
 * Path-glob ownership and overlap checking — generic, not board-specific: it
 * operates on plain strings (ids, glob patterns), nothing here reads a
 * `BoardDocument` or a `board.yaml`. Originally written for mfw's `owns:`
 * field (the scheduler uses it to keep two tasks that could touch the same
 * file from running at once; `claim` uses it to refuse a claim that would
 * race a currently-active task's declared scope) and hoisted here once a
 * second project needed the identical "do these two sets of path globs
 * overlap" primitive for its own, unrelated workflow semantics. A consumer's
 * own layer (e.g. `@mfw/board`) supplies the project-specific meaning
 * (what `owns` represents, when conflicts matter); this module only answers
 * the glob-matching question.
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
	const target = path.split("/");
	if (pat.length === 0) return false;
	const match = (i: number, j: number): boolean => {
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
	if (validateOwnsPattern(a) || validateOwnsPattern(b)) return true;
	for (let i = 0; ; i++) {
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

/** Does `outer`'s single segment (literal or glob) provably cover every
 * string `inner`'s single segment could produce? Only the easy cases are
 * decidable (an identical segment; a literal inside a glob); outer-glob vs
 * inner-glob containment is genuinely hard in general, so it's conservatively
 * "no" rather than attempted. */
function segmentContains(outerSeg: string, innerSeg: string): boolean {
	if (outerSeg === innerSeg) return true;
	if (!isGlob(outerSeg)) return false;
	if (!isGlob(innerSeg)) return segmentMatches(outerSeg, innerSeg);
	return false;
}

/**
 * Is every path `inner` could own also owned by `outer`? Conservative in the
 * opposite direction from `patternsOverlap`: false whenever containment isn't
 * clearly provable, never a false positive. An `outer` ending in `**` covers
 * anything beneath its prefix; otherwise every segment must line up exactly
 * (`segmentContains`) and both patterns must be the same length — `inner`
 * having its own `**` is never provably contained by a non-`**` outer
 * segment, however permissive, since `**` can match any depth.
 */
export function patternWithin(inner: string, outer: string): boolean {
	const si = segments(inner);
	const so = segments(outer);
	if (si.length === 0 || so.length === 0) return false;
	if (validateOwnsPattern(inner) || validateOwnsPattern(outer)) return false;
	let i = 0;
	for (let j = 0; j < so.length; j++) {
		const outerSeg = so[j] as string;
		if (outerSeg === "**") return true;
		if (i >= si.length) return false;
		const innerSeg = si[i] as string;
		if (innerSeg === "**") return false;
		if (!segmentContains(outerSeg, innerSeg)) return false;
		i++;
	}
	return i === si.length;
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

// ---------------------------------------------------------------------------
// Exemptions: rulings that let two tasks share files on purpose.
// ---------------------------------------------------------------------------

/** One ruling: `cards` may overlap on exactly `paths` (both patterns of the
 * overlapping pair must be listed). `ruling` and `note` are for humans. */
export interface OwnershipPairExemption {
	cards: [string, string];
	paths: string[];
	ruling?: string;
	note?: string;
}

export interface OwnershipExemptions {
	/** Patterns that any two tasks may overlap on (shared registries, append-only files). */
	appendOnly: string[];
	pairs: OwnershipPairExemption[];
}

export class OwnershipExemptionsError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OwnershipExemptionsError";
	}
}

const isStrings = (v: unknown): v is string[] =>
	Array.isArray(v) && v.every((x) => typeof x === "string");

/**
 * Validate a parsed exemptions document:
 *
 *     append_only: [glob, ...]        # any pair may overlap on these
 *     pairs:
 *       - cards: [ID-A, ID-B]
 *         paths: [glob, ...]          # both patterns of an overlap must be listed
 *         ruling: free text           # optional
 *         note: free text             # optional
 *
 * `knownIds` is every id on the board: a pair naming a task that does not
 * exist is a data error in the table, not a state to tolerate.
 */
export function parseOwnershipExemptions(
	raw: unknown,
	knownIds: ReadonlySet<string>,
): OwnershipExemptions {
	const doc = (raw ?? {}) as Record<string, unknown>;
	if (typeof doc !== "object" || Array.isArray(doc)) {
		throw new OwnershipExemptionsError("must be a YAML mapping");
	}
	const appendOnly = doc.append_only ?? doc.appendOnly ?? [];
	if (!isStrings(appendOnly)) {
		throw new OwnershipExemptionsError(
			"'append_only' must be a list of patterns",
		);
	}
	for (const pattern of appendOnly) {
		const bad = validateOwnsPattern(pattern);
		if (bad)
			throw new OwnershipExemptionsError(`append_only '${pattern}': ${bad}`);
	}
	const rawPairs = doc.pairs ?? [];
	if (!Array.isArray(rawPairs)) {
		throw new OwnershipExemptionsError("'pairs' must be a list");
	}
	const pairs = rawPairs.map((entry: unknown, i): OwnershipPairExemption => {
		const e = (entry ?? {}) as Record<string, unknown>;
		const cards = Array.isArray(e.cards)
			? e.cards.map((c) => (typeof c === "number" ? String(c) : c))
			: e.cards;
		if (!isStrings(cards) || cards.length !== 2) {
			throw new OwnershipExemptionsError(
				`pairs[${i}].cards must be exactly two ids`,
			);
		}
		if (!isStrings(e.paths) || e.paths.length === 0) {
			throw new OwnershipExemptionsError(
				`pairs[${i}].paths must be a non-empty list of patterns`,
			);
		}
		for (const id of cards) {
			if (!knownIds.has(id)) {
				throw new OwnershipExemptionsError(
					`pairs[${i}] names unknown id '${id}' (pair {${cards.join(", ")}})`,
				);
			}
		}
		for (const pattern of e.paths) {
			const bad = validateOwnsPattern(pattern);
			if (bad)
				throw new OwnershipExemptionsError(
					`pairs[${i}].paths '${pattern}': ${bad}`,
				);
		}
		for (const key of ["ruling", "note"] as const) {
			if (e[key] !== undefined && typeof e[key] !== "string") {
				throw new OwnershipExemptionsError(
					`pairs[${i}].${key} must be a string`,
				);
			}
		}
		return {
			cards: [cards[0] as string, cards[1] as string],
			paths: e.paths,
			...(typeof e.ruling === "string" ? { ruling: e.ruling } : {}),
			...(typeof e.note === "string" ? { note: e.note } : {}),
		};
	});
	return { appendOnly, pairs };
}

const isLiteralPath = (p: string): boolean => !/[*?[\]{}]/.test(p);

/** Is `pattern` covered by an append-only entry (literal: owned by it; glob:
 * conservatively contained in it, never a false exemption)? */
function inAppendOnly(ex: OwnershipExemptions, pattern: string): boolean {
	return ex.appendOnly.some((entry) =>
		isLiteralPath(pattern)
			? ownsPath(entry, pattern)
			: patternWithin(pattern, entry),
	);
}

/** Is the overlap of patterns `pa` (task `a`) and `pb` (task `b`) allowed? */
export function isExempt(
	ex: OwnershipExemptions,
	a: string,
	b: string,
	pa: string,
	pb: string,
): boolean {
	const pair = ex.pairs.find(
		(p) =>
			(p.cards[0] === a && p.cards[1] === b) ||
			(p.cards[0] === b && p.cards[1] === a),
	);
	if (pair?.paths.includes(pa) && pair.paths.includes(pb)) return true;
	return inAppendOnly(ex, pa) || inAppendOnly(ex, pb);
}

/** `findOwnershipConflicts` with every exempt pattern pair removed; a conflict
 * left with no pair disappears. */
export function findOwnershipConflictsExempt(
	nodes: readonly OwnershipNode[],
	ex?: OwnershipExemptions,
): OwnershipConflict[] {
	const raw = findOwnershipConflicts(nodes);
	if (!ex) return raw;
	const out: OwnershipConflict[] = [];
	for (const c of raw) {
		const patterns = c.patterns.filter(
			([pa, pb]) => !isExempt(ex, c.a, c.b, pa, pb),
		);
		if (patterns.length > 0) out.push({ ...c, patterns });
	}
	return out;
}

/** Pairs whose tasks are not both still open: the ruling protects nothing. */
export function inertExemptionPairs(
	ex: OwnershipExemptions,
	openIds: ReadonlySet<string>,
): OwnershipPairExemption[] {
	return ex.pairs.filter(
		(p) => !openIds.has(p.cards[0]) || !openIds.has(p.cards[1]),
	);
}
