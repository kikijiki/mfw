import type { RunReasoningEffort } from "@mfw/db/schema";
import type { ProviderConfig } from "./agents/adapter.ts";
import { findProvider, tierModel } from "./agents/catalogue.ts";
import type { HostCandidate } from "./host-registry.ts";
import type { ModelTier } from "./tasks/types.ts";

/**
 * The routing seam: which harness, model and effort a run gets, and why.
 *
 * `routeRun` is pure. The run engine calls it once per run at PREPARE with the
 * live project settings, the machine-wide provider holds and (optionally) the
 * outcome priors, persists the decision on the run row (`runs.routing`,
 * `provider_id`, `model`, `reasoning_effort`, `harness`, `model_vendor`) and
 * LAUNCH rebuilds the provider from that row, never from the project's
 * current settings. A settings change therefore applies to the next run and
 * never leaks into a prepared one.
 *
 * Precedence for a fresh run (first match wins):
 *
 *   1. explicit   the human's start options (UI "run with model …")
 *   2. task       the task's own `provider` / `model` fields
 *   3. project    the project tier map (`modelTiers[tier]`), then the project
 *                 `model` for the standard tier (or for no tier)
 *   4. catalogue  the provider catalogue's model for the tier
 *
 * A pinned route (explicit or task) is never swapped for a fallback: a held
 * pinned provider waits instead. A route the project chose falls back down
 * `routing.fallbacks[tier]` (else `routing.fallbacks.default`) when its
 * provider is held. Outcome priors only ever reorder that fallback list, and
 * only when every fallback has a usable prior: they never pick the primary.
 *
 * Continuations (repair, resume, answered resume, unblock) inherit their
 * parent's route; with `routing.escalateOnRepair` a repair from the second on
 * moves one tier up. Repairs are bounded by `maxRepairs`, so escalation is too.
 *
 * Placement (`placeRun`) decides WHERE a task run executes, before routing:
 *
 *   1. task      the task's `execution_target` (`ssh`, `ssh:<hostId>`, `runpod`)
 *   2. project   `routing.placement` (`{ target: "ssh", host?, labels? }`)
 *   3. default   the daemon machine (`local`)
 *
 * An SSH placement picks a schedulable registry host (fresh, passing probe)
 * whose labels include the requested ones and which has the run's harness
 * installed and logged in. `routeRun` then refuses a route whose harness the
 * placed host cannot run, and skips such fallbacks.
 */

export const ROUTE_RULES = [
	"explicit",
	"brain",
	"task",
	"project-tier",
	"project-model-standard",
	"project-model",
	"catalogue-tier",
	"provider-default",
	"inherited",
	"escalated",
	"fallback",
] as const;
export type RouteRule = (typeof ROUTE_RULES)[number];

export const ROUTE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * An OpenAI-compatible endpoint Codex can be pointed at (`wire_api =
 * "responses"`: Codex no longer speaks chat completions). Local llama.cpp,
 * Ollama, vLLM or OpenRouter. No key is stored here: `grant` names a workload
 * secret grant whose environment variable is `envKey`, so the key reaches the
 * agent only through the grant (redacted, per-run, revocable).
 */
export interface EndpointConfig {
	baseUrl: string;
	/** Env var Codex reads the bearer key from; requires `grant`. */
	envKey?: string;
	/** Workload secret grant id that supplies `envKey`. */
	grant?: string;
	/** Model used when a route names this endpoint without a model. */
	model?: string;
	/** Who serves the model, for outcome rows (`local`, `openrouter`, …). */
	vendor?: string;
}

/** A provider reference: a catalogue id (`claude-cli`, `codex-cli`) or an endpoint id (Codex via that endpoint). */
export interface RouteTarget {
	provider: string;
	model?: string;
	effort?: RunReasoningEffort;
}

/** Project default placement (`routing.placement`). */
export interface PlacementConfig {
	target: "local" | "ssh";
	/** A registry host id; absent = any matching host. */
	host?: string;
	/** Every label must be on the host. */
	labels?: string[];
}

