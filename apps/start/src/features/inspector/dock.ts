import type { KeyBinding } from "../../lib/keyboard";
import { useMediaQuery } from "../../lib/nav";

/**
 * Where the inspector docks (design §11.4). Pure helpers plus one hook, so the
 * breakpoint table is a unit-tested constant rather than a CSS accident.
 *
 * | width       | side     |
 * | ----------- | -------- |
 * | < 768       | `full`   |
 * | 768 - 1279  | `bottom` |
 * | >= 1280     | `right`  |
 * | >= 1680     | `split`  |  (inspector, tree and timeline side by side)
 */

export type DockSide = "full" | "bottom" | "right" | "split";

export const DOCK_BREAKPOINTS = {
	bottom: 768,
	right: 1280,
	split: 1680,
} as const;

export function dockFor(width: number): DockSide {
	if (width >= DOCK_BREAKPOINTS.split) return "split";
	if (width >= DOCK_BREAKPOINTS.right) return "right";
	if (width >= DOCK_BREAKPOINTS.bottom) return "bottom";
	return "full";
}

export interface DockLayout {
	/** The element holding the lens and the inspector side by side (or stacked). */
	container: string;
	/** The inspector's own pane. */
	pane: string;
}

/**
 * Tailwind classes per side. Docked sides sit in the flow next to the lens, so
 * nothing is overlaid; only `full` covers the screen (phones have no room for
 * a second column).
 */
export function dockLayout(side: DockSide): DockLayout {
	switch (side) {
		case "full":
			return {
				container: "flex h-full min-h-0 flex-col",
				pane: "fixed inset-0 z-40 flex min-h-0 flex-col bg-[var(--mfw-bg)]",
			};
		case "bottom":
			return {
				container: "flex h-full min-h-0 flex-col",
				pane: "flex h-[45%] min-h-48 shrink-0 flex-col border-t bg-[var(--mfw-bg)]",
			};
		case "right":
			return {
				container: "flex h-full min-h-0 flex-row",
				pane: "flex h-full w-[min(36rem,42vw)] shrink-0 flex-col border-l bg-[var(--mfw-bg)]",
			};
		case "split":
			return {
				container: "flex h-full min-h-0 flex-row",
				pane: "flex h-full w-[min(44rem,38vw)] shrink-0 flex-col border-l bg-[var(--mfw-bg)]",
			};
	}
}

/** The side for the current viewport. Before the first effect it is `full` (the phone-first paint). */
export function useDockSide(): DockSide {
	const split = useMediaQuery(`(min-width: ${DOCK_BREAKPOINTS.split}px)`);
	const right = useMediaQuery(`(min-width: ${DOCK_BREAKPOINTS.right}px)`);
	const bottom = useMediaQuery(`(min-width: ${DOCK_BREAKPOINTS.bottom}px)`);
	if (split) return "split";
	if (right) return "right";
	if (bottom) return "bottom";
	return "full";
}

/** How the inspector is presented: docked beside a lens, in a modal sheet (the task overlay), or as its own page. */
export type InspectorPresentation = "dock" | "sheet" | "page";

/**
 * The search params after closing the inspector: `node` and the inspector's
 * own `tab` go, the lens's filters, `t`, `f` and `w` stay. Closing is the URL
 * changing, never view state.
 */
export function closeNodeSearch<T extends { node?: string; tab?: string }>(
	search: T,
): Omit<T, "node" | "tab"> {
	const { node: _node, tab: _tab, ...rest } = search;
	return rest;
}

/** Is a Radix dialog, menu or listbox open? Escape then belongs to it, not to the inspector. */
function overlayOpen(): boolean {
	if (typeof document === "undefined") return false;
	return (
		document.querySelector(
			'[role="dialog"][data-state="open"], [role="alertdialog"], [role="menu"], [role="listbox"]',
		) !== null
	);
}

/**
 * The inspector's shortcuts. Escape closes a *docked* inspector only: the
 * sheet and the full page are closed by their own chrome, and a text field
 * keeps its Escape (the registry swallows single keys in inputs, so a dirty
 * form is never closed by accident).
 */
export function inspectorBindings(opts: {
	presentation: InspectorPresentation;
	onClose: () => void;
}): KeyBinding[] {
	return [
		{
			key: "Escape",
			label: "Close inspector",
			group: "Inspector",
			enabled: opts.presentation === "dock",
			run: () => {
				if (overlayOpen()) return;
				opts.onClose();
			},
		},
	];
}
