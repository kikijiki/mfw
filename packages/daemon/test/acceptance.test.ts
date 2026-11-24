import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBoardConfig } from "@mfw/board-core";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import { EventBus } from "@mfw/db/eventlog";
import { ulid } from "@mfw/db/ids";
import { engineKv } from "@mfw/db/schema";
import { eq } from "drizzle-orm";
import pino from "pino";
import { boot } from "../src/boot.ts";
import {
	defaultBoardYaml,
	ensureBoardConfig,
} from "../src/default-board-config.ts";
import { git } from "../src/git.ts";
import { silentLogger } from "../src/log.ts";
import { TaskService } from "../src/task-service.ts";
import {
	addAcceptanceField,
	BoardUpgradeError,
	upgradeBoardYaml,
} from "../src/tasks/acceptance.ts";
import { MFW_EXCLUDE } from "./fixtures/board.ts";

/** The default board.yaml without the acceptance field, as a hand-written board might be. */
function boardYamlWithoutAcceptance(key = "MFW"): string {
	const yaml = defaultBoardYaml(key).replace(
		/\n {6}# Acceptance criteria:[^\n]*\n(?: {6}#[^\n]*\n)*\s*acceptance: \{ type: checklist, optional: true \}\n/,
		"\n",
	);
	expect(yaml).not.toContain("acceptance:");
	return yaml;
}

const dirs: string[] = [];
const handles: ProjectDbHandle[] = [];

