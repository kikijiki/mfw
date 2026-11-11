import { afterEach, describe, expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMfwProject } from "../src/project.ts";

/** Load, edge-case and fuzz tests. Generous time bounds: they catch O(n^2)
 * regressions (repair once took minutes on 1,200 cards), not machine noise. */

const CLI = join(import.meta.dir, "../src/cli.ts");

const BOARD = [
	"mfw: 1",
	"hierarchy: { parent: parent, children: children }",
	"types:",
	"  task:",
	"    layout: flat",
	"    dir: tasks",
	"    id: { strategy: own-sequence, key: TK }",
	"    fields:",
	"      title: {}",
	"      status: { values: [backlog, done], default: backlog }",
	"      parent: { ref: task, optional: true }",
	"      children: { ref: task, list: true, optional: true }",
	"      depends_on: { ref: task, list: true, optional: true }",
	"      tags: { list: true, optional: true }",
].join("\n");

const dirs: string[] = [];
async function tmp(): Promise<string> {
	const d = await realpath(await mkdtemp(join(tmpdir(), "mfwb-stress-")));
	dirs.push(d);
	await writeFile(join(d, "board.yaml"), BOARD);
	await mkdir(join(d, "tasks"));
	return d;
}
afterEach(async () => {
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function mfwb(cwd: string, args: string[], stdin?: string) {
	const p = Bun.spawn(["bun", "run", CLI, ...args], {
		cwd,
		stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
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

/** Write `n` cards straight to disk: TK-1.. as epics of ~`fan` children each,
 * with a dependency chain between siblings. `children` lists are correct. */
async function generate(dir: string, n: number, fan = 25): Promise<void> {
	const epics = Math.ceil(n / (fan + 1));
	const kids = new Map<number, number[]>();
	let id = epics;
	for (let e = 1; e <= epics && id < n; e++) {
		const list: number[] = [];
		for (let k = 0; k < fan && id < n; k++) list.push(++id);
		kids.set(e, list);
	}
	const writes: Promise<void>[] = [];
	for (let i = 1; i <= n; i++) {
		const parent = [...kids].find(([, l]) => l.includes(i))?.[0];
		const children = kids.get(i);
		const lines = [
			"---",
			"mfw: 1",
			`id: TK-${i}`,
			"rev: 1",
			`title: card ${i}`,
		];
		if (parent) lines.push(`parent: TK-${parent}`);
		if (children)
			lines.push(`children: [${children.map((c) => `TK-${c}`).join(", ")}]`);
		if (parent && i > (kids.get(parent)?.[0] ?? 0))
			lines.push(`depends_on: [TK-${i - 1}]`);
		lines.push("---", "", `body of ${i}`, "");
		writes.push(writeFile(join(dir, "tasks", `TK-${i}.md`), lines.join("\n")));
	}
	await Promise.all(writes);
}

describe("load", () => {
	test("repair on a consistent 1500-card board is a fast no-op", async () => {
		const d = await tmp();
		await generate(d, 1500);
		const t0 = performance.now();
		const r = await mfwb(d, ["repair"]);
		const ms = performance.now() - t0;
		expect(r.stdout).toBe("nothing to repair");
		expect(ms).toBeLessThan(8000);
	}, 60_000);

	test("repair fixes only the parents whose lists were damaged", async () => {
		const d = await tmp();
		await generate(d, 600);
		const p = join(d, "tasks", "TK-3.md");
		await writeFile(
			p,
			(await readFile(p, "utf8")).replace(
				/children: \[.*\]\n/,
				"children: [TK-1]\n",
			),
		);
		const r = await mfwb(d, ["repair", "--json"]);
		const out = JSON.parse(r.stdout) as { repaired: { id: string }[] };
		expect(out.repaired.map((c) => c.id)).toEqual(["TK-3"]);
		expect((await mfwb(d, ["repair"])).stdout).toBe("nothing to repair");
	}, 60_000);

	test("list and check finish on 1500 cards", async () => {
		const d = await tmp();
		await generate(d, 1500);
		for (const cmd of [["list"], ["check", "--board-only"]]) {
			const t0 = performance.now();
			const r = await mfwb(d, cmd);
			expect(r.code === 0 || r.code === 1).toBe(true);
			expect(performance.now() - t0).toBeLessThan(20_000);
		}
	}, 120_000);

	test("parallel creates under one parent keep children exact", async () => {
		const d = await tmp();
		await mfwb(d, ["create", "title=epic"]);
		const runs = await Promise.all(
			Array.from({ length: 12 }, (_, i) =>
				mfwb(d, ["create", `title=k${i}`, "parent=TK-1"]),
			),
		);
		expect(runs.every((r) => r.code === 0)).toBe(true);
		const kids = JSON.parse((await mfwb(d, ["show", "--json", "TK-1"])).stdout);
		expect(JSON.stringify(kids)).toContain("TK-13");
		expect((await mfwb(d, ["repair"])).stdout).toBe("nothing to repair");
	}, 120_000);
});

describe("edge cases", () => {
	test("hostile titles, huge bodies and wide list fields round-trip", async () => {
		const d = await tmp();
		const titles = [
			"colon: hash # quote ' dq \" --- end",
			"émoji 🚀 日本語 \u0000x".replace("\u0000", ""),
			"- leading dash",
			"[bracket] {brace} | pipe > gt",
			"x".repeat(5000),
			"true",
			"123",
			"null",
		];
		for (const title of titles) {
			const r = await mfwb(d, ["create", "--", `title=${title}`]);
			expect(r.code).toBe(0);
		}
		for (let i = 0; i < titles.length; i++) {
			const doc = JSON.parse(
				(await mfwb(d, ["show", "--json", `TK-${i + 1}`])).stdout,
			);
			expect(JSON.stringify(doc)).toContain(
				JSON.stringify(titles[i]).slice(1, -1),
			);
		}
		const body = `${"line ---\n".repeat(20_000)}\n---\nfrontmatter lookalike\n`;
		const big = await mfwb(
			d,
			["create", "title=big", "--body-file", "-"],
			body,
		);
		expect(big.code).toBe(0);
		const shown = await mfwb(d, ["show", "TK-9"]);
		expect(shown.stdout).toContain("frontmatter lookalike");
		const tags = Array.from({ length: 300 }, (_, i) => `t${i}`).join(",");
		expect((await mfwb(d, ["create", "title=tags", `tags=${tags}`])).code).toBe(
			0,
		);
		const deps = Array.from({ length: 200 }, (_, i) => `TK-${(i % 9) + 1}`);
		expect(
			(
				await mfwb(d, [
					"create",
					"title=deps",
					`depends_on=${[...new Set(deps)].join(",")}`,
				])
			).code,
		).toBe(0);
	}, 120_000);

	test("--body-file errors, --help and delete refusals", async () => {
		const d = await tmp();
		await mfwb(d, ["create", "title=a"]);
		await mfwb(d, ["create", "title=b", "parent=TK-1", "depends_on=TK-1"]);
		expect(
			(await mfwb(d, ["create", "--body-file", "/nonexistent"])).code,
		).toBe(2);
		expect(
			(await mfwb(d, ["create", "--body", "x", "--body-file", "-"], "y")).code,
		).toBe(2);
		const help = await mfwb(d, ["create", "--help"]);
		expect(help.code).toBe(0);
		expect(help.stdout).toContain("--body-file");
		expect((await mfwb(d, ["--help"])).code).toBe(0);
		expect((await mfwb(d, ["delete", "TK-1"])).code).toBe(1); // has children
		expect((await mfwb(d, ["delete", "TK-9"])).code).toBe(1); // missing
		expect((await mfwb(d, ["delete", "TK-2"])).code).toBe(0);
		expect((await mfwb(d, ["delete", "TK-1"])).code).toBe(0);
		expect((await mfwb(d, ["list"])).stdout).toBe("");
	}, 60_000);

	test("delete refuses a card another card depends on", async () => {
		const d = await tmp();
		await mfwb(d, ["create", "title=a"]);
		await mfwb(d, ["create", "title=b", "depends_on=TK-1"]);
		const r = await mfwb(d, ["delete", "TK-1"]);
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("TK-2");
		expect((await mfwb(d, ["list"])).stdout.split("\n").length).toBe(2);
	}, 60_000);
});

describe("fuzz", () => {
	/** Seeded PRNG so a failure reproduces. */
	function rng(seed: number) {
		let s = seed >>> 0;
		return () => {
			s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
			return s / 2 ** 32;
		};
	}

	for (const seed of [1, 2, 3]) {
		test(`random create/reparent/delete/update keeps the hierarchy consistent (seed ${seed})`, async () => {
			const d = await tmp();
			const { store } = await openMfwProject(d);
			const rand = rng(seed);
			const live = new Set<string>();
			const pick = () => [...live][Math.floor(rand() * live.size)];
			for (let step = 0; step < 150; step++) {
				const op = rand();
				try {
					if (op < 0.4 || live.size < 3) {
						const parent = live.size > 0 && rand() < 0.7 ? pick() : undefined;
						const doc = await store.createDocument("task", {
							fields: { title: `t${step}`, ...(parent ? { parent } : {}) },
						});
						live.add(doc.id);
					} else if (op < 0.65) {
						const id = pick() as string;
						const p = rand() < 0.2 ? "" : pick();
						await store.setParent("task", id, p || null);
					} else if (op < 0.85) {
						const id = pick() as string;
						if (await store.deleteDocument("task", id)) live.delete(id);
					} else {
						await store.updateDocument("task", pick() as string, {
							fields: { tags: [`x${step}`, "a b", "c:d"] },
						});
					}
				} catch {
					// refused ops (cycle, has-children, ...) are expected; they must not corrupt
				}
			}
			expect(await store.repairHierarchy()).toEqual([]);
			const issues = await store.validate();
			expect(
				issues.filter((i) =>
					/child|parent|hierarch|cycle/i.test(JSON.stringify(i)),
				),
			).toEqual([]);
		}, 120_000);
	}
});
