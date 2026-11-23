import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { STRONG_WORDS } from "../src/claims.ts";

/**
 * A strong status word (verified, merged, deployed, healthy, passing, fixed)
 * may only reach a screen through the claim guard (`claims.ts` `renderClaim`,
 * fed by `claims-evidence.ts`). A run whose state is merely `completed` also
 * covers "the agent asked a question", "waiting at the review gate" and "merge
 * only queued", so a label that says `merged` or `verified` for it is a lie.
 *
 * This scans the UI sources and the daemon's view-model code for string
 * literals that carry one of those words. Each file that legitimately has some
 * is listed below with a ceiling and the reason; a new hit anywhere else, or
 * more hits in a listed file, fails the test and needs either the claim guard
 * or a justified allowlist entry.
 */

const ROOT = join(import.meta.dir, "..", "..", "..");

const UI_ROOT = join(ROOT, "apps/start/src");
const VIEW_MODEL_FILES = [
	"run-pips.ts",
	"run-provenance-view.ts",
	"headlines.ts",
	"flow.ts",
	"history.ts",
	"brain-runtime/facts.ts",
	"brain-runtime/digest.ts",
	"finalize/machine.ts",
].map((f) => join(ROOT, "packages/daemon/src", f));

const WORD = new RegExp(`\\b(${STRONG_WORDS.join("|")})\\b`, "i");
// A negation is the opposite of a claim: "not verified" asserts nothing strong.
const NEGATED =
	/\b(not|never|un|no|cannot be|could not be|nothing is|isn't|without)\s+(\w+\s+)?(verified|merged|deployed|healthy|passing|fixed)\b/i;

/** file (repo-relative) -> [max literal hits, why those are not run/task status]. */
const ALLOWED: Record<string, [number, string]> = {
	// Prose: help text, confirmations, descriptions of what an action does.
	"apps/start/src/features/settings/ProjectConfig.tsx": [
		1,
		"help text for a setting",
	],
	"apps/start/src/features/settings/ResourcesPanel.tsx": [
		3,
		"'fixed' is a resource quantity kind, not a status",
	],
	"apps/start/src/features/sessions/SessionCard.tsx": [
		4,
		"'fixed' is a session resolution the user picks",
	],
	"apps/start/src/features/runpod/runpodPresentation.ts": [
		2,
		"negated: 'could not be verified' / 'not verified'",
	],
	"apps/start/src/features/resources/ResourcesPage.tsx": [
		1,
		"help text about a hardware probe",
	],
	"apps/start/src/features/resources/resourceFormat.ts": [
		1,
		"negated: 'cannot be verified'",
	],
	"apps/start/src/features/inspector/DecisionRow.tsx": [
		1,
		"help text: 'fixed pipeline'",
	],
	"apps/start/src/features/inspector/GroupCompare.tsx": [
		3,
		"'fixed' column label, selection-mode help text, group merged status from the run_groups row",
	],
	"apps/start/src/features/inspector/story.tsx": [
		2,
		"run_groups.status and selection mode words, set by the merge queue (host)",
	],
	"apps/start/src/features/flow/NodeRow.tsx": [
		2,
		"run_groups.status 'merged' is written by the merge queue (host); 'first verified' is the selection mode name",
	],
	"apps/start/src/features/flow/FlowHover.tsx": [1, "CSS position: fixed"],
	"apps/start/src/features/flow/TimelineCell.tsx": [1, "CSS position: fixed"],
	"apps/start/src/features/fleet/FleetPage.tsx": [
		2,
		"a 'Merged' column and count taken from the host's merge records",
	],
	"apps/start/src/features/dispatch/state.ts": [
		1,
		"describes the breaker's recovery policy, not a run's status",
	],
	"apps/start/src/features/agents/ProvenanceChips.tsx": [
		2,
		"negated: 'not verified by the host'",
	],
	"apps/start/src/features/agents/useNodeActions.tsx": [
		2,
		"confirmation text: 'nothing is merged'",
	],
	"apps/start/src/features/inspector/groupGate.ts": [
		1,
		"negated: 'not verified'",
	],
	// Host-observed: the value is read from a host record, not from run state.
	"apps/start/src/features/review/ReviewPage.tsx": [
		1,
		"'Already merged' is read from git, not from a run state",
	],
	"apps/start/src/features/repo/branches.tsx": [
		2,
		"branch merged-ness comes from git ancestry",
	],
	"apps/start/src/features/repo/repoModel.ts": [
		12,
		"branch merged-ness comes from git ancestry",
	],
	"apps/start/src/features/repo/worktrees.tsx": [
		1,
		"branch merged-ness comes from git ancestry",
	],
	"apps/start/src/features/home/SinceYouLeft.tsx": [
		1,
		"digest entry kind 'merged' is built from merge events",
	],
	"apps/start/src/features/brain/brain.ts": [
		3,
		"outcome fold: `final === 'merged'` comes from the merge record",
	],
	"apps/start/src/features/brain/steering.ts": [
		3,
		"outcome fold: `final === 'merged'` comes from the merge record",
	],
	"apps/start/src/features/board/BrainIntentLine.tsx": [
		1,
		"names the brain's tool call 'tasks.merge'; a proposal, not a result",
	],
	"apps/start/src/features/board/CardAgentStrip.tsx": [0, "doc comment only"],
	"packages/daemon/src/flow.ts": [
		1,
		"run_groups.status 'merged' is written by the merge queue (host)",
	],
	"packages/daemon/src/history.ts": [
		3,
		"'merged' is the merge.completed event type, a host record",
	],
	"packages/daemon/src/finalize/machine.ts": [
		4,
		"settle class 'verified': set only after the verify step ran and passed",
	],
};

function walk(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) {
			if (name === "node_modules") continue;
			walk(p, out);
		} else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
			out.push(p);
		}
	}
	return out;
}

