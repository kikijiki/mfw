/**
 * The one place themes are registered. To add or drop a theme, edit this list
 * and `index.css`; `themes.test.ts` fails if the two disagree. See README.md.
 */

export interface ThemeSwatch {
	bg: string;
	fg: string;
	accent: string;
}

export interface ThemeMeta {
	id: string;
	label: string;
	/** One line, shown in the switcher. */
	note: string;
	light: ThemeSwatch;
	dark: ThemeSwatch;
}

export const THEMES = [
	{
		id: "classic",
		label: "Classic",
		note: "The current look, for comparison",
		light: { bg: "#f9fafb", fg: "#1f2329", accent: "#5b5bd6" },
		dark: { bg: "#14161a", fg: "#e8eaed", accent: "#9b9ef0" },
	},
	{
		id: "margin",
		label: "Margin",
		note: "Hairlines and whitespace, nothing filled",
		light: { bg: "#fbfbfa", fg: "#22242a", accent: "#4a4f9e" },
		dark: { bg: "#16181c", fg: "#e6e7ea", accent: "#aeb1e6" },
	},
	{
		id: "pebble",
		label: "Pebble",
		note: "Soft layered surfaces, large radii",
		light: { bg: "#f1f2f6", fg: "#23262f", accent: "#5453a8" },
		dark: { bg: "#17191f", fg: "#e8e9ee", accent: "#b0b1ec" },
	},
	{
		id: "gauge",
		label: "Gauge",
		note: "Dense and exact, square with strong rules",
		light: { bg: "#f4f5f6", fg: "#181b20", accent: "#3f4a94" },
		dark: { bg: "#121417", fg: "#e9ebee", accent: "#a9b2e4" },
	},
	{
		id: "slab",
		label: "Slab",
		note: "Chunky borders, large type, flat blocks",
		light: { bg: "#f3f3f1", fg: "#1e2026", accent: "#454a8c" },
		dark: { bg: "#18191d", fg: "#eeeef0", accent: "#b4b8ea" },
	},
] as const satisfies readonly ThemeMeta[];

export type ThemeId = (typeof THEMES)[number]["id"];

export const DEFAULT_THEME: ThemeId = "classic";

export const THEME_IDS: readonly ThemeId[] = THEMES.map((t) => t.id);

export function isThemeId(value: unknown): value is ThemeId {
	return typeof value === "string" && THEME_IDS.includes(value as ThemeId);
}
