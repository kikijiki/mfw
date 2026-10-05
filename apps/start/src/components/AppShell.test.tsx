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
	test("keeps Resources and global RunPod operations fixed above Projects", () => {
		const sidebar = between(shell, "function Sidebar", "function Divider");
		expect(shell).toContain(
			'{ label: "Resources", to: href.resources(), icon: Boxes }',
		);
		expect(shell).toContain(
			'{ label: "RunPod", to: href.runpod(), icon: Cloud }',
		);
		expect(shell).toContain(
			'{ label: "OpenRouter", to: href.openrouter(), icon: RouteIcon }',
		);
		expect(sidebar.indexOf("{PRIMARY_NAV.map")).toBeLessThan(
			sidebar.indexOf("Projects"),
		);
		expect(routes).toContain('path: "/resources"');
		expect(routes).toContain('path: "/runpod"');
		expect(routes).toContain('path: "/openrouter"');
	});

	test("preserves Add Project, dynamic rows, per-project controls, and detach location", () => {
		const sidebar = between(shell, "function Sidebar", "function Divider");
		expect(sidebar).toContain('aria-label="Add project"');
		expect(sidebar).toContain("(projects.data ?? []).map");
		expect(sidebar).toContain("href.board(p.name)");
		expect(sidebar).toContain(
			'<ProjectDispatchButton project={p.name} variant="icon" />',
		);
		expect(projectSettings).toContain("<DetachProject");
	});

	test("places the global dispatch row directly above Settings", () => {
		const sidebar = between(shell, "function Sidebar", "function Divider");
		const globalControl =
			'<GlobalDispatchButton variant="navigation" compact={!expanded} />';
		const settings = '<NavLink\n\t\t\t\tentry={{ label: "Settings"';

		expect(sidebar).toContain(globalControl);
		expect(sidebar).not.toContain('<GlobalDispatchButton variant="icon" />');
		expect(sidebar.indexOf(globalControl)).toBeLessThan(
			sidebar.indexOf(settings),
		);
		expect(sidebar.slice(sidebar.indexOf(globalControl))).toContain(
			`${globalControl}\n\t\t\t${settings}`,
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

	test("mobile is exactly Now, Inbox, Resources, RunPod, More", () => {
		const mobile = between(shell, "const MOBILE_NAV", "function Sidebar");
		const tabBar = between(shell, "function TabBar", "function MobileHeader");
		expect(mobile.match(/label: /g)).toHaveLength(4);
		for (const label of ["Now", "Inbox", "Resources", "RunPod"]) {
			expect(mobile).toContain(`label: "${label}"`);
		}
		expect(tabBar).toContain(">More</span>");
		expect(tabBar).toContain('aria-controls="mobile-more-menu"');
		expect(tabBar).toContain('label: "History"');
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
		expect(routes).toMatch(/resources: \(\) => `\$\{APP_ROOT\}\/resources`/);
		expect(routes).toMatch(/runpod: \(\) => `\$\{APP_ROOT\}\/runpod`/);
		expect(routes).toMatch(/openrouter: \(\) => `\$\{APP_ROOT\}\/openrouter`/);
		expect(routes).toContain("pathname.startsWith(prefix)");
	});
});
