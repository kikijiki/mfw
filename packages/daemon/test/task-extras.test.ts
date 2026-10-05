import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import { EventBus, type StoredEvent } from "@mfw/db/eventlog";
import { SpecConflictError, type TaskService } from "../src/task-service.ts";
import { CAPS, ExtrasError } from "../src/tasks/extras.ts";
import { makeTasks } from "./fixtures/board.ts";

/**
 * A task is a directory: `task.md`, an optional `spec.md`, optional `files/*`.
 * What matters here is that the optional parts are real files beside the task,
 * that they stay put through everything the board does to the task (status
 * changes and retitles are content-only writes now — MFW-ADR-22 froze a
 * task's path at creation, nothing ever renames it again), and that the
 * sanity caps hold before anything touches disk.
 */

interface Env {
	dir: string;
	handle: ProjectDbHandle;
	tasks: TaskService;
	seen: StoredEvent[];
}

const envs: Env[] = [];

async function freshEnv(): Promise<Env> {
	const dir = await mkdtemp(join(tmpdir(), "mfw-extras-"));
	const handle = await openProjectDb(dir);
	const bus = new EventBus();
	const seen: StoredEvent[] = [];
	bus.subscribe((e) => seen.push(e));
	const tasks = await makeTasks(handle, bus, dir);
	const env = { dir, handle, tasks, seen };
	envs.push(env);
	return env;
}

afterEach(async () => {
	for (const env of envs.splice(0)) {
		env.handle.close();
		await rm(env.dir, { recursive: true, force: true });
	}
});

/** Flat now: `.mfw/tasks/<ID>-<slug>/`, no status segment, frozen at creation. */
const taskDir = (env: Env, name: string) => join(env.dir, "tasks", name);

const bytes = (n: number) => new Uint8Array(n).fill(7);

describe("the task directory", () => {
	test("a new task is a directory holding task.md and nothing else", async () => {
		const env = await freshEnv();
		const t = await env.tasks.create({ title: "Wire it up" });
		const dir = taskDir(env, `${t.id}-wire-it-up`);
		expect(await readdir(dir)).toEqual(["task.md"]);
	});

	test("a directory with no task.md is not a task, and is left alone", async () => {
		const env = await freshEnv();
		const stray = taskDir(env, "MFW-9-only-attachments");
		await mkdir(join(stray, "files"), { recursive: true });
		await writeFile(join(stray, "files", "a.png"), "x");

		await env.tasks.refresh();

		expect(await env.tasks.list()).toEqual([]);
		expect(existsSync(join(stray, "files", "a.png"))).toBe(true);
	});

	test("a task's own directory is found by its id, not by a prefix of it", async () => {
		const env = await freshEnv();
		const a = await env.tasks.create({ title: "one" }); // MFW-1
		for (let i = 0; i < 9; i++) await env.tasks.create({ title: `n${i}` });
		const eleven = await env.tasks.create({ title: "eleven" }); // MFW-11
		await env.tasks.setSpec(a.id, "belongs to one");
		await env.tasks.setSpec(eleven.id, "belongs to eleven");

		expect((await env.tasks.getSpec(a.id))?.body).toBe("belongs to one");
		expect((await env.tasks.getSpec(eleven.id))?.body).toBe(
			"belongs to eleven",
		);
	});
});

