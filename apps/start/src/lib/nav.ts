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
 * Open a task as a child of the board route so the board stays mounted (scroll,
 * filters). The address bar shows `/p/$project/tasks/$taskId` via `routeMasks` in `router.tsx`.
 */
export function useOpenTaskFromBoard(
	project: string,
): (taskId: string) => void {
	const router = useRouter();
	return useCallback(
		(taskId: string) => {
			void router.navigate({
				to: "/p/$project/board/tasks/$taskId",
				params: { project, taskId },
				// Keep the board's filters: the still-mounted `BoardPage` reads them.
				search: true,
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
