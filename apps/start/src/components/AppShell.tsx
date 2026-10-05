import { useQuery } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import {
	Activity,
	Boxes,
	Cloud,
	Ellipsis,
	FolderPlus,
	History,
	Inbox,
	type LucideIcon,
	Monitor,
	PanelLeftClose,
	PanelLeftOpen,
	Route as RouteIcon,
	Settings,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "~/components/ui/select";
import { cn } from "~/lib/utils";
import {
	GlobalDispatchButton,
	ProjectDispatchButton,
} from "../features/dispatch/DispatchControls";
import { AddProjectDialog } from "../features/projects/AddProjectDialog";
import {
	LiveContext,
	type LiveStatus,
	useLive,
	useLiveChannel,
} from "../lib/live";
import { useSidebarPreference } from "../lib/sidebarPreference";
import { ToastProvider } from "../lib/toast";
import { useTRPC } from "../lib/trpc";
import { href, isActive, withBase } from "../routes";
import "../styles/tokens.css";
import { DaemonUnreachableBanner, ReconnectingOverlay } from "./ErrorState";

/**
 * The app shell. It alone:
 *  1. opens the single live subscription and publishes it via `LiveContext`
 *     (no screen opens its own event channel);
 *  2. renders the daemon-health indicator on every view;
 *  3. hosts the toast viewport, where the error policy lands.
 */

export interface AppShellProps {
	children: ReactNode;
	/** Current project, when the route has one. */
	project?: string;
	/** Overrides the router path for active-nav highlighting (tests). */
	activePath?: string;
	/** How links are followed. Defaults to a full page navigation. */
	navigate?: (to: string) => void;
}

export function AppShell(props: AppShellProps) {
	return (
		<ToastProvider>
			<LiveRoot {...props} />
		</ToastProvider>
	);
}

/** Separate so `useLiveChannel` runs under the toast provider and can raise toasts. */
function LiveRoot({ children, ...rest }: AppShellProps) {
	const live = useLiveChannel();
	return (
		<LiveContext.Provider value={live}>
			<Shell {...rest}>{children}</Shell>
		</LiveContext.Provider>
	);
}

function Shell({ children, project, activePath, navigate }: AppShellProps) {
	const routerPath = useRouterState({ select: (s) => s.location.pathname });
	const path = activePath ?? routerPath;
	const go = navigate ?? ((to: string) => window.location.assign(withBase(to)));

	const { inboxCount } = useInboxBadge();
	const sidebar = useSidebarPreference();

	return (
		/* Exactly the viewport; never scrolls, so the sidebar cannot grow with content. */
		<div
			className="mfw-v2 flex h-full w-full flex-col overflow-hidden md:flex-row"
			style={{ background: "var(--mfw-bg)" }}
		>
			<Sidebar
				path={path}
				project={project}
				inboxCount={inboxCount}
				onNavigate={go}
				expanded={sidebar.expanded}
				onToggle={sidebar.toggle}
			/>
			<div className="flex min-h-0 min-w-0 flex-1 flex-col">
				<HealthBanner />
				<MobileHeader project={project} onNavigate={go} />
				{/*
				 * Positioning boundary for transient overlays. `min-h-0` lets it shrink
				 * below its content; `main` is the one scroll container, and screens
				 * with their own scrolling resolve `h-full` against it.
				 *
				 * `data-scroll-root`: the element a task panel locks while open
				 * (`document.body` is never the scroll container).
				 */}
				<div data-content-region className="relative min-h-0 min-w-0 flex-1">
					<ReconnectingStatus />
					<main
						data-scroll-root
						className="h-full min-h-0 min-w-0 overflow-auto pb-14 md:pb-0"
					>
						{children}
					</main>
				</div>
			</div>
			{/* Reset transient mobile menus whenever the router commits a path. */}
			<TabBar key={path} path={path} inboxCount={inboxCount} onNavigate={go} />
		</div>
	);
}

// ---------------------------------------------------------------------------
// Inbox badge
// ---------------------------------------------------------------------------

/** The badge uses the server's count, never a client derivation, so it cannot
 *  disagree with the list. `inbox.list` is invalidated by the live channel. */
function useInboxBadge() {
	const trpc = useTRPC();
	const { data } = useQuery(trpc.inbox.list.queryOptions());
	const inboxCount = data?.counts.total ?? 0;

	// The tab title is the badge for a backgrounded window.
	useEffect(() => {
		if (typeof document === "undefined") return;
		document.title = inboxCount > 0 ? `(${inboxCount}) mfw` : "mfw";
	}, [inboxCount]);

	return { inboxCount, critical: data?.counts.critical ?? 0 };
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

interface NavEntry {
	label: string;
	to: string;
	icon: LucideIcon;
}

const PRIMARY_NAV: NavEntry[] = [
	{ label: "Now", to: href.now(), icon: Activity },
	{ label: "Inbox", to: href.inbox(), icon: Inbox },
	{ label: "History", to: href.history(), icon: History },
	{ label: "Resources", to: href.resources(), icon: Boxes },
	{ label: "RunPod", to: href.runpod(), icon: Cloud },
	{ label: "OpenRouter", to: href.openrouter(), icon: RouteIcon },
];

const MOBILE_NAV: NavEntry[] = [
	{ label: "Now", to: href.now(), icon: Activity },
	{ label: "Inbox", to: href.inbox(), icon: Inbox },
	{ label: "Resources", to: href.resources(), icon: Boxes },
	{ label: "RunPod", to: href.runpod(), icon: Cloud },
];

function Sidebar({
	path,
	project,
	inboxCount,
	onNavigate,
	expanded,
	onToggle,
}: {
	path: string;
	project?: string;
	inboxCount: number;
	onNavigate: (to: string) => void;
	expanded: boolean;
	onToggle: () => void;
}) {
	const trpc = useTRPC();
	const projects = useQuery({
		...trpc.system.projects.queryOptions(),
		staleTime: 5 * 60_000,
	});
	const [addingProject, setAddingProject] = useState(false);

	return (
		<nav
			aria-label="Main"
			data-expanded={expanded}
			// Scrolls on its own so many projects do not clip Settings.
			className="hidden min-h-0 shrink-0 flex-col gap-1 overflow-y-auto border-r p-2 md:flex"
			style={{
				width: expanded ? "var(--mfw-sidebar-w)" : "48px",
				background: "var(--mfw-bg-subtle)",
				borderColor: "var(--mfw-border)",
			}}
		>
			{/* Health belongs to the mfw identity; global dispatch sits at the bottom. */}
			<div
				className={cn(
					"flex items-center gap-1 px-2 py-1.5",
					!expanded && "flex-col px-0",
				)}
			>
				<div className="flex items-center gap-1">
					<span
						className="font-semibold"
						style={{
							fontSize: "var(--mfw-text-lg)",
							display: expanded ? undefined : "none",
						}}
					>
						mfw
					</span>
					<HealthDot />
				</div>
				{expanded ? <div className="flex-1" /> : null}
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					aria-label={expanded ? "Collapse sidebar" : "Expand sidebar"}
					aria-expanded={expanded}
					onClick={onToggle}
				>
					{expanded ? <PanelLeftClose /> : <PanelLeftOpen />}
				</Button>
			</div>

			{PRIMARY_NAV.map((entry) => (
				<NavLink
					key={entry.to}
					entry={entry}
					active={isActive(path, entry.to)}
					badge={entry.to === href.inbox() ? inboxCount : undefined}
					onNavigate={onNavigate}
					compact={!expanded}
				/>
			))}

			{expanded ? <Divider /> : null}

			{expanded ? (
				<>
					<div
						className="px-2 pt-1 pb-0.5 uppercase"
						style={{
							color: "var(--mfw-fg-faint)",
							fontSize: "var(--mfw-text-2xs)",
							letterSpacing: "0.06em",
						}}
					>
						Projects
					</div>
					<Button
						type="button"
						variant="ghost"
						className="h-[var(--mfw-row-h)] w-full justify-start gap-0 px-2 pr-0"
						aria-label="Add project"
						onClick={() => setAddingProject(true)}
					>
						<span className="min-w-0 flex-1 truncate text-left">
							Add project
						</span>
						<span
							aria-hidden
							className="flex size-7 items-center justify-center"
						>
							<FolderPlus />
						</span>
					</Button>
				</>
			) : (
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					className="self-center"
					aria-label="Add project"
					title="Add project"
					onClick={() => setAddingProject(true)}
				>
					<FolderPlus />
				</Button>
			)}
			{/*
			 * Project row: link plus per-project play/stop. The button is a sibling
			 * of the anchor; nested in a link it would also navigate.
			 */}
			{(projects.data ?? []).map((p) => (
				<fieldset
					key={p.name}
					aria-label={`${p.name} project`}
					className={cn(
						"m-0 flex min-w-0 items-center gap-1 border-0 p-0",
						!expanded && "flex-col",
					)}
				>
					<NavLink
						className={cn("min-w-0", expanded ? "flex-1" : "w-full")}
						entry={{ label: p.name, to: href.board(p.name), icon: Monitor }}
						active={p.name === project}
						onNavigate={onNavigate}
						compact={!expanded}
					/>
					<ProjectDispatchButton project={p.name} variant="icon" />
				</fieldset>
			))}
			{expanded && projects.data?.length === 0 ? (
				<div
					className="px-2 py-1"
					style={{
						color: "var(--mfw-fg-faint)",
						fontSize: "var(--mfw-text-xs)",
					}}
				>
					No projects attached yet.
				</div>
			) : null}

			<AddProjectDialog open={addingProject} onOpenChange={setAddingProject} />

			<div className="flex-1" />
			<Divider />
			<GlobalDispatchButton variant="navigation" compact={!expanded} />
			<NavLink
				entry={{ label: "Settings", to: href.settings(), icon: Settings }}
				active={isActive(path, href.settings())}
				onNavigate={onNavigate}
				compact={!expanded}
			/>
		</nav>
	);
}

function Divider() {
	return (
		<div
			className="my-1 h-px"
			style={{ background: "var(--mfw-border)" }}
			aria-hidden
		/>
	);
}

function NavLink({
	entry,
	active,
	badge,
	className,
	onNavigate,
	compact = false,
}: {
	entry: NavEntry;
	active: boolean;
	badge?: number;
	className?: string;
	onNavigate: (to: string) => void;
	compact?: boolean;
}) {
	const Icon = entry.icon;
	const badgeLabel = badge ? `${entry.label}, ${badge} items` : entry.label;
	return (
		<a
			href={withBase(entry.to)}
			aria-current={active ? "page" : undefined}
			aria-label={compact ? badgeLabel : undefined}
			title={compact ? badgeLabel : undefined}
			className={cn(
				"mfw-focus relative flex items-center gap-2 no-underline",
				compact ? "justify-center px-0" : "px-2",
				"hover:brightness-110",
				className,
			)}
			style={{
				height: "var(--mfw-row-h)",
				borderRadius: "var(--mfw-radius-md)",
				background: active ? "var(--mfw-accent-subtle)" : "transparent",
				color: active ? "var(--mfw-accent)" : "var(--mfw-fg-muted)",
			}}
			onClick={(e) => {
				// Let the browser handle modified clicks (new tab / new window).
				if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
				e.preventDefault();
				onNavigate(entry.to);
			}}
		>
			<Icon aria-hidden className="size-4 shrink-0" />
			{compact ? null : (
				<span className="min-w-0 flex-1 truncate">{entry.label}</span>
			)}
			{badge ? <CountBadge count={badge} compact={compact} /> : null}
		</a>
	);
}

function CountBadge({
	count,
	compact = false,
}: {
	count: number;
	compact?: boolean;
}) {
	return (
		<span
			aria-hidden={compact || undefined}
			className={cn(
				"mfw-num inline-flex h-4.5 min-w-4.5 items-center justify-center px-1",
				compact && "absolute -top-0.5 -right-0.5 h-3.5 min-w-3.5 px-0.5",
			)}
			style={{
				background: "var(--mfw-accent)",
				color: "var(--mfw-fg-on-accent)",
				borderRadius: "var(--mfw-radius-sm)",
				fontSize: "var(--mfw-text-2xs)",
			}}
		>
			{count > 99 ? "99+" : count}
		</span>
	);
}

/** Phone: bottom tabs, because the top of a phone screen is not reachable. */
function TabBar({
	path,
	inboxCount,
	onNavigate,
}: {
	path: string;
	inboxCount: number;
	onNavigate: (to: string) => void;
}) {
	const [moreOpen, setMoreOpen] = useState(false);
	const moreButtonRef = useRef<HTMLButtonElement>(null);
	const moreMenuRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!moreOpen) return;
		const dismissOutside = (event: PointerEvent) => {
			const target = event.target;
			if (!(target instanceof Node)) return;
			if (
				moreMenuRef.current?.contains(target) ||
				moreButtonRef.current?.contains(target)
			)
				return;
			setMoreOpen(false);
		};
		const dismissWithKeyboard = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			setMoreOpen(false);
			moreButtonRef.current?.focus();
		};
		document.addEventListener("pointerdown", dismissOutside);
		document.addEventListener("keydown", dismissWithKeyboard);
		return () => {
			document.removeEventListener("pointerdown", dismissOutside);
			document.removeEventListener("keydown", dismissWithKeyboard);
		};
	}, [moreOpen]);
	const moreActive =
		isActive(path, href.history()) ||
		isActive(path, href.openrouter()) ||
		isActive(path, href.settings());
	const moreEntries: NavEntry[] = [
		{ label: "History", to: href.history(), icon: History },
		{ label: "OpenRouter", to: href.openrouter(), icon: RouteIcon },
		{ label: "Settings", to: href.settings(), icon: Settings },
	];
	return (
		<>
			{moreOpen ? (
				<div
					ref={moreMenuRef}
					id="mobile-more-menu"
					role="menu"
					className="fixed right-2 bottom-14 z-50 flex min-w-40 flex-col gap-1 border p-2 md:hidden"
					style={{
						background: "var(--mfw-bg-raised)",
						borderColor: "var(--mfw-border)",
						borderRadius: "var(--mfw-radius-md)",
					}}
				>
					{moreEntries.map((entry) => (
						<NavLink
							key={entry.to}
							entry={entry}
							active={isActive(path, entry.to)}
							onNavigate={(to) => {
								setMoreOpen(false);
								onNavigate(to);
							}}
							className="min-h-11"
						/>
					))}
				</div>
			) : null}
			<nav
				aria-label="Main"
				className="fixed inset-x-0 bottom-0 z-40 flex border-t md:hidden"
				style={{
					background: "var(--mfw-bg-subtle)",
					borderColor: "var(--mfw-border)",
				}}
			>
				{MOBILE_NAV.map((entry) => {
					const Icon = entry.icon;
					const active = isActive(path, entry.to);
					return (
						<a
							key={entry.to}
							href={withBase(entry.to)}
							aria-current={active ? "page" : undefined}
							// 44px minimum touch target.
							className="mfw-focus flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 py-1.5 no-underline"
							style={{
								color: active ? "var(--mfw-accent)" : "var(--mfw-fg-muted)",
							}}
							onClick={(e) => {
								if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0)
									return;
								e.preventDefault();
								setMoreOpen(false);
								onNavigate(entry.to);
							}}
						>
							<span className="relative">
								<Icon aria-hidden className="size-5" />
								{entry.to === href.inbox() && inboxCount > 0 ? (
									<span
										aria-hidden
										className="absolute -top-0.5 -right-1 size-2 rounded-full"
										style={{ background: "var(--mfw-accent)" }}
									/>
								) : null}
							</span>
							<span style={{ fontSize: "var(--mfw-text-2xs)" }}>
								{entry.label}
							</span>
						</a>
					);
				})}
				<button
					ref={moreButtonRef}
					type="button"
					aria-expanded={moreOpen}
					aria-controls="mobile-more-menu"
					aria-current={moreActive ? "page" : undefined}
					className="mfw-focus flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 border-0 py-1.5"
					style={{
						background: "transparent",
						color: moreActive ? "var(--mfw-accent)" : "var(--mfw-fg-muted)",
					}}
					onClick={() => setMoreOpen((open) => !open)}
				>
					<Ellipsis aria-hidden className="size-5" />
					<span style={{ fontSize: "var(--mfw-text-2xs)" }}>More</span>
				</button>
			</nav>
		</>
	);
}