export interface RoutingConfig {
	/** Where task runs execute when the task does not say (default: local). */
	placement?: PlacementConfig;
	endpoints?: Record<string, EndpointConfig>;
	/** Ordered alternatives per tier (`default` for untiered or unlisted tiers). */
	fallbacks?: Partial<Record<ModelTier | "default", RouteTarget[]>>;
	/** Repair n >= 2 routes one tier up (light → standard → strong). */
	escalateOnRepair?: boolean;
}

/** The live project values routing reads. */
export interface RoutingSettings {
	provider: ProviderConfig;
	model: string;
	modelTiers?: Partial<Record<ModelTier, string>>;
	reasoningEffort?: RunReasoningEffort;
	routing?: RoutingConfig | null;
}

/** An endpoint as persisted on the run (no secret values, ever). */
export interface ResolvedEndpoint {
	id: string;
	baseUrl: string;
	envKey?: string;
	grant?: string;
	model?: string;
	vendor?: string;
}

export interface ProviderHold {
	until: number;
	reason: string;
}

export interface RoutePrior {
	n: number;
	firstPassRate: number | null;
	usable: boolean;
}

export interface RouteCandidate {
	provider: string;
	endpoint: string | null;
	model: string;
	effort: RunReasoningEffort;
	holdKey: string;
	held: ProviderHold | null;
	prior?: RoutePrior;
}

export interface RoutingDecision {
	/** Harness (catalogue id) that drives the run. */
	provider: string;
	endpoint: ResolvedEndpoint | null;
	model: string;
	effort: RunReasoningEffort;
	tier: ModelTier | null;
	/** Execution target kind (`local`, `runpod`, `ssh`, …). */
	target: string;
	/** Registry host the run executes on (`ssh` target only). */
	hostId?: string | null;
	/** Which rule picked this route. */
	reason: RouteRule;
	/** One sentence for the run page. */
	detail: string;
	/** Everything considered, primary first, in the order tried. */
	candidates: RouteCandidate[];
	/** Key of the provider hold this run is subject to. */
	holdKey: string;
	/** Set when the chosen route is held: dispatch must wait. */
	held: (ProviderHold & { key: string }) | null;
	/** True when explicit or task fields pinned the route (no fallback). */
	pinned: boolean;
	escalatedFrom?: string;
}

export interface RouteInput {
	kind: "task" | "repair" | "resume" | "plan" | "import" | "action";
	explicit?: { provider?: string; model?: string; effort?: RunReasoningEffort };
	task?: {
		provider: string | null;
		model: string | null;
		modelTier: ModelTier | null;
	} | null;
	/** The parent run's route, for continuations. */
	parent?: Pick<
		RoutingDecision,
		"provider" | "endpoint" | "model" | "effort" | "tier"
	> & { reason?: RouteRule; pinned?: boolean };
	/** Repair ordinal of the run being routed (1 = first repair). */
	repairOrdinal?: number;
	/**
	 * The project brain's pick (a `spawn`'s harness/model/effort). It ranks
	 * below a human pin (task `provider`/`model`, explicit start options) and
	 * above the project's defaults; `overrideHumanPin` is the brain's audited
	 * flag to rank above them. Unlike an explicit pick it is still subject to
	 * provider holds and has no fallbacks.
	 */
	brain?: {
		provider?: string;
		model?: string;
		effort?: RunReasoningEffort;
		overrideHumanPin?: boolean;
	};
	settings: RoutingSettings;
	target?: string;
	/** Where the run was placed; its harness list gates the route. */
	placement?: Pick<PlacementDecision, "target" | "hostId" | "harnesses">;
	held?: (key: string) => ProviderHold | null;
	/** A human start: overrides queue policy, so holds do not apply. */
	ignoreHolds?: boolean;
	prior?: (candidate: {
		harness: string;
		model: string;
		tier?: ModelTier | null;
	}) => RoutePrior;
}

export class RoutingError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RoutingError";
	}
}

const TIER_UP: Record<ModelTier, ModelTier> = {
	light: "standard",
	standard: "strong",
	strong: "strong",
};

export function holdKeyOf(provider: string, endpoint?: string | null): string {
	return endpoint ? `${provider}@${endpoint}` : provider;
}

