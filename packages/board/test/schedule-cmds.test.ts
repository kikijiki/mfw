import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
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
	"    ownership: { field: owns, exemptions: shares.yaml }",
	"    statusClasses:",
	"      terminal: [done]",
	"      live: [todo, doing]",
	"      queued: [todo]",
	"    fields:",
	"      title: {}",
	"      status: { values: [todo, doing, done], default: todo }",
	"      depends_on: { ref: task, list: true, optional: true }",
	"      owns: { type: string, list: true, optional: true }",
].join("\n");

const dirs: string[] = [];
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
	owns?: string[];
}

async function board(
	seeds: Seed[],
	shares: string | undefined = "pairs: []\n",
	yaml = BOARD,
) {
	const d = await realpath(await mkdtemp(join(tmpdir(), "mfwb-sch-")));
	dirs.push(d);
	await writeFile(join(d, "board.yaml"), yaml);
	if (shares !== undefined) await writeFile(join(d, "shares.yaml"), shares);
	for (const s of seeds) {
		const args = ["create", `title=${s.title}`, `status=${s.status ?? "todo"}`];
		if (s.deps) args.push(`depends_on=${s.deps.join(",")}`);
		if (s.owns) args.push(`owns=${s.owns.join(",")}`);
		expect((await mfwb(d, args)).code).toBe(0);
	}
	return d;
}

// TK-1 done; TK-2 ready (dep 1) unblocks 3,4; TK-3, TK-4 wait on 2; TK-5 doing; TK-6 ready.
const SEEDS: Seed[] = [
	{ title: "one", status: "done" },
	{ title: "two", deps: ["TK-1"], owns: ["src/a/**"] },
	{ title: "three", deps: ["TK-2"] },
	{ title: "four", deps: ["TK-2"] },
	{ title: "five", status: "doing", owns: ["src/z/**"] },
	{ title: "six", owns: ["src/z/file.ts"] }, // overlaps the one in progress
];

describe("graph", () => {
	test("mermaid by default, dot and json on request, finished hidden unless --all", async () => {
		const d = await board(SEEDS);
		const m = await mfwb(d, ["graph"]);
		expect(m.code).toBe(0);
		expect(m.stdout).toContain("graph LR");
		expect(m.stdout).toContain("TK_2 --> TK_3");
		expect(m.stdout).not.toContain("TK_1[");
		expect((await mfwb(d, ["graph", "--all"])).stdout).toContain("TK_1[");
		expect((await mfwb(d, ["graph", "--format", "dot"])).stdout).toContain(
			'"TK-2" -> "TK-3"',
		);
		const j = JSON.parse((await mfwb(d, ["graph", "--json"])).stdout);
		expect(j.nodes.map((n: { id: string }) => n.id)).toEqual([
			"TK-2",
			"TK-3",
			"TK-4",
			"TK-5",
			"TK-6",
		]);
		expect((await mfwb(d, ["graph", "--format", "svg"])).code).toBe(2);
	});
});

describe("ready --unblocks", () => {
	test("shows how much each ready document frees; json always carries it", async () => {
		const d = await board(SEEDS);
		const r = await mfwb(d, ["ready", "--unblocks"]);
		expect(r.stdout.split("\n")).toEqual([
			"TK-2 todo deps: TK-1 unblocks: 2",
			"TK-6 todo deps: - unblocks: 0",
		]);
		const j = JSON.parse((await mfwb(d, ["ready", "--json"])).stdout);
		expect(j[0]).toMatchObject({ id: "TK-2", unblocks: 2, chain: 1 });
	});
});

