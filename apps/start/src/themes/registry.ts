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
		id: "docket",
		label: "Docket",
		note: "One numbered worklist: clear the queue fast",
		light: { bg: "#f7f6f1", fg: "#17181c", accent: "#8c1d2f" },
		dark: { bg: "#171615", fg: "#eeebe3", accent: "#f0a3a8" },
	},
	{
		id: "switchyard",
		label: "Switchyard",
		note: "Lanes by stage: see where all work stands",
		light: { bg: "#e8efec", fg: "#0f2a2c", accent: "#a93c05" },
		dark: { bg: "#0f201f", fg: "#e6f2ee", accent: "#ffb27a" },
	},
	{
		id: "singlefile",
		label: "Single File",
		note: "One column, one decision at a time",
		light: { bg: "#eef1f4", fg: "#1e2732", accent: "#2f5d8a" },
		dark: { bg: "#141a22", fg: "#eae6dc", accent: "#9cc4ea" },
	},
	{
		id: "bench",
		label: "Bench",
		note: "Tiled panes: the queue stays beside your work",
		light: { bg: "#e9e8df", fg: "#1d1e17", accent: "#4a5d00" },
		dark: { bg: "#1a1c17", fg: "#ebecdf", accent: "#c5d86d" },
	},
] as const satisfies readonly ThemeMeta[];

export type ThemeId = (typeof THEMES)[number]["id"];

export const DEFAULT_THEME: ThemeId = "classic";

export const THEME_IDS: readonly ThemeId[] = THEMES.map((t) => t.id);

export function isThemeId(value: unknown): value is ThemeId {
	return typeof value === "string" && THEME_IDS.includes(value as ThemeId);
}
