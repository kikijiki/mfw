import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { acquireDaemonLock } from "../resources/daemon-lock.ts";
import { pinnedTool } from "../sandbox.ts";
import { AuthService, authDbPath, isAuthRefused } from "./service.ts";

/**
 * `mfw auth ...`: the owner's recovery path. It works on `$MFW_HOME/auth.db`
 * directly, so it needs no session and no server. That file is what limits it
 * to the owner: it is 0600 and `$MFW_HOME` is hidden inside the agent sandbox,
 * where this command finds no database and refuses. It never creates one.
 */

export const AUTH_USAGE = [
	"usage: mfw auth <command>",
	"",
	"  unlock        clear failed sign-in attempts for every address",
	"  sign-out-everywhere   revoke every session, including stolen ones",
	"  setup-token   print a new first-run setup token (before an owner exists)",
	"  reset --yes   remove the owner and all sessions, then repeat first-run setup;",
	"                refused while the server or any agent session is alive",
].join("\n");

export interface AuthCliDeps {
	home: string;
	out: (line: string) => void;
	err: (line: string) => void;
	/** Live agent sessions. Throws when that cannot be determined. */
	listAgentSessions?: () => Promise<string[]>;
}

const socketDir = (root: string, uid: number) => join(root, `tmux-${uid}`);

/**
 * Every tmux socket of this user, from the kernel's table of listening unix
 * sockets, so a server started with another `TMUX_TMPDIR` or socket name is
 * still found. The configured and default paths are always included.
 */
export function discoverTmuxSockets(
	unixTable: string,
	uid: number,
	env: Record<string, string | undefined>,
): string[] {
	const found = new Set<string>();
	const marker = `/tmux-${uid}/`;
	for (const line of unixTable.split("\n")) {
		const path = /\s(\/.*)$/.exec(line)?.[1];
		if (!path) continue;
		const at = path.lastIndexOf(marker);
		if (at >= 0 && !path.slice(at + marker.length).includes("/"))
			found.add(path);
	}
	const roots = [
		"/tmp",
		...(env.TMUX_TMPDIR?.startsWith("/") ? [env.TMUX_TMPDIR] : []),
	];
	const names = ["mfw", ...(env.MFW_TMUX_SOCKET ? [env.MFW_TMUX_SOCKET] : [])];
	for (const root of roots)
		for (const name of names) found.add(join(socketDir(root, uid), name));
	return [...found];
}

/**
 * Live agent sessions on these sockets. On an mfw socket every session counts;
 * on any other (the owner's own tmux) only sessions with an agent's `mfw_` name.
 * Anything but a clear answer throws: a reset must never proceed on a guess.
 */
export async function liveAgentSessions(
	tmux: string,
	sockets: readonly string[],
	ownSocket?: string,
): Promise<string[]> {
	const sessions: string[] = [];
	for (const socket of sockets) {
		const p = Bun.spawn([tmux, "-S", socket, "list-sessions", "-F", "#S"], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exit] = await Promise.all([
			new Response(p.stdout).text(),
			new Response(p.stderr).text(),
			p.exited,
		]);
		if (exit !== 0) {
			if (
				/no server running|error connecting to .*(No such file|Connection refused)/i.test(
					stderr,
				)
			)
				continue;
			throw new Error(
				`tmux list-sessions on ${socket} failed: ${stderr.trim() || exit}`,
			);
		}
		const name = basename(socket);
		const isMfwSocket = name.startsWith("mfw") || name === ownSocket;
		for (const session of stdout.split("\n").filter(Boolean))
			if (isMfwSocket || session.startsWith("mfw_")) sessions.push(session);
	}
	return sessions;
}

export async function findAgentSessions(o: {
	tmux: string;
	readUnixTable: () => string;
	uid: number;
	env: Record<string, string | undefined>;
}): Promise<string[]> {
	return liveAgentSessions(
		o.tmux,
		discoverTmuxSockets(o.readUnixTable(), o.uid, o.env),
		o.env.MFW_TMUX_SOCKET,
	);
}

async function defaultAgentSessions(): Promise<string[]> {
	const tmux = pinnedTool("tmux");
	if (!tmux) throw new Error("tmux is not on a trusted PATH");
	const uid = process.getuid?.();
	if (uid === undefined) throw new Error("cannot determine the user id");
	return findAgentSessions({
		tmux,
		readUnixTable: () => readFileSync("/proc/net/unix", "utf8"),
		uid,
		env: process.env,
	});
}

async function reset(auth: AuthService, d: AuthCliDeps): Promise<number> {
	let lock: Awaited<ReturnType<typeof acquireDaemonLock>>;
	try {
		// Also keeps a server from starting until the reset is done.
		lock = await acquireDaemonLock(d.home, {
			processBootId: `auth-reset-${process.pid}`,
			timeoutMs: 500,
		});
	} catch {
		d.err("mfw auth: the server is running. Fix: stop the server, then retry.");
		return 1;
	}
	try {
		let sessions: string[];
		try {
			sessions = await (d.listAgentSessions ?? defaultAgentSessions)();
		} catch (e) {
			d.err(
				`mfw auth: cannot tell whether agents are running (${(e as Error).message}); nothing was changed.`,
			);
			return 1;
		}
		if (sessions.length > 0) {
			d.err(
				`mfw auth: agent sessions are still alive: ${sessions.join(", ")}. A running agent could claim the owner account during setup. Fix: stop them from the UI or with tmux kill-session, then retry.`,
			);
			return 1;
		}
		await auth.resetOwner();
		d.out(
			"mfw auth: owner and sessions removed. Start the server, then run `mfw auth setup-token`.",
		);
		return 0;
	} finally {
		await lock.release();
	}
}

async function withStore(
	d: AuthCliDeps,
	run: (auth: AuthService) => Promise<number>,
): Promise<number> {
	const path = authDbPath(d.home);
	if (!existsSync(path)) {
		d.err(
			`mfw auth: no auth database at ${path}. Start the server once, and run this on the host, outside any agent sandbox.`,
		);
		return 1;
	}
	const auth = await AuthService.open(path);
	try {
		return await run(auth);
	} finally {
		auth.close();
	}
}

export async function runAuthCommand(
	args: readonly string[],
	d: AuthCliDeps,
): Promise<number> {
	switch (args[0]) {
		case "--help":
		case "-h":
			d.out(AUTH_USAGE);
			return 0;
		case "unlock":
			return withStore(d, async (auth) => {
				await auth.unlock();
				d.out("mfw auth: cleared all failed sign-in attempts.");
				return 0;
			});
		case "sign-out-everywhere":
			return withStore(d, async (auth) => {
				await auth.revokeAll();
				d.out("mfw auth: every session is signed out.");
				return 0;
			});
		case "setup-token":
			return withStore(d, async (auth) => {
				try {
					const token = await auth.issueSetupToken();
					d.out(token);
					return 0;
				} catch (e) {
					if (!isAuthRefused(e)) throw e;
					d.err(
						"mfw auth: an owner already exists. To start over: mfw auth reset --yes",
					);
					return 1;
				}
			});
		case "reset":
			if (!args.includes("--yes")) {
				d.err(
					"mfw auth reset removes the owner and every session. Re-run with --yes.",
				);
				return 2;
			}
			return withStore(d, (auth) => reset(auth, d));
		default:
			d.err(AUTH_USAGE);
			return 2;
	}
}
