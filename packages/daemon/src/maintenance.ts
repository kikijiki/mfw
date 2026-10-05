import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ProjectDbHandle } from "@mfw/db/client";
import { appendEvent, type EventBus } from "@mfw/db/eventlog";
import { engineKv, events as eventRows } from "@mfw/db/schema";
import { eq } from "drizzle-orm";
import { git } from "./git.ts";
import type { Logger } from "./log.ts";
import { runProc } from "./proc.ts";
import { loadReopenPolicies, reopenDefinitionHash } from "./reopen-policy.ts";
import { CLAIM_HOLDING_RUN_STATES, type RunRegistry } from "./run-registry.ts";
import type { RaiseInput } from "./session.ts";
import type { TaskService } from "./task-service.ts";
import type { DefinitionOfDone, DoDCheck } from "./tasks/types.ts";
import {
	describeVerificationEnvironment,
	type EnvPolicy,
	type VerificationResult,
	type VerifyOptions,
	verify,
} from "./verifier.ts";
import { WorktreeManager } from "./worktree.ts";

/**
 * Periodic housekeeping, driven by the scheduler's maintenance hook.
 *
 * The regression sweep is the only thing that sets and clears `main_red`, the
 * breaker the merge queue respects. It runs in an ephemeral worktree off the
 * integration branch, never the primary checkout or the merge worker's
 * integration worktree.
 */

/** Input to the brain's second opinion on a sweep failure the deterministic classifiers could not place (see `Maintenance.diagnoseVerdict`). */
export interface DiagnoseCtx {
	taskId: string | null;
	check: string;
	outputTail: string;
	exitCode: number | null;
	environment: string;
	/** Whether the same check passes at the last known-green sha; null with no green baseline. */
	passesAtGreenSha: boolean | null;
}

export interface DiagnoseResult {
	status: "ok" | "failed";
	verdict?: "regression" | "environment" | "flaky";
	reason?: string;
}

/** The slice of the brain `Maintenance` needs (`diagnose` only), separate from `BrainPort`. */
export interface DiagnosePort {
	enabled: boolean;
	diagnose(ctx: DiagnoseCtx): Promise<DiagnoseResult>;
}

export interface MaintenanceDeps {
	handle: ProjectDbHandle;
	bus: EventBus;
	tasks: TaskService;
	registry: RunRegistry;
	log: Logger;
	projectRoot: string;
	integrationBranch: string;
	mfwHome?: string;
	checkPrefix?: string;
	envPolicy?: EnvPolicy;
	/** Renewal window applied to a live run's lease during a groom pass. */
	leaseMs?: number;
	now?: () => number;
	/** Late-bound to `RunEngine.startPlan(prompt, {taskId})` (Maintenance is built first). Absent disables `expandDrafts`. */
	startExpand?: (taskId: string, prompt: string) => Promise<{ runId: string }>;
	/** Late-bound to the scheduler's `status().playing` (project and global); `expandDrafts` only runs while playing. Absent always dispatches. */
	dispatching?: () => Promise<boolean>;
	/** System-wide cap on simultaneous draft-expansion runs (default 1). */
	maxConcurrentDraftExpansions?: number;
	/** Advisory second opinion for a sweep failure neither `result.crashed` nor `isInfrastructural` placed. Absent or `enabled: false` treats it as a regression. */
	diagnose?: DiagnosePort;
	/** Raises a pre-loaded human session when a regression crosses `ESCALATE_AFTER_SWEEPS`. Absent skips it; `main_red` is unaffected. */
	sessions?: { raise(input: RaiseInput): Promise<unknown> };
	/** Starts a first-class recovery run. The referenced task remains done. */
	startRepair?: (
		taskId: string,
		incidentId: string,
		detail: string,
	) => Promise<{ runId: string } | null>;
}

export interface SweepResult {
	checked: number;
	/** Failed at the tip and not at the last known-green sha (or no baseline exists). */
	broken: string[];
	/** Failed at the tip and also at the last known-green sha: environment problem, not blamed, does not gate `main_red`. */
	infra: string[];
	mainRed: boolean;
	/** Survived `ESCALATE_AFTER_SWEEPS` sweeps: self-repair stops being admitted and a human is needed (see `setMainRed`). */
	escalated: boolean;
}

/** A tracked, still-unresolved regression: keyed by task id in `sweep_regressions`. */
interface TrackedRegression {
	since: number;
	attempts: number;
	lastCheckedAt: number;
	detail: string;
}

/** Sweeps a regression survives before self-repair is disabled and a human is asked. Exported so `InboxService` uses the same threshold for persistent infra failures. */
export const ESCALATE_AFTER_SWEEPS = 3;

/** Persisted infra alarm; `engineKv` value for `sweep_infra` and `verify_infra`. */
export interface InfraState {
	active: boolean;
	since: number;
	attempts: number;
	taskIds: string[];
	detail: string;
}

/**
 * Read-modify-write a persisted infra alarm at `key`: non-empty `taskIds` bumps
 * `attempts` and dates `since`; empty clears it. Shared by the sweep
 * (`sweep_infra`) and finalize-time verify (`verify_infra`) so both count toward
 * one threshold (`ESCALATE_AFTER_SWEEPS`). Not sticky: it clears itself.
 */
export async function updateInfraState(
	deps: { handle: ProjectDbHandle; bus: EventBus; now: () => number },
	key: string,
	taskIds: string[],
	detail: string,
	buildEvent: (value: InfraState) => Parameters<typeof appendEvent>[1],
): Promise<InfraState> {
	const [row] = await deps.handle.db
		.select()
		.from(engineKv)
		.where(eq(engineKv.key, key));
	const prev = row?.value as Partial<InfraState> | undefined;
	const active = taskIds.length > 0;
	const value: InfraState = active
		? {
				active: true,
				since: prev?.active ? (prev.since ?? deps.now()) : deps.now(),
				attempts: (prev?.active ? (prev.attempts ?? 0) : 0) + 1,
				taskIds,
				detail,
			}
		: { active: false, since: 0, attempts: 0, taskIds: [], detail: "" };
	const stored = await deps.handle.withTx(async (tx) => {
		const record: Record<string, unknown> = { ...value };
		await tx
			.insert(engineKv)
			.values({ key, value: record, updatedAt: new Date() })
			.onConflictDoUpdate({
				target: engineKv.key,
				set: { value: record, updatedAt: new Date() },
			});
		if (!active) return null;
		return appendEvent(tx, buildEvent(value));
	});
	if (stored) deps.bus.publish([stored]);
	return value;
}

/** The slice of a task the sweep actually needs to re-verify it. */
interface TaskWithDodRow {
	id: string;
	dod: DefinitionOfDone;
}

export interface GroomResult {
	staleClaimsReleased: number;
	promoted: string[];
}

export interface ReopenResult {
	/** Tasks whose commands ran this pass. */
	checked: string[];
	reopened: string[];
}