afterEach(async () => {
	for (const h of handles.splice(0)) h.close();
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tmp(prefix: string): Promise<string> {
	const d = await mkdtemp(join(tmpdir(), prefix));
	dirs.push(d);
	return d;
}

describe("board.yaml upgrade", () => {
	test("adds the field as one inserted line, keeping the rest byte for byte, and is idempotent", async () => {
		const dir = await tmp("mfw-acc-yaml-");
		const path = join(dir, "board.yaml");
		const before = boardYamlWithoutAcceptance();
		await writeFile(path, before);

		expect(await upgradeBoardYaml(path)).toBe(true);
		const after = await readFile(path, "utf8");
		const added = after
			.split("\n")
			.filter((l) => !before.split("\n").includes(l));
		expect(added).toEqual([
			"      acceptance: { type: checklist, optional: true }",
		]);
		expect(after.replace(`${added[0]}\n`, "")).toBe(before);
		const config = await loadBoardConfig(path);
		expect(config.types.task?.fields.acceptance?.kind).toBe("checklist");
		// Its own types (adr) and comments are untouched.
		expect(after).toContain("# The Definition of Done");

		expect(await upgradeBoardYaml(path)).toBe(false);
		expect(await readFile(path, "utf8")).toBe(after);
	});

	test("refuses a conflicting acceptance field and writes nothing", async () => {
		const dir = await tmp("mfw-acc-yaml-");
		const path = join(dir, "board.yaml");
		const conflicting = boardYamlWithoutAcceptance().replace(
			"      verification: { type: json, optional: true }\n",
			"      verification: { type: json, optional: true }\n      acceptance: { type: json, list: true, optional: true }\n",
		);
		await writeFile(path, conflicting);
		await expect(upgradeBoardYaml(path)).rejects.toBeInstanceOf(
			BoardUpgradeError,
		);
		await expect(ensureBoardConfig(dir)).rejects.toThrow(/not a checklist/);
		expect(await readFile(path, "utf8")).toBe(conflicting);
	});

	test("inserts after a last field whose value is a block map, before a trailing comment and the next type", () => {
		const text =
			"mfw: 1\ntypes:\n  task:\n    layout: flat\n    dir: tasks\n    id: { strategy: own-sequence, key: ABC }\n    fields:\n      title: {}\n      status:\n        values: [a, b]\n        default: a\n    # trailing comment\n  note:\n    layout: flat\n    dir: notes\n    id: { strategy: own-sequence, key: ABC, suffix: N }\n    fields:\n      title: {}\n";
		const out = addAcceptanceField("board.yaml", text);
		expect(out).toBe(
			text.replace(
				"        default: a\n",
				"        default: a\n      acceptance: { type: checklist, optional: true }\n",
			),
		);
	});

	test("a flow-style fields map is upgraded too", () => {
		const text =
			"mfw: 1\ntypes:\n  task:\n    layout: flat\n    dir: tasks\n    id: { strategy: own-sequence, key: ABC }\n    fields: { title: {}, status: { values: [a, b], default: a } }\n";
		const out = addAcceptanceField("board.yaml", text);
		expect(out).toContain("acceptance: { type: checklist, optional: true }");
		expect(addAcceptanceField("board.yaml", out)).toBe(out);
	});

	test("a fresh board gets the field from the default", async () => {
		const dir = await tmp("mfw-acc-yaml-");
		await ensureBoardConfig(dir, "ABC");
		const config = await loadBoardConfig(join(dir, "board.yaml"));
		expect(config.types.task?.fields.acceptance?.kind).toBe("checklist");
	});
});

interface Svc {
	dir: string;
	handle: ProjectDbHandle;
	svc: TaskService;
}

async function service(dir: string): Promise<Svc> {
	const handle = await openProjectDb(dir);
	handles.push(handle);
	await ensureBoardConfig(dir, "MFW");
	const svc = new TaskService({
		handle,
		bus: new EventBus(),
		boardDir: dir,
		stateDir: dir,
		config: await loadBoardConfig(join(dir, "board.yaml")),
		taskKey: "MFW",
		log: silentLogger(),
	});
	await svc.load();
	return { dir, handle, svc };
}

describe("acceptance criteria persistence", () => {
	test("checked survives a restart (re-read from disk), and edits keep item ids", async () => {
		const dir = await tmp("mfw-acc-svc-");
		const a = await service(dir);
		const t = await a.svc.create({
			title: "t",
			criteria: [{ text: "one", checked: true }, { text: "two" }],
		});
		await a.svc.edit(t.id, {
			criteria: [
				{ id: "c1", text: "one", checked: true },
				{ id: "c2", text: "two", checked: true },
			],
		});
		const file = await readFile(
			join(dir, "tasks", `${t.id}-t`, "task.md"),
			"utf8",
		);
		expect(file).toContain("acceptance:");
		expect(file).not.toContain("## Acceptance Criteria");

		// A second service over the same directory: nothing in memory carries over.
		const b = await service(dir);
		expect((await b.svc.get(t.id))?.criteria).toEqual([
			{ id: "c1", text: "one", checked: true },
			{ id: "c2", text: "two", checked: true },
		]);
	});

	test("checklist ops: add, toggle, edit, remove; concurrent toggles both land", async () => {
		const dir = await tmp("mfw-acc-svc-");
		const { svc } = await service(dir);
		const t = await svc.create({
			title: "t",
			criteria: [{ text: "alpha" }, { text: "beta" }],
		});
		const added = await svc.editCriteria(t.id, { op: "add", text: "gamma" });
		expect(added.itemId).toBe("c3");
		await Promise.all([
			svc.editCriteria(t.id, { op: "toggle", selector: "c1" }),
			svc.editCriteria(t.id, { op: "toggle", selector: "bet" }),
		]);
		await svc.editCriteria(t.id, {
			op: "edit",
			selector: "gamma",
			text: "gamma two",
		});
		const out = await svc.editCriteria(t.id, { op: "remove", selector: "c1" });
		expect(out.task.criteria).toEqual([
			{ id: "c2", text: "beta", checked: true },
			{ id: "c3", text: "gamma two", checked: false },
		]);
		await expect(
			svc.editCriteria(t.id, { op: "toggle", selector: "nope" }),
		).rejects.toThrow(/no checklist item/);
	});

	test("a board rule on acceptance gates the daemon's own merge tail", async () => {
		const dir = await tmp("mfw-acc-svc-");
		await writeFile(
			join(dir, "board.yaml"),
			defaultBoardYaml("MFW").replace(
				"    slugFrom: title\n",
				"    slugFrom: title\n    rules:\n      - { id: done-accepted, field: acceptance, when: { status: done }, forbid: { done: false } }\n",
			),
		);
		const { svc } = await service(dir);
		const t = await svc.create({
			title: "t",
			status: "ready",
			criteria: [{ text: "works" }],
		});
		const runId = ulid();
		expect(await svc.tryClaim(t.id, runId, 60_000)).toBe(true);
		const landed = await svc.releaseMerged(t.id, runId);
		expect(landed.to).toBe("review");
		expect(landed.violation).toContain("done-accepted");
	});
});

describe("attach", () => {
	test("adds the field to a board.yaml that lacks it, in one board commit", async () => {
		const root = await tmp("mfw-acc-boot-");
		const home = await tmp("mfw-acc-home-");
		await git(["init", "-q", "-b", "main", "."], root);
		await git(["config", "user.email", "t@t"], root);
		await git(["config", "user.name", "t"], root);
		await writeFile(join(root, ".git/info/exclude"), MFW_EXCLUDE);
		await writeFile(join(root, "board.yaml"), boardYamlWithoutAcceptance());
		await git(["add", "-A"], root);
		await git(["commit", "-qm", "init"], root);

		const orch = await boot({
			projects: [{ name: "demo", root, integrationBranch: "main" }],
			log: silentLogger(),
			autostart: false,
			mfwHome: home,
		});
		try {
			expect(await readFile(join(root, "board.yaml"), "utf8")).toContain(
				"acceptance: { type: checklist, optional: true }",
			);
			const log = await git(["log", "--format=%s", "-n", "1"], root);
			expect(log.stdout.trim()).toBe(
				"mfw: add mfw's task fields to board.yaml",
			);
		} finally {
			await orch.shutdown();
		}
	}, 30_000);

	test("a conflicting acceptance field refuses the attach", async () => {
		const root = await tmp("mfw-acc-boot-");
		const home = await tmp("mfw-acc-home-");
		await git(["init", "-q", "-b", "main", "."], root);
		await writeFile(join(root, ".git/info/exclude"), MFW_EXCLUDE);
		const boardDir = root;
		await mkdir(boardDir, { recursive: true });
		await writeFile(
			join(boardDir, "board.yaml"),
			boardYamlWithoutAcceptance().replace(
				"      verification: { type: json, optional: true }\n",
				"      verification: { type: json, optional: true }\n      acceptance: { optional: true }\n",
			),
		);
		const lines: string[] = [];
		const orch = await boot({
			projects: [{ name: "demo", root, integrationBranch: "main" }],
			log: pino({ level: "error" }, { write: (s: string) => lines.push(s) }),
			autostart: false,
			mfwHome: home,
		});
		try {
			expect(() => orch.get("demo")).toThrow();
			expect(lines.join("\n")).toContain("project attach FAILED");
			expect(lines.join("\n")).toContain("is not a checklist");
		} finally {
			await orch.shutdown();
		}
	}, 30_000);
});
