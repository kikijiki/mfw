import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appRouter } from "@mfw/api";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { parseMcpConfig } from "../../daemon/src/agents/acp-translate.ts";
import {
	BRAIN_SOCKET_ENDPOINT,
	BrainSocket,
} from "../../daemon/src/brain-runtime/brain-socket.ts";
import { makeBrainClient, makeClient } from "../src/client.ts";

/**
 * The brain's tools over the real socket: the real router behind the real
 * socket, a real `mfw mcp --brain` child process configured the way the daemon
 * writes the turn's MCP config.
 */

const MAIN = join(import.meta.dir, "../src/main.ts");
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const c of cleanups.splice(0).reverse()) await c();
});

async function rig() {
	const home = await mkdtemp(join(tmpdir(), "mfw-bsm-"));
	const socket = new BrainSocket(home);
	cleanups.push(async () => {
		await socket.stop();
		await rm(home, { recursive: true, force: true });
	});
	const reads: unknown[] = [];
	const acts: unknown[] = [];
	const svc = {
		brainRuntime: {
			reads: {
				read: async (tool: string, args: unknown, o: unknown) => {
					reads.push({ tool, args, o });
					return { tasks: [{ id: "T-1" }] };
				},
			},
			actions: {
				act: async (input: unknown) => {
					acts.push(input);
					return { actionId: "A1", status: "proposed" };
				},
			},
		},
	};
	const orchestrator = {
		get: (name: string) => {
			if (name !== "alpha" && name !== "beta")
				throw new Error(`unknown project '${name}'`);
			return svc;
		},
	};
	socket.setHandler((req, binding) =>
		fetchRequestHandler({
			endpoint: BRAIN_SOCKET_ENDPOINT,
			router: appRouter,
			req,
			createContext: () => ({
				orchestrator: orchestrator as never,
				principal: {
					kind: "brain" as const,
					id: `brain:${binding.runId}`,
					...binding,
				},
			}),
		}),
	);
	return { home, socket, reads, acts };
}

/** The env a daemon turn config carries, round-tripped through the ACP bridge's parser. */
async function turnEnv(
	home: string,
	socket: BrainSocket,
	runId: string,
): Promise<Record<string, string>> {
	const access = await socket.issue({
		project: "alpha",
		sessionId: "S1",
		runId,
	});
	const config = JSON.stringify({
		mcpServers: {
			mfw_brain: {
				command: "bun",
				args: ["run", MAIN, "--brain", "S1"],
				env: {
					MFW_SOCKET: access.socketPath,
					MFW_BRAIN_TOKEN_FILE: access.tokenFile,
					MFW_PROJECT: "alpha",
					MFW_BRAIN_SESSION: "S1",
					MFW_BRAIN_TURN: runId,
				},
			},
		},
	});
	const file = join(home, "mcp.json");
	await writeFile(file, config);
	const [server] = parseMcpConfig(config);
	if (!server) throw new Error("no server parsed");
	return Object.fromEntries(server.env.map((e) => [e.name, e.value]));
}

async function mcpChild(env: Record<string, string>) {
	const transport = new StdioClientTransport({
		command: "bun",
		args: ["run", MAIN, "--brain", "S1"],
		env: { ...(process.env as Record<string, string>), ...env },
		stderr: "pipe",
	});
	const client = new Client({ name: "t", version: "1" });
	await client.connect(transport);
	cleanups.push(() => client.close());
	return client;
}

const text = (r: unknown) =>
	((r as { content: { text: string }[] }).content[0] as { text: string }).text;

