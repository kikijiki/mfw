import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where `mfw mcp` gets its API token, first match wins:
 *   1. `--token-file <path>`
 *   2. `MFW_TOKEN`
 *   3. `$MFW_HOME/mcp-token`, if it exists and `MFW_URL` is the local default
 *
 * There is no `--token <value>`: a command line is visible to every process on
 * the machine. A file must be a regular 0600 file of this user, not a link.
 */

/** The app's default mount; see `makeClient`. */
export const DEFAULT_MFW_URL = "http://localhost:7777/mfw/api/trpc";
/** Matches `MCP_TOKEN_FILE` in the daemon, which this package does not depend on. */
export const MCP_TOKEN_FILE = "mcp-token";
const TOKEN_SHAPE = /^mfwt_[A-Za-z0-9_-]{43}$/;
const MAX_TOKEN_FILE = 256;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export class McpCredentialError extends Error {
	override readonly name = "McpCredentialError";
}

function readTokenFile(path: string): string | null {
	let fd: number;
	try {
		// O_NONBLOCK: a FIFO planted at this path must not hang the server at start.
		fd = openSync(
			path,
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return null;
		if (code === "ELOOP")
			throw new McpCredentialError(`token file ${path} is a symbolic link`);
		throw new McpCredentialError(`cannot read token file ${path} (${code})`);
	}
	try {
		const st = fstatSync(fd);
		if (!st.isFile())
			throw new McpCredentialError(`token file ${path} is not a regular file`);
		if ((st.mode & 0o077) !== 0)
			throw new McpCredentialError(
				`token file ${path} is readable by others. Fix: chmod 600 ${path}`,
			);
		if (st.uid !== process.getuid?.())
			throw new McpCredentialError(
				`token file ${path} belongs to another user`,
			);
		if (st.size > MAX_TOKEN_FILE)
			throw new McpCredentialError(`token file ${path} is not a token`);
		const buf = Buffer.alloc(MAX_TOKEN_FILE);
		const n = readSync(fd, buf, 0, MAX_TOKEN_FILE, 0);
		return buf.subarray(0, n).toString("utf8").trim();
	} finally {
		closeSync(fd);
	}
}

function checked(token: string, source: string): string {
	if (!TOKEN_SHAPE.test(token))
		throw new McpCredentialError(`${source} does not hold an mfw API token`);
	return token;
}

/**
 * A token file: the token, then optionally `origin=<issuing origin>`. A
 * recorded origin is binding, so a repository's MCP config that points
 * `MFW_URL` elsewhere cannot collect a stored token.
 */
function tokenFromFile(contents: string, path: string, url: string): string {
	const source = `token file ${path}`;
	const [first = "", second, ...rest] = contents.split("\n");
	const token = checked(first.trim(), source);
	if (rest.length > 0)
		throw new McpCredentialError(`${source} does not hold an mfw API token`);
	if (second === undefined) return token;
	const recorded = /^origin=(https?:\/\/[^\s/]+)$/.exec(second.trim())?.[1];
	if (!recorded)
		throw new McpCredentialError(`${source} does not hold an mfw API token`);
	const target = new URL(url).origin;
	if (new URL(recorded).origin !== target)
		throw new McpCredentialError(
			`${source} was issued for ${recorded}, not ${target}`,
		);
	return token;
}

/** The token to use, or null when none is configured. */
export function resolveMcpToken(
	args: readonly string[],
	env: Record<string, string | undefined>,
): string | null {
	const url = env.MFW_URL ?? DEFAULT_MFW_URL;
	if (args.some((a) => a === "--token" || a.startsWith("--token=")))
		throw new McpCredentialError(
			"--token is not accepted: a command line is visible to other processes. Use --token-file or MFW_TOKEN.",
		);
	const inline = args.find((a) => a.startsWith("--token-file="));
	const at = args.indexOf("--token-file");
	if (inline !== undefined || at >= 0) {
		const path = inline ? inline.slice("--token-file=".length) : args[at + 1];
		if (!path || path.startsWith("--"))
			throw new McpCredentialError("--token-file needs a path");
		const token = readTokenFile(path);
		if (token === null)
			throw new McpCredentialError(`token file ${path} does not exist`);
		return tokenFromFile(token, path, url);
	}
	if (env.MFW_TOKEN) return checked(env.MFW_TOKEN.trim(), "MFW_TOKEN");
	// The implicit file is for the local default only. Anywhere else must be
	// named explicitly, so it is not even read.
	if (url !== DEFAULT_MFW_URL) return null;
	const home = env.MFW_HOME ?? join(homedir(), ".local", "share", "mfw");
	const path = join(home, MCP_TOKEN_FILE);
	const token = readTokenFile(path);
	return token === null ? null : tokenFromFile(token, path, url);
}

/** A bearer token must not cross a network in the clear. */
export function assertTokenTransport(url: string): void {
	const u = new URL(url);
	if (u.protocol === "https:") return;
	if (u.protocol === "http:" && LOOPBACK.has(u.hostname)) return;
	throw new McpCredentialError(
		`refusing to send an API token to ${u.origin} without TLS. Use an https:// MFW_URL.`,
	);
}
