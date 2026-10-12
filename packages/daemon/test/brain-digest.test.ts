import { describe, expect, test } from "bun:test";
import {
	DIGEST_HARD_CAP_CHARS,
	type DigestInput,
	renderDigest,
} from "../src/brain-runtime/digest.ts";
import {
	classifyEvent,
	dueWake,
	pendingWakes,
	type WakeEvent,
} from "../src/brain-runtime/wake-table.ts";

const base = (over: Partial<DigestInput> = {}): DigestInput => ({
	wakeClass: "settled",
	turnSeq: 4,
	generation: 1,
	resumed: true,
	now: 1_800_000_000_000,
	lastTurnAt: 1_800_000_000_000 - 20 * 60_000,
	events: [],
	eventsFrom: 10,
	eventsTo: 20,
	runFacts: [],
	applied: [],
	live: [],
	frontier: [],
	humanOpen: [],
	capacity: ["Workers: 1 live of 2 slots."],
	reminders: [],
	...over,
});

const ev = (
	seq: number,
	type: string,
	payload = {},
	extra = {},
): WakeEvent => ({
	seq,
	ts: 1_800_000_000_000 + seq,
	type,
	payload,
	...extra,
});

describe("wake digest", () => {
	test("a resumed wake carries no charter; a fresh generation carries it and the rehydration sections", () => {
		const resumed = renderDigest(base()).markdown;
		expect(resumed).not.toContain("You are this project's brain");
		expect(resumed).toContain("## Applied since your last turn");
		const fresh = renderDigest(
			base({
				resumed: false,
				rehydration: {
					plan: "# plan\n- ship the importer",
					decisions: ["#1 spawn MFW-3 (proposed): small"],
					overrides: ["#9 archive MFW-4: it is still needed"],
				},
			}),
		).markdown;
		expect(fresh).toContain("You are this project's brain");
		expect(fresh).toContain("- ship the importer");
		expect(fresh).toContain("it is still needed");
	});

	test("over the hard cap, low-priority lines go first and the applied actions stay", () => {
		const events = Array.from({ length: 80 }, (_, i) =>
			ev(100 + i, "run.state_changed", {
				to: "completed",
				note: "x".repeat(90),
			}),
		);
		const frontier = Array.from({ length: 2000 }, (_, i) => ({
			id: `MFW-${i}`,
			title: "t".repeat(60),
			unblocks: 0,
		}));
		const applied = [
			{ id: "A1", tool: "spawn", status: "proposed", summary: "keep me" },
		];
		const out = renderDigest(base({ events, frontier, applied }));
		expect(out.markdown.length).toBeLessThanOrEqual(DIGEST_HARD_CAP_CHARS);
		expect(out.truncated).toBeGreaterThan(0);
		expect(out.markdown).toContain("keep me");
		expect(out.markdown).toContain("digest truncated");
	});
});

describe("wake table", () => {
	const kind = (id: string) => (id.startsWith("brain") ? "brain" : "task");

	test("classes", () => {
		const c = (e: WakeEvent) => classifyEvent(e, kind);
		expect(
			c(ev(1, "run.settled", { class: "verify_failed" }, { runId: "r" })),
		).toBe("settled");
		// A state change alone is no settle: finalize says when a run settled,
		// and a single-run fast path success needs no brain.
		expect(
			c(ev(1, "run.state_changed", { to: "completed" }, { runId: "r" })),
		).toBeNull();
		expect(
			c(ev(1, "run.state_changed", { to: "merging" }, { runId: "r" })),
		).toBeNull();
		expect(c(ev(1, "clarify.resolved", { answered: true }))).toBe("human");
		expect(
			c(ev(1, "clarify.resolved", { answered: true, by: "brain" })),
		).toBeNull();
		expect(
			c(ev(1, "run.activity_changed", { to: "needs_answer" }, { runId: "r" })),
		).toBe("attention");
		expect(c(ev(1, "run.scope_changed", { level: "violation" }))).toBe(
			"attention",
		);
		expect(c(ev(1, "merge.parked"))).toBe("merge");
		expect(c(ev(1, "rate_limit.hit"))).toBe("capacity");
		expect(c(ev(1, "human.override"))).toBe("human");
		expect(c(ev(1, "task.edited", { source: "brain" }))).toBeNull();
		expect(c(ev(1, "brain.turn_ended"))).toBeNull();
	});

	test("a class is due after its quiet period or its maximum, whichever first", () => {
		const t0 = 1_000_000;
		const pend = pendingWakes(
			[
				{ ...ev(1, "task.created"), ts: t0 },
				{ ...ev(2, "task.created"), ts: t0 + 20_000 },
			],
			kind,
		);
		expect(dueWake(pend, t0 + 40_000)).toBeNull(); // 20s quiet < 30s
		expect(dueWake(pend, t0 + 51_000)).toBe("frontier");
		expect(dueWake(pend, t0 + 5 * 60_000 + 1)).toBe("frontier");
	});
});
