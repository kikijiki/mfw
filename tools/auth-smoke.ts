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
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	rmdirSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { validateTestHome } from "./root-test.ts";

const ROOT = resolve(import.meta.dir, "..");
/** `MFW_SMOKE_ENTRY` runs the same checks against another build, such as an old one. */
const ENTRY =
	process.env.MFW_SMOKE_ENTRY ??
	join(ROOT, "apps/start/.output/server/index.mjs");
/**
 * `MFW_SMOKE_INSTALL=<prefix>` runs them against a compiled install instead:
 * the server is its `mfw server`, every CLI call its compiled `mfw`, and the
 * start-up refusals its pinned runtime running its bundle directly, because
 * `mfw server` supplies a loopback HOST when none is set.
 */
const INSTALL = process.env.MFW_SMOKE_INSTALL
	? resolve(process.env.MFW_SMOKE_INSTALL)
	: null;
function installedBundleArgv(prefix: string): string[] {
	const lib = join(prefix, "lib/mfw");
	const manifest = JSON.parse(readFileSync(join(lib, "install.json"), "utf8"));
	const runtime = String(manifest.runtime.path);
	return [
		runtime.startsWith("/") ? runtime : resolve(lib, runtime),
		"--config=/dev/null",
		"--no-env-file",
		"run",
		join(lib, "server/index.mjs"),
	];
}
/** The command line that starts the server under test. */
const SERVER_ARGV = INSTALL
	? [join(INSTALL, "bin/mfw"), "server"]
	: [process.execPath, "run", ENTRY];
/** The same server, started past `mfw server`, for the bind refusals. */
const BUNDLE_ARGV = INSTALL
	? installedBundleArgv(INSTALL)
	: [process.execPath, "run", ENTRY];
