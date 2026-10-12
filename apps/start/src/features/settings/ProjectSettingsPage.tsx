import { useEffect, useRef, useState } from "react";

import { Page, Panel } from "../../components/Page";
import { cn } from "../../lib/utils";
import { SeedRunActions } from "../board/SeedRuns";
import { WipeBoard } from "../board/WipeBoard";
import { DetachProject } from "../projects/DetachProject";
import { ProjectAppearanceCard } from "../projects/ProjectAppearance";
import { BudgetsPanel } from "./BudgetsPanel";
import { ProjectConfig } from "./ProjectConfig";
import { ProjectSemaphoresPanel } from "./ResourcesPanel";

/** The sections, in page order. `id` is the anchor of the element holding it. */
export const SETTINGS_SECTIONS = [
	{ id: "dispatch", label: "Dispatch" },
	{ id: "agent", label: "Agents & routing" },
	{ id: "runs", label: "Runs" },
	{ id: "watchdog", label: "Watchdog" },
	{ id: "remote", label: "Remote execution" },
	{ id: "notifications", label: "Notifications" },
	{ id: "brain", label: "Brain" },
	{ id: "board", label: "Board" },
	{ id: "docs", label: "Docs" },
	{ id: "seed", label: "Seed the board" },
	{ id: "budgets", label: "Budgets" },
	{ id: "resources", label: "Resources" },
	{ id: "danger", label: "Danger zone" },
] as const;

/**
 * Everything scoped to ONE project, on that project's own page. The scope is
 * the URL (`/p/$project/settings`), so there is no project picker.
 *
 * Two panes: a section nav (sticky on the left from `lg`, a scrolling strip
 * above the content below it) and a bounded column of cards. The width is
 * bounded because a form field stretched across a 1900px screen is unreadable.
 *
 * `/settings` keeps only what is not per-project: provider CLIs (one machine)
 * and appearance (one browser).
 */
export function ProjectSettingsPage({ project }: { project: string }) {
	const scroller = useRef<HTMLDivElement>(null);
	const [active, setActive] = useState<string>(SETTINGS_SECTIONS[0].id);

	// The section whose top has passed the top of the scroller is the current one.
	useEffect(() => {
		const root = scroller.current;
		if (!root) return;
		const onScroll = () => {
			const top = root.getBoundingClientRect().top + 96;
			let current: string = SETTINGS_SECTIONS[0].id;
			for (const section of SETTINGS_SECTIONS) {
				const el = document.getElementById(section.id);
				if (el && el.getBoundingClientRect().top <= top) current = section.id;
			}
			setActive(current);
		};
		root.addEventListener("scroll", onScroll, { passive: true });
		return () => root.removeEventListener("scroll", onScroll);
	}, []);

	// `#seed` and friends: the empty board links straight to a section.
	useEffect(() => {
		const id = window.location.hash.slice(1);
		if (SETTINGS_SECTIONS.some((s) => s.id === id)) {
			const t = setTimeout(
				() => document.getElementById(id)?.scrollIntoView(),
				300,
			);
			return () => clearTimeout(t);
		}
	}, []);

	const jump = (id: string) => {
		document.getElementById(id)?.scrollIntoView({ block: "start" });
		setActive(id);
	};

	return (
		<Page className="h-full">
			<div ref={scroller} className="min-h-0 flex-1 overflow-auto">
				<div className="mx-auto flex w-full max-w-[88rem] flex-col gap-3 p-3 lg:flex-row lg:items-start lg:gap-6">
					<nav
						aria-label="Settings sections"
						className="sticky top-0 z-10 -mx-3 flex shrink-0 gap-1 overflow-x-auto border-b px-3 py-1.5 lg:top-3 lg:mx-0 lg:w-48 lg:flex-col lg:overflow-visible lg:border-0 lg:p-0"
						style={{
							borderColor: "var(--mfw-border)",
							background: "var(--mfw-bg)",
						}}
					>
						{SETTINGS_SECTIONS.map((section) => (
							<button
								key={section.id}
								type="button"
								onClick={() => jump(section.id)}
								aria-current={active === section.id ? "true" : undefined}
								className={cn(
									"mfw-focus shrink-0 whitespace-nowrap border-0 px-2 py-1 text-left lg:border-l-2",
								)}
								style={{
									background: "none",
									borderLeftColor:
										active === section.id ? "var(--mfw-accent)" : "transparent",
									color:
										active === section.id
											? "var(--mfw-fg)"
											: "var(--mfw-fg-muted)",
									fontSize: "var(--mfw-text-xs)",
								}}
							>
								{section.label}
							</button>
						))}
					</nav>
					{/* Keyed by project so a route change resets the drafts rather than
					    trying to migrate one project's unsaved edits onto another. */}
					<div className="flex min-w-0 max-w-[68rem] flex-1 flex-col gap-3">
						<ProjectAppearanceCard project={project} />
						<ProjectConfig key={project} project={project} />
						<Panel id="seed" key={`seed:${project}`} title="Seed the board">
							<div className="flex flex-wrap items-center gap-3">
								<p
									style={{
										color: "var(--mfw-fg-muted)",
										fontSize: "var(--mfw-text-xs)",
									}}
								>
									Get tasks onto {project}'s board without typing them: import
									surveys this repository, plan decomposes one goal into a
									dependency-ordered set. Both can attach a spec to a task and
									start an agent run you can follow. Neither changes code.
								</p>
								<span className="flex-1" />
								<SeedRunActions project={project} />
							</div>
						</Panel>
						<div id="budgets" className="scroll-mt-3">
							<BudgetsPanel key={`budgets:${project}`} project={project} />
						</div>
						<div id="resources" className="scroll-mt-3">
							<ProjectSemaphoresPanel
								key={`res:${project}`}
								project={project}
							/>
						</div>
						<div id="danger" className="flex scroll-mt-3 flex-col gap-3">
							<WipeBoard key={`wipe:${project}`} project={project} />
							<DetachProject key={`detach:${project}`} project={project} />
						</div>
					</div>
				</div>
			</div>
		</Page>
	);
}