describe("brain tools over the socket", () => {
	test("a read and an act reach the router, attributed to the token's turn", async () => {
		const { home, socket, reads, acts } = await rig();
		const env = await turnEnv(home, socket, "R1");
		const client = await mcpChild(env);

		const read = await client.callTool({ name: "board", arguments: {} });
		expect(text(read)).toContain("T-1");
		expect(reads).toEqual([
			{ tool: "board", args: {}, o: { turnRunId: "R1" } },
		]);

		const act = await client.callTool({
			name: "note",
			arguments: { text: "hello", rationale: "because" },
		});
		expect(text(act)).toContain("proposed");
		expect(acts).toMatchObject([{ turnRunId: "R1", tool: "note" }]);
	});

	test("after the turn ends the same child is refused (stale-turn token)", async () => {
		const { home, socket, reads } = await rig();
		const env = await turnEnv(home, socket, "R1");
		const client = await mcpChild(env);
		await client.callTool({ name: "board", arguments: {} });
		await socket.revoke("R1");
		const res = await client.callTool({ name: "board", arguments: {} });
		expect((res as { isError?: boolean }).isError).toBe(true);
		expect(reads).toHaveLength(1);
	});

	test("a client that lies about its turn is refused by the daemon", async () => {
		const { home, socket, reads } = await rig();
		const env = await turnEnv(home, socket, "R1");
		await socket.issue({ project: "alpha", sessionId: "S1", runId: "R2" });
		const client = makeBrainClient({ ...env, MFW_BRAIN_TURN: "R2" });
		await expect(
			client.brain.read.query({
				project: "alpha",
				tool: "board",
				args: {},
				turnRunId: "R2",
			}),
		).rejects.toThrow();
		await expect(
			client.brain.read.query({
				project: "alpha",
				tool: "board",
				args: {},
				turnRunId: "R1",
			}),
		).rejects.toThrow();
		expect(reads).toHaveLength(0);
	});

	test("the brain cannot reach the rest of the API through the socket", async () => {
		const { home, socket } = await rig();
		const env = await turnEnv(home, socket, "R1");
		const client = makeBrainClient(env);
		await expect(
			client.brain.setPaused.mutate({ project: "alpha", paused: true }),
		).rejects.toThrow();
	});
});

describe("the token's binding holds on the parsed input (reviewer M2)", () => {
	async function exploit(path: string, body: unknown) {
		const { home, socket, acts } = await rig();
		const env = await turnEnv(home, socket, "R1");
		const token = (
			await Bun.file(env.MFW_BRAIN_TOKEN_FILE as string).text()
		).trim();
		const res = await fetch(`http://mfw-brain/trpc/${path}`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(body),
			unix: env.MFW_SOCKET,
		} as RequestInit);
		await res.text();
		return { status: res.status, acts };
	}
	const honest = { project: "alpha", turnRunId: "R1", tool: "t", args: {} };
	const other = { project: "beta", turnRunId: "R2", tool: "t", args: {} };

	test("a batch with an honest decoy does not reach brain.act", async () => {
		const r = await exploit("brain.act?batch=1", {
			json: honest,
			"0": { json: other },
		});
		expect(r.acts).toEqual([]);
		expect(r.status).toBe(400);
	});

	test("any batch is refused on this socket", async () => {
		const r = await exploit("brain.act?batch=1", { "0": { json: honest } });
		expect(r.acts).toEqual([]);
		expect(r.status).toBe(400);
	});

	test("superjson metadata cannot rewrite the project and turn", async () => {
		const r = await exploit("brain.act", {
			json: { ...honest, args: { p: "beta", r: "R2" } },
			meta: {
				referentialEqualities: {
					"args.p": ["project"],
					"args.r": ["turnRunId"],
				},
			},
		});
		expect(r.acts).toEqual([]);
		expect(r.status).toBe(403);
	});

	test("an honest single call still reaches brain.act", async () => {
		const r = await exploit("brain.act", { json: honest });
		expect(r.status).toBe(200);
		expect(r.acts).toHaveLength(1);
	});
});

describe("UI TCP stays open until auth v1 (C1)", () => {
	test("owner-side clients and a brain without MFW_SOCKET still use the TCP url", async () => {
		// `mfw mcp` (owner side) is unchanged: MFW_URL or the :7777 default.
		expect(makeClient()).toBeDefined();
		const original = process.env.MFW_URL;
		const seen: string[] = [];
		const server = Bun.serve({
			port: 0,
			fetch(req) {
				seen.push(new URL(req.url).pathname);
				return new Response("{}", { status: 500 });
			},
		});
		cleanups.push(async () => {
			await server.stop(true);
			if (original === undefined) delete process.env.MFW_URL;
			else process.env.MFW_URL = original;
		});
		const brain = makeBrainClient({
			MFW_URL: `http://127.0.0.1:${server.port}/mfw/api/trpc`,
		});
		await brain.brain.session.query({ project: "alpha" }).catch(() => {});
		expect(seen[0]).toStartWith("/mfw/api/trpc/");
	});

	test("MFW_SOCKET without a token file is a configuration error", () => {
		expect(() => makeBrainClient({ MFW_SOCKET: "/x/brain.sock" })).toThrow(
			/MFW_BRAIN_TOKEN_FILE/,
		);
	});
});
