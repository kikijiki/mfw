import { useCallback, useEffect, useState } from "react";

import { THEME_NAME_KEY } from "./bootstrap";
import { DEFAULT_THEME, isThemeId, type ThemeId } from "./registry";

/** What <html> is painting now; the bootstrap script already resolved URL, storage and default. */
export function paintedTheme(): ThemeId {
	if (typeof document === "undefined") return DEFAULT_THEME;
	const value = document.documentElement.getAttribute("data-theme");
	return isThemeId(value) ? value : DEFAULT_THEME;
}

/**
 * Apply and remember a theme. Storage failure is ignored: the theme still
 * applies to this page view. A `?theme=` in the address is dropped, or the
 * next reload would override the choice just made.
 */
export function selectTheme(id: ThemeId): void {
	document.documentElement.setAttribute("data-theme", id);
	try {
		window.localStorage.setItem(THEME_NAME_KEY, id);
	} catch {
		// Blocked storage: this page view keeps the theme.
	}
	const url = new URL(window.location.href);
	if (url.searchParams.has("theme")) {
		url.searchParams.delete("theme");
		window.history.replaceState(window.history.state, "", url);
	}
}

export function useThemeName(): {
	name: ThemeId;
	setName: (id: ThemeId) => void;
} {
	// SSR-safe default, corrected on mount so hydration markup matches.
	const [name, setNameState] = useState<ThemeId>(DEFAULT_THEME);
	useEffect(() => setNameState(paintedTheme()), []);
	const setName = useCallback((id: ThemeId) => {
		selectTheme(id);
		setNameState(id);
	}, []);
	return { name, setName };
}
