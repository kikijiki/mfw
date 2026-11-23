#!/usr/bin/env bun
/**
 * Auth smoke test against the PRODUCTION BUILD, over raw sockets.
 *
 *   bun run build && bun run smoke:auth
 *
 * The unit tests call the guard directly, so they never see what the framework
 * does first: router normalisation, path spellings, malformed requests. This
 * sends the bytes itself, because `fetch` would normalise the very paths under
 * test. It runs one server on a private temporary MFW_HOME, with the usage
 * monitor off and agent CLIs removed from PATH, and stops it before exiting.
 */
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { validateTestHome } from "./root-test.ts";

const ROOT = resolve(import.meta.dir, "..");
const ENTRY = join(ROOT, "apps/start/.output/server/index.mjs");
const PASSWORD = "smoke test owner passphrase";
const Q = "brain.states";
const AGENT_CLI =
	/^(claude|codex|gemini|opencode|aider|goose|qwen|cursor-agent)$/;

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail: unknown = ""): void {
	if (ok) passed++;
	else failures.push(`${name}${detail === "" ? "" : ` -> ${String(detail)}`}`);
}

interface RawResponse {
	status: number;
	head: string;
	body: string;
}

/** Sends from a chosen loopback address: Bun's `net` ignores `localAddress`. */
const BOUND_CLIENT = `
import re, socket, sys
port, source = int(sys.argv[1]), sys.argv[2]
s = socket.socket()
s.settimeout(8)
s.bind((source, 0))
s.connect(("127.0.0.1", port))
s.sendall(sys.stdin.buffer.read())
data = b""
while True:
    at = data.find(b"\\r\\n\\r\\n")
    m = re.search(rb"content-length: (\\d+)", data[:at], re.I) if at >= 0 else None
    if m and len(data) - at - 4 >= int(m.group(1)):
        break
    chunk = s.recv(65536)
    if not chunk:
        break
    data += chunk
sys.stdout.buffer.write(data)
`;

