import { createHash, randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
	assertSocketPathFits,
	ensureSocketRoot,
	socketRoot,
} from "../containment/socket-root.ts";

/**
 * The brain's transport: a unix socket instead of unauthenticated TCP.
 *
 * The brain's MCP server is a child of an LLM harness, so anything it can
 * reach, the model can reach. Over TCP that was the whole UI API with no
 * credential. Here the daemon opens one listener per turn at
 * `$MFW_HOME/run/b/<hash>/brain.sock` (0600, in a 0700 directory) and accepts
 * only a bearer token minted for that turn, written to a 0600 file beside it
 * whose path (never the secret) goes into the MCP server's environment. The token is revoked when the turn ends, and a daemon
 * restart forgets every token, so a leaked or stale one buys nothing.
 *
 * The token binds the call: the project and the turn id the caller claims
 * (in the tRPC input and in `x-mfw-brain-turn`) must be the ones the token
 * was issued for, and only the brain's own procedures are served. The router
 * itself is injected (`setHandler`): `@mfw/api` depends on this package, so
 * the app wires its tRPC handler in at startup.
 *
 * The UI's TCP listener requires an owner session (auth v1), so this socket
 * is the brain's only working route to the API.
 */

export const BRAIN_TURN_HEADER = "x-mfw-brain-turn";
/** The path the injected handler is mounted at (its tRPC `endpoint`). */
export const BRAIN_SOCKET_ENDPOINT = "/trpc";
/** The only procedures a brain turn may call. */
export const BRAIN_PROCEDURES: ReadonlySet<string> = new Set([
	"brain.read",
	"brain.act",
]);

/** What a token is good for. */
export interface BrainTurnBinding {
	project: string;
	sessionId: string;
	runId: string;
}

export interface BrainSocketAccess {
	/** Value of `MFW_SOCKET`. */
	socketPath: string;
	/** Value of `MFW_BRAIN_TOKEN_FILE`. */
	tokenFile: string;
}

export type BrainSocketHandler = (
	req: Request,
	binding: BrainTurnBinding,
) => Response | Promise<Response>;

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const TURN_DIR_CHARS = 12;
/** Names inside a turn's directory, which a brain sandbox binds read-only. */
export const BRAIN_SOCKET_FILE = "brain.sock";
export const BRAIN_TOKEN_FILE = "token";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const json = (status: number, message: string) =>
	new Response(JSON.stringify({ error: message }), {
		status,
		headers: { "content-type": "application/json" },
	});

/** One turn's listener and the directory that is all its sandbox can see. */
interface TurnEndpoint {
	key: string;
	dir: string;
	socketPath: string;
	server: ReturnType<typeof Bun.serve>;
}

export class BrainSocket {
	private handler: BrainSocketHandler | null = null;
	private prepared: Promise<void> | null = null;
	/** sha256(token) -> binding. */
	private readonly tokens = new Map<string, BrainTurnBinding>();
	/** runId -> its token and listener, to revoke by turn. */
	private readonly byRun = new Map<string, TurnEndpoint>();
	private readonly onExit = () => {
		for (const turn of this.byRun.values()) {
			try {
				unlinkSync(turn.socketPath);
			} catch {}
		}
	};

	constructor(private readonly home: string) {}

	/**
	 * Short and outside `$MFW_HOME`, because a unix socket path is limited to
	 * 107 bytes: `<socket root>/b/<hash>/brain.sock` (socket-root.ts).
	 */
	get dir(): string {
		return socketRoot(this.home);
	}

	private get turnRoot(): string {
		return join(this.dir, "b");
	}

	setHandler(handler: BrainSocketHandler | null): void {
		this.handler = handler;
	}

	/** True when a router is wired in, i.e. the socket can serve a turn. */
	get ready(): boolean {
		return this.handler !== null;
	}

	/**
	 * Mint a token for one turn and open a listener only it can use. The turn's
	 * directory holds exactly that socket and token, so a sandbox binding it
	 * reaches no other turn.
	 */
	async issue(binding: BrainTurnBinding): Promise<BrainSocketAccess> {
		await this.prepare();
		await this.revoke(binding.runId);
		const turnDir = join(
			this.turnRoot,
			sha(binding.runId).slice(0, TURN_DIR_CHARS),
		);
		const socketPath = join(turnDir, BRAIN_SOCKET_FILE);
		assertSocketPathFits(socketPath, "brain socket");
		await rm(turnDir, { recursive: true, force: true });
		await mkdir(turnDir, { mode: 0o700 });
		await chmod(turnDir, 0o700);
		const token = randomBytes(32).toString("base64url");
		const key = sha(token);
		const tokenFile = join(turnDir, BRAIN_TOKEN_FILE);
		await writeFile(tokenFile, token, { mode: 0o600 });
		await chmod(tokenFile, 0o600);
		const runId = binding.runId;
		const prior = process.umask(0o177);
		let server: ReturnType<typeof Bun.serve>;
		try {
			server = Bun.serve({
				unix: socketPath,
				maxRequestBodySize: MAX_BODY_BYTES,
				fetch: (req) => this.serve(req, runId),
			});
		} finally {
			process.umask(prior);
		}
		await chmod(socketPath, 0o600);
		// Never keep the process alive, and never leave a socket file behind.
		server.unref();
		this.tokens.set(key, { ...binding });
		this.byRun.set(runId, { key, dir: turnDir, socketPath, server });
		return { socketPath, tokenFile };
	}

