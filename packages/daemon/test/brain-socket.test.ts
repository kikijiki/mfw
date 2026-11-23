import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
	BRAIN_TURN_HEADER,
	BrainSocket,
	type BrainSocketAccess,
	brainSocketFor,
} from "../src/brain-runtime/brain-socket.ts";
import { socketRoot } from "../src/containment/socket-root.ts";

/**
 * The brain socket in isolation: a stand-in handler records what reaches the
 * router, so every refusal below is the socket's own.
 */

const dirs: string[] = [];
const sockets: BrainSocket[] = [];
afterEach(async () => {
	for (const s of sockets.splice(0)) await s.stop();
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function home() {
	const dir = await mkdtemp(join(tmpdir(), "mfw-bs-"));
	dirs.push(dir);
	return dir;
}

async function setup() {
	const dir = await home();
	const socket = new BrainSocket(dir);
	sockets.push(socket);
	const seen: Request[] = [];
	socket.setHandler(async (req) => {
		seen.push(req);
		return new Response(JSON.stringify({ ok: true }));
	});
	return { dir, socket, seen };
}

const binding = { project: "alpha", sessionId: "S1", runId: "R1" };

function call(
	access: BrainSocketAccess,
	token: string | null,
	over: {
		procedure?: string;
		input?: unknown;
		headers?: Record<string, string>;
		method?: "GET" | "POST";
	} = {},
) {
	const input = over.input ?? {
		json: { project: "alpha", turnRunId: "R1" },
	};
	const headers: Record<string, string> = { ...over.headers };
	if (token !== null) headers.authorization = `Bearer ${token}`;
	const procedure = over.procedure ?? "brain.read";
	const method = over.method ?? "POST";
	const url = `http://x/trpc/${procedure}`;
	return fetch(
		method === "GET"
			? `${url}?input=${encodeURIComponent(JSON.stringify(input))}`
			: url,
		{
			method,
			headers,
			...(method === "POST" ? { body: JSON.stringify(input) } : {}),
			unix: access.socketPath,
		} as RequestInit,
	);
}

const tokenOf = (a: BrainSocketAccess) => readFile(a.tokenFile, "utf8");

describe("brain socket", () => {
	test("the socket and token file are 0600 under a 0700 run directory", async () => {
		const { dir, socket } = await setup();
		const access = await socket.issue(binding);
		expect(access.socketPath.startsWith(join(socketRoot(dir), "b"))).toBe(true);
		expect(basename(access.socketPath)).toBe("brain.sock");
		expect(dirname(access.tokenFile)).toBe(dirname(access.socketPath));
		expect(statSync(access.socketPath).mode & 0o777).toBe(0o600);
		expect(statSync(socketRoot(dir)).mode & 0o777).toBe(0o700);
		expect(statSync(access.tokenFile).mode & 0o777).toBe(0o600);
		expect((await tokenOf(access)).length).toBeGreaterThanOrEqual(32);
	});

	test("a valid token reaches the router, with the turn attribution taken from the token", async () => {
		const { socket, seen } = await setup();
		const access = await socket.issue(binding);
		const res = await call(access, await tokenOf(access), {
			headers: { [BRAIN_TURN_HEADER]: "R1" },
		});
		expect(res.status).toBe(200);
		expect(seen).toHaveLength(1);
		expect(seen[0]?.headers.get(BRAIN_TURN_HEADER)).toBe("R1");
		// The credential does not travel on to the router.
		expect(seen[0]?.headers.get("authorization")).toBeNull();
		expect(await seen[0]?.text()).toContain('"turnRunId":"R1"');
	});

	test("queries (GET) are served the same way", async () => {
		const { socket, seen } = await setup();
		const access = await socket.issue(binding);
		const res = await call(access, await tokenOf(access), { method: "GET" });
		expect(res.status).toBe(200);
		expect(seen).toHaveLength(1);
	});

	test("a missing, malformed or wrong token gets 401 and reaches nothing", async () => {
		const { socket, seen } = await setup();
		const access = await socket.issue(binding);
		for (const t of [null, "", "nope", `${await tokenOf(access)}x`]) {
			expect((await call(access, t)).status).toBe(401);
		}
		expect(seen).toHaveLength(0);
	});

	test("a revoked (stale-turn) token is refused and its file is gone", async () => {
		const { socket, seen } = await setup();
		const access = await socket.issue(binding);
		const token = await tokenOf(access);
		expect((await call(access, token)).status).toBe(200);
		await socket.revoke("R1");
		expect(existsSync(access.tokenFile)).toBe(false);
		// The turn's listener is gone with it, so there is nothing to connect to.
		expect(existsSync(access.socketPath)).toBe(false);
		await expect(call(access, token)).rejects.toThrow();
		expect(seen).toHaveLength(1);
		await socket.revoke("R1"); // idempotent
	});

	test("a token cannot act as another turn or project", async () => {
		const { socket, seen } = await setup();
		const access = await socket.issue(binding);
		const token = await tokenOf(access);
		const claims = [
			{ headers: { [BRAIN_TURN_HEADER]: "R2" } },
			{ input: { json: { project: "alpha", turnRunId: "R2" } } },
			{ input: { json: { project: "beta", turnRunId: "R1" } } },
			{ input: { json: { project: "alpha" } } },
		];
		for (const c of claims)
			expect((await call(access, token, c)).status).toBe(403);
		expect(seen).toHaveLength(0);
	});

	test("a batch is refused, even with only honest calls in it", async () => {
		const { socket, seen } = await setup();
		const access = await socket.issue(binding);
		const res = await fetch("http://x/trpc/brain.read?batch=1", {
			method: "POST",
			headers: { authorization: `Bearer ${await tokenOf(access)}` },
			body: JSON.stringify({
				"0": { json: { project: "alpha", turnRunId: "R1" } },
			}),
			unix: access.socketPath,
		} as RequestInit);
		expect(res.status).toBe(400);
		expect(seen).toHaveLength(0);
	});

	test("two turns hold two tokens; ending one leaves the other working", async () => {
		const { socket } = await setup();
		const a = await socket.issue(binding);
		const b = await socket.issue({ ...binding, runId: "R2" });
		expect(a.tokenFile).not.toBe(b.tokenFile);
		const ta = await tokenOf(a);
		const tb = await tokenOf(b);
		// A token is tied to its own turn's listener.
		expect(
			(
				await call(a, tb, {
					input: { json: { project: "alpha", turnRunId: "R1" } },
				})
			).status,
		).toBe(401);
		await socket.revoke("R1");
		await expect(call(a, ta)).rejects.toThrow();
		expect(
			(
				await call(b, ta, {
					input: { json: { project: "alpha", turnRunId: "R2" } },
				})
			).status,
		).toBe(401);
		expect(
			(
				await call(b, tb, {
					input: { json: { project: "alpha", turnRunId: "R2" } },
				})
			).status,
		).toBe(200);
	});

	test("only the brain's own procedures are served", async () => {
		const { socket, seen } = await setup();
		const access = await socket.issue(binding);
		const token = await tokenOf(access);
		for (const procedure of [
			"tasks.delete",
			"brain.setPaused",
			"brain.read,tasks.list",
			"brain.override",
		]) {
			expect((await call(access, token, { procedure })).status).toBe(403);
		}
		expect((await call(access, token, { procedure: "brain.act" })).status).toBe(
			200,
		);
		expect(
			(await call(access, token, { procedure: "brain.read,brain.act" })).status,
		).toBe(400);
		expect(seen).toHaveLength(1);
	});

	test("unparseable input is a 400, not a pass-through", async () => {
		const { socket, seen } = await setup();
		const access = await socket.issue(binding);
		const res = await fetch("http://x/trpc/brain.read", {
			method: "POST",
			headers: { authorization: `Bearer ${await tokenOf(access)}` },
			body: "{not json",
			unix: access.socketPath,
		} as RequestInit);
		expect(res.status).toBe(400);
		expect(seen).toHaveLength(0);
	});

	test("a socket with no router yet answers 503 rather than serving", async () => {
		const { socket } = await setup();
		socket.setHandler(null);
		expect(socket.ready).toBe(false);
		const access = await socket.issue(binding);
		expect((await call(access, await tokenOf(access))).status).toBe(503);
	});

	test("a restarted daemon forgets every token and sweeps their files", async () => {
		const { dir, socket } = await setup();
		const access = await socket.issue(binding);
		const old = await tokenOf(access);
		// Simulate a crash: the old process is gone but its files are not.
		const next = new BrainSocket(dir);
		sockets.push(next);
		next.setHandler(async () => new Response("{}"));
		const fresh = await next.issue({ ...binding, runId: "R9" });
		expect(await readdir(join(socketRoot(dir), "b"))).toEqual([
			basename(dirname(fresh.tokenFile)),
		]);
		expect(existsSync(access.tokenFile)).toBe(false);
		expect((await call(fresh, old)).status).toBe(401);
	});

	test("a turn's token does not work on another turn's socket", async () => {
		const { socket } = await setup();
		const a = await socket.issue(binding);
		const b = await socket.issue({ ...binding, runId: "R2" });
		expect(dirname(a.socketPath)).not.toBe(dirname(b.socketPath));
		expect((await call(b, await tokenOf(a))).status).toBe(401);
	});

	test("stop removes the socket and tokens", async () => {
		const { socket } = await setup();
		const access = await socket.issue(binding);
		await socket.stop();
		expect(existsSync(access.socketPath)).toBe(false);
		expect(existsSync(access.tokenFile)).toBe(false);
	});

	test("a very long home still gets a socket that fits", async () => {
		const dir = await home();
		const long = new BrainSocket(join(dir, "x".repeat(200), "y".repeat(200)));
		sockets.push(long);
		const access = await long.issue(binding);
		expect(Buffer.byteLength(access.socketPath)).toBeLessThanOrEqual(107);
		expect(access.socketPath.startsWith(dir)).toBe(false);
		expect(statSync(access.socketPath).mode & 0o777).toBe(0o600);
	});

	test("an unusable socket directory is refused with the fix", async () => {
		const prior = process.env.MFW_SOCKET_DIR;
		process.env.MFW_SOCKET_DIR = join(await home(), "z".repeat(110));
		try {
			const s = new BrainSocket(await home());
			await expect(s.issue(binding)).rejects.toThrow(/MFW_SOCKET_DIR/);
		} finally {
			if (prior === undefined) delete process.env.MFW_SOCKET_DIR;
			else process.env.MFW_SOCKET_DIR = prior;
		}
	});

	test("brainSocketFor shares one socket per home", async () => {
		const dir = await home();
		expect(brainSocketFor(dir)).toBe(brainSocketFor(`${dir}/`));
	});
});