describe("spec.md", () => {
	test("none yet reads as an empty, non-existent doc", async () => {
		const env = await freshEnv();
		const t = await env.tasks.create({ title: "no spec" });
		expect(await env.tasks.getSpec(t.id)).toEqual({
			body: "",
			hash: "",
			exists: false,
		});
		expect(await env.tasks.getSpec("MFW-999")).toBeNull();
	});

	test("is plain markdown beside task.md: no frontmatter", async () => {
		const env = await freshEnv();
		const t = await env.tasks.create({ title: "with spec" });
		const doc = await env.tasks.setSpec(t.id, "# Design\n\nprose\n");
		expect(doc?.exists).toBe(true);

		const path = join(taskDir(env, `${t.id}-with-spec`), "spec.md");
		expect(await Bun.file(path).text()).toBe("# Design\n\nprose\n");
	});

	test("a stale baseHash is a conflict that carries the current text", async () => {
		const env = await freshEnv();
		const t = await env.tasks.create({ title: "racy" });
		const first = await env.tasks.setSpec(t.id, "one");
		await env.tasks.setSpec(t.id, "two", first?.hash);

		try {
			await env.tasks.setSpec(t.id, "three", first?.hash);
			throw new Error("expected a conflict");
		} catch (e) {
			expect(e).toBeInstanceOf(SpecConflictError);
			expect((e as SpecConflictError).current.body).toBe("two");
		}
		expect((await env.tasks.getSpec(t.id))?.body).toBe("two");
	});

	test("a blank body removes the file rather than leaving an empty one", async () => {
		const env = await freshEnv();
		const t = await env.tasks.create({ title: "cleared" });
		await env.tasks.setSpec(t.id, "something");
		const cleared = await env.tasks.setSpec(t.id, "  \n");
		expect(cleared).toEqual({ body: "", hash: "", exists: false });
		expect(existsSync(join(taskDir(env, `${t.id}-cleared`), "spec.md"))).toBe(
			false,
		);
	});

	test("is capped, and the refusal is a user error, not a crash", async () => {
		const env = await freshEnv();
		const t = await env.tasks.create({ title: "novel" });
		const tooBig = "x".repeat(CAPS.specBytes + 1);
		await expect(env.tasks.setSpec(t.id, tooBig)).rejects.toBeInstanceOf(
			ExtrasError,
		);
		expect((await env.tasks.getSpec(t.id))?.exists).toBe(false);
	});

	test("an edit made in an editor is what the next read returns", async () => {
		const env = await freshEnv();
		const t = await env.tasks.create({ title: "by hand" });
		await writeFile(
			join(taskDir(env, `${t.id}-by-hand`), "spec.md"),
			"typed in vim",
		);
		expect((await env.tasks.getSpec(t.id))?.body).toBe("typed in vim");
	});

	test("saving is announced as a task edit, so the board gets committed", async () => {
		const env = await freshEnv();
		const t = await env.tasks.create({ title: "audited" });
		let touched = 0;
		env.tasks.onBoardChanged = () => touched++;
		env.seen.length = 0;

		await env.tasks.setSpec(t.id, "text");

		expect(touched).toBeGreaterThan(0);
		expect(env.seen.map((e) => e.type)).toEqual(["task.edited"]);
		expect(env.seen[0]?.payload).toMatchObject({ fields: ["spec"] });
	});
});