/** The `mfw` CLI under test. */
const MFW_CLI = INSTALL
	? [join(INSTALL, "bin/mfw")]
	: [process.execPath, "run", join(ROOT, "packages/cli/src/main.ts")];
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
	const unixPath = opts.from?.startsWith("unix:") ? opts.from.slice(5) : null;
	if (opts.from && !unixPath) return rawFrom(port, payload, opts.from);
	return new Promise((done, fail) => {
		const socket = unixPath
			? net.connect({ path: unixPath })
			: net.connect({ port, host: "127.0.0.1" });
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
	// The session's cookie: the other Set-Cookie headers delete shadow cookies.
	const setCookie =
		[...res.head.matchAll(/set-cookie: ([^\r\n]+)/gi)]
			.map((m) => m[1] as string)
			.find((c) => !/Max-Age=0/i.test(c)) ?? "";
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

function unlock(home: string, env: Record<string, string>): number | null {
	return Bun.spawnSync([...MFW_CLI, "auth", "unlock"], {
		cwd: ROOT,
		env: { ...env, MFW_HOME: home },
		stdout: "ignore",
		stderr: "ignore",
	}).exitCode;
}

/** N1: every loopback address is one source, so rotating them buys nothing. */
async function loopbackIsOneSource(
	port: number,
	home: string,
	env: Record<string, string>,
): Promise<void> {
	let evaluated = 0;
	for (let i = 1; i <= 9; i++) {
		const r = await authPost(
			port,
			"login",
			{ password: `wrong guess number ${i}` },
			{},
			`127.66.0.${i}`,
		);
		if (r.status === 401) evaluated++;
	}
	check(
		"rotating 127.x addresses does not escape the lock",
		evaluated <= 5,
		`${evaluated} guesses evaluated`,
	);
	const shared = await authPost(
		port,
		"login",
		{ password: PASSWORD },
		{},
		"127.0.0.1",
	);
	check(
		"agents and the owner share the loopback bucket",
		shared.status === 429,
		shared.status,
	);
	check(
		"the refusal says when to retry",
		/retry-after: \d+/i.test(shared.head),
		shared.head.slice(0, 60),
	);
	check("mfw auth unlock exits 0", unlock(home, env) === 0);
	const after = await authPost(
		port,
		"login",
		{ password: PASSWORD },
		{},
		"127.0.0.1",
	);
	check("unlock lets the owner back in", after.status === 200, after.status);
}

const BOGUS = "A".repeat(43);

/** N2: a planted cookie is sent first, and must not hide the real one. */
async function plantedCookie(port: number): Promise<void> {
	const session = await authPost(port, "login", { password: PASSWORD });
	const value = session.cookie.split("=")[1] as string;
	const both = `mfw_session=${BOGUS}; mfw_session=${value}`;
	const api = await raw(
		port,
		request("GET", `/mfw/api/trpc/${Q}`, {
			Cookie: both,
			"x-mfw-key": session.key,
		}),
	);
	check(
		"a shadow cookie does not hide the real session",
		api.status === 200,
		api.status,
	);
	const state = await raw(
		port,
		request("GET", "/mfw/api/auth/state", {
			Cookie: both,
			"x-mfw-key": session.key,
		}),
	);
	check(
		"state sees the real session behind a shadow",
		state.body.includes("authenticated"),
		state.body,
	);
	const relogin = await authPost(
		port,
		"login",
		{ password: PASSWORD },
		{ Cookie: `mfw_session=${BOGUS}` },
	);
	check(
		"login works with a planted cookie",
		relogin.status === 200,
		relogin.status,
	);
	const cleared = [...relogin.head.matchAll(/set-cookie: ([^\r\n]+)/gi)].map(
		(m) => m[1] as string,
	);
	check(
		"login clears shadow cookies on the longer paths",
		cleared.some((c) => /Path=\/mfw\/api(;|$)/.test(c) && /Max-Age=0/.test(c)),
		cleared.length,
	);
	const fresh = (cleared.find((c) => !/Max-Age=0/.test(c)) ?? "").split(
		";",
	)[0] as string;
	const afterLogin = await raw(
		port,
		request("GET", `/mfw/api/trpc/${Q}`, {
			Cookie: `mfw_session=${BOGUS}; ${fresh}`,
			"x-mfw-key": relogin.key,
		}),
	);
	check(
		"the new session works behind the planted cookie",
		afterLogin.status === 200,
		afterLogin.status,
	);
	const stolen = await raw(
		port,
		request("GET", `/mfw/api/trpc/${Q}`, { Cookie: both }),
	);
	check(
		"several cookies without the key are still refused",
		stolen.status === 403,
		stolen.status,
	);
}

/** N2 in a real browser: script on a sibling localhost port plants the cookie. */
async function plantedCookieInChrome(
	port: number,
	scratch: string,
): Promise<void> {
	const chromeBin = Bun.which("google-chrome") ?? Bun.which("chromium");
	if (!chromeBin) {
		if (process.env.MFW_SMOKE_CHROME === "1")
			check("Chrome is available", false);
		else console.log("auth-smoke: no Chrome on PATH, browser case not run");
		return;
	}
	const sibling = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () =>
			new Response("<!doctype html><title>sibling</title>", {
				headers: { "content-type": "text/html" },
			}),
	});
	const cdpPort = await freePort();
	const chrome = Bun.spawn(
		[
			chromeBin,
			"--headless=new",
			"--no-sandbox",
			"--disable-gpu",
			"--disable-dev-shm-usage",
			"--no-first-run",
			"--disable-background-networking",
			"--disable-component-update",
			"--no-proxy-server",
			`--user-data-dir=${join(scratch, "chrome")}`,
			`--remote-debugging-port=${cdpPort}`,
			"--remote-debugging-address=127.0.0.1",
			"about:blank",
		],
		{
			env: { PATH: process.env.PATH ?? "", HOME: join(scratch, "home") },
			stdout: "ignore",
			stderr: "ignore",
		},
	);
	let ws: WebSocket | null = null;
	try {
		let target: { type: string; webSocketDebuggerUrl: string } | undefined;
		for (let i = 0; i < 150 && !target; i++) {
			try {
				const list = (await (
					await fetch(`http://127.0.0.1:${cdpPort}/json`)
				).json()) as { type: string; webSocketDebuggerUrl: string }[];
				target = list.find((t) => t.type === "page");
			} catch {
				// not up yet
			}
			if (!target) await Bun.sleep(100);
		}
		if (!target) throw new Error("Chrome did not start");
		const socket = new WebSocket(target.webSocketDebuggerUrl);
		ws = socket;
		await new Promise((r) =>
			socket.addEventListener("open", r, { once: true }),
		);
		let id = 0;
		const pending = new Map<
			number,
			(v: { result?: { result?: { value?: unknown } } }) => void
		>();
		socket.addEventListener("message", (m) => {
			const d = JSON.parse(String(m.data));
			if (d.id) pending.get(d.id)?.(d);
		});
		const send = (method: string, params: unknown = {}) =>
			new Promise<{ result?: { result?: { value?: unknown } } }>((done) => {
				const i = ++id;
				pending.set(i, done);
				socket.send(JSON.stringify({ id: i, method, params }));
			});
		const ev = async (expression: string) =>
			(
				await send("Runtime.evaluate", {
					expression,
					awaitPromise: true,
					returnByValue: true,
				})
			).result?.result?.value;
		const until = async (expression: string, ms = 45_000) => {
			const end = Date.now() + ms;
			while (Date.now() < end) {
				try {
					if (await ev(expression)) return true;
				} catch {
					// navigating
				}
				await Bun.sleep(150);
			}
			return false;
		};
		const app = `http://localhost:${port}/mfw`;
		// `document.cookie` cannot see a cookie scoped to a longer path.
		const hasPlanted = async () => {
			const r = (await send("Network.getCookies", {
				urls: [`${app}/api/trpc/x`],
			})) as unknown as { result?: { cookies?: { value: string }[] } };
			return (r.result?.cookies ?? []).some((c) => c.value === BOGUS);
		};
		const KEY = "mfw:auth:request-key";
		await send("Page.enable");
		await send("Runtime.enable");
		await send("Page.navigate", { url: `${app}/login` });
		await until(
			`location.pathname === '/mfw/login' && document.readyState === 'complete'`,
		);
		const signedIn = await ev(
			`fetch('/mfw/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-mfw-auth': '1' }, body: ${JSON.stringify(JSON.stringify({ password: PASSWORD }))} }).then(async (r) => { if (r.ok) localStorage.setItem(${JSON.stringify(KEY)}, (await r.json()).requestKey); return r.status; })`,
		);
		check("Chrome: signs in", signedIn === 200, signedIn);
		const key = await ev(`localStorage.getItem(${JSON.stringify(KEY)})`);

		await send("Page.navigate", { url: `http://localhost:${sibling.port}/` });
		await until(`document.title === 'sibling'`);
		await ev(
			`document.cookie = "mfw_session=${BOGUS}; path=/mfw/api; max-age=31536000"`,
		);
		check("Chrome: the sibling page planted the cookie", await hasPlanted());

		await send("Page.navigate", { url: `${app}/settings` });
		await until(
			`location.pathname === '/mfw/settings' && document.readyState === 'complete'`,
		);
		await Bun.sleep(2500);
		check(
			"Chrome: a planted cookie does not bounce the owner to login",
			(await ev("location.pathname")) === "/mfw/settings",
			await ev("location.href"),
		);
		check(
			"Chrome: a planted cookie does not wipe the key",
			(await ev(`localStorage.getItem(${JSON.stringify(KEY)})`)) === key,
		);
		const status = await ev(
			`fetch('/mfw/api/trpc/${Q}', { headers: { 'x-mfw-key': localStorage.getItem(${JSON.stringify(KEY)}) ?? '' } }).then((r) => r.status)`,
		);
		check(
			"Chrome: the API still answers behind the planted cookie",
			status === 200,
			status,
		);
		const again = await ev(
			`fetch('/mfw/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-mfw-auth': '1' }, body: ${JSON.stringify(JSON.stringify({ password: PASSWORD }))} }).then(async (r) => { if (r.ok) localStorage.setItem(${JSON.stringify(KEY)}, (await r.json()).requestKey); return r.status; })`,
		);
		const afterLogin = await ev(
			`fetch('/mfw/api/trpc/${Q}', { headers: { 'x-mfw-key': localStorage.getItem(${JSON.stringify(KEY)}) ?? '' } }).then((r) => r.status)`,
		);
		check(
			"Chrome: signing in again works with the planted cookie",
			again === 200 && afterLogin === 200,
			`${again}/${afterLogin}`,
		);
		await send("Page.navigate", { url: `http://localhost:${sibling.port}/` });
		await until(`document.title === 'sibling'`);
		check("Chrome: login removed the planted cookie", !(await hasPlanted()));
	} finally {
		try {
			ws?.close();
		} catch {
			// already closed
		}
		chrome.kill("SIGKILL");
		await chrome.exited;
		sibling.stop(true);
	}
}

/** N3: a login racing a password change must not outlive it. */
async function loginRacingPasswordChange(
	port: number,
	home: string,
	env: Record<string, string>,
): Promise<void> {
	let current = PASSWORD;
	let survived = 0;
	for (let trial = 0; trial < 12; trial++) {
		unlock(home, env);
		const owner = await authPost(port, "login", { password: current });
		const next = `race trial passphrase number ${trial}`;
		const change = authPost(
			port,
			"password",
			{ current, next },
			{ Cookie: owner.cookie, "x-mfw-key": owner.key },
		);
		const stale = authPost(
			port,
			"login",
			{ password: current },
			{},
			"127.0.9.9",
		);
		const [changed, late] = await Promise.all([change, stale]);
		if (changed.status === 200) current = next;
		if (late.status === 200) {
			const use = await raw(
				port,
				request("GET", `/mfw/api/trpc/${Q}`, {
					Cookie: late.cookie,
					"x-mfw-key": late.key,
				}),
			);
			if (changed.status === 200 && use.status === 200) survived++;
		}
	}
	check(
		"no login with the old password survives a change",
		survived === 0,
		`${survived} of 12 survived`,
	);
}

