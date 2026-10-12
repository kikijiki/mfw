/**
 * Dispatch status wording. Pure and dependency free (no React, no tRPC types) so
 * it is testable alone. Shapes structurally mirror `SchedulerStatus` /
 * `FleetDispatch` in `@mfw/daemon`.
 */

export type DispatchState =
	| "dispatching"
	| "stopped"
	| "stopped_global"
	| "held"
	| "main_red"
	| "board_suspended";

export interface DispatchStatusLike {
	/** The EFFECTIVE answer: this project's switch AND the master stop. */
	playing: boolean;
	/** This project's OWN switch (what the per-project button toggles); unchanged while the master stop is off. */
	projectPlaying: boolean;
	/** The machine-wide master switch. */
	globalPlaying: boolean;
	running: boolean;
	enabled: boolean;
	state: DispatchState;
	/**
	 * Set when no switch can start work: the project has no brain route
	 * (`brain.routes`), so nothing decides what runs. Reported with state
	 * `held`; this field is what names it.
	 */
	blocked?: "no_brain_route" | null;
	reason: string | null;
	/** The engine stopped itself; pressing play will not clear it. */
	selfStopped: boolean;
	hold: { until: number; reason: string } | null;
	recovery?: {
		incidentId: string | null;
		causeTaskId: string | null;
		repairRunId: string | null;
		phase: string;
	} | null;
}

export type Tone = "neutral" | "accent" | "ok" | "warn" | "critical" | "info";

/** The one sentence for a project with no brain route; the UI links it to project settings. */
export const NO_BRAIN_HINT =
	"Brain not configured \u2014 set brain.routes in project settings";

/** The two-or-three word chip. */
export function dispatchLabel(status: DispatchStatusLike): string {
	if (status.blocked === "no_brain_route") return "Brain not configured";
	switch (status.state) {
		case "dispatching":
			return "Dispatching";
		case "stopped":
			return "Stopped";
		case "stopped_global":
			return "mfw stopped";
		case "held":
			return "Rate-limited";
		case "main_red":
			return status.recovery?.repairRunId ? "Recovering main" : "Main is red";
		case "board_suspended":
			return "Board suspended";
	}
}

/** Manual stops are neutral; a hold or red main is the engine refusing to spend, which play cannot fix. */
export function dispatchTone(status: DispatchStatusLike): Tone {
	if (status.blocked === "no_brain_route") return "warn";
	switch (status.state) {
		case "dispatching":
			return "ok";
		case "stopped":
			return "neutral";
		case "stopped_global":
			return "warn";
		case "held":
			return "warn";
		case "main_red":
			return "critical";
		case "board_suspended":
			return "critical";
	}
}

/** The full sentence. Every non-dispatching state says WHO stopped it: play does nothing against a hold, and a manual stop never clears itself. */
export function dispatchExplain(status: DispatchStatusLike): string {
	if (status.blocked === "no_brain_route") {
		return `${NO_BRAIN_HINT}. Nothing starts until a brain route is configured; there is no headless fallback.`;
	}
	const because = status.reason ? `: ${status.reason}` : "";
	switch (status.state) {
		case "dispatching":
			return "Dispatching: the brain chooses safe waves from dependency-ready work; the configured maximum and resource locks remain hard limits.";
		case "stopped":
			return `You stopped this project${because}. Nothing new starts until you press play.`;
		case "stopped_global":
			return `This project is switched ON, but mfw is stopped everywhere${because}. It starts dispatching as soon as you start mfw. The project's own play button will not do it.`;
		case "held":
			return `Playing, but mfw is holding dispatch itself${because}. It resumes on its own when the hold expires.`;
		case "main_red":
			return status.recovery?.repairRunId
				? `Playing, but ordinary work is held${because}. The recovery run is ${status.recovery.phase.replaceAll("_", " ")}; its verified merge is allowed through the breaker, then main is checked immediately.`
				: `Playing, but mfw stopped itself${because}: nothing new starts while the integration branch is broken. It resumes when main goes green.`;
		case "board_suspended":
			return `Playing, but mfw stopped itself${because}: it does not trust the board on disk. It resumes once the board reloads cleanly.`;
	}
}

/** Reads `projectPlaying`, NOT `playing`: the button owns only this project's switch, so a switched-on project must offer STOP even while the master stop is off. */
export function dispatchAction(status: DispatchStatusLike): "play" | "stop" {
	return status.projectPlaying ? "stop" : "play";
}

// The fleet

export type FleetSummary = "empty" | "none" | "some" | "all";

export interface FleetLike {
	/** Projects individually switched on; independent of the master switch. */
	playing: number;
	total: number;
	summary: FleetSummary;
	/** The master switch. False stops all dispatch regardless of per-project switches. */
	globalPlaying: boolean;
	projects: {
		project: string;
		status?: { projectPlaying: boolean } | null;
		error: string | null;
	}[];
}

/** Carries two facts: whether mfw runs at all, and how many projects are armed (they start the moment the master goes on). */
export function fleetLabel(fleet: FleetLike): string {
	if (fleet.total === 0) return "No projects";
	const armed = `${fleet.playing}/${fleet.total}`;
	if (!fleet.globalPlaying) return `mfw stopped (${armed} armed)`;
	switch (fleet.summary) {
		case "empty":
			return "No projects";
		case "none":
			return `Running (0/${fleet.total} playing)`;
		case "all":
			return `Running (${armed} playing)`;
		case "some":
			return `Running (${armed} playing)`;
	}
}

export function fleetTone(fleet: FleetLike): Tone {
	if (fleetFailures(fleet).length > 0) return "warn";
	if (fleet.total === 0) return "neutral";
	// Master off overrides every project.
	if (!fleet.globalPlaying) return "warn";
	return fleet.playing === 0 ? "neutral" : "ok";
}

/** One toggle: the master stop is a single boolean ANDed with each project's switch, not a batch. */
export function globalAction(fleet: FleetLike): "play" | "stop" {
	return fleet.globalPlaying ? "stop" : "play";
}

/** Projects whose status could not be read, so a partial view is visible. */
export function fleetFailures(fleet: FleetLike): string[] {
	return fleet.projects.filter((p) => p.error !== null).map((p) => p.project);
}

/** Starting is blocked while any project is unreadable (it could start spending); stopping is always safe. */
export function canStartFleet(fleet: FleetLike): boolean {
	return fleetFailures(fleet).length === 0;
}
