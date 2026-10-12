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
import { ACCEPTANCE_MIGRATION_KEY, TaskService } from "../src/task-service.ts";
import {
	addAcceptanceField,
	BoardUpgradeError,
	bodyWithCriteriaSection,
	downgradeBoardYaml,
	planBodyMigration,
	removeAcceptanceField,
	revertBodyCriteria,
	upgradeBoardYaml,
} from "../src/tasks/acceptance.ts";
import {
	REVERT_COMMIT_MESSAGE,
	revertAcceptance,
} from "../src/tasks/acceptance-revert.ts";
import { MFW_EXCLUDE } from "./fixtures/board.ts";

/** The default board.yaml as a board created before the field existed has it. */
function legacyBoardYaml(key = "MFW"): string {
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
		const before = legacyBoardYaml();
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
		const conflicting = legacyBoardYaml().replace(
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
		expect(removeAcceptanceField("board.yaml", out)).toBe(text);
	});

	test("a flow-style fields map is upgraded too", () => {
		const text =
			"mfw: 1\ntypes:\n  task:\n    layout: flat\n    dir: tasks\n    id: { strategy: own-sequence, key: ABC }\n    fields: { title: {}, status: { values: [a, b], default: a } }\n";
		const out = addAcceptanceField("board.yaml", text);
		expect(out).toContain("acceptance: { type: checklist, optional: true }");
		expect(addAcceptanceField("board.yaml", out)).toBe(out);
	});

	test("downgrade is the exact inverse of the upgrade", () => {
		const before = legacyBoardYaml();
		const up = addAcceptanceField("board.yaml", before);
		expect(removeAcceptanceField("board.yaml", up)).toBe(before);
		expect(removeAcceptanceField("board.yaml", before)).toBe(before);
	});

	test("a fresh board gets the field from the default", async () => {
		const dir = await tmp("mfw-acc-yaml-");
		await ensureBoardConfig(dir, "ABC");
		const config = await loadBoardConfig(join(dir, "board.yaml"));
		expect(config.types.task?.fields.acceptance?.kind).toBe("checklist");
	});
});

