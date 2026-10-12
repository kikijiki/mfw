import { z } from "zod";
import { RUN_ACTIVITIES } from "./activity.ts";

/**
 * Audit event taxonomy v2.
 *
 * An event is a record of a state change that has already been decided and is
 * committing in the same transaction. Nothing reads events to make decisions:
 * deleting every event row loses history, never correctness.
 */

const ts = z.number().int(); // epoch ms, set by the appender
const runRef = z.object({ runId: z.string() });
const integerString = z.string().regex(/^-?(?:0|[1-9][0-9]*)$/);
const quantityString = z.string().regex(/^(?:0|[1-9][0-9]*)$/);
const holdReason = z.enum([
	"disabled",
	"draining",
	"dynamic-unprovisioned",
	"invalid-definition",
	"quota-exhausted",
	"observation-missing",
	"observation-ambiguous",
	"observation-not-current-process",
	"observation-not-current-kernel",
	"observation-stale",
	"observation-failed",
	"observation-inconsistent",
	"cpu-pressure",
	"external-occupancy",
	"unknown-occupancy",
	"headroom-exhausted",
]);
const observationDiagnostic = z.object({
	kind: z.string(),
	bindingId: z.string().nullable(),
	sequence: quantityString.nullable(),
	observedAt: z.number().int().nullable(),
	ageMs: z.number().nullable(),
	expiresAt: z.number().int().nullable(),
	maxAgeMs: z.number().int().nonnegative(),
	processBootId: z.string().nullable(),
	kernelBootId: z.string().nullable(),
	reuse: z.literal("serialized-while-fresh"),
	policy: z.enum(["required", "ignored-explicitly"]),
});
const cpuPressureDiagnostic = z.object({
	configuredPermits: quantityString,
	busyFraction: z.number().min(0).max(1),
	runnableProcesses: z.number().int().nonnegative(),
	maxBusyFraction: z.number().min(0).max(1).nullable(),
	maxRunnableProcesses: z.number().int().nonnegative().nullable(),
	busyBlocked: z.boolean(),
	runnableBlocked: z.boolean(),
});
const pidStartDiagnostic = z.discriminatedUnion("status", [
	z.object({
		status: z.literal("verified"),
		pid: z.number().int().positive(),
		startTimeTicks: quantityString,
		kernelBootId: z.string().nullable(),
	}),
	z.object({
		status: z.literal("unavailable"),
		pid: z.number().int().nonnegative(),
		reason: z.enum([
			"permission-denied",
			"process-missing",
			"malformed-stat",
			"not-sampled",
		]),
	}),
	z.object({
		status: z.literal("raced"),
		pid: z.number().int().nonnegative(),
		beforeStartTimeTicks: quantityString,
		afterStartTimeTicks: quantityString,
	}),
]);
const blockingGpuSource = z.enum([
	"amd-smi-process",
	"amd-smi-device",
	"nvidia-smi-compute-apps",
	"nvidia-smi-processes",
	"nvidia-smi-device",
]);
const kfdGpuSource = z.enum(["linux-kfd-debugfs", "linux-kfd-sysfs"]);
const gpuEvidenceDiagnostic = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("hsa-queue"),
		source: kfdGpuSource,
		admission: z.literal("diagnostic-only"),
		queueId: z.string().max(200),
	}),
	z.object({
		kind: z.literal("device-memory"),
		source: z.union([kfdGpuSource, blockingGpuSource]),
		admission: z.enum(["diagnostic-only", "blocking"]),
		residentBytes: quantityString,
		memoryKind: z.enum(["framebuffer", "vram", "gtt"]).optional(),
	}),
	z.object({
		kind: z.literal("compute-context"),
		source: blockingGpuSource,
		admission: z.literal("blocking"),
		contextKind: z.enum(["compute", "graphics", "mps", "other"]).optional(),
		computeUnitFraction: z.number().min(0).max(1).optional(),
	}),
]);
const gpuOccupancyDiagnostic = z.object({
	bindingId: z.string(),
	stableKey: z.string(),
	deviceKey: z.string().nullable(),
	state: z.enum(["idle", "occupied", "unknown"]),
	blocksExclusiveAdmission: z.boolean(),
	gpuUtilization: z.number().min(0).max(1).nullable(),
	memoryUsedBytes: quantityString.nullable(),
	memoryTotalBytes: quantityString.nullable(),
	temperatureCelsius: z.number().finite().nullable(),
	powerWatts: z.number().finite().nonnegative().nullable(),
	occupants: z
		.array(
			z.object({
				pid: z.number().int().nonnegative(),
				pidStart: pidStartDiagnostic,
				attribution: z.enum(["managed", "external", "unknown"]),
				runId: z.string().nullable(),
				leaseId: z.string().nullable(),
				evidence: z.array(gpuEvidenceDiagnostic).max(256),
			}),
		)
		.max(256),
	deviceEvidence: z.array(gpuEvidenceDiagnostic).max(256),
});
const ramPolicyDiagnostic = z.object({
	configuredQuotaBytes: quantityString,
	safetyHeadroomBytes: quantityString,
	memAvailableBytes: quantityString,
	durablePromisesBytes: quantityString,
	attributableManagedBytes: quantityString,
	outstandingPromiseBytes: quantityString,
	quotaRemainingBytes: quantityString,
	observedHeadroomBytes: integerString,
	effectiveCapacityBytes: quantityString,
	requestBytes: quantityString.optional(),
});