/**
 * A provider reference to `{harness, endpoint}`. Unknown or non-drivable
 * references throw a `RoutingError` with the fix, so a typo in a task's
 * `provider` refuses early instead of starting a run that cannot launch.
 */
export function resolveProviderRef(
	ref: string,
	routing: RoutingConfig | null | undefined,
): { provider: string; endpoint: ResolvedEndpoint | null } {
	const endpoint = routing?.endpoints?.[ref];
	if (endpoint) {
		return { provider: "codex-cli", endpoint: { id: ref, ...endpoint } };
	}
	const entry = findProvider(ref);
	if (!entry?.drivable) {
		const endpoints = Object.keys(routing?.endpoints ?? {});
		throw new RoutingError(
			`provider '${ref}' is not something mfw can run: use claude-cli, codex-cli${
				endpoints.length ? `, or an endpoint (${endpoints.join(", ")})` : ""
			}, or add '${ref}' under the project's routing endpoints`,
		);
	}
	return { provider: entry.id, endpoint: null };
}

function projectPrimary(settings: RoutingSettings): {
	provider: string;
	endpoint: ResolvedEndpoint | null;
} {
	const id = settings.provider.endpoint?.id;
	if (id) return resolveProviderRef(id, settings.routing);
	return { provider: settings.provider.id, endpoint: null };
}

function sameRoute(
	a: { provider: string; endpoint: ResolvedEndpoint | null },
	b: { provider: string; endpoint: ResolvedEndpoint | null },
): boolean {
	return a.provider === b.provider && a.endpoint?.id === b.endpoint?.id;
}

/** A model for `tier` (or the provider default) on a route that is not the project's own. */
function foreignModel(
	route: { provider: string; endpoint: ResolvedEndpoint | null },
	tier: ModelTier | null,
	routing: RoutingConfig | null | undefined,
): { model: string; rule: RouteRule } | null {
	if (route.endpoint) {
		const model = routing?.endpoints?.[route.endpoint.id]?.model;
		return model ? { model, rule: "provider-default" } : null;
	}
	if (tier) {
		const model = tierModel(route.provider, tier);
		if (model) return { model, rule: "catalogue-tier" };
	}
	const fallback = findProvider(route.provider)?.defaultModel;
	return fallback ? { model: fallback, rule: "provider-default" } : null;
}

/** The project's own model for a tier on its primary route. */
function projectModel(
	settings: RoutingSettings,
	route: { provider: string; endpoint: ResolvedEndpoint | null },
	tier: ModelTier | null,
): { model: string; rule: RouteRule } {
	if (tier) {
		const override = settings.modelTiers?.[tier];
		if (override) return { model: override, rule: "project-tier" };
		if (tier === "standard")
			return { model: settings.model, rule: "project-model-standard" };
		if (!route.endpoint) {
			const catalogue = tierModel(route.provider, tier);
			if (catalogue) return { model: catalogue, rule: "catalogue-tier" };
		}
	}
	return { model: settings.model, rule: "project-model" };
}

function candidateOf(
	route: { provider: string; endpoint: ResolvedEndpoint | null },
	model: string,
	effort: RunReasoningEffort,
	held: RouteInput["held"],
): RouteCandidate {
	const holdKey = holdKeyOf(route.provider, route.endpoint?.id);
	return {
		provider: route.provider,
		endpoint: route.endpoint?.id ?? null,
		model,
		effort,
		holdKey,
		held: held?.(holdKey) ?? null,
	};
}

/** Pure routing decision; see the module comment for the precedence. */
export function routeRun(input: RouteInput): RoutingDecision {
	const decision = routeOn(input);
	const hostId = input.placement?.hostId ?? null;
	if (!hostId) return decision;
	return {
		...decision,
		hostId,
		detail: `${decision.detail}, on host ${hostId}`,
	};
}

function onHost(input: RouteInput, provider: string): boolean {
	const harnesses = input.placement?.harnesses;
	return !harnesses || harnesses.includes(provider);
}

