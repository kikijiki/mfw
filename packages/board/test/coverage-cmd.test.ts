import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "../src/cli.ts");

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

const YAML = [
	"mfw: 1",
	"coverage:",
	"  - id: ledger",
	"    source: ledger.tsv",
	"    id_column: id",
	"    open_when: { column: resolution, equals: open }",
	"    alias_column: merged",
	"    alias_none: '-'",
	"    waivers: { file: waived.tsv, id_column: id }",
	"    closed_by: { type: task, field: closes, status: [todo, doing, done] }",
	"    referenced_by: { type: task, field: contributes }",
	"types:",
	"  task:",
	"    layout: flat",
	"    dir: tasks",
	"    id: { strategy: own-sequence, key: TK }",
	"    fields:",
	"      title: {}",
	"      status: { values: [todo, doing, done, dropped], default: todo }",
	"      closes: { type: string, list: true, optional: true }",
	"      contributes: { type: string, list: true, optional: true }",
].join("\n");

const LEDGER =
	"id\tmerged\tresolution\nR1\tR9\topen\nR2\t-\topen\nR3\t-\tfixed\n";

async function setup(
	cards: [string, string][],
	opts: { ledger?: string; waived?: string; yaml?: string } = {},
) {
	const d = await realpath(await mkdtemp(join(tmpdir(), "mfwb-cov-")));
	dirs.push(d);
	await writeFile(join(d, "board.yaml"), opts.yaml ?? YAML);
	if (opts.ledger !== "")
		await writeFile(join(d, "ledger.tsv"), opts.ledger ?? LEDGER);
	await writeFile(join(d, "waived.tsv"), opts.waived ?? "id\treason\n");
	for (const [i, [closes, status]] of cards.entries()) {
		const args = ["create", `title=c${i + 1}`, `status=${status}`];
		if (closes) args.push(`closes=${closes}`);
		expect((await mfwb(d, args)).code).toBe(0);
	}
	return d;
}

describe("coverage", () => {
	test("covered ledger is clean and says what it checked", async () => {
		const d = await setup([
			["R9", "todo"],
			["R2", "done"],
		]);
		const r = await mfwb(d, ["check"]);
		expect(r.code).toBe(0);
		expect(r.stdout).toContain(
			"coverage ledger: 2 open of 3 row(s), 2 covered, 0 waived",
		);
	});

	test("an uncovered row is an error at its table line", async () => {
		const d = await setup([["R9", "todo"]]);
		const r = await mfwb(d, ["check"]);
		expect(r.code).toBe(1);
		expect(r.stdout).toContain(
			"error ledger ledger.tsv:3: R2 is closed by no document, expected exactly 1",
		);
	});

	test("a dropped closer does not count; a waiver covers; an unknown id is an issue", async () => {
		const d = await setup(
			[
				["R9", "dropped"],
				["R404", "todo"],
			],
			{
				waived: "id\treason\nR1\tlater\nR2\tlater\n",
			},
		);
		const r = await mfwb(d, ["check", "--json"]);
		const issues = JSON.parse(r.stdout).issues as {
			message: string;
			severity: string;
		}[];
		expect(issues.map((i) => i.message)).toEqual([
			"closes names 'R404', which is not a row of ledger.tsv",
		]);
	});

	test("a missing table is exit 3, not an issue", async () => {
		const d = await setup([["R9", "todo"]], { ledger: "" });
		const r = await mfwb(d, ["check"]);
		expect(r.code).toBe(3);
		expect(r.stderr).toContain("ledger.tsv");
	});

	test("config errors: a closer field that is not a string list, unknown status", async () => {
		const a = await setup([], {
			yaml: YAML.replace("field: closes,", "field: title,"),
		});
		expect((await mfwb(a, ["check"])).code).toBe(3);
		const b = await setup([], {
			yaml: YAML.replace("[todo, doing, done]", "[todo, nope]"),
		});
		expect((await mfwb(b, ["check"])).code).toBe(3);
	});
});
