import { Page, Panel, Scroller } from "../../components/Page";
import { SeedRunActions } from "../board/SeedRuns";
import { WipeBoard } from "../board/WipeBoard";
import { DetachProject } from "../projects/DetachProject";
import { ProjectConfig } from "./ProjectConfig";
import { ProjectSemaphoresPanel } from "./ResourcesPanel";

/**
 * Everything scoped to ONE project, on that project's own page. The scope is
 * the URL (`/p/$project/settings`), so there is no project picker.
 *
 * `/settings` keeps only what is not per-project: provider CLIs (one machine)
 * and appearance (one browser).
 */
export function ProjectSettingsPage({ project }: { project: string }) {
	return (
		<Page className="h-full">
			{/* Keyed by project so a route change resets the drafts rather than
			    trying to migrate one project's unsaved edits onto another. */}
			<Scroller className="flex flex-col gap-3 p-3">
				<ProjectConfig key={project} project={project} />
				<Panel key={`seed:${project}`} title="Seed the board">
					<div className="flex flex-wrap items-center gap-3">
						<p
							style={{
								color: "var(--mfw-fg-muted)",
								fontSize: "var(--mfw-text-xs)",
							}}
						>
							Get tasks onto {project}'s board without typing them: import
							surveys this repository, plan decomposes one goal into a
							dependency-ordered set. Both can attach a spec to a task and start
							an agent run you can follow. Neither changes code.
						</p>
						<span className="flex-1" />
						<SeedRunActions project={project} />
					</div>
				</Panel>
				<ProjectSemaphoresPanel key={`res:${project}`} project={project} />
				<WipeBoard key={`wipe:${project}`} project={project} />
				<DetachProject key={`detach:${project}`} project={project} />
			</Scroller>
		</Page>
	);
}
