/**
 * The pure half of the reroute and add-attempt dialogs: what the routing
 * catalogue offers (harnesses with their models, hosts) and what a form
 * state means as a request. Free text stays allowed for the model (the
 * catalogue list is a hint, never a gate: `settings.providers.catalogue`
 * says `allowsCustomModel`).
 */

export interface CatalogueProvider {
	id: string;
	name: string;
	drivable: boolean;
	installed: boolean;
	models: readonly { id: string; label: string }[];
	defaultModel: string;
}

export interface CatalogueHost {
	config: { id: string };
}

export interface HarnessChoice {
	id: string;
	name: string;
	models: readonly { id: string; label: string }[];
	defaultModel: string;
}

export interface HostChoice {
	/** `execution_target` syntax. */
	value: string;
	label: string;
}

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

/** Harnesses a run can actually be moved to: drivable and installed here. */
export function harnessChoices(
	providers: readonly CatalogueProvider[] | undefined,
): HarnessChoice[] {
	return (providers ?? [])
		.filter((p) => p.drivable && p.installed)
		.map((p) => ({
			id: p.id,
			name: p.name,
			models: p.models,
			defaultModel: p.defaultModel,
		}));
}

/** This machine first, then every registered SSH host. */
export function hostChoices(
	hosts: readonly CatalogueHost[] | undefined,
): HostChoice[] {
	return [
		{ value: "local", label: "This machine" },
		...(hosts ?? []).map((h) => ({
			value: `ssh:${h.config.id}`,
			label: h.config.id,
		})),
	];
}

export interface RouteForm {
	harness: string;
	model: string;
	effort: string;
	target: string;
}

export interface CurrentRoute {
	harness: string | null;
	model: string | null;
	/** The registry host the run is on, or null for this machine. */
	hostId: string | null;
}

export interface RoutePick {
	harness?: string;
	model?: string;
	effort?: Effort;
	target?: string;
}

/** The form's initial state: the run's own route, so only a change is sent. */
export function initialForm(current: CurrentRoute): RouteForm {
	return {
		harness: current.harness ?? "",
		model: current.model ?? "",
		effort: "",
		target: current.hostId ? `ssh:${current.hostId}` : "local",
	};
}

/**
 * What the form asks for. For a reroute (`requireChange`) only the fields
 * that differ from the current route are sent, and an untouched form is
 * refused with a reason. An added attempt sends what is filled in.
 */
export function buildPick(
	form: RouteForm,
	current: CurrentRoute,
	opts: { requireChange: boolean },
): { ok: true; pick: RoutePick } | { ok: false; reason: string } {
	const pick: RoutePick = {};
	const harness = form.harness.trim();
	const model = form.model.trim();
	const currentTarget = current.hostId ? `ssh:${current.hostId}` : "local";
	const changed = (v: string, cur: string | null) =>
		!opts.requireChange || v !== (cur ?? "");
	if (harness && changed(harness, current.harness)) pick.harness = harness;
	if (model && changed(model, current.model)) pick.model = model;
	if (form.effort && (EFFORTS as readonly string[]).includes(form.effort)) {
		pick.effort = form.effort as Effort;
	}
	if (form.target && changed(form.target, currentTarget)) {
		pick.target = form.target;
	}
	if (opts.requireChange && Object.keys(pick).length === 0) {
		return {
			ok: false,
			reason: "Pick another harness, model, effort or host to move the work.",
		};
	}
	return { ok: true, pick };
}
