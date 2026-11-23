/**
 * Typed claims (DESIGN W2 "Typed briefing claims"): nothing the UI states as
 * fact may rest on an agent's say-so.
 *
 * Three classes:
 * - `host-observed`: the host derived it (a verifier exit, a merge, a probe).
 * - `agent-reported`: it came out of a sandbox.
 * - `inference`: the brain wrote it, or it was computed from other statements.
 *
 * A strong word renders as fact only with a `Backing` for that word and
 * subject. A `Backing` has one origin: `HostEvidence.fromEvents`, which folds
 * host-written audit events. It cannot be built from a literal, and it does
 * not survive serialization, so a forged or replayed claim renders weak.
 *
 * Pure: `claims-evidence.ts` reads the rows.
 */

export const CLAIM_CLASSES = [
	"host-observed",
	"agent-reported",
	"inference",
] as const;
export type ClaimClass = (typeof CLAIM_CLASSES)[number];

/** The closed list. A new strong word is added here and in `RECORDS_FOR`. */
export const STRONG_WORDS = [
	"verified",
	"deployed",
	"healthy",
	"passing",
	"merged",
	"fixed",
] as const;
export type StrongWord = (typeof STRONG_WORDS)[number];

export type HostRecordKind = "verification" | "merge" | "deployment" | "health";

/** The host records a word needs, all of them, for the same subject. */
export const RECORDS_FOR: Record<StrongWord, readonly HostRecordKind[]> = {
	verified: ["verification"],
	passing: ["verification"],
	merged: ["merge"],
	deployed: ["deployment"],
	healthy: ["health"],
	fixed: ["verification", "merge"],
};

export interface ClaimSubject {
	kind: "task" | "run" | "deployment";
	id: string;
}

/** The audit event a claim can be followed to. */
export interface HostRecordRef {
	kind: HostRecordKind;
	seq: number;
}

declare const backedWord: unique symbol;

/** Proof from host records. Invariant in `W`: one word's backing never fits another. */
export type Backing<W extends StrongWord> = Readonly<{
	word: W;
	subject: ClaimSubject;
	records: readonly HostRecordRef[];
	[backedWord]: (w: W) => W;
}>;

/** Only `HostEvidence` adds to this, so a look-alike object is not a backing. */
const MINTED = new WeakSet<object>();

export interface AgentSays {
	from: "agent";
}
export interface Inferred {
	from: "inference";
}
export const agentSays: AgentSays = { from: "agent" };
export const inferred: Inferred = { from: "inference" };

export interface Claim {
	word: StrongWord;
	subject: ClaimSubject;
	backing: Backing<StrongWord> | AgentSays | Inferred;
}

/**
 * The producer API. A strong word stated as fact needs its own `Backing`;
 * without one the caller must say whose word it is.
 */
export function claim<W extends StrongWord>(
	word: W,
	subject: ClaimSubject,
	backing: Backing<W> | AgentSays | Inferred,
): Claim {
	return { word, subject, backing: backing as Claim["backing"] };
}

export interface RenderedClaim {
	class: ClaimClass;
	text: string;
	word: StrongWord | null;
	subject: ClaimSubject | null;
	/** The statement was shown in a weaker form than it was made. */
	weakened: boolean;
	records: readonly HostRecordRef[];
}

const sameSubject = (a: ClaimSubject, b: ClaimSubject) =>
	a.kind === b.kind && a.id === b.id;

function isValidBacking(
	c: Claim,
): c is Claim & { backing: Backing<StrongWord> } {
	const b = c.backing as Partial<Backing<StrongWord>>;
	return (
		MINTED.has(c.backing) &&
		b.word === c.word &&
		!!b.subject &&
		sameSubject(b.subject, c.subject)
	);
}