describe("body section planning", () => {
	test("moves every item, done flags included, and keeps the rest of the body exactly", () => {
		const body =
			"Why this exists.\n\n## Acceptance Criteria\n\n- [x] login works with `a, b`\n- [ ] logout clears the *session*\n- plain item\n\n## Notes\n\nkeep me\n";
		const plan = planBodyMigration(body, []);
		expect(plan).toEqual({
			kind: "move",
			body: "Why this exists.\n\n## Notes\n\nkeep me",
			items: [
				{ text: "login works with `a, b`", done: true },
				{ text: "logout clears the *session*", done: false },
				{ text: "plain item", done: false },
			],
		});
	});

	test("anything that would lose text is skipped", () => {
		const prose = "## Acceptance Criteria\n\nThe page must load.\n- item\n";
		expect(planBodyMigration(prose, []).kind).toBe("skip");
		const nested = "## Acceptance Criteria\n\n- item\n  - sub\n";
		expect(planBodyMigration(nested, []).kind).toBe("skip");
		const both = "## Acceptance Criteria\n\n- item\n";
		expect(planBodyMigration(both, [{ id: "c1" }]).kind).toBe("skip");
		expect(planBodyMigration("no section", []).kind).toBe("none");
	});

	test("the reverse renders checkboxes the forward plan reads back", () => {
		const items = [
			{ text: "a", done: true },
			{ text: "b", done: false },
		];
		const body = bodyWithCriteriaSection("Goal.", items);
		expect(planBodyMigration(body, [])).toEqual({
			kind: "move",
			body: "Goal.",
			items,
		});
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

async function legacyTask(
	dir: string,
	id: string,
	body: string,
	extra = "",
): Promise<string> {
	const taskDir = join(dir, "tasks", `${id}-legacy`);
	await mkdir(taskDir, { recursive: true });
	const path = join(taskDir, "task.md");
	await writeFile(
		path,
		`---\nmfw: 1\nid: ${id}\nrev: 3\ntitle: legacy ${id}\nstatus: backlog\n${extra}---\n\n${body}\n`,
	);
	return path;
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

describe("body -> field task migration", () => {
	test("moves criteria into the field preserving text, skips lossy sections, runs once", async () => {
		const dir = await tmp("mfw-acc-mig-");
		await writeFile(join(dir, "board.yaml"), legacyBoardYaml());
		const goodBody =
			"Context line.\n\n## Acceptance Criteria\n\n- [x] parses `--flag=a,b`\n- [ ] errors name the file\n\n## Notes\n\nverbatim tail";
		const goodPath = await legacyTask(dir, "MFW-1", goodBody);
		const proseBody = "## Acceptance Criteria\n\nSee the spec.";
		const prosePath = await legacyTask(dir, "MFW-2", proseBody);
		const proseBefore = await readFile(prosePath, "utf8");
		await legacyTask(dir, "MFW-3", "Nothing to move.");

		const { svc, handle } = await service(dir); // upgrades board.yaml
		const report = await svc.migrateAcceptance();
		expect(report?.migrated).toEqual(["MFW-1"]);
		expect(report?.skipped.map((s) => s.id)).toEqual(["MFW-2"]);

		const got = await svc.get("MFW-1");
		expect(got?.criteria).toEqual([
			{ id: "c1", text: "parses `--flag=a,b`", checked: true },
			{ id: "c2", text: "errors name the file", checked: false },
		]);
		expect(got?.body).toBe("Context line.\n\n## Notes\n\nverbatim tail");
		const onDisk = await readFile(goodPath, "utf8");
		expect(onDisk).not.toContain("## Acceptance Criteria");
		expect(await readFile(prosePath, "utf8")).toBe(proseBefore);

		// Once per board: a later run (or a hand-written section) is left alone.
		expect(await svc.migrateAcceptance()).toBeNull();
		const [marker] = await handle.db
			.select()
			.from(engineKv)
			.where(eq(engineKv.key, ACCEPTANCE_MIGRATION_KEY));
		expect(marker?.value).toMatchObject({ version: 1, migrated: 1 });
	});

	test("the reverse step restores body sections and the old board.yaml", async () => {
		const dir = await tmp("mfw-acc-rev-");
		const legacy = legacyBoardYaml();
		await writeFile(join(dir, "board.yaml"), legacy);
		const body = "Goal.\n\n## Acceptance Criteria\n\n- [x] first\n- [ ] second";
		const path = await legacyTask(dir, "MFW-1", body);
		const { svc } = await service(dir);
		await svc.migrateAcceptance();

		const report = await revertBodyCriteria(
			dir,
			await loadBoardConfig(join(dir, "board.yaml")),
		);
		expect(report).toEqual({ migrated: ["MFW-1"], skipped: [] });
		expect(await downgradeBoardYaml(join(dir, "board.yaml"))).toBe(true);
		expect(await readFile(join(dir, "board.yaml"), "utf8")).toBe(legacy);
		// The old board validates the reverted task again.
		const config = await loadBoardConfig(join(dir, "board.yaml"));
		expect(config.types.task?.fields.acceptance).toBeUndefined();
		const reverted = await readFile(path, "utf8");
		expect(reverted).not.toContain("acceptance:");
		expect(reverted).toContain(
			"Goal.\n\n## Acceptance Criteria\n\n- [x] first\n- [ ] second",
		);
	});

	test("deferred while the circuit breaker distrusts the board", async () => {
		const dir = await tmp("mfw-acc-brk-");
		await writeFile(join(dir, "board.yaml"), legacyBoardYaml());
		for (let i = 1; i <= 6; i++) {
			await legacyTask(dir, `MFW-${i}`, "## Acceptance Criteria\n\n- x");
		}
		const { svc } = await service(dir);
		await rm(join(dir, "tasks"), { recursive: true, force: true });
		await svc.refresh();
		expect(svc.isBoardSuspended).toBe(true);
		expect(await svc.migrateAcceptance()).toBeNull();
	});
});

describe("attach", () => {
	test("upgrades board.yaml and migrates tasks in one board commit", async () => {
		const root = await tmp("mfw-acc-boot-");
		const home = await tmp("mfw-acc-home-");
		await git(["init", "-q", "-b", "main", "."], root);
		await git(["config", "user.email", "t@t"], root);
		await git(["config", "user.name", "t"], root);
		await writeFile(join(root, ".git/info/exclude"), MFW_EXCLUDE);
		const boardDir = root;
		await mkdir(boardDir, { recursive: true });
		await writeFile(join(boardDir, "board.yaml"), legacyBoardYaml());
		await legacyTask(
			boardDir,
			"MFW-1",
			"Goal.\n\n## Acceptance Criteria\n\n- [ ] it works",
		);
		await git(["add", "-A"], root);
		await git(["commit", "-qm", "init"], root);

		const orch = await boot({
			projects: [{ name: "demo", root, integrationBranch: "main" }],
			log: silentLogger(),
			autostart: false,
			mfwHome: home,
		});
		try {
			const svc = orch.get("demo");
			expect((await svc.tasks.get("MFW-1"))?.criteria).toEqual([
				{ id: "c1", text: "it works", checked: false },
			]);
			const log = await git(["log", "--format=%s", "-n", "1"], root);
			expect(log.stdout.trim()).toBe(
				"mfw: move acceptance criteria into the acceptance field",
			);
			const files = await git(
				["show", "--name-only", "--format=", "HEAD"],
				root,
			);
			expect(files.stdout).toContain("board.yaml");
			expect(files.stdout).toContain("tasks/MFW-1-legacy/task.md");

			// The reverse step refuses while a daemon has the project attached.
			await expect(
				revertAcceptance({ root, log: silentLogger() }),
			).rejects.toThrow(/stop it before reverting/);
		} finally {
			await orch.shutdown();
		}

		// With the daemon stopped: back to the legacy board, in one commit, and
		// the marker cleared so the next attach migrates again.
		const reverted = await revertAcceptance({ root, log: silentLogger() });
		expect(reverted.migrated).toEqual(["MFW-1"]);
		expect(reverted.committed).toBe(REVERT_COMMIT_MESSAGE);
		expect(await readFile(join(boardDir, "board.yaml"), "utf8")).toBe(
			legacyBoardYaml(),
		);
		const status = await git(["status", "--porcelain"], root);
		expect(status.stdout.trim()).toBe("");

		const again = await boot({
			projects: [{ name: "demo", root, integrationBranch: "main" }],
			log: silentLogger(),
			autostart: false,
			mfwHome: home,
		});
		try {
			expect((await again.get("demo").tasks.get("MFW-1"))?.criteria).toEqual([
				{ id: "c1", text: "it works", checked: false },
			]);
		} finally {
			await again.shutdown();
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
			legacyBoardYaml().replace(
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
