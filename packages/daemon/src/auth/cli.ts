import { randomBytes } from "node:crypto";
import {
	existsSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { acquireDaemonLock } from "../resources/daemon-lock.ts";
import { pinnedTool } from "../sandbox.ts";
import { AuthService, authDbPath, isAuthRefused } from "./service.ts";
import {
	DEFAULT_TOKEN_ORIGIN,
	MCP_TOKEN_FILE,
	normalizeTokenOrigin,
	parseTtl,
	TOKEN_SCOPES,
} from "./tokens.ts";

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
	"  token create --name <name> --scope <scope> [--scope <scope>]",
	"               [--project <project>] [--ttl 30m|24h|7d] [--write-file [--origin <url>]]",
	"                create an API token, shown once (default expiry 24h, at most 90d).",
	`                scopes: ${TOKEN_SCOPES.join(", ")}`,
	`                --write-file saves it to $MFW_HOME/${MCP_TOKEN_FILE} (0600) for \`mfw mcp\`,`,
	`                bound to --origin (default ${DEFAULT_TOKEN_ORIGIN})`,
	"  token list    show tokens (never their secrets)",
	"  token revoke <id>   revoke a token at once",
	"  token audit [--limit <n>] [--id <token id>]",
	"                what tokens changed and streamed, and how often they were refused",
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

/** Flags of `token create`, or the problem. A flag's value is the next word. */
function parseCreate(args: readonly string[]):
	| {
			name?: string;
			scopes: string[];
			project?: string;
			ttlMs?: number;
			writeFile: boolean;
			origin?: string;
	  }
	| string {
	const out: {
		name?: string;
		scopes: string[];
		project?: string;
		ttlMs?: number;
		writeFile: boolean;
		origin?: string;
	} = { scopes: [], writeFile: false };
	for (let i = 0; i < args.length; i++) {
		const flag = args[i];
		if (flag === "--write-file") {
			out.writeFile = true;
			continue;
		}
		if (
			!["--name", "--scope", "--project", "--ttl", "--origin"].includes(
				flag ?? "",
			)
		)
			return `unknown option '${flag}'`;
		const value = args[++i];
		if (value === undefined || value.startsWith("--"))
			return `${flag} needs a value`;
		if (flag === "--name") out.name = value;
		else if (flag === "--scope") out.scopes.push(value);
		else if (flag === "--project") out.project = value;
		else if (flag === "--origin") {
			const origin = normalizeTokenOrigin(value);
			if (!origin)
				return "--origin must be a bare https:// origin, or http:// on loopback";
			out.origin = origin;
		} else {
			const ttlMs = parseTtl(value);
			if (ttlMs === null) return "--ttl must look like 30m, 24h or 7d";
			out.ttlMs = ttlMs;
		}
	}
	if (out.origin && !out.writeFile) return "--origin needs --write-file";
	return out;
}

/**
 * A fresh exclusive 0600 file, renamed in: never written through a planted
 * link. The second line names the server, and `mfw mcp` sends it nowhere else.
 */
function writeTokenFile(home: string, token: string, origin: string): string {
	const path = join(home, MCP_TOKEN_FILE);
	const temp = `${path}.${randomBytes(6).toString("hex")}`;
	try {
		writeFileSync(temp, `${token}\norigin=${origin}\n`, {
			mode: 0o600,
			flag: "wx",
		});
		renameSync(temp, path);
	} catch (e) {
		rmSync(temp, { force: true });
		throw e;
	}
	return path;
}

/** The configured project names, or null when the config cannot be read. */
async function configuredProjects(home: string): Promise<Set<string> | null> {
	try {
		const { loadConfig } = await import("../config.ts");
		return new Set((await loadConfig(home)).projects.map((p) => p.name));
	} catch {
		return null;
	}
}

async function runTokenCommand(
	args: readonly string[],
	d: AuthCliDeps,
): Promise<number> {
	switch (args[0]) {
		case "create": {
			const parsed = parseCreate(args.slice(1));
			if (typeof parsed === "string") {
				d.err(`mfw auth token: ${parsed}\n${AUTH_USAGE}`);
				return 2;
			}
			return withStore(d, async (auth) => {
				try {
					const { token, info } = await auth.createToken({
						name: parsed.name,
						scopes: parsed.scopes,
						project: parsed.project,
						ttlMs: parsed.ttlMs,
					});
					if (
						info.project &&
						!(await configuredProjects(d.home))?.has(info.project)
					)
						d.err(
							`mfw auth: warning: no project named '${info.project}' is attached. The token gains access if one is attached later.`,
						);
					const summary = `${info.id} '${info.name}' [${info.scopes.join(", ")}] ${info.project ? `project ${info.project}` : "all projects"}, expires ${new Date(info.expiresAt).toISOString()}`;
					if (parsed.writeFile) {
						const path = writeTokenFile(
							d.home,
							token,
							parsed.origin ?? DEFAULT_TOKEN_ORIGIN,
						);
						d.out(`mfw auth: created ${summary}`);
						d.out(`mfw auth: saved to ${path} (0600)`);
					} else {
						d.err(`mfw auth: created ${summary}. It is shown only once:`);
						d.out(token);
					}
					return 0;
				} catch (e) {
					if (!isAuthRefused(e)) throw e;
					d.err(`mfw auth token: ${e.message}`);
					return 1;
				}
			});
		}
		case "list":
			return withStore(d, async (auth) => {
				const tokens = await auth.listTokens();
				if (tokens.length === 0) d.out("mfw auth: no tokens.");
				const names = await configuredProjects(d.home);
				const where = (project: string | null) =>
					project === null
						? "all projects"
						: names && !names.has(project)
							? `${project} (not attached)`
							: project;
				for (const t of tokens)
					d.out(
						`${t.id}  ${t.status}  '${t.name}'  [${t.scopes.join(", ")}]  ${where(t.project)}  expires ${new Date(t.expiresAt).toISOString()}  last used ${t.lastUsedAt ? new Date(t.lastUsedAt).toISOString() : "never"}`,
					);
				return 0;
			});
		case "audit": {
			const rest = args.slice(1);
			let limit = 50;
			let tokenId: string | undefined;
			for (let i = 0; i < rest.length; i += 2) {
				const value = rest[i + 1];
				if (rest[i] === "--limit" && /^[1-9][0-9]{0,3}$/.test(value ?? ""))
					limit = Number(value);
				else if (rest[i] === "--id" && value) tokenId = value;
				else {
					d.err("usage: mfw auth token audit [--limit <n>] [--id <token id>]");
					return 2;
				}
			}
			return withStore(d, async (auth) => {
				const when = (ms: number) => new Date(ms).toISOString();
				const counters = (await auth.tokenAuditCounters()).filter(
					(c) => !tokenId || c.tokenId === tokenId,
				);
				for (const c of counters)
					d.out(
						`${c.tokenId}  '${c.name}'  refused ${c.refused}${c.lastRefusedPath ? ` (last ${c.lastRefusedPath}${c.lastRefusedAt ? ` at ${when(c.lastRefusedAt)}` : ""})` : ""}  older actions dropped ${c.dropped}`,
					);
				const rows = await auth.listTokenAudit({
					limit,
					...(tokenId ? { tokenId } : {}),
				});
				for (const r of rows)
					d.out(
						`${when(r.at)}  '${r.name}'  ${r.kind}  ${r.path}  ${r.project ?? "-"}  ${r.outcome}`,
					);
				if (counters.length === 0 && rows.length === 0)
					d.out("mfw auth: no token activity recorded.");
				return 0;
			});
		}
		case "revoke": {
			const id = args[1];
			if (!id || args.length !== 2) {
				d.err("usage: mfw auth token revoke <id>");
				return 2;
			}
			return withStore(d, async (auth) => {
				if (await auth.revokeToken(id)) {
					d.out(`mfw auth: revoked ${id}.`);
					return 0;
				}
				d.err(`mfw auth: no live token '${id}'. See: mfw auth token list`);
				return 1;
			});
		}
		default:
			d.err(AUTH_USAGE);
			return 2;
	}
}

export async function runAuthCommand(
	args: readonly string[],
	d: AuthCliDeps,
): Promise<number> {
	switch (args[0]) {
		case "token":
			return runTokenCommand(args.slice(1), d);
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
