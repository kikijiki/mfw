import { useQuery } from "@tanstack/react-query";
import type { KeyboardEvent, ReactNode } from "react";

import { Tabs, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { AppLink } from "../../components/AppLink";
import { Chip } from "../../components/Page";
import { useTRPC } from "../../lib/trpc";
import { href, isActive } from "../../routes";
import { ProjectDispatchButton } from "../dispatch/DispatchControls";
import { useInbox } from "../inbox/useInbox";

/**
 * Project chrome: the current project and its tabs. Each badge count comes
 * from the query behind its tab (`tasks.list`, `inbox.list` via `useInbox`),
 * so it cannot disagree with the screen it points at.
 *
 * The strip is `ui/tabs` driven by the URL; each trigger is `asChild` over a
 * real `<a href>`, so middle-click, copy-link and deep links work while the
 * tablist supplies roving focus. Styling comes from the primitive's
 * `data-active:` / `data-horizontal:` variants in styles.css.
 *
 * Two button props Radix merges onto the child are cleared:
 * `aria-controls` (no tabpanel exists) and `type` (on an anchor it would mean
 * the target's MIME type).
 *
 * `onValueChange` is absent on purpose: the anchor navigates, and a second
 * handler would push two history entries. Space is wired below.
 */
export function ProjectLayout({
	project,
	pathname,
	children,
}: {
	project: string;
	pathname: string;
	children: ReactNode;
}) {
	const trpc = useTRPC();
	const tasks = useQuery(trpc.tasks.list.queryOptions({ project }));
	const rows = tasks.data ?? [];
	const review = rows.filter((t) => t.status === "review").length;
	const blocked = rows.filter((t) => t.status === "blocked").length;
	// Cached: the sidebar badge subscribes to the same key.
	const inbox = useInbox(project);
	const triggers = useQuery(trpc.triggers.list.queryOptions({ project }));
	// Counts every state not firing on purpose; armed and disabled do not count.
	const triggersNeedingAttention = (triggers.data ?? []).filter(
		(t) => t.state !== "armed" && t.state !== "disabled",
	).length;

	const tabs = [
		{
			label: "Board",
			to: href.board(project),
			badge: undefined as number | undefined,
		},
		{
			label: "Inbox",
			to: href.projectInbox(project),
			badge: inbox.counts?.total,
		},
		{ label: "Review", to: href.review(project), badge: review },
		{ label: "ADRs", to: href.adrs(project), badge: undefined },
		{ label: "Runs", to: href.runs(project), badge: undefined },
		{
			label: "Triggers",
			to: href.triggers(project),
			badge: triggersNeedingAttention,
		},
		{ label: "Files", to: href.files(project), badge: undefined },
		{ label: "Settings", to: href.projectSettings(project), badge: undefined },
	];
	const current = tabs.find((tab) => isActive(pathname, tab.to));

	return (
		/* `h-full`, not `flex-1`: the shell's `<main>` is a block container, so
		 * `flex-1` does nothing and child screens would resolve `h-full` against auto. */
		<div className="flex h-full min-h-0 w-full flex-col">
			<div
				className="flex flex-wrap items-center gap-3 border-b px-3 py-1.5"
				style={{
					borderColor: "var(--mfw-border)",
					background: "var(--mfw-bg-subtle)",
				}}
			>
				<span className="font-semibold">{project}</span>
				{/* Phone-only per-project control (desktop has it in the sidebar). */}
				<ProjectDispatchButton project={project} className="md:hidden" />
				{blocked > 0 ? <Chip tone="warn">{blocked} blocked</Chip> : null}
				<div className="relative min-w-0 max-md:order-last max-md:w-full">
					<nav
						aria-label="Project"
						className="max-md:-mx-3 max-md:overflow-x-auto max-md:px-3 max-md:pr-11"
					>
						<Tabs value={current?.to ?? ""} activationMode="manual">
							<TabsList variant="line" className="max-md:h-auto">
								{tabs.map((tab) => (
									<TabsTrigger
										key={tab.to}
										value={tab.to}
										asChild
										className="max-md:min-h-11 max-md:px-3"
									>
										<AppLink
											to={tab.to}
											aria-controls={undefined}
											type={undefined}
											aria-current={tab.to === current?.to ? "page" : undefined}
											onKeyDown={activateOnSpace}
										>
											{tab.label}
											{tab.badge ? (
												<Chip tone="accent">{tab.badge}</Chip>
											) : null}
										</AppLink>
									</TabsTrigger>
								))}
							</TabsList>
						</Tabs>
					</nav>
					<span
						aria-hidden
						className="pointer-events-none absolute inset-y-0 -right-3 hidden w-10 items-center justify-end bg-gradient-to-r from-transparent to-[var(--mfw-bg-subtle)] pr-2 text-lg max-md:flex"
					>
						›
					</span>
				</div>
			</div>
			<div className="flex min-h-0 flex-1 flex-col">{children}</div>
		</div>
	);
}

/**
 * A tab must activate on Space (WAI-ARIA); on an anchor Space would scroll.
 * Radix's handler calls `onValueChange`, which is not supplied, so click here.
 */
function activateOnSpace(event: KeyboardEvent<HTMLAnchorElement>) {
	if (event.key !== " ") return;
	event.preventDefault();
	event.currentTarget.click();
}
