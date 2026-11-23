import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BrainSocket } from "../src/brain-runtime/brain-socket.ts";
import { socketRoot } from "../src/containment/socket-root.ts";
import { type BrainUnit, brainUnit } from "./support/brain-unit.ts";

/**
 * How a brain turn is wired to the socket: the env and config a harness (and
 * the ACP bridge, via MFW_ACP_MCP_CONFIG) is given, and the token's lifetime.
 */

let u: BrainUnit | undefined;
let socket: BrainSocket | undefined;
let home: string | undefined;
const saved = process.env.MFW_BRAIN_TCP;
afterEach(async () => {
	await u?.cleanup();
	await socket?.stop();
	if (home) await rm(home, { recursive: true, force: true });
	u = socket = home = undefined;
	if (saved === undefined) delete process.env.MFW_BRAIN_TCP;
	else process.env.MFW_BRAIN_TCP = saved;
});

async function started() {
	home = await mkdtemp(join(tmpdir(), "mfw-brs-"));
	socket = new BrainSocket(home);
	socket.setHandler(async () => new Response("{}"));
	u = await brainUnit({ socket });
	await u.runtime.tick(); // creates the session at the current head
	await u.human();
	u.advance(60_000);
	expect((await u.runtime.tick()).state).toBe("started");
	const launched = u.launched[0];
	if (!launched) throw new Error("no turn launched");
	return launched;
}

describe("a brain turn's MCP server", () => {
	test("gets the socket and a token file, never a URL or the secret", async () => {
		const t = await started();
		const { env } = t.launch.mcp;
		expect(env.MFW_URL).toBeUndefined();
		expect(env.MFW_SOCKET?.startsWith(join(socketRoot(home ?? ""), "b"))).toBe(
			true,
		);
		expect(env.MFW_SOCKET?.endsWith("/brain.sock")).toBe(true);
		expect(env.MFW_BRAIN_TURN).toBe(t.runId);
		expect(env.MFW_PROJECT).toBe("unit");
		const file = env.MFW_BRAIN_TOKEN_FILE;
		// Beside the socket: that directory is all a turn's sandbox is given.
		expect(dirname(file ?? "")).toBe(dirname(env.MFW_SOCKET ?? ""));
		expect(statSync(file ?? "").mode & 0o777).toBe(0o600);

		// The generated config (what claude --mcp-config and MFW_ACP_MCP_CONFIG read) is the same
		// and holds no token: it is copied into project files by some bridges.
		const cfg = JSON.parse(await readFile(t.launch.mcpConfigPath, "utf8"));
		expect(cfg.mcpServers.mfw_brain.env).toEqual(env);
		const token = await readFile(file ?? "", "utf8");
		expect(JSON.stringify(cfg)).not.toContain(token);
		expect(JSON.stringify(t.launch)).not.toContain(token);
	});

	test("the token is revoked when the turn ends", async () => {
		const t = await started();
		const file = t.launch.mcp.env.MFW_BRAIN_TOKEN_FILE ?? "";
		expect(existsSync(file)).toBe(true);
		expect(socket?.liveTurns()).toEqual([t.runId]);
		await u?.endRun(t.runId);
		await u?.runtime.tick();
		expect((await u?.turns())?.[0]?.status).toBe("ok");
		expect(socket?.liveTurns()).toEqual([]);
		expect(existsSync(file)).toBe(false);
	});

	test("each turn gets its own token", async () => {
		const first = await started();
		await u?.endRun(first.runId);
		await u?.runtime.tick();
		await u?.human("again");
		u?.advance(60_000);
		await u?.runtime.tick();
		const second = u?.launched[1];
		expect(second?.runId).not.toBe(first.runId);
		expect(second?.launch.mcp.env.MFW_BRAIN_TOKEN_FILE).not.toBe(
			first.launch.mcp.env.MFW_BRAIN_TOKEN_FILE,
		);
	});
});

describe("the unix socket is the brain's only transport", () => {
	test("MFW_BRAIN_TCP=1 no longer selects TCP", async () => {
		process.env.MFW_BRAIN_TCP = "1";
		const t = await started();
		expect(t.launch.mcp.env.MFW_URL).toBeUndefined();
		expect(
			t.launch.mcp.env.MFW_SOCKET?.startsWith(socketRoot(home ?? "")),
		).toBe(true);
		expect(t.launch.mcp.env.MFW_SOCKET?.endsWith("/brain.sock")).toBe(true);
	});

	test("with no router wired to the socket no turn is launched and no token is minted", async () => {
		home = await mkdtemp(join(tmpdir(), "mfw-brs-"));
		socket = new BrainSocket(home);
		u = await brainUnit({ socket });
		await u.runtime.tick();
		await u.human();
		u.advance(60_000);
		await u.runtime.tick();
		expect(u.launched).toHaveLength(0);
		expect(socket.liveTurns()).toEqual([]);
		expect(existsSync(join(home, "run", "brain.sock"))).toBe(false);
	});
});
