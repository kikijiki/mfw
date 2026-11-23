import { appRouter } from "@mfw/api";
import type {
	AuthenticatedSession,
	AuthService,
} from "@mfw/daemon/auth/service";
import type { Orchestrator } from "@mfw/daemon/services";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { type GuardResult, jsonResponse } from "./auth-guard";

const PROCEDURE_LIST =
	/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*(,[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*)*$/;

/**
 * Exactly `<endpoint>/<procedure>[,<procedure>...]`. tRPC finds the procedure
 * by slicing the pathname, so it also serves other spellings (a case variant
 * of the mount, a trailing slash, percent-encoding); none of them is ours.
 */
export function isCanonicalTrpcPath(
	pathname: string,
	endpoint: string,
): boolean {
	const prefix = `${endpoint.replace(/\/$/, "")}/`;
	return (
		pathname.startsWith(prefix) &&
		PROCEDURE_LIST.test(pathname.slice(prefix.length))
	);
}

/**
 * Serve one authenticated tRPC request. The session's principal goes into the
 * context. Whether a response is a stream is read from the response itself,
 * never guessed from the URL, and every stream ends with its session.
 */
export async function serveTrpc(
	req: Request,
	guarded: GuardResult,
	deps: {
		auth: AuthService;
		endpoint: string;
		orchestrator: () => Promise<Orchestrator>;
		/** Replaces the tRPC handler (tests). */
		handle?: (req: Request) => Promise<Response>;
	},
): Promise<Response> {
	if (!guarded.ok) return guarded.response;
	const session = guarded.session;
	const apiToken = guarded.apiToken;
	const principal = apiToken ?? session?.principal;
	if (!principal)
		return jsonResponse(401, {
			error: "unauthenticated",
			message: "sign in to use the mfw API",
		});
	const url = new URL(req.url);
	if (!isCanonicalTrpcPath(url.pathname, deps.endpoint))
		return jsonResponse(404, { error: "not_found", message: "not found" });
	// One call per request, so the per-token rate limit counts calls.
	if (apiToken && (url.searchParams.has("batch") || url.pathname.includes(",")))
		return jsonResponse(400, {
			error: "batch_refused",
			message: "API tokens make one call per request",
		});
	const orchestrator = await deps.orchestrator();
	const tokenAudit = apiToken
		? {
				begin: (entry: Parameters<AuthService["beginTokenAction"]>[0]) =>
					deps.auth.beginTokenAction(entry),
				finish: (id: number, outcome: string) =>
					deps.auth.finishTokenAction(id, outcome),
			}
		: undefined;

	// A body cannot be re-wrapped cheaply, and only GET opens a subscription.
	const ac = new AbortController();
	const forward = () => ac.abort();
	const canWrap = req.method === "GET" || req.method === "HEAD";
	if (canWrap) {
		if (req.signal.aborted) ac.abort();
		else req.signal.addEventListener("abort", forward, { once: true });
	}
	const scoped = canWrap ? new Request(req, { signal: ac.signal }) : req;

	const response = await (deps.handle
		? deps.handle(scoped)
		: fetchRequestHandler({
				endpoint: deps.endpoint,
				router: appRouter,
				req: scoped,
				createContext: () => ({
					orchestrator,
					principal,
					...(tokenAudit ? { tokenAudit } : {}),
				}),
				onError({ error, path }) {
					console.error(`[mfw] tRPC error on '${path}':`, error.message);
				},
			}));

	const isStream = (response.headers.get("content-type") ?? "")
		.toLowerCase()
		.startsWith("text/event-stream");
	if (!isStream || !response.body) {
		req.signal.removeEventListener("abort", forward);
		return response;
	}
	if (apiToken && !deps.auth.tokenStreamAvailable(apiToken.tokenId)) {
		req.signal.removeEventListener("abort", forward);
		ac.abort();
		await response.body.cancel().catch(() => undefined);
		return jsonResponse(
			429,
			{
				error: "too_many_streams",
				message: "this token has too many open streams",
			},
			{ "Retry-After": "5" },
		);
	}
	return endingWithSession(response, response.body, {
		ac,
		parent: req.signal,
		forward,
		watch: (onEnd) =>
			apiToken
				? deps.auth.watchToken(apiToken.tokenId, onEnd)
				: deps.auth.watchSession(
						(session as AuthenticatedSession).sessionId,
						onEnd,
					),
	});
}

/**
 * Pass a stream through, closing it when the session ends and dropping the
 * session watch however it finishes (client gone, server done).
 */
function endingWithSession(
	response: Response,
	source: ReadableStream<Uint8Array>,
	o: {
		ac: AbortController;
		parent: AbortSignal;
		forward: () => void;
		watch: (onEnd: () => void) => () => void;
	},
): Response {
	const reader = source.getReader();
	let closed = false;
	let release = () => {};
	const finish = () => {
		closed = true;
		release();
		o.parent.removeEventListener("abort", o.forward);
		o.parent.removeEventListener("abort", stop);
		o.ac.abort();
	};
	let stop = () => {};
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			stop = () => {
				if (closed) return;
				finish();
				void reader.cancel().catch(() => undefined);
				try {
					controller.close();
				} catch {
					// already closed
				}
			};
			release = o.watch(stop);
			if (o.parent.aborted) stop();
			else o.parent.addEventListener("abort", stop, { once: true });
		},
		async pull(controller) {
			try {
				const { done, value } = await reader.read();
				if (closed) return;
				if (done) {
					finish();
					controller.close();
				} else controller.enqueue(value);
			} catch (e) {
				if (closed) return;
				finish();
				controller.error(e);
			}
		},
		cancel(reason) {
			if (closed) return;
			finish();
			return reader.cancel(reason);
		},
	});
	return new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}