function refuseOffHost(input: RouteInput, provider: string): void {
	if (onHost(input, provider)) return;
	const harnesses = input.placement?.harnesses ?? [];
	throw new RoutingError(
		`host '${input.placement?.hostId}' cannot run ${provider}: it has ${
			harnesses.length ? harnesses.join(", ") : "no logged-in harness"
		}; log in to ${provider} on the box as its user, or place the task on another host`,
	);
}

/** Apply the brain's pick per the human-pin precedence (design I14). */
function withBrainPick(input: RouteInput): {
	input: RouteInput;
	viaBrain: boolean;
} {
	const pick = input.brain;
	if (!pick || !(pick.provider || pick.model || pick.effort)) {
		return { input, viaBrain: false };
	}
	const humanPinned = !!(
		input.explicit?.provider ||
		input.explicit?.model ||
		input.task?.provider ||
		input.task?.model
	);
	if (humanPinned && pick.overrideHumanPin !== true) {
		return { input, viaBrain: false };
	}
	return {
		viaBrain: !!(pick.provider || pick.model),
		input: {
			...input,
			explicit: {
				...(pick.provider ? { provider: pick.provider } : {}),
				...(pick.model ? { model: pick.model } : {}),
				...((pick.effort ?? input.explicit?.effort)
					? { effort: (pick.effort ?? input.explicit?.effort) as never }
					: {}),
			},
			task: input.task
				? { ...input.task, provider: null, model: null }
				: input.task,
		},
	};
}

function routeOn(original: RouteInput): RoutingDecision {
	const { input, viaBrain } = withBrainPick(original);
	const { settings } = input;
	const target = input.placement?.target ?? input.target ?? "local";
	const baseEffort =
		input.explicit?.effort ?? settings.reasoningEffort ?? "medium";
	const primary = projectPrimary(settings);

	// Continuations (repair, resume, answered resume, unblock) route as
	// "repair"/"resume" with their parent; task and plan runs are always fresh.
	if (input.parent && (input.kind === "repair" || input.kind === "resume")) {
		const inherited = inherit(input, target);
		refuseOffHost(input, inherited.provider);
		return inherited;
	}

	const tier = input.task?.modelTier ?? null;
	const pinnedRef = input.explicit?.provider ?? input.task?.provider ?? null;
	const pinnedModel = input.explicit?.model ?? input.task?.model ?? null;
	const route = pinnedRef
		? resolveProviderRef(pinnedRef, settings.routing)
		: primary;
	const onPrimary = sameRoute(route, primary);

	let model: string;
	let rule: RouteRule;
	if (input.explicit?.model) {
		model = input.explicit.model;
		rule = "explicit";
	} else if (input.task?.model) {
		model = input.task.model;
		rule = "task";
	} else if (onPrimary) {
		({ model, rule } = projectModel(settings, route, tier));
	} else {
		const picked = foreignModel(route, tier, settings.routing);
		if (!picked) {
			throw new RoutingError(
				`provider '${pinnedRef}' has no model for this run: set the task's model, or give endpoint '${route.endpoint?.id}' a default model`,
			);
		}
		({ model, rule } = picked);
	}
	if (input.explicit?.provider) rule = "explicit";
	else if (input.task?.provider && rule !== "explicit") rule = "task";
	if (viaBrain && rule === "explicit") rule = "brain";

	const pinned = pinnedRef !== null || pinnedModel !== null;
	const first = candidateOf(route, model, baseEffort, input.held);
	const fallbacks = pinned
		? []
		: orderFallbacks(
				(
					settings.routing?.fallbacks?.[tier ?? "default"] ??
					settings.routing?.fallbacks?.default ??
					[]
				).flatMap((t) => {
					const r = resolveProviderRef(t.provider, settings.routing);
					const m =
						t.model ??
						(sameRoute(r, primary)
							? projectModel(settings, r, tier).model
							: foreignModel(r, tier, settings.routing)?.model);
					if (!m) return [];
					const c = candidateOf(r, m, t.effort ?? baseEffort, input.held);
					if (c.holdKey === first.holdKey && c.model === first.model) return [];
					return [c];
				}),
				tier,
				input.prior,
			);
	const candidates = [first, ...fallbacks];
	// A brain pick is pinned (no fallbacks) but is not exempt from holds.
	const explicitRun =
		input.ignoreHolds === true ||
		(input.explicit !== undefined && pinned && !viaBrain);
	const chosen = explicitRun
		? first
		: (candidates.find((c) => c.held === null && onHost(input, c.provider)) ??
			candidates.find((c) => onHost(input, c.provider)) ??
			first);
	refuseOffHost(input, chosen.provider);
	const fellBack = chosen !== first;
	const chosenRoute =
		chosen === first
			? route
			: resolveProviderRef(
					chosen.endpoint ?? chosen.provider,
					settings.routing,
				);
	const held =
		!explicitRun && chosen.held
			? { key: chosen.holdKey, ...chosen.held }
			: null;
	return {
		provider: chosenRoute.provider,
		endpoint: chosenRoute.endpoint,
		model: chosen.model,
		effort: chosen.effort,
		tier,
		target,
		reason: fellBack ? "fallback" : rule,
		detail: fellBack
			? `${first.holdKey} is held (${first.held?.reason ?? "rate limited"}), so fell back to ${chosen.holdKey} ${chosen.model}`
			: describe(rule, chosen, tier, held),
		candidates,
		holdKey: chosen.holdKey,
		held,
		pinned,
	};
}

