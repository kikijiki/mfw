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
		id: "broadsheet",
		label: "Broadsheet",
		note: "Editorial: serif heads, hairlines, ink on paper",
		light: { bg: "#f6f1e7", fg: "#1f1a14", accent: "#1d3f72" },
		dark: { bg: "#1a1714", fg: "#ede6d8", accent: "#9db9e3" },
	},
	{
		id: "swiss",
		label: "Swiss",
		note: "Strict grid, black and white, one signal red",
		light: { bg: "#ffffff", fg: "#0a0a0a", accent: "#d3180c" },
		dark: { bg: "#0e0e0e", fg: "#f5f5f2", accent: "#ff5240" },
	},
	{
		id: "control",
		label: "Control Room",
		note: "Dense, status first, amber on near-black",
		light: { bg: "#eef0ea", fg: "#10140f", accent: "#7a4e00" },
		dark: { bg: "#0a0c0b", fg: "#e9f0e6", accent: "#ffb000" },
	},
	{
		id: "fieldnotes",
		label: "Field Notes",
		note: "Calm: moss, clay, soft shapes, room to breathe",
		light: { bg: "#f3f1e8", fg: "#23291f", accent: "#3f6345" },
		dark: { bg: "#171b16", fg: "#e8e9dd", accent: "#a5c79a" },
	},
	{
		id: "teletype",
		label: "Teletype",
		note: "Brutalist instrument: mono, thick rules, flat blocks",
		light: { bg: "#d9d9d3", fg: "#0b0b0b", accent: "#0038ff" },
		dark: { bg: "#000000", fg: "#f2f2ea", accent: "#ffe500" },
	},
] as const satisfies readonly ThemeMeta[];

export type ThemeId = (typeof THEMES)[number]["id"];

export const DEFAULT_THEME: ThemeId = "classic";

export const THEME_IDS: readonly ThemeId[] = THEMES.map((t) => t.id);

export function isThemeId(value: unknown): value is ThemeId {
	return typeof value === "string" && THEME_IDS.includes(value as ThemeId);
}
