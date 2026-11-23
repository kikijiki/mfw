import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MCP_TOKEN_FILE as DAEMON_FILE } from "../../daemon/src/auth/tokens.ts";
import { makeClient } from "../src/client.ts";
import {
	assertTokenTransport,
	MCP_TOKEN_FILE,
	resolveMcpToken,
} from "../src/credential.ts";

const TOKEN = `mfwt_${"a".repeat(43)}`;
const OTHER = `mfwt_${"b".repeat(43)}`;
let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "mfw-mcp-cred-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const file = (name: string, body: string, mode = 0o600) => {
	const p = join(home, name);
	writeFileSync(p, body, { mode });
	chmodSync(p, mode);
	return p;
};

describe("resolveMcpToken", () => {
	test("agrees with the daemon on the default file name", () => {
		expect(MCP_TOKEN_FILE).toBe(DAEMON_FILE);
	});

	test("none configured is null", () => {
		expect(resolveMcpToken([], { MFW_HOME: home })).toBeNull();
	});

	test("reads the default file", () => {
		file(MCP_TOKEN_FILE, `${TOKEN}\n`);
		expect(resolveMcpToken([], { MFW_HOME: home })).toBe(TOKEN);
	});

	test("the env beats the file, and --token-file beats both", () => {
		file(MCP_TOKEN_FILE, TOKEN);
		expect(resolveMcpToken([], { MFW_HOME: home, MFW_TOKEN: OTHER })).toBe(
			OTHER,
		);
		const p = file("chosen", `${TOKEN}\n`);
		expect(
			resolveMcpToken(["--token-file", p], {
				MFW_HOME: home,
				MFW_TOKEN: OTHER,
			}),
		).toBe(TOKEN);
		expect(resolveMcpToken([`--token-file=${p}`], { MFW_HOME: home })).toBe(
			TOKEN,
		);
	});

	for (const args of [["--token", TOKEN], [`--token=${TOKEN}`]])
		test(`refuses a secret on the command line: ${args[0]?.slice(0, 8)}`, () => {
			expect(() => resolveMcpToken(args, { MFW_HOME: home })).toThrow(
				/command line/,
			);
		});

	for (const mode of [0o640, 0o604, 0o644, 0o660])
		test(`refuses a file with mode ${mode.toString(8)}`, () => {
			file(MCP_TOKEN_FILE, TOKEN, mode);
			expect(() => resolveMcpToken([], { MFW_HOME: home })).toThrow(
				/chmod 600/,
			);
		});

	test("refuses a symbolic link", () => {
		const real = file("real", TOKEN);
		symlinkSync(real, join(home, MCP_TOKEN_FILE));
		expect(() => resolveMcpToken([], { MFW_HOME: home })).toThrow(/symbolic/);
	});

	test("refuses a FIFO without hanging", () => {
		const fifo = join(home, MCP_TOKEN_FILE);
		expect(Bun.spawnSync(["mkfifo", "-m", "600", fifo]).exitCode).toBe(0);
		expect(() => resolveMcpToken([], { MFW_HOME: home })).toThrow(
			/not a regular file/,
		);
	});

	test("refuses a missing --token-file rather than running without it", () => {
		expect(() =>
			resolveMcpToken(["--token-file", join(home, "absent")], {
				MFW_HOME: home,
			}),
		).toThrow(/does not exist/);
		expect(() => resolveMcpToken(["--token-file"], {})).toThrow(/needs a path/);
	});

	for (const bad of ["not-a-token", `${TOKEN}x`, `${TOKEN}\n${OTHER}`])
		test(`refuses contents that are not one token: ${bad.slice(0, 10)}`, () => {
			file(MCP_TOKEN_FILE, bad);
			expect(() => resolveMcpToken([], { MFW_HOME: home })).toThrow(
				/does not hold/,
			);
		});

	test("refuses a malformed MFW_TOKEN without echoing it", () => {
		try {
			resolveMcpToken([], { MFW_HOME: home, MFW_TOKEN: "secret-value" });
			throw new Error("should have refused");
		} catch (e) {
			expect((e as Error).message).toContain("MFW_TOKEN");
			expect((e as Error).message).not.toContain("secret-value");
		}
	});
});

