/**
 * Per-run egress proxy: a CONNECT-only proxy on one unix socket per run (the
 * sandbox experiments, E4 "Exact rules"). The policy decisions live in
 * `egress-policy.ts`; this file owns sockets, limits, timers and logging.
 *
 * The netns is the real enforcement (no route out of the sandbox); this proxy
 * is the only door, and it bounds and logs what goes through. A CONNECT
 * allowlist cannot tell reads from writes, so exfiltration to an allowed host
 * is bounded and logged, not prevented.
 *
 * Every failure path closes the socket: a handler exception must never leave
 * a client hanging (a NUL byte once did).
 */

import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { chmod, mkdir, rm } from "node:fs/promises";
import net from "node:net";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import {
	type AllowEntry,
	buildAllowlist,
	canonicalAddress,
	checkTarget,
	deny,
	type EgressDenial,
	MAX_HEAD_BYTES,
	parseClientHelloSni,
	parseRequestHead,
	type Resolver,
	resolvePinned,
} from "./egress-policy.ts";

/** One ALLOW or DENY decision, as handed to the log sink. */
export type EgressLogEntry =
	| {
			decision: "ALLOW";
			/**
			 * `open` is logged when the tunnel is established (byte counts are
			 * zero), `close` when it ends, with the totals.
			 */
			phase: "open" | "close";
			runId: string;
			host: string;
			port: number;
			ip: string;
			bytesUp: number;
			bytesDown: number;
			durationMs: number;
			at: number;
	  }
	| {
			decision: "DENY";
			runId: string;
			/** Absent when the request never parsed to a target. */
			host?: string;
			port?: number;
			ip?: string;
			status: number;
			reason: string;
			at: number;
	  };

export interface EgressClock {
	now(): number;
}

export interface EgressLimits {
	/** Total deadline for the request head (not per read). */
	headerDeadlineMs: number;
	/** A tunnel with no traffic in either direction is closed after this. */
	idleMs: number;
	upstreamConnectMs: number;
	/** A tunnel is closed this long after it opened, however busy it is. */
	maxTunnelMs: number;
	/** Total deadline for DNS resolution of an allowlisted name. */
	resolveMs: number;
	/** Concurrent client connections to this run's proxy. */
	maxConnectionsPerRun: number;
}

export const DEFAULT_EGRESS_LIMITS: EgressLimits = {
	headerDeadlineMs: 5_000,
	idleMs: 60_000,
	upstreamConnectMs: 5_000,
	resolveMs: 5_000,
	maxTunnelMs: 60 * 60_000,
	maxConnectionsPerRun: 64,
};

/** A connection cap shared by every run's proxy. */
export interface ConnectionGate {
	acquire(): boolean;
	release(): void;
	readonly active: number;
}

export function createConnectionGate(max: number): ConnectionGate {
	let active = 0;
	return {
		acquire() {
			if (active >= max) return false;
			active++;
			return true;
		},
		release() {
			if (active > 0) active--;
		},
		get active() {
			return active;
		},
	};
}

export interface EgressProxyOptions {
	runId: string;
	/** Absolute path of the unix socket. See `egressSocketPath`. */
	socketPath: string;
	/** Bare host means port 443. */
	allow: readonly AllowEntry[];
	/** Default: `dns.lookup` with `all: true`. */
	resolve?: Resolver;
	clock?: EgressClock;
	log?: (entry: EgressLogEntry) => void;
	/** Called per chunk relayed, so counters stay current while a tunnel is open. */
	onBytes?: (host: string, port: number, up: number, down: number) => void;
	limits?: Partial<EgressLimits>;
	/**
	 * The global connection cap, shared by every run's proxy. Required: a proxy
	 * with no global cap is a way to exhaust the daemon's file descriptors.
	 */
	gate: ConnectionGate;
	/** Rule 11: the ClientHello SNI must equal the CONNECT host. Off by default. */
	sni?: boolean;
	/** This machine's addresses, read per request. Default: its network interfaces. */
	localAddresses?: () => readonly string[];
	/** Upstream dialer, given the pinned IP. Default `net.connect`. */
	connect?: (ip: string, port: number) => net.Socket;
}

export interface EgressProxy {
	readonly socketPath: string;
	/** Client connections currently open on this proxy. */
	readonly active: number;
	/** Stop accepting, destroy every connection, and remove the socket. */
	close(): Promise<void>;
}

const UNIX_PATH_MAX = 107;

