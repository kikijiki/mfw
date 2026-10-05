import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardStore, parseBoardConfig } from "@mfw/board-core";
import {
	claimTask,
	releaseClaim,
	TaskOwnershipHeldError,
} from "../src/claim.ts";
import { MFW_CLAIM_FIELDS } from "../src/project.ts";
import { clearLease, readLease, writeLease } from "../src/state.ts";

const CONFIG = parseBoardConfig({
	mfw: 1,
	types: {
		task: {
			layout: "directory",
			dir: "tasks",
			primary: "task.md",
			id: { strategy: "own-sequence", key: "MFW" },
			slugFrom: "title",
			fields: {
				title: {},
				status: {
					values: ["backlog", "ready", "in_progress", "done"],
					default: "backlog",
				},
				depends_on: { ref: "task", list: true, acyclic: true, optional: true },
				owns: { list: true, optional: true },
			},
		},
	},
});

const dirs: string[] = [];
async function freshRoot(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "board-claim-"));
	dirs.push(dir);
	return dir;
}
afterEach(async () => {
	for (const dir of dirs.splice(0))
		await rm(dir, { recursive: true, force: true });
});

function claimConfig(root: string) {
	return { root, ...MFW_CLAIM_FIELDS };
}

describe("claimTask", () => {
	test("eight concurrent claimers, exactly one winner", async () => {
		const root = await freshRoot();
		const store = new BoardStore(root, CONFIG);
		const doc = await store.createDocument("task", {
			fields: { title: "contested" },
		});
		await store.updateDocument("task", doc.id, { fields: { status: "ready" } });

		const results = await Promise.all(
			Array.from({ length: 8 }, (_, i) =>
				claimTask(
					store,
					doc.id,
					`run-${i}`,
					60_000,
					"ready",
					claimConfig(root),
				),
			),
		);
		expect(results.filter(Boolean)).toHaveLength(1);
		const after = await store.readDocument("task", doc.id);
		expect(after?.fields.status).toBe("in_progress");
		const lease = await readLease(root, doc.id);
		expect(lease.claimedByRunId).toMatch(/^run-\d$/);
	});

	test("a task that is not ready cannot be claimed", async () => {
		const root = await freshRoot();
		const store = new BoardStore(root, CONFIG);
		const doc = await store.createDocument("task", {
			fields: { title: "backlogged" },
		});
		expect(
			await claimTask(
				store,
				doc.id,
				"run-1",
				60_000,
				"ready",
				claimConfig(root),
			),
		).toBeNull();
	});

	test("a claim is refused while a dependency is unfinished", async () => {
		const root = await freshRoot();
		const store = new BoardStore(root, CONFIG);
		const dep = await store.createDocument("task", {
			fields: { title: "dependency" },
		});
		const doc = await store.createDocument("task", {
			fields: { title: "dependent", status: "ready", depends_on: [dep.id] },
		});
		expect(
			await claimTask(
				store,
				doc.id,
				"run-1",
				60_000,
				"ready",
				claimConfig(root),
			),
		).toBeNull();

		await store.updateDocument("task", dep.id, { fields: { status: "done" } });
		const claimed = await claimTask(
			store,
			doc.id,
			"run-1",
			60_000,
			"ready",
			claimConfig(root),
		);
		expect(claimed?.fields.status).toBe("in_progress");
	});

	test("a claim is refused when it would overlap a currently active task's owns", async () => {
		const root = await freshRoot();
		const store = new BoardStore(root, CONFIG);
		const active = await store.createDocument("task", {
			fields: { title: "active", status: "in_progress", owns: ["src/api/**"] },
		});
		const next = await store.createDocument("task", {
			fields: { title: "next", status: "ready", owns: ["src/api/router.ts"] },
		});
		await expect(
			claimTask(store, next.id, "run-1", 60_000, "ready", claimConfig(root)),
		).rejects.toBeInstanceOf(TaskOwnershipHeldError);
		expect((await store.readDocument("task", active.id))?.fields.status).toBe(
			"in_progress",
		);
	});

	test("overlapping owns against a task that is not active does not block the claim", async () => {
		const root = await freshRoot();
		const store = new BoardStore(root, CONFIG);
		await store.createDocument("task", {
			fields: { title: "parked", status: "backlog", owns: ["src/api/**"] },
		});
		const next = await store.createDocument("task", {
			fields: { title: "next", status: "ready", owns: ["src/api/router.ts"] },
		});
		const claimed = await claimTask(
			store,
			next.id,
			"run-1",
			60_000,
			"ready",
			claimConfig(root),
		);
		expect(claimed?.fields.status).toBe("in_progress");
	});
});