/** Priors reorder fallbacks only when every fallback has a usable prior. */
function orderFallbacks(
	fallbacks: RouteCandidate[],
	tier: ModelTier | null,
	prior: RouteInput["prior"],
): RouteCandidate[] {
	if (!prior || fallbacks.length < 2) return fallbacks;
	const withPrior = fallbacks.map((c) => ({
		...c,
		prior: prior({ harness: c.provider, model: c.model, tier }),
	}));
	if (!withPrior.every((c) => c.prior.usable)) return withPrior;
	return [...withPrior].sort(
		(a, b) => (b.prior.firstPassRate ?? 0) - (a.prior.firstPassRate ?? 0),
	);
}

function inherit(input: RouteInput, target: string): RoutingDecision {
	const parent = input.parent as NonNullable<RouteInput["parent"]>;
	const { settings } = input;
	let model = parent.model;
	let tier = parent.tier;
	let reason: RouteRule = "inherited";
	let escalatedFrom: string | undefined;
	if (
		input.kind === "repair" &&
		settings.routing?.escalateOnRepair &&
		(input.repairOrdinal ?? 0) >= 2 &&
		tier &&
		tier !== "strong" &&
		parent.reason !== "explicit" &&
		parent.reason !== "task"
	) {
		const up = TIER_UP[tier];
		const route = { provider: parent.provider, endpoint: parent.endpoint };
		const next = sameRoute(route, projectPrimary(settings))
			? projectModel(settings, route, up).model
			: foreignModel(route, up, settings.routing)?.model;
		if (next && next !== model) {
			escalatedFrom = model;
			model = next;
			tier = up;
			reason = "escalated";
		}
	}
	const holdKey = holdKeyOf(parent.provider, parent.endpoint?.id);
	const candidate: RouteCandidate = {
		provider: parent.provider,
		endpoint: parent.endpoint?.id ?? null,
		model,
		effort: parent.effort,
		holdKey,
		held: null,
	};
	return {
		provider: parent.provider,
		endpoint: parent.endpoint,
		model,
		effort: parent.effort,
		tier,
		target,
		reason,
		detail:
			reason === "escalated"
				? `repair ${input.repairOrdinal} escalated from ${escalatedFrom} to the ${tier} tier (${model})`
				: `continues its parent run on ${holdKey} ${model}`,
		candidates: [candidate],
		holdKey,
		// A continuation finishes the attempt it belongs to; holds gate new work.
		held: null,
		pinned: parent.pinned ?? false,
		...(escalatedFrom ? { escalatedFrom } : {}),
	};
}