async function rawFrom(
	port: number,
	payload: string,
	from: string,
): Promise<RawResponse> {
	const p = Bun.spawn(
		["python3", "-I", "-c", BOUND_CLIENT, String(port), from],
		{
			stdin: new TextEncoder().encode(payload),
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [buffer, stderr, exit] = await Promise.all([
		new Response(p.stdout).text(),
		new Response(p.stderr).text(),
		p.exited,
	]);
	if (exit !== 0) throw new Error(`bound client failed: ${stderr.slice(-300)}`);
	const at = buffer.indexOf("\r\n\r\n");
	const head = at >= 0 ? buffer.slice(0, at) : buffer;
	return {
		status: Number(/^HTTP\/1\.[01] (\d+)/.exec(head)?.[1] ?? 0),
		head,
		body: at >= 0 ? buffer.slice(at + 4) : "",
	};
}

function raw(
	port: number,
	payload: string,
	opts: { ms?: number; from?: string } = {},
): Promise<RawResponse> {
	if (opts.from) return rawFrom(port, payload, opts.from);
	return new Promise((done, fail) => {
		const socket = net.connect({ port, host: "127.0.0.1" });
		let buffer = "";
		const finish = () => {
			clearTimeout(timer);
			socket.destroy();
			const at = buffer.indexOf("\r\n\r\n");
			const head = at >= 0 ? buffer.slice(0, at) : buffer;
			done({
				status: Number(/^HTTP\/1\.[01] (\d+)/.exec(head)?.[1] ?? 0),
				head,
				body: at >= 0 ? buffer.slice(at + 4) : "",
			});
		};
		const timer = setTimeout(finish, opts.ms ?? 3000);
		socket.on("connect", () => socket.write(payload));
		socket.on("data", (d) => {
			buffer += d.toString("latin1");
			// Done at Content-Length: the server may hold the socket open after it.
			const at = buffer.indexOf("\r\n\r\n");
			const length = /content-length: (\d+)/i.exec(buffer.slice(0, at))?.[1];
			if (at >= 0 && length && buffer.length - at - 4 >= Number(length))
				finish();
		});
		socket.on("end", finish);
		socket.on("error", (e) => {
			if (buffer) finish();
			else {
				clearTimeout(timer);
				fail(e);
			}
		});
	});
}

function request(
	method: string,
	target: string,
	headers: Record<string, string> = {},
	body?: string,
): string {
	const all: Record<string, string> = {
		Host: "localhost",
		Connection: "close",
		...headers,
	};
	if (body !== undefined)
		all["Content-Length"] = String(Buffer.byteLength(body));
	const lines = Object.entries(all).map(([k, v]) => `${k}: ${v}`);
	return `${method} ${target} HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n${body ?? ""}`;
}

async function authPost(
	port: number,
	action: string,
	payload: unknown,
	headers: Record<string, string> = {},
	from?: string,
) {
	const res = await raw(
		port,
		request(
			"POST",
			`/mfw/api/auth/${action}`,
			{ "Content-Type": "application/json", "x-mfw-auth": "1", ...headers },
			JSON.stringify(payload),
		),
		{ ms: 8000, ...(from ? { from } : {}) },
	);
	const setCookie = /set-cookie: ([^\r\n]+)/i.exec(res.head)?.[1] ?? "";
	let json: Record<string, unknown> = {};
	try {
		json = JSON.parse(res.body);
	} catch {
		// a refusal without a JSON body
	}
	return {
		...res,
		cookie: setCookie.split(";")[0] ?? "",
		key: String(json.requestKey ?? ""),
		json,
	};
}

/** Every spelling the reviewer probed: traversal, encoding, case, internals. */
const PATHS = [
	"/",
	"/mfw",
	"/mfw/",
	"/mfw/settings",
	"//mfw/settings",
	"/mfw//settings",
	"/MFW/settings",
	"/mfw/settings/",
	"/mfw/./settings",
	"/mfw/login/../settings",
	"/mfw/%2e%2e/mfw/settings",
	"/mfw/login/..%2fsettings",
	"/mfw/login%2f..%2fsettings",
	"/mfw/login/",
	"/mfw/login;x",
	"/mfw/login%00",
	"/mfw/p/x/board",
	"/mfw/nonexistent",
	`/mfw/api/trpc/${Q}`,
	`//mfw/api/trpc/${Q}`,
	`/mfw//api/trpc/${Q}`,
	`/mfw/api//trpc/${Q}`,
	`/mfw/API/trpc/${Q}`,
	`/mfw/api/TRPC/${Q}`,
	`/mfw/api/trpc/${Q}/`,
	`/mfw/api/trpc//${Q}`,
	`/mfw/api/trpc/${Q}?batch=1&input=%7B%7D`,
	`/mfw/api/health/../trpc/${Q}`,
	`/mfw/api/health/..%2ftrpc%2f${Q}`,
	`/mfw/api/health%2f..%2ftrpc%2f${Q}`,
	`/mfw/assets/..%2fapi%2ftrpc%2f${Q}`,
	`/mfw/assets/%2e%2e/api/trpc/${Q}`,
	`/mfw/assets/..;/api/trpc/${Q}`,
	`/mfw/login/../api/trpc/${Q}`,
	`/mfw/icon.svg/../api/trpc/${Q}`,
	`/mfw/api/auth/state/../../trpc/${Q}`,
	`/mfw/api/auth/state%2f..%2f..%2ftrpc%2f${Q}`,
	`/api/trpc/${Q}`,
	`/mfw/mfw/api/trpc/${Q}`,
	"/mfw/api/files/p/x",
	"/mfw/api/docs/p/s/x",
	"/mfw/api/attachments/p/t/n",
	"/mfw/api/auth/logout",
	"/_serverFn/x",
	"/mfw/_serverFn/x",
	"/mfw/_serverFn/eyJ4IjoxfQ",
	"/_server",
	"/mfw/_server",
	"/__nitro",
	"/mfw/__nitro",
	"/_nitro",
	"/mfw/_nitro/tasks",
	"/_build",
	"/mfw/_build/manifest.json",
	"/mfw/@vite/client",
	"/mfw/@fs/etc/passwd",
	"/mfw/src/start.ts",
	"/mfw/.env",
	"/mfw/package.json",
	"/mfw/nitro.json",
	"/mfw/../.output/nitro.json",
	"/mfw/assets/..%2f..%2fnitro.json",
	"/mfw/assets/%2e%2e%2f%2e%2e%2fserver%2findex.mjs",
	"/mfw/assets/x.map",
	"/mfw/__tsd",
	"/mfw/__manifest",
	"/mfw/__tanstack",
	"/.well-known/x",
	"/mfw/.well-known/x",
	"/favicon.ico",
	"/mfw/favicon.ico",
];

/** The only paths in the matrix that may answer 2xx without a session. */
const OPEN = new Set(["/mfw/login", "/mfw/api/health"]);
const API_SPELLING = /\/api\/|\/api$|trpc|_serverfn/i;

function safePath(): string {
	const keep: string[] = [];
	for (const dir of (process.env.PATH ?? "").split(":")) {
		if (!dir) continue;
		let names: string[] = [];
		try {
			names = readdirSync(dir);
		} catch {
			continue;
		}
		if (!names.some((n) => AGENT_CLI.test(n))) keep.push(dir);
	}
	return keep.join(":");
}

async function freePort(): Promise<number> {
	return new Promise((done, fail) => {
		const s = net.createServer();
		s.once("error", fail);
		s.listen(0, "127.0.0.1", () => {
			const a = s.address();
			const port = typeof a === "object" && a ? a.port : 0;
			s.close(() => done(port));
		});
	});
}

async function matrix(
	port: number,
	cookie: string,
	key: string,
): Promise<void> {
	for (const path of PATHS) {
		const json = await raw(
			port,
			request("GET", path, { Accept: "application/json" }),
		);
		const html = await raw(port, request("GET", path, { Accept: "text/html" }));
		const anon = [json.status, html.status].some((s) => s >= 200 && s < 300);
		check(
			`no session: ${path}`,
			!anon || OPEN.has(path),
			`${json.status}/${html.status}`,
		);
		for (const r of [json, html])
			check(`never a 5xx: ${path}`, r.status < 500, r.status);

		if (API_SPELLING.test(path) && !OPEN.has(path)) {
			const stolen = await raw(
				port,
				request("GET", path, { Accept: "application/json", Cookie: cookie }),
			);
			check(
				`cookie alone: ${path}`,
				stolen.status < 200 || stolen.status >= 300,
				stolen.status,
			);
		}
		if (/trpc/i.test(path) && path !== `/mfw/api/trpc/${Q}`) {
			const full = await raw(
				port,
				request("GET", path, {
					Accept: "application/json",
					Cookie: cookie,
					"x-mfw-key": key,
				}),
			);
			// Dot segments normalise to the real URL before routing: the same resource.
			const same = new URL(path, "http://x").pathname === `/mfw/api/trpc/${Q}`;
			check(
				`non-canonical with key: ${path}`,
				same || full.status !== 200,
				full.status,
			);
		}
	}
}

async function streamEndsOnLogout(port: number): Promise<void> {
	const session = await authPost(port, "login", { password: PASSWORD });
	const socket = net.connect(port, "127.0.0.1");
	let buffer = "";
	let ended = false;
	socket.on("data", (d) => {
		buffer += d.toString();
	});
	socket.on("close", () => {
		ended = true;
	});
	socket.on("error", () => {
		ended = true;
	});
	socket.write(
		`GET /mfw/api/trpc/usage.changes HTTP/1.1\r\nHost: localhost\r\nAccept: text/event-stream\r\nCookie: ${session.cookie}\r\nx-mfw-key: ${session.key}\r\n\r\n`,
	);
	await Bun.sleep(600);
	check(
		"SSE opens with cookie and key",
		/text\/event-stream/i.test(buffer),
		buffer.slice(0, 80),
	);
	await raw(
		port,
		request("POST", "/mfw/api/auth/logout", {
			Cookie: session.cookie,
			"x-mfw-key": session.key,
		}),
	);
	await Bun.sleep(2000);
	check("SSE ends on logout", ended || /0\r\n\r\n$/.test(buffer));
	socket.destroy();

	for (const variant of ["usage.changes/", "usage%2Echanges"]) {
		const again = await authPost(port, "login", { password: PASSWORD });
		const res = await raw(
			port,
			request("GET", `/mfw/api/trpc/${variant}`, {
				Accept: "text/event-stream",
				Cookie: again.cookie,
				"x-mfw-key": again.key,
			}),
			{ ms: 800 },
		);
		check(`SSE spelling refused: ${variant}`, res.status === 404, res.status);
	}
}

async function perSourceThrottle(
	port: number,
	home: string,
	env: Record<string, string>,
): Promise<void> {
	const attacker = "127.0.0.2";
	for (let i = 0; i < 5; i++)
		await authPost(
			port,
			"login",
			{ password: `wrong guess number ${i}` },
			{},
			attacker,
		);
	const locked = await authPost(
		port,
		"login",
		{ password: PASSWORD },
		{},
		attacker,
	);
	check("the guessing address is locked", locked.status === 429, locked.status);
	const owner = await authPost(
		port,
		"login",
		{ password: PASSWORD },
		{},
		"127.0.0.1",
	);
	check("another address still signs in", owner.status === 200, owner.status);
	const cli = Bun.spawnSync(
		[
			process.execPath,
			"run",
			join(ROOT, "packages/cli/src/main.ts"),
			"auth",
			"unlock",
		],
		{
			cwd: ROOT,
			env: { ...env, MFW_HOME: home },
			stdout: "ignore",
			stderr: "ignore",
		},
	);
	check("mfw auth unlock exits 0", cli.exitCode === 0, cli.exitCode);
	const after = await authPost(
		port,
		"login",
		{ password: PASSWORD },
		{},
		attacker,
	);
	check(
		"unlock lets the locked address back in",
		after.status === 200,
		after.status,
	);
}

async function main(): Promise<number> {
	if (!existsSync(ENTRY)) {
		console.error("auth-smoke: no production build. Fix: bun run build");
		return 2;
	}
	const scratch = validateTestHome(mkdtempSync(join(tmpdir(), "mfw-test-")));
	const fakeHome = join(scratch, "home");
	const mfwHome = join(scratch, "mfw");
	mkdirSync(fakeHome);
	const port = await freePort();
	const env = {
		PATH: safePath(),
		HOME: fakeHome,
		MFW_HOME: mfwHome,
		PORT: String(port),
		HOST: "127.0.0.1",
		MFW_USAGE_MONITOR: "0",
		TMUX_TMPDIR: scratch,
		MFW_TMUX_SOCKET: `mfw-smoke-${process.pid}`,
	};
	const logFile = join(scratch, "server.log");
	const server = Bun.spawn([process.execPath, "run", ENTRY], {
		cwd: ROOT,
		env,
		stdout: Bun.file(logFile),
		stderr: Bun.file(logFile),
	});
	try {
		let up = false;
		for (let i = 0; i < 200 && !up; i++) {
			const r = await raw(port, request("GET", "/mfw/api/health"), {
				ms: 500,
			}).catch(() => null);
			up = r?.status === 200;
			if (!up) await Bun.sleep(100);
		}
		if (!up)
			throw new Error(
				`server did not start:\n${readFileSync(logFile, "utf8").slice(-1500)}`,
			);
		const tokenFile = join(mfwHome, "setup-token");
		for (let i = 0; i < 50 && !existsSync(tokenFile); i++) await Bun.sleep(100);
		const token = readFileSync(tokenFile, "utf8").trim();
		check(
			"the setup token is not in the server log",
			!readFileSync(logFile, "utf8").includes(token),
		);

		const setup = await authPost(port, "setup", { token, password: PASSWORD });
		check("setup succeeds", setup.status === 200, setup.status);
		const state = await raw(
			port,
			request("GET", "/mfw/api/auth/state", { Cookie: setup.cookie }),
		);
		check("state never returns the key", !state.body.includes(setup.key));
		check(
			"a cookie alone is not signed in",
			state.body.includes('"login"'),
			state.body,
		);
		const control = await raw(
			port,
			request("GET", `/mfw/api/trpc/${Q}`, {
				Cookie: setup.cookie,
				"x-mfw-key": setup.key,
			}),
		);
		check(
			"control: cookie and key read the API",
			control.status === 200,
			control.status,
		);
		const sibling = await raw(
			port,
			request("GET", `/mfw/api/trpc/${Q}`, {
				Cookie: setup.cookie,
				"x-mfw-key": setup.key,
				"Sec-Fetch-Site": "same-site",
			}),
		);
		check("same-site API call refused", sibling.status === 403, sibling.status);

		for (const [name, payload] of [
			[
				"port out of range",
				"GET /mfw/api/health HTTP/1.1\r\nHost: localhost:99999\r\nConnection: close\r\n\r\n",
			],
			["HTTP/1.0 without Host", "GET /mfw/api/health HTTP/1.0\r\n\r\n"],
		] as const) {
			const r = await raw(port, payload);
			check(`malformed request is a 400: ${name}`, r.status === 400, r.status);
		}

		await matrix(port, setup.cookie, setup.key);
		await streamEndsOnLogout(port);
		await perSourceThrottle(port, mfwHome, env);
		check(
			"no agent CLI ran",
			!existsSync(join(fakeHome, ".codex")) &&
				!existsSync(join(fakeHome, ".claude")),
		);
	} finally {
		server.kill("SIGTERM");
		await Promise.race([server.exited, Bun.sleep(5000)]);
		server.kill("SIGKILL");
		await server.exited;
		rmSync(validateTestHome(scratch), { recursive: true, force: true });
	}
	console.log(`auth-smoke: ${passed} passed, ${failures.length} failed`);
	for (const f of failures.slice(0, 40)) console.log(`  FAIL ${f}`);
	return failures.length ? 1 : 0;
}

if (import.meta.main) process.exit(await main());