describe("attachments", () => {
	test("add, list, read back and remove", async () => {
		const env = await freshEnv();
		const t = await env.tasks.create({ title: "screenshots" });

		const info = await env.tasks.addAttachment(
			t.id,
			"shot 1.png",
			new Uint8Array([1, 2, 3]),
		);
		expect(info).toMatchObject({ name: "shot 1.png", size: 3 });
		expect(
			(await env.tasks.listTaskAttachments(t.id))?.map((a) => a.name),
		).toEqual(["shot 1.png"]);
		expect([
			...((await env.tasks.getAttachment(t.id, "shot 1.png")) ?? []),
		]).toEqual([1, 2, 3]);

		expect(await env.tasks.removeAttachment(t.id, "shot 1.png")).toBe(true);
		expect(await env.tasks.removeAttachment(t.id, "shot 1.png")).toBe(false);
		expect(await env.tasks.listTaskAttachments(t.id)).toEqual([]);
		// The empty `files/` goes too: git would not track it, so it would exist
		// here and not on the next checkout.
		expect(existsSync(join(taskDir(env, `${t.id}-screenshots`), "files"))).toBe(
			false,
		);
	});

	test("adding under an existing name replaces it without counting twice", async () => {
		const env = await freshEnv();
		const t = await env.tasks.create({ title: "replace" });
		await env.tasks.addAttachment(t.id, "a.bin", bytes(10));
		await env.tasks.addAttachment(t.id, "a.bin", bytes(20));
		expect(await env.tasks.listTaskAttachments(t.id)).toMatchObject([
			{ name: "a.bin", size: 20 },
		]);
	});

	test.each([
		["../escape.png"],
		["a/b.png"],
		[".hidden"],
		[".tmp-x"],
		["nul\0.png"],
		["..\\win.png"],
		[""],
		["x".repeat(121)],
	])("the name %j is refused", async (name) => {
		const env = await freshEnv();
		const t = await env.tasks.create({ title: "names" });
		await expect(
			env.tasks.addAttachment(t.id, name, bytes(1)),
		).rejects.toBeInstanceOf(ExtrasError);
		// Nothing landed anywhere on the board, least of all outside the task.
		expect(await readdir(env.dir)).not.toContain("escape.png");
	});

	test("reading or deleting with a hostile name is refused too", async () => {
		const env = await freshEnv();
		const t = await env.tasks.create({ title: "reads" });
		await expect(
			env.tasks.getAttachment(t.id, "../task.md"),
		).rejects.toBeInstanceOf(ExtrasError);
		await expect(
			env.tasks.removeAttachment(t.id, "../task.md"),
		).rejects.toBeInstanceOf(ExtrasError);
	});

	test("an empty file and an oversized file are refused", async () => {
		const env = await freshEnv();
		const t = await env.tasks.create({ title: "sizes" });
		await expect(
			env.tasks.addAttachment(t.id, "empty.bin", bytes(0)),
		).rejects.toBeInstanceOf(ExtrasError);
		await expect(
			env.tasks.addAttachment(t.id, "big.bin", bytes(CAPS.attachmentBytes + 1)),
		).rejects.toBeInstanceOf(ExtrasError);
		await env.tasks.addAttachment(
			t.id,
			"edge.bin",
			bytes(CAPS.attachmentBytes),
		);
	});

	test("the total across a task's attachments is capped", async () => {
		const env = await freshEnv();
		const t = await env.tasks.create({ title: "total" });
		const fits = Math.floor(CAPS.attachmentsTotalBytes / CAPS.attachmentBytes);
		for (let i = 0; i < fits; i++) {
			await env.tasks.addAttachment(
				t.id,
				`f${i}.bin`,
				bytes(CAPS.attachmentBytes),
			);
		}
		await expect(
			env.tasks.addAttachment(
				t.id,
				"one-more.bin",
				bytes(CAPS.attachmentBytes),
			),
		).rejects.toBeInstanceOf(ExtrasError);
		// Replacing an existing file with a same-size one is not growth.
		await env.tasks.addAttachment(t.id, "f0.bin", bytes(CAPS.attachmentBytes));
	});

	test("the number of attachments is capped", async () => {
		const env = await freshEnv();
		const t = await env.tasks.create({ title: "count" });
		for (let i = 0; i < CAPS.attachmentCount; i++) {
			await env.tasks.addAttachment(t.id, `f${i}.txt`, bytes(1));
		}
		await expect(
			env.tasks.addAttachment(t.id, "extra.txt", bytes(1)),
		).rejects.toBeInstanceOf(ExtrasError);
	});

	test("an unknown task is null, not an error", async () => {
		const env = await freshEnv();
		expect(
			await env.tasks.addAttachment("MFW-42", "a.txt", bytes(1)),
		).toBeNull();
		expect(await env.tasks.listTaskAttachments("MFW-42")).toBeNull();
		expect(await env.tasks.getAttachment("MFW-42", "a.txt")).toBeNull();
	});
});

