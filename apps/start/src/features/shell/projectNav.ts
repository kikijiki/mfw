import { href } from "../../routes";

/**
 * The project header's navigation, pure. Lead, then two lenses over the same work
 * (Board, Flow) and an overflow for everything that is not a lens. Review,
 * Inbox and Agents are not destinations here: review is the task inspector's
 * Changes tab, the inbox is Home, agents are on the work itself.
 */

export interface LensTab {
	label: string;
	to: string;
	/** Not routable yet; rendered inert with `reason` as its title. */
	disabled?: boolean;
	reason?: string;
	/** Active only on exactly this path (Lead is the prefix of every other tab). */
	exact?: boolean;
}

/** Whether `tab` is the current one for `pathname`; the caller supplies the prefix-aware `isActive`. */
export function lensActive(
	pathname: string,
	tab: LensTab,
	isActive: (pathname: string, path: string) => boolean,
): boolean {
	if (tab.disabled || !isActive(pathname, tab.to)) return false;
	return !tab.exact || pathname.replace(/\/+$/, "").endsWith(tab.to);
}

export interface OverflowEntry {
	label: string;
	to: string;
	badge?: number;
}

export function projectNav(
	project: string,
	counts: { triggersNeedingAttention: number },
): { lenses: LensTab[]; overflow: OverflowEntry[] } {
	return {
		lenses: [
			{ label: "Lead", to: href.project(project), exact: true },
			{ label: "Board", to: href.board(project) },
			{ label: "Flow", to: href.flow(project) },
		],
		overflow: [
			{ label: "Docs", to: href.docs(project) },
			{
				label: "Triggers",
				to: href.triggers(project),
				badge: counts.triggersNeedingAttention || undefined,
			},
			{ label: "Repo", to: href.repo(project) },
			{ label: "Settings", to: href.projectSettings(project) },
		],
	};
}
