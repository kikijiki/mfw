import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "../src/cli.ts");

const BOARD = [
	"mfw: 1",
	"types:",
	"  task:",
	"    layout: flat",
	"    dir: tasks",
	"    id: { strategy: own-sequence, key: TK }",
	"    statusClasses:",
	"      terminal: [done]",
	"      live: [todo, doing]",
	"      parked: [parked]",
	"      queued: [todo]",
	"    ready: { columns: [agent, area] }",
	"    fields:",
	"      title: {}",
	"      status: { values: [todo, doing, done, parked], default: todo }",
	"      agent: { optional: true }",
	"      area: { optional: true }",
	"      depends_on: { ref: task, list: true, optional: true }",
].join("\n");

/** BOARD plus a real `hierarchy:` section and the parent/children ref fields. */
const HBOARD = `${BOARD.replace(
	"mfw: 1\n",
	"mfw: 1\nhierarchy: { parent: parent, children: children }\n",
)}\n      parent: { ref: task, optional: true }\n      children: { ref: task, list: true, optional: true }`;

const dirs: string[] = [];
async function tmp(): Promise<string> {
	const d = await realpath(await mkdtemp(join(tmpdir(), "mfwb-wf-")));
	dirs.push(d);
	return d;
}
afterEach(async () => {
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function mfwb(cwd: string, args: string[]) {
	const e: Record<string, string | undefined> = { ...process.env };
	delete e.MFW_BOARD;
	const p = Bun.spawn(["bun", "run", CLI, ...args], {
		cwd,
		env: e,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(p.stdout).text(),
		new Response(p.stderr).text(),
		p.exited,
	]);
	return { stdout: stdout.trim(), stderr: stderr.trim(), code };
}

interface Seed {
	title: string;
	status?: string;
	deps?: string[];
	agent?: string;
	parent?: string;
}

/** Creates TK-1..TK-n in order. */
async function board(seeds: Seed[], boardYaml = BOARD): Promise<string> {
	const d = await tmp();
	await mkdir(d, { recursive: true });
	await writeFile(join(d, "board.yaml"), boardYaml);
	for (const s of seeds) {
		const args = ["create", `title=${s.title}`, `status=${s.status ?? "todo"}`];
		if (s.deps) args.push(`depends_on=${s.deps.join(",")}`);
		if (s.agent) args.push(`agent=${s.agent}`);
		if (s.parent) args.push(`parent=${s.parent}`);
		const r = await mfwb(d, args);
		expect(r.code).toBe(0);
	}
	return d;
}

// TK-1 done, TK-2 todo (dep TK-1) ready, TK-3 todo (dep TK-2) not ready,
// TK-4 doing, TK-5 parked, TK-6 todo (dep TK-5) not ready, TK-7 todo no deps.
const SEEDS: Seed[] = [
	{ title: "one", status: "done" },
	{ title: "two", deps: ["TK-1"], agent: "alice" },
	{ title: "three", deps: ["TK-2"] },
	{ title: "four", status: "doing" },
	{ title: "five", status: "parked" },
	{ title: "six", deps: ["TK-5"] },
	{ title: "seven" },
];

// TK-1 (todo) has children TK-2 (done) and TK-3 (todo); TK-3 has child TK-4
// (todo); TK-5 stands alone.
const TREE: Seed[] = [
	{ title: "root" },
	{ title: "c1", status: "done", parent: "TK-1" },
	{ title: "c2", parent: "TK-1" },
	{ title: "g1", parent: "TK-3" },
	{ title: "alone" },
];

describe("ready", () => {
	test("lists only queued + unblocked, sorted, with columns", async () => {
		const d = await board(SEEDS);
		const r = await mfwb(d, ["ready"]);
		expect(r.code).toBe(0);
		expect(r.stdout.split("\n")).toEqual([
			"TK-2 todo deps: TK-1 | alice -",
			"TK-7 todo deps: - | - -",
		]);
	});

	test("--json shape", async () => {
		const d = await board(SEEDS);
		const r = await mfwb(d, ["ready", "--json"]);
		const rows = JSON.parse(r.stdout) as Record<string, unknown>[];
		// every declared field rides along, so callers can filter on any of them
		expect(rows.map(({ fields, unblocks, chain, ...rest }) => rest)).toEqual([
			{
				id: "TK-2",
				type: "task",
				status: "todo",
				dependsOn: ["TK-1"],
				columns: { agent: "alice", area: null },
			},
			{
				id: "TK-7",
				type: "task",
				status: "todo",
				dependsOn: [],
				columns: { agent: null, area: null },
			},
		]);
		// TK-2 frees TK-3 (which TK-4 and the rest wait behind)
		expect(rows[0]).toMatchObject({ unblocks: 1, chain: 1 });
		expect((rows[0]?.fields as Record<string, unknown>).title).toBe("two");
		expect((rows[0]?.fields as Record<string, unknown>).agent).toBe("alice");
	});

	test("field filters work like list's: field=a|b and field~a|b", async () => {
		const d = await board(SEEDS);
		expect((await mfwb(d, ["ready", "agent=alice"])).stdout).toBe(
			"TK-2 todo deps: TK-1 | alice -",
		);
		expect((await mfwb(d, ["ready", "agent=alice|bob"])).stdout).toContain(
			"TK-2",
		);
		expect((await mfwb(d, ["ready", "agent=nobody"])).stdout).toBe("");
		const j = await mfwb(d, ["ready", "--json", "title=seven"]);
		expect((JSON.parse(j.stdout) as { id: string }[]).map((r) => r.id)).toEqual(
			["TK-7"],
		);
	});

	test("a bare number for a keyed id gets a did-you-mean hint", async () => {
		const d = await board(SEEDS);
		const r = await mfwb(d, ["show", "2"]);
		expect(r.code).toBe(1);
		expect(r.stderr).toBe("task '2' not found (did you mean TK-2?)");
		expect((await mfwb(d, ["show", "99"])).stderr).toBe("task '99' not found");
	});

	test("--type restricts candidates; unknown type fails", async () => {
		const d = await board(SEEDS);
		expect((await mfwb(d, ["ready", "--type", "task"])).stdout).toContain(
			"TK-2",
		);
		const r = await mfwb(d, ["ready", "--type", "nope"]);
		expect(r.code).toBe(2);
	});

	test("empty result is exit 0 with no output", async () => {
		const d = await board([{ title: "x", status: "done" }]);
		const r = await mfwb(d, ["ready"]);
		expect(r).toEqual({ stdout: "", stderr: "", code: 0 });
	});

	test("no statusClasses: exit 2 with explanation", async () => {
		const plain = [
			"mfw: 1",
			"types:",
			"  task:",
			"    layout: flat",
			"    dir: tasks",
			"    id: { strategy: own-sequence, key: TK }",
			"    fields:",
			"      title: {}",
			"      status: { values: [todo, done], default: todo }",
		].join("\n");
		const d = await board([], plain);
		const r = await mfwb(d, ["ready"]);
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("statusClasses");
	});

	test("--under without hierarchy errors clearly", async () => {
		const d = await board(SEEDS);
		const r = await mfwb(d, ["ready", "--under", "TK-1"]);
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("hierarchy");
	});

	test("--under limits to descendants", async () => {
		const d = await board(TREE, HBOARD);
		const all = await mfwb(d, ["ready"]);
		expect(all.stdout.split("\n").map((l) => l.split(" ")[0])).toEqual([
			"TK-4",
			"TK-5",
		]);
		const r = await mfwb(d, ["ready", "--under", "TK-1"]);
		expect(r.code).toBe(0);
		expect(r.stdout.split("\n").map((l) => l.split(" ")[0])).toEqual(["TK-4"]);
		expect((await mfwb(d, ["ready", "--under", "TK-99"])).code).toBe(2);
	});

	test("a parent is ready only once all its children are terminal", async () => {
		const d = await board(TREE, HBOARD);
		const ids = async () =>
			(await mfwb(d, ["ready"])).stdout
				.split("\n")
				.map((l) => l.split(" ")[0])
				.filter(Boolean);
		expect(await ids()).toEqual(["TK-4", "TK-5"]);
		await mfwb(d, ["update", "TK-4", "status=done"]);
		expect(await ids()).toEqual(["TK-3", "TK-5"]);
		await mfwb(d, ["update", "TK-3", "status=done"]);
		expect(await ids()).toEqual(["TK-1", "TK-5"]);
	});

	test("a child depending on its own parent is a cycle", async () => {
		const d = await board(TREE, HBOARD);
		const u = await mfwb(d, ["update", "TK-3", "depends_on=TK-1"]);
		expect(u.code).toBe(0);
		const v = await mfwb(d, ["validate"]);
		expect(v.code).toBe(14);
		expect(v.stdout).toContain("dependency cycle");
		const c = await mfwb(d, ["ready", "--check"]);
		expect(c.code).toBe(1);
		expect(c.stderr).toContain("blocked");
	});

	test("--check: parked dependency blocks a live document", async () => {
		const d = await board(SEEDS);
		const r = await mfwb(d, ["ready", "--check"]);
		expect(r.code).toBe(1);
		expect(r.stderr).toBe("blocked TK-6: unresolved dependencies TK-5");
		const j = await mfwb(d, ["ready", "--check", "--json"]);
		expect(j.code).toBe(1);
		expect(JSON.parse(j.stdout)).toEqual({
			blocked: { "TK-6": ["TK-5"] },
			ok: false,
		});
	});

	test("--check: dangling dependency is reported", async () => {
		const d = await board([{ title: "a" }, { title: "b" }]);
		await writeFile(
			join(d, "tasks", "TK-2.md"),
			(await Bun.file(join(d, "tasks", "TK-2.md")).text()).replace(
				/^---\n/,
				"---\ndepends_on: [TK-99]\n",
			),
		);
		const r = await mfwb(d, ["ready", "--check"]);
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("blocked TK-2: unresolved dependencies TK-99");
	});

	test("--check: healthy board", async () => {
		const d = await board([
			{ title: "a", status: "done" },
			{ title: "b", deps: ["TK-1"] },
			{ title: "c", deps: ["TK-2"] },
		]);
		const r = await mfwb(d, ["ready", "--check"]);
		expect(r.code).toBe(0);
		expect(r.stdout).toBe(
			"Queue liveness: 2 live documents, all remaining reachable",
		);
		const j = await mfwb(d, ["ready", "--check", "--json"]);
		expect(JSON.parse(j.stdout)).toEqual({ blocked: {}, ok: true });
	});
});

describe("levels", () => {
	test("md table sorted by level then id", async () => {
		const d = await board(SEEDS);
		const r = await mfwb(d, ["levels"]);
		expect(r.code).toBe(0);
		expect(r.stdout.split("\n")).toEqual([
			"| id | level | status | title |",
			"| --- | --- | --- | --- |",
			"| TK-1 | 0 | done | one |",
			"| TK-4 | 0 | doing | four |",
			"| TK-5 | 0 | parked | five |",
			"| TK-7 | 0 | todo | seven |",
			"| TK-2 | 1 | todo | two |",
			"| TK-6 | 1 | todo | six |",
			"| TK-3 | 2 | todo | three |",
		]);
	});

	test("tsv and json formats", async () => {
		const d = await board(SEEDS);
		const t = await mfwb(d, ["levels", "--format", "tsv"]);
		const lines = t.stdout.split("\n");
		expect(lines[0]).toBe("id\tlevel\tstatus\ttitle");
		expect(lines.at(-1)).toBe("TK-3\t2\ttodo\tthree");
		const j = JSON.parse(
			(await mfwb(d, ["levels", "--format", "json"])).stdout,
		);
		expect(j[0]).toEqual({
			id: "TK-1",
			level: 0,
			status: "done",
			title: "one",
		});
		expect(j).toHaveLength(7);
		expect((await mfwb(d, ["levels", "--format", "xml"])).code).toBe(2);
	});

	test("--under limits rows to descendants", async () => {
		const d = await board(TREE, HBOARD);
		const r = await mfwb(d, ["levels", "--under", "TK-1", "--format", "tsv"]);
		expect(r.code).toBe(0);
		expect(r.stdout.split("\n")).toEqual([
			"id\tlevel\tstatus\ttitle",
			"TK-2\t0\tdone\tc1",
			"TK-4\t0\ttodo\tg1",
			"TK-3\t1\ttodo\tc2",
		]);
	});
});

describe("view", () => {
	test("board counts per type and status, with class and total", async () => {
		const d = await board(SEEDS);
		const r = await mfwb(d, ["view", "board"]);
		expect(r.code).toBe(0);
		expect(r.stdout.split("\n")).toEqual([
			"| type | status | class | count |",
			"| --- | --- | --- | --- |",
			"| task | doing | live | 1 |",
			"| task | done | terminal | 1 |",
			"| task | parked | parked | 1 |",
			"| task | todo | live | 4 |",
			"| total |  |  | 7 |",
		]);
	});

	test("tsv, json, --type", async () => {
		const d = await board(SEEDS);
		const t = await mfwb(d, ["view", "board", "--format", "tsv"]);
		expect(t.stdout.split("\n")[0]).toBe("type\tstatus\tclass\tcount");
		const j = JSON.parse(
			(await mfwb(d, ["view", "board", "--type", "task", "--format", "json"]))
				.stdout,
		);
		expect(j.at(-1)).toEqual({
			type: "total",
			status: "",
			class: "",
			count: 7,
		});
	});

	test("--under without hierarchy errors; unknown view exits 2", async () => {
		const d = await board(SEEDS);
		const u = await mfwb(d, ["view", "board", "--under", "TK-1"]);
		expect(u.code).toBe(2);
		expect(u.stderr).toContain("hierarchy");
		const r = await mfwb(d, ["view", "nope"]);
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("valid views: board");
	});

	test("--under counts descendants", async () => {
		const d = await board(TREE, HBOARD);
		const r = await mfwb(d, ["view", "board", "--under", "TK-1"]);
		expect(r.code).toBe(0);
		expect(r.stdout.split("\n")).toEqual([
			"| type | status | class | count |",
			"| --- | --- | --- | --- |",
			"| task | done | terminal | 1 |",
			"| task | todo | live | 2 |",
			"| total |  |  | 3 |",
		]);
	});
});
