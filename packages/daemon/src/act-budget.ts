import type { ProjectDbHandle } from "@mfw/db/client";
import { engineKv } from "@mfw/db/schema";
import { eq } from "drizzle-orm";
import { loadConfig, type StoredActBudget } from "./config.ts";
import { type InboxItem, type InboxKind, mergeInboxes } from "./inbox.ts";

/**
 * The machine-level `act` budget and review debt (DESIGN W2, patterns 3 and 7):
 * how many asks the whole fleet may put in front of the owner. What is over
 * budget is not dropped. It stays in `inbox.list`, flagged `heldBack`, still
 * answerable, and is released in priority order as the owner clears items.
 *
 * Critical items (mfw is stuck, the breaker is open) are outside the budget:
 * always visible, never charged, and not review debt. Tool approvals are
 * outside it too, because a folded approval stalls a live run: always visible
 * and never charged, but they do count as review debt once aged.
 *
 * `planActBudget` is pure. The only state is which items were already shown,
 * a ledger in each project's `engine_kv`, so a restart keeps the same picture.
 */

export const ACT_BUDGET_LEDGER_KEY = "act_budget_ledger";

export type ActBudgetConfig = Required<StoredActBudget>;

export const DEFAULT_ACT_BUDGET: ActBudgetConfig = {
	maxVisible: 5,
	minVisible: 2,
	perWindow: 20,
	windowMs: 24 * 3_600_000,
	projectShare: 0.6,
	debtGraceMs: 4 * 3_600_000,
	debtStep: 5,
	debtStaleMs: 72 * 3_600_000,
};

/** The stored keys over the defaults. A floor above the ceiling takes the ceiling. */
export function resolveActBudget(
	stored: StoredActBudget | undefined,
): ActBudgetConfig {
	const c = { ...DEFAULT_ACT_BUDGET, ...stored };
	return { ...c, minVisible: Math.min(c.minVisible, c.maxVisible) };
}

export interface ReviewDebt {
	/** Open non-critical `act` items past the grace period, plus every held decision. */
	count: number;
	/** `null` when no counted item has a real timestamp. */
	oldestAgeMs: number | null;
}

export interface HeldGroup {
	project: string;
	kind: InboxKind;
	count: number;
	oldestTs: number;
}

export interface ActBudgetSummary {
	/** Budgeted `act` items (not critical, not approvals) visible now, after debt tightening. */
	limit: number;
	/** Items charged to the rolling window, over all projects. */
	usedInWindow: number;
	perWindow: number;
	heldBack: number;
	/** In release order. */
	groups: HeldGroup[];
	debt: ReviewDebt;
	/** Per project, for its headline. */
	byProject: Record<string, { heldBack: number; debt: ReviewDebt }>;
}

/** project -> item id -> when it was first shown. */
export type SurfacedLedger = Record<string, Record<string, number>>;

export interface ActBudgetPlan {
	/** `itemKey`s in front of the owner. */
	visible: Set<string>;
	/** `itemKey`s outside the budget: critical items and tool approvals. */
	bypassed: Set<string>;
	/** In release order. */
	held: InboxItem[];
	/** Shown for the first time by this plan: the ledger's new entries. */
	admitted: InboxItem[];
	summary: ActBudgetSummary;
}

const itemKey = (i: Pick<InboxItem, "project" | "id">) =>
	`${i.project}\n${i.id}`;

/** What waits on the owner most directly goes first. */
const KIND_PRIORITY: Partial<Record<InboxKind, number>> = {
	brain_decision: 0,
	needs_answer: 1,
	clarify: 2,
};
const OTHER_KINDS = 3;

/** Always shown and never charged to the window. */
const bypassesBudget = (i: InboxItem) =>
	i.severity === "critical" || i.kind === "approval_pending";

function releaseOrder(a: InboxItem, b: InboxItem): number {
	return (
		(KIND_PRIORITY[a.kind] ?? OTHER_KINDS) -
			(KIND_PRIORITY[b.kind] ?? OTHER_KINDS) ||
		a.ts - b.ts ||
		a.project.localeCompare(b.project) ||
		a.id.localeCompare(b.id)
	);
}

