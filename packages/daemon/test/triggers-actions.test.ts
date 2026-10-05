import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StoredEvent } from "@mfw/db/eventlog";
import { git } from "../src/git.ts";
import { silentLogger } from "../src/log.ts";
import type { Notifier } from "../src/notify.ts";
import type { TriggerDispatch } from "../src/triggers/actions.ts";
import { createAgentAction } from "../src/triggers/agent-action.ts";
import type { TriggerAction, TriggerDef } from "../src/triggers/def.ts";
import { createNotifyAction } from "../src/triggers/notify-action.ts";
import {
	eventRefs,
	placeholderValues,
	renderPlaceholders,
} from "../src/triggers/placeholders.ts";
import {
	createScriptAction,
	Semaphore,
} from "../src/triggers/script-action.ts";

/** The real action handlers, exercised in isolation without a `TriggerService` (spine: `triggers.test.ts`). */

function mkDef(action: TriggerAction, secrets: string[] = []): TriggerDef {
	return {
		id: "t",
		title: "t",
		enabled: true,
		source: {
			kind: "event",
			match: { kind: "exact", type: "merge.completed" },
		},
		action,
		catchup: "latest",
		concurrency: "serial",
		onFailure: "inbox",
		retries: 0,
		secrets,
		body: "",
		file: "t.md",
		definition: "---\nid: t\n---\n",
		hash: "sha256:x",
	};
}

function mkDispatch(opts: {
	def: TriggerDef;
	projectRoot?: string;
	grantedSecrets?: string[];
	payload?: Record<string, unknown>;
	taskId?: string;
	runId?: string;
}): TriggerDispatch {
	const event = {
		type: "merge.completed",
		seq: 1,
		ts: 1_700_000_000_000,
		payload: opts.payload ?? { sha: "abc123", target: "main" },
		taskId: opts.taskId,
		runId: opts.runId,
	} as unknown as StoredEvent;
	return {
		def: opts.def,
		deliveryId: "deadbeefdeadbeef",
		event,
		projectRoot: opts.projectRoot ?? "/nonexistent",
		projectName: "demo",
		grantedSecrets: opts.grantedSecrets ?? [],
		skippedSeqs: [],
	};
}

describe("placeholders", () => {
	test("renders the known set and blanks an absent field rather than throwing", async () => {
		const values = await placeholderValues(
			{
				type: "merge.completed",
				seq: 5,
				payload: { sha: "abc", target: "main" },
			},
			"deadbeef",
			undefined,
		);
		expect(
			renderPlaceholders(
				"{{event.type}}#{{event.seq}} {{delivery.id}} {{merge.sha}}->{{merge.target}} task={{task.id}}",
				values,
			),
		).toBe("merge.completed#5 deadbeef abc->main task=");
	});

	test("eventRefs reaches taskId/runId past the discriminated union", () => {
		const event = {
			type: "task.created",
			taskId: "MFW-1",
			payload: {},
		} as unknown as StoredEvent;
		expect(eventRefs(event)).toEqual({ taskId: "MFW-1", runId: undefined });
	});

	test("looks up task.title through the injected tasks reader", async () => {
		const values = await placeholderValues(
			{ type: "task.status_changed", seq: 1, payload: {} },
			"d1",
			"MFW-1",
			{
				get: async (id) => (id === "MFW-1" ? { title: "fix the thing" } : null),
			},
		);
		expect(renderPlaceholders("{{task.id}}: {{task.title}}", values)).toBe(
			"MFW-1: fix the thing",
		);
	});
});

describe("action: notify", () => {
	function fakeNotifier(opts: {
		configured: boolean;
		results?: { sink: "webhook" | "command"; ok: boolean; detail?: string }[];
	}): { notifier: Notifier; calls: unknown[] } {
		const calls: unknown[] = [];
		const notifier: Notifier = {
			async notify(kind, detail) {
				calls.push({ kind, detail });
				return (opts.results ?? []).map((r) => ({ ...r, durationMs: 0 }));
			},
			async send() {
				return [];
			},
			stats() {
				return {
					sent: 0,
					delivered: 0,
					failed: 0,
					lastFailure: null,
					configured: opts.configured,
				};
			},
		};
		return { notifier, calls };
	}

	test("renders the message and delivers through the notifier", async () => {
		const { notifier, calls } = fakeNotifier({
			configured: true,
			results: [{ sink: "webhook", ok: true }],
		});
		const def = mkDef({
			kind: "notify",
			message: "{{merge.sha}} landed on {{merge.target}}",
		});
		const handler = createNotifyAction({ notifier });
		const result = await handler(
			mkDispatch({ def, taskId: "MFW-1", runId: "r1" }),
		);
		expect(result.ok).toBe(true);
		expect(result.detail).toBe("abc123 landed on main");
		expect(calls).toEqual([
			{
				kind: "trigger",
				detail: {
					project: "demo",
					taskId: "MFW-1",
					runId: "r1",
					message: "abc123 landed on main",
				},
			},
		]);
	});

	test("refuses loudly rather than silently no-op when no sink is configured", async () => {
		const { notifier } = fakeNotifier({ configured: false });
		const def = mkDef({ kind: "notify", message: "hi" });
		const handler = createNotifyAction({ notifier });
		const result = await handler(mkDispatch({ def }));
		expect(result.ok).toBe(false);
		expect(result.detail).toContain("no sink configured");
	});

	test("a failing sink is a failing delivery", async () => {
		const { notifier } = fakeNotifier({
			configured: true,
			results: [{ sink: "webhook", ok: false, detail: "HTTP 500" }],
		});
		const def = mkDef({ kind: "notify", message: "hi" });
		const handler = createNotifyAction({ notifier });
		const result = await handler(mkDispatch({ def }));
		expect(result.ok).toBe(false);
		expect(result.detail).toContain("HTTP 500");
	});
});

