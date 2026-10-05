import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import { EventBus } from "@mfw/db/eventlog";
import { decisions, runs } from "@mfw/db/schema";
import { eq } from "drizzle-orm";
import {
	BrainService,
	buildDispatchPlanPrompt,
	ClaudeCliInference,
	CodexCliInference,
	type DecisionPoint,
	type DiffFacts,
	type DiffSource,
	type InferenceClient,
	type InferenceOpts,
	inferenceForProvider,
} from "../src/brain.ts";
import type { BrainCallCtx } from "../src/finalize/step-runner.ts";
import { silentLogger } from "../src/log.ts";
import type { DiagnoseCtx } from "../src/maintenance.ts";
import { RunRegistry } from "../src/run-registry.ts";
import type { DispatchPlanInput } from "../src/scheduler.ts";
import type { TaskService } from "../src/task-service.ts";

/**
 * Every test drives a fake InferenceClient (offline). The key assertions are
 * fail-closed: a broken brain never approves and never leaves a `running` decision.
 */

// --- Fakes ---

class FakeInference implements InferenceClient {
	readonly prompts: string[] = [];
	readonly opts: InferenceOpts[] = [];
	/** Consumed in order; an Error is thrown, a string is returned. */
	responses: (string | Error)[] = [];
	/** "hang" never resolves, only the service's abort race ends the call. */
	mode: "queue" | "hang" = "queue";
	onCall: (() => void) | null = null;

	constructor(...responses: (string | Error)[]) {
		this.responses = responses;
	}

	async complete(prompt: string, opts: InferenceOpts): Promise<string> {
		this.prompts.push(prompt);
		this.opts.push(opts);
		this.onCall?.();
		if (this.mode === "hang") return new Promise<string>(() => {});
		const next = this.responses.shift();
		if (next === undefined) throw new Error("fake: no response queued");
		if (next instanceof Error) throw next;
		return next;
	}

	get calls(): number {
		return this.prompts.length;
	}
}

class FakeDiffs implements DiffSource {
	constructor(private readonly facts: DiffFacts) {}
	async collect(_ctx: BrainCallCtx, _point: DecisionPoint): Promise<DiffFacts> {
		return this.facts;
	}
}

const emptyDiffs = new FakeDiffs({
	patch: "diff --git a/x b/x\n+hello\n",
	stat: " x | 1 +\n",
	commits: "abc1234 do the thing",
	files: ["x"],
});

// --- Fixture ---

interface Env {
	dir: string;
	handle: ProjectDbHandle;
	bus: EventBus;
	registry: RunRegistry;
	inference: FakeInference;
	brain: BrainService;
	ctx: BrainCallCtx;
	cleanup: () => Promise<void>;
}

async function makeEnv(
	over: {
		inference?: FakeInference;
		enabled?: boolean;
		timeoutMs?: number;
		diffs?: DiffSource;
		providerId?: string;
		reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh" | "max";
		reviewModel?: string;
		tasks?: TaskService;
	} = {},
): Promise<Env> {
	const dir = await mkdtemp(join(tmpdir(), "mfw-brain-"));
	const handle = await openProjectDb(dir);

	const bus = new EventBus();
	const registry = new RunRegistry({ handle, bus, runsDir: join(dir, "runs") });
	const subject = await registry.create({
		kind: "task",
		taskId: "MFW-1",
		label: "MFW-1 subject",
		model: "sonnet",
		providerId: over.providerId ?? "claude-cli",
		reasoningEffort: over.reasoningEffort ?? "medium",
		cwd: dir,
		branch: "mfw/task/MFW-1/x",
	});

	const inference = over.inference ?? new FakeInference();
	const brain = new BrainService({
		registry,
		handle,
		bus,
		inference,
		log: silentLogger(),
		model: "sonnet",
		providerId: over.providerId ?? "claude-cli",
		reasoningEffort: over.reasoningEffort ?? "medium",
		enabled: over.enabled ?? true,
		...(over.timeoutMs !== undefined ? { timeoutMs: over.timeoutMs } : {}),
		projectRoot: dir,
		diffs: over.diffs ?? emptyDiffs,
		...(over.reviewModel ? { reviewModel: over.reviewModel } : {}),
		...(over.tasks ? { tasks: over.tasks } : {}),
	});

	const ctx: BrainCallCtx = {
		runId: subject.id,
		taskId: "MFW-1",
		worktreePath: dir,
		branch: "mfw/task/MFW-1/x",
		baseSha: "deadbeef",
		verify: {
			passed: false,
			crashed: false,
			checks: [
				{
					check: "run: bun test",
					ok: false,
					classification: "failed",
					detail: "1 failing",
				},
				{ check: "files_exist: src/x.ts", ok: true },
			],
		},
		report: { escalation: null, summary: "tried the thing" },
	};

	return {
		dir,
		handle,
		bus,
		registry,
		inference,
		brain,
		ctx,
		cleanup: async () => {
			handle.close();
			await rm(dir, { recursive: true, force: true });
		},
	};
}

