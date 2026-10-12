import type { ProjectDb, ProjectDbHandle, ProjectDbTx } from "@mfw/db/client";
import { appendEvent, type EventBus } from "@mfw/db/eventlog";
import { engineKv, resourceSlots, spendLedger } from "@mfw/db/schema";
import { and, eq, gte, like, lt, sql } from "drizzle-orm";
import {
	type BudgetEntry,
	budgetEntrySchema,
	loadConfig,
	mutateConfig,
	type StoredBudgets,
} from "./config.ts";
import type { Logger } from "./log.ts";
import type { ProviderHoldStore } from "./provider-holds.ts";
import type { RunRegistry } from "./run-registry.ts";

/**
 * Budgets over the spend ledger (design §7, invariant I7).
 *
 * A budget is a sum of ledger rows over a window against a limit. Three kinds:
 *
 *  - `agent`: key is a provider hold key (`claude-cli`, `codex-cli@or`).
 *    Exhausted, the account gets a `ProviderHoldStore` hold with reason
 *    `budget` until the window resets. `routeRun` already skips a held account
 *    for project- and brain-chosen routes and waits (never overrides) for a
 *    human-pinned one. Live runs finish: killing them wastes what was spent.
 *  - `resource`: key is `runpod:<acct>`, `host:<id>`, an openrouter account.
 *    Exhausted, no new admission may depend on it (`holdFor`), the tasks that
 *    depend on it are held with `task.held_for_resource`, live runs on it get
 *    the `liveRunPolicy`, and the human gets one inbox item.
 *  - `brain`: the project brain's own spend, any harness. Exhausted, the brain
 *    is paused (a budget hold in the same state as a human pause).
 *
 * State per budget lives in `engine_kv.budgets`, written in the same
 * transaction as the event that announces the transition, so a restart or a
 * second evaluation never repeats an event or an inbox item. Windows are UTC.
 */

export type BudgetKind = "agent" | "resource" | "brain";
export type BudgetUnit = "usd" | "tokens" | "slot_hours";
export type BudgetScope = "project" | "machine";
export type BudgetPhase = "ok" | "warned" | "exhausted";

export interface WindowBounds {
	start: number;
	end: number;
}

const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** The window containing `now`: calendar (UTC) for hour/day/week/month, epoch-aligned buckets for `<n>m|h|d`. */
export function windowBounds(window: string, now: number): WindowBounds {
	const d = new Date(now);
	switch (window) {
		case "hour": {
			const start = Math.floor(now / 3_600_000) * 3_600_000;
			return { start, end: start + 3_600_000 };
		}
		case "day": {
			const start = Date.UTC(
				d.getUTCFullYear(),
				d.getUTCMonth(),
				d.getUTCDate(),
			);
			return { start, end: start + 86_400_000 };
		}
		case "week": {
			const day = (d.getUTCDay() + 6) % 7; // Monday = 0
			const start =
				Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) -
				day * 86_400_000;
			return { start, end: start + 7 * 86_400_000 };
		}
		case "month":
			return {
				start: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1),
				end: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1),
			};
	}
	const m = /^([1-9][0-9]*)([mhd])$/.exec(window);
	if (!m) throw new Error(`invalid budget window '${window}'`);
	const len = Number(m[1]) * UNIT_MS[m[2] as keyof typeof UNIT_MS];
	const start = Math.floor(now / len) * len;
	return { start, end: start + len };
}

/** Whether two keys name the same thing; a trailing `*` matches by prefix on either side. */
export function keyMatches(a: string, b: string): boolean {
	if (a === b) return true;
	if (a.endsWith("*") && b.startsWith(a.slice(0, -1))) return true;
	if (b.endsWith("*") && a.startsWith(b.slice(0, -1))) return true;
	return false;
}

/** The resource keys a task consumes: declared resources, and the target's own account. */
export function resourceKeysOfTask(task: {
	requiresResources?: readonly (string | { id: string })[] | null;
	executionTarget?: string | null;
}): string[] {
	const keys: string[] = [];
	for (const r of task.requiresResources ?? [])
		keys.push(typeof r === "string" ? r : r.id);
	const target = task.executionTarget ?? "local";
	if (target === "runpod") keys.push("runpod:*");
	else if (target.startsWith("ssh:")) keys.push(`host:${target.slice(4)}`);
	return keys;
}

