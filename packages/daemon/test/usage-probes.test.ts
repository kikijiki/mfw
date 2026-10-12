import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CLAUDE_USAGE_URL,
	claudeUsageProbe,
	parseClaudeUsage,
} from "../src/usage/claude-usage.ts";
import {
	type CodexRpcTransport,
	codexUsageProbe,
	parseCodexRateLimits,
} from "../src/usage/codex-usage.ts";
import { defaultUsageProbes } from "../src/usage/default-probes.ts";
import { UsageProbeError, windowLabel } from "../src/usage/types.ts";

const fixture = (name: string): unknown =>
	JSON.parse(
		readFileSync(join(import.meta.dir, "fixtures/usage", name), "utf8"),
	);

const SECRET = "sk-ant-oat01-SECRET-TOKEN-VALUE";

describe("windowLabel", () => {
	test("minutes, hours, days", () => {
		expect(windowLabel(45)).toBe("45m");
		expect(windowLabel(300)).toBe("5h");
		expect(windowLabel(10_080)).toBe("7d");
		expect(windowLabel(43_200)).toBe("30d");
		expect(windowLabel(0)).toBe("?");
	});
});

describe("parseClaudeUsage", () => {
	test("reads the limits list: session, weekly, scoped weekly", () => {
		const w = parseClaudeUsage(fixture("claude-oauth-usage.json"));
		expect(w.map((x) => [x.label, x.usedPercent, x.windowMinutes])).toEqual([
			["5h", 21, 300],
			["7d", 16, 10_080],
			["7d Fable", 0, 10_080],
		]);
		expect(w[0]?.resetsAt).toBe(Date.parse("2026-10-12T13:39:59.569755+00:00"));
		expect(w[0]?.source).toBe("claude-oauth-usage");
	});

	test("falls back to the flat fields when limits is absent", () => {
		const body = fixture("claude-oauth-usage.json") as Record<string, unknown>;
		const { limits: _drop, ...flat } = body;
		const w = parseClaudeUsage({
			...flat,
			seven_day_sonnet: {
				utilization: 55.5,
				resets_at: "2026-10-19T00:00:00Z",
			},
		});
		expect(w.map((x) => [x.label, x.usedPercent])).toEqual([
			["5h", 21],
			["7d", 16],
			["7d Sonnet", 55.5],
		]);
	});

	test("clamps out of range percents", () => {
		const w = parseClaudeUsage({
			limits: [{ kind: "session", percent: 140, resets_at: null }],
		});
		expect(w[0]?.usedPercent).toBe(100);
		expect(w[0]?.resetsAt).toBeNull();
	});

	test("an unknown shape is an error, not an empty meter", () => {
		expect(() => parseClaudeUsage({ hello: 1 })).toThrow(UsageProbeError);
		expect(() => parseClaudeUsage(null)).toThrow(UsageProbeError);
		expect(() => parseClaudeUsage({ limits: [{ kind: "mystery" }] })).toThrow(
			UsageProbeError,
		);
	});
});

