import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (rel: string) =>
	readFileSync(join(import.meta.dir, "..", "..", rel), "utf8");
const shell = read("components/AppShell.tsx");
const buttonStyles = read("components/ui/button.tsx");
const dispatchControls = read("features/dispatch/DispatchControls.tsx");
const preference = read("lib/sidebarPreference.ts");

function between(source: string, start: string, end: string): string {
	const from = source.indexOf(start);
	const to = source.indexOf(end, from);
	expect(from).toBeGreaterThan(-1);
	expect(to).toBeGreaterThan(from);
	return source.slice(from, to);
}

describe("the collapsible desktop navigation rail", () => {
	const sidebar = between(shell, "function Sidebar", "function Divider");

	test("is desktop-only, independently scrollable, and releases its width", () => {
		expect(sidebar).toContain(
			'className="hidden min-h-0 shrink-0 flex-col gap-1 overflow-y-auto border-r p-2 md:flex"',
		);
		expect(sidebar).toContain(
			'width: expanded ? "var(--mfw-sidebar-w)" : "48px"',
		);
		expect(shell).toContain(
			'className="mfw-v2 flex h-full w-full flex-col overflow-hidden md:flex-row"',
		);
		expect(shell).toContain('className="flex min-h-0 min-w-0 flex-1 flex-col"');
	});

	test("wires an action-labelled native button to the persisted preference", () => {
		expect(shell).toContain("const sidebar = useSidebarPreference()");
		expect(sidebar).toContain(
			'aria-label={expanded ? "Collapse sidebar" : "Expand sidebar"}',
		);
		expect(sidebar).toContain("aria-expanded={expanded}");
		expect(sidebar).toContain("onClick={onToggle}");
		expect(sidebar).toContain("<PanelLeftClose />");
		expect(sidebar).toContain("<PanelLeftOpen />");
		expect(preference).toContain(
			'export const SIDEBAR_STORAGE_KEY = "mfw:v2:sidebar"',
		);
		expect(preference).toContain("setExpandedState(readSidebarPreference()");
		expect(preference).toContain("writeSidebarPreference(");
	});

	test("keeps the identity and collapse control in the top header", () => {
		const header = between(
			sidebar,
			"{/* Health belongs to the mfw identity",
			"{PRIMARY_NAV.map",
		);
		expect(header).toContain("<HealthDot />");
		expect(header).toContain('aria-label={expanded ? "Collapse sidebar"');
		expect(header).not.toContain("<GlobalDispatchButton");
		expect(header.indexOf("<HealthDot />")).toBeLessThan(
			header.indexOf('aria-label={expanded ? "Collapse sidebar"'),
		);
	});

	test("renders global dispatch as a full bottom navigation row", () => {
		const bottom = sidebar.slice(
			sidebar.lastIndexOf('<div className="flex-1" />'),
		);
		const globalControl =
			'<GlobalDispatchButton variant="navigation" compact={!expanded} />';
		const navigationVariant = between(
			dispatchControls,
			'{variant === "navigation" ? (',
			") : (\n\t\t\t\t<Switch",
		);

		expect(bottom).toContain(globalControl);
		expect(bottom.indexOf(globalControl)).toBeLessThan(
			bottom.indexOf('label: "Settings"'),
		);
		expect(dispatchControls).toContain(
			'"mfw-focus h-[var(--mfw-row-h)] w-full gap-2 rounded-[var(--mfw-radius-md)] px-2 font-normal"',
		);
		expect(dispatchControls).toContain(
			'compact ? "justify-center px-0" : "justify-start"',
		);
		expect(dispatchControls).toContain("aria-label={label}");
		expect(dispatchControls).toContain("title={label}");
		expect(dispatchControls).toContain("aria-pressed={playing}");
		expect(dispatchControls).toContain('{pending ? "Working…" : actionLabel}');
		expect(navigationVariant).toContain("<Button");
		expect(navigationVariant).not.toContain("<Switch");
	});

	test("makes Add project a full row with a flush, dispatch-sized trailing action", () => {
		const projectEntry = between(
			sidebar,
			"{expanded ? (",
			"{(projects.data ?? []).map",
		);
		expect(projectEntry).toContain(
			'className="h-[var(--mfw-row-h)] w-full justify-start gap-0 px-2 pr-0"',
		);
		expect(projectEntry).toContain(">\n\t\t\t\t\t\t\tAdd project\n");
		expect(projectEntry).toContain(
			'className="flex size-7 items-center justify-center"',
		);
		expect(projectEntry).not.toContain('size="icon-xs"');
		expect(dispatchControls).toContain('size="icon-sm"');
		expect(buttonStyles).toMatch(/"icon-sm":\s*"size-7/);
	});

	test("retains all primary, project, settings, health, and dispatch controls", () => {
		const projects = between(
			sidebar,
			"(projects.data ?? []).map",
			"projects.data?.length === 0",
		);
		expect(sidebar).toContain("{PRIMARY_NAV.map");
		expect(sidebar).toContain('label: "Settings"');
		expect(sidebar).toContain("<HealthDot />");
		expect(sidebar).toContain(
			'<GlobalDispatchButton variant="navigation" compact={!expanded} />',
		);
		expect(projects).toContain("compact={!expanded}");
		expect(projects).toContain("<fieldset");
		expect(projects).toMatch(/aria-label=\{`\$\{p\.name\} project`\}/);
		expect(projects).toMatch(
			/<NavLink[\s\S]*?\/>\s*<ProjectDispatchButton project=\{p\.name\} variant="icon" \/>/,
		);
		// The project map itself must not be conditional on expanded mode.
		expect(sidebar).not.toContain(
			"{expanded\n\t\t\t\t? (projects.data ?? []).map",
		);
	});

	test("hides expanded-only copy while preserving names and active indication", () => {
		expect(sidebar).toContain('display: expanded ? undefined : "none"');
		expect(sidebar).toContain("{expanded ? <Divider /> : null}");
		expect(sidebar).toContain("{expanded ? (");
		expect(sidebar).toContain("{expanded && projects.data?.length === 0 ? (");

		const navLink = between(shell, "function NavLink", "function CountBadge");
		expect(navLink).toContain('aria-current={active ? "page" : undefined}');
		expect(navLink).toContain("aria-label={compact ? badgeLabel : undefined}");
		expect(navLink).toContain("title={compact ? badgeLabel : undefined}");
		expect(navLink).toContain("compact ? null : (");
	});

	test("keeps the nonzero Inbox count visible and associated in compact mode", () => {
		expect(sidebar).toContain(
			"badge={entry.to === href.inbox() ? inboxCount : undefined}",
		);
		const navLink = between(shell, "function NavLink", "function CountBadge");
		expect(navLink).toMatch(
			/const badgeLabel = badge \? `\$\{entry\.label\}, \$\{badge\} items` : entry\.label/,
		);
		expect(navLink).toContain(
			"{badge ? <CountBadge count={badge} compact={compact} /> : null}",
		);
	});

	test("leaves the existing mobile header and tab bar breakpoint contract intact", () => {
		const mobileHeader = between(
			shell,
			"function MobileHeader",
			"export function ProjectSwitcher",
		);
		const tabBar = between(shell, "function TabBar", "function MobileHeader");
		expect(mobileHeader).toContain("md:hidden");
		expect(tabBar).toContain("md:hidden");
		expect(mobileHeader).not.toContain("PanelLeftClose");
		expect(mobileHeader).not.toContain("PanelLeftOpen");
		expect(tabBar).not.toContain("PanelLeftClose");
		expect(tabBar).not.toContain("PanelLeftOpen");
	});
});