/** Utility-class strings ("fixed inset-0 z-50") are CSS, not labels. */
const isClassList = (s: string) =>
	/\bfixed\b/i.test(s) && /\w-[\w[\d]|\bflex\b|\bborder\b/.test(s);

function literalHits(source: string): string[] {
	const hits: string[] = [];
	for (const line of source.split("\n")) {
		const t = line.trim();
		if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
		const code = line.replace(/\/\/.*$/, "");
		for (const m of code.matchAll(/(["'`])((?:\\.|(?!\1).)*)\1/g)) {
			const text = m[2] ?? "";
			if (!WORD.test(text) || isClassList(text) || NEGATED.test(text)) continue;
			hits.push(text);
		}
	}
	return hits;
}

describe("strong-word status labels come from the claim guard", () => {
	test("the scanner sees a strong word and ignores css and negations", () => {
		expect(literalHits(`const a = "merged";`)).toEqual(["merged"]);
		expect(literalHits(`const a = "fixed inset-0 z-50";`)).toEqual([]);
		expect(literalHits(`const a = "not verified by the host";`)).toEqual([]);
		expect(literalHits(`// "verified"`)).toEqual([]);
	});

	test("no UI or view-model string produces a strong word outside the allowlist", () => {
		const files = [...walk(UI_ROOT), ...VIEW_MODEL_FILES];
		const problems: string[] = [];
		for (const f of files) {
			const rel = relative(ROOT, f);
			const hits = literalHits(readFileSync(f, "utf8"));
			const allowed = ALLOWED[rel]?.[0] ?? 0;
			if (hits.length > allowed) {
				problems.push(
					`${rel}: ${hits.length} strong-word literal(s), ${allowed} allowed: ${hits.join(" | ")}`,
				);
			}
		}
		expect(problems).toEqual([]);
	});

	test("every allowlist entry names a file that exists and has a reason", () => {
		for (const [rel, [, why]] of Object.entries(ALLOWED)) {
			expect(why.length).toBeGreaterThan(10);
			expect(() => statSync(join(ROOT, rel))).not.toThrow();
		}
	});
});
