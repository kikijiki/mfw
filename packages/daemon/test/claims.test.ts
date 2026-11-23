import { describe, expect, test } from "bun:test";
import {
	agentSays,
	type Backing,
	type Claim,
	claim,
	type EvidenceEvent,
	foldText,
	guardText,
	HostEvidence,
	inferred,
	renderClaim,
	STRONG_WORDS,
	type StrongWord,
	statement,
	stripClaimMarks,
	strongWordCount,
} from "../src/claims.ts";

const TASK = { kind: "task", id: "MFW-1" } as const;
const TARGET = { kind: "deployment", id: "prod" } as const;

let seq = 0;
const ev = (
	type: string,
	payload: Record<string, unknown>,
	ids: { taskId?: string; runId?: string } = {},
): EvidenceEvent => ({ seq: ++seq, type, payload, ...ids });

const R = { taskId: "MFW-1", runId: "run-1" };
const check = (passed: boolean, ids = R) =>
	ev("verify.check", { check: "test", passed }, ids);
const merge = (ids = R) =>
	ev("merge.completed", { sha: "abc", target: "main" }, ids);
const probe = (kind: "deploy" | "health", ok: boolean, target = "prod") =>
	ev("deployment.probed", { target, probe: kind, ok });

const FULL = () =>
	HostEvidence.fromEvents([
		check(true),
		merge(),
		probe("deploy", true),
		probe("health", true),
	]);

const subjectFor = (w: StrongWord) =>
	w === "deployed" || w === "healthy" ? TARGET : TASK;

describe("each strong word", () => {
	for (const word of STRONG_WORDS) {
		test(`${word} renders as fact with its host record`, () => {
			const backing = FULL().backing(word, subjectFor(word));
			expect(backing).not.toBeNull();
			const r = renderClaim(
				claim(word, subjectFor(word), backing as Backing<typeof word>),
			);
			expect(r).toMatchObject({
				class: "host-observed",
				text: word,
				weakened: false,
			});
			expect(r.records.length).toBeGreaterThan(0);
		});

		test(`${word} has no backing without a record`, () => {
			expect(HostEvidence.empty().backing(word, subjectFor(word))).toBeNull();
		});

		test(`${word} from an agent stays the agent's word`, () => {
			expect(
				renderClaim(claim(word, subjectFor(word), agentSays)),
			).toMatchObject({
				class: "agent-reported",
				text: `agent says it is ${word}`,
				weakened: true,
			});
		});

		test(`${word} inferred renders unverified`, () => {
			const r = renderClaim(claim(word, subjectFor(word), inferred));
			expect(r.class).toBe("inference");
			expect(r.text).toStartWith("unverified:");
		});

		test(`free text with an unbacked ${word} is marked`, () => {
			const g = guardText(`MFW-1 is ${word}.`, HostEvidence.empty(), {
				author: "brain",
			});
			expect(g.text).toBe(`MFW-1 is ${word} (brain's claim, no host record).`);
			expect(g.original).toBe(`MFW-1 is ${word}.`);
		});
	}
});

describe("the type level", () => {
	test("an unbacked strong claim does not compile", () => {
		const e = FULL();
		const verified = e.backing("verified", TASK) as Backing<"verified">;
		// Each line is a compile error, checked by `tsc`; at runtime each renders weak.
		// @ts-expect-error a strong word needs a backing
		const a = claim("verified", TASK, null);
		// @ts-expect-error a backing for one word does not fit another
		const b = claim("deployed", TARGET, verified);
		// @ts-expect-error a literal is not a backing
		const c = claim("merged", TASK, {
			word: "merged",
			subject: TASK,
			records: [],
		});
		for (const x of [a, b, c]) {
			expect(renderClaim(x).class).not.toBe("host-observed");
		}
	});
});

