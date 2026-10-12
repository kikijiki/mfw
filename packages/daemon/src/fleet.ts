import { isRunActivity, type RunActivity } from "@mfw/core/activity";
import type { ProjectDb } from "@mfw/db/client";
import { spendLedger } from "@mfw/db/schema";
import { gte, sql } from "drizzle-orm";
import { type BudgetStatus, keyMatches, windowBounds } from "./budgets.ts";
import {
	describeHostHealth,
	type HealthTrackEntry,
	overallHealth,
} from "./host-health.ts";
import type { HostResourceReadModel } from "./host-resources/types.ts";
import type { HostView } from "./host-service.ts";
import type { OpenRouterAccountReadModel } from "./openrouter-account-service.ts";
import type { StoredProviderHold } from "./provider-holds.ts";
import { parseRoutingRecord } from "./routing.ts";
import type { RunPodAccountReadModel } from "./runpod-account-service.ts";
import type { Orchestrator, ProjectServices } from "./services.ts";

/**
 * `fleet.summary`: where agents run and what they cost, in one read.
 *
 * Three families of node, each carrying its capacity, its current occupants,
 * its budgets and spend, any hold on it and its health:
 *
 *  - hosts: this machine (with its slot resources) and registry SSH hosts;
 *  - accounts: one per harness account (`claude-cli`, `codex-cli@or`), the
 *    unit a rate limit or an `agent` budget acts on, with its models;
 *  - resources: the RunPod account and the OpenRouter account.
 *
 * An occupant is a run chip: `runs.active` rows (the same set the presence
 * bar shows) plus host leases whose run is not in that set, so a lease held
 * by a run the registry has not listed still appears. Every chip names its
 * project and a node ref, so the page can open the right inspector.
 *
 * Building is split from gathering: `buildFleetSummary` is pure over plain
 * inputs, `gatherFleet` reads the orchestrator.
 */

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

export interface FleetRunChip {
	/** `run:<id>`: what `?node=` takes. */
	ref: string;
	runId: string;
	/** Null when only a host lease names the run: the registry has no row for it. */
	project: string | null;
	taskId: string | null;
	taskTitle: string | null;
	label: string | null;
	kind: string | null;
	state: string;
	activity: RunActivity | null;
	harness: string | null;
	model: string | null;
	startedAt: number | null;
	liveCostUsd: number | null;
}

export interface FleetHold {
	source: "provider" | "budget" | "paused";
	reason: string;
	/** When the node is available again; null when no time is known (paused by a person). */
	until: number | null;
	since: number | null;
}

export interface FleetBudget {
	id: string;
	key: string;
	kind: "agent" | "resource" | "brain";
	scope: "project" | "machine";
	/** The project a project-scoped budget belongs to; null for a machine ceiling. */
	project: string | null;
	unit: "usd" | "tokens" | "slot_hours";
	window: string;
	limit: number;
	used: number;
	fraction: number;
	warnAt: number | null;
	phase: "ok" | "warned" | "exhausted";
	held: boolean;
	windowStart: number;
	resetsAt: number;
}

export interface FleetSpend {
	/** Start of the UTC day the figures cover. */
	since: number;
	usd: number;
	tokens: number;
}

export type FleetHealthState =
	| "ok"
	| "degraded"
	| "unavailable"
	| "unknown"
	| "disabled";

/**
 * One check behind a health state, with its cause. `summary` is the readable
 * status line; the rest is the disclosure: what the probe said (`message`),
 * since when, what mfw does about it (`affects`) and what to do (`hint`).
 */
export interface FleetHealthItem {
	kind: string;
	label: string;
	status: FleetHealthState;
	code: string | null;
	summary: string;
	message: string | null;
	since: number | null;
	lastOkAt: number | null;
	checkedAt: number | null;
	consecutiveFailures: number;
	affects: string | null;
	hint: string | null;
	/** A first failure after a good reading: shown, but it does not turn the node amber. */
	transient: boolean;
}

export interface FleetHealth {
	state: FleetHealthState;
	/** The worst item's cause in words; null when healthy. */
	detail: string | null;
	checkedAt: number | null;
	/** Every check behind the state; one entry for a provider or SSH host. */
	items: FleetHealthItem[];
}

