import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	claudeWeeklyProbe,
	RateLimitObserver,
} from "../src/usage/claude-weekly.ts";
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

describe("windowLabel", () => {
	test("minutes, hours, days", () => {
		expect(windowLabel(45)).toBe("45m");
		expect(windowLabel(300)).toBe("5h");
		expect(windowLabel(10_080)).toBe("7d");
		expect(windowLabel(43_200)).toBe("30d");
		expect(windowLabel(0)).toBe("?");
	});
});

describe("claudeWeeklyProbe", () => {
	const run = (obs?: RateLimitObserver) =>
		claudeWeeklyProbe({ observer: obs }).run(new AbortController().signal);

	test("unknown with an empty ledger: no window, never 0%", async () => {
		expect((await run()).windows).toEqual([]);
		expect((await run(new RateLimitObserver())).windows).toEqual([]);
	});

	test("a percentage after an observed event", async () => {
		const o = new RateLimitObserver(() => 1_000);
		o.observe({
			status: "allowed_warning",
			limited: false,
			resetsAt: 9_000_000,
			utilization: 0.83,
		});
		const { windows } = await run(o);
		expect(windows).toHaveLength(1);
		expect(windows[0]).toMatchObject({
			label: "7d",
			usedPercent: 83,
			resetsAt: 9_000_000_000,
			windowMinutes: 10_080,
			source: "claude-rate-limit-event",
		});
	});

	test("a refusal is 100% until its reset, then unknown again", async () => {
		let now = 1_000;
		const o = new RateLimitObserver(() => now);
		o.observe({
			status: "rejected",
			limited: true,
			resetsAt: 5_000_000,
			utilization: null,
		});
		expect((await run(o)).windows[0]?.usedPercent).toBe(100);
		now = 5_000_000_000;
		expect((await run(o)).windows).toEqual([]);
	});

	test("a heartbeat without a number changes nothing", async () => {
		const o = new RateLimitObserver(() => 1_000);
		o.observe({
			status: "allowed",
			limited: false,
			resetsAt: null,
			utilization: null,
		});
		expect((await run(o)).windows).toEqual([]);
	});
});

describe("defaultUsageProbes", () => {
	test("claude is present but unknown by default; no OAuth switch remains", async () => {
		const probes = defaultUsageProbes(undefined, { PATH: "" });
		expect(probes.map((p) => p.provider)).toEqual(["claude-cli", "codex-cli"]);
		// Not installed: hidden.
		expect(await probes[0]?.available()).toBe(false);
		expect(await probes[1]?.available()).toBe(false);
	});

	test("the codex availability check does not open auth.json", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mfw-test-usage-bin-"));
		const bin = join(dir, "codex");
		writeFileSync(bin, "#!/bin/sh\n", { mode: 0o755 });
		expect(await codexUsageProbe({ command: bin }).available()).toBe(true);
		expect(
			await codexUsageProbe({ command: join(dir, "missing") }).available(),
		).toBe(false);
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