/**
 * How often one task's `reopen_when` commands may run. A parked task can wait
 * for days, and its command (a test suite, a probe of an external service)
 * is not free, so it is sampled rather than polled every tick.
 */
export const REOPEN_CHECK_INTERVAL_MS = 10 * 60_000;

export interface GcResult {
	runDirsPruned: number;
	worktreesRemoved: number;
}

export class Maintenance {
	private readonly now: () => number;

	private readonly leaseMs: number;

	private reopening = false;

	constructor(private readonly deps: MaintenanceDeps) {
		this.now = deps.now ?? (() => Date.now());
		this.leaseMs = deps.leaseMs ?? 15 * 60_000;
	}

	/**
	 * Re-run the DoD of every done task against the current integration branch; a
	 * failing task is reopened and main goes red.
	 *
	 * - Only tasks with a completed run of their own are swept: import-filed done
	 *   tasks were never verified, and their invented DoDs would falsely reopen
	 *   shipped features and redden main.
	 * - Unresolved regressions are tracked in `sweep_regressions` and re-verified
	 *   every sweep regardless of status, so a reopened task cannot let main go green.
	 * - A failure is corroborated against the last known-green sha
	 *   (`isInfrastructural`): a check that also fails there is infra, not a
	 *   regression. Signal deaths are classified earlier (`VerificationResult.crashed`).
	 * - Attribution is coarse: tasks sharing a check are all reopened when it
	 *   breaks, with no bisection.
	 * - `diff_against_base` is stripped from re-run checks: in the shared tip
	 *   worktree it is structurally false.
	 */
	private regressionCheckableDod(dod: DefinitionOfDone): DefinitionOfDone {
		return {
			verifier: dod.verifier,
			checks: dod.checks.filter(
				(c): c is Exclude<DoDCheck, { diff_against_base: boolean }> =>
					!("diff_against_base" in c),
			),
		};
	}

	async regressionSweep(
		limit = 25,
		signal?: AbortSignal,
	): Promise<SweepResult> {
		if (signal?.aborted) throw new Error("regression sweep preempted");
		const done = await this.deps.tasks.list("done");
		const verifiedHere = new Set(
			(await this.deps.registry.list({ states: ["completed"] }))
				.map((r) => r.taskId)
				.filter((id): id is string => !!id),
		);
		// Gate on the effective dod (task's own or project default), not the raw file field.
		const withDod = done
			.filter(
				(t) => this.deps.tasks.effectiveDod(t.dod) && verifiedHere.has(t.id),
			)
			.slice(-limit); // cap work

		const regressions = await this.getRegressions();
		// Tracked regressions absent from this `done` sample (reopened or blocked) are fetched and re-checked anyway. Deleted tasks or ones that lost their effective DoD drop out.
		const sampled = new Set(withDod.map((t) => t.id));
		const tracked: TaskWithDodRow[] = [];
		for (const id of Object.keys(regressions)) {
			if (sampled.has(id)) continue;
			const t = await this.deps.tasks.get(id);
			const dod = t ? this.deps.tasks.effectiveDod(t.dod) : null;
			if (!t || !dod) {
				delete regressions[id];
				continue;
			}
			tracked.push({ id: t.id, dod: this.regressionCheckableDod(dod) });
		}
		const toCheck: TaskWithDodRow[] = [
			...withDod.map((t) => ({
				id: t.id,
				dod: this.regressionCheckableDod(
					this.deps.tasks.effectiveDod(t.dod) as DefinitionOfDone,
				),
			})),
			...tracked,
		];

		if (toCheck.length === 0) {
			await this.setRegressions({});
			await this.setMainRed(false);
			return {
				checked: 0,
				broken: [],
				infra: [],
				mainRed: false,
				escalated: false,
			};
		}

		const wt = await this.sweepWorktree();
		if (!wt) {
			this.deps.log.warn("regression sweep skipped: no verify worktree");
			const affected = toCheck.map((task) => task.id);
			await this.setInfraState(
				affected,
				"the sweep could not create its detached verification worktree; " +
					"no task was checked or blamed, and main was not newly gated",
			);
			const red = await this.mainRedState();
			return {
				checked: 0,
				broken: Object.keys(regressions),
				infra: affected,
				mainRed: red.red,
				escalated: red.escalated,
			};
		}

		const infra: string[] = [];
		// Project merge checks are shared by every task: cache per check so each runs once at the tip; focused checks still run per task.
		const tipCheckResults = new Map<string, VerificationResult>();
		const infrastructureVerdicts = new Map<string, boolean>();
		const diagnosisVerdicts = new Map<
			string,
			"regression" | "environment" | "flaky"
		>();
		// Failing result for a residual regression this pass, so an escalation can quote the check's tail.
		const resultsByTask = new Map<string, VerificationResult>();
		let cleanPass = true;
		let tipSha = "";
		try {
			const baseSha = (await git(["rev-parse", "HEAD"], wt)).stdout.trim();
			tipSha = baseSha;
			const opts: VerifyOptions = {
				checkPrefix: this.deps.checkPrefix,
				envPolicy: this.deps.envPolicy,
				// A sweep must not be held up by one pathological check.
				defaultTimeoutMs: 5 * 60_000,
				signal,
			};
			for (const task of toCheck) {
				if (signal?.aborted) throw new Error("regression sweep preempted");
				const planFingerprint = JSON.stringify(task.dod);
				const checkResults: VerificationResult[] = [];
				for (const check of task.dod.checks) {
					const checkFingerprint = JSON.stringify(check);
					let checkResult = tipCheckResults.get(checkFingerprint);
					if (!checkResult) {
						checkResult = await verify(
							wt,
							{ verifier: task.dod.verifier, checks: [check] },
							baseSha,
							opts,
						);
						tipCheckResults.set(checkFingerprint, checkResult);
					}
					checkResults.push(checkResult);
				}
				const checks = checkResults.flatMap((entry) => entry.checks);
				const failing = checks.filter((check) => !check.ok);
				const result: VerificationResult = {
					passed: failing.length === 0,
					checks,
					crashed:
						failing.length > 0 &&
						failing.every((check) => check.classification === "crashed"),
				};
				if (result.passed) {
					delete regressions[task.id];
					continue;
				}

				// A signal death (SIGILL, SIGSEGV, OOM kill...) means the verifier died, not
				// that the task regressed. Classified at the point of failure since a rerun at
				// another commit would not reliably reproduce it.
				//
				// Any infra verdict below also clears a stale `regressions[task.id]` entry;
				// otherwise a check that can never pass the sweep (e.g. `diff_against_base`)
				// would latch main red.
				if (result.crashed) {
					infra.push(task.id);
					delete regressions[task.id];
					cleanPass = false;
					this.deps.log.warn(
						{ taskId: task.id },
						"sweep check was killed by a signal; treating this as an " +
							"infrastructure problem, not a regression",
					);
					continue;
				}

				// A timeout is infra, not a question for the brain. Classify the task as infra only when every failure has that class; another ordinary failure is still considered below.
				const failingChecks = result.checks.filter((c) => !c.ok);
				if (
					failingChecks.length > 0 &&
					failingChecks.every((c) => c.classification === "timeout")
				) {
					infra.push(task.id);
					delete regressions[task.id];
					cleanPass = false;
					this.deps.log.warn(
						{ taskId: task.id },
						"sweep check timed out; treating this as an infrastructure problem, not asking the brain",
					);
					continue;
				}

				let infrastructural = infrastructureVerdicts.get(planFingerprint);
				if (infrastructural === undefined) {
					infrastructural = await this.isInfrastructural(
						wt,
						task.dod,
						baseSha,
						opts,
					);
					infrastructureVerdicts.set(planFingerprint, infrastructural);
				}
				if (infrastructural) {
					infra.push(task.id);
					delete regressions[task.id];
					cleanPass = false;
					this.deps.log.warn(
						{ taskId: task.id },
						"sweep check failed, but also fails at the last known-green commit; " +
							"treating this as an infrastructure problem, not a regression",
					);
					continue;
				}

				// Residual case: failed at tip, not corroborated as infra (no green baseline,
				// or it passes at green). Corroboration cannot tell a flake from a regression,
				// so ask the brain (advisory; deterministic verdicts above are never asked).
				let diagnosed = diagnosisVerdicts.get(planFingerprint);
				if (!diagnosed) {
					diagnosed = await this.diagnoseVerdict(task.id, result, opts);
					diagnosisVerdicts.set(planFingerprint, diagnosed);
				}
				if (diagnosed === "environment" || diagnosed === "flaky") {
					infra.push(task.id);
					delete regressions[task.id];
					cleanPass = false;
					this.deps.log.warn(
						{ taskId: task.id, verdict: diagnosed },
						`sweep check failed, but the brain diagnosed it as ${
							diagnosed === "flaky"
								? "flaky, not a regression"
								: "an environment problem, not a regression"
						}`,
					);
					continue;
				}

				cleanPass = false;
				const detail = result.checks
					.filter((c) => !c.ok)
					.map((c) => c.check)
					.join(", ");
				resultsByTask.set(task.id, result);
				const existing = regressions[task.id];
				regressions[task.id] = {
					since: existing?.since ?? this.now(),
					attempts: (existing?.attempts ?? 0) + 1,
					lastCheckedAt: this.now(),
					detail,
				};
				// A failed shared check is an incident against the tip, not proof this task caused it. Never move completed cards backwards from a sweep.
			}
			if (cleanPass) await this.setLastGreenSha(baseSha);
		} finally {
			await this.removeSweepWorktree(wt);
		}

		await this.setRegressions(regressions);
		await this.setInfraState(infra);

		// Earliest-flagged unresolved regression (deterministic). It is the single id the scheduler's self-repair exemption may admit through the red-main gate (see `Scheduler.tick()`'s `repairTaskId`).
		const brokenEntries = Object.entries(regressions).sort(
			(a, b) => a[1].since - b[1].since,
		);
		const brokenIds = brokenEntries.map(([id]) => id);
		// A task owning a DoD is not necessarily the one whose merge broke it. Attribute only when the event log shows one unambiguous merge since the last green tip; multiple candidates need diagnosis.
		const causeTaskId =
			brokenIds.length > 0
				? await this.unambiguousCauseTask(tipSha)
				: undefined;
		const escalated =
			(brokenEntries[0]?.[1].attempts ?? 0) >= ESCALATE_AFTER_SWEEPS;

		if (escalated && brokenEntries[0]) {
			await this.raiseMainRedSession(
				causeTaskId,
				brokenEntries[0]?.[1] as TrackedRegression,
				resultsByTask.get(brokenEntries[0][0]),
			);
		}
		await this.setMainRed(brokenIds.length > 0, causeTaskId, escalated);
		if (causeTaskId && !escalated && this.deps.startRepair) {
			const state = await this.mainRedState();
			if (!state.repairRunId) {
				const incidentId = `regression-${brokenEntries[0]?.[1].since ?? this.now()}`;
				const repair = await this.deps.startRepair(
					causeTaskId,
					incidentId,
					brokenEntries[0]?.[1].detail ?? "verification failed",
				);
				if (repair) await this.setRepairRun(repair.runId, incidentId);
			}
		}
		return {
			checked: toCheck.length,
			broken: brokenIds,
			infra,
			mainRed: brokenIds.length > 0,
			escalated,
		};
	}

