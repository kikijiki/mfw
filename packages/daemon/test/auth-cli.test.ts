import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAuthCommand } from "../src/auth/cli.ts";
import {
	AuthRefused,
	AuthService,
	FREE_ATTEMPTS,
} from "../src/auth/service.ts";

const PASSWORD = "correct horse battery";
let home: string;
let out: string[];
let err: string[];

const run = (...args: string[]) =>
	runAuthCommand(args, {
		home,
		out: (l) => out.push(l),
		err: (l) => err.push(l),
	});

const code = async (p: Promise<unknown>) => {
	try {
		await p;
		return "ok";
	} catch (e) {
		if (e instanceof AuthRefused) return e.code;
		throw e;
	}
};

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "mfw-auth-cli-"));
	out = [];
	err = [];
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("mfw auth unlock", () => {
	test("lets a locked-out owner back in, with the server's store open", async () => {
		const auth = await AuthService.open(join(home, "auth.db"), {
			passwordCheckIntervalMs: 0,
		});
		try {
			await auth.setup((await auth.beginFirstRun()) as string, PASSWORD);
			for (let i = 0; i < FREE_ATTEMPTS; i++)
				await code(auth.login("wrong password!", undefined, "127.0.0.1"));
			expect(await code(auth.login(PASSWORD, undefined, "127.0.0.1"))).toBe(
				"locked",
			);
			expect(await run("unlock")).toBe(0);
			expect(await code(auth.login(PASSWORD, undefined, "127.0.0.1"))).toBe(
				"ok",
			);
		} finally {
			auth.close();
		}
	});

	test("never creates a store: inside the sandbox MFW_HOME is empty", async () => {
		expect(await run("unlock")).toBe(1);
		expect(existsSync(join(home, "auth.db"))).toBe(false);
		expect(err.join("\n")).toContain("no auth database");
	});
});

describe("mfw auth", () => {
	test("an unknown subcommand is a usage error", async () => {
		expect(await run("nope")).toBe(2);
		expect(err.join("\n")).toContain("usage: mfw auth");
	});
});
