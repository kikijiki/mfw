import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import { EventBus } from "@mfw/db/eventlog";
import { buildPrompts } from "../src/boot.ts";
import { RunRegistry } from "../src/run-registry.ts";
import type { TaskService } from "../src/task-service.ts";
import { makeTasks } from "./fixtures/board.ts";

/**
 * `buildPrompts` is what `describeTask` runs through for `.task`, `.repair`
 * and `.resume` alike. A task's `spec.md` lives in the board, which agent
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

	test("repair and resume prompts carry the spec too", async () => {
		const env = await freshEnv();
		const task = await env.tasks.create({ title: "wire the widget" });
		await env.tasks.setSpec(task.id, "Frame format details.");

		const repair = await env.prompts.repair(task.id, "run-does-not-exist");
		const resume = await env.prompts.resume(task.id, "run-does-not-exist");

		expect(repair).toContain("Frame format details.");
		expect(resume).toContain("Frame format details.");
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

describe("buildPrompts: import", () => {
	test("tells the importer a spec becomes a container task's spec.md", async () => {
		const env = await freshEnv();

		const prompt = await env.prompts.import();

		expect(prompt).toContain("`spec.md` of a\ncontainer task");
		expect(prompt).not.toContain("Existing MFW Specs");
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
		return run.id;
	}

	test("names the commands that were stopped and says nothing wakes the agent", async () => {
		const env = await freshEnv();
		const task = await env.tasks.create({ title: "wire the widget" });
		const parent = await parentRun(env, task.id, [
			{ pid: 11, command: "bun test --watch", cwd: env.dir },
			{ pid: 12, command: "cargo build --release", cwd: env.dir },
		]);

		const prompt = await env.prompts.resume(task.id, parent);

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

		const prompt = await env.prompts.resume(task.id, parent);

		expect(prompt).toContain("was interrupted before finishing");
		expect(prompt).not.toContain("Commands left running");
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