async function decisionRows(env: Env) {
	return env.handle.db.select().from(decisions);
}

async function brainRuns(env: Env) {
	return env.handle.db.select().from(runs).where(eq(runs.kind, "brain"));
}

const CRITIC_OK = JSON.stringify({
	accepted: true,
	criteria: [
		{
			criterion:
				"Deliver the task goal described above (legacy implicit criterion).",
			verdict: "met",
			evidenceClass: "source-confirmed",
			evidence: "The diff implements the requested change.",
		},
	],
	fakeDone: false,
	scopeCreep: false,
	concerns: [],
});
const CRITIC_FLAGGED =
	'```json\n{"accepted":false,"criteria":[{"criterion":"Deliver the task goal described above (legacy implicit criterion).","verdict":"unmet","evidenceClass":"source-confirmed","evidence":"Tests were removed instead of implementing the goal."}],"fakeDone":true,"scopeCreep":false,"concerns":["tests were gutted"]}\n```';
const REPLAN_OK = '{"action": "escalate", "reason": "needs a human"}';
const REVIEW_OK = '{"approved": true, "reason": "clean task edits"}';

function dispatchInput(): DispatchPlanInput {
	const summary = (id: string, title: string) => ({
		id,
		title,
		body: `${title} implementation details`,
		type: "implementation" as const,
		priority: "medium" as const,
		size: "m" as const,
		labels: [],
		dependsOn: [],
		requiresResources: [],
		executionTarget: "local",
		parentId: null,
		contentRev: 1,
		owns: [],
	});
	return {
		maxToStart: 3,
		candidates: [
			summary("MFW-1", "UI work"),
			summary("MFW-2", "Database work"),
			summary("MFW-3", "Related UI work"),
		],
		running: [],
	};
}

describe("brain CLI inference transports", () => {
	test("Codex uses ephemeral read-only exec with the selected model and effort", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mfw-codex-infer-"));
		const bin = join(dir, "fake-codex");
		await writeFile(
			bin,
			`#!/bin/sh
: > "$0.args"
for arg in "$@"; do printf '%s\\n' "$arg" >> "$0.args"; done
printf '{"approved":true,"reason":"safe"}'
`,
		);
		await chmod(bin, 0o755);
		const inference = new CodexCliInference({ cwd: dir, bin });
		const output = await inference.complete("return json", {
			model: "gpt-5.6-sol",
			reasoningEffort: "high",
			timeoutMs: 5_000,
		});
		expect(output).toBe('{"approved":true,"reason":"safe"}');
		expect((await readFile(`${bin}.args`, "utf8")).trim().split("\n")).toEqual([
			"exec",
			"--ephemeral",
			"--sandbox",
			"read-only",
			"--color",
			"never",
			"-m",
			"gpt-5.6-sol",
			"-c",
			'model_reasoning_effort="high"',
			"return json",
		]);
		await rm(dir, { recursive: true, force: true });
	});

	test("provider selection retains Claude, chooses Codex, and defers unsupported errors", async () => {
		expect(
			inferenceForProvider({ id: "claude-cli", type: "claude-cli" }),
		).toBeInstanceOf(ClaudeCliInference);
		expect(
			inferenceForProvider({ id: "codex-cli", type: "codex-cli" }),
		).toBeInstanceOf(CodexCliInference);
		const unsupported = inferenceForProvider({ id: "custom", type: "custom" });
		await expect(
			unsupported.complete("unused", {
				model: "custom-model",
				timeoutMs: 1_000,
			}),
		).rejects.toThrow(/no non-interactive brain transport/);
	});

	test("an unsupported transport is harmless while the brain is disabled", async () => {
		const env = await makeEnv({ enabled: false });
		const unsupported = inferenceForProvider({ id: "custom", type: "custom" });
		const brain = new BrainService({
			registry: env.registry,
			handle: env.handle,
			bus: env.bus,
			inference: unsupported,
			log: silentLogger(),
			model: "custom-model",
			providerId: "custom",
			reasoningEffort: "medium",
			enabled: false,
			projectRoot: env.dir,
		});
		expect(await brain.critic(env.ctx)).toMatchObject({ status: "failed" });
		expect(await brainRuns(env)).toEqual([]);
		await env.cleanup();
	});
});