export interface ResolvedBudget {
	/** `agent:claude-cli`, `resource:runpod:main`, `brain`. */
	id: string;
	key: string;
	kind: BudgetKind;
	scope: BudgetScope;
	window: string;
	unit: BudgetUnit;
	limit: number;
	warnAt: number | null;
	liveRunPolicy: "stop" | "finish_turn";
}

export interface BudgetStatus extends ResolvedBudget {
	used: number;
	fraction: number;
	windowStart: number;
	windowResetsAt: number;
	phase: BudgetPhase;
	/** A hold is in force because of this budget. */
	held: boolean;
}

interface StoredState {
	windowStart: number;
	phase: BudgetPhase;
	limit: number;
	/** Live runs waiting for a turn boundary under `finish_turn`. */
	pendingStops?: string[];
	/** Runs already told to stop; a stop is sent once, the supervisor finalizes. */
	stopped?: string[];
	pausedBrain?: boolean;
}
type StateMap = Record<string, StoredState>;

function unitOf(e: BudgetEntry): { unit: BudgetUnit; limit: number } {
	if (e.limitUsd !== undefined) return { unit: "usd", limit: e.limitUsd };
	if (e.limitTokens !== undefined)
		return { unit: "tokens", limit: e.limitTokens };
	return { unit: "slot_hours", limit: e.limitSlotHours as number };
}

function flatten(b: StoredBudgets | undefined, scope: BudgetScope) {
	const out: ResolvedBudget[] = [];
	const push = (kind: BudgetKind, key: string, e: BudgetEntry) => {
		const { unit, limit } = unitOf(e);
		out.push({
			id: kind === "brain" ? "brain" : `${kind}:${key}`,
			key,
			kind,
			scope,
			window: e.window,
			unit,
			limit,
			warnAt: e.warnAt ?? null,
			liveRunPolicy: e.liveRunPolicy ?? "stop",
		});
	};
	for (const [k, e] of Object.entries(b?.agents ?? {})) push("agent", k, e);
	for (const [k, e] of Object.entries(b?.resources ?? {}))
		push("resource", k, e);
	if (b?.brain) push("brain", "brain", b.brain);
	return out;
}

/**
 * Machine and project budgets as one list. A project may only tighten a
 * machine ceiling: for the same key and unit the lower limit wins, and a
 * different unit keeps both (the stricter trips first).
 */
export function resolveBudgets(
	machine: StoredBudgets | undefined,
	project: StoredBudgets | undefined,
): ResolvedBudget[] {
	const out = flatten(machine, "machine");
	for (const p of flatten(project, "project")) {
		const same = out.findIndex(
			(m) => m.id === p.id && m.scope === "machine" && m.unit === p.unit,
		);
		const m = same >= 0 ? out[same] : undefined;
		if (m && m.limit < p.limit) continue; // the machine ceiling is tighter
		if (m) out.splice(same, 1);
		out.push(p);
	}
	return out;
}

export interface BudgetServiceDeps {
	handle: ProjectDbHandle;
	bus: EventBus;
	log: Logger;
	mfwHome: string;
	project: string;
	/** Project budgets from the boot config, used until the config file has an entry for this project. */
	stored?: StoredBudgets;
	holds: Pick<ProviderHoldStore, "hold" | "clear" | "active">;
	registry: Pick<RunRegistry, "list">;
	/** Stop a live run (`RunEngine.stop`, the graceful interrupt then kill). */
	stopRun: (runId: string) => Promise<void>;
	/** Machine-scoped budgets sum these ledgers. Absent = this project's own. */
	ledgers?: () => ProjectDbHandle[];
	/** Pause or resume the brain for a `brain` budget. */
	pauseBrain?: (paused: boolean) => Promise<void>;
	now?: () => number;
	/** `tick()` evaluates at most this often. */
	minIntervalMs?: number;
}