/** JSON-safe resource hold contract for event readers. */
export const HostHoldEventDiagnosticSchema = z.object({
	resourceId: z.string(),
	reason: holdReason,
	message: z.string(),
	requestedAmount: quantityString,
	configuredQuota: quantityString.nullable(),
	durablePromises: quantityString.nullable(),
	effectiveCapacity: quantityString,
	observation: observationDiagnostic.nullable(),
	ramFormula: ramPolicyDiagnostic.nullable(),
	cpuPressure: cpuPressureDiagnostic.nullable(),
	gpuOccupancy: gpuOccupancyDiagnostic.nullable(),
});
export type HostHoldEventDiagnostic = z.infer<
	typeof HostHoldEventDiagnosticSchema
>;

/** How a run's finalize ended, a closed enum the brain decides from (`run.settled`). */
export const SETTLE_CLASSES = [
	"verified",
	"verify_failed",
	"review_fix",
	"review_reject",
	"scope_violation",
	"scope_outside",
	"question",
	"background_work",
	"interrupted",
	"watchdog_killed",
	"rate_limited",
	"stopped",
	"infra_failure",
	"report_blocked",
	"report_replan",
	"report_drop",
	"plan_output",
	"merge_parked",
] as const;
export type SettleClass = (typeof SETTLE_CLASSES)[number];

/** Why the brain was woken (`brain.turn_started`). */
export const WAKE_CLASSES = [
	"settled",
	"attention",
	"frontier",
	"capacity",
	"merge",
	"human",
	"heartbeat",
] as const;
export type WakeClass = (typeof WAKE_CLASSES)[number];