describe("releaseClaim", () => {
	test("releases to the requested status and clears the lease", async () => {
		const root = await freshRoot();
		const store = new BoardStore(root, CONFIG);
		const doc = await store.createDocument("task", {
			fields: { title: "done soon", status: "ready" },
		});
		await claimTask(store, doc.id, "run-1", 60_000, "ready", claimConfig(root));

		const released = await releaseClaim(
			store,
			doc.id,
			"run-1",
			"done",
			claimConfig(root),
		);
		expect(released?.fields.status).toBe("done");
		expect((await readLease(root, doc.id)).claimedByRunId).toBeNull();
	});

	test("refuses to release a claim held by a different run", async () => {
		const root = await freshRoot();
		const store = new BoardStore(root, CONFIG);
		const doc = await store.createDocument("task", {
			fields: { title: "guarded", status: "ready" },
		});
		await claimTask(store, doc.id, "run-1", 60_000, "ready", claimConfig(root));
		expect(
			await releaseClaim(store, doc.id, "run-2", "done", claimConfig(root)),
		).toBeNull();
	});
});

describe("bind-only claims (start: false)", () => {
	const bind = { start: false, worktree: "/wt/a" };

	async function ready(root: string, fields: Record<string, unknown> = {}) {
		const store = new BoardStore(root, CONFIG);
		const doc = await store.createDocument("task", {
			fields: { title: "t", status: "ready", ...fields },
		});
		return { store, doc };
	}

	test("leaves status unchanged and records the worktree", async () => {
		const root = await freshRoot();
		const { store, doc } = await ready(root);
		const claimed = await claimTask(
			store,
			doc.id,
			"run-1",
			60_000,
			"ready",
			claimConfig(root),
			bind,
		);
		expect(claimed?.fields.status).toBe("ready");
		expect((await store.readDocument("task", doc.id))?.fields.status).toBe(
			"ready",
		);
		const lease = await readLease(root, doc.id);
		expect(lease.claimedByRunId).toBe("run-1");
		expect(lease.worktree).toBe("/wt/a");
		expect(lease.leaseExpiresAt).not.toBeNull();
	});

	test("works on an already-started task", async () => {
		const root = await freshRoot();
		const { store, doc } = await ready(root, { status: "in_progress" });
		const claimed = await claimTask(
			store,
			doc.id,
			"run-1",
			60_000,
			"ready",
			claimConfig(root),
			bind,
		);
		expect(claimed?.fields.status).toBe("in_progress");
		expect((await readLease(root, doc.id)).claimedByRunId).toBe("run-1");
	});

	test("refuses unmet dependencies", async () => {
		const root = await freshRoot();
		const store = new BoardStore(root, CONFIG);
		const dep = await store.createDocument("task", { fields: { title: "d" } });
		const doc = await store.createDocument("task", {
			fields: { title: "t", status: "ready", depends_on: [dep.id] },
		});
		expect(
			await claimTask(
				store,
				doc.id,
				"run-1",
				60_000,
				"ready",
				claimConfig(root),
				bind,
			),
		).toBeNull();
	});

	test("refuses a foreign live claim", async () => {
		const root = await freshRoot();
		const { store, doc } = await ready(root);
		const cfg = claimConfig(root);
		await claimTask(store, doc.id, "run-1", 60_000, "ready", cfg, bind);
		expect(
			await claimTask(store, doc.id, "run-2", 60_000, "ready", cfg, bind),
		).toBeNull();
		expect((await readLease(root, doc.id)).claimedByRunId).toBe("run-1");
	});

	test("refuses owns overlapping a claimed-but-not-started task", async () => {
		const root = await freshRoot();
		const { store, doc: a } = await ready(root, { owns: ["src/api/**"] });
		const b = await store.createDocument("task", {
			fields: { title: "b", status: "ready", owns: ["src/api/x.ts"] },
		});
		const cfg = claimConfig(root);
		await claimTask(store, a.id, "run-1", 60_000, "ready", cfg, bind);
		await expect(
			claimTask(store, b.id, "run-2", 60_000, "ready", cfg, bind),
		).rejects.toBeInstanceOf(TaskOwnershipHeldError);
	});

	test("two concurrent bind-only claims, exactly one winner", async () => {
		const root = await freshRoot();
		const { store, doc } = await ready(root);
		const results = await Promise.all(
			["run-1", "run-2"].map((r) =>
				claimTask(store, doc.id, r, 60_000, "ready", claimConfig(root), bind),
			),
		);
		expect(results.filter(Boolean)).toHaveLength(1);
	});

	test("release with null clears the lease and leaves status", async () => {
		const root = await freshRoot();
		const { store, doc } = await ready(root);
		const cfg = claimConfig(root);
		await claimTask(store, doc.id, "run-1", 60_000, "ready", cfg, bind);
		expect(await releaseClaim(store, doc.id, "run-2", null, cfg)).toBeNull();
		const released = await releaseClaim(store, doc.id, "run-1", null, cfg);
		expect(released?.fields.status).toBe("ready");
		const lease = await readLease(root, doc.id);
		expect(lease.claimedByRunId).toBeNull();
		expect(lease.worktree).toBeNull();
	});
});

