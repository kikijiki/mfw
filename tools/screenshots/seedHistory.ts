/**
 * Writes a project's run history into its SQLite database and run
 * directories, through the db package's own writers (`appendEvent`, which
 * derives the span timeline in the same transaction; `recordSpend`;
 * `backfillAttemptOutcomes`) and the same row shapes the daemon writes
 * (`BrainActionService.act`, `RunRegistry.create`).
 *
 * Why not a fake agent through the real daemon: every dispatch path ends in a
 * tmux session running a driver, and the engine's test seam for swapping the
 * driver (`adapters.driverOverride`) is only reachable in-process. A dev
 * server cannot take it, and a run takes minutes of wall clock, so history
 * would be minutes old instead of days. Writing rows through the same
 * writers, offline and in time order, gives the full history with controlled
 * timestamps and costs. The board itself (tasks, ADRs) is written through
 * `mfwb`, and the daemon still reads and supervises everything at boot.
 */

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MfwEvent } from "@mfw/core/events";
import { openProjectDb, type ProjectDbTx } from "@mfw/db/client";
import { appendEvent } from "@mfw/db/eventlog";
import { ulid } from "@mfw/db/ids";
import { backfillAttemptOutcomes } from "@mfw/db/outcomes";
import {
	brainActions,
	brainSessions,
	brainTurns,
	decisions,
	events,
	mergeJobs,
	reviewComments,
	reviewVerdicts,
	runGroups,
	runSteps,
	runs,
} from "@mfw/db/schema";
import { recordSpend } from "@mfw/db/spend";
import { and, eq, lte, max } from "drizzle-orm";
import {
	parseAgo,
	type SeedBrainAction,
	type SeedProject,
	type SeedRun,
} from "./plan.ts";
import type { RunGit } from "./seedRepos.ts";

const MIN = 60_000;

export interface HistoryInput {
	project: SeedProject;
	/** The repository root: `.mfw/` lives here. */
	root: string;
	seedNow: number;
	taskIds: Map<string, string>;
	runIds: Map<string, string>;
	groupIds: Map<string, string>;
	runGit: Map<string, RunGit>;
	hostname: string;
}

export interface HistoryResult {
	/** The event seq just before the "you were away" window (for Since you left). */
	seenSeq: number;
	brainSessionId: string | null;
	eventCount: number;
}

interface Op {
	ts: number;
	/** Tie-break inside one instant. */
	order: number;
	apply(tx: ProjectDbTx): Promise<void>;
}

const harnessVendor = (h: string) =>
	h === "codex-cli" ? "openai" : "anthropic";

