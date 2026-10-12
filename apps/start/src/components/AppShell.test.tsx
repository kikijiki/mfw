import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (path: string) =>
	readFileSync(join(import.meta.dir, "..", path), "utf8");
const shell = read("components/AppShell.tsx");
const routes = read("routes.tsx");
const projectSettings = read("features/settings/ProjectSettingsPage.tsx");

function between(source: string, start: string, end: string): string {
	const from = source.indexOf(start);
	const to = source.indexOf(end, from);
	expect(from).toBeGreaterThanOrEqual(0);
	expect(to).toBeGreaterThan(from);
	return source.slice(from, to);
}

describe("machine navigation", () => {
	test("keeps one Fleet entry fixed above Projects", () => {
		const sidebar = between(shell, "function Sidebar", "function Divider");
		expect(shell).toContain(
			'{ label: "Fleet", to: href.fleet(), icon: Boxes }',
		);
		// The four pages Fleet replaced have no entry of their own.
		for (const label of ["Models", "Resources", "RunPod", "OpenRouter"]) {
			expect(shell).not.toContain(`label: "${label}"`);
		}
		expect(sidebar.indexOf("{PRIMARY_NAV.map")).toBeLessThan(
			sidebar.indexOf("Projects"),
		);
		expect(routes).toContain('path: "/fleet"');
		expect(routes).toContain('path: "/fleet/runpod"');
		expect(routes).toContain('path: "/fleet/openrouter"');
	});

	test("preserves Add Project, dynamic rows, per-project controls, and detach location", () => {
		const sidebar = between(shell, "function Sidebar", "function Divider");
		const entry = read("features/shell/SidebarProject.tsx");
		expect(sidebar).toContain('aria-label="Add project"');
		expect(sidebar).toContain("(projects.data ?? []).map");
		// One entry per project; its link and dispatch toggle live in the entry.
		expect(sidebar).toContain("<ProjectEntry");
		expect(entry).toContain("href.board(name)");
		expect(entry).toContain("useProjectDispatch(name)");
		expect(projectSettings).toContain("<DetachProject");
	});

	test("puts the global mfw switch and status in the title row, Settings at the bottom", () => {
		const sidebar = between(shell, "function Sidebar", "function Divider");
		const group = '<GlobalDispatchButton variant="status" compact />';
		expect(sidebar).toContain(group);
		expect(sidebar).toContain("<GlobalDispatchButton");
		expect(sidebar).not.toContain('<GlobalDispatchButton variant="navigation"');
		expect(sidebar).not.toContain('<GlobalDispatchButton variant="icon" />');
		// Title, then the status group, then the collapse control: one row.
		const title = sidebar.indexOf(">\n\t\t\t\t\t\tmfw\n");
		const status = sidebar.indexOf("<GlobalDispatchButton");
		const collapse = sidebar.indexOf(
			'aria-label={expanded ? "Collapse sidebar"',
		);
		expect(title).toBeGreaterThan(-1);
		expect(title).toBeLessThan(status);
		expect(status).toBeLessThan(collapse);
		expect(collapse).toBeLessThan(sidebar.indexOf("{PRIMARY_NAV.map"));
		expect(sidebar.lastIndexOf('label: "Settings"')).toBeGreaterThan(
			sidebar.indexOf("{PRIMARY_NAV.map"),
		);
	});

	test("collapsed desktop retains icons, active state, and keyboard names", () => {
		const sidebar = between(shell, "function Sidebar", "function Divider");
		const navLink = between(shell, "function NavLink", "function CountBadge");
		expect(shell).toContain(
			'width: expanded ? "var(--mfw-sidebar-w)" : "48px"',
		);
		expect(navLink).toContain('aria-current={active ? "page" : undefined}');
		expect(navLink).toContain("aria-label={compact ? badgeLabel : undefined}");
		expect(navLink).toContain("<Icon aria-hidden");
		expect(
			sidebar.indexOf('aria-label={expanded ? "Collapse sidebar"'),
		).toBeLessThan(sidebar.indexOf("{PRIMARY_NAV.map"));
	});

	test("mobile is exactly Home, Fleet, More", () => {
		const mobile = between(shell, "const MOBILE_NAV", "function Sidebar");
		const tabBar = between(shell, "function TabBar", "function MobileHeader");
		expect(mobile.match(/label: /g)).toHaveLength(2);
		for (const label of ["Home", "Fleet"]) {
			expect(mobile).toContain(`label: "${label}"`);
		}
		expect(tabBar).toContain(">More</span>");
		expect(tabBar).toContain('aria-controls="mobile-more-menu"');
		expect(tabBar).toContain('label: "Settings"');
		expect(tabBar).not.toContain("{PRIMARY_NAV.map");
		expect(shell).toContain("<TabBar key={path}");
		expect(tabBar).toContain('className="min-h-11"');
		expect(tabBar).toContain('role="menu"');
		expect(tabBar).toContain('document.addEventListener("pointerdown"');
		expect(tabBar).toContain('event.key !== "Escape"');
		expect(tabBar).toContain("moreButtonRef.current?.focus()");
		expect(tabBar).toMatch(
			/e\.preventDefault\(\);\s*setMoreOpen\(false\);\s*onNavigate\(entry\.to\)/,
		);
	});

	test("all machine links preserve base paths and active deep links", () => {
		const navLink = between(shell, "function NavLink", "function CountBadge");
		expect(navLink).toContain("href={withBase(entry.to)}");
		expect(shell).toContain("isActive(path, entry.to)");
		expect(routes).toMatch(/fleet: \(\) => `\$\{APP_ROOT\}\/fleet`/);
		expect(routes).toMatch(/runpod: \(\) => `\$\{APP_ROOT\}\/fleet\/runpod`/);
		expect(routes).toMatch(
			/openrouter: \(\) => `\$\{APP_ROOT\}\/fleet\/openrouter`/,
		);
		expect(routes).toContain("pathname.startsWith(prefix)");
	});
});
