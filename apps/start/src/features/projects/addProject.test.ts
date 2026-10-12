import { describe, expect, test } from "bun:test";

import {
	type AddState,
	type BoardTemplateInfo,
	buildAddInput,
	describeInspection,
	effectiveInspection,
	type Inspection,
	needsInspection,
	suggestFolders,
	summarize,
	validateFolderName,
} from "./addProject";

const REPO = "/home/me/dev/app";

function inspection(patch: Partial<Inspection> = {}): Inspection {
	return {
		path: REPO,
		exists: true,
		isGitRepo: true,
		location: "none",
		boardYaml: null,
		valid: false,
		error: null,
		key: null,
		types: [],
		statusRoles: null,
		statusMapError: null,
		...patch,
	};
}

const boardTypes: Inspection["types"] = [
	{
		name: "task",
		dir: "tasks",
		layout: "flat",
		documents: 3,
		statusField: "status",
		statuses: ["todo", "doing", "done"],
		statusCounts: { todo: 1, doing: 1, done: 1 },
	},
];

const found = (patch: Partial<Inspection> = {}) =>
	inspection({
		location: "root",
		boardYaml: `${REPO}/board.yaml`,
		valid: true,
		key: "APP",
		types: boardTypes,
		statusRoles: { todo: "ready", doing: "in_progress", done: "done" },
		...patch,
	});

const templates: BoardTemplateInfo[] = [
	{ id: "mfw-default", title: "mfw default", description: "", statuses: [] },
	{ id: "kanban", title: "Kanban", description: "", statuses: [] },
];

const inRepo: AddState = {
	repo: REPO,
	board: { kind: "repo" },
	template: null,
};
const elsewhere = (create = false): AddState => ({
	repo: REPO,
	board: { kind: "folder", path: "/home/me/boards/app", create },
	template: null,
});

describe("describeInspection", () => {
	test("no answer yet blocks Add", () => {
		const view = describeInspection(null);
		expect(view).toMatchObject({
			kind: "loading",
			canAdd: false,
			needsTemplate: false,
		});
	});

	test("a folder that does not exist will be created and needs a template", () => {
		const view = describeInspection(inspection({ exists: false }));
		expect(view).toMatchObject({
			kind: "new-folder",
			canAdd: true,
			needsTemplate: true,
		});
	});

	test("no board here asks for a template", () => {
		expect(describeInspection(inspection())).toMatchObject({
			kind: "none",
			tone: "neutral",
			canAdd: true,
			needsTemplate: true,
		});
	});

	test("an existing board reports tasks, layout, statuses with counts and roles", () => {
		const view = describeInspection(found());
		expect(view).toMatchObject({
			kind: "existing",
			tone: "success",
			canAdd: true,
			needsTemplate: false,
			tasks: 3,
			layout: "flat",
		});
		expect(view.detail).toContain("3 tasks");
		expect(view.statuses).toEqual([
			{ name: "todo", count: 1, role: "ready" },
			{ name: "doing", count: 1, role: "in_progress" },
			{ name: "done", count: 1, role: "done" },
		]);
	});

	test("a board in .mfw/ says it will be moved", () => {
		const view = describeInspection(found({ location: "legacy-mfw" }));
		expect(view).toMatchObject({
			kind: "legacy",
			tone: "warning",
			canAdd: true,
			needsTemplate: false,
		});
		expect(view.title).toContain(".mfw/");
		expect(view.detail).toContain("moved to the folder root");
	});

	test("both locations is an error naming both files, and blocks Add", () => {
		const view = describeInspection(
			found({ location: "ambiguous", path: "/x/board" }),
		);
		expect(view).toMatchObject({
			kind: "ambiguous",
			tone: "error",
			canAdd: false,
			needsTemplate: false,
		});
		expect(view.detail).toContain("/x/board/board.yaml");
		expect(view.detail).toContain("/x/board/.mfw/board.yaml");
	});

	test("an invalid board.yaml shows its error and blocks Add", () => {
		const view = describeInspection(
			inspection({
				location: "root",
				valid: false,
				error: "types.task: bad field",
			}),
		);
		expect(view).toMatchObject({
			kind: "invalid",
			tone: "error",
			canAdd: false,
		});
		expect(view.detail).toBe("types.task: bad field");
	});

	test("a board whose statuses cannot be mapped blocks Add with the fix", () => {
		const view = describeInspection(
			found({ statusRoles: null, statusMapError: "add x-mfw-daemon" }),
		);
		expect(view).toMatchObject({ kind: "invalid", canAdd: false });
		expect(view.detail).toBe("add x-mfw-daemon");
	});
});

