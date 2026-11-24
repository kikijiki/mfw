import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ambientEnv, runBoard } from "./support/board-run.ts";

const TASK_BOARD = [
	"mfw: 1",
	"types:",
	"  task:",
	"    layout: flat",
	"    dir: tasks",
	"    id: { strategy: own-sequence, key: TK }",
	"    fields:",
	"      title: {}",
	"      status: { values: [backlog, ready, done], default: backlog }",
	"      tags: { list: true, optional: true }",
].join("\n");

const ONE_TYPE_BOARD = TASK_BOARD.replace("  task:", "  note:");
const TWO_TYPE_BOARD = `${TASK_BOARD}\n  adr:\n    layout: flat\n    dir: adrs\n    id: { strategy: own-sequence, key: AD }\n    fields:\n      title: {}`;

const dirs: string[] = [];
async function tmp(): Promise<string> {
	const d = await realpath(await mkdtemp(join(tmpdir(), "mfw-board-cli-")));
	dirs.push(d);
	return d;
}
afterEach(async () => {
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function put(path: string, content: string): Promise<void> {
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, content);
}

function mfwBoard(
	cwd: string,
	args: string[],
	env: Record<string, string> = {},
) {
	const e = ambientEnv();
	Object.assign(e, env);
	return runBoard(cwd, args, { env: e });
}

describe("board discovery", () => {
	test("finds board.yaml in cwd and from a subdirectory", async () => {
		const d = await tmp();
		await put(join(d, "board.yaml"), TASK_BOARD);
		await mfwBoard(d, ["create", "title=a"]);
		await mkdir(join(d, "x", "y"), { recursive: true });
		const r = await mfwBoard(join(d, "x", "y"), ["list"]);
		expect(r.code).toBe(0);
		expect(r.stdout).toBe("TK-1\ttask");
	});

	test("a board.yaml under .mfw/ is not found, but can be named with --config", async () => {
		const d = await tmp();
		await put(join(d, ".mfw", "board.yaml"), TASK_BOARD);
		const r = await mfwBoard(d, ["list"]);
		expect(r.code).toBe(3);
		expect(r.stderr).toContain("no board found");
		const c = await mfwBoard(d, [
			"--config",
			join(d, ".mfw", "board.yaml"),
			"create",
			"title=a",
		]);
		expect(c.code).toBe(0);
		expect(await Bun.file(join(d, ".mfw", "tasks", "TK-1.md")).exists()).toBe(
			true,
		);
	});

	test("nearest board wins", async () => {
		const d = await tmp();
		await put(join(d, "board.yaml"), TASK_BOARD);
		await put(join(d, "inner", "board.yaml"), TASK_BOARD);
		await mfwBoard(d, ["create", "title=outer"]);
		await mkdir(join(d, "inner", "sub"), { recursive: true });
		const r = await mfwBoard(join(d, "inner", "sub"), ["list"]);
		expect(r.stdout).toBe("");
		const outer = await mfwBoard(d, ["list"]);
		expect(outer.stdout).toBe("TK-1\ttask");
	});

	test("--config (before or after the command) and MFW_BOARD", async () => {
		const d = await tmp();
		const other = await tmp();
		await put(join(other, "b", "board.yaml"), TASK_BOARD);
		const cfg = join(other, "b", "board.yaml");
		await mfwBoard(d, ["--config", cfg, "create", "title=a"]);
		expect((await mfwBoard(d, ["list", "--config", cfg])).stdout).toBe(
			"TK-1\ttask",
		);
		expect((await mfwBoard(d, ["list"], { MFW_BOARD: cfg })).stdout).toBe(
			"TK-1\ttask",
		);
	});

	test("--config beats MFW_BOARD, which beats the search", async () => {
		const d = await tmp();
		await put(join(d, "board.yaml"), TASK_BOARD);
		await put(join(d, "e1", "board.yaml"), TASK_BOARD);
		await put(join(d, "e2", "board.yaml"), TASK_BOARD);
		await mfwBoard(d, [
			"--config",
			join(d, "e1", "board.yaml"),
			"create",
			"title=a",
		]);
		const env = { MFW_BOARD: join(d, "e2", "board.yaml") };
		expect((await mfwBoard(d, ["list"], env)).stdout).toBe("");
		expect(
			(
				await mfwBoard(
					d,
					["list", "--config", join(d, "e1", "board.yaml")],
					env,
				)
			).stdout,
		).toBe("TK-1\ttask");
		expect((await mfwBoard(d, ["list"])).stdout).toBe("");
	});

	test("no board: error lists what was searched", async () => {
		const d = await tmp();
		const r = await mfwBoard(d, ["list"]);
		expect(r.code).toBe(3);
		expect(r.stderr).toContain("no board found");
		expect(r.stderr).toContain("board.yaml");
	});

	test("missing --config file errors", async () => {
		const d = await tmp();
		const r = await mfwBoard(d, ["list", "--config", join(d, "nope.yaml")]);
		expect(r.code).toBe(3);
		expect(r.stderr).toContain("does not exist");
	});
});

describe("--type defaulting", () => {
	test("task when present", async () => {
		const d = await tmp();
		await put(join(d, "board.yaml"), TWO_TYPE_BOARD);
		await mfwBoard(d, ["create", "title=a"]);
		expect((await mfwBoard(d, ["list"])).stdout).toBe("TK-1\ttask");
		await mfwBoard(d, ["create", "--type", "adr", "title=b"]);
		expect((await mfwBoard(d, ["list", "--type", "adr"])).stdout).toBe(
			"AD-1\tadr",
		);
	});

	test("the only type when exactly one", async () => {
		const d = await tmp();
		await put(join(d, "board.yaml"), ONE_TYPE_BOARD);
		expect((await mfwBoard(d, ["create", "title=a"])).code).toBe(0);
		expect((await mfwBoard(d, ["list"])).stdout).toBe("TK-1\tnote");
	});

	test("error asking for --type when ambiguous", async () => {
		const d = await tmp();
		await put(
			join(d, "board.yaml"),
			TWO_TYPE_BOARD.replace("  task:", "  note:"),
		);
		const r = await mfwBoard(d, ["list"]);
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("--type");
	});

	test("unknown --type errors", async () => {
		const d = await tmp();
		await put(join(d, "board.yaml"), TASK_BOARD);
		const r = await mfwBoard(d, ["list", "--type", "zzz"]);
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("unknown type");
	});
});

describe("generic commands", () => {
	test("create/show/update round trip", async () => {
		const d = await tmp();
		await put(join(d, "board.yaml"), TASK_BOARD);
		const c = await mfwBoard(d, [
			"create",
			"--body",
			"hello",
			"title=one",
			"tags=a,b",
		]);
		expect(c.code).toBe(0);
		expect(c.stdout).toContain("task TK-1 (rev 1)");
		const u = await mfwBoard(d, [
			"update",
			"TK-1",
			"--base-rev",
			"1",
			"status=ready",
		]);
		expect(u.code).toBe(0);
		const s = await mfwBoard(d, ["show", "TK-1", "--json"]);
		const j = JSON.parse(s.stdout);
		expect(j.id).toBe("TK-1");
		expect(j.fields.status).toBe("ready");
		expect(j.fields.tags).toEqual(["a", "b"]);
		expect(j.body).toContain("hello");
		const stale = await mfwBoard(d, [
			"update",
			"TK-1",
			"--base-rev",
			"1",
			"title=x",
		]);
		expect(stale.code).toBe(1);
		expect((await mfwBoard(d, ["show", "TK-9"])).code).toBe(1);
		expect(
			(await mfwBoard(d, ["create", "--id", "TK-50", "title=z"])).stdout,
		).toContain("TK-50");
	});

	test("list filters and --json", async () => {
		const d = await tmp();
		await put(join(d, "board.yaml"), TASK_BOARD);
		await mfwBoard(d, ["create", "title=a", "status=ready", "tags=x,y"]);
		await mfwBoard(d, ["create", "title=b", "status=done", "tags=z"]);
		await mfwBoard(d, ["create", "title=c", "tags=y"]);
		const ids = async (...a: string[]) =>
			(await mfwBoard(d, ["list", ...a])).stdout
				.split("\n")
				.filter(Boolean)
				.map((l) => l.split("\t")[0]);
		expect(await ids("status=ready|done")).toEqual(["TK-1", "TK-2"]);
		expect(await ids("status=backlog")).toEqual(["TK-3"]);
		expect(await ids("tags~y")).toEqual(["TK-1", "TK-3"]);
		expect(await ids("tags~x|z")).toEqual(["TK-1", "TK-2"]);
		expect(await ids("tags~y", "status=ready")).toEqual(["TK-1"]);
		const j = JSON.parse(
			(await mfwBoard(d, ["list", "--json", "tags~z"])).stdout,
		);
		expect(j).toHaveLength(1);
		expect(j[0].fields.title).toBe("b");
	});

	test("check exit codes", async () => {
		const d = await tmp();
		await put(join(d, "board.yaml"), TASK_BOARD);
		await mfwBoard(d, ["create", "title=a"]);
		const ok = await mfwBoard(d, ["check"]);
		expect(ok.code).toBe(0);
		expect(ok.stdout).toBe("ok");
		await put(
			join(d, "tasks", "TK-9.md"),
			"---\nmfw: 1\nid: TK-9\nrev: 1\ntitle: bad\nstatus: nonsense\n---\n",
		);
		const bad = await mfwBoard(d, ["check"]);
		expect(bad.code).toBe(1);
		expect(bad.stdout).toContain("TK-9");
	});

	test("usage: unknown command and no command exit 2", async () => {
		const d = await tmp();
		await put(join(d, "board.yaml"), TASK_BOARD);
		const r = await mfwBoard(d, ["frobnicate"]);
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("usage: mfw-board");
		expect(r.stderr).toContain("claim <id>");
		expect((await mfwBoard(d, [])).code).toBe(2);
	});
});

describe("claim / release parsing", () => {
	test("claim and release require an id (and release a --run)", async () => {
		const d = await tmp();
		await put(join(d, "board.yaml"), TASK_BOARD);
		expect((await mfwBoard(d, ["claim"])).code).toBe(2);
		expect((await mfwBoard(d, ["release", "TK-1"])).code).toBe(2);
		expect((await mfwBoard(d, ["release"])).code).toBe(2);
	});
	// Claim/release behavior (start:false worktree binding, to:null release)
	// depends on the not-yet-merged claim.ts signatures; covered after the merge.
});