const LIVE = ["starting", "running", "ended", "finalizing"] as const;

export class BudgetService {
	private readonly now: () => number;
	private lastTick = 0;
	private loaded = false;
	/** id -> hold for exhausted resource budgets, read by `holdFor`. */
	private exhaustedResources = new Map<
		string,
		{
			key: string;
			until: number;
			used: number;
			limit: number;
			unit: BudgetUnit;
		}
	>();
	private chain: Promise<unknown> = Promise.resolve();

	constructor(private readonly deps: BudgetServiceDeps) {
		this.now = deps.now ?? (() => Date.now());
	}

	// ------------------------------------------------------------------
	// configuration
	// ------------------------------------------------------------------

	async config(): Promise<{
		machine: StoredBudgets | undefined;
		project: StoredBudgets | undefined;
	}> {
		const file = await loadConfig(this.deps.mfwHome).catch(() => null);
		const entry = file?.projects.find((p) => p.name === this.deps.project);
		return {
			machine: file?.budgets,
			// The file is the truth once it has the project: removing the last
			// budget must not resurrect the boot-time copy.
			project: entry ? entry.budgets : this.deps.stored,
		};
	}

	/** Configured budgets with the brain's lowered limits applied (`set_budget`). */
	async resolved(): Promise<ResolvedBudget[]> {
		const ceilings = await this.ceilings();
		const lowered = await this.readOverrides();
		return ceilings.map((b) => {
			const o = lowered[b.id];
			return o !== undefined && o < b.limit ? { ...b, limit: o } : b;
		});
	}

	/** The human-configured budgets, before the brain's lowering. */
	private async ceilings(): Promise<ResolvedBudget[]> {
		const c = await this.config();
		return resolveBudgets(c.machine, c.project);
	}

	/**
	 * The brain's `set_budget`: lower (or restore toward) a limit, never above
	 * the configured ceiling, never a different unit or window.
	 */
	async checkBrainLimit(input: {
		budget: string;
		limitUsd?: number;
		limitTokens?: number;
		window?: string;
	}): Promise<
		| { ok: true; id: string; limit: number; ceiling: number; unit: BudgetUnit }
		| { ok: false; code: string; message: string; fix: string }
	> {
		const all = await this.ceilings();
		const b =
			all.find((x) => x.id === input.budget) ??
			all.find((x) => x.key === input.budget);
		if (!b) {
			return {
				ok: false,
				code: "ceiling_unknown",
				message: `no budget ceiling is configured for '${input.budget}': the brain may only lower a limit a human configured`,
				fix: "Ask the owner to add the budget in Settings → Budgets.",
			};
		}
		const given =
			input.limitUsd !== undefined
				? { unit: "usd" as const, v: input.limitUsd }
				: input.limitTokens !== undefined
					? { unit: "tokens" as const, v: input.limitTokens }
					: null;
		const field = b.unit === "tokens" ? "limitTokens" : "limitUsd";
		if (!given || given.v <= 0) {
			return {
				ok: false,
				code: "invalid_limit",
				message: "set_budget needs a limitUsd or limitTokens greater than zero",
				fix: `Pass ${field} for ${b.id}.`,
			};
		}
		if (given.unit !== b.unit) {
			return {
				ok: false,
				code: "unit_mismatch",
				message: `${b.id} is measured in ${b.unit}, not ${given.unit}`,
				fix: `Pass ${field}.`,
			};
		}
		if (input.window !== undefined && input.window !== b.window) {
			return {
				ok: false,
				code: "window_fixed",
				message: `${b.id} has a ${b.window} window; the brain cannot change it`,
				fix: "Omit window.",
			};
		}
		if (given.v > b.limit) {
			return {
				ok: false,
				code: "above_ceiling",
				message: `${given.v} exceeds the configured ceiling ${b.limit} for ${b.id}: the brain may only lower a budget`,
				fix: "Ask the owner to raise the budget in Settings → Budgets.",
			};
		}
		return {
			ok: true,
			id: b.id,
			limit: given.v,
			ceiling: b.limit,
			unit: b.unit,
		};
	}