describe("buildAddInput", () => {
	test("a board in the repository sends neither boardRoot nor, for an existing board, template", () => {
		expect(buildAddInput(inRepo, found(), templates)).toEqual({ root: REPO });
	});

	test("template only when there is no board yet, defaulting to mfw-default", () => {
		expect(buildAddInput(inRepo, inspection(), templates)).toEqual({
			root: REPO,
			template: "mfw-default",
		});
		expect(
			buildAddInput({ ...inRepo, template: "kanban" }, inspection(), templates),
		).toEqual({ root: REPO, template: "kanban" });
		// A leftover template choice is dropped once a board is found.
		expect(
			buildAddInput({ ...inRepo, template: "kanban" }, found(), templates),
		).toEqual({ root: REPO });
	});

	test("boardRoot only when a different folder is chosen", () => {
		const folder = "/home/me/boards/app";
		expect(
			buildAddInput(elsewhere(), found({ path: folder }), templates),
		).toEqual({ root: REPO, boardRoot: folder });
		const same: AddState = {
			...inRepo,
			board: { kind: "folder", path: REPO, create: false },
		};
		expect(buildAddInput(same, found(), templates)).toEqual({ root: REPO });
	});

	test("a folder to be created asks the daemon to create it, with a template", () => {
		const state = elsewhere(true);
		const effective = effectiveInspection(state, undefined);
		expect(buildAddInput(state, effective, templates)).toEqual({
			root: REPO,
			boardRoot: "/home/me/boards/app",
			createBoardFolder: true,
			template: "mfw-default",
		});
	});

	test("nothing is submitted while loading, on errors, or without a repository", () => {
		expect(buildAddInput(inRepo, null, templates)).toBeNull();
		expect(
			buildAddInput(inRepo, found({ location: "ambiguous" }), templates),
		).toBeNull();
		expect(
			buildAddInput({ ...inRepo, repo: null }, found(), templates),
		).toBeNull();
	});

	test("an unknown template choice blocks Add", () => {
		expect(
			buildAddInput({ ...inRepo, template: "gone" }, inspection(), templates),
		).toBeNull();
	});
});

describe("effectiveInspection", () => {
	test("an answer for another folder never describes the current one", () => {
		expect(effectiveInspection(elsewhere(), found({ path: REPO }))).toBeNull();
		expect(needsInspection(elsewhere(true))).toBe(false);
		expect(needsInspection(elsewhere())).toBe(true);
		expect(needsInspection({ ...inRepo, repo: null })).toBe(false);
	});
});

describe("summarize", () => {
	const text = (lines: ReturnType<typeof summarize>) =>
		lines.map((l) => `${l.label}: ${l.value}`).join("\n");

	test("says where the board goes and what happens to it", () => {
		expect(text(summarize(inRepo, inspection(), templates))).toContain(
			'a new "mfw default" board.yaml will be written',
		);
		expect(
			text(
				summarize({ ...inRepo, template: "kanban" }, inspection(), templates),
			),
		).toContain('"Kanban"');
		expect(text(summarize(inRepo, found(), templates))).toContain(
			"existing board adopted as it is (3 tasks)",
		);
		expect(
			text(summarize(inRepo, found({ location: "legacy-mfw" }), templates)),
		).toContain("moves to the folder root");
		const away = text(
			summarize(
				elsewhere(true),
				effectiveInspection(elsewhere(true), null),
				[],
			),
		);
		expect(away).toContain("/home/me/boards/app");
		expect(away).toContain("created for it");
	});

	test("is empty before a repository is chosen", () => {
		expect(summarize({ ...inRepo, repo: null }, null)).toEqual([]);
	});
});

describe("folder naming and suggestions", () => {
	test("only a plain single segment can be typed", () => {
		expect(validateFolderName("app-board")).toBeNull();
		for (const bad of ["", "  ", "..", ".", "a/b", "../x", "a\\b"]) {
			expect(validateFolderName(bad)).not.toBeNull();
		}
	});

	test("suggests recent, matching siblings and a new <repo>-board, without repositories", () => {
		const result = suggestFolders({
			repo: REPO,
			recent: ["/srv/boards/app"],
			siblings: [
				{
					name: "app-docs",
					path: "/home/me/dev/app-docs",
					isRepository: false,
				},
				{ name: "other", path: "/home/me/dev/other", isRepository: false },
				{
					name: "app-notes",
					path: "/home/me/dev/app-notes",
					isRepository: true,
				},
				{ name: "app", path: REPO, isRepository: true },
			],
		});
		expect(result.map((s) => [s.path, s.reason, s.create])).toEqual([
			["/srv/boards/app", "recent", false],
			["/home/me/dev/app-docs", "sibling", false],
			["/home/me/dev/app-board", "new", true],
		]);
	});

	test("an existing <repo>-board sibling is not offered twice as new", () => {
		const result = suggestFolders({
			repo: REPO,
			recent: [],
			siblings: [
				{
					name: "app-board",
					path: "/home/me/dev/app-board",
					isRepository: false,
				},
			],
		});
		expect(result).toHaveLength(1);
		expect(result[0]?.create).toBe(false);
	});
});
