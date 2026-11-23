import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectDb } from "@mfw/db/client";
import { events } from "@mfw/db/schema";
import {
	buildHeadline,
	collectHeadline,
	countLanded,
	type HeadlineSource,
	spendFractionOf,
} from "../src/headlines.ts";
import {
	ATTENTION_BY_KIND,
	attentionOf,
	type InboxKind,
	type InboxSeverity,
} from "../src/inbox.ts";

const act = { kind: "review", attention: "act" } as const;
const know = { kind: "failed_run", attention: "know" } as const;

describe("attention classes", () => {
	// Every kind, listed once. The Record type already fails the build when a
	// kind is missing from the table; this fails the run when the table and
	// the classification rules drift apart.
	const KINDS: InboxKind[] = [
		"main_red",
		"clarify",
		"review",
		"blocked",
		"failed_run",
		"merge_parked",
		"trigger_disarmed",
		"trigger_failed",
		"push_refused",
		"sweep_infra",
		"verify_infra",
		"admission",
		"draft_failed",
		"ownership_conflict",
		"followups",
		"needs_answer",
		"approval_pending",
		"stalled",
		"budget",
		"auth_hold",
		"brain_stuck",
		"brain_notice",
		"brain_decision",
		"brain_breaker",
	];
	const SEVERITIES: InboxSeverity[] = ["critical", "attention", "info"];

	test("the table covers exactly the InboxKind union", () => {
		expect(Object.keys(ATTENTION_BY_KIND).sort()).toEqual([...KINDS].sort());
	});

	test("every kind and severity yields a class", () => {
		for (const kind of KINDS)
			for (const sev of SEVERITIES)
				expect(["act", "know", "ambient"]).toContain(attentionOf(kind, sev));
	});

	test("critical is always act", () => {
		for (const kind of KINDS) expect(attentionOf(kind, "critical")).toBe("act");
	});

	test("an act kind that mfw already handled (info) is know", () => {
		expect(attentionOf("review", "info")).toBe("know");
		expect(attentionOf("review", "attention")).toBe("act");
	});

	test("infra retries are ambient until they escalate", () => {
		expect(attentionOf("sweep_infra", "info")).toBe("ambient");
		expect(attentionOf("verify_infra", "critical")).toBe("act");
	});

	test("failed runs and follow-ups are know", () => {
		expect(attentionOf("failed_run", "info")).toBe("know");
		expect(attentionOf("followups", "info")).toBe("know");
	});
});

describe("buildHeadline", () => {
	test("the documented example", () => {
		const h = buildHeadline({
			project: "mfw",
			landedToday: 7,
			inboxItems: [act, know],
			budgets: [{ unit: "usd", fraction: 0.62 }],
		});
		expect(h.text).toBe("Landed 7, needs you 1; main green; spend 62%");
		expect(h.parts.map((p) => p.link)).toEqual([
			"landed",
			"needs_you",
			"main",
			"budgets",
		]);
	});

	test("only act items count as needs you", () => {
		const h = buildHeadline({
			project: "p",
			landedToday: 0,
			inboxItems: [know, know, { kind: "sweep_infra", attention: "ambient" }],
			budgets: [],
		});
		expect(h.needsYou).toBe(0);
		expect(h.text).toBe("Landed 0, needs you 0; main green");
	});

	test("a main_red item makes main red", () => {
		const h = buildHeadline({
			project: "p",
			landedToday: 1,
			inboxItems: [{ kind: "main_red", attention: "act" }],
			budgets: [],
		});
		expect(h.text).toBe("Landed 1, needs you 1; main red");
	});

	test("spend is omitted without a dollar budget, never shown as 0%", () => {
		const h = buildHeadline({
			project: "p",
			landedToday: 0,
			inboxItems: [],
			budgets: [{ unit: "tokens", fraction: 0.9 }],
		});
		expect(h.spendFraction).toBeNull();
		expect(h.text).not.toContain("spend");
	});

	test("spend is the fullest dollar budget and may exceed 100%", () => {
		expect(
			spendFractionOf([
				{ unit: "usd", fraction: 0.2 },
				{ unit: "usd", fraction: 1.04 },
				{ unit: "tokens", fraction: 2 },
			]),
		).toBe(1.04);
		expect(spendFractionOf([])).toBeNull();
	});
});

describe("collectHeadline", () => {
	const source = (over: Partial<HeadlineSource> = {}): HeadlineSource => ({
		name: "mfw",
		inbox: { list: async () => [act] },
		budgets: { list: async () => [{ unit: "usd", fraction: 0.5 }] },
		landedSince: async () => 3,
		...over,
	});

	test("reads the facts", async () => {
		expect((await collectHeadline(source())).text).toBe(
			"Landed 3, needs you 1; main green; spend 50%",
		);
	});

	test("asks for landed work since local midnight", async () => {
		const now = new Date(2026, 10, 22, 15, 30).getTime();
		let since: Date | undefined;
		await collectHeadline(
			source({
				landedSince: async (d) => {
					since = d;
					return 0;
				},
			}),
			now,
		);
		expect(since).toEqual(new Date(2026, 10, 22, 0, 0, 0, 0));
	});

	test("a failing read degrades instead of throwing", async () => {
		const h = await collectHeadline(
			source({
				inbox: { list: async () => Promise.reject(new Error("x")) },
				budgets: { list: async () => Promise.reject(new Error("x")) },
				landedSince: async () => Promise.reject(new Error("x")),
			}),
		);
		expect(h.text).toBe("Landed 0, needs you 0; main green");
	});
});

describe("countLanded", () => {
	test("counts only merge.completed events since the cutoff", async () => {
		const root = await mkdtemp(join(tmpdir(), "mfw-headlines-"));
		const handle = await openProjectDb(join(root, ".mfw"));
		try {
			const at = (h: number) => new Date(2026, 10, 22, h);
			await handle.db.insert(events).values([
				{ ts: at(1), type: "merge.completed", payload: {} },
				{ ts: at(9), type: "merge.completed", payload: {} },
				{ ts: at(10), type: "merge.completed", payload: {} },
				{ ts: at(11), type: "task.created", payload: {} },
			]);
			expect(await countLanded(handle, at(0))).toBe(3);
			expect(await countLanded(handle, at(9))).toBe(2);
			expect(await countLanded(handle, at(12))).toBe(0);
		} finally {
			handle.close?.();
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("headline: act budget and review debt", () => {
	const base = {
		project: "p",
		landedToday: 1,
		inboxItems: [act, act, act],
		budgets: [],
	};

	test("says nothing when nothing is held and there is no debt", () => {
		const h = buildHeadline({
			...base,
			attention: { heldBack: 0, debt: { count: 0, oldestAgeMs: null } },
		});
		expect(h.text).toBe("Landed 1, needs you 3; main green");
	});

	test("held items stay in needs-you and are named beside it", () => {
		const h = buildHeadline({
			...base,
			attention: {
				heldBack: 2,
				debt: { count: 4, oldestAgeMs: 3 * 86_400_000 },
			},
		});
		expect(h.needsYou).toBe(3);
		expect(h.text).toBe(
			"Landed 1, needs you 3; main green; 2 held back; review debt 4, oldest 3d",
		);
		expect(h.parts.find((p) => p.key === "held_back")?.link).toBe("needs_you");
	});

	test("debt with no dated item shows no age", () => {
		const h = buildHeadline({
			...base,
			attention: { heldBack: 0, debt: { count: 1, oldestAgeMs: null } },
		});
		expect(h.text).toEndWith("review debt 1");
	});
});
