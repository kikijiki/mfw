import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import { brainTurns, engineKv } from "@mfw/db/schema";
import { eq } from "drizzle-orm";
import {
	ACT_BUDGET_LEDGER_KEY,
	type ActBudgetConfig,
	applyActBudget,
	DEFAULT_ACT_BUDGET,
	planActBudget,
	resolveActBudget,
} from "../src/act-budget.ts";
import { ActBreaker } from "../src/brain-runtime/act-breaker.ts";
import { decisionCardId } from "../src/brain-runtime/decision-rights.ts";
import { recordProvenance } from "../src/brain-runtime/provenance.ts";
import { actBudgetSchema } from "../src/config.ts";
import {
	attentionOf,
	type InboxItem,
	type InboxKind,
	InboxService,
	type InboxSeverity,
} from "../src/inbox.ts";
import { type BrainUnit, brainUnit } from "./support/brain-unit.ts";

const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;

const config = (over: Partial<ActBudgetConfig> = {}): ActBudgetConfig => ({
	...DEFAULT_ACT_BUDGET,
	...over,
});

function item(
	id: string,
	over: {
		project?: string;
		kind?: InboxKind;
		severity?: InboxSeverity;
		ageMs?: number;
	} = {},
): InboxItem {
	const kind = over.kind ?? "review";
	const severity = over.severity ?? "attention";
	return {
		id,
		project: over.project ?? "alpha",
		kind,
		severity,
		attention: attentionOf(kind, severity),
		title: id,
		detail: "",
		ref: "brain",
		ts: NOW - (over.ageMs ?? 60_000),
	};
}

const heldIds = (p: ReturnType<typeof planActBudget>) =>
	p.held.map((h) => h.id);
const visibleIds = (p: ReturnType<typeof planActBudget>) =>
	[...p.visible].map((k) => k.split("\n")[1]).sort();

