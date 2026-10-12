import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectDb } from "@mfw/db/client";
import { EventBus } from "@mfw/db/eventlog";
import { claudeAdapter, codexAdapter } from "../src/agents/adapter.ts";
import { parseAgentEvents } from "../src/agents/events.ts";
import {
	nativeSessionUuid,
	sessionIdFromArgv,
} from "../src/agents/native-session.ts";
import type { StepRunner } from "../src/finalize/step-runner.ts";
import { silentLogger } from "../src/log.ts";
import { RunRegistry } from "../src/run-registry.ts";
import { Supervisor } from "../src/supervisor.ts";
import { makeTasks } from "./fixtures/board.ts";

const DRIVER = join(
	import.meta.dir,
	"../src/agents/drivers/app-server-driver.ts",
);
const CLAUDE_BRIDGE = join(
	import.meta.dir,
	"../src/agents/bridges/claude-app-server.ts",
);
const CODEX_BRIDGE = join(
	import.meta.dir,
	"../src/agents/bridges/codex-app-server-bridge.ts",
);
const FAKE_CLAUDE = join(import.meta.dir, "fixtures/fake-claude-app-server.ts");
const FAKE_CODEX = join(import.meta.dir, "fixtures/fake-codex-app-server.ts");

const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Run the shared driver over a bridge in `dir`, returning the transcript. */
async function drive(
	dir: string,
	bridge: string,
	providerArgv: string[],
): Promise<ReturnType<typeof parseAgentEvents>> {
	await writeFile(
		join(dir, "driver.json"),
		JSON.stringify({
			bridgeArgv: ["bun", "run", bridge],
			providerArgv,
			cwd: dir,
			env: {},
			initialMessage: "go",
			reasoningEffort: "high",
			steer: true,
			approvalMode: "autonomous",
		}),
	);
	await writeFile(join(dir, "events.jsonl"), "");
	await writeFile(join(dir, "control.jsonl"), "");
	const proc = Bun.spawn(["bun", "run", DRIVER, dir], {
		stdout: "ignore",
		stderr: "pipe",
	});
	const code = await proc.exited;
	const stderr = await new Response(proc.stderr).text();
	expect(code, stderr).toBe(0);
	return parseAgentEvents(await readFile(join(dir, "events.jsonl"), "utf8"));
}

class FakeHost {
	alive = new Set<string>();
	session(runId: string) {
		return `mfw_${runId}`;
	}
	async isAlive(runId: string) {
		return this.alive.has(runId);
	}
	async listSessions() {
		return [...this.alive].map((r) => this.session(r));
	}
	async kill() {}
	async readExit() {
		return { kind: "running" } as never;
	}
	async appendSteer() {}
}

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "mfw-native-session-"));
	const mfwDir = join(root, ".mfw");
	const handle = await openProjectDb(mfwDir);
	const bus = new EventBus();
	const registry = new RunRegistry({
		handle,
		bus,
		runsDir: join(mfwDir, "runs"),
	});
	const tasks = await makeTasks(handle, bus, mfwDir);
	const host = new FakeHost();
	const sup = new Supervisor({
		handle,
		registry,
		tasks,
		host: host as never,
		stepRunner: { finalize: async () => {} } as unknown as StepRunner,
		log: silentLogger(),
		projectRoot: root,
		bootId: "boot-1",
	});
	return {
		root,
		registry,
		host,
		sup,
		cleanup: async () => {
			await sup.stop();
			handle.close();
			await rm(root, { recursive: true, force: true });
		},
	};
}