// --- Happy paths ---

describe("BrainService: happy path per decision point", () => {
	test("critic: validated JSON becomes an ok decision with a full audit trail", async () => {
		const env = await makeEnv({
			inference: new FakeInference(CRITIC_FLAGGED),
			providerId: "codex-cli",
			reasoningEffort: "high",
		});
		const res = await env.brain.critic(env.ctx);
		expect(res.status).toBe("ok");
		expect(res.flagged).toBe(true);
		expect(res.reason).toContain("tests were gutted");

		const [d] = await decisionRows(env);
		expect(d?.role).toBe("critic");
		expect(d?.status).toBe("ok");
		expect(d?.action).toBe("flagged");
		expect(d?.reason).toContain("gutted");
		expect(d?.subjectRunId).toBe(env.ctx.runId);
		expect(d?.taskId).toBe("MFW-1");
		expect(d?.model).toBe("sonnet");
		expect(d?.output).toMatchObject({ fakeDone: true, flagged: true });
		expect((d?.input as { point?: string }).point).toBe("critic");
		expect(d?.durationMs).toBeGreaterThanOrEqual(0);
		expect(d?.finishedAt).not.toBeNull();

		// audit files live in the brain run's dir
		const runId = d?.brainRunId as string;
		const dir = env.registry.runDir(runId);
		const prompt = await readFile(join(dir, "prompt.md"), "utf8");
		expect(prompt).toContain("MFW-1");
		expect(prompt).toContain("DIFF:");
		const raw = await readFile(join(dir, "raw.log"), "utf8");
		expect(raw).toContain("fakeDone");

		const [run] = await brainRuns(env);
		expect(run?.id).toBe(runId);
		expect(run?.label).toBe(`critic:${env.ctx.runId}`);
		expect(run?.providerId).toBe("codex-cli");
		expect(run?.reasoningEffort).toBe("high");
		expect(run?.state).toBe("completed");
		expect(env.inference.opts[0]?.reasoningEffort).toBe("high");
		expect(run?.finishedAt).not.toBeNull();

		expect(env.brain.counters()).toMatchObject({
			calls: 1,
			failures: 0,
			timeouts: 0,
		});
		expect(env.brain.counters().p95Ms).toBeGreaterThanOrEqual(0);
		await env.cleanup();
	});

	test("replan: the action lands on the result and the decision row", async () => {
		const env = await makeEnv({ inference: new FakeInference(REPLAN_OK) });
		const res = await env.brain.replan(env.ctx);
		expect(res).toMatchObject({ status: "ok", action: "escalate" });

		const [d] = await decisionRows(env);
		expect(d?.role).toBe("replan");
		expect(d?.status).toBe("ok");
		expect(d?.action).toBe("escalate");
		expect(d?.output).toMatchObject({ action: "escalate" });

		const prompt = await readFile(
			join(env.registry.runDir(d?.brainRunId as string), "prompt.md"),
			"utf8",
		);
		expect(prompt).toContain("Failed checks:");
		expect(prompt).toContain("bun test");
		await env.cleanup();
	});

	test("import_review: an explicit approval is recorded as such", async () => {
		const env = await makeEnv({ inference: new FakeInference(REVIEW_OK) });
		const res = await env.brain.importReview(env.ctx);
		expect(res).toMatchObject({ status: "ok", approved: true });

		const [d] = await decisionRows(env);
		expect(d?.role).toBe("import_review");
		expect(d?.status).toBe("ok");
		expect(d?.action).toBe("approve");
		expect(d?.output).toMatchObject({ approved: true });
		await env.cleanup();
	});
});