/** The one renderer of a claim. Anything it cannot prove renders weak. */
export function renderClaim(c: Claim): RenderedClaim {
	const base = { word: c.word, subject: c.subject };
	if (isValidBacking(c)) {
		return {
			...base,
			class: "host-observed",
			text: c.word,
			weakened: false,
			records: c.backing.records,
		};
	}
	const from = (c.backing as { from?: unknown } | null)?.from;
	if (from === "agent") {
		return {
			...base,
			class: "agent-reported",
			text: `agent says it is ${c.word}`,
			weakened: true,
			records: [],
		};
	}
	// Inferred, or something that presented itself as a backing and is not one.
	return {
		...base,
		class: "inference",
		text: `unverified: inferred ${c.word}`,
		weakened: true,
		records: [],
	};
}

// ---------- host evidence ----------

/** An audit event row, as `claims-evidence.ts` reads it. */
export interface EvidenceEvent {
	seq: number;
	type: string;
	taskId?: string | null;
	runId?: string | null;
	payload: Record<string, unknown>;
}

/** The only event types that can back a claim. All are written by the host. */
export const EVIDENCE_EVENT_TYPES = [
	"verify.check",
	"merge.completed",
	"merge.parked",
	"main.red",
	"deployment.probed",
] as const;

interface RunFold {
	taskId: string | null;
	lastCheck: number;
	allPassed: boolean;
	lastMerge: number;
	lastReverifyPark: number;
}

/** What the host's own records establish. Built only by folding events. */
export class HostEvidence {
	private readonly runs = new Map<string, RunFold>();
	/** Task to its run with the newest verification. */
	private readonly latestVerified = new Map<string, string>();
	private readonly mergedRuns = new Map<string, string>();
	private readonly regressedAt = new Map<string, number>();
	private readonly probes = new Map<string, { ok: boolean; seq: number }>();
	readonly deploymentTargets = new Set<string>();

	private constructor() {}

	static empty(): HostEvidence {
		return new HostEvidence();
	}

	/** Fold rows in `seq` order, whatever order they arrive in. */
	static fromEvents(rows: readonly EvidenceEvent[]): HostEvidence {
		const out = new HostEvidence();
		for (const e of [...rows].sort((a, b) => a.seq - b.seq)) out.add(e);
		return out;
	}

	private run(id: string, taskId: string | null | undefined): RunFold {
		let r = this.runs.get(id);
		if (!r) {
			r = {
				taskId: taskId ?? null,
				lastCheck: 0,
				allPassed: true,
				lastMerge: 0,
				lastReverifyPark: 0,
			};
			this.runs.set(id, r);
		}
		if (taskId && !r.taskId) r.taskId = taskId;
		return r;
	}

	private add(e: EvidenceEvent): void {
		const p = e.payload;
		switch (e.type) {
			case "verify.check": {
				if (!e.runId || typeof p.passed !== "boolean") return;
				const r = this.run(e.runId, e.taskId);
				r.lastCheck = e.seq;
				// A failure anywhere in the run's verification stays a failure.
				r.allPassed &&= p.passed;
				if (e.taskId) this.latestVerified.set(e.taskId, e.runId);
				return;
			}
			case "merge.completed": {
				if (!e.runId || typeof p.sha !== "string" || p.sha === "") return;
				this.run(e.runId, e.taskId).lastMerge = e.seq;
				if (e.taskId) this.mergedRuns.set(e.taskId, e.runId);
				return;
			}
			case "merge.parked": {
				if (!e.runId || p.kind !== "reverify") return;
				this.run(e.runId, e.taskId).lastReverifyPark = e.seq;
				return;
			}
			case "main.red": {
				if (typeof p.causeTaskId === "string") {
					this.regressedAt.set(p.causeTaskId, e.seq);
				}
				return;
			}
			case "deployment.probed": {
				if (typeof p.target !== "string" || typeof p.ok !== "boolean") return;
				if (p.probe !== "deploy" && p.probe !== "health") return;
				this.deploymentTargets.add(p.target);
				this.probes.set(`${p.probe}:${p.target}`, { ok: p.ok, seq: e.seq });
				return;
			}
		}
	}