export const EventSchema = z.discriminatedUnion("type", [
	// --- task lifecycle ---
	z.object({
		type: z.literal("task.created"),
		taskId: z.string(),
		payload: z.object({
			source: z.enum([
				"human",
				"planner",
				"importer",
				"lifetime",
				"split",
				"followup",
				"file",
			]),
			title: z.string(),
			/** `brain:<actionId>#<n>` when the brain wrote the task (it must not wake itself). */
			createdBy: z.string().optional(),
		}),
	}),
	z.object({
		type: z.literal("task.status_changed"),
		taskId: z.string(),
		payload: z.object({
			from: z.string(),
			to: z.string(),
			actor: z.enum([
				"scheduler",
				"human",
				"brain",
				"verifier",
				"watchdog",
				"boot",
			]),
			reason: z.string().optional(),
		}),
	}),
	z.object({
		type: z.literal("task.edited"),
		taskId: z.string(),
		payload: z.object({
			source: z.enum(["api", "file", "brain"]),
			fields: z.array(z.string()),
			rev: z.number().int(),
		}),
	}),
	z.object({
		type: z.literal("task.reopen_check"),
		taskId: z.string(),
		payload: z.object({
			attemptId: z.string(),
			definitionHash: z.string(),
			checkout: z.enum(["integration-worktree", "primary"]),
			phase: z.enum(["started", "finished"]),
			outcome: z.enum(["passed", "failed", "error"]).optional(),
			detail: z.string().optional(),
		}),
	}),

	z.object({
		type: z.literal("task.deleted"),
		taskId: z.string(),
		payload: z.object({ title: z.string() }),
	}),
	z.object({
		type: z.literal("task.claimed"),
		taskId: z.string(),
		payload: runRef.extend({
			purpose: z.enum(["task_run", "draft_expansion"]).optional(),
		}),
	}),
	z.object({
		type: z.literal("task.claim_released"),
		taskId: z.string(),
		payload: runRef.extend({
			purpose: z.enum(["task_run", "draft_expansion"]),
			reason: z.string().optional(),
		}),
	}),
	z.object({
		type: z.literal("task.lease_expired"),
		taskId: z.string(),
		payload: runRef,
	}),
	z.object({
		type: z.literal("task.quarantined"),
		payload: z.object({
			file: z.string(),
			reason: z.string(),
			taskId: z.string().optional(),
		}),
	}),
	/**
	 * The board on disk stopped being believable (most of it vanished in one
	 * poll, or the tracked sentinel is missing). The index is frozen and dispatch
	 * held rather than processing the difference as N deletions.
	 */
	z.object({
		type: z.literal("board.suspended"),
		payload: z.object({
			reason: z.enum(["sentinel", "mass-delete"]),
			indexed: z.number(),
			found: z.number(),
			lost: z.number(),
		}),
	}),
	z.object({
		type: z.literal("board.resumed"),
		payload: z.object({ loaded: z.number() }),
	}),
	z.object({
		type: z.literal("task.conflict"),
		taskId: z.string(),
		payload: z.object({
			conflictFile: z.string(),
			fileRev: z.number().int(),
			dbRev: z.number().int(),
		}),
	}),
	z.object({
		type: z.literal("task.held_for_resource"),
		taskId: z.string(),
		payload: z.object({
			waitingFor: z.array(z.string()),
			scope: z.enum(["project", "host"]).optional(),
			reason: z.string().optional(),
			code: z.string().optional(),
			snapshotGeneration: z.string().optional(),
			diagnostics: z.array(HostHoldEventDiagnosticSchema).optional(),
			/** The exact remedy (daemon `refusal-fix.ts`); absent on old events. */
			fix: z
				.object({
					kind: z.enum(["setting", "command", "ui"]),
					text: z.string().min(1),
				})
				.optional(),
		}),
	}),
	z.object({
		type: z.literal("admission.state_changed"),
		taskId: z.string(),
		runId: z.string(),
		payload: z.object({
			admissionId: z.string(),
			from: z.string(),
			to: z.string(),
			reason: z.string().optional(),
		}),
	}),
	z.object({
		type: z.literal("admission.recovered"),
		taskId: z.string(),
		runId: z.string(),
		payload: z.object({
			admissionId: z.string(),
			action: z.enum(["resumed", "compensated", "adopted"]),
		}),
	}),

	// --- runs ---
	z.object({
		type: z.literal("run.started"),
		runId: z.string(),
		taskId: z.string().optional(),
		payload: z.object({
			kind: z.string(),
			taskId: z.string().optional(),
			model: z.string(),
			branch: z.string().optional(),
			/** Typed lineage (see `runs.relation`): enough to insert a tree node from the event alone. */
			parentRunId: z.string().optional(),
			relation: z.string().optional(),
			label: z.string().optional(),
			groupId: z.string().optional(),
			role: z.string().optional(),
		}),
	}),
	z.object({
		type: z.literal("run.state_changed"),
		runId: z.string(),
		taskId: z.string().optional(),
		payload: z.object({
			from: z.string(),
			to: z.string(),
			exitCode: z.number().int().nullable().optional(),
			killReason: z.string().optional(),
			note: z.string().optional(),
		}),
	}),
	/**
	 * The run's activity (see `activity.ts`) changed: working, waiting on an
	 * approval or an answer, stalled, idle, ended. Only on change, so a busy
	 * run writes a handful, not one per supervisor pass.
	 */
	z.object({
		type: z.literal("run.activity_changed"),
		runId: z.string(),
		taskId: z.string().optional(),
		payload: z.object({
			from: z.enum(RUN_ACTIVITIES).nullable(),
			to: z.enum(RUN_ACTIVITIES),
			question: z.string().optional(),
			stallCause: z.enum(["background", "silent"]).optional(),
			pendingApprovals: z.number().int().nonnegative().optional(),
		}),
	}),
	/**
	 * A live run's running token and cost totals, sampled from its transcript
	 * at most once every 30 s. Display only (the agent chip's `$`); the spend
	 * ledger stays the source for budgets and the final `usage` is unchanged.
	 */
	z.object({
		type: z.literal("run.usage_sampled"),
		runId: z.string(),
		taskId: z.string().optional(),
		payload: z.object({
			tokensIn: z.number().nonnegative(),
			tokensOut: z.number().nonnegative(),
			costUsd: z.number().nonnegative().optional(),
		}),
	}),
	/**
	 * A run's subagents changed shape: one started, or one finished (`run_subagents`).
	 * Tool counts alone do not announce. Lets the Flow tree and the transcript
	 * refetch the `sub:` nodes; `running` is how many are still going.
	 */
	z.object({
		type: z.literal("run.subagents_changed"),
		runId: z.string(),
		taskId: z.string().optional(),
		payload: z.object({
			total: z.number().int().nonnegative(),
			running: z.number().int().nonnegative(),
		}),
	}),
	/**
	 * The scope watchdog's level for a live run changed (ok, warn, violation):
	 * how many files it changed, how many fall outside its task's `owns`, how
	 * many another claimed task owns. Only on a level change.
	 */
	z.object({
		type: z.literal("run.scope_changed"),
		runId: z.string(),
		taskId: z.string().optional(),
		payload: z.object({
			from: z.enum(["ok", "warn", "violation"]).nullable(),
			level: z.enum(["ok", "warn", "violation"]),
			files: z.number().int().nonnegative(),
			outside: z.number().int().nonnegative(),
			foreign: z.number().int().nonnegative(),
		}),
	}),
	z.object({
		// A run's worktree or branch was saved to a `wip/` branch before being
		// discarded (by a human discard, or a close with `discard`).
		type: z.literal("run.wip_archived"),
		runId: z.string(),
		taskId: z.string().optional(),
		payload: z.object({
			ref: z.string().nullable(),
			sha: z.string().nullable(),
			actor: z.string(),
			reason: z.string(),
		}),
	}),
	/**
	 * A judgment call was recorded (`phase: "inserted"`, status running) or
	 * settled (`phase: "settled"`, with its terminal status and action). Exactly
	 * one event per insert and per settle, in the row's own transaction.
	 */
	z.object({
		type: z.literal("decision.recorded"),
		taskId: z.string().optional(),
		runId: z.string().optional(), // the subject run, when there is one
		payload: z.object({
			id: z.number().int(),
			role: z.string(),
			phase: z.enum(["inserted", "settled"]),
			status: z.string(),
			kind: z.string().nullable().optional(),
			action: z.string().nullable().optional(),
			taskId: z.string().nullable().optional(),
			subjectRunId: z.string().nullable().optional(),
			effects: z.array(z.string()).optional(),
		}),
	}),
	z.object({
		type: z.literal("run.finalize_step"),
		runId: z.string(),
		taskId: z.string().optional(),
		payload: z.object({
			step: z.string(),
			ok: z.boolean(),
			detail: z.string().optional(),
		}),
	}),

	// --- verification / merge / main health ---
	z.object({
		type: z.literal("verify.check"),
		taskId: z.string(),
		runId: z.string(),
		payload: z.object({
			check: z.string(),
			passed: z.boolean(),
			classification: z
				.enum(["failed", "missing-file", "no-change", "timeout", "crashed"])
				.optional(),
			detail: z.string().optional(),
		}),
	}),
	z.object({
		type: z.literal("merge.completed"),
		taskId: z.string().optional(), // absent for import merges
		runId: z.string(),
		payload: z.object({ sha: z.string(), target: z.string() }),
	}),
	z.object({
		type: z.literal("merge.deferred"),
		taskId: z.string(),
		payload: z.object({ reason: z.string() }),
	}),
	/**
	 * The merge landed but the push did not, so local and remote have diverged.
	 * Nothing else in the timeline says so (`merge.completed` is still true).
	 * The merge is not undone; pushing is a publication step after landing.
	 */
	z.object({
		type: z.literal("merge.push_failed"),
		taskId: z.string().optional(),
		runId: z.string(),
		payload: z.object({
			target: z.string(),
			remote: z.string(),
			reason: z.string(),
		}),
	}),
	/**
	 * A merge job parked (conflict, or failed re-verify after a rebase). Fires
	 * on every park, soft or hard; `exhausted: true` marks the one that
	 * escalates to a human (see `MergeQueue.park()`).
	 *
	 * `crashed` marks a `kind: "reverify"` park fully explained by a DoD check
	 * dying to a signal, not by a real conflict. Absent (not `false`) on other
	 * parks, like `verify.check`'s `classification`.
	 */
	z.object({
		type: z.literal("merge.parked"),
		taskId: z.string().optional(),
		runId: z.string(),
		payload: z.object({
			target: z.string(),
			kind: z.enum(["conflict", "reverify"]),
			reason: z.string(),
			retries: z.number(),
			exhausted: z.boolean(),
			crashed: z.boolean().optional(),
		}),
	}),
	/** An operator asked a parked job to retry; `merge.completed` or another `merge.parked` is the answer. */
	z.object({
		type: z.literal("merge.retried"),
		taskId: z.string().optional(),
		runId: z.string(),
		payload: z.object({ target: z.string() }),
	}),
	/**
	 * A job's retries were exhausted and `MergeQueue.park()` handed the branch
	 * to one automatic conflict-resolution run (`childRunId`) instead of
	 * escalating. The job moves to `abandoned` (the work continues under the
	 * child); the child's own merge job escalates via `merge.parked` if it too
	 * runs out of retries.
	 */
	z.object({
		type: z.literal("merge.unblock_started"),
		taskId: z.string().optional(),
		runId: z.string(),
		payload: z.object({
			target: z.string(),
			kind: z.enum(["conflict", "reverify"]),
			reason: z.string(),
			retries: z.number(),
			childRunId: z.string(),
		}),
	}),
	/** An operator gave up on a parked job's branch (`abandon`, or first half of `sendToReady`). Terminal. */
	z.object({
		type: z.literal("merge.abandoned"),
		taskId: z.string().optional(),
		runId: z.string(),
		payload: z.object({ target: z.string() }),
	}),
	/** The board firewall discarded board changes a merging branch carried; kept as an event so repeated discards are visible. */
	z.object({
		type: z.literal("merge.board_reverted"),
		taskId: z.string().optional(),
		runId: z.string(),
		payload: z.object({
			target: z.string(),
			paths: z.array(z.string()),
		}),
	}),
	z.object({
		type: z.literal("main.red"),
		payload: z.object({
			incidentId: z.string().optional(),
			causeTaskId: z.string().optional(),
			detail: z.string().optional(),
		}),
	}),
	z.object({
		type: z.literal("recovery.started"),
		taskId: z.string().optional(),
		runId: z.string(),
		payload: z.object({ incidentId: z.string() }),
	}),
	z.object({ type: z.literal("main.green"), payload: z.object({}) }),
	/**
	 * A regression survived `ESCALATE_AFTER_SWEEPS` sweeps. Fires once, on the
	 * sweep that first crosses the threshold: self-repair is no longer admitted
	 * through the red-main gate and a human is needed.
	 */
	z.object({
		type: z.literal("main.red_escalated"),
		payload: z.object({ causeTaskId: z.string() }),
	}),
	/**
	 * A sweep check also failed at the last commit the sweep confirmed green, so
	 * it cannot be a code regression. Nothing is reopened and `main_red` is not
	 * tripped; the sweep environment needs attention.
	 */
	z.object({
		type: z.literal("sweep.infra_failure"),
		payload: z.object({
			taskIds: z.array(z.string()),
			attempts: z.number().int(),
		}),
	}),
	/**
	 * A finalize-time DoD check was killed by a signal (SIGILL, SIGSEGV, OOM, ...)
	 * rather than run to a result: a fact about the verifier, not the code. The
	 * task is not blamed (see `task.status_changed`). Finalize-time twin of
	 * `sweep.infra_failure`.
	 */
	z.object({
		type: z.literal("verify.infra_crash"),
		taskId: z.string(),
		runId: z.string(),
		payload: z.object({
			attempts: z.number().int(),
		}),
	}),

	// --- scheduler ---
	z.object({
		type: z.literal("scheduler.paused"),
		payload: z.object({ reason: z.string(), until: ts.optional() }),
	}),
	z.object({ type: z.literal("scheduler.resumed"), payload: z.object({}) }),
	z.object({
		type: z.literal("rate_limit.hit"),
		payload: z.object({
			providerId: z.string(),
			until: ts,
			reason: z.string(),
		}),
	}),
	z.object({
		type: z.literal("rate_limit.cleared"),
		payload: z.object({ providerId: z.string() }),
	}),

	// --- resources ---
	z.object({
		type: z.literal("resource.locked"),
		runId: z.string(),
		payload: z.object({ resourceId: z.string(), slot: z.number().int() }),
	}),
	z.object({
		type: z.literal("resource.released"),
		payload: z.object({
			resourceId: z.string(),
			slot: z.number().int(),
			runId: z.string(),
			forced: z.boolean(),
		}),
	}),
	z.object({
		type: z.literal("resource.leaked"),
		payload: z.object({ resourceId: z.string(), runId: z.string() }),
	}),
	z.object({
		type: z.literal("resource.cleanup"),
		payload: z.object({
			resourceId: z.string(),
			ok: z.boolean(),
			detail: z.string().optional(),
		}),
	}),

	// --- lifetime / clarify ---
	z.object({
		type: z.literal("lifetime.fired"),
		payload: z.object({ defId: z.string(), taskId: z.string() }),
	}),
	z.object({
		type: z.literal("clarify.raised"),
		runId: z.string(),
		payload: z.object({ kind: z.string(), count: z.number().int() }),
	}),
	z.object({
		type: z.literal("clarify.resolved"),
		runId: z.string(),
		payload: z.object({
			answered: z.boolean(),
			continuationRunId: z.string().optional(),
			/** Who answered; the brain's own answer does not wake it. */
			by: z.enum(["brain", "human"]).optional(),
		}),
	}),

	// --- project triggers ---
	/**
	 * An armed trigger's definition file no longer matches the hash recorded
	 * when armed, so it disarmed itself (M2 mitigation: makes a silent edit to a
	 * hook visible).
	 */
	z.object({
		type: z.literal("trigger.disarmed"),
		payload: z.object({
			defId: z.string(),
			reason: z.enum(["hash-drift", "definition-removed", "unloadable"]),
			armedHash: z.string(),
			foundHash: z.string().optional(),
		}),
	}),
	z.object({
		type: z.literal("trigger.dispatched"),
		payload: z.object({
			defId: z.string(),
			deliveryId: z.string(),
			eventSeq: z.number().int(),
			eventType: z.string(),
			action: z.string(),
			skippedSeqs: z.array(z.number().int()).optional(),
		}),
	}),
	z.object({
		type: z.literal("trigger.failed"),
		payload: z.object({
			defId: z.string(),
			deliveryId: z.string(),
			eventSeq: z.number().int(),
			eventType: z.string(),
			action: z.string(),
			detail: z.string(),
		}),
	}),

	// --- escalation sessions ---
	/** mfw exhausted its recovery and composed a diagnostic brief. Costs nothing; `session.opened` starts a run. */
	z.object({
		type: z.literal("session.raised"),
		taskId: z.string().optional(),
		runId: z.string().optional(),
		payload: z.object({
			sessionId: z.string(),
			source: z.enum(["main_red", "merge_parked", "blocked"]),
		}),
	}),
	/** A human opened a composed session (the point it starts costing). */
	z.object({
		type: z.literal("session.opened"),
		taskId: z.string().optional(),
		runId: z.string(),
		payload: z.object({ sessionId: z.string() }),
	}),
	/** A session was closed with a disposition (closing must resolve something, not just hide it). */
	z.object({
		type: z.literal("session.resolved"),
		taskId: z.string().optional(),
		payload: z.object({
			sessionId: z.string(),
			resolution: z.enum(["fixed", "retried", "dismissed"]),
			reason: z.string().optional(),
		}),
	}),

	// --- brain-led orchestration (schemas only; emitters arrive with the brain) ---
	/** Finalize ended in `settle`: the closed class of how a run ended, plus the facts the brain needs. */
	z.object({
		type: z.literal("run.settled"),
		runId: z.string(),
		taskId: z.string().optional(),
		payload: z.object({
			groupId: z.string().nullable().optional(),
			class: z.enum(SETTLE_CLASSES),
			facts: z.record(z.string(), z.unknown()),
		}),
	}),
	z.object({
		type: z.literal("brain.turn_started"),
		runId: z.string(),
		payload: z.object({
			sessionId: z.string(),
			seq: z.number().int().nonnegative(),
			generation: z.number().int().nonnegative(),
			wakeClass: z.enum(WAKE_CLASSES),
			eventsFrom: z.number().int().nonnegative(),
			eventsTo: z.number().int().nonnegative(),
			resumed: z.boolean(),
		}),
	}),
	z.object({
		type: z.literal("brain.turn_ended"),
		runId: z.string(),
		payload: z.object({
			sessionId: z.string(),
			status: z.enum(["ok", "failed", "timeout", "aborted"]),
			actionsCount: z.number().int().nonnegative(),
			error: z.string().optional(),
		}),
	}),
	/** One act-tool call of a brain turn, with the id of its `brain_actions` and `decisions` rows. */
	z.object({
		type: z.literal("brain.action"),
		runId: z.string().optional(),
		taskId: z.string().optional(),
		payload: z.object({
			actionId: z.string(),
			tool: z.string(),
			status: z.enum(["accepted", "applied", "rejected", "failed", "proposed"]),
			decisionId: z.number().int().optional(),
			sessionId: z.string().optional(),
			/** Set when the executor, not the validator, failed the action. */
			error: z.string().optional(),
		}),
	}),
	/** An attempt group changed state: opened a selection, picked a winner, merged or was abandoned. */
	z.object({
		type: z.literal("run.group_changed"),
		taskId: z.string(),
		payload: z.object({
			groupId: z.string(),
			status: z.enum(["open", "selecting", "merged", "abandoned"]),
			winnerRunId: z.string().nullable().optional(),
			reason: z.string().optional(),
		}),
	}),
	z.object({
		type: z.literal("brain.rollover"),
		payload: z.object({
			sessionId: z.string(),
			reason: z.string(),
			fromGeneration: z.number().int().nonnegative(),
			toGeneration: z.number().int().nonnegative(),
			fromNativeSessionId: z.string().nullable().optional(),
			toNativeSessionId: z.string().nullable().optional(),
		}),
	}),
	/** A budget key crossed its `warnAt` fraction; wakes the brain so it can economise. */
	z.object({
		type: z.literal("budget.threshold"),
		payload: z.object({
			key: z.string(),
			kind: z.enum(["agent", "resource", "brain"]),
			unit: z.enum(["usd", "tokens", "slot_hours"]),
			used: z.number().nonnegative(),
			limit: z.number().nonnegative(),
			fraction: z.number().nonnegative(),
			windowResetsAt: z.number().int().nullable().optional(),
		}),
	}),
	z.object({
		type: z.literal("budget.exhausted"),
		payload: z.object({
			key: z.string(),
			kind: z.enum(["agent", "resource", "brain"]),
			unit: z.enum(["usd", "tokens", "slot_hours"]),
			used: z.number().nonnegative(),
			limit: z.number().nonnegative(),
			windowResetsAt: z.number().int().nullable().optional(),
		}),
	}),
	z.object({
		type: z.literal("budget.restored"),
		payload: z.object({
			key: z.string(),
			kind: z.enum(["agent", "resource", "brain"]),
			reason: z.enum(["window_reset", "limit_raised"]),
		}),
	}),
	/** A human reversed a brain decision; `decisionId` is the override row, `overriddenDecisionId` the original. */
	z.object({
		type: z.literal("human.override"),
		taskId: z.string().optional(),
		runId: z.string().optional(),
		payload: z.object({
			decisionId: z.number().int(),
			overriddenDecisionId: z.number().int(),
			reason: z.string().optional(),
			/** The brain tool whose decision was reversed (`set_status`, `spawn`, ...). */
			tool: z.string().optional(),
			/** The inverse operation that was applied, one line. */
			inverse: z.string().optional(),
		}),
	}),
	/** A person wrote to the brain. `about` is a node ref (`task:T-1`, `run:<id>`, `decision:<n>`) when the note concerns one thing. */
	z.object({
		type: z.literal("human.brain_message"),
		taskId: z.string().optional(),
		runId: z.string().optional(),
		payload: z.object({
			sessionId: z.string().optional(),
			text: z.string(),
			about: z.string().optional(),
			/** The `decisions` row holding the message (the durable copy). */
			decisionId: z.number().int().optional(),
		}),
	}),
]);

export type MfwEvent = z.infer<typeof EventSchema>;
export type MfwEventType = MfwEvent["type"];