/**
 * Phone: the sidebar is gone, so the switcher, health dot and global dispatch
 * control live here. Per-project play/stop is omitted: `ProjectLayout`'s header
 * carries it, and a second icon beside the global toggle would be ambiguous.
 */
function MobileHeader({
	project,
	onNavigate,
}: {
	project?: string;
	onNavigate: (to: string) => void;
}) {
	const [addingProject, setAddingProject] = useState(false);
	return (
		<>
			<div
				className="flex items-center gap-2 border-b px-2 py-1.5 md:hidden"
				style={{
					borderColor: "var(--mfw-border)",
					background: "var(--mfw-bg-subtle)",
				}}
			>
				<div className="flex items-center gap-1">
					<span className="font-semibold">mfw</span>
					<HealthDot />
				</div>
				<div className="min-w-0 flex-1">
					<ProjectSwitcher project={project} onNavigate={onNavigate} />
				</div>
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					className="max-md:size-11"
					aria-label="Add project"
					onClick={() => setAddingProject(true)}
				>
					<FolderPlus />
				</Button>
				<GlobalDispatchButton variant="icon" />
			</div>
			<AddProjectDialog open={addingProject} onOpenChange={setAddingProject} />
		</>
	);
}

export function ProjectSwitcher({
	project,
	onNavigate,
}: {
	project?: string;
	onNavigate: (to: string) => void;
}) {
	const trpc = useTRPC();
	const projects = useQuery({
		...trpc.system.projects.queryOptions(),
		staleTime: 5 * 60_000,
	});
	const names = (projects.data ?? []).map((p) => p.name);
	if (names.length === 0) return null;

	return (
		<Select
			value={project ?? ""}
			onValueChange={(name) => onNavigate(href.board(name))}
		>
			<SelectTrigger size="sm" className="min-h-11 w-full max-w-50">
				<SelectValue placeholder="Select a project" />
			</SelectTrigger>
			<SelectContent>
				{names.map((name) => (
					<SelectItem key={name} value={name}>
						{name}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

// ---------------------------------------------------------------------------
// Daemon health
// ---------------------------------------------------------------------------

const STATUS_TOKEN: Record<LiveStatus, string> = {
	connected: "--mfw-ok",
	reconnecting: "--mfw-warn",
	offline: "--mfw-critical",
};

const STATUS_LABEL: Record<LiveStatus, string> = {
	connected: "Connected",
	reconnecting: "Reconnecting",
	offline: "Connection lost",
};

/** Present in every layout so staleness is visible without navigating. */
export function HealthDot() {
	const { status } = useLive();
	return (
		<span
			role="img"
			aria-label={STATUS_LABEL[status]}
			title={STATUS_LABEL[status]}
			className={cn(
				"inline-block size-2.5 shrink-0 rounded-full",
				status !== "connected" && "mfw-pulse",
			)}
			style={{ background: `var(${STATUS_TOKEN[status]})` }}
		/>
	);
}

function HealthBanner() {
	const { status, lastContactAt, reconnect } = useLive();
	if (status !== "offline") return null;
	return (
		<DaemonUnreachableBanner
			lastContactAt={lastContactAt}
			onRetry={reconnect}
		/>
	);
}

function ReconnectingStatus() {
	const { status } = useLive();
	return status === "reconnecting" ? <ReconnectingOverlay /> : null;
}
