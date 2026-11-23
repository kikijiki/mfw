import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	lstatSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAuthCommand } from "../src/auth/cli.ts";
import { AuthService, authDbPath } from "../src/auth/service.ts";
import { MCP_TOKEN_FILE, parseTtl } from "../src/auth/tokens.ts";

let home: string;
let out: string[];
let err: string[];

const run = (...args: string[]) =>
	runAuthCommand(args, {
		home,
		out: (l) => out.push(l),
		err: (l) => err.push(l),
	});

beforeEach(async () => {
	home = mkdtempSync(join(tmpdir(), "mfw-token-cli-"));
	out = [];
	err = [];
	const auth = await AuthService.open(authDbPath(home));
	await auth.setup(
		(await auth.beginFirstRun()) as string,
		"correct horse battery",
	);
	auth.close();
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

const create = ["token", "create", "--name", "ci", "--scope", "board:read"];

describe("mfw auth token", () => {
	test("create prints only the token on stdout", async () => {
		expect(await run(...create)).toBe(0);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatch(/^mfwt_[A-Za-z0-9_-]{43}$/);
		expect(err.join("\n")).not.toContain(out[0] as string);
	});

	test("the token it prints authenticates with its scopes", async () => {
		await run(...create, "--scope", "status:read", "--project", "alpha");
		const auth = await AuthService.open(authDbPath(home));
		const p = await auth.authenticateToken(out[0]);
		auth.close();
		expect(p?.scopes).toEqual(["status:read", "board:read"]);
		expect(p?.project).toBe("alpha");
	});

	test("--write-file saves it 0600 and never prints it", async () => {
		expect(await run(...create, "--write-file")).toBe(0);
		const path = join(home, MCP_TOKEN_FILE);
		expect(lstatSync(path).mode & 0o777).toBe(0o600);
		const token = readFileSync(path, "utf8").trim();
		expect(token).toStartWith("mfwt_");
		expect([...out, ...err].join("\n")).not.toContain(token);
		expect(readdirSync(home).filter((f) => f.includes("mcp-token."))).toEqual(
			[],
		);
	});

	test("--write-file replaces a planted link instead of writing through it", async () => {
		const target = join(home, "victim");
		writeFileSync(target, "untouched");
		symlinkSync(target, join(home, MCP_TOKEN_FILE));
		expect(await run(...create, "--write-file")).toBe(0);
		expect(readFileSync(target, "utf8")).toBe("untouched");
		expect(lstatSync(join(home, MCP_TOKEN_FILE)).isSymbolicLink()).toBe(false);
	});

	test("list shows tokens, never a secret", async () => {
		await run(...create);
		const token = out[0] as string;
		out = [];
		expect(await run("token", "list")).toBe(0);
		expect(out.join("\n")).toContain("'ci'");
		expect(out.join("\n")).not.toContain(token);
	});

	test("revoke ends a token", async () => {
		await run(...create);
		const token = out[0] as string;
		let auth = await AuthService.open(authDbPath(home));
		const id = (await auth.listTokens())[0]?.id as string;
		auth.close();
		expect(await run("token", "revoke", id)).toBe(0);
		auth = await AuthService.open(authDbPath(home));
		expect(await auth.authenticateToken(token)).toBeNull();
		auth.close();
		expect(await run("token", "revoke", id)).toBe(1);
	});

	for (const [label, args, code] of [
		["no name", ["token", "create", "--scope", "board:read"], 1],
		["no scope", ["token", "create", "--name", "x"], 1],
		["admin", ["token", "create", "--name", "x", "--scope", "admin"], 1],
		["bad ttl", [...create, "--ttl", "soon"], 2],
		["ttl over the cap", [...create, "--ttl", "91d"], 1],
		["unknown flag", [...create, "--forever"], 2],
		["missing value", ["token", "create", "--name"], 2],
		["unknown subcommand", ["token", "mint"], 2],
	] as const)
		test(`refuses ${label}`, async () => {
			expect(await run(...args)).toBe(code);
			expect(out).toEqual([]);
		});

	test("inside a sandbox, where the database is hidden, it refuses and creates nothing", async () => {
		const hidden = mkdtempSync(join(tmpdir(), "mfw-token-cli-hidden-"));
		try {
			for (const args of [
				create,
				["token", "list"],
				["token", "revoke", "x"],
			]) {
				const code = await runAuthCommand(args, {
					home: hidden,
					out: (l) => out.push(l),
					err: (l) => err.push(l),
				});
				expect(code).toBe(1);
			}
			expect(err.join("\n")).toContain("outside any agent sandbox");
			expect(out).toEqual([]);
			expect(readdirSync(hidden)).toEqual([]);
			expect(existsSync(authDbPath(hidden))).toBe(false);
		} finally {
			rmSync(hidden, { recursive: true, force: true });
		}
	});
});

describe("a token for a project this install does not have", () => {
	const write = (names: string[]) =>
		writeFileSync(
			join(home, "config.json"),
			JSON.stringify({
				projects: names.map((name) => ({ name, root: join(home, name) })),
			}),
		);

	test("create warns, and list marks it", async () => {
		write(["alpha"]);
		expect(await run(...create, "--project", "later")).toBe(0);
		expect(err.join("\n")).toContain("no project named 'later'");
		out = [];
		await run("token", "list");
		expect(out.join("\n")).toContain("later (not attached)");
	});

	test("an attached project gets neither", async () => {
		write(["alpha"]);
		await run(...create, "--project", "alpha");
		expect(err.join("\n")).not.toContain("no project named");
		out = [];
		await run("token", "list");
		expect(out.join("\n")).not.toContain("not attached");
	});
});

describe("mfw auth token audit", () => {
	async function activity() {
		const auth = await AuthService.open(authDbPath(home));
		const { token, info } = await auth.createToken({
			name: "ci",
			scopes: ["board:write"],
		});
		const other = await auth.createToken({
			name: "other",
			scopes: ["board:read"],
		});
		await auth.beginTokenAction({
			tokenId: info.id,
			name: "ci",
			path: "tasks.create",
			project: "alpha",
			outcome: "ok",
		});
		await auth.beginTokenAction({
			tokenId: other.info.id,
			name: "other",
			path: "live.events",
			project: "alpha",
			kind: "stream",
			outcome: "opened",
		});
		await auth.recordTokenRefusal({
			tokenId: info.id,
			name: "ci",
			path: "settings.get",
		});
		auth.close();
		return { token, id: info.id };
	}

	test("shows actions, streams and refusals, never a secret", async () => {
		const { token } = await activity();
		expect(await run("token", "audit")).toBe(0);
		const text = out.join("\n");
		expect(text).toContain("tasks.create");
		expect(text).toContain("live.events");
		expect(text).toContain("refused 1 (last settings.get");
		expect(text).not.toContain(token);
	});

	test("--id narrows it to one token", async () => {
		const { id } = await activity();
		expect(await run("token", "audit", "--id", id)).toBe(0);
		const text = out.join("\n");
		expect(text).toContain("tasks.create");
		expect(text).not.toContain("live.events");
	});

	for (const args of [["--limit", "0"], ["--limit"], ["--what", "x"]])
		test(`refuses ${args.join(" ")}`, async () => {
			expect(await run("token", "audit", ...args)).toBe(2);
		});

	test("with nothing recorded it says so", async () => {
		expect(await run("token", "audit")).toBe(0);
		expect(out.join("\n")).toContain("no token activity");
	});
});

describe("mfw auth token create --write-file records the issuing origin", () => {
	const lines = () =>
		readFileSync(join(home, MCP_TOKEN_FILE), "utf8").trim().split("\n");

	test("the default loopback origin", async () => {
		expect(await run(...create, "--write-file")).toBe(0);
		expect(lines()[1]).toBe("origin=http://localhost:7777");
	});

	test("--origin names another", async () => {
		expect(
			await run(
				...create,
				"--write-file",
				"--origin",
				"https://box.example:8443/",
			),
		).toBe(0);
		expect(lines()[1]).toBe("origin=https://box.example:8443");
	});

	for (const bad of [
		"not-a-url",
		"ftp://box.example",
		"http://box.example",
		"https://box.example/path",
		"https://user@box.example",
	])
		test(`refuses --origin ${bad}`, async () => {
			expect(await run(...create, "--write-file", "--origin", bad)).toBe(2);
			expect(existsSync(join(home, MCP_TOKEN_FILE))).toBe(false);
		});

	test("--origin without --write-file is refused", async () => {
		expect(await run(...create, "--origin", "https://box.example")).toBe(2);
	});
});

describe("parseTtl", () => {
	test("reads minutes, hours and days", () => {
		expect(parseTtl("30m")).toBe(1_800_000);
		expect(parseTtl("24h")).toBe(86_400_000);
		expect(parseTtl("7d")).toBe(604_800_000);
	});
	for (const bad of ["", "0d", "-1d", "1w", "1.5h", "h", "1 d"])
		test(`refuses '${bad}'`, () => {
			expect(parseTtl(bad)).toBeNull();
		});
});