describe("claim defaults and sidecar compat", () => {
	test("default start still flips status", async () => {
		const root = await freshRoot();
		const store = new BoardStore(root, CONFIG);
		const doc = await store.createDocument("task", {
			fields: { title: "t", status: "ready" },
		});
		const claimed = await claimTask(
			store,
			doc.id,
			"run-1",
			60_000,
			"ready",
			claimConfig(root),
		);
		expect(claimed?.fields.status).toBe("in_progress");
		expect((await readLease(root, doc.id)).worktree).toBeNull();
	});

	test("an old sidecar without worktree reads as null", async () => {
		const root = await freshRoot();
		await mkdir(join(root, "state", "tasks"), { recursive: true });
		await writeFile(
			join(root, "state", "tasks", "MFW-1.json"),
			JSON.stringify({
				claimedByRunId: "run-9",
				claimedAt: 1,
				leaseExpiresAt: 2,
				statusChangedAt: 3,
			}),
		);
		const lease = await readLease(root, "MFW-1");
		expect(lease.claimedByRunId).toBe("run-9");
		expect(lease.worktree).toBeNull();
	});
});

const WF_CONFIG = parseBoardConfig({
	mfw: 1,
	types: {
		task: {
			layout: "flat",
			dir: "tasks",
			id: { strategy: "own-sequence", key: "WF" },
			statusClasses: { terminal: ["done"], live: ["planned", "doing"] },
			fields: {
				title: {},
				status: { values: ["planned", "doing", "done"], default: "planned" },
				parent: { ref: "task", optional: true },
				children: { ref: "task", list: true, optional: true },
				depends_on: { ref: "task", list: true, optional: true },
			},
		},
	},
	hierarchy: { parent: "parent", children: "children" },
});

describe("claims follow the board's workflow readiness", () => {
	async function tree() {
		const root = await freshRoot();
		const store = new BoardStore(root, WF_CONFIG);
		const parent = await store.createDocument("task", {
			fields: { title: "p", status: "planned" },
		});
		const child = await store.createDocument("task", {
			fields: { title: "c", status: "planned", parent: parent.id },
		});
		return { root, store, parent, child };
	}
	const cfg = (root: string, withConfig: boolean) => ({
		root,
		...MFW_CLAIM_FIELDS,
		doneStatus: "done",
		activeStatus: "doing",
		...(withConfig ? { boardConfig: WF_CONFIG } : {}),
	});

	test("a parent with an open child is not claimable; ready once the child is terminal", async () => {
		const { root, store, parent, child } = await tree();
		const attempt = () =>
			claimTask(store, parent.id, "r", 60_000, "planned", cfg(root, true), {
				start: false,
			});
		expect(await attempt()).toBeNull();
		await store.updateDocument("task", child.id, {
			fields: { status: "done" },
		});
		expect(await attempt()).not.toBeNull();
	});

	test("depends_on in a terminal (non-'done') class is satisfied", async () => {
		const wf = parseBoardConfig({
			mfw: 1,
			types: {
				task: {
					layout: "flat",
					dir: "tasks",
					id: { strategy: "own-sequence", key: "WF" },
					statusClasses: { terminal: ["shipped"], live: ["planned"] },
					fields: {
						title: {},
						status: { values: ["planned", "shipped"], default: "planned" },
						depends_on: { ref: "task", list: true, optional: true },
					},
				},
			},
		});
		const r2 = await freshRoot();
		const s2 = new BoardStore(r2, wf);
		const dep = await s2.createDocument("task", { fields: { title: "d" } });
		const t = await s2.createDocument("task", {
			fields: { title: "t", depends_on: [dep.id] },
		});
		const c = { root: r2, ...MFW_CLAIM_FIELDS, boardConfig: wf };
		const go = () =>
			claimTask(s2, t.id, "r", 60_000, "planned", c, { start: false });
		expect(await go()).toBeNull();
		await s2.updateDocument("task", dep.id, { fields: { status: "shipped" } });
		expect(await go()).not.toBeNull();
	});

	test("without a config the old hierarchy-blind rule applies (daemon behaviour)", async () => {
		const { root, store, parent } = await tree();
		const got = await claimTask(
			store,
			parent.id,
			"r",
			60_000,
			"planned",
			cfg(root, false),
			{ start: false },
		);
		expect(got).not.toBeNull();
	});

	test("clearLease drops a binding and is a no-op without one", async () => {
		const root = await freshRoot();
		await clearLease(root, "X-1");
		expect((await readLease(root, "X-1")).claimedByRunId).toBeNull();
		await writeLease(root, "X-1", {
			claimedByRunId: "r",
			claimedAt: 1,
			leaseExpiresAt: 2,
			statusChangedAt: 1,
			worktree: "/w",
		});
		await clearLease(root, "X-1");
		const l = await readLease(root, "X-1");
		expect(l.claimedByRunId).toBeNull();
		expect(l.leaseExpiresAt).toBeNull();
		expect(l.worktree).toBeNull();
	});
});