describe("act budget: enforcement and release order", () => {
	test("excess act items are held back, never removed", () => {
		const items = ["a", "b", "c", "d"].map((id, i) =>
			item(id, { ageMs: (10 - i) * 60_000 }),
		);
		const plan = planActBudget({
			items,
			surfaced: {},
			now: NOW,
			config: config({ maxVisible: 2, minVisible: 1 }),
		});
		expect(visibleIds(plan)).toEqual(["a", "b"]);
		expect(heldIds(plan)).toEqual(["c", "d"]);
		expect(plan.summary.heldBack).toBe(2);
	});

	test("know and ambient items are outside the budget", () => {
		const plan = planActBudget({
			items: [
				item("a"),
				item("k", { kind: "failed_run", severity: "info" }),
				item("s", { kind: "sweep_infra", severity: "info" }),
			],
			surfaced: {},
			now: NOW,
			config: config({ maxVisible: 1, minVisible: 1 }),
		});
		expect(plan.summary.heldBack).toBe(0);
		expect(plan.admitted.map((a) => a.id)).toEqual(["a"]);
	});

	test("release follows priority: decision, approval, question, then oldest", () => {
		const items = [
			item("old-review", { ageMs: 5 * HOUR }),
			item("question", { kind: "needs_answer", ageMs: 1000 }),
			item("approval", { kind: "approval_pending", ageMs: 2000 }),
			item("decision", { kind: "brain_decision", ageMs: 3000 }),
		];
		const plan = planActBudget({
			items,
			surfaced: {},
			now: NOW,
			config: config({ maxVisible: 1, minVisible: 1, debtStep: 100 }),
		});
		expect(visibleIds(plan)).toEqual(["decision"]);
		expect(heldIds(plan)).toEqual(["approval", "question", "old-review"]);
		expect(plan.held.map((h) => h.kind)[0]).toBe("approval_pending");
	});

	test("clearing a visible item releases the next one", () => {
		const cfg = config({ maxVisible: 1, minVisible: 1, debtStep: 100 });
		const a = item("a", { ageMs: 3000 });
		const b = item("b", { ageMs: 2000 });
		const first = planActBudget({
			items: [a, b],
			surfaced: {},
			now: NOW,
			config: cfg,
		});
		expect(visibleIds(first)).toEqual(["a"]);
		const next = planActBudget({
			items: [b],
			surfaced: { alpha: { a: NOW } },
			now: NOW + 1,
			config: cfg,
		});
		expect(visibleIds(next)).toEqual(["b"]);
		expect(next.summary.heldBack).toBe(0);
	});

	test("the window cap holds new items until the window rolls", () => {
		const cfg = config({
			maxVisible: 5,
			minVisible: 1,
			perWindow: 2,
			debtStep: 100,
		});
		const surfaced = { alpha: { x: NOW - HOUR, y: NOW - 2 * HOUR } };
		const capped = planActBudget({
			items: [item("n")],
			surfaced,
			now: NOW,
			config: cfg,
		});
		expect(heldIds(capped)).toEqual(["n"]);
		expect(capped.summary.usedInWindow).toBe(2);
		const rolled = planActBudget({
			items: [item("n")],
			surfaced,
			now: NOW + 24 * HOUR,
			config: cfg,
		});
		expect(heldIds(rolled)).toEqual([]);
	});

	test("an item already in front of the owner is not taken back", () => {
		const plan = planActBudget({
			items: [
				item("seen", { ageMs: 1000 }),
				item("urgent", { kind: "brain_decision", ageMs: 10 }),
			],
			surfaced: { alpha: { seen: NOW - 1000 } },
			now: NOW,
			config: config({ maxVisible: 1, minVisible: 1, debtStep: 100 }),
		});
		expect(visibleIds(plan)).toEqual(["seen"]);
		expect(heldIds(plan)).toEqual(["urgent"]);
	});

	test("one project cannot take every slot while another waits", () => {
		const items = [
			...["a1", "a2", "a3", "a4"].map((id, i) =>
				item(id, { project: "alpha", ageMs: (20 - i) * 60_000 }),
			),
			item("b1", { project: "beta", ageMs: 60_000 }),
		];
		const plan = planActBudget({
			items,
			surfaced: {},
			now: NOW,
			config: config({
				maxVisible: 3,
				minVisible: 1,
				projectShare: 0.6,
				debtStep: 100,
			}),
		});
		expect(visibleIds(plan)).toEqual(["a1", "a2", "b1"]);
	});

	test("a share never leaves a slot empty when only one project waits", () => {
		const items = ["a1", "a2", "a3"].map((id) => item(id));
		const plan = planActBudget({
			items,
			surfaced: {},
			now: NOW,
			config: config({
				maxVisible: 3,
				minVisible: 1,
				projectShare: 0.34,
				debtStep: 100,
			}),
		});
		expect(plan.summary.heldBack).toBe(0);
	});

	test("held items are grouped by project and kind", () => {
		const items = [
			item("v", { ageMs: 9000 }),
			item("r1", { ageMs: 8000 }),
			item("r2", { ageMs: 7000 }),
			item("q", { project: "beta", kind: "needs_answer", ageMs: 100 }),
		];
		const plan = planActBudget({
			items,
			surfaced: { alpha: { v: NOW - 9000 } },
			now: NOW,
			config: config({ maxVisible: 1, minVisible: 1, debtStep: 100 }),
		});
		expect(plan.summary.groups).toEqual([
			{ project: "beta", kind: "needs_answer", count: 1, oldestTs: NOW - 100 },
			{ project: "alpha", kind: "review", count: 2, oldestTs: NOW - 8000 },
		]);
	});
});

describe("act budget: review debt", () => {
	test("debt counts aged cards and every held decision, with the oldest age", () => {
		const plan = planActBudget({
			items: [
				item("fresh", { ageMs: HOUR }),
				item("aged", { ageMs: 6 * HOUR }),
				item("decision", { kind: "brain_decision", ageMs: 1000 }),
			],
			surfaced: {},
			now: NOW,
			config: config(),
		});
		expect(plan.summary.debt.count).toBe(2);
		expect(plan.summary.debt.oldestAgeMs).toBe(6 * HOUR);
	});

	test("more debt tightens the limit, down to the floor", () => {
		const cfg = config({
			maxVisible: 5,
			minVisible: 2,
			debtStep: 2,
			debtStaleMs: 1000 * HOUR,
		});
		const aged = (n: number) =>
			Array.from({ length: n }, (_, i) =>
				item(`d${i}`, { ageMs: 5 * HOUR + i }),
			);
		const limit = (n: number) =>
			planActBudget({ items: aged(n), surfaced: {}, now: NOW, config: cfg })
				.summary.limit;
		expect(limit(1)).toBe(5);
		expect(limit(2)).toBe(4);
		expect(limit(4)).toBe(3);
		expect(limit(40)).toBe(2);
	});

	test("stale debt takes one more slot", () => {
		const plan = planActBudget({
			items: [item("old", { ageMs: 100 * HOUR })],
			surfaced: {},
			now: NOW,
			config: config({ maxVisible: 5, minVisible: 2, debtStep: 100 }),
		});
		expect(plan.summary.limit).toBe(4);
	});

	test("critical items are incidents, not debt", () => {
		const plan = planActBudget({
			items: [
				item("red", {
					kind: "main_red",
					severity: "critical",
					ageMs: 90 * HOUR,
				}),
			],
			surfaced: {},
			now: NOW,
			config: config(),
		});
		expect(plan.summary.debt.count).toBe(0);
		expect(plan.summary.limit).toBe(DEFAULT_ACT_BUDGET.maxVisible);
	});

	test("an item with no real timestamp counts but has no age", () => {
		const raw = item("iso", { kind: "admission" });
		const plan = planActBudget({
			items: [{ ...raw, ts: 0 }],
			surfaced: {},
			now: NOW,
			config: config(),
		});
		expect(plan.summary.debt).toEqual({ count: 1, oldestAgeMs: null });
	});
});

