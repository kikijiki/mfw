import { describe, expect, test } from "bun:test";
import {
	createSseParser,
	makeFetchEventSource,
	type SseEvent,
} from "./fetch-event-source";

const parse = (chunks: string[]) => {
	const events: SseEvent[] = [];
	const feed = createSseParser((e) => events.push(e));
	for (const c of chunks) feed(c);
	return events;
};

describe("SSE parser", () => {
	test("reads named events, ids and multi-line data", () => {
		expect(parse(["event: ping\ndata: a\ndata: b\nid: 7\n\n"])).toEqual([
			{ type: "ping", data: "a\nb", lastEventId: "7" },
		]);
	});

	test("survives any chunk boundary, including inside CRLF", () => {
		const text = "data: one\r\n\r\ndata: two\r\n\r\n";
		const split = [...text];
		expect(parse(split).map((e) => e.data)).toEqual(["one", "two"]);
	});

	test("ignores comments and dispatches nothing without data", () => {
		expect(parse([": keepalive\n\nevent: x\n\n"])).toEqual([]);
	});
});

const sse = (body: string, status = 200) =>
	new Response(body, {
		status,
		headers: { "content-type": "text/event-stream" },
	});

describe("fetch EventSource", () => {
	test("delivers events through the fetch it was given", async () => {
		const calls: string[] = [];
		const Source = makeFetchEventSource((async (url: string) => {
			calls.push(url);
			return sse("event: connected\ndata: {}\n\ndata: hello\n\n");
		}) as unknown as typeof fetch);
		const source = new Source("http://x/s");
		const got = await new Promise<string>((done) =>
			source.addEventListener("message", (e) => done(e.data)),
		);
		source.close();
		expect(got).toBe("hello");
		expect(calls).toEqual(["http://x/s"]);
	});

	test("a 401 is final: it closes and does not reconnect", async () => {
		let calls = 0;
		const Source = makeFetchEventSource((async () => {
			calls++;
			return new Response("{}", { status: 401 });
		}) as unknown as typeof fetch);
		const source = new Source("http://x/s");
		await new Promise((done) => source.addEventListener("error", done));
		expect(source.readyState).toBe(source.CLOSED);
		await Bun.sleep(20);
		expect(calls).toBe(1);
	});
});
