import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "../src/cli.ts");

const BOARD = [
	"mfw: 1",
	"hierarchy: { parent: parent, children: children }",
	"roots:",
	"  code: ./no-such-code-dir",
	"refs:",
	"  - { id: held, root: code, paths: ['**/*.rs'], pattern: 'held for (?<id>TK-\\d+)', to: task }",
	"types:",
	"  task:",
	"    layout: flat",
	"    dir: tasks",
	"    id: { strategy: own-sequence, key: TK }",
	"    fields:",
	"      title: {}",
	"      parent: { ref: task, optional: true }",
	"      children: { ref: task, list: true, optional: true }",
	"      depends_on: { ref: task, list: true, optional: true }",
].join("\n");

const dirs: string[] = [];
afterEach(async () => {
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function mfwb(cwd: string, args: string[]) {
	const p = Bun.spawn([process.execPath, "run", CLI, ...args], {
		cwd,
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

async function board(): Promise<string> {
	const d = await realpath(await mkdtemp(join(tmpdir(), "mfwb-under-")));
	dirs.push(d);
	await writeFile(join(d, "board.yaml"), BOARD);
	await mkdir(join(d, "tasks"));
	const doc = (id: string, extra: string) =>
		writeFile(
			join(d, "tasks", `${id}.md`),
			`---\nmfw: 1\nid: ${id}\nrev: 1\ntitle: ${id}\n${extra}---\n`,
		);
	await doc("TK-1", "children: [TK-2]\n");
	await doc("TK-2", "parent: TK-1\ndepends_on: [TK-77]\n"); // dangling dep inside the subtree
	await doc("TK-3", "depends_on: [TK-88]\n"); // dangling dep outside it
	return d;
}

describe("check --under", () => {
	test("reports exactly the full run's issues on the subtree", async () => {
		const d = await board();
		const full = await mfwb(d, ["check", "--board-only", "--json"]);
		const under = await mfwb(d, ["check", "--under", "TK-1", "--json"]);
		const inSubtree = (
			JSON.parse(full.stdout).issues as { id: string | null }[]
		).filter((i) => i.id === "TK-1" || i.id === "TK-2");
		expect(inSubtree.length).toBeGreaterThan(0);
		expect(JSON.parse(under.stdout).issues).toEqual(inSubtree);
		expect(under.code).toBe(1);
	});

	test("does not touch the refs roots, so a missing root cannot fail it", async () => {
		const d = await board();
		const whole = await mfwb(d, ["check"]);
		expect(whole.code).toBe(3); // the refs root is missing
		const under = await mfwb(d, ["check", "--under", "TK-1", "--json"]);
		expect(under.code).toBe(1); // the dangling dependency, not the environment
		expect(JSON.parse(under.stdout).scans).toBeUndefined();
	});

	test("says so when the selected rules are all refs rules", async () => {
		const d = await board();
		const r = await mfwb(d, ["check", "--under", "TK-1", "--rule", "held"]);
		expect(r.code).toBe(0);
		expect(r.stderr).toContain("skips them");
	});

	test("a bad --under or id fails fast with exit 2", async () => {
		const d = await board();
		expect((await mfwb(d, ["check", "--under", "TK-404"])).code).toBe(2);
		expect((await mfwb(d, ["check", "TK-404", "--board-only"])).code).toBe(2);
	});
});