function transcript(
	run: SeedRun,
	taskTitle: string,
	startMs: number,
	endMs: number,
	live: boolean,
	sessionId: string,
): string {
	const lines: Record<string, unknown>[] = [];
	let seq = 0;
	const total = Math.max(1, endMs - startMs);
	const stamp = (frac: number) =>
		new Date(startMs + total * frac).toISOString();
	const push = (frac: number, e: Record<string, unknown>) =>
		lines.push({ ts: stamp(frac), seq: seq++, ...e });

	push(0, {
		type: "hello",
		provider: run.harness,
		capabilities: { steer: true, interrupt: true, approvals: true, plan: true },
	});
	push(0.01, {
		type: "session",
		provider: run.harness,
		sessionId,
		status: "started",
		ordinal: 0,
	});
	push(0.02, {
		type: "message",
		role: "user",
		text: `Task: ${taskTitle}\n\nWork in your worktree, commit when the checks pass, and report in MFW_REPORT.json.`,
	});
	push(0.05, {
		type: "thinking",
		text: "Read the task and the files it owns before changing anything; keep the diff inside the declared scope.",
	});
	const files = Object.keys(run.change?.files ?? {});
	let n = 0;
	const call = (
		frac: number,
		name: string,
		input: unknown,
		output: string,
		ok = true,
	) => {
		const id = `toolu_${run.alias}_${++n}`;
		push(frac, { type: "tool_call", id, name, input });
		push(frac + 0.004, { type: "tool_result", id, ok, output });
	};
	call(
		0.08,
		"Grep",
		{ pattern: "export", path: "src" },
		"src/server.ts\nsrc/routes/health.ts\nsrc/middleware/auth.ts",
	);
	call(
		0.12,
		"Read",
		{ file_path: "src/server.ts" },
		'import { Hono } from "hono";\n// ...',
	);
	files.forEach((f, i) => {
		const frac = 0.2 + (0.5 * (i + 1)) / (files.length + 1);
		call(
			frac,
			f.startsWith("test/") ? "Write" : "Edit",
			{ file_path: f },
			`Updated ${f}`,
		);
		push(frac + 0.01, {
			type: "usage",
			inputTokens: Math.round(run.tokensIn * frac),
			outputTokens: Math.round(run.tokensOut * frac),
			cachedInputTokens: Math.round(run.tokensIn * frac * 0.6),
			cumulative: true,
			costUsd: Number((run.costUsd * frac).toFixed(2)),
		});
	});

	if (live && run.activity === "needs_answer" && run.question) {
		push(0.8, {
			type: "message",
			role: "assistant",
			text: "The retry schedule is straightforward, but one policy decision is not mine to make.",
		});
		const id = `toolu_${run.alias}_ask`;
		push(0.82, {
			type: "tool_call",
			id,
			name: "AskUserQuestion",
			input: {
				questions: [
					{
						question: run.question.text,
						header: "Retry policy",
						options: (run.question.options ?? []).map((label) => ({ label })),
					},
				],
			},
		});
		return `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
	}

	if (live) {
		push(0.85, {
			type: "message",
			role: "assistant",
			text: "Editing the response middleware now; running the type check next.",
		});
		push(0.95, {
			type: "tool_call",
			id: `toolu_${run.alias}_run`,
			name: "Bash",
			input: { command: "bun run typecheck && bun test" },
		});
		return `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
	}

	if (run.checks) {
		const failed = run.checks.some((c) => !c.passed);
		call(
			0.8,
			"Bash",
			{ command: "bun run typecheck && bun test" },
			failed
				? "1 fail\n(fail) logging > redacts the Authorization header"
				: "12 pass\n0 fail",
			!failed,
		);
	}
	push(0.95, {
		type: "message",
		role: "assistant",
		text: run.summary ?? "Done.",
	});
	push(0.99, {
		type: "usage",
		inputTokens: run.tokensIn,
		outputTokens: run.tokensOut,
		cachedInputTokens: Math.round(run.tokensIn * 0.6),
		cumulative: true,
		costUsd: run.costUsd,
		turns: 6,
	});
	push(1, {
		type: "done",
		reason: run.end === "interrupted" ? "interrupted" : "complete",
	});
	return `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
}

/** Everything one project's history needs, applied in time order. */
export async function seedHistory(input: HistoryInput): Promise<HistoryResult> {
	const { project, root, seedNow } = input;
	const handle = await openProjectDb(join(root, ".mfw"));
	const at = (ago: string) => seedNow - parseAgo(ago) * MIN;
	const taskId = (alias: string) => {
		const id = input.taskIds.get(alias);
		if (!id) throw new Error(`no task id for ${alias}`);
		return id;
	};
	const runId = (alias: string) => {
		const id = input.runIds.get(alias);
		if (!id) throw new Error(`no run id for ${alias}`);
		return id;
	};
	const runsDir = join(root, ".mfw", "runs");
	const ops: Op[] = [];
	let order = 0;
	const op = (ts: number, apply: Op["apply"]) =>
		ops.push({ ts, order: order++, apply });
	const ev = (ts: number, e: MfwEvent) =>
		op(ts, async (tx) => {
			await appendEvent(tx, e, ts);
		});
	const titleOf = new Map(input.project.tasks.map((t) => [t.alias, t.title]));

	// ---- tasks ----
	for (const t of project.tasks) {
		const id = taskId(t.alias);
		ev(at(t.created), {
			type: "task.created",
			taskId: id,
			payload: { source: "human", title: t.title },
		});
		// Where a task starts before its first recorded move: the template's entry status.
		let from =
			project.template === "mfw-default"
				? "backlog"
				: project.template === "planning"
					? "planned"
					: "todo";
		for (const m of t.moves ?? []) {
			if (m.to !== from) {
				ev(at(m.ago), {
					type: "task.status_changed",
					taskId: id,
					payload: {
						from,
						to: m.to,
						actor: (m.actor ?? "scheduler") as "scheduler",
						...(m.reason ? { reason: m.reason } : {}),
					},
				});
			}
			from = m.to;
		}
	}

	// ---- groups ----
	for (const g of project.groups ?? []) {
		const gid = input.groupIds.get(g.alias) as string;
		const created = at(g.start);
		ops.push({
			ts: created,
			order: order++,
			apply: async (tx) => {
				await tx.insert(runGroups).values({
					id: gid,
					taskId: taskId(g.task),
					kind: "competing",
					selection: g.selection,
					status: g.status,
					winnerRunId: g.winner ? runId(g.winner) : null,
					createdByAction: null,
					createdAt: new Date(created),
					closedAt: null,
				});
			},
		});
	}

	// ---- runs ----
	const sessionIds = new Map<string, string>();
	for (const r of project.runs) {
		const id = runId(r.alias);
		const tid = taskId(r.task);
		const task = project.tasks.find((t) => t.alias === r.task);
		const startMs = at(r.start);
		const endMs = startMs + r.minutes * MIN;
		const live = r.end === "live";
		const gitInfo = input.runGit.get(r.alias);
		const kind = r.kind ?? "task";
		const relation = r.relation ?? (kind === "repair" ? "repair" : "fresh");
		const parent = r.parent ? runId(r.parent) : null;
		const chainRoot = r.parent
			? (() => {
					let cur = project.runs.find((x) => x.alias === r.parent);
					while (cur?.parent)
						cur = project.runs.find((x) => x.alias === cur?.parent);
					return cur ? runId(cur.alias) : id;
				})()
			: id;
		const sessionId = randomUUID();
		sessionIds.set(r.alias, sessionId);
		const state =
			r.end === "merged" || r.end === "failed"
				? "completed"
				: r.end === "review"
					? "needs_review"
					: r.end === "interrupted"
						? "interrupted"
						: "running";
		const usage = {
			inputTokens: r.tokensIn,
			outputTokens: r.tokensOut,
			cachedInputTokens: Math.round(r.tokensIn * 0.6),
			costUsd: r.costUsd,
		};
		const label = kind === "repair" ? `${tid}#repair` : tid;
		const group = r.group ? (input.groupIds.get(r.group) ?? null) : null;
		const finishedMs = endMs + (r.end === "merged" ? 90_000 : 40_000);

		op(startMs, async (tx) => {
			await tx.insert(runs).values({
				id,
				kind,
				taskId: tid,
				parentRunId: parent,
				label,
				model: r.model,
				providerId: r.harness,
				reasoningEffort: r.effort ?? null,
				cwd: gitInfo?.worktree ?? root,
				worktreePath: gitInfo?.worktree ?? null,
				branch: gitInfo?.branch ?? null,
				integrationBranch: "main",
				baseSha: gitInfo?.baseSha ?? null,
				attempt: kind === "repair" ? 2 : 1,
				argv: [
					r.harness === "codex-cli" ? "codex" : "claude",
					"--model",
					r.model,
				],
				initialPrompt: `Task ${tid}: ${titleOf.get(r.task) ?? ""}`,
				state,
				outcome:
					r.end === "interrupted" ? "interrupted" : live ? null : "completed",
				capabilities: {
					steer: true,
					verified: true,
					interrupt: true,
					approvals: true,
					plan: true,
					fileChanges: true,
					commandProgress: true,
					mcp: true,
				},
				exitCode: live ? null : r.end === "interrupted" ? null : 0,
				usage: live ? null : usage,
				usageLive: live ? usage : null,
				startedAt: new Date(startMs),
				finishedAt: live ? null : new Date(finishedMs),
				harness: r.harness,
				modelVendor: harnessVendor(r.harness),
				activity: live ? (r.activity ?? "working") : "ended",
				activityDetail:
					live && r.activity === "needs_answer" && r.question
						? {
								pendingApprovals: [],
								question: r.question.text,
								questionSource: "tool",
								...(r.question.options ? { options: r.question.options } : {}),
								background: [],
							}
						: null,
				note: r.summary ?? null,
				taskSize: task?.size ?? null,
				taskType: task?.type ?? "implementation",
				nativeSessionId: sessionId,
				relation: relation as "fresh",
				chainRootId: chainRoot,
				groupId: group,
				role: (r.role ?? (group ? "attempt" : "implement")) as "implement",
				transcriptSummary: null,
			});
		});

		const base = { runId: id, taskId: tid };
		ev(startMs, {
			type: "run.started",
			...base,
			payload: {
				kind,
				taskId: tid,
				model: r.model,
				...(gitInfo ? { branch: gitInfo.branch } : {}),
				...(parent ? { parentRunId: parent, relation } : {}),
				label,
				...(group ? { groupId: group, role: "attempt" } : {}),
			},
		});
		ev(startMs + 1000, {
			type: "task.claimed",
			taskId: tid,
			payload: { runId: id },
		});
		ev(startMs + 20_000, {
			type: "run.state_changed",
			...base,
			payload: { from: "starting", to: "running" },
		});
		ev(startMs + 30_000, {
			type: "run.activity_changed",
			...base,
			payload: { from: null, to: "working" },
		});

		if (live) {
			const askedAt = seedNow - 7 * MIN;
			if (r.activity === "needs_answer" && r.question) {
				ev(askedAt, {
					type: "run.activity_changed",
					...base,
					payload: {
						from: "working",
						to: "needs_answer",
						question: r.question.text,
					},
				});
			}
			ev(seedNow - 2 * MIN, {
				type: "run.usage_sampled",
				...base,
				payload: {
					tokensIn: r.tokensIn,
					tokensOut: r.tokensOut,
					costUsd: r.costUsd,
				},
			});
		} else {
			ev(endMs, {
				type: "run.activity_changed",
				...base,
				payload: { from: "working", to: "ended" },
			});
			ev(endMs + 1000, {
				type: "run.state_changed",
				...base,
				payload:
					r.end === "interrupted"
						? {
								from: "running",
								to: "interrupted",
								note: "daemon restarted while the run was live",
							}
						: { from: "running", to: "ended", exitCode: 0 },
			});
			if (r.end !== "interrupted") {
				ev(endMs + 5000, {
					type: "run.state_changed",
					...base,
					payload: { from: "ended", to: "finalizing" },
				});
				for (const c of r.checks ?? []) {
					ev(endMs + 10_000, {
						type: "verify.check",
						taskId: tid,
						runId: id,
						payload: {
							check: c.check,
							passed: c.passed,
							...(c.passed ? {} : { classification: "failed" as const }),
							...(c.detail ? { detail: c.detail } : {}),
						},
					});
				}
				const settleClass =
					r.alias === "flakyRun"
						? "report_blocked"
						: r.checks?.some((c) => !c.passed)
							? "verify_failed"
							: "verified";
				ev(endMs + 20_000, {
					type: "run.settled",
					...base,
					payload: {
						groupId: group,
						class: settleClass,
						facts: { filesChanged: Object.keys(r.change?.files ?? {}).length },
					},
				});
				ev(endMs + 40_000, {
					type: "run.state_changed",
					...base,
					payload: {
						from: "finalizing",
						to: state === "needs_review" ? "needs_review" : "completed",
					},
				});
				ev(endMs + 41_000, {
					type: "task.claim_released",
					taskId: tid,
					payload: { runId: id, purpose: "task_run" },
				});
			}
			if (r.end === "merged" && gitInfo?.mergeSha) {
				ev(endMs + 90_000, {
					type: "merge.completed",
					...base,
					payload: { sha: gitInfo.mergeSha, target: "main" },
				});
			}
		}

		if (!live) {
			op(finishedMs, async (tx) => {
				await recordSpend(tx, {
					kind: "agent",
					accountKey: r.harness,
					source: "run_usage",
					runId: id,
					taskId: tid,
					usd: r.costUsd,
					tokensIn: r.tokensIn,
					tokensOut: r.tokensOut,
					ts: new Date(finishedMs),
				});
				if (r.end !== "interrupted") {
					const verify = (r.checks ?? []).map((c) => ({
						check: c.check,
						ok: c.passed,
						...(c.detail ? { detail: c.detail } : {}),
					}));
					await tx.insert(runSteps).values({
						runId: id,
						step: "verify",
						seq: 1,
						status: "done",
						result: { passed: verify.every((c) => c.ok), checks: verify },
						startedAt: new Date(endMs + 5000),
						finishedAt: new Date(endMs + 15_000),
					});
				}
				if (r.end === "merged" && gitInfo?.mergedAt) {
					await tx.insert(runSteps).values({
						runId: id,
						step: "merge",
						seq: 2,
						status: "done",
						result: { sha: gitInfo.mergeSha, target: "main" },
						startedAt: new Date(endMs + 60_000),
						finishedAt: new Date(gitInfo.mergedAt),
					});
					await tx.insert(mergeJobs).values({
						runId: id,
						taskId: tid,
						branch: gitInfo.branch,
						targetBranch: "main",
						state: "merged",
						attempt: 1,
						enqueuedAt: new Date(endMs + 50_000),
						updatedAt: new Date(gitInfo.mergedAt),
					});
				}
			});
		}
	}

	// ---- review artefacts for runs awaiting a human ----
	for (const r of project.runs.filter((x) => x.end === "review")) {
		const id = runId(r.alias);
		const tid = taskId(r.task);
		const endMs = at(r.start) + r.minutes * MIN;
		op(endMs + 25_000, async (tx) => {
			const [d] = await tx
				.insert(decisions)
				.values({
					ts: new Date(endMs + 25_000),
					role: "critic",
					taskId: tid,
					subjectRunId: id,
					model: HAIKU_CRITIC,
					status: "ok",
					action: "accepted",
					reason:
						"The change satisfies the acceptance criteria. One low-severity note about audit detail.",
					input: {},
					output: {
						verdict: "merge",
						mode: "critic",
						round: 0,
						reviewerModel: HAIKU_CRITIC,
						implementerModel: r.model,
						sameModel: false,
						independent: true,
						criteria: (
							project.tasks.find((t) => t.alias === r.task)?.criteria ?? []
						).map((criterion) => ({
							criterion,
							verdict: "met",
							evidenceClass: "source-confirmed",
							evidence: "Covered by the diff and its tests.",
						})),
					},
					durationMs: 14_000,
					finishedAt: new Date(endMs + 39_000),
					kind: "judge",
				})
				.returning({ id: decisions.id });
			await tx.insert(reviewVerdicts).values({
				id: ulid(endMs + 26_000),
				taskId: tid,
				subjectRunId: id,
				decisionId: d?.id ?? null,
				mode: "critic",
				reviewerHarness: "claude-cli",
				reviewerModel: HAIKU_CRITIC,
				round: 0,
				verdict: "merge",
				findings: [
					{
						file:
							Object.keys(r.change?.files ?? {})[0] ?? "src/routes/admin.ts",
						line: 18,
						severity: "low",
						change:
							"Log the previous values as well as the new ones, so an audit can reconstruct the change.",
					},
				],
				criteria: [],
				independent: true,
				createdAt: new Date(endMs + 27_000),
			});
		});
		if (r.alias === "adminRun") {
			op(endMs + 3_600_000, async (tx) => {
				await tx.insert(reviewComments).values([
					{
						taskId: tid,
						file: "src/routes/admin.ts",
						line: 18,
						side: "new",
						body: "Should the audit line include the previous values too? Support will ask which burst a key had before.",
						resolved: false,
						createdAt: new Date(endMs + 3_600_000),
					},
				]);
			});
		}
	}

	// ---- brain ----
	let brainSessionId: string | null = null;
	if (project.brain) {
		const brain = project.brain;
		const sessionId = ulid(at("11d"));
		brainSessionId = sessionId;
		const sessionStart = at("11d");
		let cursor = 0;
		op(sessionStart, async (tx) => {
			await tx.insert(brainSessions).values({
				id: sessionId,
				scope: { kind: "project" },
				status: "idle",
				harness: brain.harness,
				model: brain.model,
				effort: "high",
				nativeSessionId: randomUUID(),
				lastCostTotal: brain.turns.reduce((s, t) => s + t.costUsd, 0),
				nativeHost: input.hostname,
				generation: 0,
				generationStartedAt: new Date(sessionStart),
				contextTokens: 61_400,
				cursor: 0,
				createdAt: new Date(sessionStart),
			});
		});
		brain.turns.forEach((turn, i) => {
			const turnRun = ulid(at(turn.ago));
			const start = at(turn.ago);
			const end = start + turn.minutes * MIN;
			op(start, async (tx) => {
				const [last] = await tx.select({ seq: max(events.seq) }).from(events);
				const eventsTo = last?.seq ?? 0;
				await tx.insert(runs).values({
					id: turnRun,
					kind: "brain",
					taskId: null,
					label: `brain turn ${i + 1}`,
					model: brain.model,
					providerId: brain.harness,
					cwd: root,
					state: "completed",
					outcome: "completed",
					exitCode: 0,
					usage: { costUsd: turn.costUsd },
					startedAt: new Date(start),
					finishedAt: new Date(end),
					harness: brain.harness,
					modelVendor: "anthropic",
					activity: "ended",
					relation: "session",
					chainRootId: turnRun,
					role: "brain",
				});
				await tx.insert(brainTurns).values({
					runId: turnRun,
					sessionId,
					seq: i,
					generation: 0,
					wakeClass: turn.wake,
					eventsFrom: cursor,
					eventsTo,
					resumed: i > 0,
					status: "ok",
					usage: {
						costUsd: turn.costUsd,
						inputTokens: 38_000 + i * 4_000,
						outputTokens: 2_100,
					},
					actionsCount: turn.actions.length,
					startedAt: new Date(start),
					endedAt: new Date(end),
				});
				cursor = eventsTo;
				await appendEvent(
					tx,
					{
						type: "brain.turn_started",
						runId: turnRun,
						payload: {
							sessionId,
							seq: i,
							generation: 0,
							wakeClass: turn.wake,
							eventsFrom: cursor,
							eventsTo,
							resumed: i > 0,
						},
					},
					start,
				);
			});
			op(end, async (tx) => {
				await recordSpend(tx, {
					kind: "brain",
					accountKey: brain.harness,
					source: "brain_usage",
					runId: turnRun,
					brainSessionId: sessionId,
					usd: turn.costUsd,
					tokensIn: 38_000 + i * 4_000,
					tokensOut: 2_100,
					ts: new Date(end),
				});
				await appendEvent(
					tx,
					{
						type: "brain.turn_ended",
						runId: turnRun,
						payload: {
							sessionId,
							status: "ok",
							actionsCount: turn.actions.length,
						},
					},
					end,
				);
			});
			turn.actions.forEach((a, j) => {
				const ts = start + (j + 1) * 20_000;
				op(ts, async (tx) => recordAction(tx, a, ts, turnRun, sessionId));
			});
		});

		async function recordAction(
			tx: ProjectDbTx,
			a: SeedBrainAction,
			ts: number,
			turnRun: string,
			sessionId: string,
		) {
			const tid = a.task ? taskId(a.task) : null;
			const subjectRun = a.run ? runId(a.run) : null;
			const status = a.status ?? "applied";
			const args: Record<string, unknown> = {
				...(tid && !["notify_human", "set_status", "note"].includes(a.tool)
					? { taskId: tid }
					: {}),
				...(a.tool === "set_status" && tid ? { id: tid } : {}),
				...(a.tool === "note" && tid ? { taskId: tid, text: a.text } : {}),
				...(a.tool === "set_plan" ? { markdown: a.text } : {}),
				...(subjectRun ? { runId: subjectRun } : {}),
				...(a.args ?? {}),
				...(a.args?.blocking
					? { blocking: (a.args.blocking as string[]).map(taskId) }
					: {}),
				rationale: a.rationale,
				...(a.confidence ? { confidence: a.confidence } : {}),
				...(a.alternatives ? { alternatives: a.alternatives } : {}),
			};
			if (a.tool === "spawn" && !args.role) args.role = "implement";
			const kind =
				a.tool === "set_plan" ? "plan" : a.tool === "note" ? "note" : "action";
			const text =
				a.tool === "set_plan" || a.tool === "note"
					? (a.text ?? a.rationale)
					: a.rationale;
			const [d] = await tx
				.insert(decisions)
				.values({
					ts: new Date(ts),
					role: "brain",
					taskId: tid,
					subjectRunId: subjectRun,
					brainRunId: turnRun,
					model: brain.model,
					status: "ok",
					action: a.tool,
					reason: text,
					input: args,
					output: { status, result: { ok: true } },
					durationMs: 0,
					finishedAt: new Date(ts),
					brainSessionId: sessionId,
					turnRunId: turnRun,
					kind,
					alternatives: a.alternatives ?? null,
					confidence: a.confidence ?? null,
					contextRefs: {},
					harness: brain.harness,
				})
				.returning({ id: decisions.id });
			const actionId = ulid(ts);
			await tx.insert(brainActions).values({
				id: actionId,
				idemKey: `${turnRun}:${a.tool}:${actionId}`,
				sessionId,
				turnRunId: turnRun,
				tool: a.tool,
				args,
				status,
				rejection: null,
				effects: null,
				decisionId: d?.id ?? null,
				createdAt: new Date(ts),
				appliedAt: status === "applied" ? new Date(ts) : null,
			});
			if (a.tool === "spawn_attempts" && tid) {
				await tx
					.update(runGroups)
					.set({ createdByAction: actionId })
					.where(eq(runGroups.taskId, tid));
			}
			await appendEvent(
				tx,
				{
					type: "brain.action",
					runId: turnRun,
					...(tid ? { taskId: tid } : {}),
					payload: {
						actionId,
						tool: a.tool,
						status,
						...(d ? { decisionId: d.id } : {}),
						sessionId,
					},
				},
				ts,
			);
		}
	}

	// ---- apply in time order ----
	ops.sort((a, b) => a.ts - b.ts || a.order - b.order);
	// A group's runs reference it: the group row is first at its own instant.
	for (const o of ops) await handle.withTx((tx) => o.apply(tx));

	// Closing the competing group's selection state as an event, after its runs ended.
	for (const g of project.groups ?? []) {
		const gid = input.groupIds.get(g.alias) as string;
		await handle.withTx(async (tx) => {
			const ts = at(g.start) + 40 * MIN;
			await appendEvent(
				tx,
				{
					type: "run.group_changed",
					taskId: taskId(g.task),
					payload: { groupId: gid, status: g.status },
				},
				ts,
			);
		});
	}

	await backfillAttemptOutcomes(handle.db);

	const [seen] = await handle.db
		.select({ seq: max(events.seq) })
		.from(events)
		.where(and(lte(events.ts, new Date(seedNow - 6 * 60 * MIN))));
	const [count] = await handle.db.select({ n: max(events.seq) }).from(events);

	// Run directories: meta.json, a transcript, and the exit marker.
	for (const r of project.runs) {
		const id = runId(r.alias);
		const dir = join(runsDir, id);
		await mkdir(dir, { recursive: true });
		const startMs = at(r.start);
		const live = r.end === "live";
		const endMs = live ? seedNow - 60_000 : startMs + r.minutes * MIN;
		await writeFile(
			join(dir, "meta.json"),
			`${JSON.stringify({ id, kind: r.kind ?? "task", taskId: taskId(r.task), model: r.model, startedAt: startMs }, null, "\t")}\n`,
		);
		await writeFile(
			join(dir, "events.jsonl"),
			transcript(
				r,
				titleOf.get(r.task) ?? r.task,
				startMs,
				endMs,
				live,
				sessionIds.get(r.alias) as string,
			),
		);
		if (!live) await writeFile(join(dir, "exit"), "exit:0");
	}

	handle.close();
	return {
		seenSeq: seen?.seq ?? 0,
		brainSessionId,
		eventCount: count?.n ?? 0,
	};
}

const HAIKU_CRITIC = "claude-haiku-4-5";
