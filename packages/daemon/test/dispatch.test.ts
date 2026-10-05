import { describe, expect, test } from "bun:test";
import {
	type DispatchTarget,
	dispatchStatusAll,
	type GlobalDispatchStore,
	setDispatching,
	setGlobalDispatching,
	summarize,
} from "../src/dispatch.ts";
import type { SchedulerStatus } from "../src/scheduler.ts";

// The fakes model the key property: `setEnabled` writes a durable flag without
// starting the loop; `settings.update` persists `schedulerAutostart` and starts it.

class FakeScheduler {
	running = false;
	paused = false;
	pauseReason: string | null = null;
	hold: { until: number; reason: string } | null = null;
	/** Every start/stop/flag write, in order. */
	readonly log: string[] = [];
	failStart = false;

	async setEnabled(on: boolean, reason = "manual"): Promise<void> {
		this.paused = !on;
		this.pauseReason = on ? null : reason;
		this.log.push(on ? "unpause" : "pause");
	}

	/** Stands in for `SettingsService.update({schedulerAutostart})`, which calls `start()`/`stop()`. */
	setRunning(on: boolean): void {
		this.running = on;
		this.log.push(on ? "start" : "stop");
	}

	async status(): Promise<SchedulerStatus> {
		const playing = this.running && !this.paused;
		const state = !playing ? "stopped" : this.hold ? "held" : "dispatching";
		return {
			playing,
			// No master switch in the fake.
			projectPlaying: playing,
			globalPlaying: true,
			running: this.running,
			enabled: !this.paused,
			state,
			reason:
				state === "dispatching"
					? null
					: state === "held"
						? (this.hold?.reason ?? null)
						: (this.pauseReason ?? "the dispatch loop is not running"),
			selfStopped: state === "held",
			lastTickAt: 0,
			lastTickMs: 0,
			hold: this.hold,
			mainRed: false,
			boardSuspended: false,
			inFlight: 0,
			errors: 0,
		};
	}
}

/** Records what reached config.json, and serializes like the real one does. */
class FakeSettings {
	readonly writes: boolean[] = [];
	/** Makes the persist step throw (e.g. read-only home). */
	fail: string | null = null;
	/** Counts `update` calls mid-flight; a concurrent fan-out would raise it. */
	static inFlight = 0;
	static maxInFlight = 0;

	constructor(private readonly scheduler: FakeScheduler) {}

	async update(patch: { schedulerAutostart: boolean }): Promise<unknown> {
		FakeSettings.inFlight++;
		FakeSettings.maxInFlight = Math.max(
			FakeSettings.maxInFlight,
			FakeSettings.inFlight,
		);
		try {
			// Yield mid-write, like a real read-modify-write of a shared file.
			await Bun.sleep(1);
			if (this.fail) throw new Error(this.fail);
			this.writes.push(patch.schedulerAutostart);
			this.scheduler.setRunning(patch.schedulerAutostart);
			return {};
		} finally {
			FakeSettings.inFlight--;
		}
	}
}

interface Fake extends DispatchTarget {
	scheduler: FakeScheduler;
	settings: FakeSettings;
}

function target(name: string): Fake {
	const scheduler = new FakeScheduler();
	return { name, scheduler, settings: new FakeSettings(scheduler) };
}

describe("setDispatching: one control, both switches", () => {
	test("play clears the pause, starts the loop, and persists the choice", async () => {
		const t = target("demo");
		expect((await t.scheduler.status()).state).toBe("stopped");

		const status = await setDispatching(t, true);

		expect(status.playing).toBe(true);
		expect(status.running).toBe(true);
		expect(status.enabled).toBe(true);
		expect(status.state).toBe("dispatching");
		// `schedulerAutostart` makes a restart resume.
		expect(t.settings.writes).toEqual([true]);
	});

	test("play on a project someone paused LAST WEEK still dispatches", async () => {
		const t = target("demo");
		await t.scheduler.setEnabled(false, "operator");

		const status = await setDispatching(t, true);
		// A `start()`-only control would gate out every tick on the stale pause flag.
		expect(status.state).toBe("dispatching");
		expect(t.scheduler.paused).toBe(false);
	});

	test("play on a project that was only ever paused-off still starts the loop", async () => {
		const t = target("demo");
		// A `setEnabled`-only control would flip the flag with no loop running.
		const status = await setDispatching(t, true);
		expect(t.scheduler.running).toBe(true);
		expect(status.playing).toBe(true);
	});

	test("stop persists both halves, so a restart stays stopped", async () => {
		const t = target("demo");
		await setDispatching(t, true);

		const status = await setDispatching(t, false, "stopped from the UI");
		expect(status.playing).toBe(false);
		expect(status.state).toBe("stopped");
		expect(status.reason).toBe("stopped from the UI");
		expect(t.settings.writes).toEqual([true, false]);
		expect(t.scheduler.paused).toBe(true);
	});

	test("the order is safe in both directions", async () => {
		const t = target("demo");
		await setDispatching(t, true);
		// Gate cleared before the loop starts, so a failure between cannot start work.
		expect(t.scheduler.log).toEqual(["unpause", "start"]);

		t.scheduler.log.length = 0;
		await setDispatching(t, false);
		// Loop stopped before the gate is set.
		expect(t.scheduler.log).toEqual(["stop", "pause"]);
	});

	test("a failed persist leaves the project stopped, never half-started", async () => {
		const t = target("demo");
		t.settings.fail = "config.json is read-only";
		await expect(setDispatching(t, true)).rejects.toThrow("read-only");
		// The flag was cleared but no loop exists; status must not report "on".
		const status = await t.scheduler.status();
		expect(status.running).toBe(false);
		expect(status.playing).toBe(false);
		expect(status.state).toBe("stopped");
	});

	test("play reports the truth when a hold is still in the way", async () => {
		const t = target("demo");
		t.scheduler.hold = { until: Date.now() + 60_000, reason: "rate-limited" };
		const status = await setDispatching(t, true);
		// Playing but not dispatching.
		expect(status.playing).toBe(true);
		expect(status.state).toBe("held");
		expect(status.selfStopped).toBe(true);
	});

	// Overlapping Stop/Play calls (double-click, two tabs): each is two awaited
	// steps, so without serialization their steps interleave and
	// `schedulerAutostart` and the pause flag end up disagreeing.
	test("a double-click of stop/play never leaves schedulerAutostart and the pause flag disagreeing", async () => {
		const t = target("demo");
		await setDispatching(t, true);

		await Promise.all([
			setDispatching(t, false, "tab A stop"),
			setDispatching(t, true),
		]);

		// The last `schedulerAutostart` write is the final intent; the pause flag must agree.
		const lastAutostart = t.settings.writes.at(-1);
		expect(t.scheduler.paused).toBe(!lastAutostart);
	});
});