	/**
	 * Whether a failing check also fails at the last sweep-confirmed green commit
	 * (so it is infra, not this task's regression).
	 *
	 * If that commit is the current tip the code is unchanged, so the failure
	 * cannot be a code regression and no second checkout is needed. Otherwise check
	 * out the green sha, re-run, then restore the tip. With no baseline, the
	 * failure is trusted.
	 *
	 * `!corroboration.passed` also treats a signal death at green as infrastructural:
	 * the tip run was already ruled not-a-crash, so this is a second unknown-cause
	 * failure.
	 */
	private async isInfrastructural(
		wt: string,
		dod: DefinitionOfDone,
		tipSha: string,
		opts: VerifyOptions,
	): Promise<boolean> {
		const green = await this.getLastGreenSha();
		if (!green) return false;
		if (green === tipSha) return true;

		// `-f`: the worktree is a disposable copy, and DoD checks may legitimately
		// modify tracked files (formatter, codegen, lockfile). Without it a checkout
		// can refuse, and an unchecked failed restore would make later tasks verify
		// against the wrong commit.
		const co = await git(["checkout", "--detach", "-f", "-q", green], wt);
		let corroboration: VerificationResult = {
			passed: true,
			checks: [],
			crashed: false,
		};
		if (co.exitCode === 0) {
			await this.linkDependencies(wt);
			corroboration = await verify(wt, dod, green, opts);
		}
		const restore = await git(["checkout", "--detach", "-f", "-q", tipSha], wt);
		if (restore.exitCode !== 0) {
			// Force still failing means the worktree state is unknown: abort the sweep rather than mis-verify the remaining tasks. `regressionSweep`'s `finally` tears the worktree down and nothing is persisted for an unfinished pass.
			throw new Error(
				`regression sweep could not restore its worktree to the tip after corroborating at ${green}: ${restore.stderr || restore.stdout}`,
			);
		}
		await this.linkDependencies(wt);
		return !corroboration.passed;
	}

