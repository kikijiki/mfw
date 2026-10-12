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
	const d = await realpath(await mkdtemp(join(tmpdir(), "mfwb-chk-")));
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

const CONFLICTING: Seed[] = [
	{ title: "a", owns: ["src/x/**"] },
	{ title: "b", owns: ["src/x/y.ts"] },
];

describe("check command", () => {
	test("--list shows every rule with severity and what it reads", async () => {
		const d = await board([]);
		const r = await mfwb(d, ["check", "--list", "--json"]);
		expect(r.code).toBe(0);
		const rules = JSON.parse(r.stdout) as { id: string; severity: string }[];
		const byId = new Map(rules.map((x) => [x.id, x.severity]));
		expect(byId.get("cycle")).toBe("error");
		expect(byId.get("conflicts")).toBe("configurable");
		expect(byId.get("inert-exemption")).toBe("advisory");
	});

	test("an unknown --rule is a usage error naming the rules", async () => {
		const d = await board([]);
		const r = await mfwb(d, ["check", "--rule", "nope"]);
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("unknown rule 'nope'");
		expect(r.stderr).toContain("unreachable");
	});

	test("an unknown id is a usage error", async () => {
		const d = await board([{ title: "a" }]);
		expect((await mfwb(d, ["check", "TK-99"])).code).toBe(2);
	});

	test("<id> keeps issues about, or involving, that document", async () => {
		const d = await board([...CONFLICTING, { title: "c" }]);
		const b = await mfwb(d, ["check", "TK-2"]);
		expect(b.code).toBe(1); // TK-2 is the other side of TK-1's conflict
		const c = await mfwb(d, ["check", "TK-3"]);
		expect(c.code).toBe(0);
		expect(c.stdout).toBe("ok");
	});

	test("builtins severity: advisory prints but passes, --strict fails, off hides", async () => {
		const advisory = BOARD.replace(
			"types:",
			"builtins: { conflicts: advisory }\ntypes:",
		);
		const d = await board(CONFLICTING, "pairs: []\n", advisory);
		const r = await mfwb(d, ["check"]);
		expect(r.code).toBe(0);
		expect(r.stdout).toContain("advisory conflicts task TK-1");
		expect(r.stdout).toContain("ok: 1 advisory issue(s)");
		expect((await mfwb(d, ["check", "--strict"])).code).toBe(1);

		const off = BOARD.replace("types:", "builtins: { conflicts: off }\ntypes:");
		const o = await board(CONFLICTING, "pairs: []\n", off);
		const r2 = await mfwb(o, ["check"]);
		expect(r2.code).toBe(0);
		expect(r2.stdout).toBe("ok");
	});

	test("an invalid builtins value is a board error", async () => {
		const bad = BOARD.replace(
			"types:",
			"builtins: { conflicts: loud }\ntypes:",
		);
		const d = await board([], "pairs: []\n", bad);
		expect((await mfwb(d, ["check"])).code).toBe(3);
	});

	test("rules that do not apply are skipped: no ownership, no status classes", async () => {
		const plain = [
			"mfw: 1",
			"types:",
			"  note:",
			"    layout: flat",
			"    dir: notes",
			"    id: { strategy: own-sequence, key: NT }",
			"    fields:",
			"      title: {}",
		].join("\n");
		const d = await board([], undefined, plain);
		const r = await mfwb(d, ["check"]);
		expect(r.code).toBe(0);
		expect(r.stdout).toBe("ok");
	});

	test("a missing exemptions file is an issue, not a crash", async () => {
		const d = await board([{ title: "a" }]);
		await rm(join(d, "shares.yaml"));
		const r = await mfwb(d, ["check"]);
		expect(r.code).toBe(1);
		expect(r.stdout).toContain("error exemptions");
	});
});