	private runOf(s: ClaimSubject, kind: "verify" | "merge"): RunFold | null {
		if (s.kind === "run") return this.runs.get(s.id) ?? null;
		if (s.kind !== "task") return null;
		const id = (kind === "verify" ? this.latestVerified : this.mergedRuns).get(
			s.id,
		);
		return id ? (this.runs.get(id) ?? null) : null;
	}

	private verification(s: ClaimSubject): HostRecordRef | null {
		const r = this.runOf(s, "verify");
		if (!r || r.lastCheck === 0 || !r.allPassed) return null;
		// A failed re-verify after the checks outranks them until a merge lands.
		if (r.lastReverifyPark > Math.max(r.lastCheck, r.lastMerge)) return null;
		return { kind: "verification", seq: r.lastCheck };
	}

	private merge(s: ClaimSubject): HostRecordRef | null {
		const r = this.runOf(s, "merge");
		return r && r.lastMerge > 0 ? { kind: "merge", seq: r.lastMerge } : null;
	}

	private probe(
		s: ClaimSubject,
		probe: "deploy" | "health",
	): HostRecordRef | null {
		if (s.kind !== "deployment") return null;
		const p = this.probes.get(`${probe}:${s.id}`);
		return p?.ok
			? { kind: probe === "deploy" ? "deployment" : "health", seq: p.seq }
			: null;
	}

	private fixed(s: ClaimSubject): HostRecordRef[] | null {
		const v = this.verification(s);
		const m = this.merge(s);
		if (!v || !m) return null;
		// The merged run must be the verified one, or the pass is about other code.
		if (this.runOf(s, "verify") !== this.runOf(s, "merge")) return null;
		const taskId = s.kind === "task" ? s.id : this.runs.get(s.id)?.taskId;
		const red = taskId ? this.regressedAt.get(taskId) : undefined;
		return red !== undefined && red > m.seq ? null : [v, m];
	}

	/** The proof for this word and subject, or null when the host has none. */
	backing<W extends StrongWord>(
		word: W,
		subject: ClaimSubject,
	): Backing<W> | null {
		const records = this.recordsFor(word, subject);
		if (!records) return null;
		const b = { word, subject: { ...subject }, records };
		MINTED.add(b);
		return b as unknown as Backing<W>;
	}

	private recordsFor(
		word: StrongWord,
		s: ClaimSubject,
	): HostRecordRef[] | null {
		const one = (r: HostRecordRef | null) => (r ? [r] : null);
		switch (word) {
			case "verified":
			case "passing":
				return one(this.verification(s));
			case "merged":
				return one(this.merge(s));
			case "deployed":
				return one(this.probe(s, "deploy"));
			case "healthy":
				return one(this.probe(s, "health"));
			case "fixed":
				return this.fixed(s);
		}
	}

	/** Whether any subject of any kind with this id backs the word. */
	backsId(word: StrongWord, id: string): boolean {
		return (["task", "run", "deployment"] as const).some(
			(kind) => this.recordsFor(word, { kind, id }) !== null,
		);
	}
}

// ---------- the free-text guard ----------

/** Look-alike letters that NFKD leaves alone, mapped to the Latin they imitate. */
const CONFUSABLES: Readonly<Record<string, string>> = {
	а: "a",
	е: "e",
	о: "o",
	р: "p",
	с: "c",
	у: "y",
	х: "x",
	і: "i",
	ј: "j",
	ѕ: "s",
	һ: "h",
	ԁ: "d",
	ѵ: "v",
	ν: "v",
	ο: "o",
	α: "a",
	ι: "i",
	ρ: "p",
	τ: "t",
	ε: "e",
	ɡ: "g",
	ı: "i",
	"’": "'",
	ʼ: "'",
};

/**
 * Lower-case, compatibility-decomposed text with marks and invisible format
 * characters removed, plus each folded unit's offset in the original.
 */