	/**
	 * Advisory brain second opinion for a failure `isInfrastructural` did not
	 * place: no green baseline, or the check passes at green. This is
	 * corroboration's blind spot (real regression vs flake).
	 *
	 * Disabled, absent or failed calls default to `"regression"`, so turning the
	 * brain off never misses a real regression.
	 */
	private async raiseMainRedSession(
		causeTaskId: string | undefined,
		tracked: TrackedRegression,
		lastResult: VerificationResult | undefined,
	): Promise<void> {
		if (!this.deps.sessions) return;
		const green = await this.getLastGreenSha();
		const tail = lastResult
			? lastResult.checks
					.filter((c) => !c.ok)
					.map(
						(c) =>
							`- [${c.classification ?? "failed"}] ${c.check}\n${(c.detail ?? "").trim() || "(no output captured)"}`,
					)
					.join("\n\n")
			: `(no fresh output this pass; last seen: ${tracked.detail})`;
		await this.deps.sessions
			.raise({
				source: "main_red",
				sourceKey: causeTaskId ?? `regression-${tracked.since}`,
				...(causeTaskId ? { taskId: causeTaskId } : {}),
				title: causeTaskId
					? `main is red: ${causeTaskId} has not cleared after repeated attempts`
					: "main is red: the introducing merge is ambiguous",
				summary:
					`The regression sweep has re-checked ${causeTaskId ?? "the failing check"} ${tracked.attempts} ` +
					`times since ${new Date(tracked.since).toISOString()} and its DoD still ` +
					`fails at the integration branch's tip. Merges have been paused this whole ` +
					`time (main_red), and self-repair (if it was ever admitted through the ` +
					`breaker for this cause) has not landed a fix.\n\n` +
					`Last observed output (tail, not head):\n${tail}`,
				whatWasTried: [
					`re-verified ${tracked.attempts} time(s) across separate sweeps, most recently ${new Date(tracked.lastCheckedAt).toISOString()}`,
					green
						? `corroborated against the last known-green commit (${green}); the same check passes there, so this is not an artifact of the sweep's own environment`
						: "no known-green commit exists yet to corroborate against",
					this.deps.diagnose?.enabled
						? "the brain's second opinion (diagnose) was consulted on this failure and also read it as a real regression, not a flake or an environment problem"
						: "the brain was not consulted (disabled); no second opinion beyond the deterministic checks above",
				],
				environment:
					"The sweep runs in an EPHEMERAL worktree off the integration branch " +
					"(`.mfw/sweep`), torn down after every pass; it will be gone by the " +
					"time you read this. Its installed dependencies are a hard-linked " +
					"SNAPSHOT (`.mfw/sweep-deps`), not the live checkout, refreshed only " +
					"when the lockfile changes; a project whose workspace packages or " +
					"dependency layout are unusual can fail here in ways that do not " +
					"reproduce in your own shell (this exact gap once hid a real bug " +
					"for hours: see `Maintenance.shadowLink`'s doc comment). Reproduce " +
					"in a fresh worktree off the integration branch to rule that out " +
					"before trusting this as a genuine regression.",
				hypothesis:
					(causeTaskId
						? `The merge attributed to ${causeTaskId} is the only candidate since the last green tip. `
						: "More than one merge (or no recorded merge) separates the green and failing tips, so mfw refused to guess which task caused it. ") +
					"The check is failing on the " +
					"integration branch; corroboration ruled out \"the sweep's own " +
					'environment" as the cause (or found nothing to corroborate ' +
					"against yet), but it cannot rule out a flake, nor point at the " +
					"specific commit responsible if other work has merged since.",
			} satisfies RaiseInput)
			.catch((e) => {
				this.deps.log.warn(
					{ err: e, taskId: causeTaskId },
					"could not raise a session for the escalated main_red",
				);
			});
	}

	private async unambiguousCauseTask(
		tipSha: string,
	): Promise<string | undefined> {
		const green = await this.getLastGreenSha();
		if (!green || !tipSha || green === tipSha) return undefined;
		const candidates = await this.deps.handle.db
			.select()
			.from(eventRows)
			.where(eq(eventRows.type, "merge.completed"));
		const taskIds = new Set<string>();
		for (const event of candidates) {
			const sha = (event.payload as { sha?: string }).sha;
			if (!sha || !event.taskId) continue;
			const afterGreen = await git(
				["merge-base", "--is-ancestor", green, sha],
				this.deps.projectRoot,
			);
			const beforeTip = await git(
				["merge-base", "--is-ancestor", sha, tipSha],
				this.deps.projectRoot,
			);
			if (afterGreen.exitCode === 0 && beforeTip.exitCode === 0) {
				taskIds.add(event.taskId);
			}
		}
		return taskIds.size === 1 ? [...taskIds][0] : undefined;
	}

	private async diagnoseVerdict(
		taskId: string,
		result: VerificationResult,
		opts: VerifyOptions,
	): Promise<"regression" | "environment" | "flaky"> {
		if (!this.deps.diagnose?.enabled) return "regression";
		// Only the ambiguous residue goes to the model; facts already decided (e.g. a timeout beside an ambiguous failure) are not reinterpreted.
		const failing = result.checks.filter(
			(c) =>
				!c.ok &&
				c.classification !== "timeout" &&
				c.classification !== "crashed",
		);
		if (failing.length === 0) return "regression";
		const green = await this.getLastGreenSha();
		const exitCodes = new Set(failing.map((c) => c.exitCode));
		const outcome = await this.deps.diagnose
			.diagnose({
				taskId,
				check: failing.map((c) => c.check).join(", ") || "(unknown check)",
				outputTail: failing
					.map(
						(c) =>
							`- [${c.classification ?? "other"}] ${c.check}: ${c.detail ?? ""}`,
					)
					.join("\n"),
				exitCode: exitCodes.size === 1 ? (failing[0]?.exitCode ?? null) : null,
				environment: [
					"regression sweep in an ephemeral worktree off the integration branch",
					describeVerificationEnvironment(opts),
				].join("; "),
				// `isInfrastructural` already ruled out `false`: green is absent (unknown) or passed there (true).
				passesAtGreenSha: green === null ? null : true,
			})
			.catch(
				(e: unknown): DiagnoseResult => ({
					status: "failed",
					reason: e instanceof Error ? e.message : String(e),
				}),
			);
		return outcome.status === "ok" && outcome.verdict
			? outcome.verdict
			: "regression";
	}

	/** A throwaway checkout of the integration branch tip. */
	private async sweepWorktree(): Promise<string | null> {
		const dir = join(this.deps.projectRoot, ".mfw", "sweep");
		await this.removeSweepWorktree(dir);
		const r = await git(
			["worktree", "add", "--detach", "-q", dir, this.deps.integrationBranch],
			this.deps.projectRoot,
		);
		if (r.exitCode !== 0) {
			this.deps.log.warn({ err: r.stderr }, "sweep worktree add failed");
			return null;
		}
		await this.linkDependencies(dir);
		return dir;
	}

	/**
	 * Give the sweep the run's installed dependencies from a snapshot, not the live
	 * checkout: a bare worktree lacks gitignored packages (checks fail as false
	 * regressions), while symlinking the primary checkout let an in-progress
	 * install look like a regression.
	 *
	 * One snapshot under `.mfw/sweep-deps` is rebuilt only when the lockfile
	 * changes. It uses hard links (`cp -al`), so it costs inodes not bytes and later
	 * writes replace files instead of mutating them. Best effort: projects with no
	 * dependency directories link nothing.
	 */
	private async linkDependencies(dir: string): Promise<void> {
		const snapshot = await this.dependencySnapshot();
		if (!snapshot) return;
		const workspace = await this.workspacePackages(dir);
		for (const rel of snapshot.dirs) {
			try {
				await this.shadowLink(
					join(snapshot.root, rel),
					join(dir, rel),
					workspace,
					dir,
				);
			} catch (e) {
				// One unlinkable directory must not abort the sweep; the checks that
				// need it fail loudly with their own output.
				this.deps.log.debug({ err: e, rel }, "sweep dependency link skipped");
			}
		}
	}

