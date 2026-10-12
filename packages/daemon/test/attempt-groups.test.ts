import "./support/tmux-test-socket.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { mergeJobs, runGroups } from "@mfw/db/schema";
import { eq } from "drizzle-orm";
import { git } from "../src/git.ts";
import { type GroupFixture, groupFixture } from "./support/group-fixture.ts";

/**
 * Competing attempts of one task: siblings share the task's claim, each has
 * its own worktree, and one winner (chosen by the brain, or the first verified
 * one) goes through the merge queue. Real git, tmux and finalize; the brain is
 * the test, acting through the action service.
 */

let fx: GroupFixture | undefined;
afterEach(async () => {
	await fx?.cleanup();
	fx = undefined;
});

const WATCHDOG = {
	scope: {
		mode: "kill" as const,
		sampleMs: 5_000,
		foreignOwned: "kill" as const,
		onFinish: "review" as const,
	},
};

/** Two attempts of a fresh task, launched and finished. */
async function twoAttempts(
	f: GroupFixture,
	opts: {
		fail?: (runIds: string[]) => string[];
		selection?: "brain" | "first_verified";
		owns?: string[];
	} = {},
) {
	const taskId = await f.task("compete", opts.owns ? { owns: opts.owns } : {});
	// Run ids are pre-minted into the outbox row, so the driver can be told
	// which attempt to fail before anything launches.
	const proposed = await f.act("spawn_attempts", {
		taskId,
		variants: [{ model: "sonnet" }, { model: "opus" }],
		selection: opts.selection ?? "brain",
	});
	expect(proposed.status).toBe("accepted");
	const runIds = (proposed.result?.runIds ?? []) as string[];
	const groupId = String(proposed.result?.groupId);
	expect(runIds).toHaveLength(2);
	if (opts.fail) await f.control({ fail: opts.fail(runIds) });
	const stats = await f.svc.scheduler.tick();
	expect(stats.started).toEqual([taskId, taskId]);
	return { taskId, runIds, groupId, actionId: proposed.actionId };
}

async function settled(f: GroupFixture, runIds: string[]) {
	await f.until(
		async () => {
			const rows = await Promise.all(
				runIds.map((id) => f.svc.registry.get(id)),
			);
			return rows.every(
				(r) =>
					r &&
					["completed", "failed", "killed", "finalize_error"].includes(r.state),
			);
		},
		{ what: "the attempts to settle", timeoutMs: 60_000 },
	);
}