const EXTERNAL = "box.example.test:8443";
/** Real socket peers: only the first is named in MFW_TRUSTED_PROXIES. */
const PROXY_PEER = "127.0.0.2";
const OTHER_PEER = "127.0.0.3";

function viaProxy(
	client: string,
	extra: Record<string, string> = {},
): Record<string, string> {
	return {
		Host: EXTERNAL,
		"X-Forwarded-For": client,
		"X-Forwarded-Proto": "https",
		"X-Forwarded-Host": EXTERNAL,
		...extra,
	};
}

/** The server must exit with the fix, and never accept a connection. */
async function refusesToStart(
	name: string,
	base: Record<string, string>,
	bind: Record<string, string>,
	scratch: string,
): Promise<void> {
	const port = await freePort();
	const logFile = join(scratch, `refused-${passed}-${failures.length}.log`);
	const p = Bun.spawn(BUNDLE_ARGV, {
		cwd: ROOT,
		env: { ...base, ...bind, PORT: String(port) },
		stdout: Bun.file(logFile),
		stderr: Bun.file(logFile),
	});
	const exit = await Promise.race([p.exited, Bun.sleep(15000).then(() => -1)]);
	if (exit === -1) p.kill("SIGKILL");
	await p.exited;
	const log = readFileSync(logFile, "utf8");
	check(`${name}: exits 1`, exit === 1, exit);
	check(`${name}: prints the fix`, log.includes("refusing to start"), log);
	const open = await raw(port, request("GET", "/mfw/api/health"), {
		ms: 300,
	}).catch(() => null);
	check(`${name}: nothing is listening`, open === null, open?.status);
}

/**
 * Review F3: a build made with any NODE_ENV still refuses. Point
 * `MFW_SMOKE_ENTRY` at a `NODE_ENV=development` build and set
 * `MFW_SMOKE_REFUSALS=1` to run only this against it.
 */
async function refusalsInDevelopmentMode(): Promise<void> {
	const scratch = validateTestHome(mkdtempSync(join(tmpdir(), "mfw-test-")));
	const fakeHome = join(scratch, "home");
	mkdirSync(fakeHome);
	const base = {
		PATH: safePath(),
		HOME: fakeHome,
		MFW_HOME: join(scratch, "mfw"),
		MFW_USAGE_MONITOR: "0",
		MFW_DISABLE_ORCHESTRATOR: "1",
		TMUX_TMPDIR: scratch,
		MFW_TMUX_SOCKET: `mfw-smoke-dev-${process.pid}`,
		NODE_ENV: "development",
	};
	try {
		await refusesToStart("NODE_ENV=development, no HOST", base, {}, scratch);
		await refusesToStart(
			"NODE_ENV=development, every interface",
			base,
			{ HOST: "0.0.0.0" },
			scratch,
		);
		await refusesToStart(
			"NODE_ENV=development, plain non-loopback",
			base,
			{ HOST: "192.0.2.1" },
			scratch,
		);
	} finally {
		rmSync(validateTestHome(scratch), { recursive: true, force: true });
	}
}

