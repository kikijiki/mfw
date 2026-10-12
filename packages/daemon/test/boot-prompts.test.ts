import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import { EventBus } from "@mfw/db/eventlog";
import { buildPrompts } from "../src/boot.ts";
import { ClarifyService } from "../src/clarify.ts";
import { silentLogger } from "../src/log.ts";
import { ReviewService } from "../src/review.ts";
import { RunRegistry } from "../src/run-registry.ts";
import type { TaskService } from "../src/task-service.ts";
import { makeTasks } from "./fixtures/board.ts";

/**
 * `buildPrompts` is what `describeTask` runs through for `.task` and
 * `.continuation` alike. A task's `spec.md` lives in the board, which agent
 * worktrees do not check out, so the prompt is the ONLY way an agent sees the
 * spec it is meant to be implementing against. Drives `buildPrompts` directly
 * against fixture services rather than booting a whole project.
 */

interface Env {
	dir: string;
	handle: ProjectDbHandle;
	tasks: TaskService;
	registry: RunRegistry;
	prompts: ReturnType<typeof buildPrompts>;
}

const envs: Env[] = [];

async function freshEnv(): Promise<Env> {
	const dir = await mkdtemp(join(tmpdir(), "mfw-boot-prompts-"));
	const handle = await openProjectDb(dir);
	const bus = new EventBus();
	const tasks = await makeTasks(handle, bus, dir);
	const registry = new RunRegistry({
		handle,
		bus,
		runsDir: join(dir, "runs"),
	});
	const env: Env = {
		dir,
		handle,
		tasks,
		registry,
		prompts: buildPrompts(tasks, registry),
	};
	envs.push(env);
	return env;
}

afterEach(async () => {
	for (const env of envs.splice(0)) {
		env.handle.close();
		await rm(env.dir, { recursive: true, force: true });
	}
});

describe("buildPrompts: the task's spec", () => {
	test("a task's spec.md reaches the prompt as its own section", async () => {
		const env = await freshEnv();
		const task = await env.tasks.create({ title: "wire the widget" });
		await env.tasks.setSpec(
			task.id,
			"The widget speaks over a length-prefixed frame.",
		);

		const prompt = await env.prompts.task(task.id);

		expect(prompt).toContain("## Spec");
		expect(prompt).toContain("The widget speaks over a length-prefixed frame.");
	});

	test("a task with no spec gets no spec section", async () => {
		const env = await freshEnv();
		const task = await env.tasks.create({ title: "wire the widget" });

		expect(await env.prompts.task(task.id)).not.toContain("## Spec");
	});

	test("another task's spec never appears", async () => {
		const env = await freshEnv();
		const task = await env.tasks.create({ title: "wire the widget" });
		const other = await env.tasks.create({ title: "unrelated" });
		await env.tasks.setSpec(other.id, "nothing to do with the widget");

		const prompt = await env.prompts.task(task.id);

		expect(prompt).not.toContain("## Spec");
		expect(prompt).not.toContain("nothing to do with the widget");
	});

	test("a continuation prompt carries the spec too", async () => {
		const env = await freshEnv();
		const task = await env.tasks.create({ title: "wire the widget" });
		await env.tasks.setSpec(task.id, "Frame format details.");

		const prompt = await env.prompts.continuation(
			task.id,
			"run-does-not-exist",
		);

		expect(prompt).toContain("Frame format details.");
	});

	test("an oversized spec is truncated with a visible marker", async () => {
		const env = await freshEnv();
		const task = await env.tasks.create({ title: "wire the widget" });
		const big = "x".repeat(30 * 1024); // over the 24 KiB prompt cap
		await env.tasks.setSpec(task.id, big);

		const prompt = await env.prompts.task(task.id);

		expect(prompt).toContain("spec truncated, over the 24576-byte cap");
		expect(prompt).not.toContain(big);
	});
});

