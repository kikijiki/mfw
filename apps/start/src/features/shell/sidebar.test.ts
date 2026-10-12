import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (rel: string) =>
	readFileSync(join(import.meta.dir, "..", "..", rel), "utf8");
const shell = read("components/AppShell.tsx");
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
			'className="mfw-v2 flex h-full w-full flex-col overflow-hidden"',
		);
		expect(shell).toContain(
			'className="flex min-h-0 flex-1 flex-col md:flex-row"',
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

	test("keeps the identity and collapse control in the top header, with no status dot of its own", () => {
		const header = between(
			sidebar,
			"{/* Identity and the collapse control.",
			"<SearchButton",
		);
		expect(header).toContain('aria-label={expanded ? "Collapse sidebar"');
		expect(header).not.toContain("<HealthDot />");
		// Title, status dot and master switch, collapse: one row.
		expect(header).toContain("<GlobalDispatchButton");
		expect(sidebar).toContain(
			'<GlobalDispatchButton variant="status" compact />',
		);
		expect(dispatchControls).toContain("function MfwStatusGroup");
		expect(dispatchControls).toContain("unreachable");
	});

	test("renders the global mfw control as ONE status group, not a bottom row", () => {
		const bottom = sidebar.slice(
			sidebar.lastIndexOf('<div className="flex-1" />'),
		);
		expect(bottom).not.toContain("<GlobalDispatchButton");
		expect(bottom).toContain('label: "Settings"');
		const group = between(
			dispatchControls,
			"function MfwStatusGroup",
			"/** Invalidate every query",
		);
		// Dot + word + play/stop in the expanded group; one control collapsed.
		expect(group).toContain("{word}");
		expect(group).toContain("onClick={onToggle}");
		expect(group).toContain("if (compact)");
		expect(group).toContain("aria-pressed={playing}");
		// Tooltips carry the detail and are not native `title`s.
		expect(group).toContain("<Tip label={tip}");
		expect(group).not.toContain("title=");
	});

	test("Add project is a full row when expanded and a tooltipped icon when collapsed", () => {
		expect(sidebar).toContain(
			'className="h-[var(--mfw-row-h)] w-full justify-start gap-0 px-2 pr-0"',
		);
		expect(sidebar).toContain(">\n\t\t\t\tAdd project\n");
		expect(sidebar).toContain('<Tip label="Add project" side="right">');
		expect(sidebar).not.toContain('title="Add project"');
	});

	test("retains all primary, project, settings, and dispatch controls", () => {
		const entry = read("features/shell/SidebarProject.tsx");
		expect(sidebar).toContain("{PRIMARY_NAV.map");
		expect(sidebar).toContain('label: "Settings"');
		expect(sidebar).toContain("(projects.data ?? []).map");
		expect(sidebar).toContain("expanded={expanded}");
		// One tile or row per project; the dispatch toggle and the menu live in it.
		expect(entry).toContain("useProjectDispatch(name)");
		expect(entry).toContain('data-testid="project-tile"');
		expect(entry).toContain('data-testid="project-row"');
		// The project map itself must not be conditional on expanded mode.
		expect(sidebar).not.toContain(
			"{expanded\n\t\t\t\t? (projects.data ?? []).map",
		);
	});

	test("hides expanded-only copy while preserving names and active indication", () => {
		expect(sidebar).toContain("{expanded ? (");
		expect(sidebar).toContain("{expanded && projects.data?.length === 0 ? (");

		const navLink = between(shell, "function NavLink", "function CountBadge");
		expect(navLink).toContain('aria-current={active ? "page" : undefined}');
		expect(navLink).toContain("aria-label={compact ? badgeLabel : undefined}");
		expect(navLink).toContain("<Tip label={badgeLabel}");
		expect(navLink).toContain("compact ? null : (");
	});

	test("a collapsed project is ONE tile: avatar link, one corner badge, tooltip, menu", () => {
		const entry = read("features/shell/SidebarProject.tsx");
		const tile = between(entry, "if (!expanded) {", "const chips = statChips");
		expect(tile).toContain("<ProjectAvatar");
		expect(tile).toContain("<BadgeView badge={badge} corner />");
		expect(tile).toContain("aria-label={tooltip}");
		expect(tile).toContain('aria-keyshortcuts="Shift+F10"');
		// No second always-visible glyph: no brain link, no play button in the tile.
		expect(tile).not.toContain("<BrainGlyphLink");
		expect(tile).not.toContain("<Play");
		expect(tile).not.toContain("Monitor");
		// The menu opens by right-click, long-press, chevron, and keyboard.
		expect(entry).toContain("onContextMenu");
		expect(entry).toContain("setTimeout(open, 500)");
		expect(entry).toContain('e.key === "ContextMenu"');
		expect(entry).toContain("Change icon");
	});

	test("an expanded project row wraps its whole self in the highlight, with one badge and hover-only dispatch", () => {
		const entry = read("features/shell/SidebarProject.tsx");
		const row = entry.slice(entry.indexOf("const chips = statChips"));
		expect(row).toContain('data-testid="project-row"');
		expect(row).toContain("style={highlight}");
		expect(row.match(/<BadgeView/g)).toHaveLength(1);
		expect(row).toContain("group-hover/row:opacity-100");
		expect(row).toContain("const showToggle = dispatch.playing");
	});

	test("keeps the nonzero needs count visible and associated in compact mode", () => {
		expect(sidebar).toContain(
			"badge={entry.to === href.home() ? inboxCount : undefined}",
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