function debtOf(items: readonly InboxItem[], now: number, graceMs: number) {
	const counted = items.filter(
		(i) => i.kind === "brain_decision" || now - i.ts >= graceMs,
	);
	const dated = counted.filter((i) => i.ts > 0).map((i) => now - i.ts);
	return {
		count: counted.length,
		oldestAgeMs: dated.length > 0 ? Math.max(...dated) : null,
	};
}

export function planActBudget(input: {
	items: readonly InboxItem[];
	surfaced: SurfacedLedger;
	now: number;
	config: ActBudgetConfig;
}): ActBudgetPlan {
	const { items, surfaced, now, config: c } = input;
	const act = items.filter((i) => i.attention === "act");
	const bypass = act.filter(bypassesBudget);
	const bypassKeys = new Set(bypass.map(itemKey));
	const budgeted = act.filter((i) => !bypassesBudget(i));
	const debtItems = act.filter((i) => i.severity !== "critical");

	const debt = debtOf(debtItems, now, c.debtGraceMs);
	const stale = debt.oldestAgeMs !== null && debt.oldestAgeMs >= c.debtStaleMs;
	const limit = Math.max(
		Math.min(c.minVisible, c.maxVisible),
		c.maxVisible - Math.floor(debt.count / c.debtStep) - (stale ? 1 : 0),
	);

	const windowStart = now - c.windowMs;
	let used = 0;
	for (const [project, entries] of Object.entries(surfaced)) {
		for (const [id, at] of Object.entries(entries)) {
			// Shown earlier, then escalated: it no longer spends the window.
			if (at > windowStart && !bypassKeys.has(itemKey({ project, id }))) used++;
		}
	}
	const usedInWindow = used;

	const visible = new Set(bypassKeys);
	const perProject = new Map<string, number>();
	const show = (i: InboxItem) => {
		visible.add(itemKey(i));
		perProject.set(i.project, (perProject.get(i.project) ?? 0) + 1);
	};

	// What the owner already sees stays put, even when the limit tightened.
	const ordered = [...budgeted].sort(releaseOrder);
	const waiting: InboxItem[] = [];
	for (const i of ordered) {
		if (surfaced[i.project]?.[i.id] !== undefined) show(i);
		else waiting.push(i);
	}
	let open = visible.size - bypass.length;

	const admitted: InboxItem[] = [];
	const admit = (i: InboxItem) => {
		show(i);
		admitted.push(i);
		open++;
		used++;
	};
	const hasRoom = () => open < limit && used < c.perWindow;
	const share = Math.max(1, Math.ceil(c.projectShare * limit));
	// First pass honours the shares; the second fills what they left empty.
	for (const i of waiting) {
		if (!hasRoom()) break;
		const atShare = (perProject.get(i.project) ?? 0) >= share;
		const otherWaits = waiting.some(
			(w) => w.project !== i.project && !visible.has(itemKey(w)),
		);
		if (!(atShare && otherWaits)) admit(i);
	}
	for (const i of waiting) {
		if (!hasRoom()) break;
		if (!visible.has(itemKey(i))) admit(i);
	}

	const held = waiting.filter((i) => !visible.has(itemKey(i)));
	const groups = new Map<string, HeldGroup>();
	for (const i of held) {
		const key = `${i.project}\n${i.kind}`;
		const g = groups.get(key);
		if (g) {
			g.count++;
			g.oldestTs = Math.min(g.oldestTs, i.ts);
		} else {
			groups.set(key, {
				project: i.project,
				kind: i.kind,
				count: 1,
				oldestTs: i.ts,
			});
		}
	}

	const byProject: ActBudgetSummary["byProject"] = {};
	for (const project of new Set(debtItems.map((i) => i.project))) {
		byProject[project] = {
			heldBack: held.filter((i) => i.project === project).length,
			debt: debtOf(
				debtItems.filter((i) => i.project === project),
				now,
				c.debtGraceMs,
			),
		};
	}

	return {
		visible,
		bypassed: bypassKeys,
		held,
		admitted,
		summary: {
			limit,
			usedInWindow,
			perWindow: c.perWindow,
			heldBack: held.length,
			groups: [...groups.values()],
			debt,
			byProject,
		},
	};
}

