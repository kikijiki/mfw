import type { ProjectSummary } from "@mfw/daemon/project-summary";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	Activity,
	Ban,
	Bell,
	Bot,
	Brain,
	ChevronDown,
	Circle,
	Eye,
	GitBranch,
	type LucideIcon,
	Pencil,
	Play,
	Settings,
	Square,
} from "lucide-react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Tip } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { nodeRef } from "../../lib/nodeRef";
import { useTRPC } from "../../lib/trpc";
import { href, withBase } from "../../routes";
import { useBrainStates } from "../brain/BrainBadge";
import type { BrainStateRow } from "../brain/brain";
import {
	ProjectDispatchDialog,
	useProjectDispatch,
} from "../dispatch/DispatchControls";
import type { DispatchStatusLike } from "../dispatch/state";
import { ProjectAppearanceDialog } from "../projects/ProjectAppearance";
import {
	type ProjectAppearance,
	ProjectAvatar,
} from "../projects/ProjectAvatar";
import {
	activityAgo,
	type ChipKey,
	idleLine,
	projectBadge,
	projectTooltip,
	type RailBadge,
	type RailInput,
	type RailTone,
	statChips,
} from "./projectRail";

/**
 * The sidebar's project entries, collapsed and expanded, over one model
 * (`projectRail.ts`). Collapsed: ONE square tile per project with one corner
 * badge; expanded: avatar, name, one trailing badge, the dispatch toggle on
 * hover (or while running) and a quiet stats line. Every other action lives in
 * a menu opened by right-click, long-press, the hover chevron, or
 * Shift+F10 / the Menu key on the focused tile.
 */

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

export interface RailRow {
	input: RailInput;
	summary: ProjectSummary | null;
}

const LIVE = new Set(["starting", "running"]);

/**
 * One model for every project: the machine-wide `projects.summary` (task
 * counts, worktrees, spend, last activity; refetched every 45 s and whenever
 * the live runs or inbox change) mixed with the live-fresh caches the shell
 * already holds (runs, inbox, dispatch fleet, brain states), so the badge
 * never lags the rest of the UI.
 */
export function useRailRows(
	names: readonly string[],
): ReadonlyMap<string, RailRow> {
	const trpc = useTRPC();
	const queryClient = useQueryClient();
	const summaries = useQuery({
		...trpc.projects.summary.queryOptions(),
		refetchInterval: 45_000,
		staleTime: 20_000,
	});
	const runs = useQuery(trpc.runs.active.queryOptions());
	const inbox = useQuery(trpc.inbox.list.queryOptions());
	const fleet = useQuery(trpc.system.scheduler.all.queryOptions());
	const brains = useBrainStates();

	// Live changes to what the summary counts refresh it without waiting for the timer.
	const first = useRef(true);
	const liveSignature = `${runs.data?.length ?? 0}:${inbox.data?.items.length ?? 0}`;
	// biome-ignore lint/correctness/useExhaustiveDependencies: the signature is the trigger, not a value read inside
	useEffect(() => {
		if (first.current) {
			first.current = false;
			return;
		}
		void queryClient.invalidateQueries(trpc.projects.summary.queryFilter());
	}, [liveSignature, queryClient, trpc]);

	return useMemo(() => {
		const out = new Map<string, RailRow>();
		const summaryBy = new Map(
			(summaries.data ?? []).map((s) => [s.project, s]),
		);
		for (const name of names) {
			const live = (runs.data ?? []).filter(
				(r) => r.project === name && LIVE.has(r.state),
			).length;
			const needs = (inbox.data?.items ?? []).filter(
				(i) => i.project === name,
			).length;
			const status = fleet.data?.projects.find((p) => p.project === name)
				?.status as DispatchStatusLike | null | undefined;
			const row: BrainStateRow | undefined = brains.get(name);
			out.set(name, {
				summary: (summaryBy.get(name) as ProjectSummary | undefined) ?? null,
				input: {
					name,
					dispatch: status ?? null,
					brain: row ? { enabled: row.enabled, state: row.state } : null,
					needs,
					liveRuns: live,
				},
			});
		}
		return out;
	}, [names, summaries.data, runs.data, inbox.data, fleet.data, brains]);
}

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

const TONE_BG: Record<RailTone, string> = {
	accent: "var(--mfw-accent)",
	ok: "var(--mfw-ok)",
	warn: "var(--mfw-warn)",
	critical: "var(--mfw-critical)",
	neutral: "var(--mfw-fg-faint)",
};

