import { describe, expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import { appendEvent, EventBus, type StoredEvent } from "@mfw/db/eventlog";
import { triggerCursor, triggerDeliveries } from "@mfw/db/schema";
import { eq } from "drizzle-orm";
import { InboxService } from "../src/inbox.ts";
import { silentLogger } from "../src/log.ts";
import {
	noopAction,
	TriggerActionRegistry,
	type TriggerActionResult,
} from "../src/triggers/actions.ts";
import { ArmingStore } from "../src/triggers/arming.ts";
import { loadTriggerDefs } from "../src/triggers/def.ts";
import { matchesEvent } from "../src/triggers/events.ts";
import {
	deliveryIdFor,
	NotFoundError,
	TriggerService,
} from "../src/triggers/service.ts";
import { makeTasks } from "./fixtures/board.ts";

/** Trigger spine tests, focused on silent failures: typos that never fire, edited triggers that keep firing, history replay on arming, cursors pinned by failing actions. */

interface F {
	root: string;
	home: string;
	handle: ProjectDbHandle;
	bus: EventBus;
	svc: TriggerService;
	arming: ArmingStore;
	ran: { defId: string; deliveryId: string; seq: number }[];
	notifications: { kind: string; detail: Record<string, unknown> }[];
	holds: { untilMs: number; reason: string }[];
	def: (name: string, body: string) => Promise<void>;
	emit: (
		type: string,
		payload: Record<string, unknown>,
		extra?: Record<string, unknown>,
	) => Promise<StoredEvent>;
	cleanup: () => Promise<void>;
}

async function fixture(
	opts: { result?: () => TriggerActionResult; now?: () => number } = {},
): Promise<F> {
	const root = await mkdtemp(join(tmpdir(), "mfw-trig-"));
	const home = await mkdtemp(join(tmpdir(), "mfw-home-"));
	const handle = await openProjectDb(join(root, ".mfw"));
	const bus = new EventBus();
	const ran: F["ran"] = [];
	const notifications: F["notifications"] = [];
	const holds: F["holds"] = [];
	const actions = new TriggerActionRegistry();
	const record = async (d: {
		def: { id: string };
		deliveryId: string;
		event: { seq: number };
	}) => {
		ran.push({ defId: d.def.id, deliveryId: d.deliveryId, seq: d.event.seq });
		return opts.result ? opts.result() : { ok: true };
	};
	for (const kind of ["notify", "script", "agent"] as const) {
		actions.register(kind, record);
	}
	const svc = new TriggerService({
		handle,
		bus,
		log: silentLogger(),
		projectRoot: root,
		projectName: "demo",
		mfwHome: home,
		actions,
		now: opts.now,
		notifier: {
			notify: async (kind, detail) => {
				notifications.push({ kind, detail });
				return [];
			},
		},
		holdDispatch: async (untilMs, reason) => {
			holds.push({ untilMs, reason });
		},
	});
	return {
		root,
		home,
		handle,
		bus,
		svc,
		arming: ArmingStore.at(home, "demo"),
		ran,
		notifications,
		holds,
		def: async (name, body) => {
			await mkdir(join(root, ".mfw", "triggers"), { recursive: true });
			await writeFile(join(root, ".mfw", "triggers", name), body);
		},
		emit: async (type, payload, extra = {}) => {
			const stored = await handle.withTx((tx) =>
				appendEvent(tx, { type, payload, ...extra } as never),
			);
			bus.publish([stored]);
			return stored;
		},
		cleanup: async () => {
			handle.close();
			await rm(root, { recursive: true, force: true });
			await rm(home, { recursive: true, force: true });
		},
	};
}

const DEPLOY = `---
id: deploy-on-merge
title: Deploy main after a merge lands
on:
  type: merge.completed
  where: { target: main }
action: notify
message: "{{merge.sha}} landed on {{merge.target}}"
catchup: latest
---

Deploys whatever is on main.
`;

const merged = (target: string, sha: string) => ({
	sha,
	target,
});

describe("the definition format", () => {
	test("a complete definition round-trips through the loader", async () => {
		const f = await fixture();
		await f.def("deploy-on-merge.md", DEPLOY);
		const { defs, quarantined } = await loadTriggerDefs(
			join(f.root, ".mfw", "triggers"),
			silentLogger(),
		);
		expect(quarantined).toEqual([]);
		const def = defs[0];
		expect(def?.id).toBe("deploy-on-merge");
		expect(def?.enabled).toBe(true);
		expect(def?.source).toEqual({
			kind: "event",
			match: {
				kind: "where",
				type: "merge.completed",
				where: { target: "main" },
			},
		});
		expect(def?.action).toEqual({
			kind: "notify",
			message: "{{merge.sha}} landed on {{merge.target}}",
		});
		expect(def?.catchup).toBe("latest");
		expect(def?.concurrency).toBe("serial"); // the defaults
		expect(def?.onFailure).toBe("inbox");
		expect(def?.hash).toStartWith("sha256:");
		await f.cleanup();
	});

	const rejections: [string, string, string][] = [
		[
			"an unknown event type",
			`---\non: merge.finished\naction: notify\nmessage: hi\n---\n`,
			"not a triggerable event",
		],
		[
			"an unknown `where` field",
			`---\non: { type: merge.completed, where: { branch: main } }\naction: notify\nmessage: hi\n---\n`,
			'not "branch"',
		],
		[
			"a glob that matches nothing",
			`---\non: deploy.*\naction: notify\nmessage: hi\n---\n`,
			"matches no triggerable event type",
		],
		[
			"a script with no command",
			`---\non: main.red\naction: script\n---\n`,
			"needs a `run` command",
		],
		[
			"a non-finite timeout",
			`---\non: main.red\naction: script\nrun: ./x.sh\ntimeout_ms: forever\n---\n`,
			"finite positive integer",
		],
		[
			"a timeout past the hard cap",
			`---\non: main.red\naction: script\nrun: ./x.sh\ntimeout_ms: 7200000\n---\n`,
			"may not exceed",
		],
		[
			"an unknown prompt placeholder",
			`---\non: main.red\naction: agent\nprompt: "fix {{task.owner}}"\n---\n`,
			"unknown placeholder",
		],
		[
			"a placeholder inside a shell command",
			`---\non: main.red\naction: script\nrun: "deploy.sh {{task.title}}"\n---\n`,
			"injection",
		],
		[
			"an expression where equality was allowed",
			`---\non: { type: task.status_changed, where: { to: [done, review] } }\naction: notify\nmessage: hi\n---\n`,
			"scalar",
		],
		["no action at all", `---\non: main.red\n---\n`, "`action` is required"],
	];

	for (const [what, body, expected] of rejections) {
		test(`${what} is quarantined with a reason, never silently ignored`, async () => {
			const f = await fixture();
			await f.def("bad.md", body);
			await f.def("deploy-on-merge.md", DEPLOY);
			const { defs, quarantined } = await loadTriggerDefs(
				join(f.root, ".mfw", "triggers"),
				silentLogger(),
			);
			expect(quarantined).toHaveLength(1);
			expect(quarantined[0]?.file).toBe("bad.md");
			expect(quarantined[0]?.reason).toContain(expected);
			expect(defs.map((d) => d.id)).toEqual(["deploy-on-merge"]);
			await f.cleanup();
		});
	}

	test("an id violating the grammar is rejected", async () => {
		const f = await fixture();
		await f.def(
			"bad.md",
			`---\nid: Not_Valid\non: main.red\naction: notify\nmessage: hi\n---\n`,
		);
		const { defs, quarantined } = await loadTriggerDefs(
			join(f.root, ".mfw", "triggers"),
			silentLogger(),
		);
		expect(defs).toEqual([]);
		expect(quarantined[0]?.reason).toContain("id must match");
		await f.cleanup();
	});
});

describe("the matcher", () => {
	const ev = (type: string, payload: Record<string, unknown>) =>
		({ type, payload }) as Pick<StoredEvent, "type" | "payload">;

	test("exact, prefix and where, and nothing else", () => {
		expect(
			matchesEvent(
				{ kind: "exact", type: "merge.completed" },
				ev("merge.completed", {}),
			),
		).toBe(true);
		expect(
			matchesEvent(
				{ kind: "exact", type: "merge.completed" },
				ev("merge.parked", {}),
			),
		).toBe(false);

		const prefix = { kind: "prefix", prefix: "task" } as const;
		expect(matchesEvent(prefix, ev("task.created", {}))).toBe(true);
		expect(matchesEvent(prefix, ev("task.status_changed", {}))).toBe(true);
		expect(matchesEvent(prefix, ev("merge.completed", {}))).toBe(false);

		const where = {
			kind: "where",
			type: "task.status_changed",
			where: { to: "done" },
		} as const;
		expect(matchesEvent(where, ev("task.status_changed", { to: "done" }))).toBe(
			true,
		);
		expect(
			matchesEvent(where, ev("task.status_changed", { to: "review" })),
		).toBe(false);
		// A missing field is not a match.
		expect(matchesEvent(where, ev("task.status_changed", {}))).toBe(false);
	});

	test("a non-allowlisted event never matches, whatever the matcher says", () => {
		expect(
			matchesEvent(
				{ kind: "prefix", prefix: "run" },
				ev("run.finalize_step", {}),
			),
		).toBe(false);
		expect(
			matchesEvent(
				{ kind: "exact", type: "run.started" },
				ev("run.started", {}),
			),
		).toBe(false);
	});

	test("an alias keeps an old event name working", () => {
		const aliases = { "merge.done": "merge.completed" };
		expect(
			matchesEvent(
				{ kind: "exact", type: "merge.completed" },
				ev("merge.done", { target: "main" }),
				aliases,
			),
		).toBe(true);
	});
});

describe("arming", () => {
	test("a definition in the repo is INERT until it is armed", async () => {
		const f = await fixture();
		await f.def("deploy-on-merge.md", DEPLOY);
		const [view] = await f.svc.list();
		expect(view?.state).toBe("unarmed");
		expect(view?.reason).toContain("present, not armed");
		expect(view?.cursor).toBeNull();

		await f.emit("merge.completed", merged("main", "abc"), { runId: "r1" });
		expect(await f.svc.dispatch()).toMatchObject({ armed: 0, dispatched: 0 });
		expect(f.ran).toEqual([]);
		await f.cleanup();
	});

	test("arming starts the cursor at HEAD, so history is never replayed", async () => {
		// Arming a deploy trigger must not deploy every sha ever merged.
		const f = await fixture();
		await f.def("deploy-on-merge.md", DEPLOY);
		for (const sha of ["a", "b", "c"]) {
			await f.emit("merge.completed", merged("main", sha), {
				runId: `r-${sha}`,
			});
		}
		const head = (await f.handle.db.select().from(triggerCursor)).length; // no cursor yet
		expect(head).toBe(0);

		const view = await f.svc.arm("deploy-on-merge", { by: "test" });
		expect(view.state).toBe("armed");
		expect(view.cursor).toBe(3);

		expect(await f.svc.dispatch()).toMatchObject({ dispatched: 0 });
		expect(f.ran).toEqual([]);
		await f.cleanup();
	});

	test("the arming record lives in the daemon home, chmod 600", async () => {
		const f = await fixture();
		await f.def("deploy-on-merge.md", DEPLOY);
		await f.svc.arm("deploy-on-merge", {
			by: "kiki",
			secrets: ["deploy_token"],
		});

		const path = join(f.home, "triggers", "demo.json");
		const parsed = JSON.parse(await readFile(path, "utf8"));
		expect(parsed["deploy-on-merge"].armedBy).toBe("kiki");
		expect(parsed["deploy-on-merge"].secrets).toEqual(["deploy_token"]);
		expect(parsed["deploy-on-merge"].hash).toStartWith("sha256:");
		expect(parsed["deploy-on-merge"].definition).toBe(DEPLOY);
		expect((await stat(path)).mode & 0o777).toBe(0o600);
		// Nothing about the arming is written into the repository.
		expect(
			await readFile(join(f.root, ".mfw/triggers/deploy-on-merge.md"), "utf8"),
		).not.toContain("armed");
		await f.cleanup();
	});

	test("editing an armed definition DISARMS it and says so", async () => {
		// An agent's silent edit to a hook must surface as "a trigger you armed was modified".
		const f = await fixture();
		await f.def("deploy-on-merge.md", DEPLOY);
		await f.svc.arm("deploy-on-merge");

		await f.def(
			"deploy-on-merge.md",
			DEPLOY.replace("notify", "notify\n# tampered"),
		);
		const events: string[] = [];
		f.bus.subscribe((e) => events.push(e.type));

		const [view] = await f.svc.list();
		expect(view?.state).toBe("drifted");
		expect(view?.reason).toContain("changed after it was armed");
		expect(view?.armedHash).not.toBe(view?.hash);
		expect(view?.approvedDefinition).toBe(DEPLOY);
		expect(view?.definition).toContain("# tampered");
		expect(events).toContain("trigger.disarmed");

		await f.emit("merge.completed", merged("main", "abc"), { runId: "r1" });
		expect(await f.svc.dispatch()).toMatchObject({ armed: 0 });
		expect(f.ran).toEqual([]);
		await f.cleanup();
	});

	test("the disarm is STICKY, so the inbox item survives the next refresh", async () => {
		// Deleting the record on drift would clear the inbox item on the next refresh.
		const f = await fixture();
		await f.def("deploy-on-merge.md", DEPLOY);
		await f.svc.arm("deploy-on-merge");
		await f.def("deploy-on-merge.md", `${DEPLOY}\nedited\n`);

		await f.svc.list();
		await f.svc.list();
		await f.svc.list();
		const disarmed = await f.svc.disarmed();
		expect(disarmed).toHaveLength(1);
		expect(disarmed[0]).toMatchObject({
			defId: "deploy-on-merge",
			reason: "hash-drift",
		});

		// The event is raised once per distinct drift.
		const events: string[] = [];
		f.bus.subscribe((e) => events.push(e.type));
		await f.svc.list();
		expect(events).toEqual([]);
		await f.cleanup();
	});

	test("re-arming clears the drift and RESUMES rather than replaying", async () => {
		const f = await fixture();
		await f.def("deploy-on-merge.md", DEPLOY);
		await f.svc.arm("deploy-on-merge");
		await f.emit("merge.completed", merged("main", "a"), { runId: "r1" });
		await f.svc.dispatch();
		expect(f.ran).toHaveLength(1);

		await f.def("deploy-on-merge.md", `${DEPLOY}\nreviewed and approved\n`);
		await f.svc.list();
		const before = (await f.handle.db.select().from(triggerCursor))[0]?.lastSeq;

		const view = await f.svc.arm("deploy-on-merge");
		expect(view.state).toBe("armed");
		expect(view.approvedDefinition).toContain("reviewed and approved");
		expect(await f.svc.disarmed()).toEqual([]);
		expect((await f.handle.db.select().from(triggerCursor))[0]?.lastSeq).toBe(
			before as number,
		);
		await f.cleanup();
	});

	test("approval refuses a definition that changed after review opened", async () => {
		const f = await fixture();
		await f.def("deploy-on-merge.md", DEPLOY);
		const [reviewed] = await f.svc.list();
		await f.def("deploy-on-merge.md", `${DEPLOY}\nchanged after review\n`);

		await expect(
			f.svc.arm("deploy-on-merge", {
				expectedHash: reviewed?.hash,
			}),
		).rejects.toMatchObject({ name: "TriggerReviewStaleError" });
		expect((await f.svc.list())[0]?.state).toBe("unarmed");
		await f.cleanup();
	});

	test("a matching pre-snapshot arming record is upgraded without re-approval", async () => {
		const f = await fixture();
		await f.def("deploy-on-merge.md", DEPLOY);
		const [before] = await f.svc.list();
		await f.arming.arm("deploy-on-merge", before?.hash ?? "");

		const [view] = await f.svc.list();
		expect(view?.state).toBe("armed");
		expect(view?.approvedDefinition).toBe(DEPLOY);
		expect((await f.arming.load())["deploy-on-merge"]?.definition).toBe(DEPLOY);
		await f.cleanup();
	});

	test("a secret requested but not granted is a refusal to dispatch", async () => {
		const f = await fixture();
		await f.def(
			"deploy-on-merge.md",
			DEPLOY.replace(
				"catchup: latest",
				"secrets: [deploy_token]\ncatchup: latest",
			),
		);
		await f.svc.arm("deploy-on-merge"); // armed, but granting nothing
		const [view] = await f.svc.list();
		expect(view?.state).toBe("needs-secrets");
		expect(view?.missingSecrets).toEqual(["deploy_token"]);

		await f.emit("merge.completed", merged("main", "a"), { runId: "r1" });
		expect(await f.svc.dispatch()).toMatchObject({ armed: 0 });
		expect(f.ran).toEqual([]);

		await f.svc.arm("deploy-on-merge", { secrets: ["deploy_token"] });
		expect((await f.svc.list())[0]?.state).toBe("armed");
		await f.cleanup();
	});

	test("an arming record whose definition vanished is surfaced, not silent", async () => {
		const f = await fixture();
		await f.def("deploy-on-merge.md", DEPLOY);
		await f.svc.arm("deploy-on-merge");
		await rm(join(f.root, ".mfw/triggers/deploy-on-merge.md"));

		const [view] = await f.svc.list();
		expect(view?.state).toBe("orphaned");
		expect(view?.reason).toContain("no definition file");
		expect((await f.svc.disarmed())[0]?.reason).toBe("definition-removed");
		await f.cleanup();
	});
});

describe("delivery", () => {
	test("a matching event dispatches once, with a stable delivery id", async () => {
		const f = await fixture();
		await f.def("deploy-on-merge.md", DEPLOY);
		await f.svc.arm("deploy-on-merge");
		const ev = await f.emit("merge.completed", merged("main", "abc"), {
			runId: "r1",
		});

		expect(await f.svc.dispatch()).toMatchObject({ dispatched: 1, failed: 0 });
		expect(f.ran).toEqual([
			{
				defId: "deploy-on-merge",
				deliveryId: deliveryIdFor("deploy-on-merge", ev.seq),
				seq: ev.seq,
			},
		]);
		const [row] = await f.handle.db.select().from(triggerDeliveries);
		expect(row?.state).toBe("ok");
		expect(row?.eventSeq).toBe(ev.seq);
		expect(row?.id).toBe(deliveryIdFor("deploy-on-merge", ev.seq));

		expect(await f.svc.dispatch()).toMatchObject({ dispatched: 0 });
		expect(f.ran).toHaveLength(1);
		await f.cleanup();
	});

	test("`where` really filters: a merge to another branch does nothing", async () => {
		const f = await fixture();
		await f.def("deploy-on-merge.md", DEPLOY);
		await f.svc.arm("deploy-on-merge");
		await f.emit("merge.completed", merged("release", "abc"), { runId: "r1" });
		expect(await f.svc.dispatch()).toMatchObject({ dispatched: 0 });
		expect(f.ran).toEqual([]);
		// The cursor still moves past non-matching events.
		expect((await f.handle.db.select().from(triggerCursor))[0]?.lastSeq).toBe(
			1,
		);
		await f.cleanup();
	});

	test("the timeline and the deliveries table both record what fired", async () => {
		const f = await fixture();
		await f.def("deploy-on-merge.md", DEPLOY);
		await f.svc.arm("deploy-on-merge");
		const events: string[] = [];
		f.bus.subscribe((e) => events.push(e.type));
		await f.emit("merge.completed", merged("main", "abc"), { runId: "r1" });
		await f.svc.dispatch();
		expect(events).toContain("trigger.dispatched");
		expect(await f.svc.deliveries("deploy-on-merge")).toHaveLength(1);
		await f.cleanup();
	});

	test("a failing action marks the delivery failed and ADVANCES the cursor", async () => {
		// Holding the cursor at a poison event would stop all later deliveries.
		const f = await fixture({ result: () => ({ ok: false, detail: "boom" }) });
		await f.def("deploy-on-merge.md", DEPLOY);
		await f.svc.arm("deploy-on-merge");
		const events: string[] = [];
		f.bus.subscribe((e) => events.push(e.type));
		const first = await f.emit("merge.completed", merged("main", "a"), {
			runId: "r1",
		});
		expect(await f.svc.dispatch()).toMatchObject({ failed: 1 });
		expect(events).toContain("trigger.failed");
		const [row] = await f.handle.db.select().from(triggerDeliveries);
		expect(row?.state).toBe("failed");
		expect(row?.detail).toBe("boom");
		expect((await f.handle.db.select().from(triggerCursor))[0]?.lastSeq).toBe(
			first.seq,
		);

		await f.emit("merge.completed", merged("main", "b"), { runId: "r2" });
		expect(await f.svc.dispatch()).toMatchObject({ failed: 1 });
		expect(f.ran).toHaveLength(2);
		await f.cleanup();
	});

	test("an action kind with no handler FAILS loudly rather than looking fine", async () => {
		const f = await fixture();
		const svc = new TriggerService({
			handle: f.handle,
			bus: f.bus,
			log: silentLogger(),
			projectRoot: f.root,
			projectName: "demo",
			mfwHome: f.home,
			actions: new TriggerActionRegistry(), // nothing registered, as boot has it
		});
		await f.def("deploy-on-merge.md", DEPLOY);
		await svc.arm("deploy-on-merge");
		await f.emit("merge.completed", merged("main", "a"), { runId: "r1" });
		expect(await svc.dispatch()).toMatchObject({ failed: 1, dispatched: 0 });
		const [row] = await f.handle.db.select().from(triggerDeliveries);
		expect(row?.state).toBe("failed");
		expect(row?.detail).toContain("no handler registered");
		await f.cleanup();
	});

	test("a replay reuses the delivery id and counts attempts", async () => {
		const f = await fixture();
		await f.def("deploy-on-merge.md", DEPLOY);
		await f.svc.arm("deploy-on-merge");
		const ev = await f.emit("merge.completed", merged("main", "a"), {
			runId: "r1",
		});
		await f.svc.dispatch();

		// Simulates a crash between the action and the cursor advance.
		await f.handle.db
			.update(triggerCursor)
			.set({ lastSeq: ev.seq - 1, updatedAt: new Date() })
			.where(eq(triggerCursor.defId, "deploy-on-merge"));
		await f.svc.dispatch();

		const rows = await f.handle.db.select().from(triggerDeliveries);
		expect(rows).toHaveLength(1); // one row, not two
		expect(rows[0]?.attempt).toBe(2);
		expect(f.ran).toHaveLength(2); // at-least-once: the action ran twice
		await f.cleanup();
	});
});

describe("catch-up policies", () => {
	async function withBacklog(catchup: string, n = 3): Promise<F> {
		const f = await fixture();
		await f.def(
			"deploy-on-merge.md",
			DEPLOY.replace("catchup: latest", `catchup: ${catchup}`),
		);
		await f.svc.arm("deploy-on-merge");
		for (let i = 0; i < n; i++) {
			await f.emit("merge.completed", merged("main", `sha${i}`), {
				runId: `r${i}`,
			});
		}
		return f;
	}

	test("`latest` coalesces to the newest and NAMES what it skipped", async () => {
		const f = await withBacklog("latest");
		expect(await f.svc.dispatch()).toMatchObject({ dispatched: 1, skipped: 2 });
		expect(f.ran.map((r) => r.seq)).toEqual([3]);
		const [row] = await f.svc.deliveries("deploy-on-merge");
		expect(row?.skippedSeqs).toEqual([1, 2]);
		await f.cleanup();
	});

	test("`all` dispatches every missed match in seq order", async () => {
		const f = await withBacklog("all");
		expect(await f.svc.dispatch()).toMatchObject({ dispatched: 3 });
		expect(f.ran.map((r) => r.seq)).toEqual([1, 2, 3]);
		await f.cleanup();
	});

	test("`none` drops the backlog, records it, and jumps to head", async () => {
		const f = await withBacklog("none");
		expect(await f.svc.dispatch()).toMatchObject({ dispatched: 0, skipped: 3 });
		expect(f.ran).toEqual([]);
		const [row] = await f.svc.deliveries("deploy-on-merge");
		expect(row?.state).toBe("skipped");
		expect(row?.skippedSeqs).toEqual([1, 2, 3]);
		expect((await f.handle.db.select().from(triggerCursor))[0]?.lastSeq).toBe(
			3,
		);
		await f.cleanup();
	});

	test("`catchup: all` past its cap degrades to latest rather than firing 200 times", async () => {
		const f = await withBacklog("all", 60);
		const pass = await f.svc.dispatch();
		expect(pass.dispatched).toBe(1);
		expect(pass.skipped).toBe(59);
		expect(f.ran.map((r) => r.seq)).toEqual([60]);
		await f.cleanup();
	});

	test("catchup answers the RESTART case; concurrency answers the running one", async () => {
		// First pass drains the backlog, later passes coalesce.
		const f = await fixture();
		await f.def(
			"deploy-on-merge.md",
			DEPLOY.replace("catchup: latest", "catchup: all\nconcurrency: latest"),
		);
		await f.svc.arm("deploy-on-merge");
		for (const sha of ["a", "b"]) {
			await f.emit("merge.completed", merged("main", sha), { runId: sha });
		}
		expect(await f.svc.dispatch()).toMatchObject({ dispatched: 2 });

		for (const sha of ["c", "d"]) {
			await f.emit("merge.completed", merged("main", sha), { runId: sha });
		}
		expect(await f.svc.dispatch()).toMatchObject({ dispatched: 1, skipped: 1 });
		// c and d are seqs 5 and 6: the first pass's own (non-triggerable)
		// `trigger.dispatched` rows occupy 3 and 4.
		expect(f.ran.map((r) => r.seq)).toEqual([1, 2, 6]);
		await f.cleanup();
	});
});

describe("the placeholder action seam", () => {
	test("the no-op reports success without touching the world", async () => {
		const registry = new TriggerActionRegistry().register("notify", noopAction);
		expect(registry.has("notify")).toBe(true);
		expect(registry.has("script")).toBe(false);
		const out = await registry.run({
			def: { action: { kind: "notify" } },
		} as never);
		expect(out.ok).toBe(true);
		expect(out.detail).toContain("no-op placeholder");
	});
});

describe("the inbox says a trigger stopped firing", () => {
	test("hash drift raises an item that stays until a human acts", async () => {
		const f = await fixture();
		const tasks = await makeTasks(f.handle, f.bus, join(f.root, ".mfw"));
		const inbox = new InboxService({
			handle: f.handle,
			project: "demo",
			tasks,
			triggers: f.svc,
		});
		await f.def("deploy-on-merge.md", DEPLOY);
		await f.svc.arm("deploy-on-merge", { by: "kiki" });
		expect((await inbox.list()).map((i) => i.kind)).not.toContain(
			"trigger_disarmed",
		);

		await f.def("deploy-on-merge.md", `${DEPLOY}\nan agent edited this\n`);
		await f.svc.list(); // notices the drift

		const item = (await inbox.list()).find(
			(i) => i.kind === "trigger_disarmed",
		);
		expect(item?.id).toBe("trigger_disarmed:deploy-on-merge");
		expect(item?.severity).toBe("attention");
		expect(item?.detail).toContain("changed after kiki armed it");
		expect(
			(await inbox.list()).some((i) => i.kind === "trigger_disarmed"),
		).toBe(true);

		await f.svc.arm("deploy-on-merge");
		expect(
			(await inbox.list()).some((i) => i.kind === "trigger_disarmed"),
		).toBe(false);
		await f.cleanup();
	});
});

describe("retry, dead-lettering and on_failure", () => {
	test("retries up to the budget with backoff, then dead-letters and advances the cursor", async () => {
		let clock = 1_000_000;
		let calls = 0;
		const f = await fixture({
			now: () => clock,
			result: () => {
				calls++;
				return { ok: false, detail: `boom ${calls}` };
			},
		});
		await f.def(
			"deploy-on-merge.md",
			DEPLOY.replace("catchup: latest", "catchup: latest\nretries: 2"),
		);
		await f.svc.arm("deploy-on-merge");
		const ev = await f.emit("merge.completed", merged("main", "a"), {
			runId: "r1",
		});

		// Attempt 1 fails; budget remains, so the cursor must not move.
		expect(await f.svc.dispatch()).toMatchObject({ dispatched: 0, failed: 1 });
		expect((await f.handle.db.select().from(triggerCursor))[0]?.lastSeq).toBe(
			0,
		);
		let [row] = await f.svc.deliveries("deploy-on-merge");
		expect(row?.state).toBe("failed");
		expect(row?.attempt).toBe(1);

		// Still cooling down: no new attempt this pass.
		expect(await f.svc.dispatch()).toMatchObject({ dispatched: 0, failed: 0 });
		expect(calls).toBe(1);

		// Past the attempt-1 backoff: attempt 2.
		clock += 6_000;
		expect(await f.svc.dispatch()).toMatchObject({ dispatched: 0, failed: 1 });
		[row] = await f.svc.deliveries("deploy-on-merge");
		expect(row?.state).toBe("failed");
		expect(row?.attempt).toBe(2);
		expect((await f.handle.db.select().from(triggerCursor))[0]?.lastSeq).toBe(
			0,
		);

		// Past the attempt-2 backoff: attempt 3 exhausts the budget, dead.
		clock += 20_000;
		expect(await f.svc.dispatch()).toMatchObject({ dispatched: 0, failed: 1 });
		[row] = await f.svc.deliveries("deploy-on-merge");
		expect(row?.state).toBe("dead");
		expect(row?.attempt).toBe(3);
		expect((await f.handle.db.select().from(triggerCursor))[0]?.lastSeq).toBe(
			ev.seq,
		);
		expect(calls).toBe(3);
		await f.cleanup();
	});

	test("retries: 0 (the default) is terminal on the first failure, 'failed', never 'dead'", async () => {
		const f = await fixture({ result: () => ({ ok: false, detail: "boom" }) });
		await f.def("deploy-on-merge.md", DEPLOY);
		await f.svc.arm("deploy-on-merge");
		await f.emit("merge.completed", merged("main", "a"), { runId: "r1" });
		expect(await f.svc.dispatch()).toMatchObject({ failed: 1 });
		const [row] = await f.svc.deliveries("deploy-on-merge");
		expect(row?.state).toBe("failed");
		expect((await f.handle.db.select().from(triggerCursor))[0]?.lastSeq).toBe(
			1,
		);
		await f.cleanup();
	});

	test("on_failure: ignore is fire-and-forget, no failing stamp, no notifier call", async () => {
		const f = await fixture({ result: () => ({ ok: false, detail: "boom" }) });
		await f.def(
			"deploy-on-merge.md",
			DEPLOY.replace("catchup: latest", "catchup: latest\non_failure: ignore"),
		);
		await f.svc.arm("deploy-on-merge");
		await f.emit("merge.completed", merged("main", "a"), { runId: "r1" });
		expect(await f.svc.dispatch()).toMatchObject({ failed: 1 });
		expect(await f.svc.failing()).toEqual([]);
		expect(f.notifications).toEqual([]);
		expect(f.holds).toEqual([]);
		await f.cleanup();
	});

	test("on_failure: inbox (the default) stamps `failing` and calls the notifier", async () => {
		const f = await fixture({ result: () => ({ ok: false, detail: "boom" }) });
		await f.def("deploy-on-merge.md", DEPLOY);
		await f.svc.arm("deploy-on-merge");
		await f.emit("merge.completed", merged("main", "a"), { runId: "r1" });
		expect(await f.svc.dispatch()).toMatchObject({ failed: 1 });

		const failing = await f.svc.failing();
		expect(failing).toHaveLength(1);
		expect(failing[0]).toMatchObject({
			defId: "deploy-on-merge",
			holdDispatch: false,
		});
		expect(failing[0]?.detail).toContain("boom");
		expect(f.notifications).toHaveLength(1);
		expect(f.notifications[0]?.kind).toBe("trigger_failed");
		expect(f.holds).toEqual([]);
		await f.cleanup();
	});

	test("on_failure: hold_dispatch also holds the scheduler, and it stays opt-in", async () => {
		const f = await fixture({ result: () => ({ ok: false, detail: "boom" }) });
		await f.def(
			"deploy-on-merge.md",
			DEPLOY.replace(
				"catchup: latest",
				"catchup: latest\non_failure: hold_dispatch",
			),
		);
		await f.svc.arm("deploy-on-merge");
		await f.emit("merge.completed", merged("main", "a"), { runId: "r1" });
		expect(await f.svc.dispatch()).toMatchObject({ failed: 1 });

		const failing = await f.svc.failing();
		expect(failing[0]?.holdDispatch).toBe(true);
		expect(f.holds).toHaveLength(1);
		expect(f.holds[0]?.reason).toContain("deploy-on-merge");
		await f.cleanup();
	});

	test("a subsequent success clears the failing stamp", async () => {
		let fail = true;
		const f = await fixture({
			result: () => (fail ? { ok: false, detail: "boom" } : { ok: true }),
		});
		await f.def("deploy-on-merge.md", DEPLOY);
		await f.svc.arm("deploy-on-merge");
		await f.emit("merge.completed", merged("main", "a"), { runId: "r1" });
		await f.svc.dispatch();
		expect(await f.svc.failing()).toHaveLength(1);

		fail = false;
		await f.emit("merge.completed", merged("main", "b"), { runId: "r2" });
		await f.svc.dispatch();
		expect(await f.svc.failing()).toEqual([]);
		await f.cleanup();
	});
});

describe("the inbox says a trigger's delivery died", () => {
	test("trigger_failed stays until the trigger next succeeds", async () => {
		const f = await fixture({ result: () => ({ ok: false, detail: "boom" }) });
		const tasks = await makeTasks(f.handle, f.bus, join(f.root, ".mfw"));
		const inbox = new InboxService({
			handle: f.handle,
			project: "demo",
			tasks,
			triggers: f.svc,
		});
		await f.def("deploy-on-merge.md", DEPLOY);
		await f.svc.arm("deploy-on-merge");
		await f.emit("merge.completed", merged("main", "a"), { runId: "r1" });
		await f.svc.dispatch();

		const item = (await inbox.list()).find((i) => i.kind === "trigger_failed");
		expect(item?.id).toBe("trigger_failed:deploy-on-merge");
		expect(item?.severity).toBe("attention");
		expect(item?.detail).toContain("boom");
		await f.cleanup();
	});
});

describe("the human surface: dry run", () => {
	test("reports what would have fired, without running anything or moving the cursor", async () => {
		const f = await fixture();
		await f.def("deploy-on-merge.md", DEPLOY);
		await f.svc.arm("deploy-on-merge");
		await f.emit("merge.completed", merged("staging", "x"), { runId: "r0" }); // does not match `where`
		const hit = await f.emit("merge.completed", merged("main", "a"), {
			runId: "r1",
		});

		const matches = await f.svc.dryRun("deploy-on-merge");
		expect(matches).toEqual([
			{
				seq: hit.seq,
				type: "merge.completed",
				ts: hit.ts,
				payload: hit.payload,
			},
		]);
		expect(f.ran).toEqual([]); // nothing actually dispatched
		expect((await f.handle.db.select().from(triggerCursor))[0]?.lastSeq).toBe(
			0,
		); // arm() parked it at head; dryRun never touches it
		await f.cleanup();
	});

	test("works on an unarmed definition: the whole point is checking `where` before arming", async () => {
		const f = await fixture();
		await f.def("deploy-on-merge.md", DEPLOY);
		const hit = await f.emit("merge.completed", merged("main", "a"), {
			runId: "r1",
		});
		const matches = await f.svc.dryRun("deploy-on-merge");
		expect(matches.map((m) => m.seq)).toEqual([hit.seq]);
		await f.cleanup();
	});

	test("an unknown trigger id is NotFoundError", async () => {
		const f = await fixture();
		await expect(f.svc.dryRun("no-such-trigger")).rejects.toThrow(
			NotFoundError,
		);
		await f.cleanup();
	});
});

describe("the human surface: retry", () => {
	test("redelivers by delivery_id, reusing the id, a redelivery button, not a new dispatch", async () => {
		let fail = true;
		const f = await fixture({
			result: () => (fail ? { ok: false, detail: "boom" } : { ok: true }),
		});
		await f.def("deploy-on-merge.md", DEPLOY);
		await f.svc.arm("deploy-on-merge");
		const ev = await f.emit("merge.completed", merged("main", "a"), {
			runId: "r1",
		});
		await f.svc.dispatch();
		let [row] = await f.svc.deliveries("deploy-on-merge");
		expect(row?.state).toBe("failed");
		expect(f.ran).toHaveLength(1);
		const deliveryId = deliveryIdFor("deploy-on-merge", ev.seq);
		expect(row?.id).toBe(deliveryId);

		fail = false;
		const view = await f.svc.retry(deliveryId);
		expect(view.id).toBe(deliveryId);
		expect(view.state).toBe("ok");
		expect(f.ran).toHaveLength(2); // the SAME delivery id, run a second time
		expect(f.ran[1]?.deliveryId).toBe(deliveryId);

		[row] = await f.svc.deliveries("deploy-on-merge");
		expect(row?.id).toBe(deliveryId); // no second row was created
		expect(row?.state).toBe("ok");
		await f.cleanup();
	});

	test("bypasses backoff: a human asking for a redelivery does not wait for cooldown", async () => {
		const f = await fixture({ result: () => ({ ok: false, detail: "boom" }) });
		await f.def(
			"deploy-on-merge.md",
			DEPLOY.replace("catchup: latest", "catchup: latest\nretries: 2"),
		);
		await f.svc.arm("deploy-on-merge");
		const ev = await f.emit("merge.completed", merged("main", "a"), {
			runId: "r1",
		});
		await f.svc.dispatch();
		expect(f.ran).toHaveLength(1);

		// No clock advance: an automatic pass would still be cooling down.
		expect(await f.svc.dispatch()).toMatchObject({ dispatched: 0, failed: 0 });
		expect(f.ran).toHaveLength(1);

		const deliveryId = deliveryIdFor("deploy-on-merge", ev.seq);
		await f.svc.retry(deliveryId);
		expect(f.ran).toHaveLength(2); // ran despite the cooldown
		await f.cleanup();
	});

	test("does not move the cursor: the cursor already advanced when the delivery was first attempted", async () => {
		const f = await fixture({ result: () => ({ ok: false, detail: "boom" }) });
		await f.def("deploy-on-merge.md", DEPLOY);
		await f.svc.arm("deploy-on-merge");
		const ev = await f.emit("merge.completed", merged("main", "a"), {
			runId: "r1",
		});
		await f.svc.dispatch();
		const cursorBefore = (await f.handle.db.select().from(triggerCursor))[0]
			?.lastSeq;
		expect(cursorBefore).toBe(ev.seq); // retries:0 default: terminal on attempt 1

		await f.svc.retry(deliveryIdFor("deploy-on-merge", ev.seq));
		expect((await f.handle.db.select().from(triggerCursor))[0]?.lastSeq).toBe(
			cursorBefore,
		);
		await f.cleanup();
	});

	test("an unknown delivery id is NotFoundError", async () => {
		const f = await fixture();
		await expect(f.svc.retry("does-not-exist")).rejects.toThrow(NotFoundError);
		await f.cleanup();
	});

	test("a delivery whose trigger definition is gone is NotFoundError, not a crash", async () => {
		const f = await fixture({ result: () => ({ ok: false, detail: "boom" }) });
		await f.def("deploy-on-merge.md", DEPLOY);
		await f.svc.arm("deploy-on-merge");
		const ev = await f.emit("merge.completed", merged("main", "a"), {
			runId: "r1",
		});
		await f.svc.dispatch();
		const deliveryId = deliveryIdFor("deploy-on-merge", ev.seq);

		await rm(join(f.root, ".mfw", "triggers", "deploy-on-merge.md"));
		await expect(f.svc.retry(deliveryId)).rejects.toThrow(NotFoundError);
		await f.cleanup();
	});
});
