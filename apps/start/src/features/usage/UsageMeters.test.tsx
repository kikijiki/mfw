import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { UsageSubscription } from "@mfw/daemon/usage-monitor";
import { renderToStaticMarkup } from "react-dom/server";

import { UsagePanelBody, UsageRail, UsageStrip, viewsOf } from "./UsageMeters";

const NOW = Date.UTC(2027, 0, 20, 12, 0, 0);
const MIN = 60_000;

const claude: UsageSubscription = {
	provider: "claude-cli",
	name: "Claude Code",
	accountLabel: "max",
	fetchedAt: NOW,
	status: "ok",
	windows: [
		{
			label: "5h",
			usedPercent: 96,
			resetsAt: NOW + 133 * MIN,
			windowMinutes: 300,
			source: "t",
		},
		{
			label: "7d",
			usedPercent: 16,
			resetsAt: NOW + 4 * 24 * 60 * MIN,
			windowMinutes: 10_080,
			source: "t",
		},
	],
};
const codex: UsageSubscription = {
	provider: "codex-cli",
	name: "Codex",
	accountLabel: null,
	fetchedAt: null,
	status: "unavailable",
	error: "codex app-server exited",
	windows: [],
};

const views = viewsOf([claude, codex], NOW);
const noop = () => {};

describe("UsageRail", () => {
	test("expanded: a labelled meter per window with percent, severity word and reset", () => {
		const html = renderToStaticMarkup(
			<UsageRail views={views} expanded onNavigate={noop} />,
		);
		expect(html).toContain("Claude Code");
		expect(html).toContain("max");
		expect((html.match(/data-testid="usage-meter"/g) ?? []).length).toBe(2);
		expect(html).toContain(">5h<");
		expect(html).toContain("96%");
		expect(html).toContain("16%");
		// Critical is said in words, not only coloured.
		expect(html).toContain("nearly out, resets in 2h13m");
		expect(html).toContain('data-severity="critical"');
		expect(html).toContain('data-severity="ok"');
		// The native meter carries the value for assistive tech.
		expect(html).toContain('<meter class="sr-only"');
		expect(html).toContain("5h window: 96% used");
		// Opens Fleet.
		expect(html).toContain('href="/fleet"');
	});

	test("unavailable is stated, with the reason, and draws no meter", () => {
		const html = renderToStaticMarkup(
			<UsageRail views={[views[1] as never]} expanded onNavigate={noop} />,
		);
		expect(html).toContain("usage unavailable: codex app-server exited");
		expect(html).not.toContain('data-testid="usage-meter"');
	});

	test("stale numbers are marked as stale", () => {
		const stale = viewsOf(
			[{ ...claude, status: "stale", error: "usage endpoint unreachable" }],
			NOW,
		);
		const html = renderToStaticMarkup(
			<UsageRail views={stale} expanded onNavigate={noop} />,
		);
		expect(html).toContain("stale, read &lt;1m ago");
		expect(html).toContain("last read is stale");
	});

	test("collapsed: monogram and the worst percent, full text in the label", () => {
		const html = renderToStaticMarkup(
			<UsageRail views={views} expanded={false} onNavigate={noop} />,
		);
		expect(html).toContain('data-testid="usage-compact-claude-cli"');
		expect(html).toContain(">CC<");
		expect(html).toContain(">96%<");
		expect(html).toContain('aria-label="Claude Code (max): 5h 96%, 7d 16%"');
		// Unknown is a question mark, never a made-up number.
		expect(html).toContain(">?<");
		expect(html).not.toContain('data-testid="usage-meter"');
	});

	test("renders nothing when no subscription was found", () => {
		expect(
			renderToStaticMarkup(<UsageRail views={[]} expanded onNavigate={noop} />),
		).toBe("");
	});
});

describe("UsageStrip (phone)", () => {
	test("one compact line per subscription, phone only, links to Fleet", () => {
		const html = renderToStaticMarkup(
			<UsageStrip views={views} onNavigate={noop} />,
		);
		expect(html).toContain("md:hidden");
		expect(html).toContain("5h 96%");
		expect(html).toContain("7d 16%");
		expect(html).toContain("unavailable");
		expect(html).toContain('href="/fleet"');
	});
});

describe("UsagePanelBody (Fleet)", () => {
	test("lists every subscription, or says none were found", () => {
		expect(renderToStaticMarkup(<UsagePanelBody views={views} />)).toContain(
			'data-testid="usage-claude-cli"',
		);
		expect(renderToStaticMarkup(<UsagePanelBody views={[]} />)).toContain(
			"No subscription with readable usage",
		);
	});
});

describe("wiring", () => {
	const read = (rel: string) =>
		readFileSync(join(import.meta.dir, "..", "..", rel), "utf8");

	test("one shared 60 s query: the shell mounts the feed once, nobody else polls", () => {
		const meters = read("features/usage/UsageMeters.tsx");
		const shell = read("components/AppShell.tsx");
		expect(meters).toContain("export const USAGE_REFETCH_MS = 60_000");
		expect((meters.match(/refetchInterval/g) ?? []).length).toBe(1);
		expect((shell.match(/useUsageFeed\(\)/g) ?? []).length).toBe(1);
		expect(shell).toContain("<UsageSidebarBlock");
		expect(shell).toContain("<UsageStripBlock");
		expect(read("features/fleet/FleetPage.tsx")).toContain("useUsage()");
		expect(meters).toContain("client.usage.changes.subscribe");
	});
});