export function foldText(text: string): { folded: string; map: number[] } {
	let folded = "";
	const map: number[] = [];
	let i = 0;
	for (const ch of text) {
		const base = ch
			.normalize("NFKD")
			.toLowerCase()
			.replace(/[\p{M}\p{Cf}]/gu, "");
		for (const unit of base) {
			const mapped = CONFUSABLES[unit] ?? unit;
			for (let k = 0; k < mapped.length; k++) map.push(i);
			folded += mapped;
		}
		i += ch.length;
	}
	map.push(text.length);
	return { folded, map };
}

const WORD_RE = new RegExp(
	`(?<![\\p{L}\\p{N}_])(${STRONG_WORDS.join("|")})(?![\\p{L}\\p{N}_])`,
	"gu",
);

export type ClaimAuthor = "brain" | "agent" | "records";

const MARKS: Record<ClaimAuthor, string> = {
	brain: "(brain's claim, no host record)",
	agent: "(agent says, no host record)",
	records: "(claimed, no host record)",
};
const MARK_AHEAD =
	/^\s*\((?:brain's claim|agent says|claimed), no host record\)/;

const NEGATORS = new Set([
	"not",
	"never",
	"no",
	"none",
	"nothing",
	"neither",
	"nor",
	"cannot",
	"cant",
	"wont",
	"without",
]);
/** Negate only as "failed to ...". */
const FAILED_TO = new Set(["failed", "fails", "fail", "unable"]);
/** The future or a condition: nothing is asserted to be true now. */
const MODALS = new Set([
	"might",
	"may",
	"could",
	"should",
	"would",
	"will",
	"must",
	"shall",
	"can",
	"to",
	"if",
	"once",
	"unless",
	"until",
	"when",
	"whether",
	"after",
	"before",
	"pending",
	"awaiting",
]);
/** May sit between a negator or modal and the word without changing the link. */
const FILLERS = new Set([
	"be",
	"been",
	"being",
	"is",
	"are",
	"was",
	"were",
	"has",
	"have",
	"had",
	"do",
	"does",
	"did",
	"yet",
	"fully",
	"actually",
	"really",
	"currently",
	"properly",
	"successfully",
	"longer",
	"still",
	"ever",
	"it",
	"this",
	"that",
	"get",
	"got",
]);
const ATTRIBUTIONS = new Set(["says", "said", "claims", "claimed"]);
const ATTRIBUTION_ADVERBS = new Set(["reportedly", "allegedly", "supposedly"]);
/** What follows a verb of saying when it really introduces someone's claim. */
const ATTRIBUTED = new Set(["it", "it's", "that", "they", "they're", "to"]);
const INFINITIVE = new Set(["be", "being", "been", "get"]);
const STRONG: ReadonlySet<string> = new Set(STRONG_WORDS);
const REPORTERS = new Set(["agent", "agents", "worker", "workers", "run"]);
/** "fixed" as an ordinary adjective: "a fixed width". */
const FIXED_NOUNS = new Set([
	"size",
	"width",
	"height",
	"length",
	"point",
	"cost",
	"costs",
	"price",
	"rate",
	"number",
	"order",
	"format",
	"version",
	"schedule",
	"window",
	"string",
	"seed",
	"budget",
	"interval",
	"delay",
	"timeout",
	"port",
	"position",
]);

const tokensOf = (s: string) => s.match(/[\p{L}\p{N}']+/gu) ?? [];

/** "isn't" counts as a negator, and "isn't" alone is not a filler. */
const isNegator = (t: string) =>
	NEGATORS.has(t) ||
	t.endsWith("n't") ||
	/^(?:is|was|are|were|has|have|had|do|does|did|could|would|should)nt$/.test(t);

/** Does the clause before the word stop it from being a plain assertion? */
function notAsserted(before: string, after: string): boolean {
	const tokens = tokensOf(before);
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i] as string;
		const next = tokens[i + 1];
		if (ATTRIBUTION_ADVERBS.has(t)) return true;
		// "says it is", not "the claimed fix" or "claimed task".
		if (ATTRIBUTIONS.has(t) && (!next || ATTRIBUTED.has(next))) return true;
		if (
			(t === "reports" || t === "reported") &&
			REPORTERS.has(tokens[i - 1] ?? "")
		) {
			return true;
		}
	}
	let negators = 0;
	for (let i = tokens.length - 1; i >= 0; i--) {
		const t = tokens[i] as string;
		if (isNegator(t)) {
			negators++;
			continue;
		}
		if (FAILED_TO.has(t) && tokens[i + 1] === "to") {
			negators++;
			continue;
		}
		// "not merged or deployed": the negation carries across the list.
		if (t === "or" && STRONG.has(tokens[i - 1] ?? "")) {
			i--;
			continue;
		}
		// "to be merged" is a future; "moved to merged" is a status.
		if (t === "to" && !INFINITIVE.has(tokens[i + 1] ?? "")) break;
		if (MODALS.has(t)) {
			// "not to be merged" and "to be merged" both assert nothing.
			if (negators === 0 || t !== "to") return true;
			continue;
		}
		if (!FILLERS.has(t)) break;
	}
	// "not not verified" is an assertion again.
	if (negators % 2 === 1) return true;
	return /^\s*(?:yet|pending)\b/.test(after);
}

/** Part of an identifier, a path or a `key=false` pair: not a statement. */
function isIdentifier(word: string, before: string, after: string): boolean {
	// "verified/deployed" is two claims, not a path.
	const left = before.match(/([\p{L}\p{N}_-]+)\/$/u)?.[1];
	const right = after.match(/^\/([\p{L}\p{N}_-]+)/u)?.[1];
	const isStrong = (t: string | undefined) =>
		(STRONG_WORDS as readonly (string | undefined)[]).includes(t);
	if (isStrong(left) || isStrong(right)) return false;
	if (left !== undefined || before.endsWith("/")) return true;
	if (before.endsWith(".") && !/^[.!?]?(\s|$)/.test(after)) return true;
	if (/^[./_][\p{L}\p{N}]/u.test(after)) return true;
	if (/^=\s*(false|0|no)\b/.test(after)) return true;
	if (word === "fixed") {
		if (after.startsWith("-")) return true;
		const next = tokensOf(after)[0];
		if (next && /^\s/.test(after) && FIXED_NOUNS.has(next)) return true;
	}
	return false;
}

const NEGATED_PREFIX = /(?:^|[^\p{L}\p{N}])(?:un|non|not)-$/u;
const CLAUSE_BREAK = /[,;:()—–]|\b(?:but|however|although|though)\b/gu;

/** Sentence spans: a stop counts only before whitespace, so "v1.2" does not split. */
function sentenceSpans(s: string): [number, number][] {
	const out: [number, number][] = [];
	const stop = /\n|[.!?]+(?=\s|$)/g;
	let from = 0;
	for (const m of s.matchAll(stop)) {
		const end = m.index + m[0].length;
		out.push([from, end]);
		from = end;
	}
	if (from < s.length) out.push([from, s.length]);
	return out;
}

/** Task-shaped (`MFW-60`) and run-shaped (ULID) ids a sentence names. */
const SUBJECT_ID = /\b[A-Za-z][A-Za-z0-9]*-\d+\b|\b[0-9A-HJKMNP-TV-Z]{26}\b/g;

export function subjectIdsIn(text: string): string[] {
	return [...new Set(text.match(SUBJECT_ID) ?? [])];
}

export interface GuardFinding {
	word: StrongWord;
	/** Offset of the word in the original text. */
	index: number;
	outcome: "backed" | "annotated";
}

export interface GuardResult {
	text: string;
	changed: boolean;
	/** The input, kept whole when the guard changed anything. */
	original?: string;
	findings: GuardFinding[];
}

export interface GuardOptions {
	author: ClaimAuthor;
	/** Who the text is about when a sentence names no id itself. */
	subject?: ClaimSubject | null;
}

function sentenceBacks(
	word: StrongWord,
	sentence: string,
	evidence: HostEvidence,
	subject: ClaimSubject | null | undefined,
): boolean {
	const ids = subjectIdsIn(sentence);
	const lower = sentence.toLowerCase();
	for (const target of evidence.deploymentTargets) {
		const at = lower.indexOf(target.toLowerCase());
		if (at < 0) continue;
		const before = lower[at - 1] ?? " ";
		const next = lower[at + target.length] ?? " ";
		if (!/[\p{L}\p{N}_-]/u.test(before) && !/[\p{L}\p{N}_-]/u.test(next)) {
			ids.push(target);
		}
	}
	// Every subject named must be backed: "A and B are merged" needs both.
	if (ids.length > 0) return ids.every((id) => evidence.backsId(word, id));
	return subject ? evidence.backing(word, subject) !== null : false;
}

/**
 * Mark each strong word that is asserted without a host record. The guard only
 * ever inserts a marker after the word: the author's text stays intact, in
 * order, so a negation keeps its meaning and no strong word can appear.
 * Idempotent.
 */
export function guardText(
	text: string,
	evidence: HostEvidence,
	opts: GuardOptions,
): GuardResult {
	const { folded, map } = foldText(text);
	const findings: GuardFinding[] = [];
	const inserts: number[] = [];
	for (const [start, stop] of sentenceSpans(folded)) {
		const raw = folded.slice(start, stop);
		const question = /\?+\s*$/.test(raw);
		const sentence = text.slice(
			map[start] ?? 0,
			map[start + raw.length] ?? text.length,
		);
		for (const w of raw.matchAll(WORD_RE)) {
			const word = w[1] as StrongWord;
			const at = w.index;
			const end = at + word.length;
			const after = raw.slice(end);
			const whole = folded.slice(start + end);
			if (question || MARK_AHEAD.test(whole)) continue;
			const before = raw.slice(0, at);
			if (isIdentifier(word, before, after)) continue;
			if (NEGATED_PREFIX.test(before)) continue;
			const breaks = [...before.matchAll(CLAUSE_BREAK)];
			const last = breaks.at(-1);
			const clause = last
				? before.slice((last.index ?? 0) + last[0].length)
				: before;
			if (notAsserted(clause, after)) continue;
			const index = map[start + at] ?? 0;
			if (sentenceBacks(word, sentence, evidence, opts.subject)) {
				findings.push({ word, index, outcome: "backed" });
			} else {
				findings.push({ word, index, outcome: "annotated" });
				inserts.push(map[start + end] ?? text.length);
			}
		}
	}
	if (inserts.length === 0) return { text, changed: false, findings };
	let out = "";
	let from = 0;
	for (const at of inserts) {
		out += `${text.slice(from, at)} ${MARKS[opts.author]}`;
		from = at;
	}
	out += text.slice(from);
	return { text: out, changed: true, original: text, findings };
}

/** Strong words in `text` as a reader would see them, for tests and audits. */
export function strongWordCount(text: string): number {
	return [...foldText(text).folded.matchAll(WORD_RE)].length;
}

/** Remove the guard's markers, recovering what the author wrote. */
export function stripClaimMarks(text: string): string {
	return text.replace(
		/ \((?:brain's claim|agent says|claimed), no host record\)/g,
		"",
	);
}

/** One short instruction for the brain's prompts. */
export const CLAIM_INSTRUCTION =
	'Say "verified", "deployed", "healthy", "passing", "merged" or "fixed" only when a host record shows it; otherwise write "agent says" or "unverified". Unbacked uses are marked.';

/** A statement with no strong word of its own, tagged with its class. */
export function statement(
	cls: ClaimClass,
	text: string,
	evidence: HostEvidence = HostEvidence.empty(),
	subject?: ClaimSubject | null,
): RenderedClaim {
	const author: ClaimAuthor =
		cls === "agent-reported"
			? "agent"
			: cls === "inference"
				? "brain"
				: "records";
	const g = guardText(text, evidence, { author, subject });
	return {
		// Host text that needed a marker was not host-observed after all.
		class: g.changed && cls === "host-observed" ? "inference" : cls,
		text: g.text,
		word: null,
		subject: subject ?? null,
		weakened: g.changed,
		records: [],
	};
}