	async applyBrainLimit(input: {
		budget: string;
		limitUsd?: number;
		limitTokens?: number;
		window?: string;
	}): Promise<{ id: string; limit: number }> {
		const v = await this.checkBrainLimit(input);
		if (!v.ok) throw new Error(v.message);
		const o = await this.readOverrides();
		o[v.id] = v.limit;
		const record = o as unknown as Record<string, unknown>;
		await this.deps.handle.db
			.insert(engineKv)
			.values({ key: "budget_overrides", value: record, updatedAt: new Date() })
			.onConflictDoUpdate({
				target: engineKv.key,
				set: { value: record, updatedAt: new Date() },
			});
		await this.evaluate();
		return { id: v.id, limit: v.limit };
	}

	private async readOverrides(): Promise<Record<string, number>> {
		const [row] = await this.deps.handle.db
			.select()
			.from(engineKv)
			.where(eq(engineKv.key, "budget_overrides"));
		return { ...((row?.value ?? {}) as Record<string, number>) };
	}

	/** Set (entry) or remove (null) one budget. `brain` takes `key: "brain"`. */
	async set(input: {
		scope: BudgetScope;
		kind: BudgetKind;
		key: string;
		entry: BudgetEntry | null;
	}): Promise<BudgetStatus[]> {
		const entry = input.entry ? budgetEntrySchema.parse(input.entry) : null;
		if (entry && input.kind !== "resource" && entry.liveRunPolicy)
			throw new Error("liveRunPolicy applies to resource budgets only");
		await mutateConfig(this.deps.mfwHome, (config) => {
			let target: { budgets?: StoredBudgets };
			if (input.scope === "machine") target = config;
			else {
				const p = config.projects.find((x) => x.name === this.deps.project);
				if (!p)
					throw new Error(
						`project '${this.deps.project}' is not in the machine config`,
					);
				target = p;
			}
			const b: StoredBudgets = { ...(target.budgets ?? {}) };
			if (input.kind === "brain") {
				if (entry) b.brain = entry;
				else delete b.brain;
			} else {
				const field = input.kind === "agent" ? "agents" : "resources";
				const rec = { ...(b[field] ?? {}) };
				if (entry) rec[input.key] = entry;
				else delete rec[input.key];
				if (Object.keys(rec).length) b[field] = rec;
				else delete b[field];
			}
			if (Object.keys(b).length) target.budgets = b;
			else delete target.budgets;
		});
		await this.evaluate();
		return this.list();
	}

	// ------------------------------------------------------------------
	// reading
	// ------------------------------------------------------------------

	async list(): Promise<BudgetStatus[]> {
		const state = await this.readState();
		const now = this.now();
		const out: BudgetStatus[] = [];
		const held = await this.deps.holds.active().catch(() => ({}));
		for (const b of await this.resolved()) {
			const w = windowBounds(b.window, now);
			const used = await this.measure(b, w);
			const st = state[b.id];
			const phase: BudgetPhase =
				used >= b.limit
					? "exhausted"
					: st && st.windowStart === w.start && st.phase === "warned"
						? "warned"
						: b.warnAt !== null && used / b.limit >= b.warnAt
							? "warned"
							: "ok";
			out.push({
				...b,
				used,
				fraction: b.limit > 0 ? used / b.limit : 0,
				windowStart: w.start,
				windowResetsAt: w.end,
				phase,
				held:
					b.kind === "agent"
						? (held as Record<string, { reason: string }>)[b.key]?.reason ===
							"budget"
						: phase === "exhausted" && b.kind === "resource",
			});
		}
		return out;
	}

	async get(id: string): Promise<BudgetStatus | null> {
		return (await this.list()).find((b) => b.id === id || b.key === id) ?? null;
	}

