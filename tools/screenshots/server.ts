/**
 * Process management for the screenshot run: a throwaway `vite dev` of the
 * web app, its tRPC endpoint, a tmux server on a private socket. Everything
 * started here is stopped by pid / socket name, never by pattern.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";

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
			const res = await fetch(`${base}/api/trpc/system.projects`, {
				signal: AbortSignal.timeout(5_000),
			});
			if (res.ok) {
				await res.json();
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

/** One tRPC call over HTTP with the SuperJSON envelope (`{json}`), as the web client sends it. */
export async function trpc<T = unknown>(
	base: string,
	path: string,
	input: unknown,
	kind: "query" | "mutation" = "mutation",
): Promise<T> {
	const url = `${base}/api/trpc/${path}`;
	const res =
		kind === "mutation"
			? await fetch(url, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ json: input }),
				})
			: await fetch(
					`${url}?input=${encodeURIComponent(JSON.stringify({ json: input }))}`,
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