describe("forged claims", () => {
	test("a fake report claiming deployed and healthy renders weak", () => {
		for (const word of ["deployed", "healthy"] as const) {
			const forged = {
				word,
				subject: TARGET,
				backing: {
					word,
					subject: TARGET,
					records: [{ kind: "deployment", seq: 1 }],
				},
			} as unknown as Claim;
			const r = renderClaim(forged);
			expect(r.class).toBe("inference");
			expect(r.weakened).toBe(true);
			expect(r.records).toEqual([]);
		}
	});

	test("a real backing does not survive a JSON round trip", () => {
		const c = claim(
			"merged",
			TASK,
			FULL().backing("merged", TASK) as Backing<"merged">,
		);
		expect(renderClaim(c).class).toBe("host-observed");
		expect(renderClaim(JSON.parse(JSON.stringify(c))).class).toBe("inference");
	});

	test("a backing cannot be moved to another subject", () => {
		const b = FULL().backing("merged", TASK) as Backing<"merged">;
		const r = renderClaim(claim("merged", { kind: "task", id: "MFW-2" }, b));
		expect(r.class).toBe("inference");
	});

	test("an event type outside the closed list backs nothing", () => {
		const e = HostEvidence.fromEvents([
			ev("agent.report", { passed: true, sha: "abc", ok: true }, R),
		]);
		for (const w of STRONG_WORDS) expect(e.backing(w, TASK)).toBeNull();
	});
});

describe("what counts as a record of the right kind", () => {
	test("verification does not back merged, nor merge verified", () => {
		const v = HostEvidence.fromEvents([check(true)]);
		expect(v.backing("verified", TASK)).not.toBeNull();
		expect(v.backing("merged", TASK)).toBeNull();
		const m = HostEvidence.fromEvents([merge()]);
		expect(m.backing("merged", TASK)).not.toBeNull();
		expect(m.backing("verified", TASK)).toBeNull();
	});

	test("one failed check means not verified", () => {
		const e = HostEvidence.fromEvents([check(true), check(false), check(true)]);
		expect(e.backing("verified", TASK)).toBeNull();
		expect(e.backing("passing", TASK)).toBeNull();
	});

	test("the task's newest verified run decides", () => {
		const R2 = { taskId: "MFW-1", runId: "run-2" };
		const e = HostEvidence.fromEvents([check(true), check(false, R2)]);
		expect(e.backing("verified", TASK)).toBeNull();
	});

	test("a failed re-verify withdraws verified until a merge lands", () => {
		const passed = check(true);
		const parked = ev("merge.parked", { kind: "reverify" }, R);
		const e = HostEvidence.fromEvents([passed, parked]);
		expect(e.backing("verified", TASK)).toBeNull();
		const landed = HostEvidence.fromEvents([passed, parked, merge()]);
		expect(landed.backing("verified", TASK)).not.toBeNull();
	});

	test("fixed needs verify and merge of the same run", () => {
		const other = { taskId: "MFW-1", runId: "run-2" };
		const e = HostEvidence.fromEvents([check(true), merge(other)]);
		expect(e.backing("fixed", TASK)).toBeNull();
	});

	test("a later main.red blaming the task withdraws fixed but not merged", () => {
		const e = HostEvidence.fromEvents([
			check(true),
			merge(),
			ev("main.red", { causeTaskId: "MFW-1" }),
		]);
		expect(e.backing("fixed", TASK)).toBeNull();
		expect(e.backing("merged", TASK)).not.toBeNull();
	});

	test("the newest probe decides, per target and per probe", () => {
		const e = HostEvidence.fromEvents([
			probe("health", true),
			probe("health", false),
			probe("deploy", true),
		]);
		expect(e.backing("healthy", TARGET)).toBeNull();
		expect(e.backing("deployed", TARGET)).not.toBeNull();
		expect(
			e.backing("deployed", { kind: "deployment", id: "staging" }),
		).toBeNull();
	});

	test("a probe says nothing about a task", () => {
		expect(FULL().backing("deployed", TASK)).toBeNull();
	});
});

const brain = { author: "brain" } as const;
const none = HostEvidence.empty();
const unchanged = (s: string) => {
	const g = guardText(s, none, brain);
	expect(g.text).toBe(s);
	expect(g.changed).toBe(false);
};
const marked = (s: string) => {
	expect(guardText(s, none, brain).changed).toBe(true);
};