	/** End a turn's access: token, listener and directory all go. Idempotent. */
	async revoke(runId: string): Promise<void> {
		const turn = this.byRun.get(runId);
		if (!turn) return;
		this.tokens.delete(turn.key);
		this.byRun.delete(runId);
		await turn.server.stop(true);
		await rm(turn.dir, { recursive: true, force: true });
	}

	/** Tokens currently valid (tests and status). */
	liveTurns(): string[] {
		return [...this.byRun.keys()];
	}

	async stop(): Promise<void> {
		const turns = [...this.byRun.keys()];
		await Promise.all(turns.map((runId) => this.revoke(runId)));
		this.tokens.clear();
		this.prepared = null;
		process.off("exit", this.onExit);
		await rm(this.turnRoot, { recursive: true, force: true });
	}

	/** Once per daemon: a second run of it would delete a live turn's directory. */
	private prepare(): Promise<void> {
		this.prepared ??= this.sweepTurns().catch((e) => {
			this.prepared = null;
			throw e;
		});
		return this.prepared;
	}

	private async sweepTurns(): Promise<void> {
		// The directory is the real barrier (0700); the socket mode is belt and braces.
		ensureSocketRoot(this.home);
		// A previous daemon's tokens are dead with it: never leave their files around.
		await rm(this.turnRoot, { recursive: true, force: true });
		await mkdir(this.turnRoot, { recursive: true, mode: 0o700 });
		process.on("exit", this.onExit);
	}

	private async serve(req: Request, listenerRun: string): Promise<Response> {
		const auth = req.headers.get("authorization") ?? "";
		const m = /^Bearer (\S+)$/.exec(auth);
		const binding = m?.[1] ? this.tokens.get(sha(m[1])) : undefined;
		// A token works only on its own turn's listener.
		if (!binding || binding.runId !== listenerRun)
			return json(401, "unknown or revoked brain token");
		if (!this.handler) return json(503, "the brain socket has no router yet");

		const url = new URL(req.url);
		if (!url.pathname.startsWith(`${BRAIN_SOCKET_ENDPOINT}/`))
			return json(404, "not found");
		const procedures = decodeURIComponent(
			url.pathname.slice(BRAIN_SOCKET_ENDPOINT.length + 1),
		).split(",");
		const denied = procedures.find((p) => !BRAIN_PROCEDURES.has(p));
		if (denied)
			return json(403, `'${denied}' is not available to a brain turn`);
		// One call per request: the router enforces the binding on its parsed input.
		if (url.searchParams.has("batch") || procedures.length !== 1)
			return json(400, "batches are not accepted on the brain socket");

		const claimed = req.headers.get(BRAIN_TURN_HEADER);
		if (claimed !== null && claimed !== binding.runId)
			return json(403, "the token was not issued for that turn");

		let body: string | undefined;
		let rawInput: string | null;
		if (req.method === "GET") {
			rawInput = url.searchParams.get("input");
		} else if (req.method === "POST") {
			body = await req.text();
			rawInput = body;
		} else {
			return json(405, "method not allowed");
		}
		const mismatch = inputMismatch(rawInput, binding);
		if (mismatch) return json(mismatch.status, mismatch.message);

		// Attribution comes from the token, whatever the caller sent.
		const headers = new Headers(req.headers);
		headers.delete("authorization");
		headers.set(BRAIN_TURN_HEADER, binding.runId);
		return this.handler(
			new Request(req.url, {
				method: req.method,
				headers,
				...(body !== undefined ? { body } : {}),
			}),
			{ ...binding },
		);
	}
}

/**
 * An early refusal for a call that names the wrong project or turn. It reads
 * the raw JSON, so it is NOT the enforcement: the transformer can still change
 * values. `brainTurnBound` in `@mfw/api` checks the parsed input.
 */
function inputMismatch(
	raw: string | null,
	binding: BrainTurnBinding,
): { status: number; message: string } | null {
	if (!raw) return { status: 400, message: "missing tRPC input" };
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { status: 400, message: "tRPC input is not JSON" };
	}
	if (!parsed || typeof parsed !== "object")
		return { status: 400, message: "tRPC input is not an object" };
	const input = (parsed as { json?: unknown }).json;
	if (!input || typeof input !== "object")
		return { status: 400, message: "tRPC input is malformed" };
	const { project, turnRunId } = input as Record<string, unknown>;
	if (project !== binding.project || turnRunId !== binding.runId)
		return {
			status: 403,
			message: "the token was not issued for that project and turn",
		};
	return null;
}

const KEY = Symbol.for("mfw.brainSockets");
type Holder = { [KEY]?: Map<string, BrainSocket> };

/**
 * The one socket for a home. It lives on `globalThis` for the same reason the
 * orchestrator does: the production bundle can emit this module into more
 * than one chunk, and two sockets would fight over one path.
 */
export function brainSocketFor(home: string): BrainSocket {
	const holder = globalThis as unknown as Holder;
	holder[KEY] ??= new Map();
	const all = holder[KEY];
	const key = resolve(home);
	let s = all.get(key);
	if (!s) {
		s = new BrainSocket(key);
		all.set(key, s);
	}
	return s;
}