/** A single-check health with its explanation; `ok` carries no detail. */
function healthOf(input: {
	kind: string;
	label: string;
	state: FleetHealthState;
	code?: string | null;
	message?: string | null;
	affects?: string | null;
	hint?: string | null;
	checkedAt: number | null;
	since?: number | null;
}): FleetHealth {
	const ok = input.state === "ok";
	const phrase = ok
		? "ok"
		: input.state === "unknown"
			? "not checked"
			: input.state === "disabled"
				? "disabled"
				: (input.message ?? input.state);
	const item: FleetHealthItem = {
		kind: input.kind,
		label: input.label,
		status: input.state,
		code: input.code ?? null,
		summary: `${input.label}: ${phrase}`,
		message: input.message ?? null,
		since: input.since ?? null,
		lastOkAt: ok ? input.checkedAt : null,
		checkedAt: input.checkedAt,
		consecutiveFailures: ok ? 0 : 1,
		affects: input.affects ?? null,
		hint: input.hint ?? null,
		transient: false,
	};
	return {
		state: input.state,
		detail: ok ? null : (input.message ?? null),
		checkedAt: input.checkedAt,
		items: [item],
	};
}

interface FleetNodeBase {
	occupants: FleetRunChip[];
	budgets: FleetBudget[];
	spend: FleetSpend;
	hold: FleetHold | null;
	/** Epoch ms the node is unavailable until (a hold or an exhausted budget), or null. */
	unavailableUntil: number | null;
	health: FleetHealth;
}

export interface FleetSlot {
	resourceId: string;
	accounting: "slot" | "quantity";
	configured: number;
	capacity: number;
	inUse: number;
	enabled: boolean;
	draining: boolean;
	holdReason: string | null;
	occupants: FleetRunChip[];
	budgets: FleetBudget[];
}

export interface FleetHostNode extends FleetNodeBase {
	id: string;
	kind: "local" | "ssh";
	label: string;
	/** Slots this node offers; null for the local machine, whose capacity is its `slots`. */
	capacity: number | null;
	inUse: number | null;
	schedulable: boolean;
	reason: string | null;
	/** Local slot resources (CPU, RAM, GPUs); empty for an SSH host. */
	slots: FleetSlot[];
}

export interface FleetModelRow {
	model: string;
	live: number;
	occupants: FleetRunChip[];
}

export interface FleetAccountNode extends FleetNodeBase {
	/** The provider hold key. */
	key: string;
	harness: string;
	endpoint: string | null;
	models: FleetModelRow[];
}

export interface FleetPodRow {
	podId: string;
	name: string;
	live: boolean;
	phase: string;
	costPerHr: number | null;
	runId: string | null;
	project: string | null;
}

export interface FleetRunpodNode extends FleetNodeBase {
	kind: "runpod";
	id: string;
	label: string;
	detailPath: "/fleet/runpod";
	balance: number | null;
	hourlyBurn: number | null;
	dispatchPaused: boolean;
	livePods: number;
	pods: FleetPodRow[];
}

export interface FleetOpenrouterNode extends FleetNodeBase {
	kind: "openrouter";
	id: string;
	label: string;
	detailPath: "/fleet/openrouter";
	remainingCredits: number | null;
	usageDaily: number | null;
	usageMonthly: number | null;
	limit: number | null;
	limitRemaining: number | null;
	limitReset: string | null;
}