describe("BrainService: dynamic dispatch planning", () => {
	test("records a bounded safe subset as a durable brain decision", async () => {
		const env = await makeEnv({
			inference: new FakeInference(
				JSON.stringify({
					selectedTaskIds: ["MFW-1", "MFW-2"],
					reason: "UI and database work are independent",
				}),
			),
		});
		const input = dispatchInput();
		const result = await env.brain.planDispatch(input);
		expect(result).toEqual({
			status: "ok",
			selectedTaskIds: ["MFW-1", "MFW-2"],
			reason: "UI and database work are independent",
		});
		const [decision] = await decisionRows(env);
		expect(decision).toMatchObject({
			role: "dispatch_plan",
			taskId: "MFW-1",
			status: "ok",
			action: "dispatch",
		});
		expect(decision?.output).toMatchObject({
			selectedTaskIds: ["MFW-1", "MFW-2"],
		});
		expect(buildDispatchPlanPrompt(input)).toContain(
			"hard ceiling, not a target",
		);
		await env.cleanup();
	});

	test("rejects an out-of-frontier answer and retries within the brain boundary", async () => {
		const inference = new FakeInference(
			JSON.stringify({
				selectedTaskIds: ["MFW-999"],
				reason: "invented task",
			}),
			JSON.stringify({
				selectedTaskIds: ["MFW-2"],
				reason: "corrected to a real candidate",
			}),
		);
		const env = await makeEnv({ inference });
		expect(await env.brain.planDispatch(dispatchInput())).toMatchObject({
			status: "ok",
			selectedTaskIds: ["MFW-2"],
		});
		expect(inference.calls).toBe(2);
		await env.cleanup();
	});
});

// --- Retry + failure classification ---

describe("BrainService: parsing, retry and failure", () => {
	test("malformed JSON retries exactly once, then fails", async () => {
		const inference = new FakeInference("not json at all", "{still: broken");
		const env = await makeEnv({ inference });
		const res = await env.brain.critic(env.ctx);
		expect(res.status).toBe("failed");
		expect(res.flagged).toBeUndefined();
		expect(inference.calls).toBe(2);
		expect(inference.prompts[1]).toContain(
			"Your previous response was invalid",
		);

		const [d] = await decisionRows(env);
		expect(d?.status).toBe("failed");
		expect(d?.action).toBeNull();
		expect(d?.reason).toContain("after 2 attempts");
		const [run] = await brainRuns(env);
		expect(run?.state).toBe("failed");
		expect(env.brain.counters()).toMatchObject({ calls: 1, failures: 1 });
		await env.cleanup();
	});

	test("a retry that parses yields ok (and both attempts are in raw.log)", async () => {
		const inference = new FakeInference("garbage", REPLAN_OK);
		const env = await makeEnv({ inference });
		const res = await env.brain.replan(env.ctx);
		expect(res).toMatchObject({ status: "ok", action: "escalate" });
		expect(inference.calls).toBe(2);

		const [d] = await decisionRows(env);
		expect(d?.status).toBe("ok");
		expect(d?.output).toMatchObject({ attempts: 2 });
		const dir = env.registry.runDir(d?.brainRunId as string);
		const raw = await readFile(join(dir, "raw.log"), "utf8");
		expect(raw).toContain("attempt 1");
		expect(raw).toContain("attempt 2");
		const prompt = await readFile(join(dir, "prompt.md"), "utf8");
		expect(prompt).toContain("attempt 2");
		await env.cleanup();
	});

	test("a throwing inference never escapes the port", async () => {
		const env = await makeEnv({
			inference: new FakeInference(new Error("claude CLI failed (1)")),
		});
		const res = await env.brain.critic(env.ctx);
		expect(res.status).toBe("failed");
		expect(res.reason).toContain("claude CLI failed");

		const [d] = await decisionRows(env);
		expect(d?.status).toBe("failed");
		expect(d?.finishedAt).not.toBeNull();
		const [run] = await brainRuns(env);
		expect(run?.state).toBe("failed");
		expect(env.brain.counters().failures).toBe(1);
		await env.cleanup();
	});

	test("a wedged call hits the hard timeout; decision and run both go terminal", async () => {
		const inference = new FakeInference();
		inference.mode = "hang";
		// The budget also covers persistence before the transport runs; leave room for SQLite on a loaded host.
		const timeoutMs = 1_000;
		const env = await makeEnv({ inference, timeoutMs });
		const started = Date.now();
		const res = await env.brain.replan(env.ctx);
		expect(Date.now() - started).toBeLessThan(5_000);
		expect(res.status).toBe("failed");
		expect(res.action).toBeUndefined();

		const [d] = await decisionRows(env);
		expect(d?.status).toBe("timeout");
		expect(d?.finishedAt).not.toBeNull();
		expect(d?.durationMs).toBeGreaterThanOrEqual(0);
		const [run] = await brainRuns(env);
		expect(run?.state).toBe("killed");
		expect(run?.killReason).toBe("watchdog-wall");
		expect(run?.finishedAt).not.toBeNull();
		expect(env.brain.counters()).toMatchObject({
			calls: 1,
			failures: 1,
			timeouts: 1,
		});
		// the transport was told the budget and handed a live signal
		expect(inference.opts[0]?.timeoutMs).toBeLessThanOrEqual(timeoutMs);
		expect(inference.opts[0]?.signal?.aborted).toBe(true);
		await env.cleanup();
	});

	test("stop() mid-flight aborts the decision", async () => {
		const inference = new FakeInference();
		inference.mode = "hang";
		const env = await makeEnv({ inference, timeoutMs: 30_000 });
		const inFlight = new Promise<void>((resolve) => {
			inference.onCall = () => resolve();
		});
		const call = env.brain.critic(env.ctx);
		await inFlight;
		const [pending] = await decisionRows(env);
		expect(pending?.status).toBe("running");
		expect(await env.brain.stop(pending?.brainRunId as string)).toBe(true);

		const res = await call;
		expect(res.status).toBe("failed");
		const [d] = await decisionRows(env);
		expect(d?.status).toBe("aborted");
		const [run] = await brainRuns(env);
		expect(run?.state).toBe("interrupted");
		expect(run?.killReason).toBe("manual");
		await env.cleanup();
	});
});