function BadgeView({
	badge,
	corner,
}: {
	badge: RailBadge;
	/** Absolutely positioned on a tile's corner (collapsed rail). */
	corner?: boolean;
}) {
	const dot = badge.text === "";
	return (
		<span
			role="img"
			aria-label={badge.label}
			data-testid="project-badge"
			data-kind={badge.kind}
			className={cn(
				"mfw-num pointer-events-none inline-flex shrink-0 items-center justify-center",
				corner && "absolute -top-1 -right-1 ring-2",
				dot ? "size-2.5 rounded-full" : "h-4 min-w-4 px-1",
			)}
			style={{
				background: TONE_BG[badge.tone],
				color: "var(--mfw-fg-on-accent)",
				borderRadius: dot ? undefined : "var(--mfw-radius-sm)",
				fontSize: "var(--mfw-text-2xs)",
				lineHeight: 1,
				// Cuts the badge out of whatever it overlaps (the tile's own background).
				["--tw-ring-color" as string]: "var(--mfw-bg-subtle)",
			}}
		>
			{badge.text}
		</span>
	);
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

interface ProjectMenuProps {
	name: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onNavigate: (to: string) => void;
	brainEnabled: boolean;
	onChangeIcon: () => void;
	dispatch: ReturnType<typeof useProjectDispatch>;
	children: ReactNode;
}

function MenuItem({
	icon: Icon,
	children,
	onSelect,
	disabled,
}: {
	icon: LucideIcon;
	children: ReactNode;
	onSelect: () => void;
	disabled?: boolean;
}) {
	return (
		<button
			type="button"
			role="menuitem"
			disabled={disabled}
			className="mfw-focus flex h-8 w-full items-center gap-2 border-0 px-2 text-left disabled:opacity-50"
			style={{
				background: "transparent",
				color: "var(--mfw-fg)",
				borderRadius: "var(--mfw-radius-sm)",
				fontSize: "var(--mfw-text-sm)",
			}}
			onClick={onSelect}
		>
			<Icon aria-hidden className="size-4 shrink-0" />
			<span className="min-w-0 flex-1 truncate">{children}</span>
		</button>
	);
}

/** The project's actions, anchored to its tile or row. */
function ProjectMenu({
	name,
	open,
	onOpenChange,
	onNavigate,
	brainEnabled,
	onChangeIcon,
	dispatch,
	children,
}: ProjectMenuProps) {
	const close = () => onOpenChange(false);
	const go = (to: string) => () => {
		close();
		onNavigate(to);
	};
	return (
		<PopoverPrimitive.Root open={open} onOpenChange={onOpenChange}>
			<PopoverPrimitive.Anchor asChild>{children}</PopoverPrimitive.Anchor>
			<PopoverPrimitive.Portal>
				<PopoverPrimitive.Content
					side="right"
					align="start"
					sideOffset={8}
					collisionPadding={8}
					role="menu"
					aria-label={`${name} actions`}
					data-testid="project-menu"
					className="z-[90] flex w-56 flex-col gap-0.5 border p-1"
					style={{
						background: "var(--mfw-bg-raised)",
						borderColor: "var(--mfw-border-strong)",
						borderRadius: "var(--mfw-radius-md)",
						boxShadow: "var(--mfw-shadow-overlay)",
					}}
					onKeyDown={(e) => {
						if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
						const items = Array.from(
							e.currentTarget.querySelectorAll<HTMLElement>(
								'[role="menuitem"]:not(:disabled)',
							),
						);
						const i = items.indexOf(document.activeElement as HTMLElement);
						const next =
							e.key === "ArrowDown"
								? items[(i + 1) % items.length]
								: items[(i - 1 + items.length) % items.length];
						e.preventDefault();
						next?.focus();
					}}
				>
					<div
						className="truncate px-2 py-1"
						style={{
							color: "var(--mfw-fg-faint)",
							fontSize: "var(--mfw-text-2xs)",
						}}
					>
						{name}
					</div>
					<MenuItem icon={Activity} onSelect={go(href.board(name))}>
						Open board
					</MenuItem>
					<MenuItem icon={GitBranch} onSelect={go(href.flow(name))}>
						Open flow
					</MenuItem>
					{brainEnabled ? (
						<MenuItem
							icon={Brain}
							onSelect={go(href.flow(name, { node: nodeRef.brain() }))}
						>
							Open brain
						</MenuItem>
					) : null}
					<MenuItem
						icon={dispatch.playing ? Square : Play}
						disabled={dispatch.pending || !dispatch.data}
						onSelect={() => {
							close();
							dispatch.toggle();
						}}
					>
						{dispatch.playing ? "Stop dispatching" : "Start dispatching"}
					</MenuItem>
					<MenuItem
						icon={Pencil}
						onSelect={() => {
							close();
							onChangeIcon();
						}}
					>
						Change icon&hellip;
					</MenuItem>
					<MenuItem icon={Settings} onSelect={go(href.projectSettings(name))}>
						Project settings
					</MenuItem>
				</PopoverPrimitive.Content>
			</PopoverPrimitive.Portal>
		</PopoverPrimitive.Root>
	);
}

/** Right-click, long-press (touch/pen) and the keyboard's menu key open the menu. */
function useMenuTriggers(open: () => void) {
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const clear = () => {
		if (timer.current) clearTimeout(timer.current);
		timer.current = null;
	};
	useEffect(
		() => () => {
			if (timer.current) clearTimeout(timer.current);
		},
		[],
	);
	return {
		onContextMenu: (e: React.MouseEvent) => {
			e.preventDefault();
			open();
		},
		onPointerDown: (e: React.PointerEvent) => {
			if (e.pointerType === "mouse") return;
			clear();
			timer.current = setTimeout(open, 500);
		},
		onPointerUp: clear,
		onPointerCancel: clear,
		onPointerLeave: clear,
		onKeyDown: (e: React.KeyboardEvent) => {
			if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
				e.preventDefault();
				open();
			}
		},
	};
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

const CHIP_ICON: Record<ChipKey, LucideIcon | null> = {
	needs: Bell,
	progress: Activity,
	ready: Circle,
	blocked: Ban,
	review: Eye,
	sessions: Bot,
	worktrees: GitBranch,
	brain: Brain,
	// The text already carries the currency sign; an icon beside it would double it.
	spend: null,
};

const CHIP_COLOR: Record<RailTone, string> = {
	accent: "var(--mfw-accent)",
	ok: "var(--mfw-ok)",
	warn: "var(--mfw-warn)",
	critical: "var(--mfw-critical)",
	neutral: "var(--mfw-fg-muted)",
};

export function ProjectEntry({
	row,
	appearance,
	active,
	expanded,
	onNavigate,
}: {
	row: RailRow;
	appearance?: ProjectAppearance | null;
	active: boolean;
	expanded: boolean;
	onNavigate: (to: string) => void;
}) {
	const { input, summary } = row;
	const name = input.name;
	const [menuOpen, setMenuOpen] = useState(false);
	const [iconOpen, setIconOpen] = useState(false);
	const dispatch = useProjectDispatch(name);
	const triggers = useMenuTriggers(() => setMenuOpen(true));
	const badge = projectBadge(input);
	const tooltip = projectTooltip(input, summary);
	const to = href.board(name);
	const follow = (e: React.MouseEvent) => {
		// Let the browser handle modified clicks (new tab / new window).
		if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
		e.preventDefault();
		onNavigate(to);
	};
	const brainEnabled =
		input.brain?.enabled === true && input.brain.state !== "off";

	const menuButton = (
		<Tip label="Project actions" side="right">
			<button
				type="button"
				aria-label={`${name} actions`}
				aria-haspopup="menu"
				aria-expanded={menuOpen}
				data-testid="project-menu-button"
				className={cn(
					"mfw-focus inline-flex items-center justify-center border-0 opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 focus-visible:opacity-100",
					expanded ? "size-6 shrink-0" : "absolute right-0 bottom-0 size-4",
				)}
				style={{
					background: expanded ? "transparent" : "var(--mfw-bg-raised)",
					color: "var(--mfw-fg-muted)",
					borderRadius: "var(--mfw-radius-sm)",
				}}
				onClick={() => setMenuOpen((v) => !v)}
			>
				<ChevronDown aria-hidden className="size-3" />
			</button>
		</Tip>
	);

	const highlight = {
		background: active ? "var(--mfw-accent-subtle)" : "transparent",
		boxShadow:
			active && !expanded ? "inset 0 0 0 1.5px var(--mfw-accent)" : undefined,
		borderRadius: "var(--mfw-radius-md)",
		color: active ? "var(--mfw-accent)" : "var(--mfw-fg-muted)",
	} as const;

	if (!expanded) {
		return (
			<>
				<ProjectMenu
					name={name}
					open={menuOpen}
					onOpenChange={setMenuOpen}
					onNavigate={onNavigate}
					brainEnabled={brainEnabled}
					onChangeIcon={() => setIconOpen(true)}
					dispatch={dispatch}
				>
					<div
						data-testid="project-tile"
						data-active={active || undefined}
						className="group/row relative flex size-8 shrink-0 items-center justify-center self-center"
						style={highlight}
					>
						<Tip
							label={`${tooltip}. Right-click or Shift+F10 for actions.`}
							side="right"
						>
							<a
								href={withBase(to)}
								aria-current={active ? "page" : undefined}
								aria-label={tooltip}
								aria-keyshortcuts="Shift+F10"
								className="mfw-focus flex size-8 items-center justify-center no-underline"
								style={{ borderRadius: "var(--mfw-radius-md)" }}
								onClick={follow}
								{...triggers}
							>
								<ProjectAvatar name={name} appearance={appearance} size={26} />
							</a>
						</Tip>
						{badge ? <BadgeView badge={badge} corner /> : null}
						{menuButton}
					</div>
				</ProjectMenu>
				<ProjectDispatchDialog dispatch={dispatch} />
				<ProjectAppearanceDialog
					project={name}
					open={iconOpen}
					onOpenChange={setIconOpen}
				/>
			</>
		);
	}

	const chips = statChips(name, summary, {
		needs: input.needs,
		liveRuns: input.liveRuns,
	});
	const ago = activityAgo(summary);
	const showToggle = dispatch.playing;
	return (
		<>
			<ProjectMenu
				name={name}
				open={menuOpen}
				onOpenChange={setMenuOpen}
				onNavigate={onNavigate}
				brainEnabled={brainEnabled}
				onChangeIcon={() => setIconOpen(true)}
				dispatch={dispatch}
			>
				<div
					data-testid="project-row"
					data-active={active || undefined}
					className="group/row flex min-w-0 flex-col gap-0.5 px-1.5 py-1"
					style={highlight}
				>
					<div className="flex min-w-0 items-center gap-1">
						<Tip label={tooltip} side="right">
							<a
								href={withBase(to)}
								aria-current={active ? "page" : undefined}
								aria-keyshortcuts="Shift+F10"
								className="mfw-focus flex min-w-0 flex-1 items-center gap-2 no-underline"
								style={{
									color: "inherit",
									borderRadius: "var(--mfw-radius-sm)",
								}}
								onClick={follow}
								{...triggers}
							>
								<ProjectAvatar name={name} appearance={appearance} size={22} />
								<span className="min-w-0 flex-1 truncate">{name}</span>
							</a>
						</Tip>
						{badge ? <BadgeView badge={badge} /> : null}
						<Tip label={dispatch.label} side="right">
							<button
								type="button"
								aria-label={dispatch.label}
								aria-pressed={dispatch.playing}
								disabled={dispatch.pending || !dispatch.data}
								data-testid="project-dispatch"
								className={cn(
									"mfw-focus inline-flex size-6 shrink-0 items-center justify-center border-0",
									!showToggle &&
										"opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 focus-visible:opacity-100",
								)}
								style={{
									background: "transparent",
									color: `var(--mfw-${dispatch.playing ? "ok" : "fg-faint"})`,
									borderRadius: "var(--mfw-radius-sm)",
								}}
								onClick={dispatch.toggle}
							>
								{dispatch.playing ? (
									<Square aria-hidden className="size-3.5" />
								) : (
									<Play aria-hidden className="size-3.5" />
								)}
							</button>
						</Tip>
						{menuButton}
					</div>
					<div
						className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 pl-[30px]"
						style={{
							color: "var(--mfw-fg-faint)",
							fontSize: "var(--mfw-text-2xs)",
							minHeight: 14,
						}}
					>
						{chips.length === 0 ? (
							<span data-testid="project-idle">
								{summary ? idleLine(summary) : " "}
							</span>
						) : (
							<>
								{chips.map((c) => {
									const Icon = CHIP_ICON[c.key];
									return (
										<Tip key={c.key} label={c.label} side="right">
											<a
												href={withBase(c.to)}
												aria-label={c.label}
												data-chip={c.key}
												className="mfw-focus mfw-num inline-flex items-center gap-0.5 no-underline"
												style={{ color: CHIP_COLOR[c.tone] }}
												onClick={(e) => {
													if (
														e.metaKey ||
														e.ctrlKey ||
														e.shiftKey ||
														e.button !== 0
													)
														return;
													e.preventDefault();
													onNavigate(c.to);
												}}
											>
												{Icon ? <Icon aria-hidden className="size-3" /> : null}
												{c.text}
											</a>
										</Tip>
									);
								})}
								{ago ? <span>{ago}</span> : null}
							</>
						)}
					</div>
				</div>
			</ProjectMenu>
			<ProjectDispatchDialog dispatch={dispatch} />
			<ProjectAppearanceDialog
				project={name}
				open={iconOpen}
				onOpenChange={setIconOpen}
			/>
		</>
	);
}