export interface FleetSummary {
	generatedAt: number;
	hosts: FleetHostNode[];
	accounts: FleetAccountNode[];
	resources: Array<FleetRunpodNode | FleetOpenrouterNode>;
	/** Every budget once (a machine ceiling is not repeated per project). */
	budgets: FleetBudget[];
	/** Live runs across the fleet, once each. */
	liveRuns: number;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface FleetRunInput {
	project: string;
	runId: string;
	kind: string;
	state: string;
	activity: string | null;
	label: string | null;
	taskId: string | null;
	taskTitle: string | null;
	providerId: string | null;
	harness: string | null;
	model: string | null;
	modelVendor: string | null;
	routing: Record<string, unknown> | null;
	hostId: string | null;
	startedAt: number;
	liveCostUsd: number | null;
}

export interface FleetInputs {
	now: number;
	runs: readonly FleetRunInput[];
	/**
	 * Runs a live lease names that are not in `runs` (any state): resolved from
	 * the registries so their chips still know their project.
	 */
	leasedRuns?: readonly FleetRunInput[];
	sshHosts: readonly HostView[];
	hostModel: Pick<
		HostResourceReadModel,
		"definitions" | "effectiveCapacities" | "leases" | "health"
	> | null;
	/** Since-when / last-ok / failure counts per probe kind (the observation loop's memory). */
	hostHealthTrack?: Readonly<Record<string, HealthTrackEntry>>;
	holds: Readonly<Record<string, StoredProviderHold>>;
	budgets: readonly { project: string; status: BudgetStatus }[];
	/** Ledger sums since `spendSince`, per account key. */
	spend: Readonly<Record<string, { usd: number; tokens: number }>>;
	spendSince: number;
	runpod: Pick<
		RunPodAccountReadModel,
		"enabled" | "accountId" | "credential" | "gate" | "settings" | "inventory"
	> &
		Partial<Pick<RunPodAccountReadModel, "balance" | "costs">> & {
			pods: ReadonlyArray<
				Pick<
					RunPodAccountReadModel["pods"][number],
					| "podId"
					| "name"
					| "live"
					| "phase"
					| "costPerHr"
					| "runId"
					| "projectName"
				>
			>;
		};
	openrouter: Pick<
		OpenRouterAccountReadModel,
		"credential" | "checkedAt" | "fresh" | "error" | "key" | "credits"
	> & { accountUsage?: OpenRouterAccountReadModel["accountUsage"] };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const LIVE_STATES = new Set([
	"starting",
	"running",
	"ended",
	"finalizing",
	"merging",
]);

const SSH_KIND = "ssh-host";

function keyOfRun(r: FleetRunInput): string {
	const d = parseRoutingRecord(r.routing);
	return d?.holdKey ?? d?.provider ?? r.providerId ?? r.harness ?? "unknown";
}

function hostOfRun(r: FleetRunInput): string | null {
	const d = parseRoutingRecord(r.routing);
	return r.hostId ?? d?.hostId ?? null;
}

function chipOf(r: FleetRunInput): FleetRunChip {
	return {
		ref: `run:${r.runId}`,
		runId: r.runId,
		project: r.project,
		taskId: r.taskId,
		taskTitle: r.taskTitle,
		label: r.label,
		kind: r.kind,
		state: r.state,
		activity: isRunActivity(r.activity) ? r.activity : null,
		harness: r.harness ?? r.providerId,
		model: r.model,
		startedAt: r.startedAt,
		liveCostUsd: r.liveCostUsd,
	};
}

function leaseChip(runId: string): FleetRunChip {
	return {
		ref: `run:${runId}`,
		runId,
		project: null,
		taskId: null,
		taskTitle: null,
		label: null,
		kind: null,
		state: "unknown",
		activity: null,
		harness: null,
		model: null,
		startedAt: null,
		liveCostUsd: null,
	};
}

function budgetView(project: string, b: BudgetStatus): FleetBudget {
	return {
		id: b.id,
		key: b.key,
		kind: b.kind,
		scope: b.scope,
		project: b.scope === "project" ? project : null,
		unit: b.unit,
		window: b.window,
		limit: b.limit,
		used: b.used,
		fraction: b.fraction,
		warnAt: b.warnAt,
		phase: b.phase,
		held: b.held,
		windowStart: b.windowStart,
		resetsAt: b.windowResetsAt,
	};
}

/** Budgets of `kinds` whose key matches any of `keys`. */
function budgetsFor(
	all: readonly FleetBudget[],
	kinds: readonly FleetBudget["kind"][],
	keys: readonly string[],
): FleetBudget[] {
	return all.filter(
		(b) => kinds.includes(b.kind) && keys.some((k) => keyMatches(b.key, k)),
	);
}

/**
 * The time a node is unavailable until: its provider hold, and any exhausted
 * budget that is holding it (the window's reset).
 */
function holdOf(
	providerHold: StoredProviderHold | undefined,
	budgets: readonly FleetBudget[],
): { hold: FleetHold | null; until: number | null } {
	const exhausted = budgets.filter((b) => b.held || b.phase === "exhausted");
	let hold: FleetHold | null = null;
	if (providerHold) {
		hold = {
			source: providerHold.reason === "budget" ? "budget" : "provider",
			reason: providerHold.reason,
			until: providerHold.until,
			since: providerHold.since ?? null,
		};
	}
	for (const b of exhausted) {
		if (hold && hold.until !== null && hold.until >= b.resetsAt) continue;
		hold = {
			source: "budget",
			reason: `budget exhausted: ${b.id}`,
			until: b.resetsAt,
			since: b.windowStart,
		};
	}
	return { hold, until: hold?.until ?? null };
}

function spendFor(input: FleetInputs, keys: readonly string[]): FleetSpend {
	let usd = 0;
	let tokens = 0;
	for (const [k, v] of Object.entries(input.spend)) {
		if (!keys.some((key) => keyMatches(key, k))) continue;
		usd += v.usd;
		tokens += v.tokens;
	}
	return { since: input.spendSince, usd, tokens };
}

function dedupeChips(chips: FleetRunChip[]): FleetRunChip[] {
	const seen = new Map<string, FleetRunChip>();
	for (const c of chips) {
		const have = seen.get(c.runId);
		// A registry row beats a lease-only placeholder.
		if (!have || (have.project === null && c.project !== null))
			seen.set(c.runId, c);
	}
	return [...seen.values()];
}

const LEASE_LIVE = new Set(["provisional", "active", "uncertain", "releasing"]);

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export function buildFleetSummary(input: FleetInputs): FleetSummary {
	const live = input.runs.filter(
		(r) => r.kind !== "brain" && LIVE_STATES.has(r.state),
	);
	const chips = new Map<string, FleetRunChip>();
	for (const r of input.leasedRuns ?? []) chips.set(r.runId, chipOf(r));
	for (const r of live) chips.set(r.runId, chipOf(r));

	// Budgets once each: a machine ceiling shows in every project's list.
	const budgets: FleetBudget[] = [];
	const seenBudget = new Set<string>();
	for (const { project, status } of input.budgets) {
		const v = budgetView(project, status);
		const id = `${v.scope}:${v.project ?? ""}:${v.id}:${v.unit}`;
		if (seenBudget.has(id)) continue;
		seenBudget.add(id);
		budgets.push(v);
	}

	// Leases per resource id, newest-state only.
	const leaseRunsByResource = new Map<string, string[]>();
	for (const lease of input.hostModel?.leases ?? []) {
		const runId = lease.run?.runId;
		if (!runId || !LEASE_LIVE.has(lease.state)) continue;
		for (const alloc of lease.allocations) {
			const list = leaseRunsByResource.get(alloc.resourceId) ?? [];
			list.push(runId);
			leaseRunsByResource.set(alloc.resourceId, list);
		}
	}
	const chipFor = (runId: string): FleetRunChip =>
		chips.get(runId) ?? leaseChip(runId);

	// RunPod pods name the run they serve.
	const podRunIds = new Set<string>();
	for (const pod of input.runpod.pods)
		if (pod.live && pod.runId) podRunIds.add(pod.runId);

	// ---- SSH hosts
	const sshIds = new Set(input.sshHosts.map((h) => h.config.id));
	const hosts: FleetHostNode[] = [];
	const onSsh = new Set<string>();
	for (const h of input.sshHosts) {
		const id = h.config.id;
		const slotId = h.slots.resourceId;
		const occ = dedupeChips([
			...live.filter((r) => hostOfRun(r) === id).map(chipOf),
			...(leaseRunsByResource.get(slotId) ?? []).map(chipFor),
		]);
		for (const o of occ) onSsh.add(o.runId);
		const keys = [`host:${id}`, slotId];
		const hb = budgetsFor(budgets, ["resource"], keys);
		const { hold, until } = holdOf(undefined, hb);
		const obs = h.observed;
		const sshBase = { kind: "ssh", label: `Host ${id}` };
		const health: FleetHealth = !obs
			? healthOf({
					...sshBase,
					state: "unknown",
					message: "not probed yet",
					affects: "No effect yet: the host is probed when it is first used.",
					hint: "Check the host from Settings to probe it now.",
					checkedAt: null,
				})
			: obs.health === "ok"
				? healthOf({ ...sshBase, state: "ok", checkedAt: obs.checkedAt })
				: obs.health === "unreachable"
					? healthOf({
							...sshBase,
							state: "unavailable",
							code: "unreachable",
							message: obs.problems[0] ?? "The host did not answer over SSH.",
							affects:
								"No runs are placed on this host until it answers again; runs already there are left alone.",
							hint: "Check the host is up and reachable over SSH, then re-check it.",
							checkedAt: obs.checkedAt,
						})
					: healthOf({
							...sshBase,
							state: "degraded",
							code: obs.health,
							message:
								obs.problems.join("; ") ||
								`The last probe reported the host as ${obs.health}.`,
							affects:
								obs.health === "refused"
									? "The host breaks mfw's trust minimum (root, sudo or no bwrap), so no runs are placed on it."
									: "The host is reachable but missing tooling, so no runs are placed on it until fixed.",
							hint: "Fix what the probe reported, then re-check the host.",
							checkedAt: obs.checkedAt,
						});
		hosts.push({
			id,
			kind: "ssh",
			label: id,
			capacity: h.slots.capacity,
			inUse: Math.max(h.slots.inUse, occ.length),
			schedulable: h.schedulable,
			reason: h.reason,
			slots: [],
			occupants: occ,
			budgets: hb,
			spend: spendFor(input, keys),
			hold,
			unavailableUntil: until,
			health,
		});
	}

	// ---- local machine: runs not on an SSH host or a pod, plus slot resources
	const localSlots: FleetSlot[] = [];
	for (const def of input.hostModel?.definitions ?? []) {
		if (def.metadata?.kind === SSH_KIND || sshIds.has(def.id)) continue;
		const cap = input.hostModel?.effectiveCapacities.find(
			(c) => c.resourceId === def.id,
		);
		const occupants = dedupeChips(
			(leaseRunsByResource.get(def.id) ?? []).map(chipFor),
		);
		localSlots.push({
			resourceId: def.id,
			accounting: def.accounting,
			configured: Number(def.capacity),
			capacity: Number(cap?.effectiveCapacity ?? def.capacity),
			inUse: Number(cap?.durablePromises ?? 0),
			enabled: def.enabled,
			draining: def.draining,
			holdReason: cap?.holdReason ?? null,
			occupants,
			budgets: budgetsFor(budgets, ["resource"], [def.id]),
		});
	}
	const localOccupants = dedupeChips(
		live.filter((r) => !hostOfRun(r) && !podRunIds.has(r.runId)).map(chipOf),
	);
	const localHealth = ((): FleetHealth => {
		const stored = input.hostModel?.health ?? [];
		if (stored.length === 0)
			return {
				state: "unknown",
				detail: null,
				checkedAt: null,
				items: [],
			};
		const items = stored
			.map((h) =>
				describeHostHealth(h, input.hostHealthTrack?.[h.kind], input.now),
			)
			.sort((a, b) => a.kind.localeCompare(b.kind));
		const state = overallHealth(items);
		const worst =
			items.find((i) => i.status === "unavailable" && !i.transient) ??
			items.find((i) => i.status === "degraded" && !i.transient);
		const more = items.filter(
			(i) => i !== worst && i.status !== "ok" && !i.transient,
		).length;
		return {
			state,
			detail: worst
				? `${worst.summary}${more > 0 ? ` (+${more} more)` : ""}`
				: null,
			checkedAt: Math.max(...stored.map((i) => i.checkedAt)),
			items: items.map((i) => ({ ...i, status: i.status })),
		};
	})();
	const localBudgets = budgetsFor(
		budgets,
		["resource"],
		localSlots.map((s) => s.resourceId),
	);
	const localHold = holdOf(undefined, localBudgets);
	hosts.unshift({
		id: "local",
		kind: "local",
		label: "This machine",
		capacity: null,
		inUse: null,
		schedulable: true,
		reason: null,
		slots: localSlots,
		occupants: localOccupants,
		budgets: localBudgets,
		spend: { since: input.spendSince, usd: 0, tokens: 0 },
		hold: localHold.hold,
		unavailableUntil: localHold.until,
		health: localHealth,
	});

	// ---- harness accounts
	const byAccount = new Map<string, FleetRunInput[]>();
	for (const r of live) {
		const k = keyOfRun(r);
		const list = byAccount.get(k) ?? [];
		list.push(r);
		byAccount.set(k, list);
	}
	// A held account or one with an agent budget shows even with nothing live.
	for (const k of Object.keys(input.holds))
		if (!byAccount.has(k)) byAccount.set(k, []);
	for (const b of budgets)
		if (b.kind === "agent" && !b.key.endsWith("*") && !byAccount.has(b.key))
			byAccount.set(b.key, []);
	const accounts: FleetAccountNode[] = [];
	for (const [key, runs] of byAccount) {
		const [harness, ...rest] = key.split("@");
		const ab = budgetsFor(budgets, ["agent"], [key]);
		const { hold, until } = holdOf(input.holds[key], ab);
		const byModel = new Map<string, FleetRunChip[]>();
		for (const r of runs) {
			const m = r.model ?? "unknown";
			const list = byModel.get(m) ?? [];
			list.push(chipOf(r));
			byModel.set(m, list);
		}
		accounts.push({
			key,
			harness: harness ?? key,
			endpoint: rest.length ? rest.join("@") : null,
			models: [...byModel.entries()]
				.map(([model, occupants]) => ({
					model,
					live: occupants.length,
					occupants,
				}))
				.sort((a, b) => b.live - a.live || a.model.localeCompare(b.model)),
			occupants: runs.map(chipOf),
			budgets: ab,
			spend: spendFor(input, [key]),
			hold,
			unavailableUntil: until,
			health: hold
				? healthOf({
						kind: "account",
						label: "Account",
						state: "unavailable",
						code: hold.source,
						message: hold.reason,
						affects:
							"New runs on this account wait; runs already live are not stopped.",
						hint:
							hold.until === null
								? "Clear the hold or raise the limit that caused it."
								: "It lifts by itself at the time shown.",
						checkedAt: null,
						since: hold.since,
					})
				: healthOf({
						kind: "account",
						label: "Account",
						state: "ok",
						checkedAt: null,
					}),
		});
	}
	accounts.sort(
		(a, b) =>
			b.occupants.length - a.occupants.length || a.key.localeCompare(b.key),
	);

	// ---- RunPod
	const rp = input.runpod;
	const rpKeys = [`runpod:${rp.accountId}`, "runpod:*"];
	const rpBudgets = budgetsFor(budgets, ["resource"], rpKeys);
	const rpHold = holdOf(undefined, rpBudgets);
	const livePods = rp.pods.filter((p) => p.live);
	const rpBase = { kind: "runpod", label: "RunPod" };
	const rpHealth: FleetHealth = !rp.enabled
		? healthOf({
				...rpBase,
				state: "disabled",
				code: "disabled",
				message: "RunPod is not enabled",
				affects: "No pods are created; local and SSH hosts are used.",
				hint: "Enable RunPod in the machine settings to use pods.",
				checkedAt: null,
			})
		: !rp.credential.ready
			? healthOf({
					...rpBase,
					state: "unavailable",
					code: rp.credential.validationError
						? "credential-invalid"
						: "no-credential",
					message: rp.credential.validationError ?? "No RunPod API key is set.",
					affects: "No pods can be created or inspected.",
					hint: "Add a valid RunPod API key in the machine settings.",
					checkedAt: rp.credential.checkedAt,
				})
			: !rp.gate.open
				? healthOf({
						...rpBase,
						state: "degraded",
						code: "dispatch-gated",
						message: rp.gate.reason,
						affects:
							"New pods are not created while the gate is closed; existing pods keep running.",
						hint: "Resolve the reason shown; the gate reopens by itself.",
						checkedAt: rp.inventory.observedAt,
					})
				: rp.inventory.error
					? healthOf({
							...rpBase,
							state: "degraded",
							code: "inventory-error",
							message: rp.inventory.error,
							affects:
								"The pod list may be out of date; pod costs and liveness are not refreshed.",
							hint: "It retries on its own; check the RunPod API status if it persists.",
							checkedAt: rp.inventory.observedAt,
						})
					: healthOf({
							...rpBase,
							state: "ok",
							checkedAt: rp.inventory.observedAt,
						});
	const rpPaused = rp.settings.dispatchPaused;
	const runpod: FleetRunpodNode = {
		kind: "runpod",
		id: `runpod:${rp.accountId}`,
		label: "RunPod",
		detailPath: "/fleet/runpod",
		balance: rp.balance?.remainingCredits ?? null,
		hourlyBurn: rp.costs?.providerInfrastructure.hourlyBurn ?? null,
		dispatchPaused: rpPaused,
		livePods: livePods.length,
		pods: rp.pods.map((p) => ({
			podId: p.podId,
			name: p.name,
			live: p.live,
			phase: p.phase,
			costPerHr: p.costPerHr,
			runId: p.runId,
			project: p.projectName,
		})),
		occupants: dedupeChips(
			livePods.filter((p) => p.runId).map((p) => chipFor(p.runId as string)),
		),
		budgets: rpBudgets,
		spend: spendFor(input, rpKeys),
		hold: rpPaused
			? {
					source: "paused",
					reason: rp.settings.reason || "dispatch paused",
					until: null,
					since: rp.settings.updatedAt,
				}
			: rpHold.hold,
		unavailableUntil: rpPaused ? null : rpHold.until,
		health: rpHealth,
	};

	// ---- OpenRouter
	const or = input.openrouter;
	const orAccountKeys = ["openrouter", "openrouter:*"];
	const orBudgets = budgetsFor(budgets, ["resource"], orAccountKeys);
	const orHold = holdOf(undefined, orBudgets);
	const orLimitExhausted =
		or.key?.limitRemaining !== null &&
		or.key?.limitRemaining !== undefined &&
		or.key.limitRemaining <= 0;
	const orBase = { kind: "openrouter", label: "OpenRouter" };
	const orHealth: FleetHealth = !or.credential.ready
		? healthOf({
				...orBase,
				state: or.credential.validationError ? "unavailable" : "disabled",
				code: or.credential.validationError
					? "credential-invalid"
					: "no-credential",
				message:
					or.credential.validationError ?? "No OpenRouter API key is set.",
				affects: "Runs routed through OpenRouter cannot start.",
				hint: "Add a valid OpenRouter API key in the machine settings.",
				checkedAt: or.credential.validatedAt,
			})
		: or.error
			? healthOf({
					...orBase,
					state: "degraded",
					code: "fetch-error",
					message: or.error,
					affects:
						"Credit and key-limit figures may be out of date; runs are not blocked by this alone.",
					hint: "It retries on its own; check the key and OpenRouter status if it persists.",
					checkedAt: or.checkedAt,
				})
			: orLimitExhausted
				? healthOf({
						...orBase,
						state: "unavailable",
						code: "limit-reached",
						message: "The key's spending limit has been reached.",
						affects:
							"Runs routed through OpenRouter wait until the limit resets or is raised.",
						hint: "Raise the key's limit on OpenRouter, or wait for its reset.",
						checkedAt: or.checkedAt,
					})
				: healthOf({ ...orBase, state: "ok", checkedAt: or.checkedAt });
	const orResetAt = or.key?.limitReset ? Date.parse(or.key.limitReset) : NaN;
	const openrouter: FleetOpenrouterNode = {
		kind: "openrouter",
		id: "openrouter",
		label: "OpenRouter",
		detailPath: "/fleet/openrouter",
		remainingCredits: or.credits.remainingCredits,
		usageDaily: or.key?.usageDaily ?? null,
		usageMonthly: or.key?.usageMonthly ?? null,
		limit: or.key?.limit ?? null,
		limitRemaining: or.key?.limitRemaining ?? null,
		limitReset: or.key?.limitReset ?? null,
		occupants: live.filter((r) => r.modelVendor === "openrouter").map(chipOf),
		budgets: orBudgets,
		spend: spendFor(input, orAccountKeys),
		hold:
			orHold.hold ??
			(orLimitExhausted
				? {
						source: "provider",
						reason: "key limit reached",
						until: Number.isFinite(orResetAt) ? orResetAt : null,
						since: null,
					}
				: null),
		unavailableUntil:
			orHold.until ??
			(orLimitExhausted && Number.isFinite(orResetAt) ? orResetAt : null),
		health: orHealth,
	};

	return {
		generatedAt: input.now,
		hosts,
		accounts,
		resources: [runpod, openrouter],
		budgets,
		liveRuns: live.length,
	};
}

// ---------------------------------------------------------------------------
// Gather
// ---------------------------------------------------------------------------

/** Ledger sums per account key since `since`, over one project's ledger. */
export async function spendByAccount(
	db: ProjectDb,
	since: number,
): Promise<Record<string, { usd: number; tokens: number }>> {
	const rows = await db
		.select({
			key: spendLedger.accountKey,
			usd: sql<number>`COALESCE(SUM(${spendLedger.usd}), 0)`,
			tokens: sql<number>`COALESCE(SUM(COALESCE(${spendLedger.tokensIn}, 0) + COALESCE(${spendLedger.tokensOut}, 0)), 0)`,
		})
		.from(spendLedger)
		.where(gte(spendLedger.ts, new Date(since)))
		.groupBy(spendLedger.accountKey);
	return Object.fromEntries(
		rows.map((r) => [r.key, { usd: Number(r.usd), tokens: Number(r.tokens) }]),
	);
}

export type FleetSource = Pick<
	Orchestrator,
	"list" | "hosts" | "hostResources" | "providerHolds" | "runpod" | "openrouter"
>;

const ACTIVE_STATES = [
	"starting",
	"running",
	"ended",
	"finalizing",
	"merging",
] as const;

type RegistryRow = Awaited<
	ReturnType<ProjectServices["registry"]["list"]>
>[number];

function inputOf(
	project: string,
	r: RegistryRow,
	title: string | null,
): FleetRunInput {
	return {
		project,
		runId: r.id,
		kind: r.kind,
		state: r.state,
		activity: r.activity,
		label: r.label,
		taskId: r.taskId,
		taskTitle: title,
		providerId: r.providerId,
		harness: r.harness,
		model: r.model,
		modelVendor: r.modelVendor,
		routing: r.routing,
		hostId: r.hostId,
		startedAt: r.startedAt.getTime(),
		liveCostUsd: r.usageLive?.costUsd ?? null,
	};
}

export async function gatherFleet(
	source: FleetSource,
	now: number = Date.now(),
): Promise<FleetSummary> {
	const projects = source.list();
	const spendSince = windowBounds("day", now).start;
	const hostModel = source.hostResources.readModel();

	const runs: FleetRunInput[] = [];
	const budgets: { project: string; status: BudgetStatus }[] = [];
	const spend: Record<string, { usd: number; tokens: number }> = {};
	for (const svc of projects) {
		const rows = (
			await svc.registry.list({ states: [...ACTIVE_STATES] })
		).filter((r) => r.kind !== "brain");
		const ids = new Set<string>();
		for (const r of rows) if (r.taskId) ids.add(r.taskId);
		const titles = svc.tasks.titles(ids);
		for (const r of rows)
			runs.push(
				inputOf(svc.name, r, r.taskId ? (titles.get(r.taskId) ?? null) : null),
			);
		for (const status of await svc.budgets.list())
			budgets.push({ project: svc.name, status });
		for (const [k, v] of Object.entries(
			await spendByAccount(svc.handle.db, spendSince),
		)) {
			const have = spend[k] ?? { usd: 0, tokens: 0 };
			spend[k] = { usd: have.usd + v.usd, tokens: have.tokens + v.tokens };
		}
	}

	// A live lease can name a run the active listing does not (it is starting,
	// or settling): find it in the registries so its chip knows its project.
	const known = new Set(runs.map((r) => r.runId));
	const leased = new Set<string>();
	for (const lease of hostModel.leases) {
		const id = lease.run?.runId;
		if (id && LEASE_LIVE.has(lease.state) && !known.has(id)) leased.add(id);
	}
	const leasedRuns: FleetRunInput[] = [];
	for (const id of leased) {
		for (const svc of projects) {
			const row = await svc.registry.get(id);
			if (!row) continue;
			leasedRuns.push(
				inputOf(
					svc.name,
					row,
					row.taskId
						? (svc.tasks.titles(new Set([row.taskId])).get(row.taskId) ?? null)
						: null,
				),
			);
			break;
		}
	}

	return buildFleetSummary({
		now,
		runs,
		leasedRuns,
		sshHosts: await source.hosts.list(),
		hostModel,
		hostHealthTrack: source.hostResources.observations?.healthTrack?.(),
		holds: await source.providerHolds.active(),
		budgets,
		spend,
		spendSince,
		runpod: await source.runpod.readModel(),
		openrouter: source.openrouter.readModel(),
	});
}
