import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxItem } from "@mfw/daemon/inbox";
import type { Orchestrator, ProjectServices } from "@mfw/daemon/services";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import { createCaller } from "../src/root.ts";

const opened: { root: string; handle: ProjectDbHandle }[] = [];
let inboxReads = 0;

afterEach(async () => {
	for (const { root, handle } of opened.splice(0)) {
		handle.close();
		await rm(root, { recursive: true, force: true });
	}
});

async function setup(count: number) {
	const root = await mkdtemp(join(tmpdir(), "mfw-inbox-budget-"));
	const handle = await openProjectDb(join(root, ".mfw"));
	opened.push({ root, handle });
	const now = Date.now();
	const items: InboxItem[] = Array.from({ length: count }, (_, i) => ({
		id: `review:${i}`,
		project: "alpha",
		kind: "review",
		severity: "attention",
		attention: "act",
		title: `r${i}`,
		detail: "",
		ref: "brain",
		ts: now - 1000 + i,
	}));
	const svc = {
		name: "alpha",
		handle,
		inbox: {
			list: async () => {
				inboxReads++;
				return items;
			},
		},
		budgets: { list: async () => [] },
	} as unknown as ProjectServices;
	const orchestrator = {
		list: () => [svc],
		get: () => svc,
	} as unknown as Orchestrator;
	return createCaller({ orchestrator });
}

describe("inbox router: act budget", () => {
	test("list keeps every item and flags the excess", async () => {
		const api = await setup(7);
		const out = await api.inbox.list();
		expect(out.items).toHaveLength(7);
		expect(out.counts.total).toBe(7);
		expect(out.items.filter((i) => i.heldBack)).toHaveLength(2);
		expect(out.budget?.heldBack).toBe(2);
	});

	test("the headline names the held-back count", async () => {
		const api = await setup(7);
		const [headline] = await api.inbox.headlines();
		expect(headline?.needsYou).toBe(7);
		expect(headline?.heldBack).toBe(2);
		expect(headline?.text).toContain("2 held back");
	});

	test("the headlines route collects the inbox once", async () => {
		const api = await setup(3);
		inboxReads = 0;
		await api.inbox.headlines();
		expect(inboxReads).toBe(1);
	});
});
