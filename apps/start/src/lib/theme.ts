import { useCallback, useEffect, useState } from "react";

/**
 * Light/dark + density preference, written to `data-mode` / `data-density` on
 * <html> (what tokens.css keys off). "system" writes nothing and lets
 * `prefers-color-scheme` decide. The visual theme (`data-theme`) is separate:
 * see `themes/`.
 */

export type ThemeChoice = "system" | "light" | "dark";
export type Density = "comfortable" | "compact";

// Also read by the pre-paint bootstrap script in `themes/bootstrap.ts`, which
// cannot import from here. Change one, change the other.
const THEME_KEY = "mfw:v2:theme";
const DENSITY_KEY = "mfw:v2:density";
/** Tells every mounted `useTheme` that another one changed the mode. */
const MODE_EVENT = "mfw:mode-change";

/** Storage can throw (private window, blocked site data); a preference is never worth a crash. */
function readStored<T extends string>(key: string, allowed: readonly T[]): T {
	if (typeof window === "undefined") return allowed[0] as T;
	try {
		const raw = window.localStorage.getItem(key);
		return allowed.includes(raw as T) ? (raw as T) : (allowed[0] as T);
	} catch {
		return allowed[0] as T;
	}
}

function writeStored(key: string, value: string): void {
	try {
		window.localStorage.setItem(key, value);
	} catch {
		// The choice still applies to this page view.
	}
}

/** `?mode=light|dark`: a shared link's mode, shown without being saved. */
function urlMode(): ThemeChoice | null {
	if (typeof window === "undefined") return null;
	const mode = new URLSearchParams(window.location.search).get("mode");
	return mode === "light" || mode === "dark" ? mode : null;
}

function dropUrlMode(): void {
	const url = new URL(window.location.href);
	if (!url.searchParams.has("mode")) return;
	url.searchParams.delete("mode");
	window.history.replaceState(window.history.state, "", url);
}

function applyTheme(choice: ThemeChoice): void {
	if (typeof document === "undefined") return;
	const root = document.documentElement;
	if (choice === "system") root.removeAttribute("data-mode");
	else root.setAttribute("data-mode", choice);
}

function applyDensity(density: Density): void {
	if (typeof document === "undefined") return;
	const root = document.documentElement;
	if (density === "comfortable") root.removeAttribute("data-density");
	else root.setAttribute("data-density", density);
}

/**
 * Keep the `dark` class on <html> in sync with `data-mode`. The shadcn `dark:`
 * utilities and the theme files key off `.dark`; the Classic `--mfw-*` tokens
 * key off `data-mode`. Driven by a MutationObserver plus the OS media query.
 */
export function useDarkClassSync(): void {
	useEffect(() => {
		if (typeof document === "undefined") return;
		const root = document.documentElement;
		const mq = window.matchMedia("(prefers-color-scheme: dark)");

		const apply = () => {
			const choice = root.getAttribute("data-mode");
			const dark = choice === "dark" || (choice === null && mq.matches);
			root.classList.toggle("dark", dark);
		};

		apply();
		// Only `data-mode` is observed, so toggling the class below cannot
		// re-enter this callback.
		const observer = new MutationObserver(apply);
		observer.observe(root, {
			attributes: true,
			attributeFilter: ["data-mode"],
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
		const storedTheme =
			urlMode() ?? readStored(THEME_KEY, ["system", "light", "dark"] as const);
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
		const onMode = (e: Event) =>
			setThemeState((e as CustomEvent<ThemeChoice>).detail);
		mq.addEventListener("change", onChange);
		window.addEventListener(MODE_EVENT, onMode);
		return () => {
			mq.removeEventListener("change", onChange);
			window.removeEventListener(MODE_EVENT, onMode);
		};
	}, []);

	const setTheme = useCallback((choice: ThemeChoice) => {
		setThemeState(choice);
		applyTheme(choice);
		writeStored(THEME_KEY, choice);
		dropUrlMode();
		window.dispatchEvent(new CustomEvent(MODE_EVENT, { detail: choice }));
	}, []);

	const setDensity = useCallback((next: Density) => {
		setDensityState(next);
		applyDensity(next);
		writeStored(DENSITY_KEY, next);
	}, []);

	return {
		theme,
		setTheme,
		resolved: theme === "system" ? (systemDark ? "dark" : "light") : theme,
		density,
		setDensity,
	};
}