describe("the guard: negation and hedging", () => {
	for (const s of [
		"MFW-1 is not verified.",
		"MFW-1 isn't verified.",
		"MFW-1 isn’t verified.",
		"This was never deployed.",
		"It has not yet been merged.",
		"It is no longer healthy.",
		"It could not be verified.",
		"It cannot be verified.",
		"Neither verified nor deployed.",
		"We failed to get it verified.",
		"It is non-verified.",
		"The agent says it is fixed.",
		"The worker reported it fixed.",
		"It is reportedly deployed.",
		"It should be fixed by the next run.",
		"It will be merged after review.",
		"It needs to be verified.",
		"Once merged, restart the service.",
		"Is it deployed?",
		"It is unverified and unhealthy.",
		"It is not merged or deployed.",
		"It is not verified or healthy.",
		"It isnt verified.",
		"It hasnt been merged.",
		"The agent claims that it is fixed.",
		"The agent says it's deployed.",
		"It needs to get verified.",
	]) {
		test(`leaves alone: ${s}`, () => unchanged(s));
	}

	for (const s of [
		"It is not only verified but shipped.",
		"It is not not verified.",
		"No issue, it is verified.",
		"The agent says so, but it is verified.",
		"All claims are verified.",
		"No issue it is verified.",
		"Deployed!",
		"VERIFIED",
		"Auto-merged into main.",
		"We merged v1.2 today.",
		"It is verified/deployed.",
		"The task moved to merged.",
		"Status changed to deployed.",
		"Claimed task MFW-1 is merged.",
		"The claimed fix is verified.",
		"Said task is fixed.",
		"- MFW-1: verified",
		"**Deployed** to prod",
		"Merged, verified, deployed.",
	]) {
		test(`marks: ${s}`, () => marked(s));
	}

	test("a question does not shield the next sentence", () => {
		const g = guardText("Is it deployed? It is deployed.", none, brain);
		expect(g.text).toBe(
			"Is it deployed? It is deployed (brain's claim, no host record).",
		);
	});

	test("only the asserted word in a sentence is marked", () => {
		const g = guardText("Not verified, but merged.", none, brain);
		expect(g.text).toBe(
			"Not verified, but merged (brain's claim, no host record).",
		);
	});
});

describe("the guard: not statements", () => {
	for (const s of [
		"See src/merged.ts for details",
		"The is_verified flag",
		"a fixed-size buffer",
		"Use a fixed width and a fixed timeout.",
		"verified=false",
		"path/to/deployed/file",
	]) {
		test(`leaves alone: ${s}`, () => unchanged(s));
	}

	test("a key claiming success is still a claim", () => marked("healthy=true"));
});

describe("the guard: Unicode and case", () => {
	for (const [name, s] of [
		["upper case", "It is DEPLOYED."],
		["mixed case", "It is VeRiFiEd."],
		["full-width", "It is ｖｅｒｉｆｉｅｄ."],
		["zero-width joiner", "It is ver​ified."],
		["soft hyphen", "It is de­ployed."],
		["combining mark", "It is verifiéd."],
		["precomposed accent", "It is verifíed."],
		["Cyrillic look-alike", "It is vеrifiеd."],
		["Greek look-alike", "It is hεalthy."],
	] as const) {
		test(`${name} is caught and its bytes are kept`, () => {
			const g = guardText(s, none, brain);
			expect(g.changed).toBe(true);
			expect(stripClaimMarks(g.text)).toBe(s);
		});
	}

	test("a marker lands after a word's trailing invisible characters", () => {
		const g = guardText("fixed​ now", none, brain);
		expect(g.text).toBe("fixed​ (brain's claim, no host record) now");
	});

	test("astral characters keep the offsets right", () => {
		const g = guardText("🎉🎉 It is merged 🎉", none, brain);
		expect(g.text).toBe("🎉🎉 It is merged (brain's claim, no host record) 🎉");
	});

	test("the fold maps every unit back into the text", () => {
		const s = "ﬁxed 🎉 ｖ​e";
		const { folded, map } = foldText(s);
		expect(map).toHaveLength(folded.length + 1);
		expect(map.at(-1)).toBe(s.length);
		expect([...map].sort((a, b) => a - b)).toEqual(map);
	});
});