describe("buildPrompts: human rejection feedback", () => {
	test("a rejection's reason and unresolved comments reach the next run, until done", async () => {
		const env = await freshEnv();
		const review = new ReviewService({
			handle: env.handle,
			registry: env.registry,
			tasks: env.tasks,
			projectRoot: env.dir,
		});
		const task = await env.tasks.create({ title: "wire the widget" });
		await env.tasks.move(task.id, "review", "scheduler");
		await review.addComment({
			taskId: task.id,
			file: "src/widget.ts",
			line: 12,
			side: "new",
			body: "this drops the length prefix",
		});
		const settled = await review.addComment({
			taskId: task.id,
			file: "src/widget.ts",
			line: 40,
			side: "new",
			body: "already fixed, ignore",
		});
		if (!settled) throw new Error("comment not stored");
		await review.resolveComment(settled.id, true);

		const moved = await review.reject(task.id, "frames are not delimited");
		expect(moved.status).toBe("ready");

		// A restarted daemon re-reads the sidecar from disk.
		const reloaded = await makeTasks(env.handle, new EventBus(), env.dir);
		for (const tasks of [env.tasks, reloaded]) {
			const prompts = buildPrompts(tasks, env.registry);
			for (const prompt of [
				await prompts.task(task.id),
				await prompts.continuation(task.id, "run-does-not-exist"),
			]) {
				expect(prompt).toContain("## A human rejected the previous attempt");
				expect(prompt).toContain("frames are not delimited");
				expect(prompt).toContain(
					"`src/widget.ts:12`: this drops the length prefix",
				);
				expect(prompt).not.toContain("already fixed, ignore");
			}
		}

		await env.tasks.move(task.id, "done", "scheduler");
		expect(await env.prompts.task(task.id)).not.toContain(
			"frames are not delimited",
		);
	});

	test("reject refuses a task that is not awaiting review", async () => {
		const env = await freshEnv();
		const review = new ReviewService({
			handle: env.handle,
			registry: env.registry,
			tasks: env.tasks,
			projectRoot: env.dir,
		});
		const task = await env.tasks.create({ title: "wire the widget" });
		await expect(review.reject(task.id, "nope")).rejects.toThrow(
			/not awaiting review/,
		);
		expect(env.tasks.pendingFeedback(task.id)).toBeNull();
	});
});

describe("buildPrompts: import", () => {
	test("tells the importer a spec becomes a container task's spec.md", async () => {
		const env = await freshEnv();

		const prompt = await env.prompts.import();

		expect(prompt).toContain("`spec.md` of a\ncontainer task");
		expect(prompt).not.toContain("Existing MFW Specs");
	});

	test("names where the repository keeps its documentation, when it is known", async () => {
		const env = await freshEnv();
		const withDocs = buildPrompts(env.tasks, env.registry, undefined, {
			hint: async () =>
				"The repository keeps documentation in: docs/ (Docs).\nRead it.",
		});
		expect(await withDocs.import()).toContain(
			"The repository keeps documentation in: docs/ (Docs).",
		);
		expect(await env.prompts.import()).not.toContain("keeps documentation");
	});
});

describe("buildPrompts: the task's scope", () => {
	test("a task that owns paths is told to edit only those, or report blocked", async () => {
		const env = await freshEnv();
		const task = await env.tasks.create({
			title: "parser work",
			owns: ["src/parser/**", "docs/parser.md"],
		});

		const prompt = await env.prompts.task(task.id);

		expect(prompt).toContain("## Scope");
		expect(prompt).toContain("- `src/parser/**`");
		expect(prompt).toContain("- `docs/parser.md`");
		expect(prompt).toContain('"status": "blocked"');
	});

	test("a task that owns nothing gets no scope section", async () => {
		const env = await freshEnv();
		const task = await env.tasks.create({ title: "anything goes" });

		expect(await env.prompts.task(task.id)).not.toContain("## Scope");
	});
});

