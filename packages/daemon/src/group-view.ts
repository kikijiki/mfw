import type { ProjectDb } from "@mfw/db/client";
import { brainActions, decisions } from "@mfw/db/schema";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { BrainActionService, Rejection } from "./brain-runtime/actions.ts";
import type { BrainActionExecutor } from "./brain-runtime/executor.ts";
import type { RunRegistry, RunRow } from "./run-registry.ts";

/**
 * One attempt group as the compare view reads it (U4-02): the `run_groups`
 * row, each attempt's route, cost and gate facts, and, per attempt, whether
 * `select_winner` would be accepted right now. The acceptance answer is the
 * action service's own validator (`check`), never a second copy of the rules,
 * so the button and the server cannot disagree (invariants I1 and I2).
 */

export interface GroupAttemptView {
	runId: string;
	label: string;
	role: string | null;
	state: string;
	activity: string | null;
	harness: string | null;
	model: string;
	effort: string | null;
	host: string | null;
	startedAt: Date;
	finishedAt: Date | null;
	costUsd: number | null;
	/** The run's final note (its last message excerpt), when it left one. */
	note: string | null;
	winner: boolean;
	facts: {
		settled: boolean;
		verified: boolean;
		verifyRan: boolean;
		scopeOutside: number;
		review: { status: "ok" | "failed"; verdict: string | null } | null;
	};
	/** The deterministic checks of its verify step (empty until verify ran). */
	checks: { name: string; ok: boolean; detail?: string }[];
	/** What `select_winner` answers for this attempt now. */
	select: { ok: true } | { ok: false; rejection: Rejection };
}

export interface GroupView {
	id: string;
	taskId: string;
	kind: string;
	selection: string;
	status: string;
	winnerRunId: string | null;
	/** `decision:<n>` that spawned the group, or `human`. */
	createdBy: string;
	createdAt: Date;
	closedAt: Date | null;
	attempts: GroupAttemptView[];
	/** The latest `select_winner` decision about this group (the brain's, or a person's). */
	selectedBy: {
		decisionId: number;
		role: string;
		reason: string;
		at: Date;
		runId: string | null;
	} | null;
}

export interface GroupViewDeps {
	registry: Pick<RunRegistry, "getGroup" | "groupRuns" | "steps">;
	actions: Pick<BrainActionService, "check">;
	executor: Pick<BrainActionExecutor, "facts">;
	db: ProjectDb;
}

/**
 * A person's action on a group (`select_winner`, add attempt) was refused by the server's own validator. Carries
 * the validator's `code` and `fix` so the API surfaces the same text the brain
 * would have been told.
 */
export class GroupActionRefusedError extends Error {
	readonly fix?: { kind: "setting" | "command" | "ui"; text: string };
	constructor(
		readonly code: string,
		message: string,
		fix?: { kind: "setting" | "command" | "ui"; text: string },
	) {
		super(message);
		this.name = "GroupActionRefusedError";
		if (fix) this.fix = fix;
	}
}

const costOf = (usage: Record<string, number> | null): number | null => {
	const v = usage?.costUsd;
	return typeof v === "number" ? v : null;
};

export async function groupView(
	deps: GroupViewDeps,
	groupId: string,
): Promise<GroupView | null> {
	const group = await deps.registry.getGroup(groupId);
	if (!group) return null;
	const members = await deps.registry.groupRuns(groupId);

	const attempts: GroupAttemptView[] = [];
	for (const run of members) attempts.push(await attemptOf(deps, group, run));

	let createdBy = "human";
	if (group.createdByAction) {
		const [a] = await deps.db
			.select({ decisionId: brainActions.decisionId })
			.from(brainActions)
			.where(eq(brainActions.id, group.createdByAction));
		if (a?.decisionId) createdBy = `decision:${a.decisionId}`;
	}

	const ids = members.map((m) => m.id);
	let selectedBy: GroupView["selectedBy"] = null;
	if (ids.length > 0) {
		const [d] = await deps.db
			.select()
			.from(decisions)
			.where(
				and(
					eq(decisions.action, "select_winner"),
					inArray(decisions.subjectRunId, ids),
					eq(decisions.status, "ok"),
				),
			)
			.orderBy(desc(decisions.ts), desc(decisions.id))
			.limit(1);
		if (d) {
			selectedBy = {
				decisionId: d.id,
				role: d.role,
				reason: d.reason ?? "",
				at: d.ts,
				runId: d.subjectRunId,
			};
		}
	}

	return {
		id: group.id,
		taskId: group.taskId,
		kind: group.kind,
		selection: group.selection,
		status: group.status,
		winnerRunId: group.winnerRunId,
		createdBy,
		createdAt: group.createdAt,
		closedAt: group.closedAt,
		attempts,
		selectedBy,
	};
}

async function attemptOf(
	deps: GroupViewDeps,
	group: { winnerRunId: string | null },
	run: RunRow,
): Promise<GroupAttemptView> {
	const f = await deps.executor.facts(run.id);
	const verify = (await deps.registry.steps(run.id)).find(
		(s) => s.step === "verify" && s.status === "done",
	)?.result as
		| { checks?: { check?: string; ok?: boolean; detail?: string }[] }
		| undefined;
	const checks = (verify?.checks ?? []).map((c) => ({
		name: c.check ?? "check",
		ok: c.ok === true,
		...(c.detail ? { detail: c.detail } : {}),
	}));
	const verdict = await deps.actions.check("select_winner", {
		runId: run.id,
		rationale: "can this attempt be selected",
	});
	return {
		runId: run.id,
		label: run.label,
		role: run.role,
		state: run.state,
		activity: run.activity,
		harness: run.harness ?? run.providerId,
		model: run.model,
		effort: run.reasoningEffort,
		host: run.hostId,
		startedAt: run.startedAt,
		finishedAt: run.finishedAt,
		costUsd: costOf(run.usage as Record<string, number> | null),
		note: run.note,
		winner: group.winnerRunId === run.id,
		facts: {
			settled: f.settled,
			verified: f.verified,
			verifyRan: f.verifyRan,
			scopeOutside: f.scopeOutside,
			review: f.review,
		},
		checks,
		select: verdict.ok
			? { ok: true }
			: { ok: false, rejection: verdict.rejection },
	};
}