describe("the guard: subjects", () => {
	const e = () =>
		HostEvidence.fromEvents([
			check(true),
			merge(),
			probe("deploy", true),
			probe("health", true),
		]);

	test("a backed sentence is left as written", () => {
		const s = "MFW-1 is verified and merged.";
		const g = guardText(s, e(), brain);
		expect(g.text).toBe(s);
		expect(g.findings.map((f) => f.outcome)).toEqual(["backed", "backed"]);
	});

	test("every subject named must be backed", () => {
		expect(guardText("MFW-1 and MFW-2 are merged.", e(), brain).changed).toBe(
			true,
		);
	});

	test("a sentence naming no subject needs the caller's", () => {
		expect(guardText("It is merged.", e(), brain).changed).toBe(true);
		const g = guardText("It is merged.", e(), { ...brain, subject: TASK });
		expect(g.changed).toBe(false);
	});

	test("a named subject outranks the caller's", () => {
		const g = guardText("MFW-2 is merged.", e(), { ...brain, subject: TASK });
		expect(g.changed).toBe(true);
	});

	test("a probed target backs its own words only", () => {
		expect(guardText("prod is healthy.", e(), brain).changed).toBe(false);
		expect(guardText("reprod is healthy.", e(), brain).changed).toBe(true);
		expect(guardText("prod is merged.", e(), brain).changed).toBe(true);
	});

	test("a verification does not back deployed in text", () => {
		expect(guardText("MFW-1 is deployed.", e(), brain).changed).toBe(true);
	});
});

describe("guard properties", () => {
	// A seeded generator, so a failure reproduces.
	const rng = (seed: number) => () => {
		seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
		return seed / 2 ** 32;
	};
	const ATOMS = [
		...STRONG_WORDS,
		"not",
		"never",
		"isn't",
		"agent says",
		"it",
		"is",
		"MFW-1",
		"MFW-2",
		"prod",
		"unverified",
		"to be",
		"but",
		",",
		".",
		"?",
		"!",
		"\n",
		"(",
		")",
		"-",
		"/",
		"=",
		"​",
		"́",
		"🎉",
		"ｖｅｒｉｆｉｅｄ",
		"vеrified",
		"(brain's claim, no host record)",
	];
	const sample = (r: () => number) =>
		Array.from({ length: Math.floor(r() * 14) }, () => {
			const atom = ATOMS[Math.floor(r() * ATOMS.length)] as string;
			return r() < 0.75 ? `${atom} ` : atom;
		}).join("");
	const evidences = [none, FULL()];
	const authors = ["brain", "agent", "records"] as const;

	test("never adds a strong word, keeps the text, and is idempotent", () => {
		const r = rng(20261123);
		for (let i = 0; i < 4000; i++) {
			const input = sample(r);
			const evidence = evidences[i % 2] as HostEvidence;
			const author = authors[i % 3] as (typeof authors)[number];
			const once = guardText(input, evidence, { author });
			expect(strongWordCount(once.text)).toBe(strongWordCount(input));
			// Insert-only: every input character survives, in order.
			let at = 0;
			for (const ch of once.text) {
				if (input.startsWith(ch, at)) at += ch.length;
			}
			expect(at).toBe(input.length);
			expect(guardText(once.text, evidence, { author }).text).toBe(once.text);
		}
	});

	test("text with no strong word is returned untouched", () => {
		const r = rng(7);
		for (let i = 0; i < 1000; i++) {
			const input = sample(r);
			if (strongWordCount(input) > 0) continue;
			expect(guardText(input, none, brain)).toMatchObject({
				text: input,
				changed: false,
			});
		}
	});
});

describe("statement", () => {
	test("keeps the class of a plain statement", () => {
		expect(statement("host-observed", "Landed 7")).toMatchObject({
			class: "host-observed",
			text: "Landed 7",
			weakened: false,
		});
	});

	test("host text with an unbacked strong word loses the host class", () => {
		const r = statement("host-observed", "main is healthy");
		expect(r.class).toBe("inference");
		expect(r.weakened).toBe(true);
	});
});