describe("act budget: config", () => {
	test("absent keys take the defaults; a floor above the ceiling is clamped", () => {
		expect(resolveActBudget(undefined)).toEqual(DEFAULT_ACT_BUDGET);
		const r = resolveActBudget({ maxVisible: 2, minVisible: 4 });
		expect(r.maxVisible).toBe(2);
		expect(r.minVisible).toBe(2);
	});

	test("the schema refuses a nonsense budget", () => {
		expect(actBudgetSchema.safeParse({ maxVisible: 0 }).success).toBe(false);
		expect(actBudgetSchema.safeParse({ projectShare: 1.5 }).success).toBe(
			false,
		);
		expect(actBudgetSchema.safeParse({ perWindow: 10 }).success).toBe(true);
	});
});

describe("act budget: durable ledger", () => {
	const roots: string[] = [];
	const handles: ProjectDbHandle[] = [];

	afterEach(async () => {
		for (const h of handles.splice(0)) h.close();
		for (const r of roots.splice(0)) {
			await rm(r, { recursive: true, force: true });
		}
	});

	async function db(): Promise<ProjectDbHandle> {
		const root = await mkdtemp(join(tmpdir(), "mfw-act-budget-"));
		roots.push(root);
		const handle = await openProjectDb(join(root, ".mfw"));
		handles.push(handle);
		return handle;
	}

	const cfg = config({ maxVisible: 1, minVisible: 1, debtStep: 100 });
	const held = (lists: InboxItem[][]) =>
		lists
			.flat()
			.filter((i) => i.heldBack)
			.map((i) => i.id);

	test("a restart keeps what was shown and what was held", async () => {
		const root = await mkdtemp(join(tmpdir(), "mfw-act-budget-"));
		roots.push(root);
		const before = await openProjectDb(join(root, ".mfw"));
		const a = item("a", { ageMs: 3000 });
		const b = item("b", { ageMs: 2000 });
		const first = await applyActBudget(
			[{ name: "alpha", handle: before }],
			[[a, b]],
			{ now: NOW, config: cfg },
		);
		expect(held(first.lists)).toEqual(["b"]);
		before.close();
		const handle = await openProjectDb(join(root, ".mfw"));
		handles.push(handle);
		const sources = [{ name: "alpha", handle }];

		// A new arrival that outranks `a` must not displace it after a restart.
		const urgent = item("urgent", { kind: "brain_decision", ageMs: 10 });
		const after = await applyActBudget(sources, [[a, b, urgent]], {
			now: NOW + 5,
			config: cfg,
		});
		expect(held(after.lists).sort()).toEqual(["b", "urgent"]);
	});

	test("a read with nothing new writes nothing", async () => {
		const handle = await db();
		const sources = [{ name: "alpha", handle }];
		const a = item("a");
		await applyActBudget(sources, [[a]], { now: NOW, config: cfg });
		const row = async () =>
			(
				await handle.db
					.select()
					.from(engineKv)
					.where(eq(engineKv.key, ACT_BUDGET_LEDGER_KEY))
			)[0];
		const before = await row();
		await applyActBudget(sources, [[a]], { now: NOW + 10, config: cfg });
		expect((await row())?.updatedAt).toEqual(before?.updatedAt);
	});

	test("cleared entries leave the ledger once the window passes", async () => {
		const handle = await db();
		const sources = [{ name: "alpha", handle }];
		await applyActBudget(sources, [[item("a")]], { now: NOW, config: cfg });
		await applyActBudget(sources, [[item("b")]], {
			now: NOW + 25 * HOUR,
			config: cfg,
		});
		const [row] = await handle.db
			.select()
			.from(engineKv)
			.where(eq(engineKv.key, ACT_BUDGET_LEDGER_KEY));
		expect(Object.keys((row?.value as { surfaced: object }).surfaced)).toEqual([
			"b",
		]);
	});

	test("the budget is machine-wide across project databases", async () => {
		const one = await db();
		const two = await db();
		const out = await applyActBudget(
			[
				{ name: "alpha", handle: one },
				{ name: "beta", handle: two },
			],
			[
				[item("a", { project: "alpha", ageMs: 3000 })],
				[item("b", { project: "beta", ageMs: 2000 })],
			],
			{ now: NOW, config: cfg },
		);
		expect(held(out.lists)).toEqual(["b"]);
		expect(out.summary.heldBack).toBe(1);
	});

	test("concurrent reads do not admit past the limit", async () => {
		const handle = await db();
		const sources = [{ name: "alpha", handle }];
		const items = [item("a", { ageMs: 3000 }), item("b", { ageMs: 2000 })];
		const [x, y] = await Promise.all([
			applyActBudget(sources, [items], { now: NOW, config: cfg }),
			applyActBudget(sources, [items], { now: NOW, config: cfg }),
		]);
		const [row] = await handle.db
			.select()
			.from(engineKv)
			.where(eq(engineKv.key, ACT_BUDGET_LEDGER_KEY));
		expect(Object.keys((row?.value as { surfaced: object }).surfaced)).toEqual([
			"a",
		]);
		expect(held(x.lists)).toEqual(["b"]);
		expect(held(y.lists)).toEqual(["b"]);
	});
});

