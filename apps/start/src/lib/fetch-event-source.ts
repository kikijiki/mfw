/**
 * An `EventSource` over `fetch`, because the native one cannot send the request
 * key header. It implements the part of the interface tRPC's subscription link
 * uses, with the standard's parsing and reconnect behaviour. A 4xx is final.
 */

export interface SseEvent {
	type: string;
	data: string;
	lastEventId: string;
}

/** Incremental SSE parser. Feed it decoded text in chunks of any size. */
export function createSseParser(
	onEvent: (event: SseEvent) => void,
	onRetry: (ms: number) => void = () => {},
): (chunk: string) => void {
	let buffer = "";
	let type = "";
	let data: string[] = [];
	let lastEventId = "";
	const line = (raw: string) => {
		if (raw === "") {
			if (data.length > 0)
				onEvent({
					type: type || "message",
					data: data.join("\n"),
					lastEventId,
				});
			type = "";
			data = [];
			return;
		}
		if (raw.startsWith(":")) return;
		const at = raw.indexOf(":");
		const field = at < 0 ? raw : raw.slice(0, at);
		let value = at < 0 ? "" : raw.slice(at + 1);
		if (value.startsWith(" ")) value = value.slice(1);
		if (field === "event") type = value;
		else if (field === "data") data.push(value);
		else if (field === "id" && !value.includes("\0")) lastEventId = value;
		else if (field === "retry" && /^\d+$/.test(value)) onRetry(Number(value));
	};
	return (chunk) => {
		buffer += chunk;
		for (;;) {
			const m = /\r\n|\n|\r/.exec(buffer);
			if (!m) return;
			// A trailing CR may be half of a CRLF split across chunks.
			if (m[0] === "\r" && m.index === buffer.length - 1) return;
			line(buffer.slice(0, m.index));
			buffer = buffer.slice(m.index + m[0].length);
		}
	};
}

type Listener = (event: never) => void;
const DEFAULT_RETRY_MS = 3000;

export function makeFetchEventSource(fetchFn: typeof fetch) {
	return class FetchEventSource {
		static readonly CONNECTING = 0;
		static readonly OPEN = 1;
		static readonly CLOSED = 2;
		readonly CONNECTING = 0;
		readonly OPEN = 1;
		readonly CLOSED = 2;
		readonly withCredentials = false;
		readonly url: string;
		readyState = 0;
		private readonly listeners = new Map<string, Set<Listener>>();
		private controller: AbortController | null = null;
		private timer: ReturnType<typeof setTimeout> | null = null;
		private retryMs = DEFAULT_RETRY_MS;
		private lastEventId = "";

		constructor(url: string | URL, _init?: unknown) {
			this.url = String(url);
			// Deferred so the caller can attach listeners first.
			queueMicrotask(() => void this.connect());
		}

		addEventListener(type: string, listener: Listener): void {
			let set = this.listeners.get(type);
			if (!set) {
				set = new Set();
				this.listeners.set(type, set);
			}
			set.add(listener);
		}

		removeEventListener(type: string, listener: Listener): void {
			this.listeners.get(type)?.delete(listener);
		}

		close(): void {
			this.readyState = this.CLOSED;
			if (this.timer) clearTimeout(this.timer);
			this.timer = null;
			this.controller?.abort();
			this.controller = null;
		}

		private emit(type: string, event: Record<string, unknown>): void {
			for (const l of [...(this.listeners.get(type) ?? [])])
				(l as (e: unknown) => void)({ type, ...event });
		}

		private fail(final: boolean): void {
			if (this.readyState === this.CLOSED) return;
			if (final) this.close();
			else this.readyState = this.CONNECTING;
			this.emit("error", {});
			if (!final && this.readyState !== this.CLOSED)
				this.timer = setTimeout(() => void this.connect(), this.retryMs);
		}

		private async connect(): Promise<void> {
			if (this.readyState === this.CLOSED) return;
			const controller = new AbortController();
			this.controller = controller;
			try {
				const headers: Record<string, string> = {
					accept: "text/event-stream",
				};
				if (this.lastEventId) headers["last-event-id"] = this.lastEventId;
				const res = await fetchFn(this.url, {
					headers,
					cache: "no-store",
					signal: controller.signal,
				});
				const isStream = (res.headers.get("content-type") ?? "")
					.toLowerCase()
					.startsWith("text/event-stream");
				if (!res.ok || !isStream || !res.body) {
					await res.body?.cancel().catch(() => undefined);
					this.fail(res.status >= 400 && res.status < 500);
					return;
				}
				if (this.readyState === this.CLOSED) return;
				this.readyState = this.OPEN;
				this.emit("open", {});
				const parse = createSseParser(
					(e) => {
						this.lastEventId = e.lastEventId;
						this.emit(e.type, { data: e.data, lastEventId: e.lastEventId });
					},
					(ms) => {
						this.retryMs = ms;
					},
				);
				const reader = res.body
					.pipeThrough(new TextDecoderStream())
					.getReader();
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					parse(value);
				}
				this.fail(false);
			} catch {
				this.fail(false);
			}
		}
	} as unknown as typeof EventSource;
}