/** C4: the production build behind a fake TLS proxy, over real socket peers. */
async function trustedProxy(): Promise<void> {
	const scratch = validateTestHome(mkdtempSync(join(tmpdir(), "mfw-test-")));
	const fakeHome = join(scratch, "home");
	const mfwHome = join(scratch, "mfw");
	mkdirSync(fakeHome);
	const port = await freePort();
	const base = {
		PATH: safePath(),
		HOME: fakeHome,
		MFW_HOME: mfwHome,
		MFW_USAGE_MONITOR: "0",
		MFW_DISABLE_ORCHESTRATOR: "1",
		TMUX_TMPDIR: scratch,
		MFW_TMUX_SOCKET: `mfw-smoke-proxy-${process.pid}`,
	};
	const logFile = join(scratch, "server.log");
	const logFd = openSync(logFile, "a");
	const server = Bun.spawn(SERVER_ARGV, {
		cwd: ROOT,
		env: {
			...base,
			PORT: String(port),
			HOST: "127.0.0.1",
			MFW_TRUSTED_PROXIES: PROXY_PEER,
			MFW_ALLOWED_HOSTS: EXTERNAL,
		},
		// One descriptor: two writers on the same file overwrite each other.
		stdout: logFd,
		stderr: logFd,
	});
	const get = (headers: Record<string, string>, from = PROXY_PEER) =>
		raw(port, request("GET", "/mfw/api/auth/state", headers), { from });
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
				`proxied server did not start:\n${readFileSync(logFile, "utf8").slice(-1500)}`,
			);
		check(
			"proxy: a loopback trusted proxy prints the forgery warning",
			/WARNING: .*ANY LOCAL PROCESS/.test(readFileSync(logFile, "utf8")),
		);
		const tokenFile = join(mfwHome, "setup-token");
		for (let i = 0; i < 50 && !existsSync(tokenFile); i++) await Bun.sleep(100);
		const token = readFileSync(tokenFile, "utf8").trim();

		const forged = await authPost(
			port,
			"setup",
			{ token: "x".repeat(43), password: PASSWORD },
			viaProxy("203.0.113.1"),
			OTHER_PEER,
		);
		check(
			"proxy: an untrusted peer's headers are refused",
			forged.status === 403,
			forged.status,
		);

		const setup = await authPost(
			port,
			"setup",
			{ token, password: PASSWORD },
			viaProxy("203.0.113.1", { Origin: `https://${EXTERNAL}` }),
			PROXY_PEER,
		);
		check("proxy: setup through the proxy", setup.status === 200, setup.status);
		const set = /set-cookie: (__Secure-mfw_session=[^\r\n]+)/i.exec(
			setup.head.replace(/set-cookie: [^\r\n]*Max-Age=0[^\r\n]*\r\n/gi, ""),
		)?.[1];
		check(
			"proxy: cookie has the __Secure- name",
			!!set,
			setup.head.slice(0, 200),
		);
		check("proxy: cookie is Secure", /; Secure/.test(set ?? ""), set);
		check("proxy: cookie is HttpOnly", /; HttpOnly/.test(set ?? ""), set);
		check(
			"proxy: cookie is SameSite=Strict",
			/SameSite=Strict/.test(set ?? ""),
			set,
		);
		check(
			"proxy: cookie Path is the base",
			/Path=\/mfw(;|$)/.test(set ?? ""),
			set,
		);

		const api = (headers: Record<string, string>, from = PROXY_PEER) =>
			raw(port, request("GET", `/mfw/api/trpc/${Q}`, headers), { from });
		const signedIn = { Cookie: setup.cookie, "x-mfw-key": setup.key };
		const ok = await api(viaProxy("203.0.113.1", signedIn));
		check("proxy: cookie and key read the API", ok.status === 200, ok.status);
		const planted = await api(
			viaProxy("203.0.113.1", {
				Cookie: `__Secure-mfw_session=${"A".repeat(43)}; ${setup.cookie}`,
				"x-mfw-key": setup.key,
			}),
		);
		check(
			"proxy: a cookie planted by a sibling port is harmless",
			planted.status === 200,
			planted.status,
		);
		const stolen = await api(viaProxy("203.0.113.1", { Cookie: setup.cookie }));
		check(
			"proxy: the cookie alone is refused",
			stolen.status === 403,
			stolen.status,
		);

		for (const [name, headers, want] of [
			["same origin", { Origin: `https://${EXTERNAL}` }, 200],
			["http Origin", { Origin: `http://${EXTERNAL}` }, 403],
			["sibling HTTPS port", { Origin: "https://box.example.test:9443" }, 403],
			["foreign Origin", { Origin: "https://evil.example" }, 403],
			["unlisted forwarded host", { "X-Forwarded-Host": "evil.example" }, 403],
			[
				"sibling forwarded port",
				{ "X-Forwarded-Host": "box.example.test:9443" },
				403,
			],
			["forwarded loopback", { "X-Forwarded-Host": "localhost" }, 403],
			["proto http", { "X-Forwarded-Proto": "http" }, 403],
			["malformed client", { "X-Forwarded-For": "not-an-address" }, 403],
			["client with a port", { "X-Forwarded-For": "203.0.113.1:99" }, 403],
			[
				"both header families",
				{ Forwarded: "for=203.0.113.1;proto=https" },
				403,
			],
		] as const) {
			const r = await get(viaProxy("203.0.113.1", headers));
			check(`proxy: ${name} -> ${want}`, r.status === want, r.status);
		}

		// Bun keeps only the last of repeated lines and the app cannot see the
		// others, so what can be enforced is that a bad final value never passes.
		for (const [name, line] of [
			["X-Forwarded-Proto", "X-Forwarded-Proto: http"],
			["X-Forwarded-Host", "X-Forwarded-Host: evil.example"],
			["X-Forwarded-For", "X-Forwarded-For: not-an-address"],
		] as const) {
			const payload = request(
				"GET",
				"/mfw/api/auth/state",
				viaProxy("203.0.113.1"),
			);
			const r = await raw(
				port,
				payload.replace("\r\n\r\n", `\r\n${line}\r\n\r\n`),
				{
					from: PROXY_PEER,
				},
			);
			check(
				`proxy: a repeated ${name} ending in a bad value is refused`,
				r.status === 403,
				r.status,
			);
		}

		const direct = await get({ Host: EXTERNAL }, PROXY_PEER);
		check(
			"proxy: a listed host without forwarded headers is refused",
			direct.status === 403,
			direct.status,
		);
		const local = await get({ Host: "localhost" }, OTHER_PEER);
		check(
			"proxy: the local browser path still works",
			local.status === 200,
			local.status,
		);

		for (let i = 0; i < 5; i++)
			await authPost(
				port,
				"login",
				{ password: "wrong password!" },
				viaProxy("203.0.113.7"),
				PROXY_PEER,
			);
		const locked = await authPost(
			port,
			"login",
			{ password: PASSWORD },
			viaProxy("203.0.113.7"),
			PROXY_PEER,
		);
		check(
			"proxy: a client locks its own bucket",
			locked.status === 429,
			locked.status,
		);
		const other = await authPost(
			port,
			"login",
			{ password: PASSWORD },
			viaProxy("203.0.113.8"),
			PROXY_PEER,
		);
		check(
			"proxy: another client is not locked",
			other.status === 200,
			other.status,
		);
		const hidden = await authPost(
			port,
			"login",
			{ password: PASSWORD },
			viaProxy("10.1.1.1, 203.0.113.7"),
			PROXY_PEER,
		);
		check(
			"proxy: a forged left entry stays in the client's bucket",
			hidden.status === 429,
			hidden.status,
		);

		// Review F1: tailnet nodes normally share a /64.
		for (let i = 0; i < 5; i++)
			await authPost(
				port,
				"login",
				{ password: "wrong password!" },
				viaProxy("fd7a:115c:a1e0::aaaa"),
				PROXY_PEER,
			);
		const tailnetPeer = await authPost(
			port,
			"login",
			{ password: PASSWORD },
			viaProxy("fd7a:115c:a1e0::bbbb"),
			PROXY_PEER,
		);
		check(
			"proxy: one tailnet IPv6 device does not lock out another",
			tailnetPeer.status === 200,
			tailnetPeer.status,
		);

		let evaluated = 0;
		for (let i = 0; i < 9; i++) {
			const r = await authPost(
				port,
				"login",
				{ password: "wrong password!" },
				{ "X-Forwarded-For": `198.51.100.${i}` },
				OTHER_PEER,
			);
			if (r.status === 401) evaluated++;
		}
		check(
			"proxy: rotating the header from an untrusted peer does not rotate its bucket",
			evaluated <= 5,
			evaluated,
		);
	} finally {
		server.kill("SIGTERM");
		await Promise.race([server.exited, Bun.sleep(5000)]);
		server.kill("SIGKILL");
		await server.exited;
	}
	try {
		await refusesToStart(
			"plain HTTP on a non-loopback address",
			base,
			{ HOST: "192.0.2.1" },
			scratch,
		);
		await refusesToStart("every interface", base, { HOST: "0.0.0.0" }, scratch);
		await refusesToStart(
			"every interface over IPv6",
			base,
			{ HOST: "::" },
			scratch,
		);
		await refusesToStart("no HOST", base, {}, scratch);
		// Review F4: these bound the unspecified address when a proxy was set.
		for (const HOST of [
			"0:0:0:0:0:0:0:0",
			"::0",
			"0000::",
			"::ffff:0.0.0.0",
			"00.0.0.0",
		])
			await refusesToStart(
				`unspecified spelling ${HOST}`,
				base,
				{
					HOST,
					MFW_TRUSTED_PROXIES: PROXY_PEER,
					MFW_ALLOWED_HOSTS: EXTERNAL,
				},
				scratch,
			);
		await refusesToStart(
			"a wildcard allowed host",
			base,
			{ HOST: "127.0.0.1", MFW_ALLOWED_HOSTS: "*.ts.net" },
			scratch,
		);
		await refusesToStart(
			"a trust-everyone proxy list",
			base,
			{ HOST: "127.0.0.1", MFW_TRUSTED_PROXIES: "0.0.0.0/0" },
			scratch,
		);
	} finally {
		rmSync(validateTestHome(scratch), { recursive: true, force: true });
	}
}

/**
 * What a process inside a real verifier-role sandbox gets connecting to `path`,
 * through the current launch path (profile, `compileBwrap`, `launchSandbox`).
 * `control` is a socket the host serves inside the sandbox's own tree.
 */
