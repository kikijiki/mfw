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
import {
	discoverTmuxSockets,
	findAgentSessions,
	liveAgentSessions,
	runAuthCommand,
} from "../src/auth/cli.ts";
import {
	AuthRefused,
	AuthService,
	FREE_ATTEMPTS,
} from "../src/auth/service.ts";
import { acquireDaemonLock } from "../src/resources/daemon-lock.ts";
import { pinnedTool } from "../src/sandbox.ts";

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

describe("mfw auth sign-out-everywhere (reviewer M4)", () => {
	test("revokes every session", async () => {
		const auth = await AuthService.open(join(home, "auth.db"));
		try {
			const s = await auth.setup(
				(await auth.beginFirstRun()) as string,
				PASSWORD,
			);
			expect(await run("sign-out-everywhere")).toBe(0);
			expect(await auth.authenticate(s.token)).toBeNull();
		} finally {
			auth.close();
		}
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

describe("agent discovery does not depend on the caller's env (recheck Low)", () => {
	const fakeTmux = (script: string) => {
		const path = join(home, "fake-tmux");
		writeFileSync(path, `#!/bin/sh\n${script}\n`);
		chmodSync(path, 0o755);
		return path;
	};
	const line = (path: string) =>
		`0000000000000000: 00000002 00000000 00010000 0001 01 12345 ${path}`;

	test("finds tmux sockets anywhere, for this uid only", () => {
		const table = [
			"Num RefCount Protocol Flags Type St Inode Path",
			line("/custom/dir/tmux-1000/mfw"),
			line("/tmp/tmux-1000/other"),
			line("/tmp/tmux-1001/mfw"),
			line("/run/user/1000/bus"),
			"0000000000000000: 00000002 00000000 00000000 0001 03 777",
		].join("\n");
		const found = discoverTmuxSockets(table, 1000, {});
		expect(found).toContain("/custom/dir/tmux-1000/mfw");
		expect(found).toContain("/tmp/tmux-1000/other");
		expect(found).not.toContain("/tmp/tmux-1001/mfw");
		expect(found).not.toContain("/run/user/1000/bus");
	});

	test("always includes the configured and default socket paths", () => {
		const found = discoverTmuxSockets("Num Path\n", 1000, {
			TMUX_TMPDIR: "/elsewhere",
			MFW_TMUX_SOCKET: "custom",
		});
		for (const path of [
			"/tmp/tmux-1000/mfw",
			"/elsewhere/tmux-1000/mfw",
			"/tmp/tmux-1000/custom",
			"/elsewhere/tmux-1000/custom",
		])
			expect(found).toContain(path);
	});

	test("any session on an mfw socket counts", async () => {
		const tmux = fakeTmux('printf "whatever\\n"');
		expect(await liveAgentSessions(tmux, ["/x/tmux-1000/mfw"])).toEqual([
			"whatever",
		]);
	});

	test("on another socket only agent-named sessions count", async () => {
		const tmux = fakeTmux('printf "my-editor\\nmfw_run1\\n"');
		expect(await liveAgentSessions(tmux, ["/x/tmux-1000/default"])).toEqual([
			"mfw_run1",
		]);
	});

	test("no server, or a stale socket, means no sessions", async () => {
		for (const message of [
			"no server running on /x",
			"error connecting to /x (No such file or directory)",
			"error connecting to /x (Connection refused)",
		]) {
			const tmux = fakeTmux(`echo "${message}" >&2; exit 1`);
			expect(await liveAgentSessions(tmux, ["/x/tmux-1000/mfw"])).toEqual([]);
		}
	});

	test("any other failure throws, so reset fails closed", async () => {
		const tmux = fakeTmux('echo "permission denied" >&2; exit 1');
		await expect(
			liveAgentSessions(tmux, ["/x/tmux-1000/mfw"]),
		).rejects.toThrow();
	});

	test("an unreadable socket table refuses instead of guessing", async () => {
		await expect(
			findAgentSessions({
				tmux: "/bin/true",
				readUnixTable: () => {
					throw new Error("no /proc");
				},
				uid: 1000,
				env: {},
			}),
		).rejects.toThrow();
	});

	test("a real server under another TMUX_TMPDIR is found from a clean env", async () => {
		const tmux = pinnedTool("tmux");
		if (!tmux) {
			console.log("skip: tmux is not on a trusted PATH");
			return;
		}
		const elsewhere = mkdtempSync(join(tmpdir(), "mfw-tm-"));
		const name = `mfw-reset-${process.pid}`;
		const env = { ...process.env, TMUX_TMPDIR: elsewhere };
		const kill = () =>
			Bun.spawnSync([tmux, "-L", name, "kill-server"], {
				env,
				stdout: "ignore",
				stderr: "ignore",
			});
		try {
			const started = Bun.spawnSync(
				[tmux, "-L", name, "new-session", "-d", "-s", "mfw_run1", "sleep 30"],
				{ env, stdout: "ignore", stderr: "pipe" },
			);
			expect(started.exitCode).toBe(0);
			const found = await findAgentSessions({
				tmux,
				readUnixTable: () => readFileSync("/proc/net/unix", "utf8"),
				uid: process.getuid?.() ?? 0,
				env: {},
			});
			expect(found).toContain("mfw_run1");
		} finally {
			kill();
			rmSync(elsewhere, { recursive: true, force: true });
		}
	});
});

describe("mfw auth", () => {
	test("an unknown subcommand is a usage error", async () => {
		expect(await run("nope")).toBe(2);
		expect(err.join("\n")).toContain("usage: mfw auth");
	});
});