describe("act budget: decision rights and the breaker", () => {
	let u: BrainUnit;
	let turnRunId: string;
	let owner: string;

	afterEach(async () => {
		await u?.cleanup();
	});

	async function start() {
		u = await brainUnit({ maxConcurrent: 20 });
		owner = (await u.tasks.create({ title: "owner goal", status: "ready" })).id;
		await u.runtime.tick();
		await u.human("plan something");
		await u.runtime.tick();
		turnRunId = u.launched[0]?.runId ?? "";
		const [t] = await u.handle.db
			.select()
			.from(brainTurns)
			.where(eq(brainTurns.runId, turnRunId));
		await recordProvenance(
			u.handle,
			t?.sessionId ?? "",
			["external"],
			u.clock.t,
		);
	}

	const inbox = () =>
		new InboxService({ handle: u.handle, project: "unit", tasks: u.tasks });
	const hold = async () => {
		const out = await u.runtime.actions.act({
			turnRunId,
			tool: "set_status",
			args: {
				rationale: "scope cut",
				id: owner,
				to: "archived",
				reason: "scope cut",
			},
		});
		expect(out.status).toBe("held");
		return out.actionId as string;
	};
	const budgeted = async (over: Partial<ActBudgetConfig> = {}) => {
		const list = await inbox().list();
		const shown = item("shown", { project: "unit", ageMs: 60_000 });
		return applyActBudget(
			[{ name: "unit", handle: u.handle }],
			[[shown, ...list]],
			{
				now: u.clock.t,
				config: config({
					maxVisible: 1,
					minVisible: 1,
					debtStep: 100,
					...over,
				}),
			},
		);
	};

	test("a held decision over budget stays listed, counted and resolvable", async () => {
		await start();
		const first = await budgeted();
		expect(first.summary.heldBack).toBe(0);

		const id = await hold();
		const out = await budgeted();
		const card = out.lists.flat().find((i) => i.id === decisionCardId(id));
		expect(card?.heldBack).toBe(true);
		expect(out.summary.heldBack).toBe(1);
		expect(out.summary.debt.count).toBeGreaterThanOrEqual(1);

		const res = await u.runtime.actions.resolveHeld({
			actionId: id,
			approve: false,
		});
		expect(res.status).not.toBe("held");
		const after = await budgeted();
		expect(after.lists.flat().map((i) => i.id)).not.toContain(
			decisionCardId(id),
		);
	});

	test("an open breaker is always visible and does not spend the budget", async () => {
		await start();
		await budgeted();
		const breaker = new ActBreaker(
			{
				handle: u.handle,
				now: () => u.clock.t,
				brainSpendUsd: async () => 1_000,
			},
			{ maxBrainUsdPerDay: 1 },
		);
		expect((await breaker.observe()).open).toBe(true);
		const out = await budgeted();
		const card = out.lists.flat().find((i) => i.kind === "brain_breaker");
		expect(card).toBeDefined();
		expect(card?.heldBack).toBeUndefined();
		expect(out.summary.limit).toBe(1);
		expect(out.summary.debt.count).toBe(0);
	});
});