function connectFromSandbox(
	path: string,
	scratch: string,
	fakeHome: string,
): { control: string; target: string } {
	mkdirSync(join(scratch, "sandbox-clone"), { recursive: true });
	const r = Bun.spawnSync(
		[
			process.execPath,
			join(ROOT, "tools/sandbox-connect-probe.ts"),
			scratch,
			fakeHome,
			path,
		],
		{ cwd: ROOT, env: { PATH: process.env.PATH ?? "", HOME: fakeHome } },
	);
	try {
		return JSON.parse(r.stdout.toString().trim().split("\n").pop() ?? "");
	} catch {
		const failed = `failed: ${r.stdout.toString()}${r.stderr.toString()}`;
		return { control: failed, target: failed };
	}
}

/** Review F2: Serve targets a private socket that local processes cannot forge on. */
async function unixSocketProxy(): Promise<void> {
	const scratch = validateTestHome(mkdtempSync(join(tmpdir(), "mfw-test-")));
	const fakeHome = join(scratch, "home");
	const mfwHome = join(scratch, "mfw");
	const socketPath = join(mfwHome, "serve", "mfw.sock");
	mkdirSync(fakeHome);
	const base = {
		PATH: safePath(),
		HOME: fakeHome,
		MFW_USAGE_MONITOR: "0",
		MFW_DISABLE_ORCHESTRATOR: "1",
		TMUX_TMPDIR: scratch,
		MFW_TMUX_SOCKET: `mfw-smoke-unix-${process.pid}`,
		HOST: "127.0.0.1",
		MFW_ALLOWED_HOSTS: EXTERNAL,
	};
	const unix = `unix:${socketPath}`;
	const serve = (client: string, extra: Record<string, string> = {}) =>
		viaProxy(client, { Host: "localhost", ...extra });
	const start = (port: number, name: string) => {
		const logFile = join(scratch, `${name}.log`);
		// The bundle itself: SIGKILL below must reach the server, not `mfw server`.
		return Bun.spawn(BUNDLE_ARGV, {
			cwd: ROOT,
			env: {
				...base,
				MFW_HOME: mfwHome,
				MFW_LISTEN_SOCKET: socketPath,
				PORT: String(port),
			},
			stdout: Bun.file(logFile),
			stderr: Bun.file(logFile),
		});
	};
	const waitForSocket = async () => {
		for (let i = 0; i < 100; i++) {
			const r = await raw(
				0,
				request("GET", "/mfw/api/auth/state", serve("203.0.113.1")),
				{
					from: unix,
					ms: 500,
				},
			).catch(() => null);
			if (r?.status === 200) return true;
			await Bun.sleep(100);
		}
		return false;
	};
	const stop = async (
		p: ReturnType<typeof Bun.spawn>,
		signal: "SIGTERM" | "SIGKILL",
	) => {
		p.kill(signal);
		await Promise.race([p.exited, Bun.sleep(5000)]);
		p.kill("SIGKILL");
		await p.exited;
	};
	const port = await freePort();
	let server = start(port, "first");
	try {
		const listening = await waitForSocket();
		check("unix: the server listens on the socket", listening);
		if (!listening) return;
		check(
			"unix: socket is 0600",
			(statSync(socketPath).mode & 0o777) === 0o600,
		);
		check(
			"unix: its directory is 0700",
			(statSync(join(mfwHome, "serve")).mode & 0o777) === 0o700,
		);

		const token = readFileSync(join(mfwHome, "setup-token"), "utf8").trim();
		const setup = await authPost(
			0,
			"setup",
			{ token, password: PASSWORD },
			serve("203.0.113.1", { Origin: `https://${EXTERNAL}` }),
			unix,
		);
		check(
			"unix: setup through the proxy socket",
			setup.status === 200,
			setup.status,
		);
		check(
			"unix: the cookie is __Secure-",
			setup.cookie.startsWith("__Secure-mfw_session="),
			setup.cookie.slice(0, 24),
		);
		const bare = await raw(0, request("GET", "/mfw/api/auth/state"), {
			from: unix,
		});
		check(
			"unix: a request without forwarded headers is refused",
			bare.status === 403,
			bare.status,
		);

		for (let i = 0; i < 5; i++)
			await authPost(
				0,
				"login",
				{ password: "wrong password!" },
				serve("fd7a:115c:a1e0::aaaa"),
				unix,
			);
		const locked = await authPost(
			0,
			"login",
			{ password: PASSWORD },
			serve("fd7a:115c:a1e0::aaaa"),
			unix,
		);
		check(
			"unix: a client locks its own bucket",
			locked.status === 429,
			locked.status,
		);
		const other = await authPost(
			0,
			"login",
			{ password: PASSWORD },
			serve("fd7a:115c:a1e0::bbbb"),
			unix,
		);
		check(
			"unix: another client is not locked",
			other.status === 200,
			other.status,
		);

		const forged = await raw(
			port,
			request("GET", "/mfw/api/auth/state", viaProxy("203.0.113.1")),
		);
		check(
			"unix: forwarded headers over loopback TCP are not trusted",
			forged.status === 403,
			forged.status,
		);
		let evaluated = 0;
		for (let i = 0; i < 9; i++) {
			const r = await authPost(
				port,
				"login",
				{ password: "wrong password!" },
				{ "X-Forwarded-For": `198.51.100.${i}` },
			);
			if (r.status === 401) evaluated++;
		}
		check(
			"unix: forged clients over loopback TCP share one bucket",
			evaluated <= 5,
			evaluated,
		);

		const outside = await new Promise<string>((done) => {
			const s = net.connect({ path: socketPath });
			s.on("connect", () => {
				s.destroy();
				done("connected");
			});
			s.on("error", (e: NodeJS.ErrnoException) => done(String(e.code)));
		});
		check(
			"unix: control, the host can connect",
			outside === "connected",
			outside,
		);
		const inside = connectFromSandbox(socketPath, scratch, fakeHome);
		check(
			"unix: control, a verifier-role sandbox sees a socket mounted into it",
			inside.control.startsWith("socket:"),
			inside.control,
		);
		check(
			"unix: a verifier-role sandbox cannot reach the socket",
			inside.target === "ENOENT:ENOENT",
			inside.target,
		);

		const second = Bun.spawn(BUNDLE_ARGV, {
			cwd: ROOT,
			env: {
				...base,
				MFW_HOME: mfwHome,
				MFW_LISTEN_SOCKET: socketPath,
				PORT: String(await freePort()),
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const secondExit = await Promise.race([
			second.exited,
			Bun.sleep(15000).then(() => -1),
		]);
		if (secondExit === -1) second.kill("SIGKILL");
		await second.exited;
		check(
			"unix: a live socket is never taken over",
			secondExit === 1,
			secondExit,
		);
		const still = await raw(
			0,
			request("GET", "/mfw/api/auth/state", serve("203.0.113.1")),
			{ from: unix },
		);
		check(
			"unix: the first server still answers",
			still.status === 200,
			still.status,
		);

		await stop(server, "SIGTERM");
		check("unix: the socket is removed on exit", !existsSync(socketPath));
		server = start(port, "second");
		check("unix: restarts after a clean exit", await waitForSocket());
		await stop(server, "SIGKILL");
		check(
			"unix: control, SIGKILL leaves a stale socket",
			existsSync(socketPath),
		);
		server = start(port, "third");
		check("unix: a stale socket is replaced", await waitForSocket());
	} finally {
		await stop(server, "SIGTERM");
	}
	try {
		const bad = async (
			name: string,
			prepare: (home: string, sock: string) => void,
		) => {
			const home = join(scratch, `bad-${passed}-${failures.length}`);
			const sock = join(home, "serve", "mfw.sock");
			mkdirSync(join(home, "serve"), { recursive: true, mode: 0o700 });
			prepare(home, sock);
			await refusesToStart(
				`unix: ${name}`,
				base,
				{ MFW_HOME: home, MFW_LISTEN_SOCKET: sock },
				scratch,
			);
			return sock;
		};
		const victim = join(scratch, "victim");
		writeFileSync(victim, "keep me\n");
		await bad("a symlink at the path", (_h, s) => symlinkSync(victim, s));
		check(
			"unix: the symlink target is untouched",
			readFileSync(victim, "utf8") === "keep me\n",
		);
		const file = await bad("a regular file at the path", (_h, s) =>
			writeFileSync(s, "keep me\n"),
		);
		check(
			"unix: the regular file is untouched",
			readFileSync(file, "utf8") === "keep me\n",
		);
		await bad("a group-readable directory", (h) =>
			chmodSync(join(h, "serve"), 0o750),
		);
		await bad("a symlinked directory", (h) => {
			const real = join(h, "real");
			mkdirSync(real, { mode: 0o700 });
			rmdirSync(join(h, "serve"));
			symlinkSync(real, join(h, "serve"));
		});
		await refusesToStart(
			"unix: a path outside MFW_HOME",
			base,
			{
				MFW_HOME: mfwHome,
				MFW_LISTEN_SOCKET: join(scratch, "elsewhere", "mfw.sock"),
			},
			scratch,
		);
		await refusesToStart(
			"unix: a relative path",
			base,
			{ MFW_HOME: mfwHome, MFW_LISTEN_SOCKET: "serve/mfw.sock" },
			scratch,
		);
		await refusesToStart(
			"unix: no exact external host",
			{ ...base, MFW_ALLOWED_HOSTS: "" },
			{ MFW_HOME: mfwHome, MFW_LISTEN_SOCKET: socketPath },
			scratch,
		);
	} finally {
		rmSync(validateTestHome(scratch), { recursive: true, force: true });
	}
}

/** One tRPC call over a raw socket; the input goes through superjson's plain shape. */
function trpcRequest(
	type: "query" | "mutation",
	path: string,
	input: unknown,
	headers: Record<string, string>,
): string {
	const encoded = JSON.stringify({ json: input });
	return type === "query"
		? request(
				"GET",
				`/mfw/api/trpc/${path}?input=${encodeURIComponent(encoded)}`,
				headers,
			)
		: request(
				"POST",
				`/mfw/api/trpc/${path}`,
				{ "Content-Type": "application/json", ...headers },
				encoded,
			);
}

/** Speak MCP to the real `mfw mcp` over stdio and call one tool. */
async function mcpToolCall(
	env: Record<string, string>,
	args: string[],
	tool: string,
	toolArgs: Record<string, unknown>,
): Promise<string> {
	const child = Bun.spawn([...MFW_CLI, "mcp", ...args], {
		cwd: ROOT,
		env,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "ignore",
	});
	const send = (message: unknown) => {
		child.stdin.write(`${JSON.stringify(message)}\n`);
		child.stdin.flush();
	};
	const reader = child.stdout.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const until = async (id: number): Promise<string> => {
		const deadline = Date.now() + 15_000;
		for (;;) {
			for (const line of buffer.split("\n"))
				if (line.includes(`"id":${id}`)) return line;
			const left = deadline - Date.now();
			if (left <= 0) return "";
			const next = await Promise.race([
				reader.read(),
				Bun.sleep(left).then(() => null),
			]);
			if (!next || next.done) return "";
			buffer += decoder.decode(next.value);
		}
	};
	try {
		send({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-03-26",
				capabilities: {},
				clientInfo: { name: "auth-smoke", version: "0" },
			},
		});
		await until(1);
		send({ jsonrpc: "2.0", method: "notifications/initialized" });
		send({
			jsonrpc: "2.0",
			id: 2,
			method: "tools/call",
			params: { name: tool, arguments: toolArgs },
		});
		return await until(2);
	} finally {
		child.kill("SIGKILL");
		await child.exited;
	}
}

async function scopedTokens(
	port: number,
	owner: { cookie: string; key: string },
	scratch: string,
	mfwHome: string,
	env: Record<string, string>,
	logFile: string,
): Promise<void> {
	const session = { Cookie: owner.cookie, "x-mfw-key": owner.key };
	const mint = async (body: Record<string, unknown>) => {
		const r = await authPost(port, "tokens", body, session);
		return {
			status: r.status,
			token: String(r.json.token ?? ""),
			id: String((r.json.info as { id?: string } | undefined)?.id ?? ""),
		};
	};
	const bearer = (token: string, more: Record<string, string> = {}) => ({
		Authorization: `Bearer ${token}`,
		...more,
	});

	// A real project, so board reads, writes and the audit stream are real.
	const repo = join(scratch, "repo");
	mkdirSync(repo);
	for (const argv of [
		["init", "-q", "-b", "main"],
		[
			"-c",
			"user.name=smoke",
			"-c",
			"user.email=smoke@localhost",
			"commit",
			"-q",
			"--allow-empty",
			"-m",
			"init",
		],
	])
		Bun.spawnSync(["git", ...argv], { cwd: repo, env });
	const templates = await raw(
		port,
		trpcRequest("query", "system.boardTemplates", undefined, session),
	);
	const template = /"id":"([^"]+)"/.exec(templates.body)?.[1];
	const added = await raw(
		port,
		trpcRequest(
			"mutation",
			"system.addProject",
			{
				name: "smoke",
				root: repo,
				boardRoot: join(repo, "board"),
				createBoardFolder: true,
				template,
				integrationBranch: "main",
				schedulerAutostart: false,
			},
			session,
		),
		{ ms: 15_000 },
	);
	check(
		"tokens: the test project is added",
		added.status === 200,
		added.body.slice(0, 200),
	);

	const reader = await mint({ name: "reader", scopes: ["board:read"] });
	const writer = await mint({ name: "writer", scopes: ["board:write"] });
	const everything = await mint({
		name: "all",
		scopes: ["status:read", "board:read", "board:write", "runs:act"],
	});
	const unknownProject = await mint({
		name: "other",
		scopes: ["board:read"],
		project: "not-this-one",
	});
	check(
		"tokens: the server refuses a project that does not exist",
		unknownProject.status === 400,
		unknownProject.status,
	);
	// The CLI only warns, so it can still produce a token bound elsewhere.
	const otherProject = {
		token: Bun.spawnSync(
			[
				...MFW_CLI,
				"auth",
				"token",
				"create",
				"--name",
				"other",
				"--scope",
				"board:read",
				"--project",
				"not-this-one",
			],
			{ cwd: ROOT, env },
		)
			.stdout.toString()
			.trim(),
	};
	check(
		"tokens: the owner mints",
		reader.status === 200 && reader.token.startsWith("mfwt_"),
		reader.status,
	);
	const listed = await raw(
		port,
		request("GET", "/mfw/api/auth/tokens", session),
	);
	check(
		"tokens: the list holds no secret",
		listed.status === 200 && !listed.body.includes(reader.token),
		listed.status,
	);
	check(
		"tokens: the secret is not stored in the clear",
		!readFileSync(join(mfwHome, "auth.db"), "latin1").includes(reader.token),
	);

	const project = { project: "smoke" };
	const status = async (
		token: string,
		type: "query" | "mutation",
		path: string,
		input: unknown,
		more: Record<string, string> = {},
	) =>
		(await raw(port, trpcRequest(type, path, input, bearer(token, more))))
			.status;

	check(
		"tokens: in-scope read through the production stack",
		(await status(reader.token, "query", "tasks.list", project)) === 200,
	);
	check(
		"tokens: out-of-scope read refused",
		(await status(reader.token, "query", "system.health", {})) === 403,
	);
	check(
		"tokens: write refused to a read token",
		(await status(reader.token, "mutation", "tasks.create", {
			...project,
			title: "x",
		})) === 403,
	);
	check(
		"tokens: in-scope write",
		(await status(writer.token, "mutation", "tasks.create", {
			...project,
			title: "from a token",
		})) === 200,
	);
	check(
		"tokens: a task cannot carry a command",
		(await status(everything.token, "mutation", "tasks.create", {
			...project,
			title: "x",
			verification: {
				verifier: "deterministic",
				checks: [{ run: "true", expect_exit: 0 }],
			},
		})) === 403,
	);
	check(
		"tokens: owner-only refused with every scope",
		(await status(everything.token, "query", "settings.get", project)) === 403,
	);
	check(
		"tokens: another project's token refused",
		(await status(otherProject.token, "query", "tasks.list", project)) === 403,
	);
	check(
		"tokens: a foreign Origin refused",
		(await status(reader.token, "query", "tasks.list", project, {
			Origin: "https://evil.example",
		})) === 403,
	);
	check(
		"tokens: a cross-site fetch refused",
		(await status(reader.token, "query", "tasks.list", project, {
			"Sec-Fetch-Site": "cross-site",
		})) === 403,
	);

	const refusedBody = await raw(
		port,
		trpcRequest("query", "settings.get", project, bearer(reader.token)),
	);
	check(
		"tokens: an API error carries no stack or server path",
		refusedBody.status === 403 &&
			!refusedBody.body.includes('"stack"') &&
			!refusedBody.body.includes(ROOT),
		refusedBody.body.slice(0, 200),
	);

	const inCookie = await raw(
		port,
		trpcRequest("query", "tasks.list", project, {
			Cookie: `mfw_session=${reader.token}`,
		}),
	);
	check(
		"tokens: not accepted as a cookie",
		inCookie.status === 401,
		inCookie.status,
	);
	const inUrl = await raw(
		port,
		request(
			"GET",
			`/mfw/api/trpc/tasks.list?access_token=${reader.token}&input=${encodeURIComponent(JSON.stringify({ json: project }))}`,
		),
	);
	check("tokens: not accepted in the URL", inUrl.status === 401, inUrl.status);
	const batch = await raw(
		port,
		request(
			"GET",
			`/mfw/api/trpc/tasks.list?batch=1&input=${encodeURIComponent(JSON.stringify({ "0": { json: project } }))}`,
			bearer(reader.token),
		),
	);
	check("tokens: batches refused", batch.status === 400, batch.status);

	for (const [method, path] of [
		["GET", "/mfw/api/auth/tokens"],
		["POST", "/mfw/api/auth/tokens"],
		["POST", "/mfw/api/auth/password"],
		["POST", "/mfw/api/auth/sign-out-everywhere"],
		["GET", "/mfw/api/files/smoke/README.md"],
		["GET", "/mfw/settings"],
	] as const) {
		const r = await raw(
			port,
			request(
				method,
				path,
				{
					...bearer(everything.token),
					...(method === "POST"
						? { "Content-Type": "application/json", "x-mfw-auth": "1" }
						: {}),
				},
				method === "POST" ? "{}" : undefined,
			),
		);
		check(`tokens: ${method} ${path} refused`, r.status === 403, r.status);
	}

	// The real `mfw mcp`, from the 0600 file that `mfw auth token create` writes.
	const mcpEnv = { ...env, MFW_URL: `http://127.0.0.1:${port}/mfw/api/trpc` };
	const created = Bun.spawnSync(
		[
			...MFW_CLI,
			"auth",
			"token",
			"create",
			"--name",
			"mcp",
			"--scope",
			"board:read",
			"--write-file",
			"--origin",
			`http://127.0.0.1:${port}`,
		],
		{ cwd: ROOT, env },
	);
	check(
		"tokens: the CLI creates a token file",
		created.exitCode === 0,
		created.stderr.toString().slice(0, 200),
	);
	const tokenArgs = ["--token-file", join(mfwHome, "mcp-token")];
	const implicit = await mcpToolCall(mcpEnv, [], "list_tasks", project);
	check(
		"tokens: the stored token is not sent to a non-default MFW_URL",
		!implicit.includes("from a token"),
		implicit.slice(0, 200),
	);
	const viaMcp = await mcpToolCall(mcpEnv, tokenArgs, "list_tasks", project);
	check(
		"tokens: mfw mcp reads with its token",
		viaMcp.includes("from a token"),
		viaMcp.slice(0, 200),
	);
	const mcpDenied = await mcpToolCall(mcpEnv, tokenArgs, "health", {});
	check(
		"tokens: mfw mcp is held to its scope",
		/needs the status:read scope/.test(mcpDenied),
		mcpDenied.slice(0, 200),
	);

	const openStream = (token: string) => {
		const socket = net.connect(port, "127.0.0.1");
		const state = { buffer: "", ended: false, socket };
		socket.on("data", (d) => {
			state.buffer += d.toString();
		});
		socket.on("close", () => {
			state.ended = true;
		});
		socket.on("error", () => {
			state.ended = true;
		});
		const input = encodeURIComponent(JSON.stringify({ json: project }));
		socket.write(
			`GET /mfw/api/trpc/live.events?input=${input} HTTP/1.1\r\nHost: localhost\r\nAccept: text/event-stream\r\nAuthorization: Bearer ${token}\r\n\r\n`,
		);
		return state;
	};
	const finished = (s: { buffer: string; ended: boolean }) =>
		s.ended || /0\r\n\r\n$/.test(s.buffer);

	const live = await mint({ name: "stream", scopes: ["board:read"] });
	const stream = openStream(live.token);
	await Bun.sleep(600);
	check(
		"tokens: a stream opens",
		/text\/event-stream/i.test(stream.buffer),
		stream.buffer.slice(0, 80),
	);
	check(
		"tokens: the stream is still open before revocation",
		!finished(stream),
	);
	await authPost(port, "token-revoke", { id: live.id }, session);
	await Bun.sleep(300);
	check("tokens: revocation ends the stream at once", finished(stream));
	stream.socket.destroy();

	const cliLive = await mint({ name: "stream-cli", scopes: ["board:read"] });
	const cliStream = openStream(cliLive.token);
	await Bun.sleep(600);
	check(
		"tokens: a second stream opens",
		/text\/event-stream/i.test(cliStream.buffer),
	);
	const revoked = Bun.spawnSync(
		[...MFW_CLI, "auth", "token", "revoke", cliLive.id],
		{ cwd: ROOT, env },
	);
	check(
		"tokens: the CLI revokes",
		revoked.exitCode === 0,
		revoked.stderr.toString().slice(0, 200),
	);
	await Bun.sleep(1800);
	check(
		"tokens: a CLI revocation ends the stream within the recheck",
		finished(cliStream),
	);
	cliStream.socket.destroy();
	check(
		"tokens: a revoked token gets 401",
		(await status(live.token, "query", "tasks.list", project)) === 401,
	);

	const noisy = await mint({ name: "noisy", scopes: ["board:read"] });
	let limited = 0;
	await Promise.all(
		Array.from({ length: 8 }, async () => {
			for (let i = 0; i < 25 && limited === 0; i++)
				if (
					(await status(noisy.token, "query", "board.schema", project)) === 429
				)
					limited++;
		}),
	);
	check("tokens: the rate limit answers 429", limited > 0);

	// A real scheduler tick. It promotes only with a brain route, and no agent CLI
	// is on this PATH, so nothing can launch. The owner's task proves the tick ran.
	const ownerCall = (
		type: "query" | "mutation",
		path: string,
		input: unknown,
	) => raw(port, trpcRequest(type, path, input, session), { ms: 10_000 });
	const idOf = (body: string) => /"id":"([^"]+)"/.exec(body)?.[1] ?? "";
	const statusOf = async (id: string) =>
		/"status":"([a-z_]+)"/.exec(
			(await ownerCall("query", "tasks.get", { ...project, id })).body,
		)?.[1];
	const victim = idOf(
		(
			await ownerCall("mutation", "tasks.create", {
				...project,
				title: "waiting for a spec",
			})
		).body,
	);
	const control = idOf(
		(
			await ownerCall("mutation", "tasks.create", {
				...project,
				title: "control",
				body: "the owner's spec",
			})
		).body,
	);
	const parkedByToken = idOf(
		(
			await raw(
				port,
				trpcRequest(
					"mutation",
					"tasks.create",
					{ ...project, title: "token task", body: "token text" },
					bearer(writer.token),
				),
			)
		).body,
	);
	check(
		"tokens: board:write cannot give a waiting task a body",
		(await status(writer.token, "mutation", "tasks.update", {
			...project,
			id: victim,
			patch: { body: "orders from a token" },
		})) === 403,
	);
	check(
		"tokens: board:write cannot give a waiting task a criterion",
		(await status(writer.token, "mutation", "tasks.criteria", {
			...project,
			id: victim,
			op: { op: "add", text: "orders from a token" },
		})) === 403,
	);
	await ownerCall("mutation", "settings.update", {
		...project,
		patch: {
			brain: { routes: [{ provider: "claude-cli" }], maxTurnsPerHour: 1 },
		},
	});
	await ownerCall("mutation", "system.scheduler.set", {
		...project,
		enabled: true,
	});
	let controlStatus: string | undefined;
	for (let i = 0; i < 40 && controlStatus !== "ready"; i++) {
		await ownerCall("mutation", "system.scheduler.kick", project);
		await Bun.sleep(250);
		controlStatus = await statusOf(control);
	}
	check(
		"tokens: the scheduler tick ran",
		controlStatus === "ready",
		controlStatus,
	);
	const victimStatus = await statusOf(victim);
	const parkedStatus = await statusOf(parkedByToken);
	await ownerCall("mutation", "system.scheduler.set", {
		...project,
		enabled: false,
	});
	await ownerCall("mutation", "settings.update", {
		...project,
		patch: { brain: null },
	});
	check(
		"tokens: the task a token tried to write stays in backlog",
		victimStatus === "backlog",
		victimStatus,
	);
	check(
		"tokens: a token's own task stays in backlog through a tick",
		parkedStatus === "backlog",
		parkedStatus,
	);
	const launched = await ownerCall("query", "runs.list", project);
	check(
		"tokens: board:write caused no agent launch",
		launched.status === 200 && !/"kind":"task"/.test(launched.body),
		launched.body.slice(0, 200),
	);
	const auditView = await raw(
		port,
		request("GET", "/mfw/api/auth/token-audit", session),
	);
	check(
		"tokens: the owner can read the audit log",
		auditView.status === 200 &&
			auditView.body.includes("tasks.create") &&
			auditView.body.includes("live.events") &&
			/"refused":[1-9]/.test(auditView.body),
		auditView.body.slice(0, 200),
	);

	const log = readFileSync(logFile, "utf8");
	check(
		"tokens: no secret in the server log",
		![
			reader.token,
			writer.token,
			everything.token,
			live.token,
			noisy.token,
		].some((t) => log.includes(t)),
	);
}

