import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TokenPrincipal } from "@mfw/daemon/auth/service";
import type { TokenScope } from "@mfw/daemon/auth/tokens";
import { silentLogger } from "@mfw/daemon/log";
import type { Orchestrator, ProjectServices } from "@mfw/daemon/services";
import { openProjectDb } from "@mfw/db/client";
import { EventBus } from "@mfw/db/eventlog";
import { makeTasks } from "../../daemon/test/fixtures/board.ts";
import { appRouter } from "../src/root.ts";
import { createCallerFactory, type TokenAuditSink } from "../src/trpc.ts";

/**
 * What a token's permitted call causes afterwards. A `board:write` token must
 * not be able to put its text in front of an agent, directly or through a later
 * scheduler tick, so these drive the real task service and its promotion scan.
 */

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const c of cleanups.splice(0)) await c();
});

const audit: TokenAuditSink = { begin: async () => 1, finish: async () => {} };

async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), "mfw-test-token-state-"));
	const mfwDir = join(dir, ".mfw");
	const handle = await openProjectDb(mfwDir);
	const bus = new EventBus();
	const tasks = await makeTasks(handle, bus, mfwDir);
	cleanups.push(async () => {
		handle.close();
		await rm(dir, { recursive: true, force: true });
	});
	const svc = {
		name: "demo",
		handle,
		bus,
		log: silentLogger(),
		tasks,
		supervisor: { wake() {} },
	} as unknown as ProjectServices;
	const orchestrator = {
		list: () => [svc],
		get: () => svc,
	} as unknown as Orchestrator;
	const factory = createCallerFactory(appRouter);
	const asToken = (scopes: TokenScope[]) =>
		factory({
			orchestrator,
			tokenAudit: audit,
			principal: {
				kind: "token",
				id: "token:t1",
				tokenId: "t1",
				name: "ci",
				scopes,
				project: null,
			} satisfies TokenPrincipal,
		});
	const owner = factory({
		orchestrator,
		principal: { kind: "owner", id: "o1", sessionId: "s1" },
	});
	return {
		tasks,
		owner,
		writer: asToken(["board:write"]),
		actor: asToken(["board:write", "runs:act"]),
	};
}

const project = "demo";
type F = Awaited<ReturnType<typeof fixture>>;

/** The state H1 route 1 starts from: a title-only task waiting to be specified. */
const titleOnly = async (f: F) =>
	(await f.owner.tasks.create({ project, title: "owner's title" })).id;

async function parkedWithReopen(f: F, status: "done" | "archived" | "review") {
	const dep = await f.tasks.create({ title: "dependency", status: "done" });
	const t = await f.tasks.create({
		title: "finished work",
		body: "the owner's spec",
		status,
		reopenWhen: [{ task_done: dep.id }],
	});
	return t.id;
}

const statusOf = async (f: F, id: string) => (await f.tasks.get(id))?.status;