/**
 * The per-run socket path: `$MFW_HOME/run/s/<12 hex>/e.sock`. The directory
 * is short because a unix socket path is limited to 107 bytes, and it is the
 * unit the engine bind-mounts into exactly one run.
 */
export function egressSocketPath(mfwHome: string, runId: string): string {
	const short = createHash("sha256").update(runId).digest("hex").slice(0, 12);
	const path = join(mfwHome, "run", "s", short, "e.sock");
	if (Buffer.byteLength(path) > UNIX_PATH_MAX) {
		throw new Error(
			`egress socket path exceeds ${UNIX_PATH_MAX} bytes: ${path}`,
		);
	}
	return path;
}

const STATUS_TEXT: Record<number, string> = {
	400: "Bad Request",
	403: "Forbidden",
	405: "Method Not Allowed",
	408: "Request Timeout",
	429: "Too Many Requests",
	431: "Request Header Fields Too Large",
	502: "Bad Gateway",
	504: "Gateway Timeout",
};

const defaultResolver: Resolver = async (host) => {
	const answers = await lookup(host, { all: true, verbatim: true });
	return answers.map((a) => a.address);
};

const hostInterfaceAddresses = (): string[] =>
	Object.values(networkInterfaces()).flatMap((list) =>
		(list ?? []).map((i) => i.address),
	);