describe("buildPrompts: resuming after leftover processes", () => {
	async function parentRun(env: Env, taskId: string, processes: unknown[]) {
		const run = await env.registry.create({
			kind: "task",
			taskId,
			label: "t",
			model: "sonnet",
			cwd: env.dir,
		});
		await env.registry.beginStep(run.id, "reap_leftovers");
		await env.registry.finishStep(run.id, "reap_leftovers", {
			processes,
			stopped: [],
			killed: [],
		});
		await env.registry.beginStep(run.id, "settle");
		await env.registry.finishStep(run.id, "settle", {
			class: processes.length > 0 ? "background_work" : "interrupted",
		});
		return run.id;
	}

	test("names the commands that were stopped and says nothing wakes the agent", async () => {
		const env = await freshEnv();
		const task = await env.tasks.create({ title: "wire the widget" });
		const parent = await parentRun(env, task.id, [
			{ pid: 11, command: "bun test --watch", cwd: env.dir },
			{ pid: 12, command: "cargo build --release", cwd: env.dir },
		]);

		const prompt = await env.prompts.continuation(task.id, parent);

		expect(prompt).toContain("## Commands left running");
		expect(prompt).toContain("bun test --watch");
		expect(prompt).toContain("cargo build --release");
		expect(prompt).toContain("mfw stopped them");
		expect(prompt).toContain("Nothing wakes an agent after its");
		expect(prompt).toContain("Run long\ncommands in the foreground");
	});

	test("an ordinary interrupted resume says nothing about leftovers", async () => {
		const env = await freshEnv();
		const task = await env.tasks.create({ title: "wire the widget" });
		const parent = await parentRun(env, task.id, []);

		const prompt = await env.prompts.continuation(task.id, parent);

		expect(prompt).toContain("was interrupted before finishing");
		expect(prompt).not.toContain("Commands left running");
	});

	test("background jobs the parent's turn ended on are named, with the foreground instruction", async () => {
		const env = await freshEnv();
		const task = await env.tasks.create({ title: "wire the widget" });
		const parent = await parentRun(env, task.id, []);
		await env.registry.beginStep(parent, "classify");
		await env.registry.finishStep(parent, "classify", {
			outcome: "completed",
			background: [{ callId: "b1", tool: "Bash", summary: "bun test" }],
		});

		const prompt = await env.prompts.continuation(task.id, parent);

		expect(prompt).toContain("## Background work that never finished");
		expect(prompt).toContain("- Bash: bun test");
		expect(prompt).toContain("Re-run them in the foreground");
		expect(prompt).not.toContain("was interrupted before finishing");
	});
});

describe("buildPrompts: a review fix repair", () => {
	async function reviewedParent(env: Env, taskId: string, critic: unknown) {
		const run = await env.registry.create({
			kind: "task",
			taskId,
			label: "t",
			model: "sonnet",
			cwd: env.dir,
		});
		await env.registry.beginStep(run.id, "verify");
		await env.registry.finishStep(run.id, "verify", {
			passed: true,
			checks: [],
		});
		await env.registry.beginStep(run.id, "critic");
		await env.registry.finishStep(run.id, "critic", critic);
		return run.id;
	}

	test("carries the reviewer's findings by file and line, not a verify failure", async () => {
		const env = await freshEnv();
		const task = await env.tasks.create({ title: "wire the widget" });
		const parent = await reviewedParent(env, task.id, {
			status: "ok",
			verdict: "fix",
			round: 2,
			findings: [
				{
					file: "src/w.ts",
					line: 7,
					severity: "blocker",
					change: "close the socket",
				},
				{ file: "", severity: "nit", change: "name things" },
			],
			criteria: [
				{
					criterion: "reconnects",
					verdict: "unmet",
					evidence: "no retry",
					evidenceClass: "source-confirmed",
				},
			],
		});
		const prompt = await env.prompts.continuation(task.id, parent);
		expect(prompt).toContain("## Review asked for changes (round 2)");
		expect(prompt).toContain("- [blocker] `src/w.ts:7`: close the socket");
		expect(prompt).toContain("- [nit] (general): name things");
		expect(prompt).toContain("- reconnects (no retry)");
		expect(prompt).not.toContain("did not pass verification");
	});

	test("a merge verdict leaves the ordinary verification repair brief", async () => {
		const env = await freshEnv();
		const task = await env.tasks.create({ title: "wire the widget" });
		const parent = await reviewedParent(env, task.id, {
			status: "ok",
			verdict: "merge",
		});
		const prompt = await env.prompts.continuation(task.id, parent);
		expect(prompt).toContain("did not pass verification");
		expect(prompt).not.toContain("Review asked for changes");
	});
});