describe("claudeUsageProbe", () => {
	const creds = (over: Record<string, unknown> = {}) =>
		JSON.stringify({
			claudeAiOauth: {
				accessToken: SECRET,
				refreshToken: "refresh-SECRET",
				expiresAt: 2_000_000,
				subscriptionType: "max",
				...over,
			},
		});
	const json = (status: number, body: unknown) =>
		new Response(JSON.stringify(body), { status });

	test("sends the bearer token and returns windows plus the plan", async () => {
		let seen: { url: string; headers: Record<string, string> } | null = null;
		const probe = claudeUsageProbe({
			home: "/nowhere",
			env: {},
			now: () => 1_000_000,
			readFile: async () => creds(),
			fetch: async (url, init) => {
				seen = { url, headers: init.headers as Record<string, string> };
				return json(200, fixture("claude-oauth-usage.json"));
			},
		});
		expect(await probe.available()).toBe(true);
		const r = await probe.run(new AbortController().signal);
		expect(r.accountLabel).toBe("max");
		expect(r.windows).toHaveLength(3);
		expect(seen).not.toBeNull();
		const s = seen as unknown as {
			url: string;
			headers: Record<string, string>;
		};
		expect(s.url).toBe(CLAUDE_USAGE_URL);
		expect(s.headers.authorization).toBe(`Bearer ${SECRET}`);
		// The token is in the request only, never in what the probe returns.
		expect(JSON.stringify(r)).not.toContain("SECRET");
	});

	test("not signed in, expired and rejected logins are permanent errors without the token", async () => {
		const run = (read: () => Promise<string>, status = 200) =>
			claudeUsageProbe({
				env: {},
				home: "/x",
				now: () => 1_000_000,
				readFile: read,
				fetch: async () => json(status, {}),
			}).run(new AbortController().signal);

		const missing = await run(async () => {
			throw new Error("ENOENT");
		}).catch((e) => e);
		expect(missing).toBeInstanceOf(UsageProbeError);
		expect(missing.permanent).toBe(true);

		const expired = await run(async () => creds({ expiresAt: 5 })).catch(
			(e) => e,
		);
		expect(expired.message).toContain("expired");
		expect(expired.permanent).toBe(true);
		expect(expired.message).not.toContain("SECRET");

		const rejected = await run(async () => creds(), 401).catch((e) => e);
		expect(rejected.permanent).toBe(true);
		expect(rejected.message).not.toContain("SECRET");
	});

	test("a network failure message never carries the request", async () => {
		const probe = claudeUsageProbe({
			env: {},
			home: "/x",
			now: () => 1,
			readFile: async () => creds(),
			fetch: async () => {
				throw new Error(`connect failed with Bearer ${SECRET}`);
			},
		});
		const e = await probe.run(new AbortController().signal).catch((x) => x);
		expect(e).toBeInstanceOf(UsageProbeError);
		expect(e.message).not.toContain("SECRET");
	});

	test("429 and 5xx are transient", async () => {
		for (const status of [429, 503]) {
			const probe = claudeUsageProbe({
				env: {},
				home: "/x",
				now: () => 1,
				readFile: async () => creds(),
				fetch: async () => json(status, {}),
			});
			const e = await probe.run(new AbortController().signal).catch((x) => x);
			expect(e.permanent).toBe(false);
		}
	});

	test("CLAUDE_CONFIG_DIR picks the credential file", async () => {
		let path = "";
		const probe = claudeUsageProbe({
			env: { CLAUDE_CONFIG_DIR: "/cfg/claude" },
			home: "/home/x",
			readFile: async (p) => {
				path = p;
				throw new Error("nope");
			},
		});
		expect(await probe.available()).toBe(false);
		expect(path).toBe("/cfg/claude/.credentials.json");
	});
});

describe("parseCodexRateLimits", () => {
	test("primary and secondary, resetsAt seconds to ms, plan label", () => {
		const r = parseCodexRateLimits(fixture("codex-rate-limits.json"));
		expect(r.accountLabel).toBe("plus");
		expect(
			r.windows.map((w) => [w.label, w.usedPercent, w.windowMinutes]),
		).toEqual([
			["5h", 41, 300],
			["7d", 7, 10_080],
			["5h Spark", 3, 300],
		]);
		expect(r.windows[0]?.resetsAt).toBe(1793445217 * 1000);
		expect(JSON.stringify(r)).not.toContain("0000-0000");
	});

	test("a 30 day free-plan window is labelled 30d", () => {
		const r = parseCodexRateLimits({
			rateLimits: {
				primary: { usedPercent: 4, windowDurationMins: 43_200, resetsAt: 1 },
				secondary: null,
			},
		});
		expect(r.windows[0]?.label).toBe("30d");
	});

	test("no windows is an error", () => {
		expect(() =>
			parseCodexRateLimits({ rateLimits: { primary: null, secondary: null } }),
		).toThrow(UsageProbeError);
	});
});