	/**
	 * The exhausted resource budget this task depends on, or null. Rate-limited
	 * re-evaluation first, so a window that rolled over releases the task.
	 */
	async holdFor(task: {
		requiresResources?: readonly (string | { id: string })[] | null;
		executionTarget?: string | null;
	}): Promise<{ key: string; until: number; reason: string } | null> {
		await this.tick();
		if (this.exhaustedResources.size === 0) return null;
		const keys = resourceKeysOfTask(task);
		for (const h of this.exhaustedResources.values()) {
			if (!keys.some((k) => keyMatches(h.key, k))) continue;
			return {
				key: h.key,
				until: h.until,
				reason: `budget exhausted: ${fmt(h.used, h.unit)} of ${fmt(h.limit, h.unit)}`,
			};
		}
		return null;
	}

	// ------------------------------------------------------------------
	// evaluation
	// ------------------------------------------------------------------

	/** Evaluate when the last pass is older than `minIntervalMs`. Never throws. */
	async tick(): Promise<void> {
		const gap = this.deps.minIntervalMs ?? 5_000;
		if (this.loaded && this.now() - this.lastTick < gap) return;
		try {
			await this.evaluate();
		} catch (e) {
			this.deps.log.warn({ err: e }, "budget evaluation failed");
		}
	}

	/** Serialized: two overlapping passes would race the transition state. */
	evaluate(): Promise<void> {
		const run = this.chain.then(() => this.evaluateNow());
		this.chain = run.catch(() => {});
		return run;
	}

	private async evaluateNow(): Promise<void> {
		this.lastTick = this.now();
		const now = this.now();
		const budgets = await this.resolved();
		const state = await this.readState();
		const next: StateMap = { ...state };
		const exhausted = new Map<
			string,
			{
				key: string;
				until: number;
				used: number;
				limit: number;
				unit: BudgetUnit;
			}
		>();
		for (const b of budgets) {
			const w = windowBounds(b.window, now);
			const used = await this.measure(b, w);
			const fraction = b.limit > 0 ? used / b.limit : 0;
			const prev = state[b.id];
			const over = used >= b.limit;
			const rolled = prev !== undefined && prev.windowStart !== w.start;
			let phase: BudgetPhase = rolled ? "ok" : (prev?.phase ?? "ok");
			let announce: Parameters<typeof appendEvent>[1] | null = null;
			let restoredReason: "window_reset" | "limit_raised" | null = null;
			const meta = { key: b.key, kind: b.kind, unit: b.unit };

			if (prev?.phase === "exhausted" && (rolled || !over)) {
				restoredReason = rolled ? "window_reset" : "limit_raised";
				announce = {
					type: "budget.restored",
					payload: { key: b.key, kind: b.kind, reason: restoredReason },
				};
				phase = "ok";
			}
			if (over && phase !== "exhausted") {
				phase = "exhausted";
				announce = {
					type: "budget.exhausted",
					payload: {
						...meta,
						used,
						limit: b.limit,
						windowResetsAt: w.end,
					},
				};
			} else if (!over && phase !== "exhausted") {
				const warn = b.warnAt !== null && fraction >= b.warnAt;
				if (warn && phase === "ok") {
					phase = "warned";
					announce = {
						type: "budget.threshold",
						payload: {
							...meta,
							used,
							limit: b.limit,
							fraction,
							windowResetsAt: w.end,
						},
					};
				} else if (!warn && phase === "warned") phase = "ok";
			}

			const st: StoredState = {
				windowStart: w.start,
				phase,
				limit: b.limit,
				...(prev?.pendingStops && phase === "exhausted"
					? { pendingStops: prev.pendingStops }
					: {}),
				...(prev?.stopped && phase === "exhausted"
					? { stopped: prev.stopped }
					: {}),
				...(prev?.pausedBrain && phase === "exhausted"
					? { pausedBrain: true }
					: {}),
			};
			next[b.id] = st;
			if (phase === "exhausted" && b.kind === "resource")
				exhausted.set(b.id, {
					key: b.key,
					until: w.end,
					used,
					limit: b.limit,
					unit: b.unit,
				});

			if (announce) {
				const event = announce;
				// The transition and its event commit together: no repeat on restart.
				const stored = await this.deps.handle.withTx(async (tx) => {
					const e = await appendEvent(tx, event, now);
					await this.writeState(next, tx);
					return e;
				});
				this.deps.bus.publish([stored]);
			}
			await this.applyEffects(b, w, phase, restoredReason, st, prev);
		}
		// A budget that was removed: lift what it held and forget it.
		const known = new Set(budgets.map((b) => b.id));
		for (const [id, st] of Object.entries(state)) {
			if (known.has(id)) continue;
			if (st.phase === "exhausted") await this.lift(id, st);
			delete next[id];
		}
		await this.writeState(next);
		this.exhaustedResources = exhausted;
		this.loaded = true;
	}