	/**
	 * Mirror one snapshot dependency directory into the worktree as a real
	 * directory of per-entry symlinks, redirecting workspace packages to the
	 * worktree's own sources.
	 *
	 * Workspace packages are relative symlinks
	 * (`apps/start/node_modules/@mfw/api -> ../../../../packages/api`) that
	 * `cp -al` preserves but which then resolve inside the snapshot, where no
	 * sources exist; `@mfw/*` silently became unresolvable and typechecks failed as
	 * false regressions. Entries inside a symlinked directory cannot be replaced,
	 * hence per-entry links; scope directories (`@mfw`) are descended into for the
	 * same reason.
	 */
	private async shadowLink(
		src: string,
		dest: string,
		workspace: Map<string, string>,
		worktree: string,
	): Promise<void> {
		await mkdir(dest, { recursive: true });
		const entries = await readdir(src, { withFileTypes: true });
		for (const entry of entries) {
			// A scope is a plain directory of packages; package names are known one level down.
			if (entry.name.startsWith("@") && entry.isDirectory()) {
				const scope = join(dest, entry.name);
				await mkdir(scope, { recursive: true });
				for (const child of await readdir(join(src, entry.name))) {
					await this.linkPackage(
						`${entry.name}/${child}`,
						join(src, entry.name, child),
						join(scope, child),
						workspace,
						worktree,
					);
				}
				continue;
			}
			await this.linkPackage(
				entry.name,
				join(src, entry.name),
				join(dest, entry.name),
				workspace,
				worktree,
			);
		}
	}

	/** One `node_modules` entry: the worktree's own copy for a workspace package, else the snapshot's. */
	private async linkPackage(
		name: string,
		fromSnapshot: string,
		link: string,
		workspace: Map<string, string>,
		worktree: string,
	): Promise<void> {
		const own = workspace.get(name);
		const target = own ? join(worktree, own) : fromSnapshot;
		await symlink(target, link, "dir").catch((e) => {
			this.deps.log.debug({ err: e, name }, "sweep package link skipped");
		});
	}

	/**
	 * The worktree's own workspace packages by name (the sources under
	 * verification, not the primary checkout). Only `dir/*` and literal
	 * `workspaces` forms are expanded; other packages stay linked to the snapshot.
	 */
	private async workspacePackages(dir: string): Promise<Map<string, string>> {
		const out = new Map<string, string>();
		const root = await readFile(join(dir, "package.json"), "utf8")
			.then((raw) => JSON.parse(raw) as { workspaces?: unknown })
			.catch(() => null);
		const globs = Array.isArray(root?.workspaces)
			? (root.workspaces as unknown[]).filter(
					(w): w is string => typeof w === "string",
				)
			: [];
		for (const glob of globs) {
			const candidates: string[] = [];
			if (glob.endsWith("/*")) {
				const base = glob.slice(0, -2);
				const kids = await readdir(join(dir, base), {
					withFileTypes: true,
				}).catch(() => [] as Dirent[]);
				for (const kid of kids) {
					if (kid.isDirectory()) candidates.push(join(base, kid.name));
				}
			} else if (!glob.includes("*")) {
				candidates.push(glob);
			}
			for (const rel of candidates) {
				const name = await readFile(join(dir, rel, "package.json"), "utf8")
					.then((raw) => (JSON.parse(raw) as { name?: string }).name)
					.catch(() => undefined);
				if (name) out.set(name, rel);
			}
		}
		return out;
	}

	/** The dependency snapshot, rebuilt when the lockfile changed since it was taken. Null when there is nothing to snapshot. */
	private async dependencySnapshot(): Promise<{
		root: string;
		dirs: string[];
	} | null> {
		const root = join(this.deps.projectRoot, ".mfw", "sweep-deps");
		const stampFile = join(root, ".stamp.json");
		const stamp = await this.lockStamp();

		// A valid snapshot is used as-is with its recorded directory list; re-deriving it from the live checkout would reintroduce the coupling.
		const prev = await readFile(stampFile, "utf8")
			.then((raw) => JSON.parse(raw) as { stamp?: string; dirs?: string[] })
			.catch(() => null);
		if (prev?.stamp === stamp && prev.dirs && prev.dirs.length > 0) {
			return { root, dirs: prev.dirs };
		}

		const dirs = await this.dependencyDirs();
		if (dirs.length === 0) return null;

		await rm(root, { recursive: true, force: true });
		for (const rel of dirs) {
			const dest = join(root, rel);
			await mkdir(dirname(dest), { recursive: true });
			// `cp -al`: hard links; `-a` keeps symlinks as symlinks.
			const r = await runProc(
				["cp", "-al", join(this.deps.projectRoot, rel), dest],
				{ timeoutMs: 5 * 60_000 },
			);
			if (r.exitCode !== 0) {
				this.deps.log.warn(
					{ rel, err: tailOf(r.stderr) },
					"sweep dependency snapshot failed",
				);
				await rm(root, { recursive: true, force: true });
				return null;
			}
		}
		await writeFile(stampFile, JSON.stringify({ stamp, dirs }), "utf8").catch(
			() => {},
		);
		this.deps.log.info(
			{ dirs: dirs.length },
			"sweep dependency snapshot built",
		);
		return { root, dirs };
	}

	/** Identity of the installed set (lockfile size and mtime); moves whenever an install does. */
	private async lockStamp(): Promise<string> {
		const parts: string[] = [];
		for (const name of [
			"bun.lock",
			"bun.lockb",
			"package-lock.json",
			"yarn.lock",
		]) {
			const st = await stat(join(this.deps.projectRoot, name)).catch(
				() => null,
			);
			if (st) parts.push(`${name}:${st.size}:${st.mtimeMs}`);
		}
		return parts.join("|") || "none";
	}