function describe(
	rule: RouteRule,
	c: RouteCandidate,
	tier: ModelTier | null,
	held: { key: string; reason: string } | null,
): string {
	const on = `${c.holdKey} ${c.model}`;
	const why: Record<RouteRule, string> = {
		explicit: `started with ${on} by hand`,
		brain: `the project brain chose ${on}`,
		task: `the task asks for ${on}`,
		"project-tier": `the project maps the ${tier} tier to ${on}`,
		"project-model-standard": `the standard tier uses the project model (${on})`,
		"project-model": `the project default (${on})`,
		"catalogue-tier": `the catalogue's ${tier} tier model (${on})`,
		"provider-default": `the provider's default model (${on})`,
		inherited: `continues its parent run on ${on}`,
		escalated: `escalated to ${on}`,
		fallback: `fell back to ${on}`,
	};
	return held ? `${why[rule]}; held: ${held.reason}` : why[rule];
}

export type PlacementRule = "task" | "project" | "default";

export interface PlacementDecision {
	/** Execution target kind. */
	target: string;
	hostId: string | null;
	/** Harnesses the placed host can run; null = not host-constrained. */
	harnesses: string[] | null;
	rule: PlacementRule;
	detail: string;
}

/** Parse a task's `execution_target`: `ssh` or `ssh:<hostId>` select SSH. */
export function parseExecutionTarget(value: string): {
	target: string;
	host: string | null;
} {
	const match = /^ssh(?::(.+))?$/.exec(value.trim());
	if (match) return { target: "ssh", host: match[1] ?? null };
	return { target: value.trim(), host: null };
}

/**
 * Where a task run executes; pure (see the module comment for precedence).
 * `free` orders matching hosts (most free slots first, then id) so a busy
 * host does not hold a task another host could start now; when every
 * matching host is full the choice is stable, so the waiter keeps its FIFO
 * place on that host's `remote.<id>.slots`.
 */
export function placeRun(input: {
	/** The task's `execution_target`; `local` (the default) defers to the project. */
	taskTarget: string | null;
	placement?: PlacementConfig | null;
	hosts: readonly HostCandidate[];
	/** Harness the run would route to (task pin, else project provider). */
	harness: string;
	free?: (hostId: string) => number;
}): PlacementDecision {
	const task = input.taskTarget ? parseExecutionTarget(input.taskTarget) : null;
	if (task && task.target !== "local" && task.target !== "ssh") {
		return {
			target: task.target,
			hostId: null,
			harnesses: null,
			rule: "task",
			detail: `the task runs on ${task.target}`,
		};
	}
	const projectSsh = input.placement?.target === "ssh" ? input.placement : null;
	let rule: PlacementRule;
	let host: string | null;
	let labels: readonly string[];
	if (task?.target === "ssh") {
		rule = "task";
		host = task.host;
		labels = task.host ? [] : (projectSsh?.labels ?? []);
	} else if (projectSsh) {
		rule = "project";
		host = projectSsh.host ?? null;
		labels = projectSsh.labels ?? [];
	} else {
		return {
			target: "local",
			hostId: null,
			harnesses: null,
			rule: "default",
			detail: "runs on the daemon machine",
		};
	}
	const who = rule === "task" ? "the task" : "the project";
	if (host) {
		const pinned = input.hosts.find((h) => h.id === host);
		if (!pinned)
			throw new RoutingError(
				`${who} places runs on SSH host '${host}', which is not registered: add it on the Resources page, or change the placement`,
			);
		if (!pinned.schedulable)
			throw new RoutingError(
				`SSH host '${host}' ${pinned.reason ?? "is not schedulable"}`,
			);
		if (!pinned.harnesses.includes(input.harness))
			throw new RoutingError(
				`SSH host '${host}' cannot run ${input.harness}: log in to it on the box as the host user, then probe the host`,
			);
		return placedOn(pinned, rule, `${who} pins host ${host}`);
	}
	const matching = input.hosts.filter((h) =>
		labels.every((label) => h.labels.includes(label)),
	);
	const usable = matching
		.filter((h) => h.schedulable && h.harnesses.includes(input.harness))
		.sort(
			(a, b) =>
				(input.free?.(b.id) ?? 0) - (input.free?.(a.id) ?? 0) ||
				a.id.localeCompare(b.id),
		);
	const chosen = usable[0];
	if (!chosen) {
		const want = labels.length ? ` labelled ${labels.join(", ")}` : "";
		const why = matching.length
			? matching
					.map((h) =>
						h.schedulable
							? `${h.id} has no logged-in ${input.harness}`
							: `${h.id} ${h.reason}`,
					)
					.join("; ")
			: "none is registered";
		throw new RoutingError(
			`${who} places runs on an SSH host${want} that can run ${input.harness}, but ${why}`,
		);
	}
	return placedOn(
		chosen,
		rule,
		`${who} places runs on SSH${labels.length ? ` (${labels.join(", ")})` : ""}; picked ${chosen.id}`,
	);
}

