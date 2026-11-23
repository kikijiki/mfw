import { appRouter } from "@mfw/api";
import type { AuthService } from "@mfw/daemon/auth/service";
import type { Orchestrator } from "@mfw/daemon/services";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { type GuardResult, jsonResponse } from "./auth-guard";

const procedures = (
	appRouter as unknown as {
		_def: { procedures: Record<string, { _def: { type: string } }> };
	}
)._def.procedures;

/** True when the URL names a subscription, i.e. a long-lived SSE response. */
export function isSubscriptionPath(
	pathname: string,
	endpoint: string,
): boolean {
	const prefix = `${endpoint.replace(/\/$/, "")}/`;
	if (!pathname.startsWith(prefix)) return false;
	let names: string[];
	try {
		names = decodeURIComponent(pathname.slice(prefix.length)).split(",");
	} catch {
		return false;
	}
	return names.some((n) => procedures[n]?._def.type === "subscription");
}

/**
 * Serve one authenticated tRPC request. The session's principal goes into the
 * context, and an SSE stream gets a signal that ends it on logout or expiry.
 */
export async function serveTrpc(
	req: Request,
	guarded: GuardResult,
	deps: {
		auth: AuthService;
		endpoint: string;
		orchestrator: () => Promise<Orchestrator>;
	},
): Promise<Response> {
	if (!guarded.ok) return guarded.response;
	const session = guarded.session;
	if (!session)
		return jsonResponse(401, {
			error: "unauthenticated",
			message: "sign in to use the mfw API",
		});
	const orchestrator = await deps.orchestrator();
	const isStream = isSubscriptionPath(new URL(req.url).pathname, deps.endpoint);
	const watch = isStream
		? deps.auth.streamSignal(session.sessionId, req.signal)
		: null;
	const scoped = watch ? new Request(req, { signal: watch.signal }) : req;
	const response = await fetchRequestHandler({
		endpoint: deps.endpoint,
		router: appRouter,
		req: scoped,
		createContext: () => ({ orchestrator, principal: session.principal }),
		onError({ error, path }) {
			console.error(`[mfw] tRPC error on '${path}':`, error.message);
		},
	});
	return watch ? releasingWhenDone(response, watch) : response;
}

/**
 * Pass a stream through, ending it when the session ends and dropping the
 * session watch however it finishes (a client gone, the server done).
 */
function releasingWhenDone(
	response: Response,
	watch: { signal: AbortSignal; release: () => void },
): Response {
	if (!response.body) {
		watch.release();
		return response;
	}
	const reader = response.body.getReader();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			watch.signal.addEventListener(
				"abort",
				() => {
					void reader.cancel().catch(() => undefined);
					try {
						controller.close();
					} catch {
						// already closed
					}
				},
				{ once: true },
			);
		},
		async pull(controller) {
			try {
				const { done, value } = await reader.read();
				if (watch.signal.aborted) return;
				if (done) {
					watch.release();
					controller.close();
				} else controller.enqueue(value);
			} catch (e) {
				watch.release();
				if (!watch.signal.aborted) controller.error(e);
			}
		},
		cancel(reason) {
			watch.release();
			return reader.cancel(reason);
		},
	});
	return new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}
