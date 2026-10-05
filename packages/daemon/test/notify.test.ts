import { describe, expect, test } from "bun:test";
import { silentLogger } from "../src/log.ts";
import { ConfigNotifier, makeNotifier, NoopNotifier } from "../src/notify.ts";

function notification() {
	return {
		type: "blocked" as const,
		project: "demo",
		taskId: "MFW-1",
		message: "needs a human",
	};
}

/** Spin up a throwaway HTTP sink that answers with the given status. */
async function sink(status: number) {
	const received: unknown[] = [];
	const server = Bun.serve({
		port: 0,
		async fetch(req) {
			received.push(await req.json());
			return new Response("", { status });
		},
	});
	return {
		url: `http://localhost:${server.port}/hook`,
		received,
		stop: () => server.stop(true),
	};
}

describe("notifier delivery reporting", () => {
	test("a 2xx webhook is a delivery, and the payload arrives intact", async () => {
		const s = await sink(200);
		const n = new ConfigNotifier({ webhook: s.url }, silentLogger());
		const results = await n.send(notification());
		expect(results).toHaveLength(1);
		expect(results[0]?.ok).toBe(true);
		expect(s.received[0]).toMatchObject({ project: "demo", taskId: "MFW-1" });
		expect(n.stats()).toMatchObject({ sent: 1, delivered: 1, failed: 0 });
		s.stop();
	});

	test("a non-2xx response is a FAILURE, not a silent success", async () => {
		// The v1 bug: `.catch(() => {})` around fetch meant a 500 from the sink
		// was indistinguishable from delivery.
		const s = await sink(500);
		const n = new ConfigNotifier({ webhook: s.url }, silentLogger());
		const results = await n.send(notification());
		expect(results[0]?.ok).toBe(false);
		expect(results[0]?.detail).toContain("500");
		const stats = n.stats();
		expect(stats.failed).toBe(1);
		expect(stats.lastFailure?.sink).toBe("webhook");
		s.stop();
	});

	test("an unreachable webhook is reported, not swallowed", async () => {
		const n = new ConfigNotifier(
			{ webhook: "http://127.0.0.1:1/nope", timeoutMs: 2000 },
			silentLogger(),
		);
		const results = await n.send(notification());
		expect(results[0]?.ok).toBe(false);
		expect(n.stats().lastFailure).not.toBeNull();
	});

	test("command sink: exit 0 delivers, nonzero fails with the stderr tail", async () => {
		const ok = new ConfigNotifier({ command: "true" }, silentLogger());
		expect((await ok.send(notification()))[0]?.ok).toBe(true);

		const bad = new ConfigNotifier(
			{ command: "echo boom >&2; exit 3" },
			silentLogger(),
		);
		const results = await bad.send(notification());
		expect(results[0]?.ok).toBe(false);
		expect(results[0]?.detail).toContain("exit 3");
		expect(results[0]?.detail).toContain("boom");
	});

	test("the notification is passed to the command as env vars", async () => {
		const marker = `/tmp/mfw-notify-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		const n = new ConfigNotifier(
			{
				command: `printf '%s|%s|%s' "$MFW_NOTIFY_TYPE" "$MFW_NOTIFY_PROJECT" "$MFW_NOTIFY_TASK" > ${marker}`,
			},
			silentLogger(),
		);
		await n.send(notification());
		expect(await Bun.file(marker).text()).toBe("blocked|demo|MFW-1");
		await Bun.file(marker).delete();
	});

	test("a hung sink times out instead of wedging finalization", async () => {
		const server = Bun.serve({
			port: 0,
			fetch: () => new Promise<Response>(() => {}), // never resolves
		});
		const n = new ConfigNotifier(
			{ webhook: `http://localhost:${server.port}/`, timeoutMs: 250 },
			silentLogger(),
		);
		const t0 = Date.now();
		const results = await n.send(notification());
		expect(results[0]?.ok).toBe(false);
		expect(Date.now() - t0).toBeLessThan(3000);
		server.stop(true);
	});

	test("both sinks are attempted independently, one failing does not hide the other", async () => {
		const s = await sink(200);
		const n = new ConfigNotifier(
			{ webhook: s.url, command: "exit 1" },
			silentLogger(),
		);
		const results = await n.send(notification());
		expect(results).toHaveLength(2);
		expect(results.filter((r) => r.ok)).toHaveLength(1);
		expect(n.stats()).toMatchObject({ delivered: 1, failed: 1 });
		s.stop();
	});
});

describe("notifier configuration", () => {
	test("no sink reports configured:false, distinct from 'delivered'", async () => {
		const n = makeNotifier(undefined, silentLogger());
		expect(n).toBeInstanceOf(NoopNotifier);
		const results = await n.send(notification());
		expect(results).toEqual([]);
		const stats = n.stats();
		// The operator can see they have NO escalation channel at all, rather
		// than a channel that appears healthy because nothing ever failed.
		expect(stats.configured).toBe(false);
		expect(stats.sent).toBe(1);
		expect(stats.delivered).toBe(0);
	});

	test("makeNotifier builds a real notifier when a sink is configured", () => {
		expect(makeNotifier({ command: "true" }, silentLogger())).toBeInstanceOf(
			ConfigNotifier,
		);
	});
});