	/** Installed-dependency directories in the primary checkout, relative to it. Never descends into a matched directory. */
	private async dependencyDirs(root = "", depth = 0): Promise<string[]> {
		if (depth > 3) return [];
		const abs = join(this.deps.projectRoot, root);
		let entries: Dirent[];
		try {
			entries = await readdir(abs, { withFileTypes: true });
		} catch {
			return [];
		}
		const out: string[] = [];
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const rel = root ? join(root, entry.name) : entry.name;
			if (entry.name === "node_modules") {
				out.push(rel);
				continue; // matched: do not walk inside it
			}
			// Skip places a checkout is not installed into, including our own `.mfw/sweep` and `.mfw/sweep-deps`.
			if (entry.name.startsWith(".") || entry.name === "worktrees") continue;
			out.push(...(await this.dependencyDirs(rel, depth + 1)));
		}
		return out;
	}

	private async removeSweepWorktree(dir: string): Promise<void> {
		await git(["worktree", "remove", "--force", dir], this.deps.projectRoot);
		await rm(dir, { recursive: true, force: true });
	}

	async isMainRed(): Promise<boolean> {
		return (await this.mainRedState()).red;
	}

	private async mainRedState(): Promise<{
		red: boolean;
		since: number;
		causeTaskId?: string;
		escalated: boolean;
		repairRunId?: string;
		incidentId?: string;
	}> {
		const [row] = await this.deps.handle.db
			.select()
			.from(engineKv)
			.where(eq(engineKv.key, "main_red"));
		const v = row?.value as
			| {
					red?: boolean;
					since?: number;
					causeTaskId?: string;
					escalated?: boolean;
					repairRunId?: string;
					incidentId?: string;
			  }
			| undefined;
		return {
			red: v?.red === true,
			since: v?.since ?? this.now(),
			causeTaskId: v?.causeTaskId,
			escalated: v?.escalated === true,
			repairRunId: v?.repairRunId,
			incidentId: v?.incidentId,
		};
	}

	/**
	 * Flip the breaker. The kv row is upserted every call (`escalated` can change
	 * while `red` stays true), but `main.red` fires only on an actual transition.
	 * `main.red_escalated` fires once, when a pass first crosses
	 * `ESCALATE_AFTER_SWEEPS`.
	 */
	async setMainRed(
		red: boolean,
		causeTaskId?: string,
		escalated = false,
	): Promise<void> {
		const prev = await this.mainRedState();
		const changed = prev.red !== red;
		const sameIncident = prev.red && prev.causeTaskId === causeTaskId;
		const since = changed || !sameIncident ? this.now() : prev.since;
		const value = {
			red,
			since,
			causeTaskId,
			escalated,
			...(red && sameIncident && prev.repairRunId
				? { repairRunId: prev.repairRunId }
				: {}),
			...(red
				? {
						incidentId:
							sameIncident && prev.incidentId
								? prev.incidentId
								: `regression-${since}`,
					}
				: {}),
		};
		const stored = await this.deps.handle.withTx(async (tx) => {
			await tx
				.insert(engineKv)
				.values({ key: "main_red", value, updatedAt: new Date() })
				.onConflictDoUpdate({
					target: engineKv.key,
					set: { value, updatedAt: new Date() },
				});
			const events = [];
			if (changed) {
				events.push(
					red
						? await appendEvent(tx, {
								type: "main.red",
								payload: {
									...(value.incidentId ? { incidentId: value.incidentId } : {}),
									...(causeTaskId ? { causeTaskId } : {}),
									detail: "regression sweep failed",
								},
							})
						: await appendEvent(tx, { type: "main.green", payload: {} }),
				);
			}
			if (escalated && !prev.escalated && causeTaskId) {
				events.push(
					await appendEvent(tx, {
						type: "main.red_escalated",
						payload: { causeTaskId },
					}),
				);
			}
			return events;
		});
		if (stored.length > 0) this.deps.bus.publish(stored);
		if (changed || escalated !== prev.escalated) {
			this.deps.log.warn(
				{ red, causeTaskId, escalated },
				"main health changed",
			);
		}
	}

	private async setRepairRun(runId: string, incidentId: string): Promise<void> {
		const current = await this.mainRedState();
		if (!current.red) return;
		const value = { ...current, repairRunId: runId, incidentId };
		const stored = await this.deps.handle.withTx(async (tx) => {
			await tx
				.insert(engineKv)
				.values({ key: "main_red", value, updatedAt: new Date() })
				.onConflictDoUpdate({
					target: engineKv.key,
					set: { value, updatedAt: new Date() },
				});
			return appendEvent(tx, {
				type: "recovery.started",
				...(current.causeTaskId ? { taskId: current.causeTaskId } : {}),
				runId,
				payload: { incidentId },
			});
		});
		this.deps.bus.publish([stored]);
	}

	/** Unresolved regressions by task id; persists across sweeps so a reopened task stays checked. */
	private async getRegressions(): Promise<Record<string, TrackedRegression>> {
		const [row] = await this.deps.handle.db
			.select()
			.from(engineKv)
			.where(eq(engineKv.key, "sweep_regressions"));
		return (row?.value as Record<string, TrackedRegression> | undefined) ?? {};
	}

	private async setRegressions(
		value: Record<string, TrackedRegression>,
	): Promise<void> {
		await this.deps.handle.db
			.insert(engineKv)
			.values({ key: "sweep_regressions", value, updatedAt: new Date() })
			.onConflictDoUpdate({
				target: engineKv.key,
				set: { value, updatedAt: new Date() },
			});
	}

	/** Last commit the sweep confirmed fully clean; the baseline corroboration checks against. */
	private async getLastGreenSha(): Promise<string | null> {
		const [row] = await this.deps.handle.db
			.select()
			.from(engineKv)
			.where(eq(engineKv.key, "sweep_last_green_sha"));
		return (row?.value as { sha?: string } | undefined)?.sha ?? null;
	}

	private async setLastGreenSha(sha: string): Promise<void> {
		const value = { sha, at: this.now() };
		await this.deps.handle.db
			.insert(engineKv)
			.values({ key: "sweep_last_green_sha", value, updatedAt: new Date() })
			.onConflictDoUpdate({
				target: engineKv.key,
				set: { value, updatedAt: new Date() },
			});
	}

	/** Persisted visibility for the infra case: as unmissable as a regression but gates nothing. Clears itself when a pass finds nothing infrastructural. */
	private async setInfraState(
		taskIds: string[],
		detail = "a check either crashed (killed by a signal) or also fails at the " +
			"last commit the sweep confirmed green; this looks like a sweep, " +
			"toolchain, or infrastructure problem, not a code regression",
	): Promise<void> {
		await updateInfraState(
			{ handle: this.deps.handle, bus: this.deps.bus, now: this.now },
			"sweep_infra",
			taskIds,
			detail,
			(value) => ({
				type: "sweep.infra_failure",
				payload: { taskIds: value.taskIds, attempts: value.attempts },
			}),
		);
	}

	/**
	 * Audit the whole `in_progress` column, including tasks never claimed: a live
	 * run keeps its task, anything else is released. Also promotes newly eligible
	 * tasks. Safety net for crashes between claim and run start and for hand edits.
	 *
	 * A draft mid-expansion holds a claim (`claimedByRunId` + lease) but stays in
	 * `draft`, so the scan above never sees it, and `expireStaleLeases` is never
	 * called. A claim orphaned by a crash would leave the card "expanding" forever,
	 * so drafts are audited the same way: a live run keeps the claim (lease
	 * renewed), else it is released to unclaimed `draft`.
	 */
	async groom(): Promise<GroomResult> {
		const inProgress = await this.deps.tasks.list("in_progress");
		let released = 0;
		for (const task of inProgress) {
			if (task.claimedByRunId) {
				const run = await this.deps.registry.get(task.claimedByRunId);
				const live = run && CLAIM_HOLDING_RUN_STATES.includes(run.state);
				// A live run keeps its task. Releasing on lease age alone handed it to a second agent mid-run; the run row is authoritative and stale rows are fixed by the supervisor or boot reconciliation.
				if (
					live ||
					(await this.deps.registry.hasPendingCleanup(task.claimedByRunId))
				) {
					await this.deps.tasks.renewLease(task.claimedByRunId, this.leaseMs);
					continue;
				}
			}
			// Keyed on the claim seen above: if it moved to a new run, `release` no-ops. A task with no claim matches `expectedRunId: null` and goes back to `ready` with a reason saying so.
			const rec = await this.deps.tasks.release(
				task.id,
				task.claimedByRunId,
				"ready",
				"boot",
				task.claimedByRunId
					? "claiming run is no longer active"
					: "in_progress task had no claim or live run",
			);
			if (rec) released++;
		}

		const drafts = await this.deps.tasks.list("draft");
		for (const task of drafts) {
			if (!task.claimedByRunId) continue;
			const run = await this.deps.registry.get(task.claimedByRunId);
			const live = run && CLAIM_HOLDING_RUN_STATES.includes(run.state);
			if (
				live ||
				(await this.deps.registry.hasPendingCleanup(task.claimedByRunId))
			) {
				await this.deps.tasks.renewLease(task.claimedByRunId, this.leaseMs);
				continue;
			}
			const rec = await this.deps.tasks.release(
				task.id,
				task.claimedByRunId,
				"draft",
				"boot",
				"draft expansion run is no longer active",
			);
			if (rec) released++;
		}

		const promoted = await this.deps.tasks.promoteReady();
		return { staleClaimsReleased: released, promoted };
	}

	/** Command predicates are inert until armed by an operator outside the
	 * repository. Every attempt is audited before executing and after finishing. */
	async reopenByCommand(signal?: AbortSignal): Promise<ReopenResult> {
		const result: ReopenResult = { checked: [], reopened: [] };
		if (
			this.reopening ||
			(this.deps.dispatching && !(await this.deps.dispatching()))
		)
			return result;
		this.reopening = true;
		try {
			for (const candidate of this.deps.tasks.reopenCommandCandidates()) {
				if (signal?.aborted) break;
				const hash = reopenDefinitionHash(
					candidate.conditions,
					this.deps.checkPrefix,
					this.deps.integrationBranch,
				);
				const policy = (
					await loadReopenPolicies(this.deps.projectRoot, this.deps.mfwHome)
				)[candidate.id];
				if (!policy || policy.hash !== hash) continue;
				const key = `reopen_check:${candidate.id}`;
				const [previous] = await this.deps.handle.db
					.select()
					.from(engineKv)
					.where(eq(engineKv.key, key));
				const last = previous?.value as { at?: number } | undefined;
				if (
					last?.at !== undefined &&
					this.now() - last.at < REOPEN_CHECK_INTERVAL_MS
				)
					continue;
				const attemptId = randomUUID();
				const audit = {
					attemptId,
					definitionHash: hash,
					checkout: policy.checkout,
				};
				const started = await this.deps.handle.withTx(async (tx) => {
					await tx
						.insert(engineKv)
						.values({
							key,
							value: { at: this.now(), hash, attemptId },
							updatedAt: new Date(),
						})
						.onConflictDoUpdate({
							target: engineKv.key,
							set: {
								value: { at: this.now(), hash, attemptId },
								updatedAt: new Date(),
							},
						});
					return appendEvent(tx, {
						type: "task.reopen_check",
						taskId: candidate.id,
						payload: {
							...audit,
							phase: "started",
							detail: JSON.stringify(candidate.conditions),
						},
					});
				});
				this.deps.bus.publish([started]);
				result.checked.push(candidate.id);
				let temporary: string | undefined;
				let outcome: "passed" | "failed" | "error" = "error";
				let detail = "";
				try {
					let cwd = this.deps.projectRoot;
					if (policy.checkout === "integration-worktree") {
						temporary = await mkdtemp(join(tmpdir(), "mfw-reopen-check-"));
						cwd = join(temporary, "checkout");
						const added = await git(
							[
								"worktree",
								"add",
								"--detach",
								"-q",
								cwd,
								this.deps.integrationBranch,
							],
							this.deps.projectRoot,
						);
						if (added.exitCode !== 0)
							throw new Error(
								added.stderr || "could not create reopen verification worktree",
							);
					}
					const verified = await verify(
						cwd,
						{ verifier: "deterministic", checks: candidate.commands },
						"",
						{
							checkPrefix: this.deps.checkPrefix,
							envPolicy: this.deps.envPolicy,
							defaultTimeoutMs: 5 * 60_000,
							signal,
						},
					);
					outcome = verified.passed ? "passed" : "failed";
					detail = JSON.stringify({
						conditions: candidate.conditions,
						result: verified,
					});
				} catch (error) {
					detail = error instanceof Error ? error.message : String(error);
				} finally {
					if (temporary) {
						await git(
							["worktree", "remove", "--force", join(temporary, "checkout")],
							this.deps.projectRoot,
						);
						await rm(temporary, { recursive: true, force: true });
					}
					const finished = await this.deps.handle.withTx((tx) =>
						appendEvent(tx, {
							type: "task.reopen_check",
							taskId: candidate.id,
							payload: { ...audit, phase: "finished", outcome, detail },
						}),
					);
					this.deps.bus.publish([finished]);
				}
				const stillArmed = (
					await loadReopenPolicies(this.deps.projectRoot, this.deps.mfwHome)
				)[candidate.id];
				if (
					outcome === "passed" &&
					stillArmed?.hash === hash &&
					(!this.deps.dispatching || (await this.deps.dispatching())) &&
					(await this.deps.tasks.reopen(candidate.id, candidate.conditions))
				)
					result.reopened.push(candidate.id);
			}
		} finally {
			this.reopening = false;
		}
		return result;
	}

	/**
	 * Start (or retry) an expansion pass for every `draft` not already
	 * mid-expansion. Gated on the same `dispatching` switch as the scheduler. The
	 * per-task attempt cap is `TaskService.recordDraftExpandFailure`;
	 * `maxConcurrentDraftExpansions` caps starts per sweep.
	 */
	async expandDrafts(): Promise<{ started: string[] }> {
		if (!this.deps.startExpand) return { started: [] };
		if (this.deps.dispatching && !(await this.deps.dispatching())) {
			return { started: [] };
		}
		const cap = this.deps.maxConcurrentDraftExpansions ?? 1;
		const live = await this.deps.registry.list({
			kinds: ["plan"],
			states: [...CLAIM_HOLDING_RUN_STATES],
		});
		const busy = new Set(
			live.filter((r) => r.taskId != null).map((r) => r.taskId as string),
		);
		let inFlight = busy.size;
		const started: string[] = [];
		if (inFlight >= cap) return { started };

		const drafts = (await this.deps.tasks.list()).filter(
			(t) =>
				t.status === "draft" &&
				(t.draftPhase === "queued" || t.draftPhase === "retrying"),
		);
		for (const t of drafts) {
			if (inFlight >= cap) break;
			if (busy.has(t.id)) continue;
			const prompt = t.draftPrompt || t.body || t.title;
			try {
				await this.deps.startExpand(t.id, prompt);
				started.push(t.id);
				inFlight++;
			} catch (e) {
				this.deps.log.error(
					{ err: e, taskId: t.id },
					"draft expansion failed to start",
				);
			}
		}
		return { started };
	}

	/**
	 * Bounded history: prune old terminal run directories, and remove only
	 * positively owned, clean, integrated worktrees no live run or preserved-work
	 * pointer still references. Historical rows never authorize branch deletion.
	 */
	async gc(opts: { keepRuns?: number } = {}): Promise<GcResult> {
		const keepRuns = opts.keepRuns ?? 200;
		const allRuns = await this.deps.registry.list({});
		const pendingCleanup = new Set<string>();
		for (const run of allRuns) {
			if (await this.deps.registry.hasPendingCleanup(run.id))
				pendingCleanup.add(run.id);
		}

		// --- run dirs ---
		const terminal = await this.deps.registry.list({
			states: [
				"completed",
				"failed",
				"killed",
				"interrupted",
				"rate_limited",
				"finalize_error",
			],
		});
		terminal.sort(
			(a, b) =>
				(b.finishedAt ?? b.startedAt).getTime() -
				(a.finishedAt ?? a.startedAt).getTime(),
		);
		let runDirsPruned = 0;
		for (const run of terminal.slice(keepRuns)) {
			if (pendingCleanup.has(run.id)) continue;
			await rm(this.deps.registry.runDir(run.id), {
				recursive: true,
				force: true,
			});
			runDirsPruned++;
		}

		// --- worktrees + branches ---
		const wm = new WorktreeManager(this.deps.projectRoot);
		const liveStates = new Set<string>([
			"starting",
			"running",
			"ended",
			"finalizing",
			"merging",
			// An import parked for human approval keeps its branch and worktree: they are the work being judged.
			"needs_review",
		]);
		const liveRuns = allRuns.filter(
			(run) => liveStates.has(run.state) || pendingCleanup.has(run.id),
		);
		const allTasks = await this.deps.tasks.list();
		const preserved = new Set(
			allTasks.map((t) => t.preservedWorktree).filter((p): p is string => !!p),
		);
		// Tasks in review or blocked keep their worktree even without a preserved pointer (T14/T15 release without a gc step).
		const awaitingHuman = new Set(
			allTasks
				.filter((t) => t.status === "review" || t.status === "blocked")
				.map((t) => t.id),
		);
		for (const run of allRuns) {
			if (run.taskId && awaitingHuman.has(run.taskId) && run.worktreePath) {
				preserved.add(run.worktreePath);
			}
		}
		const keepPaths = new Set([
			...liveRuns
				.map((run) => run.worktreePath)
				.filter((path): path is string => !!path)
				.map((path) => resolve(path)),
			...[...preserved].map((path) => resolve(path)),
		]);

		// Git lists every repository worktree; only those with the durable identity
		// from WorktreeManager.create() (`<repo>/worktrees/<runId>` on branch
		// `mfw/<runId>`) are removable. The creator row supplies the base SHA, so
		// manual/IDE/terminal-manager worktrees are never candidates.
		const registered = new Set((await wm.list()).map((path) => resolve(path)));
		const ownedCandidates = new Map<
			string,
			{ branch: string; baseSha: string }
		>();
		for (const run of allRuns) {
			if (!run.worktreePath || !run.branch || !run.baseSha) continue;
			const path = resolve(run.worktreePath);
			if (path !== resolve(wm.dir, run.id)) continue;
			if (run.branch !== `mfw/${run.id}`) continue;
			if (!registered.has(path)) continue;
			const durableOwner = await wm.ownership(path);
			if (
				!durableOwner ||
				durableOwner.runId !== run.id ||
				durableOwner.branch !== run.branch ||
				durableOwner.baseSha !== run.baseSha
			) {
				continue;
			}
			ownedCandidates.set(path, {
				branch: run.branch,
				baseSha: run.baseSha,
			});
		}

		let worktreesRemoved = 0;
		for (const [path, owned] of ownedCandidates) {
			if (keepPaths.has(path)) continue;

			// Never erase work: preserve a dirty tree or a branch whose tip has not landed. GC is not a finalizer.
			const localChanges = await wm.hasLocalChanges({ path }).catch(() => true);
			const branch = await git(["symbolic-ref", "--short", "HEAD"], path);
			const integrated = await git(
				[
					"merge-base",
					"--is-ancestor",
					owned.branch,
					this.deps.integrationBranch,
				],
				this.deps.projectRoot,
			);
			if (
				localChanges ||
				branch.exitCode !== 0 ||
				branch.stdout.trim() !== owned.branch ||
				integrated.exitCode !== 0
			) {
				this.deps.log.warn(
					{ path, branch: owned.branch },
					"preserving MFW worktree because clean integrated state is not proven",
				);
				continue;
			}

			try {
				await wm.remove(
					{ path, branch: owned.branch, baseSha: owned.baseSha },
					{ force: false, deleteBranch: false },
				);
			} catch (error) {
				this.deps.log.warn(
					{ path, error },
					"preserving MFW worktree because Git refused removal",
				);
				continue;
			}
			worktreesRemoved++;
		}
		await git(["worktree", "prune"], this.deps.projectRoot);

		// Branch refs are deleted only with a freshly proven owned worktree (compare-and-delete); historical rows never authorize it, since a human may have recreated the branch name.
		return { runDirsPruned, worktreesRemoved };
	}

	/** The scheduler's maintenance hook: everything, failures logged not hidden. */
	async tick(signal?: AbortSignal): Promise<void> {
		for (const [name, fn] of [
			["groom", () => this.groom()],
			["reopenByCommand", () => this.reopenByCommand(signal)],
			["expandDrafts", () => this.expandDrafts()],
			["gc", () => this.gc()],
			["regressionSweep", () => this.regressionSweep(25, signal)],
		] as const) {
			try {
				const result = await fn();
				this.deps.log.debug({ maintenance: name, result }, "maintenance step");
			} catch (e) {
				if (signal?.aborted) throw e;
				// Never silent: a swallowed failure made a stopped sweep look like a passing one.
				this.deps.log.error({ err: e, step: name }, "maintenance step failed");
			}
		}
	}
}

/** Last few lines of a command's stderr, for a log line that stays readable. */
function tailOf(s: string): string {
	return s.trimEnd().split("\n").slice(-3).join("\n");
}
