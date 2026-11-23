import { createHash, randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * The brain's transport: a unix socket instead of unauthenticated TCP.
 *
 * The brain's MCP server is a child of an LLM harness, so anything it can
 * reach, the model can reach. Over TCP that was the whole UI API with no
 * credential. Here the daemon listens on `$MFW_HOME/run/brain.sock` (0600, in
 * a 0700 directory) and accepts only a bearer token minted for ONE turn,
 * written to a 0600 file whose path (never the secret) goes into the MCP
 * server's environment. The token is revoked when the turn ends, and a daemon
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

export type BrainSocketHandler = (req: Request) => Response | Promise<Response>;

/** Linux `sun_path` holds 108 bytes including the NUL. */
const MAX_SOCKET_PATH = 100;
const MAX_BODY_BYTES = 8 * 1024 * 1024;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const json = (status: number, message: string) =>
	new Response(JSON.stringify({ error: message }), {
		status,
		headers: { "content-type": "application/json" },
	});

export class BrainSocket {
	readonly dir: string;
	readonly socketPath: string;
	private readonly tokenDir: string;
	private handler: BrainSocketHandler | null = null;
	private server: ReturnType<typeof Bun.serve> | null = null;
	/** sha256(token) -> binding. */
	private readonly tokens = new Map<string, BrainTurnBinding>();
	/** runId -> sha256(token), to revoke by turn. */
	private readonly byRun = new Map<string, string>();
	private starting: Promise<void> | null = null;
	private readonly onExit = () => {
		try {
			unlinkSync(this.socketPath);
		} catch {}
	};

	constructor(home: string) {
		this.dir = join(resolve(home), "run");
		this.socketPath = join(this.dir, "brain.sock");
		this.tokenDir = join(this.dir, "brain-turn");
	}

	setHandler(handler: BrainSocketHandler | null): void {
		this.handler = handler;
	}

	/** True when a router is wired in, i.e. the socket can serve a turn. */
	get ready(): boolean {
		return this.handler !== null;
	}

	/** Mint a token for one turn, start listening if needed, return what the MCP server needs. */
	async issue(binding: BrainTurnBinding): Promise<BrainSocketAccess> {
		await this.start();
		this.revokeSync(binding.runId);
		const token = randomBytes(32).toString("base64url");
		const key = sha(token);
		const tokenFile = join(this.tokenDir, `${binding.runId}.token`);
		await writeFile(tokenFile, token, { mode: 0o600 });
		await chmod(tokenFile, 0o600);
		this.tokens.set(key, { ...binding });
		this.byRun.set(binding.runId, key);
		return { socketPath: this.socketPath, tokenFile };
	}

	/** End a turn's access: the token stops working and its file goes. Idempotent. */
	async revoke(runId: string): Promise<void> {
		this.revokeSync(runId);
		await rm(join(this.tokenDir, `${runId}.token`), { force: true });
	}

	private revokeSync(runId: string): void {
		const key = this.byRun.get(runId);
		if (key) this.tokens.delete(key);
		this.byRun.delete(runId);
	}

	/** Tokens currently valid (tests and status). */
	liveTurns(): string[] {
		return [...this.byRun.keys()];
	}

	async stop(): Promise<void> {
		this.tokens.clear();
		this.byRun.clear();
		const server = this.server;
		this.server = null;
		this.starting = null;
		process.off("exit", this.onExit);
		if (server) await server.stop(true);
		await rm(this.socketPath, { force: true });
		await rm(this.tokenDir, { recursive: true, force: true });
	}

	private start(): Promise<void> {
		if (this.server) return Promise.resolve();
		this.starting ??= this.listen().catch((e) => {
			this.starting = null;
			throw e;
		});
		return this.starting;
	}

	private async listen(): Promise<void> {
		if (this.socketPath.length > MAX_SOCKET_PATH)
			throw new Error(
				`the brain socket path is too long for a unix socket (${this.socketPath.length} > ${MAX_SOCKET_PATH}); set MFW_HOME to a shorter directory`,
			);
		// The directory is the real barrier (0700); the socket mode is belt and braces.
		await mkdir(this.dir, { recursive: true, mode: 0o700 });
		await chmod(this.dir, 0o700);
		// A previous daemon's tokens are dead with it: never leave their files around.
		await rm(this.tokenDir, { recursive: true, force: true });
		await mkdir(this.tokenDir, { recursive: true, mode: 0o700 });
		await rm(this.socketPath, { force: true });
		const prior = process.umask(0o177);
		try {
			this.server = Bun.serve({
				unix: this.socketPath,
				maxRequestBodySize: MAX_BODY_BYTES,
				fetch: (req) => this.serve(req),
			});
		} finally {
			process.umask(prior);
		}
		await chmod(this.socketPath, 0o600);
		// Never keep the process alive, and never leave a socket file behind.
		this.server.unref();
		process.on("exit", this.onExit);
	}

	private async serve(req: Request): Promise<Response> {
		const auth = req.headers.get("authorization") ?? "";
		const m = /^Bearer (\S+)$/.exec(auth);
		const binding = m?.[1] ? this.tokens.get(sha(m[1])) : undefined;
		if (!binding) return json(401, "unknown or revoked brain token");
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
		);
	}
}

/**
 * Every call's input must name the token's project and turn. tRPC batches are
 * `{"0": {json: input}, ...}`; a single call is `{json: input}`.
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
	const entries =
		"json" in parsed
			? [parsed as { json?: unknown }]
			: Object.values(parsed as Record<string, { json?: unknown }>);
	if (entries.length === 0)
		return { status: 400, message: "tRPC input is empty" };
	for (const e of entries) {
		const input = e && typeof e === "object" ? e.json : undefined;
		if (!input || typeof input !== "object")
			return { status: 400, message: "tRPC input is malformed" };
		const { project, turnRunId } = input as Record<string, unknown>;
		if (project !== binding.project || turnRunId !== binding.runId)
			return {
				status: 403,
				message: "the token was not issued for that project and turn",
			};
	}
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
