import { href } from "../../routes";

/**
 * The project header's navigation, pure. Two lenses over the same work
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