describe("plan", () => {
	test("picks by impact and skips what collides with work in progress", async () => {
		const d = await board(SEEDS);
		const r = await mfwb(d, ["plan"]);
		expect(r.code).toBe(0);
		expect(r.stdout).toContain("start together (1):");
		expect(r.stdout).toContain(
			"TK-2  unblocks 2, chain 1 scope: src/a/**  two",
		);
		expect(r.stdout).toContain(
			"TK-6: overlaps TK-5 (in progress) on src/z/file.ts ~ src/z/**",
		);
		expect(r.stdout).toContain("in progress: TK-5");
		const j = JSON.parse((await mfwb(d, ["plan", "--json"])).stdout);
		expect(j.picked.map((p: { id: string }) => p.id)).toEqual(["TK-2"]);
		expect(j.skipped[0].id).toBe("TK-6");
	});

	test("when nothing is ready it shows what the in-progress work is blocking", async () => {
		const d = await board([
			{ title: "a", status: "doing" },
			{ title: "b", deps: ["TK-1"] },
			{ title: "c", deps: ["TK-1"] },
			{ title: "d", deps: ["TK-2"] },
		]);
		const r = await mfwb(d, ["plan"]);
		expect(r.stdout).toContain("nothing to start");
		expect(r.stdout).toContain("blocking the most work:");
		expect(r.stdout).toContain(
			"TK-1: 3 waiting; ready once it finishes: TK-2, TK-3",
		);
		const j = JSON.parse((await mfwb(d, ["plan", "--json"])).stdout);
		expect(j.blockers).toEqual([
			{ id: "TK-1", unblocks: 3, next: ["TK-2", "TK-3"] },
		]);
	});

	test("--max caps the batch; an exemptions file lets a pair share files", async () => {
		const shares =
			"pairs:\n  - cards: [TK-5, TK-6]\n    paths: [src/z/**, src/z/file.ts]\n    ruling: agreed\n";
		const d = await board(SEEDS, shares);
		const r = await mfwb(d, ["plan"]);
		expect(r.stdout).toContain("start together (2):");
		const capped = await mfwb(d, ["plan", "--max", "1"]);
		expect(capped.stdout).toContain("TK-6: over --max 1");
		expect((await mfwb(d, ["plan", "--max", "x"])).code).toBe(2);
	});
});

describe("conflicts", () => {
	test("reports unordered overlaps among live documents and exits 1", async () => {
		const d = await board([
			{ title: "a", owns: ["src/x/**"] },
			{ title: "b", owns: ["src/x/y.ts"] },
			{ title: "c", owns: ["src/x/y.ts"], deps: ["TK-1"] }, // ordered after a: fine
		]);
		const r = await mfwb(d, ["conflicts"]);
		expect(r.code).toBe(1);
		expect(r.stdout).toContain("TK-1 <-> TK-2: src/x/** ~ src/x/y.ts");
		expect(r.stdout).not.toContain("TK-1 <-> TK-3");
		const j = JSON.parse((await mfwb(d, ["conflicts", "--json"])).stdout);
		expect(j.ok).toBe(false);
		expect(j.conflicts.length).toBe(2);
	});

	test("exemptions remove conflicts, inert pairs are reported, clean board exits 0", async () => {
		const shares =
			"append_only: [src/registry.ts]\npairs:\n  - cards: [TK-1, TK-3]\n    paths: [src/x/**]\n";
		const d = await board(
			[
				{ title: "a", owns: ["src/registry.ts"] },
				{ title: "b", owns: ["src/registry.ts"] },
				{ title: "c", status: "done", owns: ["src/x/**"] },
			],
			shares,
		);
		const r = await mfwb(d, ["conflicts"]);
		expect(r.code).toBe(0);
		expect(r.stdout).toContain("protect nothing");
		expect(r.stdout).toContain("TK-1 <-> TK-3");
		expect(r.stdout).toContain(
			"ok: no unordered overlaps among 2 live documents",
		);
	});

	test("a board without ownership config exits 2 with how to add it", async () => {
		const yaml = BOARD.replace(
			"    ownership: { field: owns, exemptions: shares.yaml }\n",
			"",
		);
		const d = await board([{ title: "a" }], "", yaml);
		const r = await mfwb(d, ["conflicts"]);
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("ownership:");
	});
});

describe("exemptions file", () => {
	test("a declared but missing file is a board error (exit 3)", async () => {
		const d = await board(SEEDS);
		await rm(join(d, "shares.yaml"));
		const r = await mfwb(d, ["conflicts"]);
		expect(r.code).toBe(3);
		expect(r.stderr).toContain("shares.yaml");
	});
});

describe("validate and file scopes", () => {
	test("rejects an unusable glob and a bad exemptions file", async () => {
		const d = await board(
			[{ title: "a", owns: ["/abs/path"] }],
			"pairs:\n  - cards: [TK-1, TK-9]\n    paths: [a]\n",
		);
		const r = await mfwb(d, ["validate"]);
		expect(r.code).toBe(10);
		expect(r.stdout).toContain("owns '/abs/path'");
		expect(r.stdout).toContain("unknown id 'TK-9'");
	});

	test("a clean scoped board validates", async () => {
		const d = await board([{ title: "a", owns: ["src/**"] }], "pairs: []\n");
		expect((await mfwb(d, ["validate"])).code).toBe(0);
	});
});
