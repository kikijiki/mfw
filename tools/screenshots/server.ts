/**
 * Process management for the screenshot run: a throwaway `vite dev` of the
 * web app, its tRPC endpoint, a tmux server on a private socket. Everything
 * started here is stopped by pid / socket name, never by pattern.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

export async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.once("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const addr = srv.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			srv.close(() => resolve(port));
		});
	});
}

export interface DevServer {
	base: string;
	pid: number;
	stop(): Promise<void>;
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal);
	} catch {
		try {
			process.kill(pid, signal);
		} catch {
			// already gone
		}
	}
}

export async function startDevServer(opts: {
	appDir: string;
	port: number;
	env: Record<string, string>;
	logFile: string;
	timeoutMs?: number;
}): Promise<DevServer> {
	const fd = openSync(opts.logFile, "a");
	const child: ChildProcess = spawn(
		"bun",
		[
			"--bun",
			"x",
			"vite",
			"dev",
			"--host",
			"127.0.0.1",
			"--port",
			String(opts.port),
			"--strictPort",
		],
		{
			cwd: opts.appDir,
			env: { ...process.env, ...opts.env, MFW_BASE_PATH: "/" },
			stdio: ["ignore", fd, fd],
			detached: true,
		},
	);
	closeSync(fd);
	const pid = child.pid;
	if (pid === undefined) throw new Error("could not start the dev server");
	let exited = false;
	child.once("exit", () => {
		exited = true;
	});

	const base = `http://127.0.0.1:${opts.port}`;
	const stop = async () => {
		if (exited) return;
		killGroup(pid, "SIGTERM");
		for (let i = 0; i < 40 && !exited; i++) await Bun.sleep(100);
		if (!exited) killGroup(pid, "SIGKILL");
	};

	const deadline = Date.now() + (opts.timeoutMs ?? 180_000);
	while (Date.now() < deadline) {
		if (exited) {
			throw new Error(
				`dev server exited during startup; log tail:\n${tail(opts.logFile)}`,
			);
		}
		try {
			const res = await fetch(`${base}/api/health`, {
				signal: AbortSignal.timeout(5_000),
			});
			if (res.ok) {
				await res.json();
				const mfwHome = opts.env.MFW_HOME;
				if (!mfwHome) throw new Error("a screenshot server needs MFW_HOME");
				await signIn(base, mfwHome);
				return { base, pid, stop };
			}
		} catch {
			// not up yet
		}
		await Bun.sleep(500);
	}
	await stop();
	throw new Error(
		`dev server was not ready after ${(opts.timeoutMs ?? 180_000) / 1000}s; log tail:\n${tail(opts.logFile)}`,
	);
}

function tail(file: string, lines = 25): string {
	try {
		return readFileSync(file, "utf8").split("\n").slice(-lines).join("\n");
	} catch {
		return "(no log)";
	}
}

export class TrpcError extends Error {}

/** The owner password of the throwaway `MFW_HOME` a screenshot run creates. */
export const SCREENSHOT_PASSWORD = "screenshot-run-throwaway";

const sessions = new Map<string, { cookie: string; key: string }>();

/**
 * Sign in to a throwaway server: first-run setup with the token from its
 * private file, or a plain login when an earlier server of this run already did it.
 */
async function signIn(base: string, mfwHome: string): Promise<void> {
	const state = (await (await fetch(`${base}/api/auth/state`)).json()) as {
		state: string;
	};
	let action = "login";
	let body: Record<string, string> = { password: SCREENSHOT_PASSWORD };
	if (state.state === "setup") {
		// The server writes the token to a private file and never logs it.
		const tokenFile = join(mfwHome, "setup-token");
		let token: string | undefined;
		for (let i = 0; i < 50 && !token; i++) {
			if (existsSync(tokenFile))
				token = readFileSync(tokenFile, "utf8").trim() || undefined;
			if (!token) await Bun.sleep(100);
		}
		if (!token) throw new Error("the dev server wrote no setup token");
		action = "setup";
		body = { token, password: SCREENSHOT_PASSWORD };
	}
	const res = await fetch(`${base}/api/auth/${action}`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-mfw-auth": "1" },
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`sign-in failed: HTTP ${res.status}`);
	const { requestKey } = (await res.json()) as { requestKey: string };
	// The session's cookie: the other Set-Cookie headers delete shadow cookies.
	const live = res.headers.getSetCookie().find((c) => !c.includes("Max-Age=0"));
	const cookie = (live ?? "").split(";")[0] as string;
	sessions.set(base, { cookie, key: requestKey });
}

/** An expression that signs the browser in; evaluate it on a same-origin page. */
export function browserSignInScript(base: string): string {
	return `fetch(${JSON.stringify(`${base}/api/auth/login`)}, {
		method: "POST",
		headers: { "content-type": "application/json", "x-mfw-auth": "1" },
		body: ${JSON.stringify(JSON.stringify({ password: SCREENSHOT_PASSWORD }))},
	}).then(async (r) => {
		if (r.ok) localStorage.setItem("mfw:auth:request-key", (await r.json()).requestKey);
		return r.status;
	})`;
}

/** One tRPC call over HTTP with the SuperJSON envelope (`{json}`), as the web client sends it. */
export async function trpc<T = unknown>(
	base: string,
	path: string,
	input: unknown,
	kind: "query" | "mutation" = "mutation",
): Promise<T> {
	const url = `${base}/api/trpc/${path}`;
	const session = sessions.get(base);
	const auth: Record<string, string> = session
		? { cookie: session.cookie, "x-mfw-key": session.key }
		: {};
	const res =
		kind === "mutation"
			? await fetch(url, {
					method: "POST",
					headers: { "content-type": "application/json", ...auth },
					body: JSON.stringify({ json: input }),
				})
			: await fetch(
					`${url}?input=${encodeURIComponent(JSON.stringify({ json: input }))}`,
					{ headers: auth },
				);
	const body = (await res.json()) as {
		result?: { data?: { json?: T } };
		error?: { json?: { message?: string } };
	};
	if (!res.ok || body.error) {
		throw new TrpcError(
			`${path} failed: ${body.error?.json?.message ?? res.statusText}`,
		);
	}
	return body.result?.data?.json as T;
}

/** Stop a tmux server by its private socket name (never the default server) and remove its socket file. */
export async function killTmuxServer(socket: string): Promise<void> {
	try {
		const q = Bun.spawn(
			["tmux", "-L", socket, "display-message", "-p", "#{socket_path}"],
			{ stdout: "pipe", stderr: "ignore" },
		);
		const path = (await new Response(q.stdout).text()).trim();
		await q.exited;
		const p = Bun.spawn(["tmux", "-L", socket, "kill-server"], {
			stdout: "ignore",
			stderr: "ignore",
		});
		await p.exited;
		// kill-server leaves the socket file behind; ours is named after this run only.
		if (path?.endsWith(`/${socket}`)) rmSync(path, { force: true });
	} catch {
		// tmux missing or no server: nothing to stop
	}
}
