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
import { decisions } from "@mfw/db/schema";
import { eq } from "drizzle-orm";
import { makeTasks } from "../../daemon/test/fixtures/board.ts";
import { appRouter } from "../src/root.ts";
import { createCallerFactory, type TokenAuditSink } from "../src/trpc.ts";

/** What a token's calls actually do to a real board and audit trail. */

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const c of cleanups.splice(0)) await c();
});

const audit: TokenAuditSink = {
	begin: async () => 1,
	finish: async () => {},
	refuse: async () => {},
};

async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), "mfw-test-token-effects-"));
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
	const asOwner = factory({
		orchestrator,
		principal: { kind: "owner", id: "o1", sessionId: "s1" },
	});
	return { asToken, asOwner, tasks, handle };
}

describe("a token's task", () => {
	test("is parked: only the owner's default create is automatic", async () => {
		const { asToken, asOwner, tasks } = await fixture();
		const byToken = await asToken(["board:write"]).tasks.create({
			project: "demo",
			title: "from a token",
		});
		const byOwner = await asOwner.tasks.create({
			project: "demo",
			title: "from the owner",
		});
		expect((await tasks.get(byToken.id))?.readyMode).toBe("manual");
		expect((await tasks.get(byOwner.id))?.readyMode).toBe("automatic");
		const promoted = await tasks.promoteReady();
		expect(promoted).not.toContain(byToken.id);
		expect((await tasks.get(byToken.id))?.status).toBe("backlog");
	});

	test("the audit row names the token, and an owner's row does not", async () => {
		const { asToken, asOwner, handle } = await fixture();
		await asToken(["board:write"]).tasks.create({
			project: "demo",
			title: "from a token",
		});
		await asOwner.tasks.create({ project: "demo", title: "from the owner" });
		const rows = await handle.db
			.select()
			.from(decisions)
			.where(eq(decisions.role, "human"));
		const inputs = rows.map((r) => r.input as Record<string, unknown>);
		expect(inputs.find((i) => i.title === "from a token")?.principal).toEqual({
			kind: "token",
			id: "token:t1",
			name: "ci",
		});
		expect(
			inputs.find((i) => i.title === "from the owner")?.principal,
		).toBeUndefined();
	});
});
