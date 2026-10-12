import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderHoldStore } from "../src/provider-holds.ts";
import {
	type UsageProbe,
	UsageProbeError,
	type UsageProbeResult,
	type UsageWindow,
} from "../src/usage/types.ts";
import { USAGE_HOLD_PREFIX, UsageMonitor } from "../src/usage-monitor.ts";

const MIN = 60_000;

function win(
	label: string,
	usedPercent: number,
	resetsAt: number,
): UsageWindow {
	return {
		label,
		usedPercent,
		resetsAt,
		windowMinutes: label === "5h" ? 300 : 10_080,
		source: "test",
	};
}

/** A probe whose behaviour the test steers; counts calls and concurrency. */
function fakeProbe(provider = "claude-cli") {
	const probe = {
		calls: 0,
		maxConcurrent: 0,
		running: 0,
		available: true,
		next: (async () => ({ windows: [] })) as () => Promise<UsageProbeResult>,
		gate: null as Promise<void> | null,
	};
	const p: UsageProbe = {
		provider,
		name: provider,
		available: async () => probe.available,
		run: async () => {
			probe.calls += 1;
			probe.running += 1;
			probe.maxConcurrent = Math.max(probe.maxConcurrent, probe.running);
			try {
				if (probe.gate) await probe.gate;
				return await probe.next();
			} finally {
				probe.running -= 1;
			}
		},
	};
	return { probe, p };
}

function clock(start = 1_000_000) {
	let t = start;
	const timers: {
		fn: () => void;
		ms: number;
		at: number;
		cancelled: boolean;
	}[] = [];
	return {
		now: () => t,
		advance: (ms: number) => {
			t += ms;
		},
		schedule: (fn: () => void, ms: number) => {
			const timer = { fn, ms, at: t + ms, cancelled: false };
			timers.push(timer);
			return () => {
				timer.cancelled = true;
			};
		},
		timers,
	};
}

