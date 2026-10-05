import { z } from "zod";

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
		payload: z.object({
			kind: z.string(),
			taskId: z.string().optional(),
			model: z.string(),
			branch: z.string().optional(),
		}),
	}),
	z.object({
		type: z.literal("run.state_changed"),
		runId: z.string(),
		payload: z.object({
			from: z.string(),
			to: z.string(),
			exitCode: z.number().int().nullable().optional(),
			killReason: z.string().optional(),
			note: z.string().optional(),
		}),
	}),
	z.object({
		type: z.literal("run.finalize_step"),
		runId: z.string(),
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
]);

export type MfwEvent = z.infer<typeof EventSchema>;
export type MfwEventType = MfwEvent["type"];