function placedOn(
	host: HostCandidate,
	rule: PlacementRule,
	detail: string,
): PlacementDecision {
	return {
		target: "ssh",
		hostId: host.id,
		harnesses: [...host.harnesses],
		rule,
		detail,
	};
}

/** The harness a fresh run of `task` routes to, before holds and fallbacks. */
export function primaryHarness(
	task: { provider?: string | null } | null,
	settings: RoutingSettings,
): string {
	if (task?.provider)
		return resolveProviderRef(task.provider, settings.routing).provider;
	return projectPrimary(settings).provider;
}

/** What the run engine routes with: live settings, machine-wide holds, priors. */
export interface RouterDeps {
	settings: () => RoutingSettings;
	holds?: { snapshot(): Promise<(key: string) => ProviderHold | null> };
	priors?: () => Promise<RouteInput["prior"] | undefined>;
}

/**
 * Route one run against the live settings and a fresh holds snapshot. The
 * one async entry point, shared by the engine (at prepare) and the
 * scheduler (to skip a task whose route is held before trying to start it).
 */
export async function routeWith(
	deps: RouterDeps,
	input: Omit<RouteInput, "settings" | "held" | "prior">,
): Promise<RoutingDecision> {
	const settings = deps.settings();
	const held = deps.holds ? await deps.holds.snapshot() : undefined;
	const needsPriors =
		!input.parent &&
		Object.values(settings.routing?.fallbacks ?? {}).some(
			(list) => (list?.length ?? 0) > 1,
		);
	const prior = needsPriors && deps.priors ? await deps.priors() : undefined;
	return routeRun({
		...input,
		settings,
		...(held ? { held } : {}),
		...(prior ? { prior } : {}),
	});
}

/** A stored project provider (`config.json`): catalogue id, env, endpoint by id. */
export interface StoredProviderRef {
	id: string;
	type?: ProviderConfig["type"];
	env?: Record<string, string>;
	endpoint?: string;
}

/**
 * Runtime routing settings from stored project values. Throws a
 * `RoutingError` when the provider names an endpoint the routing config does
 * not define, or an endpoint on a harness other than Codex.
 */
export function routingSettingsFrom(input: {
	provider: ProviderConfig | StoredProviderRef;
	model: string;
	modelTiers?: Partial<Record<ModelTier, string>> | null;
	reasoningEffort?: RunReasoningEffort;
	routing?: RoutingConfig | null;
}): RoutingSettings {
	const { provider } = input;
	const endpointRef =
		typeof provider.endpoint === "string"
			? provider.endpoint
			: provider.endpoint?.id;
	let endpoint: ProviderConfig["endpoint"];
	if (endpointRef) {
		const e = input.routing?.endpoints?.[endpointRef];
		if (!e)
			throw new RoutingError(
				`provider endpoint '${endpointRef}' is not defined under routing endpoints`,
			);
		if (provider.id !== "codex-cli")
			throw new RoutingError(
				`only codex-cli can use an OpenAI-compatible endpoint (provider is '${provider.id}')`,
			);
		endpoint = {
			id: endpointRef,
			baseUrl: e.baseUrl,
			...(e.envKey ? { envKey: e.envKey } : {}),
		};
	}
	const entry = findProvider(provider.id);
	return {
		provider: {
			id: provider.id,
			type: entry?.configType ?? provider.type ?? "custom",
			...(provider.env ? { env: provider.env } : {}),
			...(endpoint ? { endpoint } : {}),
		},
		model: input.model,
		...(input.modelTiers ? { modelTiers: input.modelTiers } : {}),
		...(input.reasoningEffort
			? { reasoningEffort: input.reasoningEffort }
			: {}),
		routing: input.routing ?? null,
	};
}