describe("route 1: a body or criteria edit cannot make a task promotable", () => {
	test("a body edit on an automatic backlog task is refused", async () => {
		const f = await fixture();
		const id = await titleOnly(f);
		await expect(
			f.writer.tasks.update({ project, id, patch: { body: "do this" } }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(await f.tasks.promoteReady()).not.toContain(id);
		expect(await statusOf(f, id)).toBe("backlog");
		expect((await f.tasks.get(id))?.body).toBe("");
	});

	test("adding a criterion to it is refused too", async () => {
		const f = await fixture();
		const id = await titleOnly(f);
		await expect(
			f.writer.tasks.criteria({
				project,
				id,
				op: { op: "add", text: "do this" },
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(await f.tasks.promoteReady()).not.toContain(id);
		expect(await statusOf(f, id)).toBe("backlog");
	});

	test("a title edit on it is refused", async () => {
		const f = await fixture();
		const id = await titleOnly(f);
		await expect(
			f.writer.tasks.update({ project, id, patch: { title: "new" } }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
});

describe("route 2: a move to backlog cannot arm a reopen", () => {
	for (const status of ["done", "archived", "review"] as const)
		test(`refused from ${status}, and no later tick reopens it`, async () => {
			const f = await fixture();
			const id = await parkedWithReopen(f, status);
			await expect(
				f.writer.tasks.move({ project, id, to: "backlog" }),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(await f.tasks.promoteReady()).not.toContain(id);
			expect(await statusOf(f, id)).toBe(status);
		});

	for (const status of ["done", "archived", "review"] as const)
		test(`refused from ${status} even with no condition`, async () => {
			const f = await fixture();
			const t = await f.tasks.create({ title: "t", body: "b", status });
			await expect(
				f.actor.tasks.move({ project, id: t.id, to: "backlog" }),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
		});

	test("refused for a blocked task with a reopen condition", async () => {
		const f = await fixture();
		const dep = await f.tasks.create({ title: "dep" });
		const t = await f.tasks.create({
			title: "t",
			body: "b",
			status: "blocked",
			reopenWhen: [{ task_done: dep.id }],
		});
		await expect(
			f.writer.tasks.move({ project, id: t.id, to: "backlog" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
});

describe("route 3: a draft edit cannot fire expansion", () => {
	test("refused, and the captured prompt is unchanged", async () => {
		const f = await fixture();
		let fired = 0;
		(f.tasks as unknown as { onDraftCaptured: () => void }).onDraftCaptured =
			() => {
				fired++;
			};
		const t = await f.tasks.create({
			title: "captured",
			status: "draft",
			draftPrompt: "the owner's intent",
		});
		await expect(
			f.writer.tasks.update({
				project,
				id: t.id,
				patch: { body: "the token's intent" },
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(fired).toBe(0);
		expect((await f.tasks.get(t.id))?.draftPrompt).toBe("the owner's intent");
	});
});

describe("a task already in ready", () => {
	test("its body and title cannot be rewritten", async () => {
		const f = await fixture();
		const t = await f.tasks.create({
			title: "queued",
			body: "the owner's spec",
			status: "ready",
		});
		for (const patch of [{ body: "other orders" }, { title: "other" }])
			await expect(
				f.writer.tasks.update({ project, id: t.id, patch }),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			f.writer.tasks.criteria({
				project,
				id: t.id,
				op: { op: "add", text: "also do this" },
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect((await f.tasks.get(t.id))?.body).toBe("the owner's spec");
	});
});

describe("parked tasks with a reopen condition", () => {
	test("their body cannot be rewritten while the condition is pending", async () => {
		const f = await fixture();
		const dep = await f.tasks.create({ title: "dep" });
		const t = await f.tasks.create({
			title: "t",
			body: "the owner's spec",
			readyMode: "manual",
			reopenWhen: [{ task_done: dep.id }],
		});
		await expect(
			f.writer.tasks.update({ project, id: t.id, patch: { body: "x" } }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
});

describe("what a board:write token can still do", () => {
	test("edit its own parked task, which stays parked through a tick", async () => {
		const f = await fixture();
		const { id } = await f.writer.tasks.create({ project, title: "mine" });
		await f.writer.tasks.update({ project, id, patch: { body: "details" } });
		await f.writer.tasks.criteria({
			project,
			id,
			op: { op: "add", text: "a criterion" },
		});
		expect(await f.tasks.promoteReady()).not.toContain(id);
		expect(await statusOf(f, id)).toBe("backlog");
		expect((await f.tasks.get(id))?.body).toBe("details");
	});

	test("reprioritise a ready task, which changes no instructions", async () => {
		const f = await fixture();
		const t = await f.tasks.create({ title: "q", body: "b", status: "ready" });
		await f.writer.tasks.update({
			project,
			id: t.id,
			patch: { priority: "high" },
		});
		expect((await f.tasks.get(t.id))?.priority).toBe("high");
	});

	test("park a ready task", async () => {
		const f = await fixture();
		const t = await f.tasks.create({ title: "q", body: "b", status: "ready" });
		await f.writer.tasks.move({ project, id: t.id, to: "backlog" });
		expect(await f.tasks.promoteReady()).not.toContain(t.id);
		expect(await statusOf(f, t.id)).toBe("backlog");
	});
});

describe("runs:act is the scope that may dispatch", () => {
	test("it may edit a ready task and move a parked one to ready", async () => {
		const f = await fixture();
		const t = await f.tasks.create({ title: "q", body: "b", status: "ready" });
		await f.actor.tasks.update({ project, id: t.id, patch: { body: "new" } });
		expect((await f.tasks.get(t.id))?.body).toBe("new");
		const { id } = await f.actor.tasks.create({
			project,
			title: "mine",
			body: "spec",
		});
		await f.actor.tasks.move({ project, id, to: "ready" });
		expect(await statusOf(f, id)).toBe("ready");
	});
});

describe("the owner is unaffected", () => {
	test("edits and moves that a token may not make still work", async () => {
		const f = await fixture();
		const id = await titleOnly(f);
		await f.owner.tasks.update({ project, id, patch: { body: "spec" } });
		expect(await f.tasks.promoteReady()).toContain(id);
		const done = await parkedWithReopen(f, "done");
		await f.owner.tasks.move({ project, id: done, to: "backlog" });
		expect(await statusOf(f, done)).toBe("backlog");
	});
});
