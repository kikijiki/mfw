import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
	quantise,
	rowActions,
	ScrubBanner,
	scrubBindings,
	scrubbedAt,
	stepFrom,
	stepTimes,
	TimeCursor,
} from "./TimeCursor";

const NOW = Date.UTC(2026, 9, 12, 12, 0, 0);
const MIN = 60_000;
const at = (ms: number) => new Date(NOW + ms);

describe("what t means", () => {
	test("absent, unparseable and future t are live; a past t scrubs", () => {
		expect(scrubbedAt(undefined, NOW)).toBeNull();
		expect(scrubbedAt("nonsense", NOW)).toBeNull();
		expect(scrubbedAt(new Date(NOW + MIN).toISOString(), NOW)).toBeNull();
		expect(scrubbedAt(new Date(NOW).toISOString(), NOW)).toBeNull();
		expect(scrubbedAt(new Date(NOW - MIN).toISOString(), NOW)).toBe(NOW - MIN);
	});

	test("times round up to the second flow.at answers for", () => {
		expect(quantise(NOW + 1)).toBe(NOW + 1000);
		expect(quantise(NOW)).toBe(NOW);
		expect(quantise(NOW + 999)).toBe(NOW + 1000);
	});
});

describe("stepping through events", () => {
	const spans = [
		{ start: at(-30 * MIN), end: at(-20 * MIN) },
		{ start: at(-20 * MIN), end: null },
		{ start: at(-10 * MIN + 400), end: at(-5 * MIN) },
	];
	const markers = [{ at: at(-20 * MIN) }, { at: at(-1 * MIN) }];
	const times = stepTimes(spans, markers);

	test("every span edge and marker once, ascending, on whole seconds", () => {
		expect(times).toEqual([
			NOW - 30 * MIN,
			NOW - 20 * MIN,
			NOW - 10 * MIN + 1000,
			NOW - 5 * MIN,
			NOW - 1 * MIN,
		]);
	});

	test("] goes to the next event and [ to the previous; nothing past the ends", () => {
		expect(stepFrom(times, NOW - 20 * MIN, 1)).toBe(NOW - 10 * MIN + 1000);
		expect(stepFrom(times, NOW - 20 * MIN, -1)).toBe(NOW - 30 * MIN);
		expect(stepFrom(times, NOW - 30 * MIN, -1)).toBeNull();
		expect(stepFrom(times, NOW - 1 * MIN, 1)).toBeNull();
		// From between events.
		expect(stepFrom(times, NOW - 15 * MIN, 1)).toBe(NOW - 10 * MIN + 1000);
		expect(stepFrom(times, NOW - 15 * MIN, -1)).toBe(NOW - 20 * MIN);
	});

	test("a step from an event on its own second does not stay put", () => {
		// The cursor sits at .400 of the second the event is quantised to.
		const t = NOW - 10 * MIN + 400;
		expect(stepFrom(times, t, 1)).toBe(NOW - 5 * MIN);
		expect(stepFrom(times, t, -1)).toBe(NOW - 20 * MIN);
	});
});

describe("keys", () => {
	function bindings(scrubbed: number | null) {
		const set: (string | undefined)[] = [];
		const times = [NOW - 20 * MIN, NOW - 10 * MIN, NOW - 5 * MIN];
		const list = scrubBindings({
			at: scrubbed,
			times,
			now: NOW,
			onT: (t) => set.push(t),
		});
		const by = (key: string) => list.find((b) => b.key === key);
		return { set, by };
	}
	const press = (b?: { run: (e: KeyboardEvent) => void }) =>
		b?.run(new Event("keydown") as KeyboardEvent);

	test("[ and ] step through events", () => {
		const { set, by } = bindings(NOW - 10 * MIN);
		press(by("["));
		press(by("]"));
		expect(set).toEqual([
			new Date(NOW - 20 * MIN).toISOString(),
			new Date(NOW - 5 * MIN).toISOString(),
		]);
	});

	test("[ from live lands on the latest event", () => {
		const { set, by } = bindings(null);
		press(by("["));
		expect(set).toEqual([new Date(NOW - 5 * MIN).toISOString()]);
	});

	test("] past the last event returns to live", () => {
		const { set, by } = bindings(NOW - 5 * MIN);
		press(by("]"));
		expect(set).toEqual([undefined]);
	});

	test("L returns to live and is only enabled while scrubbed", () => {
		const scrubbed = bindings(NOW - 10 * MIN);
		expect(scrubbed.by("L")?.enabled).toBe(true);
		press(scrubbed.by("L"));
		expect(scrubbed.set).toEqual([undefined]);
		expect(bindings(null).by("L")?.enabled).toBe(false);
		expect(bindings(null).by("]")?.enabled).toBe(false);
	});
});

describe("read-only", () => {
	test("the actions menu is disabled while scrubbed and present when live", () => {
		const open = () => {};
		expect(rowActions(true, open)).toEqual({});
		expect(rowActions(false, open).onActions).toBe(open);
	});

	test("the banner names the instant, how long ago and the way back", () => {
		const html = renderToStaticMarkup(
			<ScrubBanner at={NOW - 38 * MIN} now={NOW} onLive={() => {}} />,
		);
		expect(html).toContain("Viewing");
		expect(html).toContain("38m ago");
		expect(html).toContain("read-only");
		expect(html).toContain("Back to live (L)");
	});

	test("the cursor strip draws nothing while live", () => {
		expect(
			renderToStaticMarkup(
				<TimeCursor at={null} now={NOW} times={[]} onT={() => {}} />,
			),
		).toBe("");
		const html = renderToStaticMarkup(
			<TimeCursor
				at={NOW - 10 * MIN}
				now={NOW}
				times={[NOW - 20 * MIN]}
				onT={() => {}}
			/>,
		);
		expect(html).toContain("Step back one event");
		expect(html).toContain("Step forward one event");
	});
});
