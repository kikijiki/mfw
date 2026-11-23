import { randomBytes } from "node:crypto";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	realpathSync,
	renameSync,
	type Stats,
	unlinkSync,
} from "node:fs";
import net from "node:net";
import { basename, join, relative, resolve, sep } from "node:path";
import { UNIX_PEER } from "./trusted-proxy";

/**
 * The private listener a TLS proxy such as `tailscale serve` targets
 * (`MFW_LISTEN_SOCKET`). Whoever connects here IS the proxy, so forwarded
 * headers are honoured from it, which is why the socket must be unreachable by
 * agents: they share the owner's uid, so file modes alone do not stop them.
 * It lives under `$MFW_HOME`, which every sandbox masks (`exposure.ts` refuses
 * any other path), in a 0700 directory.
 *
 * The socket is bound under a random name and renamed into place once it is
 * 0600, so the final path is never a socket with wider permissions, and a
 * planted link at that path is refused rather than followed.
 */

type Handler = (req: Request) => Response | Promise<Response>;

const uid = () => process.getuid?.() ?? -1;

function privateDirectory(home: string, socketPath: string): string {
	mkdirSync(home, { recursive: true, mode: 0o700 });
	const parts = relative(resolve(home), socketPath).split(sep).slice(0, -1);
	let dir = realpathSync(home);
	for (const part of parts) {
		dir = join(dir, part);
		try {
			mkdirSync(dir, { mode: 0o700 });
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
		}
		const st = lstatSync(dir);
		if (!st.isDirectory() || st.uid !== uid() || (st.mode & 0o077) !== 0)
			throw new Error(
				`${dir} must be a real directory owned by this user with mode 0700. Fix: chmod 700 it, or choose another MFW_LISTEN_SOCKET`,
			);
	}
	return dir;
}

function isAccepting(path: string): Promise<boolean> {
	return new Promise((done) => {
		const socket = net.connect({ path });
		// No answer is not proof that it is dead, so it counts as live.
		const timer = setTimeout(() => {
			socket.destroy();
			done(true);
		}, 1000);
		socket.once("connect", () => {
			clearTimeout(timer);
			socket.destroy();
			done(true);
		});
		socket.once("error", (e: NodeJS.ErrnoException) => {
			clearTimeout(timer);
			done(e.code !== "ECONNREFUSED" && e.code !== "ENOENT");
		});
	});
}

/** Only a dead socket of ours may be replaced. Anything else stops the server. */
async function assertReplaceable(path: string): Promise<void> {
	let st: Stats;
	try {
		st = lstatSync(path);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
		throw e;
	}
	if (!st.isSocket() || st.uid !== uid())
		throw new Error(
			`${path} exists and is not a socket owned by this user. Fix: move it away, or choose another MFW_LISTEN_SOCKET`,
		);
	if (await isAccepting(path))
		throw new Error(`another server is already listening on ${path}`);
}

export async function startUnixListener(
	socketPath: string,
	home: string,
	handler: Handler,
): Promise<void> {
	const dir = privateDirectory(home, socketPath);
	const path = join(dir, basename(socketPath));
	await assertReplaceable(path);
	const temp = join(dir, `.mfw-${randomBytes(6).toString("hex")}.sock`);
	const server = Bun.serve({
		unix: temp,
		fetch(req, srv) {
			Object.defineProperties(req, {
				[UNIX_PEER]: { value: true },
				ip: { value: undefined },
				waitUntil: {
					value: (p: Promise<unknown>) => void p.catch(() => undefined),
				},
				runtime: {
					enumerable: true,
					value: { name: "bun", bun: { server: srv } },
				},
			});
			return handler(req);
		},
	});
	try {
		chmodSync(temp, 0o600);
		renameSync(temp, path);
	} catch (e) {
		server.stop(true);
		throw e;
	}
	const { dev, ino } = lstatSync(path);
	process.once("exit", () => {
		try {
			// Never remove a socket a later server has put here.
			const now = lstatSync(path);
			if (now.dev === dev && now.ino === ino) unlinkSync(path);
		} catch {
			// Already gone.
		}
	});
}