async function main(): Promise<number> {
	if (INSTALL ? !existsSync(join(INSTALL, "bin/mfw")) : !existsSync(ENTRY)) {
		console.error(
			INSTALL
				? `auth-smoke: no compiled install at ${INSTALL}. Fix: bun run tools/install-build.ts`
				: "auth-smoke: no production build. Fix: bun run build",
		);
		return 2;
	}
	if (INSTALL)
		console.log(`auth-smoke: against the compiled install ${INSTALL}`);
	if (process.env.MFW_SMOKE_REFUSALS === "1") {
		await refusalsInDevelopmentMode();
		console.log(`auth-smoke: ${passed} passed, ${failures.length} failed`);
		for (const f of failures.slice(0, 40)) console.log(`  FAIL ${f}`);
		return failures.length ? 1 : 0;
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
	const server = Bun.spawn(SERVER_ARGV, {
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
		await scopedTokens(port, setup, scratch, mfwHome, env, logFile);
		await streamEndsOnLogout(port);
		await loopbackIsOneSource(port, mfwHome, env);
		await plantedCookie(port);
		await plantedCookieInChrome(port, scratch);
		unlock(mfwHome, env);
		await loginRacingPasswordChange(port, mfwHome, env);
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
	await trustedProxy();
	await refusalsInDevelopmentMode();
	await unixSocketProxy();
	console.log(`auth-smoke: ${passed} passed, ${failures.length} failed`);
	for (const f of failures.slice(0, 40)) console.log(`  FAIL ${f}`);
	return failures.length ? 1 : 0;
}

if (import.meta.main) process.exit(await main());