describe("a stored token goes only to where it was issued", () => {
	const EVIL = "https://evil.example/mfw/api/trpc";
	const LOCAL = "http://localhost:7777/mfw/api/trpc";

	test("the implicit file is not used for another MFW_URL", () => {
		file(MCP_TOKEN_FILE, `${TOKEN}\n`);
		expect(resolveMcpToken([], { MFW_HOME: home, MFW_URL: EVIL })).toBeNull();
	});

	test("nor for another loopback port", () => {
		file(MCP_TOKEN_FILE, `${TOKEN}\norigin=http://localhost:7777\n`);
		expect(
			resolveMcpToken([], {
				MFW_HOME: home,
				MFW_URL: "http://localhost:9999/mfw/api/trpc",
			}),
		).toBeNull();
	});

	test("it is used for the default URL, spelled out or not", () => {
		file(MCP_TOKEN_FILE, `${TOKEN}\norigin=http://localhost:7777\n`);
		expect(resolveMcpToken([], { MFW_HOME: home })).toBe(TOKEN);
		expect(resolveMcpToken([], { MFW_HOME: home, MFW_URL: LOCAL })).toBe(TOKEN);
	});

	test("an implicit file issued elsewhere is refused at the default URL", () => {
		file(MCP_TOKEN_FILE, `${TOKEN}\norigin=https://box.example\n`);
		expect(() => resolveMcpToken([], { MFW_HOME: home })).toThrow(/issued for/);
	});

	test("an explicit file with a recorded origin refuses any other", () => {
		const p = file("chosen", `${TOKEN}\norigin=http://localhost:7777\n`);
		expect(() =>
			resolveMcpToken(["--token-file", p], { MFW_HOME: home, MFW_URL: EVIL }),
		).toThrow(/issued for/);
	});

	test("an explicit file for that origin is accepted", () => {
		const p = file("chosen", `${TOKEN}\norigin=https://evil.example\n`);
		expect(
			resolveMcpToken(["--token-file", p], { MFW_HOME: home, MFW_URL: EVIL }),
		).toBe(TOKEN);
	});

	test("MFW_TOKEN is an explicit choice for any URL", () => {
		expect(
			resolveMcpToken([], { MFW_HOME: home, MFW_URL: EVIL, MFW_TOKEN: TOKEN }),
		).toBe(TOKEN);
	});

	for (const bad of [
		`${TOKEN}\norigin=not a url\n`,
		`${TOKEN}\norigin=https://a.example/path\n`,
		`${TOKEN}\nother=1\n`,
		`${TOKEN}\norigin=https://a.example\nextra\n`,
	])
		test(`refuses a malformed file: ${bad.slice(49, 75).trim()}`, () => {
			file(MCP_TOKEN_FILE, bad);
			expect(() => resolveMcpToken([], { MFW_HOME: home })).toThrow(
				/does not hold/,
			);
		});
});

describe("assertTokenTransport", () => {
	for (const url of [
		"http://localhost:7777/mfw/api/trpc",
		"http://127.0.0.1:7777/mfw/api/trpc",
		"http://[::1]:7777/mfw/api/trpc",
		"https://box.example/mfw/api/trpc",
	])
		test(`allows ${url}`, () => {
			expect(() => assertTokenTransport(url)).not.toThrow();
		});

	for (const url of [
		"http://box.example:7777/mfw/api/trpc",
		"http://100.64.0.1:7777/mfw/api/trpc",
		"http://localhost.evil.example/mfw/api/trpc",
		"ftp://localhost/x",
	])
		test(`refuses ${url}`, () => {
			expect(() => assertTokenTransport(url)).toThrow(/without TLS/);
		});
});

describe("the client with a token", () => {
	test("sends it as a bearer header, one call per request, never in the URL", async () => {
		const seen: { auth: string | null; url: string }[] = [];
		const server = Bun.serve({
			port: 0,
			fetch(req) {
				seen.push({
					auth: req.headers.get("authorization"),
					url: req.url,
				});
				return Response.json({ result: { data: { json: { ok: true } } } });
			},
		});
		try {
			const client = makeClient(
				`http://127.0.0.1:${server.port}/mfw/api/trpc`,
				TOKEN,
			);
			await Promise.all([
				client.system.health.query(),
				client.inbox.list.query(),
			]);
		} finally {
			await server.stop(true);
		}
		expect(seen).toHaveLength(2);
		for (const s of seen) {
			expect(s.auth).toBe(`Bearer ${TOKEN}`);
			expect(s.url).not.toContain(TOKEN);
			expect(s.url).not.toContain("batch=");
		}
	});

	test("refuses to build a client that would send it in the clear", () => {
		expect(() => makeClient("http://box.example/mfw/api/trpc", TOKEN)).toThrow(
			/without TLS/,
		);
	});
});
