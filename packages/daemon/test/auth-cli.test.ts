import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveAgentSessions, runAuthCommand } from "../src/auth/cli.ts";
import {
	AuthRefused,
	AuthService,
	FREE_ATTEMPTS,
} from "../src/auth/service.ts";
import { acquireDaemonLock } from "../src/host-resources/daemon-lock.ts";

const PASSWORD = "correct horse battery";
let home: string;
let out: string[];
let err: string[];

let agents: string[] | Error;
const run = (...args: string[]) =>
	runAuthCommand(args, {
		home,
		out: (l) => out.push(l),
		err: (l) => err.push(l),
		listAgentSessions: async () => {
			if (agents instanceof Error) throw agents;
			return agents;
		},
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
	agents = [];
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

describe("mfw auth setup-token", () => {
	test("issues a working token, in a 0600 file, and voids the previous one", async () => {
		const auth = await AuthService.open(join(home, "auth.db"), {
			passwordCheckIntervalMs: 0,
		});
		try {
			const first = (await auth.beginFirstRun()) as string;
			expect(await run("setup-token")).toBe(0);
			const file = join(home, "setup-token");
			const second = readFileSync(file, "utf8").trim();
			expect(second).not.toBe(first);
			expect(statSync(file).mode & 0o777).toBe(0o600);
			expect(out.join("\n")).toContain(second);
			expect(await code(auth.setup(first, PASSWORD))).toBe("invalid_token");
			expect(await code(auth.setup(second, PASSWORD))).toBe("ok");
		} finally {
			auth.close();
		}
	});

	test("refuses once an owner exists", async () => {
		const auth = await AuthService.open(join(home, "auth.db"));
		await auth.setup((await auth.beginFirstRun()) as string, PASSWORD);
		auth.close();
		expect(await run("setup-token")).toBe(1);
		expect(existsSync(join(home, "setup-token"))).toBe(false);
	});
});

describe("mfw auth reset (reviewer B3)", () => {
	const withOwner = async () => {
		const auth = await AuthService.open(join(home, "auth.db"));
		await auth.setup((await auth.beginFirstRun()) as string, PASSWORD);
		auth.close();
	};
	const hasOwner = async () => {
		const auth = await AuthService.open(join(home, "auth.db"));
		try {
			return await auth.hasOwner();
		} finally {
			auth.close();
		}
	};

	test("refuses while an agent session is alive", async () => {
		await withOwner();
		agents = ["mfw-run-1"];
		expect(await run("reset", "--yes")).toBe(1);
		expect(err.join("\n")).toContain("mfw-run-1");
		expect(await hasOwner()).toBe(true);
	});

	test("refuses when it cannot tell whether agents are alive", async () => {
		await withOwner();
		agents = new Error("tmux failed");
		expect(await run("reset", "--yes")).toBe(1);
		expect(await hasOwner()).toBe(true);
	});

	test("refuses while the server holds the daemon lock", async () => {
		await withOwner();
		const lock = await acquireDaemonLock(home, { processBootId: "test" });
		try {
			expect(await run("reset", "--yes")).toBe(1);
			expect(err.join("\n")).toContain("stop the server");
			expect(await hasOwner()).toBe(true);
		} finally {
			await lock.release();
		}
	});

	test("needs --yes", async () => {
		await withOwner();
		expect(await run("reset")).toBe(2);
		expect(await hasOwner()).toBe(true);
	});

	test("with no agents, removes the owner and every session", async () => {
		await withOwner();
		const auth = await AuthService.open(join(home, "auth.db"));
		const s = await auth.login(PASSWORD);
		auth.close();
		expect(await run("reset", "--yes")).toBe(0);
		const after = await AuthService.open(join(home, "auth.db"));
		try {
			expect(await after.hasOwner()).toBe(false);
			expect(await after.authenticate(s.token)).toBeNull();
		} finally {
			after.close();
		}
	});
});

describe("liveAgentSessions", () => {
	const fakeTmux = (script: string) => {
		const path = join(home, "fake-tmux");
		writeFileSync(path, `#!/bin/sh\n${script}\n`);
		chmodSync(path, 0o755);
		return path;
	};

	test("lists sessions on the given socket", async () => {
		const tmux = fakeTmux('[ "$2" = "sock" ] && printf "a\\nb\\n"');
		expect(await liveAgentSessions(tmux, "sock")).toEqual(["a", "b"]);
	});

	test("no server means no sessions", async () => {
		const tmux = fakeTmux('echo "no server running on /x" >&2; exit 1');
		expect(await liveAgentSessions(tmux, "sock")).toEqual([]);
	});

	test("any other failure throws, so reset fails closed", async () => {
		const tmux = fakeTmux('echo "permission denied" >&2; exit 1');
		await expect(liveAgentSessions(tmux, "sock")).rejects.toThrow();
	});
});

describe("mfw auth", () => {
	test("an unknown subcommand is a usage error", async () => {
		expect(await run("nope")).toBe(2);
		expect(err.join("\n")).toContain("usage: mfw auth");
	});
});