	private async applyEffects(
		b: ResolvedBudget,
		w: WindowBounds,
		phase: BudgetPhase,
		restored: "window_reset" | "limit_raised" | null,
		st: StoredState,
		prev: StoredState | undefined,
	): Promise<void> {
		if (b.kind === "agent") {
			if (phase === "exhausted") {
				// Re-asserted every pass: the hold file is advisory and may be lost.
				await this.deps.holds.hold(b.key, {
					until: w.end,
					reason: "budget",
					project: this.deps.project,
				});
			} else if (restored) await this.clearBudgetHold(b.key);
			return;
		}
		if (b.kind === "brain") {
			if (phase === "exhausted" && !st.pausedBrain && this.deps.pauseBrain) {
				await this.deps.pauseBrain(true);
				st.pausedBrain = true;
			} else if (restored && prev?.pausedBrain && this.deps.pauseBrain) {
				await this.deps.pauseBrain(false);
			}
			return;
		}
		if (phase !== "exhausted") return;
		// Resource: live runs that consume it follow the policy.
		const live = await this.deps.registry.list({ states: [...LIVE] });
		const pending = new Set(st.pendingStops ?? []);
		const stopped = new Set(st.stopped ?? []);
		for (const run of live) {
			if (run.kind === "brain" || stopped.has(run.id)) continue;
			if (!(await this.runUses(run, b.key))) continue;
			if (b.liveRunPolicy === "stop") {
				await this.stop(run.id, b.key);
				stopped.add(run.id);
				continue;
			}
			// finish_turn: stop at the next turn boundary.
			// Unknown activity (not folded yet) counts as mid-turn.
			const boundary = run.activity !== null && run.activity !== "working";
			if (boundary || pending.has(run.id)) {
				if (boundary) {
					await this.stop(run.id, b.key);
					stopped.add(run.id);
					pending.delete(run.id);
				}
			} else pending.add(run.id);
		}
		const liveIds = new Set(live.map((r) => r.id));
		for (const id of pending) if (!liveIds.has(id)) pending.delete(id);
		for (const id of stopped) if (!liveIds.has(id)) stopped.delete(id);
		if (stopped.size) st.stopped = [...stopped];
		else delete st.stopped;
		if (pending.size) st.pendingStops = [...pending];
		else delete st.pendingStops;
	}

	private async stop(runId: string, key: string): Promise<void> {
		try {
			await this.deps.stopRun(runId);
			this.deps.log.info({ runId, key }, "stopped a run: budget exhausted");
		} catch (e) {
			this.deps.log.warn({ err: e, runId, key }, "budget stop failed");
		}
	}

	private async runUses(
		run: { id: string; executionTarget: string; hostId: string | null },
		key: string,
	): Promise<boolean> {
		if (run.executionTarget === "runpod" && keyMatches(key, "runpod:*"))
			return true;
		if (run.hostId && keyMatches(key, `host:${run.hostId}`)) return true;
		const slots = await this.deps.handle.db
			.select({ resourceId: resourceSlots.resourceId })
			.from(resourceSlots)
			.where(eq(resourceSlots.runId, run.id));
		return slots.some((s) => keyMatches(key, s.resourceId));
	}

	private async clearBudgetHold(key: string): Promise<void> {
		const active = await this.deps.holds.active();
		if (active[key]?.reason === "budget") await this.deps.holds.clear(key);
	}