describe("buildPrompts: how a task run ends", () => {
	test("every task-run prompt forbids ending a turn on background work and says how to ask", async () => {
		const env = await freshEnv();
		const task = await env.tasks.create({ title: "wire the widget" });
		for (const prompt of [
			await env.prompts.task(task.id),
			await env.prompts.continuation(task.id, "none"),
		]) {
			expect(prompt).toContain("## Ending your turn");
			expect(prompt).toContain("Never end your turn with a background job");
			expect(prompt).toContain('"status": "question"');
		}
	});

	test("a continuation of a question carries the question and the answer", async () => {
		const env = await freshEnv();
		const task = await env.tasks.create({ title: "wire the widget" });
		const run = await env.registry.create({
			kind: "task",
			taskId: task.id,
			label: "t",
			model: "sonnet",
			cwd: env.dir,
		});
		await env.registry.beginStep(run.id, "settle");
		await env.registry.finishStep(run.id, "settle", { class: "question" });
		const clarify = new ClarifyService({
			handle: env.handle,
			bus: new EventBus(),
			log: silentLogger(),
		});
		await clarify.raise({
			runId: run.id,
			kind: "task",
			questions: ["Keep v1?"],
		});
		await clarify.answer(run.id, [{ index: 0, answer: "Until March." }]);
		const prompts = buildPrompts(env.tasks, env.registry, clarify);

		const prompt = await prompts.continuation(task.id, run.id);

		expect(prompt).toContain("## The question you asked was answered");
		expect(prompt).toContain("Keep v1?");
		expect(prompt).toContain("Until March.");
		expect(prompt).toContain(run.id);
	});

	test("a continuation of a parked merge names the conflict", async () => {
		const env = await freshEnv();
		const task = await env.tasks.create({ title: "wire the widget" });
		const run = await env.registry.create({
			kind: "task",
			taskId: task.id,
			label: "t",
			model: "sonnet",
			cwd: env.dir,
		});
		await env.registry.beginStep(run.id, "settle");
		await env.registry.finishStep(run.id, "settle", { class: "merge_parked" });
		await env.registry.finish(run.id, "failed", "conflict in src/a.ts");

		const prompt = await env.prompts.continuation(task.id, run.id);

		expect(prompt).toContain("## This task's branch would not merge");
		expect(prompt).toContain("conflict in src/a.ts");
	});
});

describe("buildPrompts: plan and import proposals", () => {
	const TEMPLATE = "## Goal\nWhat and why.\n\n## Notes (optional)\nAnything.\n";

	test("the plan prompt documents owns and model_tier", async () => {
		const env = await freshEnv();

		const prompt = await env.prompts.plan("ship it");

		expect(prompt).toContain("`owns`");
		expect(prompt).toContain('`model_tier`: "light" | "standard" | "strong"');
		expect(prompt).not.toContain("## Task body template");
	});

	test("plan and import prompts carry the implementation template", async () => {
		const env = await freshEnv();
		await mkdir(join(env.dir, "templates"), { recursive: true });
		await writeFile(join(env.dir, "templates", "implementation.md"), TEMPLATE);

		for (const prompt of [
			await env.prompts.plan("ship it"),
			await env.prompts.import(),
		]) {
			expect(prompt).toContain("## Task body template");
			expect(prompt).toContain("## Goal\nWhat and why.");
			expect(prompt).toContain("must fill in the required sections");
			expect(prompt).toContain("`owns`");
		}
	});
});
