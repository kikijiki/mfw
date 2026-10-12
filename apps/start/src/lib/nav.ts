import { useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

import { withBase } from "../routes";

/**
 * Navigate by built path string (from the `href` helpers in `routes.tsx`).
 * Uses `router.history` because the typed `to` overload needs a cast per call site.
 */
export function useGo(): (to: string, opts?: { replace?: boolean }) => void {
	const router = useRouter();
	return useCallback(
		(to: string, opts?: { replace?: boolean }) => {
			const href = withBase(to);
			if (opts?.replace) router.history.replace(href);
			else router.history.push(href);
		},
		[router],
	);
}

/**
 * Open a task from the board. Where the inspector docks beside the board
 * (>= 1280px, `DOCK_BREAKPOINTS.right`) it is `?node=task:ID` on the board,
 * keeping the board's filters and scroll; narrower it is the flat
 * `/p/$project/tasks/$taskId` page, full width.
 */
export function useOpenTaskFromBoard(
	project: string,
): (taskId: string) => void {
	const router = useRouter();
	return useCallback(
		(taskId: string) => {
			const docked =
				typeof window !== "undefined" &&
				window.matchMedia("(min-width: 1280px)").matches;
			if (docked) {
				void router.navigate({
					to: "/p/$project/board",
					params: { project },
					search: ((prev: Record<string, unknown>) => ({
						...prev,
						node: `task:${taskId}`,
						tab: undefined,
					})) as never,
				});
				return;
			}
			void router.navigate({
				to: "/p/$project/tasks/$taskId",
				params: { project, taskId },
			});
		},
		[router, project],
	);
}

/** A media query as React state, driven by the `matchMedia` change event. */
export function useMediaQuery(query: string): boolean {
	const [matches, setMatches] = useState(false);
	useEffect(() => {
		const mq = window.matchMedia(query);
		setMatches(mq.matches);
		const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
		mq.addEventListener("change", onChange);
		return () => mq.removeEventListener("change", onChange);
	}, [query]);
	return matches;
}

/** ≥1000px: the width below which side-by-side diffs stop being readable. */
export function useWideViewport(): boolean {
	return useMediaQuery("(min-width: 1000px)");
}