// --- A broken brain must never approve anything ---

describe("BrainService: fail-closed import review (defect D6)", () => {
	test("inference failure returns failed and NEVER approved:true", async () => {
		const env = await makeEnv({
			inference: new FakeInference(new Error("brain is on fire")),
		});
		const res = await env.brain.importReview(env.ctx);
		expect(res.status).toBe("failed");
		// Assert both the value and its absence.
		expect(res.approved).not.toBe(true);
		expect(res.approved).toBeUndefined();
		expect(Object.hasOwn(res, "approved")).toBe(false);

		const [d] = await decisionRows(env);
		expect(d?.status).toBe("failed");
		expect(d?.action).toBeNull();
		expect(d?.output).toEqual({});
		await env.cleanup();
	});

	test("every non-ok path (timeout, abort, bad JSON, disabled) withholds approval", async () => {
		// timeout
		const hang = new FakeInference();
		hang.mode = "hang";
		const timedOut = await makeEnv({ inference: hang, timeoutMs: 60 });
		const a = await timedOut.brain.importReview(timedOut.ctx);
		expect(a.status).toBe("failed");
		expect(a.approved).toBeUndefined();
		await timedOut.cleanup();

		// unparseable, twice
		const garbage = await makeEnv({
			inference: new FakeInference("yes, approved!", "definitely approve"),
		});
		const b = await garbage.brain.importReview(garbage.ctx);
		expect(b.status).toBe("failed");
		expect(b.approved).toBeUndefined();
		await garbage.cleanup();

		// valid JSON, but the model said no
		const rejected = await makeEnv({
			inference: new FakeInference(
				'{"approved": false, "reason": "deletes 40 tasks"}',
			),
		});
		const c = await rejected.brain.importReview(rejected.ctx);
		expect(c).toMatchObject({ status: "ok", approved: false });
		await rejected.cleanup();

		// disabled
		const off = await makeEnv({
			inference: new FakeInference(REVIEW_OK),
			enabled: false,
		});
		const d = await off.brain.importReview(off.ctx);
		expect(d.status).toBe("failed");
		expect(d.approved).toBeUndefined();
		await off.cleanup();
	});
});

// --- diagnose: no diff, no subject run, its own DiagnosePort ---

