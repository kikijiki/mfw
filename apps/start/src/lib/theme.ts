import { useCallback, useEffect, useState } from "react";

/**
 * Theme + density preference, written to `data-theme` / `data-density` on
 * <html> (what tokens.css keys off). "system" writes nothing and lets
 * `prefers-color-scheme` decide.
 */

export type ThemeChoice = "system" | "light" | "dark";
export type Density = "comfortable" | "compact";

// Also read by the pre-paint bootstrap script in `routes/__root.tsx`, which
// cannot import from here. Change one, change the other.
const THEME_KEY = "mfw:v2:theme";
const DENSITY_KEY = "mfw:v2:density";

function readStored<T extends string>(key: string, allowed: readonly T[]): T {
	if (typeof window === "undefined") return allowed[0] as T;
	const raw = window.localStorage.getItem(key);
	return allowed.includes(raw as T) ? (raw as T) : (allowed[0] as T);
}

function applyTheme(choice: ThemeChoice): void {
	if (typeof document === "undefined") return;
	const root = document.documentElement;
	if (choice === "system") root.removeAttribute("data-theme");
	else root.setAttribute("data-theme", choice);
}

function applyDensity(density: Density): void {
	if (typeof document === "undefined") return;
	const root = document.documentElement;
	if (density === "comfortable") root.removeAttribute("data-density");
	else root.setAttribute("data-density", density);
}

/**
 * Keep the `dark` class on <html> in sync with `data-theme`. The shadcn `dark:`
 * utilities key off `.dark` while `--mfw-*` tokens key off `data-theme`.
 * Driven by a MutationObserver plus the OS media query.
 */
export function useDarkClassSync(): void {
	useEffect(() => {
		if (typeof document === "undefined") return;
		const root = document.documentElement;
		const mq = window.matchMedia("(prefers-color-scheme: dark)");

		const apply = () => {
			const choice = root.getAttribute("data-theme");
			const dark = choice === "dark" || (choice === null && mq.matches);
			root.classList.toggle("dark", dark);
		};

		apply();
		// Only `data-theme` is observed, so toggling the class below cannot
		// re-enter this callback.
		const observer = new MutationObserver(apply);
		observer.observe(root, {
			attributes: true,
			attributeFilter: ["data-theme"],
		});
		mq.addEventListener("change", apply);

		return () => {
			observer.disconnect();
			mq.removeEventListener("change", apply);
			// The class is deliberately not restored: nothing else owns it.
		};
	}, []);
}

export interface ThemeApi {
	theme: ThemeChoice;
	setTheme: (choice: ThemeChoice) => void;
	/** What the page is actually painting right now, system choice resolved. */
	resolved: "light" | "dark";
	density: Density;
	setDensity: (density: Density) => void;
}

export function useTheme(): ThemeApi {
	// SSR-safe defaults, corrected on mount (reading localStorage in render would break hydration).
	const [theme, setThemeState] = useState<ThemeChoice>("system");
	const [density, setDensityState] = useState<Density>("comfortable");
	const [systemDark, setSystemDark] = useState(false);

	useEffect(() => {
		const storedTheme = readStored(THEME_KEY, [
			"system",
			"light",
			"dark",
		] as const);
		const storedDensity = readStored(DENSITY_KEY, [
			"comfortable",
			"compact",
		] as const);
		setThemeState(storedTheme);
		setDensityState(storedDensity);
		applyTheme(storedTheme);
		applyDensity(storedDensity);

		const mq = window.matchMedia("(prefers-color-scheme: dark)");
		setSystemDark(mq.matches);
		const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
		mq.addEventListener("change", onChange);
		return () => mq.removeEventListener("change", onChange);
	}, []);

	const setTheme = useCallback((choice: ThemeChoice) => {
		setThemeState(choice);
		applyTheme(choice);
		window.localStorage.setItem(THEME_KEY, choice);
	}, []);

	const setDensity = useCallback((next: Density) => {
		setDensityState(next);
		applyDensity(next);
		window.localStorage.setItem(DENSITY_KEY, next);
	}, []);

	return {
		theme,
		setTheme,
		resolved: theme === "system" ? (systemDark ? "dark" : "light") : theme,
		density,
		setDensity,
	};
}
