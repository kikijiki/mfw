import "../../daemon/test/support/tmux-test-socket.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { decisions } from "@mfw/db/schema";
import { eq } from "drizzle-orm";
import {
	type GroupFixture,
	groupFixture,
} from "../../daemon/test/support/group-fixture.ts";
import { createCaller } from "../src/root.ts";

/**
 * `groups.get`, `groups.selectWinner` and `runs.reroute` over a real boot:
 * the API refuses with the server's own `fix` text and records a human
 * decision on success.
 */

let fx: GroupFixture | undefined;
afterEach(async () => {
	await fx?.cleanup();
	fx = undefined;
});

async function settledPair(f: GroupFixture, fail: number[]) {
	const taskId = await f.task("compete");
	const proposed = await f.act("spawn_attempts", {
		taskId,
		variants: [{ model: "sonnet" }, { model: "opus" }],
		selection: "brain",
	});
	const runIds = (proposed.result?.runIds ?? []) as string[];
	const groupId = String(proposed.result?.groupId);
	await f.control({ fail: fail.map((i) => runIds[i] ?? "") });
	await f.svc.scheduler.tick();
	await f.until(
		async () => {
			const rows = await Promise.all(
				runIds.map((id) => f.svc.registry.get(id)),
			);
			return rows.every(
				(r) => r && ["completed", "failed", "killed"].includes(r.state),
			);
		},
		{ what: "the attempts to settle", timeoutMs: 60_000 },
	);
	return { taskId, runIds, groupId };
}

describe("groups router", () => {
	test("get lists attempts with the server's verdicts; selectWinner refuses with the fix and accepts a verified run", async () => {
		fx = await groupFixture();
		const f = fx;
		const api = createCaller({ orchestrator: f.orchestrator });
		const project = f.svc.name;
		const { runIds, groupId } = await settledPair(f, [1]);

		const view = await api.groups.get({ project, groupId });
		expect(view.attempts.map((a) => a.runId).sort()).toEqual(
			[...runIds].sort(),
		);
		expect(view.attempts.find((a) => a.runId === runIds[0])?.select.ok).toBe(
			true,
		);
		const bad = view.attempts.find((a) => a.runId === runIds[1]);
		expect(bad?.select).toMatchObject({
			ok: false,
			rejection: { code: "not_verified" },
		});

		let refusal: unknown;
		try {
			await api.groups.selectWinner({
				project,
				groupId,
				runId: runIds[1] as string,
			});
		} catch (e) {
			refusal = e;
		}
		expect(refusal).toMatchObject({
			code: "PRECONDITION_FAILED",
			cause: { name: "GroupActionRefusedError", code: "not_verified" },
		});
		expect(
			(refusal as { cause: { fix: { text: string } } }).cause.fix.text.length,
		).toBeGreaterThan(0);

		const out = await api.groups.selectWinner({
			project,
			groupId,
			runId: runIds[0] as string,
			reason: "the clean one",
		});
		expect(out).toMatchObject({ ok: true, groupId, runId: runIds[0] });
		const [d] = await f.svc.handle.db
			.select()
			.from(decisions)
			.where(eq(decisions.id, out.decisionId));
		expect(d).toMatchObject({ role: "human", action: "select_winner" });

		const after = await api.groups.get({ project, groupId });
		expect(after.status).toBe("selecting");
		expect(after.winnerRunId).toBe(runIds[0] ?? null);
	}, 120_000);

	test("get on an unknown group is NOT_FOUND", async () => {
		fx = await groupFixture();
		const api = createCaller({ orchestrator: fx.orchestrator });
		await expect(
			api.groups.get({ project: fx.svc.name, groupId: "nope" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});

describe("runs.reroute", () => {
	test("a reroute that changes nothing is refused with a fix", async () => {
		fx = await groupFixture();
		const f = fx;
		const api = createCaller({ orchestrator: f.orchestrator });
		const taskId = await f.task("noop");
		const spawned = await f.spawn(taskId);
		const runId = (spawned.result?.runIds as string[])[0] as string;
		await f.svc.scheduler.tick();
		let err: unknown;
		try {
			await api.runs.reroute({ project: f.svc.name, runId });
		} catch (e) {
			err = e;
		}
		expect(err).toMatchObject({
			code: "PRECONDITION_FAILED",
			cause: { name: "RerouteError", code: "nothing_to_change" },
		});
	}, 60_000);
});