describe("BrainService: diagnose (MFW-58)", () => {
	const DIAG_CTX: DiagnoseCtx = {
		taskId: "MFW-1",
		check: "run: bun test",
		outputTail: "1 failing, timing assertion off by 4ms",
		exitCode: 1,
		environment: "regression sweep, ephemeral worktree off main",
		passesAtGreenSha: true,
	};

	test("happy path: a validated verdict becomes an ok decision, role 'diagnose'", async () => {
		const env = await makeEnv({
			inference: new FakeInference(
				'{"verdict": "flaky", "reason": "timing-dependent, not a real regression"}',
			),
		});
		const res = await env.brain.diagnose(DIAG_CTX);
		expect(res).toMatchObject({ status: "ok", verdict: "flaky" });
		expect(res.reason).toContain("timing-dependent");

		const [d] = await decisionRows(env);
		expect(d?.role).toBe("diagnose");
		expect(d?.status).toBe("ok");
		expect(d?.action).toBe("flaky");
		expect(d?.taskId).toBe("MFW-1");
		expect(d?.subjectRunId).toBeNull(); // a sweep has no subject run
		expect((d?.input as { point?: string }).point).toBe("diagnose");
		expect((d?.input as { check?: string }).check).toBe("run: bun test");
		expect(d?.output).toMatchObject({ verdict: "flaky" });

		const [run] = await brainRuns(env);
		expect(run?.label).toBe("diagnose:MFW-1");
		expect(run?.state).toBe("completed");

		const dir = env.registry.runDir(run?.id as string);
		const prompt = await readFile(join(dir, "prompt.md"), "utf8");
		expect(prompt).toContain("run: bun test");
		expect(prompt).toContain("passes"); // passesAtGreenSha: true
		expect(prompt).toContain("MFW-1");
		await env.cleanup();
	});

	test("no green baseline reads as unknown, not as a corroborated pass", async () => {
		const env = await makeEnv({
			inference: new FakeInference('{"verdict": "regression", "reason": ""}'),
		});
		await env.brain.diagnose({ ...DIAG_CTX, passesAtGreenSha: null });
		const [d] = await decisionRows(env);
		const prompt = await readFile(
			join(env.registry.runDir(d?.brainRunId as string), "prompt.md"),
			"utf8",
		);
		expect(prompt).toContain("no green baseline");
		await env.cleanup();
	});

	test("the diagnosis prompt keeps the output tail within a fixed budget", async () => {
		const inference = new FakeInference(
			'{"verdict": "regression", "reason": "tail identifies it"}',
		);
		const env = await makeEnv({ inference });
		await env.brain.diagnose({
			...DIAG_CTX,
			outputTail: `${"old-output\n".repeat(4_000)}FINAL-FAILURE`,
		});
		const prompt = inference.prompts[0] as string;
		expect(prompt).toContain("earlier output truncated");
		expect(prompt).toContain("FINAL-FAILURE");
		expect(prompt).not.toContain("old-output\n".repeat(2_000));
		await env.cleanup();
	});

	test("bad JSON twice fails closed: no verdict, same retry-then-fail shape as the others", async () => {
		const env = await makeEnv({
			inference: new FakeInference("not json", "still not json"),
		});
		const res = await env.brain.diagnose(DIAG_CTX);
		expect(res.status).toBe("failed");
		expect(res.verdict).toBeUndefined();
		const [d] = await decisionRows(env);
		expect(d?.status).toBe("failed");
		await env.cleanup();
	});

	test("enabled:false short-circuits: no run, no decision, no inference", async () => {
		const inference = new FakeInference(
			'{"verdict": "regression", "reason": ""}',
		);
		const env = await makeEnv({ inference, enabled: false });
		expect(await env.brain.diagnose(DIAG_CTX)).toMatchObject({
			status: "failed",
		});
		expect(inference.calls).toBe(0);
		expect(await decisionRows(env)).toHaveLength(0);
		expect(await brainRuns(env)).toHaveLength(0);
		await env.cleanup();
	});
});

// --- Lifecycle plumbing ---

