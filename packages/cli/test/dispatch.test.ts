import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	boardMissingMessage,
	type Deps,
	dispatch,
	findBoardExecutable,
} from "../src/main.ts";

const MAIN = join(import.meta.dir, "../src/main.ts");
const dirs: string[] = [];
function tmp(): string {
	const d = realpathSync(mkdtempSync(join(tmpdir(), "mfw-cli-")));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fakeBoard(dir: string): string {
	const p = join(dir, "mfw-board");
	writeFileSync(p, '#!/bin/sh\necho "fake-board $*"\nexit 3\n');
	chmodSync(p, 0o755);
	return p;
}

function deps(over: Partial<Deps> = {}) {
	const out: string[] = [];
	const err: string[] = [];
	const ran: { argv: string[]; cwd?: string }[] = [];
	const mcp: string[][] = [];
	const auth: string[][] = [];
	const d: Deps = {
		env: { PATH: "" },
		selfDir: "/nonexistent",
		sourceBoardCli: null,
		serverEntry: null,
		repoRoot: "/repo",
		bun: "/bin/bun",
		out: (l) => out.push(l),
		err: (l) => err.push(l),
		run: async (argv, cwd) => {
			ran.push({ argv, cwd });
			return 0;
		},
		runMcp: async (args) => {
			mcp.push(args);
		},
		runAuth: async (args) => {
			auth.push(args);
			return 0;
		},
		...over,
	};
	return { d, out, err, ran, mcp, auth };
}

describe("mfw auth", () => {
	test("hands its arguments to the auth command", async () => {
		const h = deps();
		expect(await dispatch(["auth", "unlock"], h.d)).toBe(0);
		expect(h.auth).toEqual([["unlock"]]);
	});
});

describe("mfw board", () => {
	test("execs mfw-board next to the dispatcher, args passed through", async () => {
		const dir = tmp();
		const exe = fakeBoard(dir);
		const t = deps({ selfDir: dir });
		expect(await dispatch(["board", "list", "--json"], t.d)).toBe(0);
		expect(t.ran).toEqual([{ argv: [exe, "list", "--json"], cwd: undefined }]);
	});

	test("falls back to mfw-board on PATH", async () => {
		const dir = tmp();
		const exe = fakeBoard(dir);
		expect(findBoardExecutable({ PATH: `/nope:${dir}` }, "/nonexistent")).toBe(
			exe,
		);
	});

	test("falls back to the source checkout CLI under bun", async () => {
		const t = deps({ sourceBoardCli: "/repo/packages/board/src/cli.ts" });
		await dispatch(["board", "ready"], t.d);
		expect(t.ran[0]?.argv).toEqual([
			"/bin/bun",
			"run",
			"/repo/packages/board/src/cli.ts",
			"ready",
		]);
	});

	test("missing mfw-board: exit 127 and the fix", async () => {
		const t = deps();
		expect(await dispatch(["board", "list"], t.d)).toBe(127);
		expect(t.ran).toEqual([]);
		expect(t.err.join("\n")).toBe(boardMissingMessage());
		expect(boardMissingMessage()).toContain("mfw-board");
		expect(boardMissingMessage()).toContain("Fix:");
	});

	test("end to end: the child's exit code and output come back", async () => {
		const dir = tmp();
		fakeBoard(dir);
		const p = Bun.spawn([process.execPath, "run", MAIN, "board", "a", "b"], {
			env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [out, code] = await Promise.all([
			new Response(p.stdout).text(),
			p.exited,
		]);
		// selfDir has no mfw-board, so the PATH one runs.
		expect(out.trim()).toBe("fake-board a b");
		expect(code).toBe(3);
	});
});

describe("mfw: other subcommands", () => {
	test("unknown subcommand: usage error, exit 2, lists the commands", async () => {
		const t = deps();
		expect(await dispatch(["frobnicate"], t.d)).toBe(2);
		const msg = t.err.join("\n");
		expect(msg).toContain("unknown command 'frobnicate'");
		for (const c of ["board", "mcp", "server", "version"])
			expect(msg).toContain(c);
	});

	test("no doctor or backup stubs yet", async () => {
		for (const c of ["doctor", "backup"]) {
			const t = deps();
			expect(await dispatch([c], t.d)).toBe(2);
		}
	});

	test("no arguments prints usage to stderr, exit 2; --help to stdout, exit 0", async () => {
		const a = deps();
		expect(await dispatch([], a.d)).toBe(2);
		expect(a.err.join("\n")).toContain("usage: mfw");
		const b = deps();
		expect(await dispatch(["--help"], b.d)).toBe(0);
		expect(b.out.join("\n")).toContain("usage: mfw");
	});

	test("mcp runs in process with its args, and --help needs no server", async () => {
		const t = deps();
		await dispatch(["mcp", "--brain", "S1"], t.d);
		expect(t.mcp).toEqual([["--brain", "S1"]]);
		expect(t.ran).toEqual([]);
		const h = deps();
		expect(await dispatch(["mcp", "--help"], h.d)).toBe(0);
		expect(h.mcp).toEqual([]);
		expect(h.out.join("\n")).toContain("usage: mfw mcp");
	});

	test("server runs the built entry in the checkout; refuses when unbuilt", async () => {
		const t = deps({
			serverEntry: "/repo/apps/start/.output/server/index.mjs",
		});
		await dispatch(["server"], t.d);
		expect(t.ran).toEqual([
			{
				argv: ["/bin/bun", "run", "/repo/apps/start/.output/server/index.mjs"],
				cwd: "/repo",
			},
		]);
		expect(t.d.env.HOST).toBe("127.0.0.1");
		const u = deps();
		expect(await dispatch(["server"], u.d)).toBe(1);
		expect(u.err.join("\n")).toContain("bun run build");
	});

	test("server keeps an explicit bind address", async () => {
		for (const env of [{ HOST: "100.64.0.1" }, { NITRO_HOST: "::1" }]) {
			const t = deps({
				serverEntry: "/repo/apps/start/.output/server/index.mjs",
				env: { ...env },
			});
			await dispatch(["server"], t.d);
			expect(t.d.env).toEqual(env);
		}
	});

	test("version reports mfw and mfw-board", async () => {
		const p = Bun.spawn([process.execPath, "run", MAIN, "version"], {
			stdout: "pipe",
		});
		const out = await new Response(p.stdout).text();
		expect(out).toMatch(/^mfw \d+\.\d+\.\d+\nmfw-board \d+\.\d+\.\d+\n$/);
		expect(await p.exited).toBe(0);
	});
});

describe("real entry point", () => {
	test("`mfw board --help` reaches the board CLI (source fallback)", async () => {
		const empty = tmp();
		const p = Bun.spawn([process.execPath, "run", MAIN, "board", "--help"], {
			env: { ...process.env, PATH: empty },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [out, err] = await Promise.all([
			new Response(p.stdout).text(),
			new Response(p.stderr).text(),
		]);
		expect(`${out}${err}`).toContain("usage: mfw-board");
	});
});

describe("mfw mcp as a real process", () => {
	test("stays up on stdio and answers initialize", async () => {
		const home = mkdtempSync(join(tmpdir(), "mfw-cli-mcp-"));
		const child = Bun.spawn(
			[process.execPath, "run", join(import.meta.dir, "../src/main.ts"), "mcp"],
			{
				env: { PATH: process.env.PATH ?? "", HOME: home, MFW_HOME: home },
				stdin: "pipe",
				stdout: "pipe",
				stderr: "ignore",
			},
		);
		try {
			const line = `${JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-03-26",
					capabilities: {},
					clientInfo: { name: "test", version: "0" },
				},
			})}\n`;
			await Bun.sleep(1000);
			expect(child.exitCode).toBeNull();
			child.stdin.write(line);
			child.stdin.flush();
			const reader = child.stdout.getReader();
			const first = await Promise.race([
				reader.read(),
				Bun.sleep(8000).then(() => null),
			]);
			expect(new TextDecoder().decode(first?.value)).toContain('"id":1');
		} finally {
			child.kill("SIGKILL");
			await child.exited;
			rmSync(home, { recursive: true, force: true });
		}
	}, 15_000);
});
