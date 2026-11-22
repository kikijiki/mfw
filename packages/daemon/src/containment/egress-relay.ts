/**
 * In-sandbox relay: a TCP listener on `127.0.0.1:3128` that pipes every
 * connection to the per-run egress proxy's unix socket, which the engine
 * bind-mounts into the sandbox (the sandbox experiments, E2b). The relay is a
 * dumb byte pipe. It has no policy: the proxy is the only gate, and the netns
 * is what makes every client that skips the relay fail closed.
 *
 * It uses only `node:net`, so it runs under Bun inside the sandbox with no
 * socat. It can run as a library (`startEgressRelay`) or as a script:
 * `bun egress-relay.ts --socket <path> [--port 3128] [--host 127.0.0.1]`.
 */

import net from "node:net";

export const RELAY_HOST = "127.0.0.1";
export const RELAY_PORT = 3128;

export interface EgressRelayOptions {
	/** Absolute path of the proxy's unix socket (as seen inside the sandbox). */
	socketPath: string;
	/** Default 3128. 0 picks a free port (tests). */
	port?: number;
	/** Default 127.0.0.1. Never bind a routable address. */
	host?: string;
}

export interface EgressRelay {
	readonly host: string;
	/** The bound port, resolved when `port` was 0. */
	readonly port: number;
	/** Pipes currently open. */
	readonly active: number;
	/** Stop listening and destroy every pipe. */
	close(): Promise<void>;
}

/** Start the relay. Resolves once it is listening. */
export async function startEgressRelay(
	opts: EgressRelayOptions,
): Promise<EgressRelay> {
	const host = opts.host ?? RELAY_HOST;
	const pairs = new Set<net.Socket>();

	const server = net.createServer({ allowHalfOpen: true }, (client) => {
		const upstream = net.connect({
			path: opts.socketPath,
			allowHalfOpen: true,
		});
		pairs.add(client);
		pairs.add(upstream);
		const drop = (): void => {
			client.destroy();
			upstream.destroy();
			pairs.delete(client);
			pairs.delete(upstream);
		};
		client.on("error", drop);
		upstream.on("error", drop);
		// Both directions closed, or either side gone before it could finish.
		let open = 2;
		const half = (): void => {
			if (--open === 0) drop();
		};
		client.on("close", drop);
		upstream.on("close", drop);
		client.on("end", half);
		upstream.on("end", half);
		// Piped at once: writes to a connecting socket are queued, so nothing the
		// client sends before the upstream is up is lost.
		client.pipe(upstream);
		upstream.pipe(client);
	});

	await new Promise<void>((resolve, reject) => {
		const onError = (err: Error): void => reject(err);
		server.once("error", onError);
		server.listen(opts.port ?? RELAY_PORT, host, () => {
			server.off("error", onError);
			resolve();
		});
	});
	// A late server error must not crash the sandbox's relay process silently.
	server.on("error", () => {});

	return {
		host,
		port: (server.address() as net.AddressInfo).port,
		get active() {
			return pairs.size / 2;
		},
		async close() {
			for (const s of pairs) s.destroy();
			pairs.clear();
			await new Promise<void>((r) => server.close(() => r()));
		},
	};
}

/** Parse `--socket/--port/--host` for the script entry. */
export function parseRelayArgs(argv: readonly string[]): EgressRelayOptions {
	let socketPath: string | undefined;
	let port: number | undefined;
	let host: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		const value = argv[i + 1];
		if (flag === "--socket" || flag === "--port" || flag === "--host") {
			if (value === undefined) throw new Error(`${flag} needs a value`);
			i++;
			if (flag === "--socket") socketPath = value;
			else if (flag === "--host") host = value;
			else {
				port = Number(value);
				if (!Number.isInteger(port) || port < 0 || port > 65535) {
					throw new Error(`invalid --port: ${value}`);
				}
			}
		} else {
			throw new Error(`unknown argument: ${flag}`);
		}
	}
	if (!socketPath) throw new Error("--socket is required");
	return {
		socketPath,
		...(port !== undefined ? { port } : {}),
		...(host ? { host } : {}),
	};
}

if (import.meta.main) {
	try {
		const relay = await startEgressRelay(parseRelayArgs(process.argv.slice(2)));
		console.log(`egress-relay listening on ${relay.host}:${relay.port}`);
		const stop = (): void => {
			void relay.close().then(() => process.exit(0));
		};
		process.on("SIGTERM", stop);
		process.on("SIGINT", stop);
	} catch (err) {
		console.error(`egress-relay: ${(err as Error).message}`);
		process.exit(1);
	}
}
