import { useQuery } from "@tanstack/react-query";
import { Ellipsis } from "lucide-react";
import {
	type KeyboardEvent,
	type ReactNode,
	useEffect,
	useRef,
	useState,
} from "react";

import { Tabs, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { TipSpan } from "~/components/ui/tooltip";
import { AppLink } from "../../components/AppLink";
import { Chip } from "../../components/Page";
import { useTRPC } from "../../lib/trpc";
import { href, isActive } from "../../routes";
import { BrainHeaderChip, useBrainStates } from "../brain/BrainBadge";
import { ProjectDispatchButton } from "../dispatch/DispatchControls";
import { useInbox } from "../inbox/useInbox";
import { ConnectedProjectAvatar } from "../projects/ProjectAvatar";
import { projectNav } from "./projectNav";

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
	const brains = useBrainStates();
	const tasks = useQuery(trpc.tasks.list.queryOptions({ project }));
	const rows = tasks.data ?? [];
	const blocked = rows.filter((t) => t.status === "blocked").length;
	// Cached: the sidebar badge subscribes to the same key.
	const inbox = useInbox(project);
	const triggers = useQuery(trpc.triggers.list.queryOptions({ project }));
	// Counts every state not firing on purpose; armed and disabled do not count.
	const triggersNeedingAttention = (triggers.data ?? []).filter(
		(t) => t.state !== "armed" && t.state !== "disabled",
	).length;

	const nav = projectNav(project, { triggersNeedingAttention });
	const current = nav.lenses.find(
		(tab) => !tab.disabled && isActive(pathname, tab.to),
	);
	const overflowCurrent = nav.overflow.find((e) => isActive(pathname, e.to));
	const overflowBadge = nav.overflow.reduce((n, e) => n + (e.badge ?? 0), 0);

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
				{/* The phone shows the project in the shell's switcher already. */}
				<ConnectedProjectAvatar
					name={project}
					size={22}
					className="max-md:hidden"
				/>
				<span className="font-semibold max-md:hidden">{project}</span>
				{/* Phone-only per-project control (desktop has it in the sidebar). */}
				<ProjectDispatchButton project={project} className="md:hidden" />
				<div className="relative flex min-w-0 items-center max-md:order-last max-md:w-full">
					<nav
						aria-label="Project"
						className="max-md:-mx-3 max-md:min-w-0 max-md:flex-1 max-md:overflow-x-auto max-md:pr-11"
					>
						<Tabs
							value={current?.to ?? overflowCurrent?.to ?? ""}
							activationMode="manual"
						>
							<TabsList variant="line" className="max-md:h-auto">
								{nav.lenses.map((tab) =>
									tab.disabled ? (
										<TipSpan
											key={tab.to}
											tip={tab.reason}
											className="inline-flex flex-1"
										>
											<TabsTrigger
												value={tab.to}
												disabled
												className="max-md:min-h-11 max-md:px-3"
											>
												{tab.label}
											</TabsTrigger>
										</TipSpan>
									) : (
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
												aria-current={
													tab.to === current?.to ? "page" : undefined
												}
												onKeyDown={activateOnSpace}
											>
												{tab.label}
											</AppLink>
										</TabsTrigger>
									),
								)}
								{/* Wide screens show every destination as a tab; the
								 * overflow disclosure below is the phone's. */}
								{nav.overflow.map((entry) => (
									<TabsTrigger
										key={entry.to}
										value={entry.to}
										asChild
										className="max-md:hidden"
									>
										<AppLink
											to={entry.to}
											className="relative"
											aria-controls={undefined}
											type={undefined}
											aria-current={
												entry.to === overflowCurrent?.to ? "page" : undefined
											}
											onKeyDown={activateOnSpace}
										>
											{entry.label}
											{entry.badge ? (
												<span className="absolute -top-0.5 -right-1 text-[10px] leading-none tabular-nums">
													{entry.badge}
												</span>
											) : null}
										</AppLink>
									</TabsTrigger>
								))}
							</TabsList>
						</Tabs>
					</nav>
					<div className="md:hidden">
						<OverflowMenu
							entries={nav.overflow}
							current={overflowCurrent?.to}
							badge={overflowBadge}
						/>
					</div>
					{/* A fade, not a glyph: it sits beside the overflow button, never under it. */}
					<span
						aria-hidden
						className="pointer-events-none absolute inset-y-0 right-11 hidden w-6 bg-gradient-to-r from-transparent to-[var(--mfw-bg-subtle)] max-md:block"
					/>
				</div>
				{/* After the tabs, pushed right: an alert appearing must not slide the tab headers. */}
				<div className="flex min-w-0 items-center gap-2 md:ml-auto">
					<BrainHeaderChip project={project} row={brains.get(project)} />
					{blocked > 0 ? <Chip tone="warn">{blocked} blocked</Chip> : null}
					{inbox.counts?.total ? (
						<AppLink to={href.home()}>
							<Chip tone="warn">{inbox.counts.total} need you</Chip>
						</AppLink>
					) : null}
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

/**
 * The overflow: ADRs, Triggers, Files, Settings. A hand-rolled disclosure (no
 * dropdown primitive is installed): Escape and a click outside close it, and
 * its items are real links.
 */
function OverflowMenu({
	entries,
	current,
	badge,
}: {
	entries: ReturnType<typeof projectNav>["overflow"];
	current: string | undefined;
	badge: number;
}) {
	const [open, setOpen] = useState(false);
	const wrapRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!open) return;
		const onPointer = (event: PointerEvent) => {
			if (
				event.target instanceof Node &&
				wrapRef.current?.contains(event.target)
			)
				return;
			setOpen(false);
		};
		const onKey = (event: globalThis.KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false);
		};
		document.addEventListener("pointerdown", onPointer);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("pointerdown", onPointer);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);

	return (
		<div ref={wrapRef} className="relative shrink-0">
			<button
				type="button"
				aria-label="More project pages"
				aria-haspopup="menu"
				aria-expanded={open}
				aria-current={current ? "page" : undefined}
				className="mfw-focus flex h-7 items-center gap-1 border-0 bg-transparent px-2 max-md:min-h-11"
				style={{
					color: current ? "var(--mfw-accent)" : "var(--mfw-fg-muted)",
				}}
				onClick={() => setOpen((v) => !v)}
			>
				<Ellipsis aria-hidden className="size-4" />
				{badge > 0 ? <Chip tone="accent">{badge}</Chip> : null}
			</button>
			{open ? (
				<div
					role="menu"
					className="absolute top-full right-0 z-50 mt-1 flex min-w-40 flex-col gap-0.5 border p-1"
					style={{
						background: "var(--mfw-bg-raised)",
						borderColor: "var(--mfw-border)",
						borderRadius: "var(--mfw-radius-md)",
					}}
				>
					{entries.map((entry) => (
						<AppLink
							key={entry.to}
							to={entry.to}
							role="menuitem"
							aria-current={entry.to === current ? "page" : undefined}
							className="flex items-center gap-2 px-2 py-1.5 max-md:min-h-11"
							style={{
								borderRadius: "var(--mfw-radius-sm)",
								color:
									entry.to === current ? "var(--mfw-accent)" : "var(--mfw-fg)",
							}}
							onClick={() => setOpen(false)}
						>
							<span className="flex-1">{entry.label}</span>
							{entry.badge ? <Chip tone="accent">{entry.badge}</Chip> : null}
						</AppLink>
					))}
				</div>
			) : null}
		</div>
	);
}