class FakeTransport implements CodexRpcTransport {
	written: Record<string, unknown>[] = [];
	killed = false;
	private line: (l: string) => void = () => {};
	private close: () => void = () => {};
	constructor(
		private readonly script: (
			msg: Record<string, unknown>,
			reply: (o: unknown) => void,
			close: () => void,
		) => void,
	) {}
	write(l: string) {
		const msg = JSON.parse(l) as Record<string, unknown>;
		this.written.push(msg);
		queueMicrotask(() =>
			this.script(
				msg,
				(o) => this.line(JSON.stringify(o)),
				() => this.close(),
			),
		);
	}
	onLine(cb: (l: string) => void) {
		this.line = cb;
	}
	onClose(cb: () => void) {
		this.close = cb;
	}
	kill() {
		this.killed = true;
	}
}

describe("codexUsageProbe", () => {
	test("initialize, initialized, rateLimits/read, then kills the process", async () => {
		const t = new FakeTransport((msg, reply) => {
			if (msg.method === "initialize") reply({ id: 1, result: {} });
			if (msg.method === "account/rateLimits/read")
				reply({ id: 2, result: fixture("codex-rate-limits.json") });
		});
		const probe = codexUsageProbe({
			transport: () => t,
			signedIn: async () => true,
		});
		const r = await probe.run(new AbortController().signal);
		expect(r.windows).toHaveLength(3);
		expect(t.written.map((m) => m.method)).toEqual([
			"initialize",
			"initialized",
			"account/rateLimits/read",
		]);
		expect(t.killed).toBe(true);
	});

	test("an error reply is a permanent unavailable", async () => {
		const t = new FakeTransport((msg, reply) => {
			if (msg.method === "initialize") reply({ id: 1, result: {} });
			if (msg.method === "account/rateLimits/read")
				reply({ id: 2, error: { code: -32000, message: "no chatgpt auth" } });
		});
		const e = await codexUsageProbe({ transport: () => t })
			.run(new AbortController().signal)
			.catch((x) => x);
		expect(e).toBeInstanceOf(UsageProbeError);
		expect(e.permanent).toBe(true);
		expect(t.killed).toBe(true);
	});

	test("the process dying mid-read rejects and times out are bounded", async () => {
		const dies = new FakeTransport((msg, _reply, close) => {
			if (msg.method === "initialize") close();
		});
		const e1 = await codexUsageProbe({ transport: () => dies })
			.run(new AbortController().signal)
			.catch((x) => x);
		expect(e1.message).toContain("exited");

		const silent = new FakeTransport(() => {});
		const e2 = await codexUsageProbe({
			transport: () => silent,
			timeoutMs: 20,
		})
			.run(new AbortController().signal)
			.catch((x) => x);
		expect(e2.message).toContain("timed out");
		expect(silent.killed).toBe(true);
	});
});

describe("MFW_USAGE_FIXTURE", () => {
	const write = (body: unknown): string => {
		const dir = mkdtempSync(join(tmpdir(), "mfw-test-usage-fixture-"));
		const file = join(dir, "usage.json");
		writeFileSync(file, JSON.stringify(body));
		return file;
	};

	test("serves the file's windows and reads no credential", async () => {
		const file = write({
			subscriptions: [
				{
					provider: "claude-cli",
					name: "Claude Code",
					accountLabel: "max",
					windows: [
						{
							label: "5h",
							usedPercent: 140,
							resetsAt: 1_000,
							windowMinutes: 300,
						},
						{
							label: "7d",
							usedPercent: 38,
							resetsAt: 2_000,
							windowMinutes: 10_080,
						},
					],
				},
			],
		});
		const probes = defaultUsageProbes(undefined, { MFW_USAGE_FIXTURE: file });
		expect(probes.map((p) => p.provider)).toEqual(["claude-cli"]);
		const probe = probes[0];
		expect(await probe?.available()).toBe(true);
		const result = await probe?.run(new AbortController().signal);
		expect(result?.accountLabel).toBe("max");
		expect(
			result?.windows.map((w) => [w.label, w.usedPercent, w.resetsAt]),
		).toEqual([
			["5h", 100, 1_000],
			["7d", 38, 2_000],
		]);
	});

	test("an unreadable fixture yields no probes, never the real ones", () => {
		expect(
			defaultUsageProbes(undefined, { MFW_USAGE_FIXTURE: "/nonexistent.json" }),
		).toEqual([]);
	});
});