/** Start the proxy. Resolves once the socket is listening (mode 0600). */
export async function startEgressProxy(
	opts: EgressProxyOptions,
): Promise<EgressProxy> {
	if (Buffer.byteLength(opts.socketPath) > UNIX_PATH_MAX) {
		throw new Error(`egress socket path exceeds ${UNIX_PATH_MAX} bytes`);
	}
	if (!opts.gate) {
		throw new Error("egress proxy requires a global connection gate");
	}
	const allow = buildAllowlist(opts.allow);
	const limits: EgressLimits = { ...DEFAULT_EGRESS_LIMITS, ...opts.limits };
	const resolve = opts.resolve ?? defaultResolver;
	const clock = opts.clock ?? { now: () => Date.now() };
	const dial = opts.connect ?? ((ip, port) => net.connect({ host: ip, port }));
	const sink = opts.log ?? (() => {});
	const log = (entry: EgressLogEntry): void => {
		try {
			sink(entry);
		} catch {
			// A broken log sink must never take the proxy down.
		}
	};
	const sockets = new Set<net.Socket>();
	const readLocal = opts.localAddresses ?? hostInterfaceAddresses;
	/** Read per request: an interface can gain an address while a run is live. */
	const isOwnAddress = (): ((ip: string) => boolean) => {
		const own = new Set(readLocal().map(canonicalAddress));
		return (ip) => own.has(canonicalAddress(ip));
	};

	const denyLog = (
		d: EgressDenial,
		target?: { host: string; port: number },
		ip?: string,
	): void =>
		log({
			decision: "DENY",
			runId: opts.runId,
			...(target ? { host: target.host, port: target.port } : {}),
			...(ip ? { ip } : {}),
			status: d.status,
			reason: d.reason,
			at: clock.now(),
		});

	function respondDeny(client: net.Socket, d: EgressDenial): void {
		const body = `mfw-egress-denied: ${d.reason}\n`;
		const head =
			`HTTP/1.1 ${d.status} ${STATUS_TEXT[d.status] ?? "Error"}\r\n` +
			"X-Mfw-Egress: denied\r\n" +
			"Content-Type: text/plain\r\n" +
			`Content-Length: ${Buffer.byteLength(body)}\r\n` +
			(d.status === 405 ? "Allow: CONNECT\r\n" : "") +
			"Connection: close\r\n\r\n";
		// readHead paused the socket; a peer still sending would otherwise keep
		// its unread bytes queued and the close from ever completing.
		client.resume();
		client.end(head + body);
		// Never leave a half-closed peer holding the socket open.
		setTimeout(() => client.destroy(), 250).unref();
	}

	function onConnection(client: net.Socket): void {
		const gate = opts.gate;
		if (sockets.size >= limits.maxConnectionsPerRun) {
			denyLog(deny(429, "limit-run"));
			client.destroy();
			return;
		}
		if (!gate.acquire()) {
			denyLog(deny(429, "limit-global"));
			client.destroy();
			return;
		}
		sockets.add(client);
		client.once("close", () => {
			sockets.delete(client);
			gate.release();
		});
		client.on("error", () => client.destroy());
		handle(client).catch(() => client.destroy());
	}

	async function handle(client: net.Socket): Promise<void> {
		const head = await readHead(client, limits.headerDeadlineMs);
		if (head.kind === "closed") return;
		if (head.kind === "deny") {
			denyLog(head.denial);
			respondDeny(client, head.denial);
			return;
		}
		const parsed = parseRequestHead(head.text);
		if (!parsed.ok) {
			denyLog(parsed);
			respondDeny(client, parsed);
			return;
		}
		const target = { host: parsed.host, port: parsed.port };
		const refused = checkTarget(target.host, target.port, allow);
		if (refused) {
			denyLog(refused, target);
			respondDeny(client, refused);
			return;
		}
		const pinned = await withDeadline(
			// Fully qualified: the policy keeps the normalised name, but the
			// resolver must not retry it under the host's DNS search domains.
			resolvePinned(`${target.host}.`, resolve, isOwnAddress()),
			limits.resolveMs,
			deny(504, "dns-timeout"),
		);
		if (!pinned.ok) {
			denyLog(pinned, target);
			respondDeny(client, pinned);
			return;
		}
		if (client.destroyed) return;
		const upstream = await connectUpstream(
			dial,
			pinned.ip,
			target.port,
			limits.upstreamConnectMs,
		);
		if (!upstream.ok) {
			denyLog(upstream.denial, target, pinned.ip);
			respondDeny(client, upstream.denial);
			return;
		}
		tunnel(client, upstream.socket, target, pinned.ip, head.rest);
	}

	function tunnel(
		client: net.Socket,
		upstream: net.Socket,
		target: { host: string; port: number },
		ip: string,
		pipelined: Buffer,
	): void {
		const started = clock.now();
		let bytesUp = 0;
		let bytesDown = 0;
		let logged = false;
		const finish = (): void => {
			if (logged) return;
			logged = true;
			clearTimeout(lifetime);
			log({
				decision: "ALLOW",
				phase: "close",
				runId: opts.runId,
				host: target.host,
				port: target.port,
				ip,
				bytesUp,
				bytesDown,
				durationMs: clock.now() - started,
				at: started,
			});
		};
		// A busy or slow keep-alive tunnel must not live forever.
		const lifetime = setTimeout(() => teardown(), limits.maxTunnelMs);
		lifetime.unref();
		const teardown = (): void => {
			client.destroy();
			upstream.destroy();
			finish();
		};
		upstream.on("error", teardown);
		upstream.once("close", () => {
			client.end(); // let queued downstream bytes flush; idle timeout reaps it
			finish();
		});
		client.once("close", teardown);
		for (const s of [client, upstream]) s.setTimeout(limits.idleMs, teardown);

		const count = (up: number, down: number): void => {
			try {
				opts.onBytes?.(target.host, target.port, up, down);
			} catch {
				// Like the log sink: a broken counter must not break the tunnel.
			}
		};

		const startPiping = (first: Buffer): void => {
			if (first.length > 0) {
				bytesUp += first.length;
				count(first.length, 0);
				upstream.write(first);
			}
			client.on("data", (chunk: Buffer) => {
				bytesUp += chunk.length;
				count(chunk.length, 0);
				if (!upstream.write(chunk)) {
					client.pause();
					upstream.once("drain", () => client.resume());
				}
			});
			upstream.on("data", (chunk: Buffer) => {
				bytesDown += chunk.length;
				count(0, chunk.length);
				if (!client.write(chunk)) {
					upstream.pause();
					client.once("drain", () => upstream.resume());
				}
			});
			client.on("end", () => upstream.end());
			upstream.on("end", () => client.end());
			client.resume();
		};

		// Visible while open, and survives a daemon crash that skips the close.
		log({
			decision: "ALLOW",
			phase: "open",
			runId: opts.runId,
			host: target.host,
			port: target.port,
			ip,
			bytesUp: 0,
			bytesDown: 0,
			durationMs: 0,
			at: started,
		});
		client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
		if (!opts.sni) {
			startPiping(pipelined);
			return;
		}
		// Rule 11: hold the first TLS record back until its SNI is checked.
		let buf = pipelined;
		const deadline = setTimeout(
			() => reject("sni-timeout"),
			limits.headerDeadlineMs,
		);
		const reject = (reason: string): void => {
			clearTimeout(deadline);
			client.off("data", onFirst);
			denyLog(deny(403, reason), target, ip);
			teardown();
		};
		const onFirst = (chunk?: Buffer): void => {
			if (chunk) buf = Buffer.concat([buf, chunk]);
			const res = parseClientHelloSni(buf);
			if (res.status === "need-more") return;
			clearTimeout(deadline);
			client.off("data", onFirst);
			if (res.status === "invalid") {
				reject("sni-invalid");
				return;
			}
			if (
				res.sni === null ||
				res.sni.toLowerCase().replace(/\.$/, "") !== target.host
			) {
				reject("sni-mismatch");
				return;
			}
			client.pause();
			startPiping(buf);
			client.resume();
		};
		client.on("data", onFirst);
		client.resume();
		if (buf.length > 0) onFirst();
	}

	const server = net.createServer({ allowHalfOpen: true }, onConnection);
	server.on("error", () => {});
	await mkdir(dirname(opts.socketPath), { recursive: true, mode: 0o700 });
	await rm(opts.socketPath, { force: true });
	await new Promise<void>((resolveListen, rejectListen) => {
		server.once("error", rejectListen);
		server.listen(opts.socketPath, () => {
			server.off("error", rejectListen);
			resolveListen();
		});
	});
	await chmod(opts.socketPath, 0o600);

	return {
		socketPath: opts.socketPath,
		get active() {
			return sockets.size;
		},
		async close() {
			for (const s of sockets) s.destroy();
			await new Promise<void>((r) => server.close(() => r()));
			await rm(opts.socketPath, { force: true });
		},
	};
}