	private async lift(id: string, st: StoredState): Promise<void> {
		if (id.startsWith("agent:")) await this.clearBudgetHold(id.slice(6));
		// A removed brain budget must not leave the brain paused for good.
		if (st.pausedBrain && this.deps.pauseBrain)
			await this.deps.pauseBrain(false);
	}

	// ------------------------------------------------------------------
	// ledger
	// ------------------------------------------------------------------

	private async measure(b: ResolvedBudget, w: WindowBounds): Promise<number> {
		const handles =
			b.scope === "machine"
				? (this.deps.ledgers?.() ?? [this.deps.handle])
				: [this.deps.handle];
		let total = 0;
		for (const h of handles) total += await measureOne(h, b, w);
		return total;
	}

	// ------------------------------------------------------------------
	// state
	// ------------------------------------------------------------------

	private async readState(): Promise<StateMap> {
		const [row] = await this.deps.handle.db
			.select()
			.from(engineKv)
			.where(eq(engineKv.key, "budgets"));
		return (row?.value ?? {}) as StateMap;
	}

	private async writeState(
		value: StateMap,
		tx: ProjectDbTx | ProjectDb = this.deps.handle.db,
	): Promise<void> {
		const record = value as unknown as Record<string, unknown>;
		await tx
			.insert(engineKv)
			.values({ key: "budgets", value: record, updatedAt: new Date() })
			.onConflictDoUpdate({
				target: engineKv.key,
				set: { value: record, updatedAt: new Date() },
			});
	}

	/** Exhausted budgets for the inbox: stable id per (key, window). */
	async exhaustedForInbox(): Promise<
		{
			id: string;
			key: string;
			kind: "resource" | "brain";
			used: number;
			limit: number;
			unit: BudgetUnit;
			resetsAt: number;
			ts: number;
		}[]
	> {
		const state = await this.readState();
		const out = [];
		const budgets = await this.resolved();
		for (const b of budgets) {
			// An agent budget is a provider hold (it reroutes); a resource or
			// brain budget has no other surface, so only those are items.
			if (b.kind === "agent") continue;
			const st = state[b.id];
			if (st?.phase !== "exhausted") continue;
			const w = windowBounds(b.window, st.windowStart);
			out.push({
				id: `budget:${b.key}:${st.windowStart}`,
				key: b.key,
				kind: b.kind,
				used: await this.measure(b, w),
				limit: b.limit,
				unit: b.unit,
				resetsAt: w.end,
				ts: st.windowStart,
			});
		}
		return out;
	}
}

function fmt(n: number, unit: BudgetUnit): string {
	if (unit === "usd") return `$${n.toFixed(2)}`;
	if (unit === "slot_hours") return `${n.toFixed(1)} slot-hours`;
	return `${Math.round(n)} tokens`;
}

async function measureOne(
	handle: ProjectDbHandle,
	b: ResolvedBudget,
	w: WindowBounds,
): Promise<number> {
	const where = and(
		gte(spendLedger.ts, new Date(w.start)),
		lt(spendLedger.ts, new Date(w.end)),
		b.kind === "brain"
			? eq(spendLedger.kind, "brain")
			: b.key.endsWith("*")
				? like(spendLedger.accountKey, `${b.key.slice(0, -1)}%`)
				: eq(spendLedger.accountKey, b.key),
		b.unit === "slot_hours"
			? eq(spendLedger.source, "host_slot_time")
			: undefined,
	);
	const col =
		b.unit === "usd"
			? sql<number>`COALESCE(SUM(${spendLedger.usd}), 0)`
			: b.unit === "tokens"
				? sql<number>`COALESCE(SUM(COALESCE(${spendLedger.tokensIn}, 0) + COALESCE(${spendLedger.tokensOut}, 0)), 0)`
				: // slot time rows carry slot-seconds in `tokens_in`
					sql<number>`COALESCE(SUM(${spendLedger.tokensIn}), 0) / 3600.0`;
	const [row] = await handle.db
		.select({ v: col })
		.from(spendLedger)
		.where(where);
	return Number(row?.v ?? 0);
}
