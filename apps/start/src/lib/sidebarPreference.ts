import { useCallback, useEffect, useState } from "react";

/** This browser's desktop-sidebar preference. */
export type SidebarPreference = "expanded" | "collapsed";

export const SIDEBAR_STORAGE_KEY = "mfw:v2:sidebar";
export const DEFAULT_SIDEBAR_PREFERENCE: SidebarPreference = "expanded";

export function isSidebarPreference(
	value: unknown,
): value is SidebarPreference {
	return value === "expanded" || value === "collapsed";
}

/** Storage access can throw in privacy-restricted browsers even when `localStorage` exists. */
export function readSidebarPreference(): SidebarPreference {
	if (typeof window === "undefined") return DEFAULT_SIDEBAR_PREFERENCE;
	try {
		const stored: unknown = window.localStorage.getItem(SIDEBAR_STORAGE_KEY);
		return isSidebarPreference(stored) ? stored : DEFAULT_SIDEBAR_PREFERENCE;
	} catch {
		return DEFAULT_SIDEBAR_PREFERENCE;
	}
}

export function writeSidebarPreference(preference: SidebarPreference): void {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.setItem(
			SIDEBAR_STORAGE_KEY,
			isSidebarPreference(preference) ? preference : DEFAULT_SIDEBAR_PREFERENCE,
		);
	} catch {
		// Storage unavailable: the in-memory preference still works.
	}
}

export interface SidebarPreferenceApi {
	expanded: boolean;
	setExpanded: (expanded: boolean) => void;
	toggle: () => void;
}

export function useSidebarPreference(): SidebarPreferenceApi {
	// SSR and hydration must match; restore the stored preference after hydration.
	const [expanded, setExpandedState] = useState(true);

	useEffect(() => {
		setExpandedState(readSidebarPreference() === "expanded");
	}, []);

	const setExpanded = useCallback((next: boolean) => {
		setExpandedState(next);
		writeSidebarPreference(next ? "expanded" : "collapsed");
	}, []);

	const toggle = useCallback(
		() => setExpanded(!expanded),
		[expanded, setExpanded],
	);

	return { expanded, setExpanded, toggle };
}