describe("BrainService: orphans, supersede, caps, disabled", () => {
	test("reconcileOrphans parks decisions left running by a crashed daemon", async () => {
		const env = await makeEnv();
		await env.handle.db.insert(decisions).values({
			ts: new Date(),
			role: "critic",
			taskId: "MFW-1",
			subjectRunId: env.ctx.runId,
			brainRunId: "01ORPHAN",
			model: "sonnet",
			status: "running",
			input: {},
			output: {},
		});
		expect(await env.brain.reconcileOrphans()).toBe(1);
		const [d] = await decisionRows(env);
		expect(d?.status).toBe("aborted");
		expect(d?.finishedAt).not.toBeNull();
		// idempotent: a second boot finds nothing to park
		expect(await env.brain.reconcileOrphans()).toBe(0);
		await env.cleanup();
	});

	test("markSuperseded points a re-asked decision at its replacement", async () => {
		const env = await makeEnv({ inference: new FakeInference(REPLAN_OK) });
		await env.brain.replan(env.ctx);
		const [d] = await decisionRows(env);
		await env.brain.markSuperseded(d?.id as number, 4242);
		const [after] = await decisionRows(env);
		expect(after?.supersededBy).toBe(4242);
		await env.cleanup();
	});

	test("a 200 KB diff is capped before it ever reaches the model (§6.3)", async () => {
		const huge = "x".repeat(200 * 1024);
		const diffs = new FakeDiffs({
			patch: `diff --git a/big b/big\n+${huge}\n`,
			stat: " big | 1 +\n",
			commits: "abc1234 huge",
			files: ["big"],
		});

		const replanEnv = await makeEnv({
			inference: new FakeInference(REPLAN_OK),
			diffs,
		});
		await replanEnv.brain.replan(replanEnv.ctx);
		const replanPrompt = replanEnv.inference.prompts[0] as string;
		expect(replanPrompt.length).toBeLessThan(12_000); // 4 KB diff cap + framing
		expect(replanPrompt).toContain("truncated");
		expect(replanPrompt).toContain("big | 1 +");
		// the stored prompt.md matches what was actually sent
		const [rd] = await decisionRows(replanEnv);
		const stored = await readFile(
			join(replanEnv.registry.runDir(rd?.brainRunId as string), "prompt.md"),
			"utf8",
		);
		expect(stored).toContain(replanPrompt);
		expect((rd?.input as { diffChars?: number }).diffChars).toBeGreaterThan(
			200 * 1024,
		);
		await replanEnv.cleanup();

		const criticEnv = await makeEnv({
			inference: new FakeInference(CRITIC_OK),
			diffs,
		});
		await criticEnv.brain.critic(criticEnv.ctx);
		const criticPrompt = criticEnv.inference.prompts[0] as string;
		expect(criticPrompt.length).toBeLessThan(45_000); // 32 KB diff cap + framing
		expect(criticPrompt.length).toBeGreaterThan(30_000);
		await criticEnv.cleanup();

		const importEnv = await makeEnv({
			inference: new FakeInference(REVIEW_OK),
			diffs,
		});
		await importEnv.brain.importReview(importEnv.ctx);
		const importPrompt = importEnv.inference.prompts[0] as string;
		expect(importPrompt.length).toBeLessThan(25_000); // 16 KB diff cap + framing
		await importEnv.cleanup();
	});

	test("enabled:false short-circuits: no run, no decision, no inference", async () => {
		const inference = new FakeInference(CRITIC_OK, REPLAN_OK, REVIEW_OK);
		const env = await makeEnv({ inference, enabled: false });
		expect(env.brain.enabled).toBe(false);

		expect(await env.brain.critic(env.ctx)).toMatchObject({ status: "failed" });
		expect(await env.brain.replan(env.ctx)).toMatchObject({ status: "failed" });
		expect(await env.brain.importReview(env.ctx)).toMatchObject({
			status: "failed",
		});

		expect(inference.calls).toBe(0);
		expect(await decisionRows(env)).toHaveLength(0);
		expect(await brainRuns(env)).toHaveLength(0);
		// a configuration opt-out is not a health failure
		expect(env.brain.counters()).toMatchObject({ calls: 0, failures: 0 });
		await env.cleanup();
	});
});

const LEGACY =
	"Deliver the task goal described above (legacy implicit criterion).";

function criticAnswer(
	verdict: string,
	evidenceClass: string | undefined,
): string {
	return JSON.stringify({
		accepted: true,
		criteria: [
			{
				criterion: LEGACY,
				verdict,
				...(evidenceClass ? { evidenceClass } : {}),
				evidence: "see the diff",
			},
		],
		fakeDone: false,
		scopeCreep: false,
		concerns: [],
	});
}

/** Only `get` is read by the brain, and only for prompt context. */
function fakeTasks(task: Record<string, unknown>): TaskService {
	return {
		get: async () => ({
			title: "Scoped work",
			body: "Change the API only.",
			criteria: [],
			stallCount: 0,
			owns: [],
			...task,
		}),
	} as unknown as TaskService;
}

