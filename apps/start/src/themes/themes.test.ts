import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { THEME_NAME_KEY, themeBootstrapScript } from "./bootstrap";
import { DEFAULT_THEME, THEMES } from "./registry";
import { paintedTheme, selectTheme } from "./useThemeName";

const DIR = import.meta.dir;
const STYLED = THEMES.filter((t) => t.id !== "classic");

const COLOR_TOKENS = [
	"bg",
	"bg-subtle",
	"bg-raised",
	"bg-inset",
	"bg-hover",
	"border",
	"border-strong",
	"fg",
	"fg-muted",
	"fg-faint",
	"fg-on-accent",
	"accent",
	"accent-hover",
	"accent-subtle",
	"link",
	"ok",
	"warn",
	"critical",
	"info",
	"neutral",
	"status-backlog",
	"status-ready",
	"status-in-progress",
	"status-blocked",
	"status-review",
	"status-done",
	"status-archived",
	"diff-add-bg",
	"diff-del-bg",
	"diff-add-hl",
	"diff-del-hl",
	"swatch-l-bg",
	"swatch-l-fg",
	"swatch-c-bg",
	"swatch-c-fg",
].map((t) => `--mfw-${t}`);

const SHAPE_TOKENS = [
	"--mfw-font-ui",
	"--mfw-font-display",
	"--mfw-font-mono",
	"--mfw-radius-sm",
	"--mfw-radius-md",
	"--mfw-radius-lg",
	"--radius",
	"--mfw-shadow-raised",
	"--mfw-shadow-overlay",
];

/** The declarations of the one rule whose selector is exactly `selector`. */
function block(css: string, selector: string): string {
	const start = css.indexOf(`${selector} {`);
	if (start < 0) return "";
	return css.slice(start, css.indexOf("}", start));
}