describe("the spec and attachments stay put through everything", () => {
	test("a status change and a retitle never move the directory (MFW-ADR-22: paths are frozen at creation)", async () => {
		const env = await freshEnv();
		const t = await env.tasks.create({ title: "old name" });
		await env.tasks.setSpec(t.id, "the design");
		await env.tasks.addAttachment(t.id, "diagram.png", new Uint8Array([9]));
		const dir = taskDir(env, `${t.id}-old-name`);

		await env.tasks.move(t.id, "ready", "human");
		expect((await env.tasks.getSpec(t.id))?.body).toBe("the design");
		expect(existsSync(dir)).toBe(true);

		// A retitle is a content-only write now: the directory (and its slug)
		// are fixed at creation, not recomputed from the new title.
		await env.tasks.edit(t.id, { title: "new name" });
		expect(existsSync(dir)).toBe(true);
		expect(existsSync(taskDir(env, `${t.id}-new-name`))).toBe(false);
		expect((await env.tasks.get(t.id))?.title).toBe("new name");
		expect((await env.tasks.getSpec(t.id))?.body).toBe("the design");

		const claimed = await env.tasks.store.claim(t.id, "run-1", 60_000);
		expect(claimed).not.toBeNull();
		expect(existsSync(join(dir, "spec.md"))).toBe(true);
		expect((await env.tasks.getAttachment(t.id, "diagram.png"))?.[0]).toBe(9);
	});

	test("through a reload from disk", async () => {
		const env = await freshEnv();
		const t = await env.tasks.create({ title: "persisted" });
		await env.tasks.setSpec(t.id, "kept");
		await env.tasks.addAttachment(t.id, "a.txt", bytes(4));

		await env.tasks.load();

		expect((await env.tasks.getSpec(t.id))?.body).toBe("kept");
		expect((await env.tasks.listTaskAttachments(t.id))?.length).toBe(1);
	});

	test("a hand edit of the status: line is a status change that keeps them in place", async () => {
		// Status lives in frontmatter now (MFW-ADR-22); there's only one folder,
		// so there's nowhere to `mv` a task TO anymore. The out-of-band path that
		// matters now is a direct content edit of `status:`, picked up by refresh().
		const env = await freshEnv();
		const t = await env.tasks.create({ title: "dragged" });
		await env.tasks.setSpec(t.id, "still here");
		const path = join(taskDir(env, `${t.id}-dragged`), "task.md");
		const raw = await Bun.file(path).text();
		// `backlog` is board.yaml's declared default, so the renderer stays quiet
		// about it (no literal `status:` line to replace) — insert one instead.
		expect(raw).not.toContain("status:");
		await writeFile(path, raw.replace(/^title:/m, "status: done\ntitle:"));

		await env.tasks.refresh();

		expect((await env.tasks.get(t.id))?.status).toBe("done");
		expect((await env.tasks.getSpec(t.id))?.body).toBe("still here");
	});

	test("deleting the task deletes its spec and attachments with it", async () => {
		const env = await freshEnv();
		const t = await env.tasks.create({ title: "doomed" });
		await env.tasks.setSpec(t.id, "gone soon");
		await env.tasks.addAttachment(t.id, "a.txt", bytes(4));
		const dir = taskDir(env, `${t.id}-doomed`);

		expect(await env.tasks.remove(t.id)).toBe(true);

		expect(existsSync(dir)).toBe(false);
	});

	test("a parent's spec is simply the parent's: children do not inherit it", async () => {
		const env = await freshEnv();
		const parent = await env.tasks.create({ title: "epic", type: "epic" });
		await env.tasks.setSpec(parent.id, "shared contract");
		const child = await env.tasks.create({
			title: "child",
			parentId: parent.id,
		});

		expect((await env.tasks.getSpec(parent.id))?.body).toBe("shared contract");
		expect((await env.tasks.getSpec(child.id))?.exists).toBe(false);
	});
});

// A loose `.md` file dropped directly in `.mfw/tasks/` is no longer adopted
// under any circumstances for the `task` type: `.mfw/board.yaml` declares
// `layout: directory` for tasks, and `BoardStore`'s scan only ever looks at
// DIRECTORIES for a directory-layout type (packages/board-core/src/store.ts's
// `scan()`) — a bare file sitting next to them is invisible before any
// `mfw:`-marker check even runs. This retires both the old "bare note
// adoption" convenience AND the old "a loose task file with real frontmatter
// gets wrapped in a directory" migration path: neither has a home anymore.
// Coverage for "a marker-less note is never adopted" lives in board.test.ts.