describe("native session ids", () => {
	test("the id is a stable uuid per run id and differs between runs", () => {
		const a = nativeSessionUuid("01HZZZZZZZZZZZZZZZZZZZZZZA");
		expect(a).toMatch(UUID);
		expect(nativeSessionUuid("01HZZZZZZZZZZZZZZZZZZZZZZA")).toBe(a);
		expect(nativeSessionUuid("01HZZZZZZZZZZZZZZZZZZZZZZB")).not.toBe(a);
	});

	test("the Claude adapter passes --session-id derived from the run id; Codex has no such flag", () => {
		const claude = claudeAdapter.invocation(
			{ id: "claude-cli", type: "claude-cli" },
			"sonnet",
			"",
			{ steer: true, runId: "run-1" },
		);
		const i = claude.providerArgv.indexOf("--session-id");
		expect(i).toBeGreaterThan(0);
		expect(claude.providerArgv[i + 1]).toBe(nativeSessionUuid("run-1"));
		expect(sessionIdFromArgv(claude.providerArgv)).toBe(
			nativeSessionUuid("run-1"),
		);
		expect(claude.agentArgv).toEqual(claude.providerArgv);

		const noRun = claudeAdapter.invocation(
			{ id: "claude-cli", type: "claude-cli" },
			"sonnet",
			"",
			{ steer: true },
		);
		expect(noRun.providerArgv).not.toContain("--session-id");

		const codex = codexAdapter.invocation(
			{ id: "codex-cli", type: "codex-cli" },
			"gpt",
			"",
			{ steer: true, runId: "run-1" },
		);
		expect(codex.providerArgv).not.toContain("--session-id");
	});

	test("a Claude run's row carries the uuid passed via --session-id", async () => {
		const f = await fixture();
		try {
			const run = await f.registry.create({
				kind: "task",
				label: "t",
				model: "sonnet",
				cwd: f.root,
			});
			await f.registry.transition(run.id, "running");
			const inv = claudeAdapter.invocation(
				{ id: "claude-cli", type: "claude-cli" },
				"sonnet",
				"",
				{ steer: true, runId: run.id },
			);
			const passed = nativeSessionUuid(run.id);
			// The real adapter argv, with the CLI swapped for the fake provider.
			const events = await drive(f.registry.runDir(run.id), CLAUDE_BRIDGE, [
				"bun",
				"run",
				FAKE_CLAUDE,
				...inv.providerArgv.slice(1),
			]);
			const sessions = events.filter((e) => e.type === "session");
			expect(sessions.length).toBeGreaterThan(1);
			for (const s of sessions) expect(s.sessionId).toBe(passed);

			expect((await f.registry.get(run.id))?.nativeSessionId).toBeNull();
			f.host.alive.add(run.id);
			await f.sup.pass();
			expect((await f.registry.get(run.id))?.nativeSessionId).toBe(passed);
		} finally {
			await f.cleanup();
		}
	}, 30_000);

	test("a Codex run's row carries the thread id from thread/start", async () => {
		const f = await fixture();
		try {
			const run = await f.registry.create({
				kind: "task",
				label: "t",
				model: "gpt",
				cwd: f.root,
			});
			await f.registry.transition(run.id, "running");
			const events = await drive(f.registry.runDir(run.id), CODEX_BRIDGE, [
				"bun",
				"run",
				FAKE_CODEX,
			]);
			expect(events.find((e) => e.type === "session")).toMatchObject({
				sessionId: "thread-1",
			});

			f.host.alive.add(run.id);
			await f.sup.pass();
			expect((await f.registry.get(run.id))?.nativeSessionId).toBe("thread-1");
		} finally {
			await f.cleanup();
		}
	}, 30_000);

	test("recording is idempotent and a changed id replaces the old one", async () => {
		const f = await fixture();
		try {
			const run = await f.registry.create({
				kind: "task",
				label: "t",
				model: "m",
				cwd: f.root,
			});
			expect(await f.registry.recordNativeSession(run.id, "s-1")).toBe(true);
			expect(await f.registry.recordNativeSession(run.id, "s-1")).toBe(false);
			expect(await f.registry.recordNativeSession(run.id, "s-2")).toBe(true);
			expect((await f.registry.get(run.id))?.nativeSessionId).toBe("s-2");
		} finally {
			await f.cleanup();
		}
	});
});