describe("BrainService: critic evidence classes", () => {
	test("met on claimed evidence alone is flagged with a concern", async () => {
		const env = await makeEnv({
			inference: new FakeInference(criticAnswer("met", "claimed")),
		});
		const res = await env.brain.critic(env.ctx);
		expect(res).toMatchObject({ status: "ok", accepted: false, flagged: true });
		expect(res.reason).toContain("criterion 1 is met only on the agent's word");
		const [d] = await decisionRows(env);
		expect(d?.action).toBe("flagged");
		const output = d?.output as { criteria: { evidenceClass: string }[] };
		expect(output.criteria[0]?.evidenceClass).toBe("claimed");
		await env.cleanup();
	});

	test("met on reproduced evidence is accepted", async () => {
		const env = await makeEnv({
			inference: new FakeInference(criticAnswer("met", "reproduced")),
		});
		const res = await env.brain.critic(env.ctx);
		expect(res).toMatchObject({ status: "ok", accepted: true, flagged: false });
		const [d] = await decisionRows(env);
		expect(d?.action).toBe("accepted");
		await env.cleanup();
	});

	test("an answer without evidenceClass takes the one feedback retry", async () => {
		const inference = new FakeInference(
			criticAnswer("met", undefined),
			criticAnswer("met", "source-confirmed"),
		);
		const env = await makeEnv({ inference });
		const res = await env.brain.critic(env.ctx);
		expect(res).toMatchObject({ status: "ok", accepted: true });
		expect(inference.calls).toBe(2);
		expect(inference.prompts[1]).toContain(
			"Your previous response was invalid: criteria.0.evidenceClass",
		);
		await env.cleanup();
	});
});

describe("BrainService: review model", () => {
	test("the critic uses reviewModel and records both models; replan keeps model", async () => {
		const inference = new FakeInference(
			criticAnswer("met", "reproduced"),
			REPLAN_OK,
		);
		const env = await makeEnv({ inference, reviewModel: "opus" });
		await env.brain.critic(env.ctx);
		await env.brain.replan(env.ctx);

		expect(inference.opts.map((o) => o.model)).toEqual(["opus", "sonnet"]);
		const rows = await decisionRows(env);
		const critic = rows.find((d) => d.role === "critic");
		const replan = rows.find((d) => d.role === "replan");
		expect(critic?.model).toBe("opus");
		expect(replan?.model).toBe("sonnet");
		expect(critic?.output).toMatchObject({
			implementerModel: "sonnet",
			reviewerModel: "opus",
			sameModel: false,
		});
		const brainRunRows = await brainRuns(env);
		const criticRun = brainRunRows.find((r) => r.id === critic?.brainRunId);
		const replanRun = brainRunRows.find((r) => r.id === replan?.brainRunId);
		expect(criticRun?.model).toBe("opus");
		expect(replanRun?.model).toBe("sonnet");
		const prompt = await readFile(
			join(env.registry.runDir(critic?.brainRunId as string), "prompt.md"),
			"utf8",
		);
		expect(prompt).toContain("- model: opus");
		await env.cleanup();
	});

	test("without reviewModel the critic falls back to model and says so", async () => {
		const env = await makeEnv({
			inference: new FakeInference(criticAnswer("met", "reproduced")),
		});
		await env.brain.critic(env.ctx);
		expect(env.inference.opts[0]?.model).toBe("sonnet");
		const [d] = await decisionRows(env);
		expect(d?.output).toMatchObject({
			reviewerModel: "sonnet",
			sameModel: true,
		});
		await env.cleanup();
	});
});

describe("BrainService: scope in review", () => {
	test("files changed outside owns are listed in the critic prompt", async () => {
		const env = await makeEnv({
			inference: new FakeInference(criticAnswer("met", "reproduced")),
			tasks: fakeTasks({ owns: ["src/api/**"] }),
			diffs: new FakeDiffs({
				patch: "diff --git a/src/api/x.ts b/src/api/x.ts\n+1\n",
				stat: "",
				commits: "",
				files: ["src/api/x.ts", "src/ui/y.tsx", "README.md"],
			}),
		});
		await env.brain.critic(env.ctx);
		const prompt = env.inference.prompts[0] as string;
		expect(prompt).toContain("DECLARED SCOPE (owns):\n- src/api/**");
		expect(prompt).toContain(
			"CHANGED OUTSIDE THE DECLARED SCOPE:\n- src/ui/y.tsx\n- README.md\n",
		);
		expect(prompt).not.toContain("- src/api/x.ts");
		expect(prompt).toContain("scopeCreep");
		await env.cleanup();
	});

	test("a task without owns gets no scope section", async () => {
		const env = await makeEnv({
			inference: new FakeInference(criticAnswer("met", "reproduced")),
			tasks: fakeTasks({}),
		});
		await env.brain.critic(env.ctx);
		expect(env.inference.prompts[0]).not.toContain("DECLARED SCOPE");
		await env.cleanup();
	});

	test("the dispatch plan prompt shows each candidate's owns", () => {
		const input = dispatchInput();
		const first = input.candidates[0];
		if (first) first.owns = ["packages/ui/**"];
		const prompt = buildDispatchPlanPrompt(input);
		expect(prompt).toContain('"owns": [\n      "packages/ui/**"\n    ]');
	});
});