describe("action: script", () => {
	const roots: string[] = [];
	async function repo(): Promise<string> {
		const root = await mkdtemp(join(tmpdir(), "mfw-trig-script-"));
		roots.push(root);
		await git(["init", "-q", "-b", "main", "."], root);
		await git(["config", "user.email", "t@t"], root);
		await git(["config", "user.name", "t"], root);
		await writeFile(join(root, "a.txt"), "1\n");
		await git(["add", "-A"], root);
		await git(["commit", "-q", "-m", "init"], root);
		return root;
	}
	async function cleanup(): Promise<void> {
		for (const r of roots.splice(0))
			await rm(r, { recursive: true, force: true });
	}

	test("runs the script with the fixed env allowlist and MFW_EVENT_JSON", async () => {
		const root = await repo();
		const outFile = join(root, "out.json");
		const def = mkDef({
			kind: "script",
			run: `env | grep -E '^(MFW_|DBUS_SESSION_BUS_ADDRESS=|XDG_RUNTIME_DIR=)' | sort > "${outFile}"; cat "$MFW_EVENT_JSON" >/dev/null 2>&1 || true`,
			cwd: "repo",
			timeoutMs: 10_000,
		});
		const handler = createScriptAction({
			log: silentLogger(),
			secrets: { getSecret: async () => undefined },
			semaphore: new Semaphore(2),
			environment: {
				...process.env,
				DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
				XDG_RUNTIME_DIR: "/run/user/1000",
			},
		});
		const result = await handler(
			mkDispatch({ def, projectRoot: root, taskId: "MFW-1", runId: "r1" }),
		);
		expect(result.ok).toBe(true);
		const dumped = await Bun.file(outFile).text();
		expect(dumped).toContain("MFW_DELIVERY_ID=deadbeefdeadbeef");
		expect(dumped).toContain("MFW_PROJECT=demo");
		expect(dumped).toContain("MFW_TRIGGER_ID=t");
		expect(dumped).toContain("MFW_EVENT_TYPE=merge.completed");
		expect(dumped).toContain("MFW_TASK_ID=MFW-1");
		expect(dumped).toContain("MFW_RUN_ID=r1");
		expect(dumped).toContain('MFW_EVENT_JSON={"sha":"abc123","target":"main"}');
		expect(dumped).toContain(
			"DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus",
		);
		expect(dumped).toContain("XDG_RUNTIME_DIR=/run/user/1000");
		await cleanup();
	});

	test("a non-zero exit is a failed delivery with the stderr tail", async () => {
		const root = await repo();
		const def = mkDef({
			kind: "script",
			run: "echo boom 1>&2; exit 3",
			cwd: "repo",
			timeoutMs: 10_000,
		});
		const handler = createScriptAction({
			log: silentLogger(),
			secrets: { getSecret: async () => undefined },
			semaphore: new Semaphore(2),
		});
		const result = await handler(mkDispatch({ def, projectRoot: root }));
		expect(result.ok).toBe(false);
		expect(result.exitCode).toBe(3);
		expect(result.detail).toContain("boom");
		await cleanup();
	});

	// No direnv/sandbox wrapper here, so a simple command execs straight into
	// `sh -c` and `exitCode` is null on a signal; the detail must name the signal.
	test("a signal death is reported by name, not as a bare null exit", async () => {
		const root = await repo();
		const def = mkDef({
			kind: "script",
			run: "kill -11 $$",
			cwd: "repo",
			timeoutMs: 10_000,
		});
		const handler = createScriptAction({
			log: silentLogger(),
			secrets: { getSecret: async () => undefined },
			semaphore: new Semaphore(2),
		});
		const result = await handler(mkDispatch({ def, projectRoot: root }));
		expect(result.ok).toBe(false);
		expect(result.detail).toContain("SIGSEGV");
		expect(result.detail).not.toContain("exit null");
		await cleanup();
	});

	test("a requested-but-not-granted secret refuses to dispatch, never a blank env var", async () => {
		const root = await repo();
		const def = mkDef(
			{ kind: "script", run: "true", cwd: "repo", timeoutMs: 10_000 },
			["deploy_token"],
		);
		const handler = createScriptAction({
			log: silentLogger(),
			secrets: { getSecret: async () => "should-not-be-reached" },
			semaphore: new Semaphore(2),
		});
		const result = await handler(
			mkDispatch({ def, projectRoot: root, grantedSecrets: [] }),
		);
		expect(result.ok).toBe(false);
		expect(result.detail).toContain("not granted");
		await cleanup();
	});

	test("a granted secret is injected as its UPPERCASE name", async () => {
		const root = await repo();
		const outFile = join(root, "secret.txt");
		const def = mkDef(
			{
				kind: "script",
				run: `echo "$DEPLOY_TOKEN" > "${outFile}"`,
				cwd: "repo",
				timeoutMs: 10_000,
			},
			["deploy_token"],
		);
		const handler = createScriptAction({
			log: silentLogger(),
			secrets: {
				getSecret: async (name) =>
					name === "deploy_token" ? "s3cr3t" : undefined,
			},
			semaphore: new Semaphore(2),
		});
		const result = await handler(
			mkDispatch({ def, projectRoot: root, grantedSecrets: ["deploy_token"] }),
		);
		expect(result.ok).toBe(true);
		expect((await Bun.file(outFile).text()).trim()).toBe("s3cr3t");
		await cleanup();
	});

	test("a granted secret missing from credentials.json fails loudly", async () => {
		const root = await repo();
		const def = mkDef(
			{ kind: "script", run: "true", cwd: "repo", timeoutMs: 10_000 },
			["deploy_token"],
		);
		const handler = createScriptAction({
			log: silentLogger(),
			secrets: { getSecret: async () => undefined },
			semaphore: new Semaphore(2),
		});
		const result = await handler(
			mkDispatch({ def, projectRoot: root, grantedSecrets: ["deploy_token"] }),
		);
		expect(result.ok).toBe(false);
		expect(result.detail).toContain("not set in credentials.json");
		await cleanup();
	});

	test("cwd: worktree runs hermetically at MFW_SHA and removes the worktree after", async () => {
		const root = await repo();
		const sha = (await git(["rev-parse", "HEAD"], root)).stdout;
		const outFile = join(root, "wt.txt");
		const def = mkDef({
			kind: "script",
			run: `pwd > "${outFile}"; echo "$MFW_SHA" >> "${outFile}"`,
			cwd: "worktree",
			timeoutMs: 10_000,
		});
		const handler = createScriptAction({
			log: silentLogger(),
			secrets: { getSecret: async () => undefined },
			semaphore: new Semaphore(2),
		});
		const result = await handler(
			mkDispatch({ def, projectRoot: root, payload: { sha, target: "main" } }),
		);
		expect(result.ok).toBe(true);
		const lines = (await Bun.file(outFile).text()).trim().split("\n");
		expect(lines[0]).not.toBe(root); // ran somewhere else, not the primary checkout
		expect(lines[1]).toBe(sha);
		expect(
			existsSync(join(root, "worktrees", "trigger-deadbeefdeadbeef")),
		).toBe(false);
		await cleanup();
	});

	test("Semaphore caps concurrency at the configured max", async () => {
		const sem = new Semaphore(2);
		let active = 0;
		let peak = 0;
		const task = () =>
			sem.run(async () => {
				active++;
				peak = Math.max(peak, active);
				await new Promise((r) => setTimeout(r, 20));
				active--;
			});
		await Promise.all([task(), task(), task(), task(), task()]);
		expect(peak).toBeLessThanOrEqual(2);
	});
});

describe("action: agent", () => {
	test("starts the run with an interpolated prompt and returns immediately", async () => {
		const started: { prompt: string; model?: string }[] = [];
		let resolveRun: (v: { runId: string }) => void = () => {};
		const engine = {
			startAction: async (prompt: string, opts?: { model?: string }) => {
				started.push({ prompt, model: opts?.model });
				// Never resolves on its own: the handler must not wait on it.
				return new Promise<{ runId: string }>((resolve) => {
					resolveRun = resolve;
				});
			},
		};
		const def = mkDef({
			kind: "agent",
			prompt: "{{merge.sha}} landed on {{merge.target}} ({{delivery.id}})",
			model: "sonnet",
		});
		const handler = createAgentAction({ engine });
		const pending = handler(mkDispatch({ def }));
		// Let the handler reach `startAction`, or `resolveRun` is still the no-op default.
		await new Promise((r) => setTimeout(r, 0));
		resolveRun({ runId: "run-1" });
		const result = await pending;
		expect(result).toEqual({ ok: true, runId: "run-1" });
		expect(started).toEqual([
			{ prompt: "abc123 landed on main (deadbeefdeadbeef)", model: "sonnet" },
		]);
	});
});
