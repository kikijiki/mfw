/**
 * The exact remedy for every dispatch/admission refusal (backstage architecture.md, "Resources, targets and recovery of capacity").
 * A refusal is only useful if the operator can act on it, so each code maps to
 * one sentence naming what to change, where, or that nothing needs doing.
 * Derived from the persisted `holdCode`, so no schema change is needed and an
 * old row gains a fix too.
 */

import type { PreflightCode } from "./dispatch-preflight.ts";
import type { Held, HostCapacityHoldReason } from "./host-resources/types.ts";

export interface RefusalFix {
	/** Where the remedy lives: a project setting, a shell command, or a screen. */
	kind: "setting" | "command" | "ui";
	text: string;
}

const list = (ids: readonly string[]) =>
	ids.length > 0 ? ids.map((id) => `'${id}'`).join(", ") : "the resource";

type FixFor = (waitingFor: readonly string[]) => RefusalFix;
const ui =
	(text: (ids: string) => string): FixFor =>
	(waitingFor) => ({
		kind: "ui",
		text: text(list(waitingFor)),
	});

/**
 * Every code a hold, issue or preflight refusal can carry. Typed from the
 * coordinator's own unions, so a new host hold reason without a fix does not
 * compile.
 */
export type RefusalCode =
	| HostCapacityHoldReason
	| Held["reason"]
	| "resource"
	| "owns-overlap"
	| "duplicate"
	| "invalid_amount"
	| "reconciliation"
	| "coordinator"
	| "renewal_uncertain"
	| "reconciliation_uncertain"
	| "project_slot_recovery"
	| "compensation"
	| "route_invalid"
	| PreflightCode;