describe("UsageMonitor", () => {
	test("hides a provider that is not installed or signed in", async () => {
		const c = clock();
		const { probe, p } = fakeProbe();
		probe.available = false;
		const m = new UsageMonitor({
			probes: [p],
			now: c.now,
			schedule: c.schedule,
		});
		await m.tick();
		expect(m.snapshot()).toEqual([]);
		expect(probe.calls).toBe(0);
	});

	test("ok snapshot carries windows, plan and fetchedAt", async () => {
		const c = clock();
		const { probe, p } = fakeProbe();
		probe.next = async () => ({
			accountLabel: "max",
			windows: [win("5h", 21, c.now() + 2 * 60 * MIN)],
		});
		const m = new UsageMonitor({
			probes: [p],
			now: c.now,
			schedule: c.schedule,
		});
		await m.tick();
		const [s] = m.snapshot();
		expect(s).toMatchObject({
			provider: "claude-cli",
			accountLabel: "max",
			status: "ok",
			fetchedAt: c.now(),
		});
		expect(s?.windows[0]?.usedPercent).toBe(21);
	});

	test("cadence: not due again until the interval, then probes; loop reschedules with jitter", async () => {
		const c = clock();
		const { probe, p } = fakeProbe();
		probe.next = async () => ({ windows: [win("5h", 1, c.now() + 999 * MIN)] });
		const m = new UsageMonitor({
			probes: [p],
			now: c.now,
			schedule: c.schedule,
			random: () => 0, // jitter factor 0.9
		});
		await m.start();
		expect(probe.calls).toBe(1);
		// The loop armed exactly one timer at 0.9 * 60s.
		expect(c.timers).toHaveLength(1);
		expect(c.timers[0]?.ms).toBe(54_000);

		c.advance(30_000);
		await m.tick();
		expect(probe.calls).toBe(1); // not due

		c.advance(31_000);
		await m.tick();
		expect(probe.calls).toBe(2);
		m.stop();
		expect(c.timers[0]?.cancelled).toBe(true);
	});

	test("single flight: a slow probe is never run twice at once", async () => {
		const c = clock();
		const { probe, p } = fakeProbe();
		let release!: () => void;
		probe.gate = new Promise<void>((r) => {
			release = r;
		});
		probe.next = async () => ({ windows: [win("5h", 5, c.now() + 99 * MIN)] });
		const m = new UsageMonitor({
			probes: [p],
			now: c.now,
			schedule: c.schedule,
		});
		const a = m.tick();
		const b = m.refresh();
		const d = m.tick(true);
		release();
		await Promise.all([a, b, d]);
		expect(probe.calls).toBe(1);
		expect(probe.maxConcurrent).toBe(1);
	});

	test("failure backs off exponentially, success resets, and one provider never delays another", async () => {
		const c = clock();
		const a = fakeProbe("claude-cli");
		const b = fakeProbe("codex-cli");
		a.probe.next = async () => {
			throw new UsageProbeError("usage endpoint HTTP 503");
		};
		b.probe.next = async () => ({
			windows: [win("5h", 1, c.now() + 999 * MIN)],
		});
		const m = new UsageMonitor({
			probes: [a.p, b.p],
			now: c.now,
			schedule: c.schedule,
			maxBackoffMs: 8 * MIN,
		});
		await m.tick();
		expect([a.probe.calls, b.probe.calls]).toEqual([1, 1]);
		// failure 1: due in 2 min
		c.advance(MIN);
		await m.tick();
		expect([a.probe.calls, b.probe.calls]).toEqual([1, 2]); // b is on its 60s cadence
		c.advance(MIN);
		await m.tick();
		expect(a.probe.calls).toBe(2);
		// failure 2: due in 4 min
		c.advance(3 * MIN);
		await m.tick();
		expect(a.probe.calls).toBe(2);
		c.advance(MIN);
		await m.tick();
		expect(a.probe.calls).toBe(3);
		// failure 3 would be 8 min; capped at maxBackoffMs = 8 min
		c.advance(7 * MIN);
		await m.tick();
		expect(a.probe.calls).toBe(3);
		c.advance(MIN);
		a.probe.next = async () => ({
			windows: [win("5h", 9, c.now() + 99 * MIN)],
		});
		await m.tick();
		expect(a.probe.calls).toBe(4);
		expect(m.snapshot().find((s) => s.provider === "claude-cli")?.status).toBe(
			"ok",
		);
		// success: back to the 60s cadence
		c.advance(MIN);
		await m.tick();
		expect(a.probe.calls).toBe(5);
	});

	test("a permanent failure waits at least the permanent backoff", async () => {
		const c = clock();
		const { probe, p } = fakeProbe();
		probe.next = async () => {
			throw new UsageProbeError("not signed in", true);
		};
		const m = new UsageMonitor({
			probes: [p],
			now: c.now,
			schedule: c.schedule,
		});
		await m.tick();
		c.advance(4 * MIN);
		await m.tick();
		expect(probe.calls).toBe(1);
		c.advance(MIN);
		await m.tick();
		expect(probe.calls).toBe(2);
	});

	test("never invents numbers: stale keeps last good (dropping expired windows), then unavailable", async () => {
		const c = clock();
		const { probe, p } = fakeProbe();
		const fiveHourReset = c.now() + 10 * MIN;
		probe.next = async () => ({
			windows: [
				win("5h", 90, fiveHourReset),
				win("7d", 40, c.now() + 999 * MIN),
			],
		});
		const m = new UsageMonitor({
			probes: [p],
			now: c.now,
			schedule: c.schedule,
			maxStaleMs: 20 * MIN,
		});
		await m.tick();
		probe.next = async () => {
			throw new UsageProbeError("usage endpoint unreachable");
		};
		c.advance(2 * MIN);
		await m.tick(true);
		let [s] = m.snapshot();
		expect(s?.status).toBe("stale");
		expect(s?.error).toBe("usage endpoint unreachable");
		expect(s?.windows.map((w) => w.label)).toEqual(["5h", "7d"]);

		// The 5h window has reset since: a stale 90% would be wrong, so it is dropped.
		c.advance(10 * MIN);
		[s] = m.snapshot();
		expect(s?.status).toBe("stale");
		expect(s?.windows.map((w) => w.label)).toEqual(["7d"]);

		c.advance(30 * MIN);
		[s] = m.snapshot();
		expect(s?.status).toBe("unavailable");
		expect(s?.windows).toEqual([]);
		expect(s?.error).toBe("usage endpoint unreachable");
	});

	test("a provider that never worked is unavailable with its reason", async () => {
		const c = clock();
		const { probe, p } = fakeProbe();
		probe.next = async () => {
			throw new Error("boom with Bearer SECRET");
		};
		const m = new UsageMonitor({
			probes: [p],
			now: c.now,
			schedule: c.schedule,
		});
		await m.tick();
		const [s] = m.snapshot();
		expect(s?.status).toBe("unavailable");
		// An unexpected exception's text is never surfaced.
		expect(s?.error).toBe("usage probe failed");
	});

	test("emits on change only", async () => {
		const c = clock();
		const { probe, p } = fakeProbe();
		let pct = 10;
		const reset = c.now() + 99 * MIN;
		probe.next = async () => ({ windows: [win("5h", pct, reset)] });
		const m = new UsageMonitor({
			probes: [p],
			now: c.now,
			schedule: c.schedule,
		});
		const seen: number[] = [];
		m.subscribe((s) => seen.push(s[0]?.windows[0]?.usedPercent ?? -1));
		await m.tick();
		c.advance(MIN);
		await m.tick();
		expect(seen).toEqual([10]);
		pct = 11;
		c.advance(MIN);
		await m.tick();
		expect(seen).toEqual([10, 11]);
	});

	describe("provider holds", () => {
		const store = () =>
			ProviderHoldStore.at(
				mkdtempSync(join(tmpdir(), "mfw-usage-holds-")),
				() => 1_000_000,
			);

		test("a window at 100% holds the provider until its reset, and a drop clears only its own hold", async () => {
			const c = clock(1_000_000);
			const holds = store();
			const { probe, p } = fakeProbe("claude-cli");
			const reset = c.now() + 90 * MIN;
			probe.next = async () => ({
				windows: [win("5h", 100, reset), win("7d", 30, c.now() + 999 * MIN)],
			});
			const m = new UsageMonitor({
				probes: [p],
				holds,
				now: c.now,
				schedule: c.schedule,
			});
			await m.tick();
			const held = (await holds.active())["claude-cli"];
			expect(held?.until).toBe(reset);
			expect(held?.reason.startsWith(USAGE_HOLD_PREFIX)).toBe(true);
			expect(held?.reason).toContain("5h");

			probe.next = async () => ({ windows: [win("5h", 40, reset)] });
			c.advance(MIN);
			await m.tick();
			expect((await holds.active())["claude-cli"]).toBeUndefined();
		});

		test("a rate-limit hold from a run is left alone", async () => {
			const c = clock(1_000_000);
			const holds = store();
			await holds.hold("claude-cli", {
				until: 5_000_000,
				reason: "rate_limited",
			});
			const { probe, p } = fakeProbe("claude-cli");
			probe.next = async () => ({
				windows: [win("5h", 10, c.now() + 99 * MIN)],
			});
			const m = new UsageMonitor({
				probes: [p],
				holds,
				now: c.now,
				schedule: c.schedule,
			});
			await m.tick();
			expect((await holds.active())["claude-cli"]?.reason).toBe("rate_limited");
		});

		test("under 100% or with no reset time places no hold", async () => {
			const c = clock(1_000_000);
			const holds = store();
			const { probe, p } = fakeProbe("codex-cli");
			probe.next = async () => ({
				windows: [
					win("5h", 99, c.now() + 10 * MIN),
					{ ...win("7d", 100, 0), resetsAt: null },
				],
			});
			const m = new UsageMonitor({
				probes: [p],
				holds,
				now: c.now,
				schedule: c.schedule,
			});
			await m.tick();
			expect(await holds.active()).toEqual({});
		});
	});
});