describe("theme files", () => {
	test("registry and index.css list the same themes", () => {
		const index = readFileSync(join(DIR, "index.css"), "utf8");
		const imported = [...index.matchAll(/"\.\/([a-z]+)\.css"/g)]
			.map((m) => m[1])
			.filter((n) => n !== "bridge");
		expect(imported.sort()).toEqual(STYLED.map((t) => t.id as string).sort());
	});

	for (const theme of STYLED) {
		const css = readFileSync(join(DIR, `${theme.id}.css`), "utf8");
		const root = `:root[data-theme="${theme.id}"]`;

		test(`${theme.id} defines every shape token`, () => {
			const base = block(css, root);
			expect(SHAPE_TOKENS.filter((t) => !base.includes(`${t}:`))).toEqual([]);
		});

		for (const [mode, selector] of [
			["light", `${root}:not(.dark)`],
			["dark", `${root}.dark`],
		] as const) {
			test(`${theme.id} ${mode} defines every colour token`, () => {
				const body = block(css, selector);
				expect(COLOR_TOKENS.filter((t) => !body.includes(`${t}:`))).toEqual([]);
			});
		}

		test(`${theme.id} fetches nothing from the network`, () => {
			expect(css).not.toMatch(/https?:\/\//);
		});
	}
});

/**
 * Themes restyle; they never move anything. A declaration of one of these
 * properties fails unless its file and value are listed in LAYOUT_ALLOWLIST
 * with the reason. The list is empty on purpose.
 */
const LAYOUT_PROPERTY =
	/(?:^|[;{\s])(grid(?:-template(?:-[a-z]+)?|-area|-column(?:-start|-end)?|-row(?:-start|-end)?|-auto-[a-z]+)?|flex-direction|flex-flow|flex-wrap|order|float|position|display|visibility|translate|inset(?:-[a-z]+)?)\s*:\s*([^;}]+)/g;
const LAYOUT_ALLOWLIST: readonly string[] = [];

function layoutDeclarations(css: string): string[] {
	const code = css.replace(/\/\*[\s\S]*?\*\//g, "");
	return [...code.matchAll(LAYOUT_PROPERTY)].map(
		(m) => `${m[1]}: ${(m[2] ?? "").trim()}`,
	);
}

describe("themes do not change the layout", () => {
	for (const file of ["bridge", ...STYLED.map((t) => t.id as string)]) {
		test(`${file}.css declares no layout-moving property`, () => {
			const css = readFileSync(join(DIR, `${file}.css`), "utf8");
			const found = layoutDeclarations(css).filter(
				(d) => !LAYOUT_ALLOWLIST.includes(`${file}: ${d}`),
			);
			expect(found).toEqual([]);
		});
	}

	test("the scan catches what it is meant to catch", () => {
		expect(
			layoutDeclarations(
				"a { flex-direction: row; } b { position: fixed; color: red } c { display:none } /* order: 1 */ d { grid-template-columns: 1fr }",
			),
		).toEqual([
			"flex-direction: row",
			"position: fixed",
			"display: none",
			"grid-template-columns: 1fr",
		]);
	});
});

// --- a minimal <html>, window and storage -----------------------------------

function fakeRoot() {
	const attrs = new Map<string, string>();
	const classes = new Set<string>();
	return {
		attrs,
		classes,
		setAttribute: (k: string, v: string) => attrs.set(k, v),
		getAttribute: (k: string) => attrs.get(k) ?? null,
		classList: {
			toggle: (c: string, on: boolean) => {
				if (on) classes.add(c);
				else classes.delete(c);
			},
		},
	};
}

function runBootstrap(opts: {
	search?: string;
	stored?: Record<string, string>;
	blocked?: boolean;
	osDark?: boolean;
}) {
	const root = fakeRoot();
	const localStorage = {
		getItem: (k: string) => {
			if (opts.blocked) throw new Error("denied");
			return opts.stored?.[k] ?? null;
		},
	};
	new Function(
		"document",
		"localStorage",
		"location",
		"matchMedia",
		themeBootstrapScript(),
	)(
		{ documentElement: root },
		localStorage,
		{ search: opts.search ?? "" },
		() => ({ matches: opts.osDark ?? false }),
	);
	return root;
}

describe("pre-paint bootstrap", () => {
	test("defaults to Classic and follows the OS", () => {
		const root = runBootstrap({ osDark: true });
		expect(root.attrs.get("data-theme")).toBe(DEFAULT_THEME);
		expect(root.attrs.has("data-mode")).toBe(false);
		expect(root.classes.has("dark")).toBe(true);
	});

	test("applies the stored theme and mode", () => {
		const root = runBootstrap({
			stored: { [THEME_NAME_KEY]: "margin", "mfw:v2:theme": "light" },
			osDark: true,
		});
		expect(root.attrs.get("data-theme")).toBe("margin");
		expect(root.attrs.get("data-mode")).toBe("light");
		expect(root.classes.has("dark")).toBe(false);
	});

	test("the URL wins over storage", () => {
		const root = runBootstrap({
			search: "?theme=slab&mode=dark",
			stored: { [THEME_NAME_KEY]: "margin", "mfw:v2:theme": "light" },
		});
		expect(root.attrs.get("data-theme")).toBe("slab");
		expect(root.attrs.get("data-mode")).toBe("dark");
		expect(root.classes.has("dark")).toBe(true);
	});

	test("an unknown name falls through", () => {
		const root = runBootstrap({
			search: "?theme=nope",
			stored: { [THEME_NAME_KEY]: "also-nope" },
		});
		expect(root.attrs.get("data-theme")).toBe(DEFAULT_THEME);
	});

	test("blocked storage still sets the theme and the dark class", () => {
		const root = runBootstrap({ blocked: true, osDark: true });
		expect(root.attrs.get("data-theme")).toBe(DEFAULT_THEME);
		expect(root.classes.has("dark")).toBe(true);
	});
});

describe("selectTheme", () => {
	const g = globalThis as unknown as Record<string, unknown>;
	const saved = { document: g.document, window: g.window };

	afterEach(() => {
		g.document = saved.document;
		g.window = saved.window;
	});

	function install(href: string, blocked = false) {
		const root = fakeRoot();
		const store = new Map<string, string>();
		const replaced: string[] = [];
		g.document = { documentElement: root };
		g.window = {
			location: { href },
			history: {
				state: null,
				replaceState: (_s: unknown, _t: string, url: URL) =>
					replaced.push(String(url)),
			},
			localStorage: {
				setItem: (k: string, v: string) => {
					if (blocked) throw new Error("denied");
					store.set(k, v);
				},
			},
		};
		return { root, store, replaced };
	}

	test("applies and persists", () => {
		const { root, store } = install("http://x/");
		selectTheme("pebble");
		expect(root.attrs.get("data-theme")).toBe("pebble");
		expect(store.get(THEME_NAME_KEY)).toBe("pebble");
		expect(paintedTheme()).toBe("pebble");
	});

	test("still applies when storage is blocked", () => {
		const { root } = install("http://x/", true);
		selectTheme("gauge");
		expect(root.attrs.get("data-theme")).toBe("gauge");
	});

	test("drops ?theme= so a reload keeps the choice", () => {
		const { replaced } = install("http://x/p?theme=margin&tab=1");
		selectTheme("slab");
		expect(replaced).toEqual(["http://x/p?tab=1"]);
	});
});