export const REFUSAL_FIXES: Record<RefusalCode, FixFor> = {
	// project semaphores and the scheduler's own holds
	capacity: ui(
		(ids) =>
			`Wait for the run holding ${ids} to finish, or raise its max concurrent in Settings → Resources.`,
	),
	resource: ui(
		(ids) =>
			`Wait for the run holding ${ids} to finish, or raise its max concurrent in Settings → Resources.`,
	),
	"owns-overlap": ui(
		(ids) =>
			`Wait for ${ids} to finish, or edit the tasks so their owns globs no longer overlap (or add a depends_on between them).`,
	),
	// requirement validation
	duplicate: ui(
		(ids) =>
			`Edit the task and remove the duplicate ${ids} entry from requires_resources.`,
	),
	definition: ui(
		(ids) =>
			`Register host resource ${ids} (Host Resources page → Detected host resources, or hostResources.createDefinition) and make it available, or remove it from the task's requires_resources.`,
	),
	invalid_amount: ui(
		(ids) =>
			`Edit the amount for ${ids} in the task's requires_resources: omit it or use 1 for a slot, a whole number for an integer quantity, an IEC size such as 8GiB for RAM.`,
	),
	// host coordinator state
	reconciliation: ui(
		() =>
			"Nothing to change: host admission recovery is still running and dispatch resumes when it completes. If it does not, check open incidents on the Host Resources page and restart the daemon.",
	),
	coordinator: ui(
		() =>
			"Check the host resource store ($MFW_HOME/host) for the error shown on the Host Resources page, then restart the daemon.",
	),
	fifo: ui(
		(ids) =>
			`Nothing to change: earlier tasks are queued for ${ids} and this one is served in order. To go faster, raise the capacity of ${ids} (hostResources.updateDefinition).`,
	),
	generation: ui(
		() =>
			"Nothing to change: host capacity changed during the decision and the next tick retries.",
	),
	observation: ui(
		(ids) =>
			`Wait for a fresh probe of ${ids}; if it stays stale, check the probe error on the Host Resources page.`,
	),
	headroom: ui(
		(ids) =>
			`Free memory on the host, or lower the safetyHeadroom of ${ids} (hostResources.updateDefinition).`,
	),
	disabled: ui(
		(ids) => `Make host resource ${ids} available on the Host Resources page.`,
	),
	draining: ui(
		(ids) =>
			`Click "Allow new work" for host resource ${ids} on the Host Resources page.`,
	),
	"dynamic-unprovisioned": ui(
		(ids) =>
			`Redefine host resource ${ids} as static with an explicit capacity (hostResources.updateDefinition).`,
	),
	"invalid-definition": ui(
		(ids) =>
			`Fix the definition of host resource ${ids} (hostResources.updateDefinition); the Host Resources page shows the problem.`,
	),
	"quota-exhausted": ui(
		(ids) =>
			`Wait for runs holding ${ids} to finish, or raise its capacity (hostResources.updateDefinition).`,
	),
	"observation-missing": ui(
		(ids) =>
			`Wait for the first probe of ${ids}; if none arrives, check the probe on the Host Resources page.`,
	),
	"observation-ambiguous": ui(
		(ids) =>
			`Check the probe of ${ids} on the Host Resources page: it matched more than one device.`,
	),
	"observation-not-current-process": ui(
		() =>
			"Nothing to change: the probe predates this daemon process and the next probe replaces it.",
	),
	"observation-not-current-kernel": ui(
		() =>
			"Nothing to change: the probe predates the last reboot and the next probe replaces it.",
	),
	"observation-stale": ui(
		(ids) =>
			`Wait for a fresh probe of ${ids}; if it stays stale, check the probe error on the Host Resources page.`,
	),
	"observation-failed": ui(
		(ids) =>
			`Fix the probe of ${ids}: its error is shown on the Host Resources page.`,
	),
	"observation-inconsistent": ui(
		(ids) =>
			`Check the probe of ${ids} on the Host Resources page: its readings contradict each other.`,
	),
	"cpu-pressure": ui(
		() =>
			"Wait for host CPU pressure to fall, or raise cpuPressure.maxBusyFraction / maxRunnableProcesses on the CPU resource (hostResources.updateDefinition).",
	),
	"external-occupancy": ui(
		(ids) =>
			`Stop the process outside mfw that is using ${ids} (it is listed on the Host Resources page); mfw never signals it.`,
	),
	"unknown-occupancy": ui(
		(ids) =>
			`Identify and stop whatever is using ${ids} (see the Host Resources page); mfw never signals processes it does not own.`,
	),
	"headroom-exhausted": ui(
		(ids) =>
			`Free memory on the host, wait for running tasks to finish, or lower the safetyHeadroom of ${ids} (hostResources.updateDefinition).`,
	),
	// dispatch preflight (dispatch-preflight.ts); waitingFor carries the subject
	integration_branch_missing: (waitingFor) => ({
		kind: "setting",
		text: `Create the integration branch (git branch ${waitingFor[0] ?? "<branch>"} <commit>), or set integrationBranch in this project's entry in $MFW_HOME/config.json to a branch that exists.`,
	}),
	branch_exists: (waitingFor) => ({
		kind: "command",
		text: `Move the leftover branch out of the way, keeping its commits: git branch -m ${waitingFor[0] ?? "<branch>"} wip/${(waitingFor[0] ?? "<branch>").replace(/^mfw\//, "")}-leftover`,
	}),
	worktree_exists: (waitingFor) => ({
		kind: "command",
		text: `Inspect ${waitingFor[0] ?? "the worktree path"}; if it holds nothing you need, remove it: git worktree remove --force ${waitingFor[0] ?? "<path>"} (or delete the directory if git does not list it).`,
	}),
	memory_floor: (waitingFor) => ({
		kind: "setting",
		text: `Free memory on the host (${waitingFor.join(", ")}), or lower minFreeMemoryMb in this project's entry in $MFW_HOME/config.json (0 turns the check off).`,
	}),
	provider_held: (waitingFor) => ({
		kind: "setting",
		text: `Nothing to change: ${waitingFor[0] ?? "the provider"} is rate limited and dispatch resumes when the hold expires. To keep working meanwhile, add a fallback for this tier in Settings → Routing, unpin the task's provider, or clear the hold in Settings → Routing.`,
	}),
	budget_exhausted: (waitingFor) => ({
		kind: "setting",
		text: `Raise the budget for ${waitingFor[0] ?? "the resource"} in Settings → Budgets, or wait for its window to reset; tasks that do not use it keep running.`,
	}),
	route_invalid: ui(
		(ids) =>
			`Edit task ${ids}: set its provider to claude-cli, codex-cli or an endpoint defined in Settings → Routing (or clear it), and give an endpoint without a default model a model.`,
	),
	// issues set on an existing admission
	renewal_uncertain: ui(
		() =>
			"Nothing to change: the next lease renewal retries; if it persists, check host incidents on the Host Resources page.",
	),
	reconciliation_uncertain: ui(
		() =>
			"Nothing to change: the next reconcile retries; if it persists, restart the daemon.",
	),
	project_slot_recovery: ui(
		() =>
			"Nothing to change: project slot recovery retries on its own; if it persists, restart the daemon.",
	),
	compensation: ui(
		() =>
			"Nothing to change: the release is retried each tick; if it persists, check the daemon log for the failing step and restart the daemon.",
	),
};

/** The fix for a refusal code; never empty, even for a code added later. */
export function refusalFix(
	code: string | null | undefined,
	waitingFor: readonly string[] = [],
): RefusalFix {
	const fix =
		code && Object.hasOwn(REFUSAL_FIXES, code)
			? REFUSAL_FIXES[code as RefusalCode]
			: undefined;
	if (fix) return fix(waitingFor);
	return {
		kind: "ui",
		text: `Open the task's admission details on the Host Resources page${code ? ` (code ${code})` : ""} and resolve what it is waiting for: ${list(waitingFor)}.`,
	};
}