/**
 * The provider a prepared run launches with: its persisted harness and
 * endpoint, plus the harness's machine env from the live settings (env is
 * harness configuration, never routing). Never the project's current
 * provider: that is the §0.7 leak this replaces.
 */
export function providerForRun(
	run: { providerId: string | null; routing: Record<string, unknown> | null },
	live: RoutingSettings,
): ProviderConfig {
	const decision = parseRoutingRecord(run.routing);
	const id = decision?.provider ?? run.providerId ?? live.provider.id;
	const entry = findProvider(id);
	const env = live.provider.id === id ? live.provider.env : undefined;
	const endpoint = decision?.endpoint
		? {
				id: decision.endpoint.id,
				baseUrl: decision.endpoint.baseUrl,
				...(decision.endpoint.envKey
					? { envKey: decision.endpoint.envKey }
					: {}),
			}
		: undefined;
	return {
		id,
		type: entry?.configType ?? "custom",
		...(env ? { env } : {}),
		...(endpoint ? { endpoint } : {}),
	};
}

/** The persisted shape of a decision (`runs.routing`). */
export function routingRecord(d: RoutingDecision): Record<string, unknown> {
	return JSON.parse(JSON.stringify(d)) as Record<string, unknown>;
}

/** Read a persisted decision back; null for a pre-routing row. */
export function parseRoutingRecord(
	value: Record<string, unknown> | null | undefined,
): RoutingDecision | null {
	if (!value || typeof value.provider !== "string") return null;
	if (typeof value.model !== "string") return null;
	return value as unknown as RoutingDecision;
}

/** Who serves the model of a route, for outcome rows. */
export function routeVendor(d: Pick<RoutingDecision, "provider" | "endpoint">) {
	if (d.endpoint) return d.endpoint.vendor ?? "openai-compatible";
	if (d.provider === "claude-cli") return "anthropic";
	if (d.provider === "codex-cli") return "openai";
	return null;
}

/** Validate a routing config before it is stored: every reference must resolve. */
export function validateRoutingConfig(routing: RoutingConfig): void {
	for (const [id, endpoint] of Object.entries(routing.endpoints ?? {})) {
		if (!ROUTE_ID_PATTERN.test(id))
			throw new RoutingError(
				`endpoint id '${id}' may only use letters, digits, '_' and '-'`,
			);
		if (findProvider(id))
			throw new RoutingError(
				`endpoint id '${id}' collides with a catalogue provider id; pick another name`,
			);
		let url: URL;
		try {
			url = new URL(endpoint.baseUrl);
		} catch {
			throw new RoutingError(
				`endpoint '${id}' baseUrl '${endpoint.baseUrl}' is not a URL`,
			);
		}
		if (url.protocol !== "http:" && url.protocol !== "https:")
			throw new RoutingError(`endpoint '${id}' baseUrl must be http(s)`);
		if (url.username || url.password)
			throw new RoutingError(
				`endpoint '${id}' baseUrl must not carry credentials: use envKey + grant`,
			);
		if (endpoint.envKey && !endpoint.grant)
			throw new RoutingError(
				`endpoint '${id}' names envKey '${endpoint.envKey}' but no grant: keys reach agents only through a workload secret grant`,
			);
		if (endpoint.grant && !endpoint.envKey)
			throw new RoutingError(
				`endpoint '${id}' names grant '${endpoint.grant}' but no envKey for Codex to read it from`,
			);
	}
	for (const list of Object.values(routing.fallbacks ?? {})) {
		for (const target of list ?? []) {
			const route = resolveProviderRef(target.provider, routing);
			if (route.endpoint && !target.model && !route.endpoint.model) {
				throw new RoutingError(
					`fallback '${target.provider}' needs a model (or give the endpoint a default model)`,
				);
			}
		}
	}
}