type LedgerDb = Pick<ProjectDbHandle, "db" | "withTx">;

export interface ActBudgetSource {
	name: string;
	handle: LedgerDb;
}

async function readLedger(handle: LedgerDb): Promise<Record<string, number>> {
	const [row] = await handle.db
		.select()
		.from(engineKv)
		.where(eq(engineKv.key, ACT_BUDGET_LEDGER_KEY));
	return (
		(row?.value as { surfaced?: Record<string, number> } | undefined)
			?.surfaced ?? {}
	);
}

async function writeLedger(
	handle: LedgerDb,
	surfaced: Record<string, number>,
	now: number,
): Promise<void> {
	const value = { surfaced } as Record<string, unknown>;
	await handle.db
		.insert(engineKv)
		.values({ key: ACT_BUDGET_LEDGER_KEY, value, updatedAt: new Date(now) })
		.onConflictDoUpdate({
			target: engineKv.key,
			set: { value, updatedAt: new Date(now) },
		});
}

/** One evaluation at a time: two concurrent reads must not both spend the last slot. */
let queue: Promise<unknown> = Promise.resolve();

function serialized<T>(fn: () => Promise<T>): Promise<T> {
	const run = queue.then(fn, fn);
	queue = run.catch(() => undefined);
	return run;
}

/**
 * Apply the budget to every project's list and record what was newly shown.
 * The ledger is written before the result is returned, so what the owner saw
 * survives a crash. Entries stay while the item is open or inside the window.
 */
export function applyActBudget(
	sources: readonly ActBudgetSource[],
	lists: readonly InboxItem[][],
	opts: { now: number; config: ActBudgetConfig },
): Promise<{ lists: InboxItem[][]; summary: ActBudgetSummary }> {
	return serialized(async () => {
		const { now, config } = opts;
		const surfaced: SurfacedLedger = {};
		await Promise.all(
			sources.map(async (s) => {
				surfaced[s.name] = await readLedger(s.handle);
			}),
		);
		const plan = planActBudget({
			items: lists.flat(),
			surfaced,
			now,
			config,
		});

		const windowStart = now - config.windowMs;
		for (const s of sources) {
			const before = surfaced[s.name] ?? {};
			const open = new Set(
				lists
					.flat()
					.filter((i) => i.project === s.name)
					.map((i) => i.id),
			);
			const next: Record<string, number> = {};
			for (const [id, at] of Object.entries(before)) {
				// An escalated item leaves the ledger so it stops spending the window after it clears.
				if (plan.bypassed.has(itemKey({ project: s.name, id }))) continue;
				if (open.has(id) || at > windowStart) next[id] = at;
			}
			for (const i of plan.admitted) {
				if (i.project === s.name) next[i.id] = now;
			}
			const same =
				Object.keys(next).length === Object.keys(before).length &&
				Object.entries(next).every(([id, at]) => before[id] === at);
			if (!same) await writeLedger(s.handle, next, now);
		}

		const heldKeys = new Map(plan.held.map((i, n) => [itemKey(i), n]));
		return {
			lists: lists.map((list) =>
				list.map((i) => {
					const heldRank = heldKeys.get(itemKey(i));
					return heldRank === undefined
						? i
						: { ...i, heldBack: true, heldRank };
				}),
			),
			summary: plan.summary,
		};
	});
}

/** The stored budget. An unreadable config keeps enforcing the defaults. */
async function storedBudget(): Promise<ActBudgetConfig> {
	const stored = await loadConfig().then(
		(c) => c.actBudget,
		() => undefined,
	);
	return resolveActBudget(stored);
}

/** Every project's inbox, merged, with the machine-level budget applied. */
export async function budgetedInbox(
	services: readonly (ActBudgetSource & {
		inbox: { list(): Promise<InboxItem[]> };
	})[],
	now = Date.now(),
): Promise<ReturnType<typeof mergeInboxes> & { budget?: ActBudgetSummary }> {
	const lists = await Promise.all(services.map((s) => s.inbox.list()));
	const out = await applyActBudget(services, lists, {
		now,
		config: await storedBudget(),
	});
	return { ...mergeInboxes(out.lists), budget: out.summary };
}
