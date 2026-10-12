import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
	activeBindings,
	handleKeyDown,
	registerScope,
	resetSequence,
} from "../../lib/keyboard";
import { PaletteList } from "./CommandPalette";
import {
	commandsOnly,
	filterCommands,
	navCommands,
	nodeTarget,
	type PaletteTask,
	paletteBindings,
	rankTasks,
	refFromQuery,
	scoreTask,
} from "./palette";

const TASKS: PaletteTask[] = [
	{ id: "MFW-1", title: "Parse config v2", status: "done" },
	{ id: "MFW-41", title: "Parse config v3", status: "in_progress" },
	{ id: "MFW-410", title: "Unrelated thing", status: "ready" },
	{ id: "MFW-7", title: "Fix MFW-41 flake", status: "ready" },
];

describe("ranking", () => {
	test("an exact id beats a prefix, a prefix beats a title hit", () => {
		const ids = rankTasks(TASKS, "mfw-41").map((t) => t.id);
		expect(ids).toEqual(["MFW-41", "MFW-410", "MFW-7"]);
	});

	test("searching a title finds the task", () => {
		expect(rankTasks(TASKS, "unrelated").map((t) => t.id)).toEqual(["MFW-410"]);
		expect(rankTasks(TASKS, "parse v3").map((t) => t.id)).toEqual(["MFW-41"]);
	});

	test("subsequence match needs three letters, and no match is dropped", () => {
		expect(scoreTask(TASKS[1] as PaletteTask, "pcv")).toBeGreaterThan(0);
		expect(scoreTask(TASKS[1] as PaletteTask, "zz")).toBe(0);
		expect(rankTasks(TASKS, "nothing like it")).toEqual([]);
	});

	test("with no query open work comes before settled work, and the cap holds", () => {
		expect(rankTasks(TASKS, "")[0]?.status).not.toBe("done");
		expect(rankTasks(TASKS, "")[3]?.id).toBe("MFW-1");
		const many = Array.from({ length: 500 }, (_, i) => ({
			id: `T-${i}`,
			title: "x",
			status: "ready",
		}));
		expect(rankTasks(many, "").length).toBe(50);
	});
});

describe("targets", () => {
	test("a task selects its node on the board", () => {
		expect(nodeTarget("mfw", "task:MFW-41")).toBe(
			"/p/mfw/board?node=task:MFW-41",
		);
	});

	test("other nodes open as a page", () => {
		expect(nodeTarget("mfw", "run:01J")).toBe("/p/mfw/n/run:01J");
		expect(nodeTarget("mfw", "decision:5")).toBe("/p/mfw/n/decision:5");
	});

	test("a typed ref is recognised, prose is not", () => {
		expect(refFromQuery(" run:01J ")).toBe("run:01J");
		expect(refFromQuery("parse config")).toBeNull();
		expect(refFromQuery("run:")).toBeNull();
	});

	test("> asks for commands only", () => {
		expect(commandsOnly(">board")).toBe(true);
		expect(commandsOnly("board")).toBe(false);
		const commands = navCommands("mfw");
		expect(filterCommands(commands, ">flow").map((c) => c.id)).toEqual([
			"go-flow",
		]);
		expect(filterCommands(commands, "gb").map((c) => c.id)).toEqual([
			"go-board",
		]);
	});

	test("without a project only the machine pages are offered", () => {
		expect(navCommands(null).map((c) => c.id)).toEqual(["go-home", "go-fleet"]);
	});
});

describe("keys", () => {
	const disposers: Array<() => void> = [];
	afterEach(() => {
		for (const d of disposers.splice(0)) d();
		resetSequence();
	});

	const key = (k: string, meta = false) =>
		handleKeyDown({
			key: k,
			metaKey: meta,
			ctrlKey: false,
			altKey: false,
			shiftKey: false,
			isComposing: false,
			target: null,
			preventDefault: () => {},
		} as unknown as KeyboardEvent);

	test("mod+k opens; g h, g b, g f, g l navigate", () => {
		const went: string[] = [];
		let opened = 0;
		disposers.push(
			registerScope(
				paletteBindings({
					project: "mfw",
					go: (to) => went.push(to),
					open: () => {
						opened++;
					},
				}),
			),
		);
		key("k", true);
		expect(opened).toBe(1);
		for (const second of ["h", "b", "f", "l"]) {
			key("g");
			key(second);
		}
		expect(went).toEqual(["/", "/p/mfw/board", "/p/mfw/flow", "/fleet"]);
	});

	test("the registry (and so `?`) lists the new bindings", () => {
		disposers.push(
			registerScope(
				paletteBindings({ project: "mfw", go: () => {}, open: () => {} }),
			),
		);
		const keys = activeBindings().map((b) => b.key);
		expect(keys).toEqual(
			expect.arrayContaining(["mod+k", "g h", "g b", "g f", "g l"]),
		);
	});
});

describe("PaletteList render", () => {
	const render = (query: string, project: string | null = "mfw") =>
		renderToStaticMarkup(
			<PaletteList
				project={project}
				query={query}
				onQuery={() => {}}
				tasks={TASKS}
				onSelect={() => {}}
			/>,
		);

	test("lists tasks and the go-to commands with their keys", () => {
		const html = render("");
		expect(html).toContain("MFW-41");
		expect(html).toContain("Parse config v3");
		expect(html).toContain("Go to Board (mfw)");
		expect(html).toMatch(/G then B/);
	});

	test("a query narrows to the matching task", () => {
		const html = render("unrelated");
		expect(html).toContain("MFW-410");
		expect(html).not.toContain("Parse config v2");
	});

	test("a typed ref offers to open it", () => {
		expect(render("run:01JQ2")).toContain("run:01JQ2");
	});

	test("nothing matching says so", () => {
		expect(render("qqqq zzzz")).toContain("Nothing matches");
	});
});
