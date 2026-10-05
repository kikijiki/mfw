import type { SchedulerStatus } from "./scheduler.ts";

/**
 * Dispatch control: what "play" and "stop" mean.
 *
 * A project has two independent switches:
 *   1. `Scheduler.start()`/`stop()`: whether the dispatch loop exists. In
 *      memory; decided at boot by `schedulerAutostart` (default false, so
 *      attaching a repo never spends a subscription on its own).
 *   2. `Scheduler.setEnabled()`: a durable pause flag in `engine_kv`. Does not
 *      start or stop the loop.
 * Either alone makes a play button lie, so the per-project control moves both
 * and persists `schedulerAutostart` to config.json so a restart resumes.
 *
 * The master stop is a third switch: one machine-wide value (`dispatchPaused`
 * in config.json), ANDed with each project's own. It is not a batch over
 * projects, which would overwrite per-project settings and could not be undone.
 *
 * Order is safe in both directions: turning on clears the gate before starting
 * the loop; turning off stops the loop before setting the gate. A failure
 * halfway leaves the project stopped.
 */

/** The scheduler slice dispatch control is allowed to touch. */
export interface DispatchScheduler {
	readonly running: boolean;
	setEnabled(on: boolean, reason?: string): Promise<void>;
	status(): Promise<SchedulerStatus>;
}

/** The settings slice. `update` persists to config.json AND starts/stops the loop, keeping daemon and file in agreement. */
export interface DispatchSettings {
	update(patch: { schedulerAutostart: boolean }): Promise<unknown>;
}

/** Structurally satisfied by `ProjectServices`. */
export interface DispatchTarget {
	name: string;
	scheduler: DispatchScheduler;
	settings: DispatchSettings;
}

export const DEFAULT_STOP_REASON = "stopped from the UI";

/**
 * Serializes `setDispatching` per target (double-click, two tabs). The settings
 * queue does not cover `scheduler.setEnabled`, so overlapping calls could
 * interleave their second halves and leave `schedulerAutostart` and the pause
 * flag disagreeing. Queuing the whole function closes that.
 */
const dispatchTails = new WeakMap<DispatchTarget, Promise<unknown>>();

/** Start or stop dispatching for one project, durably. Returns the status after the change (a hold or red main may still block). */
export function setDispatching(
	target: DispatchTarget,
	on: boolean,
	reason = DEFAULT_STOP_REASON,
): Promise<SchedulerStatus> {
	const preceding = dispatchTails.get(target) ?? Promise.resolve();
	const result = preceding
		.catch(() => {})
		.then(() => applyDispatching(target, on, reason));
	// Settle-only tail: a failed call must not jam the queue for the next one.
	dispatchTails.set(
		target,
		result.then(
			() => {},
			() => {},
		),
	);
	return result;
}

async function applyDispatching(
	target: DispatchTarget,
	on: boolean,
	reason: string,
): Promise<SchedulerStatus> {
	if (on) {
		await target.scheduler.setEnabled(true);
		await target.settings.update({ schedulerAutostart: true });
	} else {
		await target.settings.update({ schedulerAutostart: false });
		await target.scheduler.setEnabled(false, reason);
	}
	return target.scheduler.status();
}

/** One project's line in the fleet view. `status` is null only when reading it threw (see `error`). */
export interface ProjectDispatch {
	project: string;
	status: SchedulerStatus | null;
	error: string | null;
}

/** `some` is a real state: one of three playing is neither `all` nor `none`. */
export type FleetSummary = "empty" | "none" | "some" | "all";

export interface FleetDispatch {
	projects: ProjectDispatch[];
	/** Projects individually switched on, out of readable ones. Independent of the master stop. */
	playing: number;
	total: number;
	summary: FleetSummary;
	/** The master switch. When false nothing dispatches; `summary` still reports per-project settings. */
	globalPlaying: boolean;
}

/**
 * Tri-state over each project's own switch (`projectPlaying`), not `playing`
 * (ANDed with the master stop), so per-project settings stay visible while the
 * master is off. A switched-on but rate-limited project still counts.
 */
export function summarize(
	projects: readonly ProjectDispatch[],
	globalPlaying = true,
): FleetDispatch {
	const readable = projects.filter((p) => p.status !== null);
	const playing = readable.filter(
		(p) => p.status?.projectPlaying === true,
	).length;
	const total = readable.length;
	const summary: FleetSummary =
		total === 0
			? "empty"
			: playing === 0
				? "none"
				: playing === total
					? "all"
					: "some";
	return { projects: [...projects], playing, total, summary, globalPlaying };
}

/** Read every attached project's status. Parallel: these are reads. */
export async function dispatchStatusAll(
	targets: readonly DispatchTarget[],
	globalPlaying = true,
): Promise<FleetDispatch> {
	return summarize(
		await Promise.all(
			targets.map(async (t): Promise<ProjectDispatch> => {
				try {
					return {
						project: t.name,
						status: await t.scheduler.status(),
						error: null,
					};
				} catch (e) {
					return { project: t.name, status: null, error: messageOf(e) };
				}
			}),
		),
		globalPlaying,
	);
}

/**
 * Flip the machine-wide master stop: one write, not a fan-out over projects, so
 * per-project settings survive. Schedulers read it via `globalPaused` on their
 * next tick and status call.
 */
export async function setGlobalDispatching(
	store: GlobalDispatchStore,
	on: boolean,
	reason = DEFAULT_STOP_REASON,
): Promise<void> {
	await store.setPaused(on ? null : { reason });
}

/** The master switch's storage. Backed by `dispatchPaused` in config.json. */
export interface GlobalDispatchStore {
	paused(): { reason: string } | null;
	setPaused(value: { reason: string } | null): Promise<void>;
}

function messageOf(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