describe("attempt groups", () => {
	test("two attempts of one task do not kill each other via the scope watchdog", async () => {
		fx = await groupFixture({ watchdog: WATCHDOG });
		const f = fx;
		const { taskId, runIds, groupId } = await twoAttempts(f, {
			owns: ["feature.txt"],
		});

		// Both are live at once, in separate worktrees, holding one claim.
		const rows = await Promise.all(runIds.map((id) => f.svc.registry.get(id)));
		expect(rows.map((r) => r?.role)).toEqual(["attempt", "attempt"]);
		expect(rows.every((r) => r?.groupId === groupId)).toBe(true);
		expect(new Set(rows.map((r) => r?.worktreePath)).size).toBe(2);
		const task = await f.svc.tasks.get(taskId);
		expect(task?.claimedByGroupId).toBe(groupId);
		expect(task?.claimedByRunId).toBe(runIds[0]);

		await settled(f, runIds);
		const done = await Promise.all(runIds.map((id) => f.svc.registry.get(id)));
		for (const r of done) {
			expect(r?.state).toBe("completed");
			expect(r?.killReason).toBeNull();
			expect(r?.note).toContain("awaiting selection");
		}
		// Nothing merged, nothing released: the group waits for its winner.
		expect(await f.svc.handle.db.select().from(mergeJobs)).toEqual([]);
		const after = await f.svc.tasks.get(taskId);
		expect(after?.claimedByGroupId).toBe(groupId);
		expect(after?.status).toBe("in_progress");
		const [group] = await f.svc.handle.db
			.select()
			.from(runGroups)
			.where(eq(runGroups.id, groupId));
		expect(group).toMatchObject({ kind: "competing", status: "open" });
	}, 120_000);

	test("select_winner refuses an unverified run and accepts a verified one", async () => {
		fx = await groupFixture();
		const f = fx;
		const { runIds } = await twoAttempts(f, { fail: (ids) => [ids[1] ?? ""] });
		await settled(f, runIds);

		const bad = await f.svc.registry.get(runIds[1] as string);
		expect(bad?.state).toBe("failed");
		const refused = await f.act("select_winner", { runId: runIds[1] });
		expect(refused.status).toBe("rejected");
		expect(refused.rejection?.code).toBe("not_verified");
		expect(refused.rejection?.fix?.text.length).toBeGreaterThan(0);

		const accepted = await f.act("select_winner", { runId: runIds[0] });
		expect(accepted.status).toBe("applied");
	}, 120_000);

	test("the winner alone gets a merge job; losers are archived to wip/ and their branches kept", async () => {
		fx = await groupFixture();
		const f = fx;
		const { taskId, runIds, groupId } = await twoAttempts(f);
		await settled(f, runIds);
		const [winnerId, loserId] = runIds as [string, string];
		const loser = await f.svc.registry.get(loserId);
		const loserBranch = loser?.branch as string;

		const picked = await f.act("select_winner", { runId: winnerId });
		expect(picked.status).toBe("applied");

		await f.until(
			async () => {
				await f.svc.mergeQueue.tick();
				const [g] = await f.svc.handle.db
					.select()
					.from(runGroups)
					.where(eq(runGroups.id, groupId));
				return g?.status === "merged";
			},
			{ what: "the winner to merge", timeoutMs: 60_000 },
		);

		// exactly one merge job: the winner's
		const jobs = await f.svc.handle.db.select().from(mergeJobs);
		expect(jobs.map((j) => j.runId)).toEqual([winnerId]);
		expect(jobs[0]?.state).toBe("merged");
		expect((await f.svc.tasks.get(taskId))?.status).toBe("done");
		expect((await git(["show", "main:feature.txt"], f.root)).stdout).toContain(
			winnerId,
		);

		// loser: archived under wip/, run branch still there, worktree gone
		await f.until(
			async () => {
				const out = await git(["branch", "--list", "wip/*"], f.root);
				return out.stdout.includes(loserId);
			},
			{ what: "the loser to be archived" },
		);
		const kept = await git(
			["rev-parse", "--verify", `refs/heads/${loserBranch}`],
			f.root,
		);
		expect(kept.exitCode).toBe(0);
		expect(loser?.worktreePath).toBeTruthy();
		const wt = await git(["worktree", "list", "--porcelain"], f.root);
		expect(wt.stdout).not.toContain(loser?.worktreePath as string);
	}, 180_000);

	test("first_verified: the first verified attempt is selected and merged without the brain", async () => {
		fx = await groupFixture();
		const f = fx;
		const { runIds, groupId } = await twoAttempts(f, {
			selection: "first_verified",
			fail: (ids) => [ids[0] ?? ""],
		});

		await f.until(
			async () => {
				await f.svc.mergeQueue.tick();
				const [g] = await f.svc.handle.db
					.select()
					.from(runGroups)
					.where(eq(runGroups.id, groupId));
				return g?.status === "merged";
			},
			{ what: "the verified attempt to merge", timeoutMs: 60_000 },
		);
		const [g] = await f.svc.handle.db
			.select()
			.from(runGroups)
			.where(eq(runGroups.id, groupId));
		expect(g?.winnerRunId).toBe(runIds[1]);
		const jobs = await f.svc.handle.db.select().from(mergeJobs);
		expect(jobs.map((j) => j.runId)).toEqual([runIds[1] as string]);
	}, 180_000);

	test("every attempt failing abandons the group and gives the claim back", async () => {
		fx = await groupFixture();
		const f = fx;
		const { taskId, runIds, groupId } = await twoAttempts(f, {
			fail: (ids) => ids,
		});
		await f.until(
			async () => {
				const [g] = await f.svc.handle.db
					.select()
					.from(runGroups)
					.where(eq(runGroups.id, groupId));
				return g?.status === "abandoned";
			},
			{ what: "the group to be abandoned", timeoutMs: 60_000 },
		);
		const task = await f.svc.tasks.get(taskId);
		expect(task?.claimedByGroupId).toBeNull();
		expect(task?.status).toBe("ready");
		expect(await f.svc.handle.db.select().from(mergeJobs)).toEqual([]);
		// ready with no brain action: nothing restarts it
		const stats = await f.svc.scheduler.tick();
		expect(stats.started).toEqual([]);
		void runIds;
	}, 120_000);
});