describe("the fleet: a tri-state over each project's OWN switch", () => {
	const status = (projectPlaying: boolean) =>
		({ projectPlaying }) as unknown as SchedulerStatus;
	const of = (project: string, projectPlaying: boolean) => ({
		project,
		status: status(projectPlaying),
		error: null,
	});

	test("summarize refuses to round a mixed fleet to either end", () => {
		expect(summarize([]).summary).toBe("empty");
		expect(summarize([of("a", false), of("b", false)]).summary).toBe("none");
		expect(summarize([of("a", true), of("b", true)]).summary).toBe("all");

		const mixed = summarize([of("a", true), of("b", false), of("c", false)]);
		expect(mixed.summary).toBe("some");
		expect(mixed.playing).toBe(1);
		expect(mixed.total).toBe(3);
	});

	test("the master stop does not erase what each project is set to", () => {
		// Summarising the effective `playing` would report "none" and hide the two armed projects.
		const fleet = summarize(
			[of("a", true), of("b", true), of("c", false)],
			false,
		);
		expect(fleet.globalPlaying).toBe(false);
		expect(fleet.summary).toBe("some");
		expect(fleet.playing).toBe(2);
	});

	test("a project whose status cannot be read is named, not dropped", async () => {
		const ok = target("ok");
		const broken = target("broken");
		broken.scheduler.status = () => Promise.reject(new Error("db is gone"));

		const fleet = await dispatchStatusAll([ok, broken]);
		expect(fleet.projects.map((p) => p.project)).toEqual(["ok", "broken"]);
		expect(fleet.projects[1]?.error).toBe("db is gone");
		// Unreadable projects are excluded from counts, not counted as stopped.
		expect(fleet.total).toBe(1);
	});
});

describe("the master stop: one switch, ANDed, never a batch", () => {
	class FakeGlobal implements GlobalDispatchStore {
		value: { reason: string } | null = null;
		readonly writes: ({ reason: string } | null)[] = [];
		paused() {
			return this.value;
		}
		async setPaused(next: { reason: string } | null) {
			this.writes.push(next);
			this.value = next;
		}
	}

	test("stopping writes ONE value and touches no project", async () => {
		const store = new FakeGlobal();
		const projects = [target("a"), target("b"), target("c")];
		for (const p of projects) await setDispatching(p, true);
		for (const p of projects) p.settings.writes.length = 0;

		await setGlobalDispatching(store, false, "going to bed");

		expect(store.paused()).toEqual({ reason: "going to bed" });
		// Regression guard: must not fan out `schedulerAutostart: false` to projects.
		for (const p of projects) expect(p.settings.writes).toEqual([]);
	});

	test("stop then start restores what each project was set to", async () => {
		const store = new FakeGlobal();
		const on = target("on");
		const off = target("off");
		await setDispatching(on, true);
		await setDispatching(off, false);

		await setGlobalDispatching(store, false);
		await setGlobalDispatching(store, true);

		expect(store.paused()).toBeNull();
		// `off` was left stopped and stays stopped (a batch would have started it).
		expect((await on.scheduler.status()).projectPlaying).toBe(true);
		expect((await off.scheduler.status()).projectPlaying).toBe(false);
	});

	test("play clears the stop rather than storing a reason", async () => {
		const store = new FakeGlobal();
		await setGlobalDispatching(store, false, "why");
		await setGlobalDispatching(store, true);
		expect(store.writes).toEqual([{ reason: "why" }, null]);
	});
});
