import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TokenPrincipal } from "@mfw/daemon/auth/service";
import { decide } from "@mfw/daemon/brain-runtime/decision-rights";
import {
	knownNonOwnerTask,
	recordProvenance,
	sessionProvenance,
	taskProvenance,
} from "@mfw/daemon/brain-runtime/provenance";
import { silentLogger } from "@mfw/daemon/log";
import type { Orchestrator, ProjectServices } from "@mfw/daemon/services";
import { openProjectDb } from "@mfw/db/client";
import { EventBus } from "@mfw/db/eventlog";
import { makeTasks } from "../../daemon/test/fixtures/board.ts";
import { appRouter } from "../src/root.ts";
import { createCallerFactory, type TokenAuditSink } from "../src/trpc.ts";

/**
 * Text a token wrote is not the owner's. The brain's taint rule is the control
 * against prompt injection, so these run the real provenance and rights code.
 */

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const c of cleanups.splice(0)) await c();
});

const audit: TokenAuditSink = {
	begin: async () => 1,
	finish: async () => {},
	refuse: async () => {},
};
const project = "demo";

async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), "mfw-test-token-prov-"));
	const mfwDir = join(dir, ".mfw");
	const handle = await openProjectDb(mfwDir);
	const bus = new EventBus();
	const tasks = await makeTasks(handle, bus, mfwDir);
	cleanups.push(async () => {
		handle.close();
		await rm(dir, { recursive: true, force: true });
	});
	const svc = {
		name: project,
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
	const writer = factory({
		orchestrator,
		tokenAudit: audit,
		principal: {
			kind: "token",
			id: "token:t1",
			tokenId: "t1",
			name: "ci",
			scopes: ["board:write"],
			project: null,
		} satisfies TokenPrincipal,
	});
	const owner = factory({
		orchestrator,
		principal: { kind: "owner", id: "o1", sessionId: "s1" },
	});
	return { tasks, handle, writer, owner, mfwDir };
}

type F = Awaited<ReturnType<typeof fixture>>;
const row = async (f: F, id: string) => {
	const t = await f.tasks.get(id);
	if (!t) throw new Error(`no task ${id}`);
	return t;
};

function expectUntrusted(t: Parameters<typeof taskProvenance>[0]) {
	expect(taskProvenance(t)).toBe("agent");
	expect(knownNonOwnerTask(t)).toBe(true);
}

/** What a real brain session concludes after reading this task. */
async function rightAfterReading(f: F, id: string) {
	await recordProvenance(
		f.handle,
		`S-${id}`,
		[taskProvenance(await row(f, id))],
		1,
	);
	return decide(
		["verification_change"],
		await sessionProvenance(f.handle, `S-${id}`),
	);
}

describe("a token's task", () => {
	test("is not the owner's", async () => {
		const f = await fixture();
		const { id } = await f.writer.tasks.create({ project, title: "t" });
		expectUntrusted(await row(f, id));
	});

	test("two tasks from one token are both created", async () => {
		const f = await fixture();
		const a = await f.writer.tasks.create({ project, title: "a" });
		const b = await f.writer.tasks.create({ project, title: "b" });
		expect(a.id).not.toBe(b.id);
	});

	test("raises verification_change to ask_first, like an agent's", async () => {
		const f = await fixture();
		const { id } = await f.writer.tasks.create({ project, title: "t" });
		const d = await rightAfterReading(f, id);
		expect(d.right).toBe("ask_first");
		expect(d.cause).toBe("taint");
		expect(d.right).toBe(decide(["verification_change"], ["agent"]).right);
	});

	test("control: the owner's task does not", async () => {
		const f = await fixture();
		const { id } = await f.owner.tasks.create({ project, title: "t" });
		expect(taskProvenance(await row(f, id))).toBe("owner_board");
		expect(knownNonOwnerTask(await row(f, id))).toBe(false);
		expect((await rightAfterReading(f, id)).right).toBe("notify_after");
	});
});

describe("an owner's task a token has edited", () => {
	const parked = async (f: F) =>
		(
			await f.owner.tasks.create({
				project,
				title: "owner's",
				status: "backlog",
			})
		).id;

	for (const [label, edit] of [
		[
			"body",
			(f: F, id: string) =>
				f.writer.tasks.update({ project, id, patch: { body: "x" } }),
		],
		[
			"priority",
			(f: F, id: string) =>
				f.writer.tasks.update({ project, id, patch: { priority: "high" } }),
		],
		[
			"criteria",
			(f: F, id: string) =>
				f.writer.tasks.criteria({
					project,
					id,
					op: { op: "add", text: "c" },
				}),
		],
	] as const)
		test(`is untrusted after a ${label} edit`, async () => {
			const f = await fixture();
			const id = await parked(f);
			await edit(f, id);
			expectUntrusted(await row(f, id));
			expect((await rightAfterReading(f, id)).right).toBe("ask_first");
		});

	test("the mark does not depend on the board declaring edited_by", async () => {
		const f = await fixture();
		const id = await parked(f);
		const store = (f.tasks as unknown as { store: { declaresField: unknown } })
			.store;
		store.declaresField = () => false;
		await f.writer.tasks.update({ project, id, patch: { body: "x" } });
		const t = await row(f, id);
		expect(t.editedBy ?? null).toBeNull();
		expectUntrusted(t);
	});

	test("an owner's later edit does not clear it", async () => {
		const f = await fixture();
		const id = await parked(f);
		await f.writer.tasks.update({ project, id, patch: { body: "x" } });
		await f.owner.tasks.update({ project, id, patch: { title: "owner's" } });
		expectUntrusted(await row(f, id));
	});

	test("the mark survives a reload of the board", async () => {
		const f = await fixture();
		const id = await parked(f);
		await f.writer.tasks.update({ project, id, patch: { body: "x" } });
		const again = await makeTasks(f.handle, new EventBus(), f.mfwDir);
		const reloaded = await again.get(id);
		if (!reloaded) throw new Error("the task did not reload");
		expectUntrusted(reloaded);
	});

	test("a refused edit does not taint the owner's task", async () => {
		const f = await fixture();
		const { id } = await f.owner.tasks.create({ project, title: "ready one" });
		await expect(
			f.writer.tasks.update({ project, id, patch: { body: "x" } }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(taskProvenance(await row(f, id))).toBe("owner_board");
	});
});