/** Race `work` against a deadline; the loser's result is dropped. */
function withDeadline<T, D>(
	work: Promise<T>,
	ms: number,
	onTimeout: D,
): Promise<T | D> {
	return new Promise((resolveRace, rejectRace) => {
		const timer = setTimeout(() => resolveRace(onTimeout), ms);
		work.then(
			(v) => {
				clearTimeout(timer);
				resolveRace(v);
			},
			(e) => {
				clearTimeout(timer);
				rejectRace(e);
			},
		);
	});
}

type HeadResult =
	| { kind: "head"; text: string; rest: Buffer }
	| { kind: "deny"; denial: EgressDenial }
	| { kind: "closed" };

/**
 * Read up to the blank line. 431 past the byte cap, 408 on a total deadline
 * (a drip client does not reset it). Bytes after the blank line (a pipelined
 * first TLS record) are returned in `rest`.
 */
function readHead(client: net.Socket, deadlineMs: number): Promise<HeadResult> {
	return new Promise((resolveHead) => {
		let buf = Buffer.alloc(0);
		let done = false;
		const finish = (r: HeadResult): void => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			client.off("data", onData);
			client.off("close", onClose);
			client.pause();
			resolveHead(r);
		};
		const onClose = (): void => finish({ kind: "closed" });
		const onData = (chunk: Buffer): void => {
			buf = Buffer.concat([buf, chunk]);
			const end = buf.indexOf("\r\n\r\n");
			if (end !== -1) {
				if (end > MAX_HEAD_BYTES) {
					finish({ kind: "deny", denial: deny(431, "head-too-large") });
					return;
				}
				// latin1 keeps one char per byte, so a non-ASCII byte is detected not decoded.
				finish({
					kind: "head",
					text: buf.subarray(0, end).toString("latin1"),
					rest: Buffer.from(buf.subarray(end + 4)),
				});
			}
			if (buf.length > MAX_HEAD_BYTES) {
				finish({ kind: "deny", denial: deny(431, "head-too-large") });
			}
		};
		const timer = setTimeout(
			() => finish({ kind: "deny", denial: deny(408, "header-timeout") }),
			deadlineMs,
		);
		client.on("data", onData);
		client.once("close", onClose);
	});
}

type Upstream =
	| { ok: true; socket: net.Socket }
	| { ok: false; denial: EgressDenial };

function connectUpstream(
	dial: (ip: string, port: number) => net.Socket,
	ip: string,
	port: number,
	timeoutMs: number,
): Promise<Upstream> {
	return new Promise((resolveUp) => {
		let socket: net.Socket;
		try {
			socket = dial(ip, port);
		} catch {
			resolveUp({ ok: false, denial: deny(502, "upstream-unreachable") });
			return;
		}
		const timer = setTimeout(() => {
			socket.destroy();
			resolveUp({ ok: false, denial: deny(504, "upstream-timeout") });
		}, timeoutMs);
		socket.once("connect", () => {
			clearTimeout(timer);
			socket.removeAllListeners("error");
			resolveUp({ ok: true, socket });
		});
		socket.once("error", () => {
			clearTimeout(timer);
			resolveUp({ ok: false, denial: deny(502, "upstream-unreachable") });
		});
	});
}
