import { useQuery } from "@tanstack/react-query";
import { Search, TriangleAlert } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { Tip } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { StateGlyph } from "../../components/agent/StateGlyph";
import { Glyph } from "../../components/icons";
import { ShortcutKbd } from "../../components/ShortcutKbd";
import { handleKeyDown, useKeyBindings } from "../../lib/keyboard";
import { nodeRef } from "../../lib/nodeRef";
import { useTRPC } from "../../lib/trpc";
import { href, withBase } from "../../routes";
import { NeedsQueue } from "../home/NeedsQueue";
import { nextNeedTarget } from "../home/needs";
import { ConnectedProjectAvatar } from "../projects/ProjectAvatar";
import {
	type PresenceProject,
	presenceView,
	projectTarget,
	runTarget,
} from "./presence";

/**
 * The presence bar (design §3.1): a 32px strip on every screen with who is
 * working where, and what needs you. It replaces the right-rail agent dock.
 *
 * It reads only `runs.active` and `inbox.list`, both kept fresh by the live
 * channel, so it adds no request of its own and opens no transcript stream.
 * The needs count is the `inbox.list` length, the same number as the Home
 * queue and the tab title.
 *
 * A project chip and a run dot open that project's Flow (`projectTarget`,
 * `runTarget`), the run's inspector docked beside it.
 */
export function PresenceBar({
	onNavigate,
}: {
	onNavigate: (to: string) => void;
}) {
	const trpc = useTRPC();
	const active = useQuery(trpc.runs.active.queryOptions());
	const inbox = useQuery(trpc.inbox.list.queryOptions());
	// One more cache read, kept fresh by the brain.* live events.
	const brains = useQuery({
		...trpc.brain.states.queryOptions(),
		staleTime: 30_000,
	});
	const view = presenceView(active.data, inbox.data?.items, brains.data);
	const [needsOpen, setNeedsOpen] = useState(false);

	useKeyBindings([
		{
			key: "n",
			label: "Next item that needs you",
			group: "Global",
			enabled: view.needs.length > 0,
			run: () => {
				const to = nextNeedTarget(view.needs);
				if (to) onNavigate(to);
			},
		},
	]);

	// Desktop has the same facts in the sidebar (project rows, Home badge) and
	// the header; the strip is a phone element, but stays mounted so the "n"
	// binding above is registered everywhere.
	return (
		<section
			aria-label="Presence"
			className="relative flex h-8 shrink-0 items-center gap-2 border-b px-2 md:hidden"
			style={{
				borderColor: "var(--mfw-border)",
				background: "var(--mfw-bg-subtle)",
				fontSize: "var(--mfw-text-xs)",
			}}
		>
			<button
				type="button"
				className="mfw-focus flex h-6 shrink-0 items-center gap-1.5 border px-2 max-md:hidden"
				style={{
					borderColor: "var(--mfw-border)",
					borderRadius: "var(--mfw-radius-sm)",
					color: "var(--mfw-fg-muted)",
					background: "transparent",
				}}
				onClick={openPalette}
			>
				<Search aria-hidden className="size-3" />
				<span>Jump to task, run…</span>
				<ShortcutKbd keys="mod+k" spaced bordered={false} />
			</button>
			<button
				type="button"
				aria-label="Open command palette"
				className="mfw-focus flex size-8 shrink-0 items-center justify-center border-0 bg-transparent md:hidden"
				style={{ color: "var(--mfw-fg-muted)" }}
				onClick={openPalette}
			>
				<Search aria-hidden className="size-4" />
			</button>

			<ul
				aria-label="Projects with live work"
				className="m-0 flex min-w-0 flex-1 list-none items-center gap-3 overflow-x-auto p-0"
			>
				{view.projects.map((p) => (
					<ProjectChip key={p.project} entry={p} onNavigate={onNavigate} />
				))}
			</ul>

			<NeedsButton
				count={view.needsTotal}
				open={needsOpen}
				onToggle={() => setNeedsOpen((v) => !v)}
				onClose={() => setNeedsOpen(false)}
				onHome={() => onNavigate(href.home())}
			>
				{/* The same queue as Home, answerable here; one inbox.list. */}
				<div className="p-2">
					<NeedsQueue
						items={view.needs}
						runs={active.data}
						empty={false}
						onNavigate={() => setNeedsOpen(false)}
					/>
				</div>
			</NeedsButton>
		</section>
	);

	function openPalette() {
		// The palette owns its open state behind the mod+K binding; press it.
		handleKeyDown(
			new KeyboardEvent("keydown", { key: "k", ctrlKey: true, metaKey: true }),
		);
	}
}

function ProjectChip({
	entry,
	onNavigate,
}: {
	entry: PresenceProject;
	onNavigate: (to: string) => void;
}) {
	const go = (to: string) => (e: React.MouseEvent) => {
		if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
		e.preventDefault();
		onNavigate(to);
	};
	const flow = projectTarget(entry.project);
	return (
		<li className="flex shrink-0 items-center gap-1.5">
			<a
				href={withBase(flow)}
				className="mfw-focus inline-flex items-center gap-1.5 font-medium no-underline"
				onClick={go(flow)}
			>
				<ConnectedProjectAvatar name={entry.project} size={16} />
				{entry.project}
			</a>
			{entry.brain ? (
				<Tip label={entry.brainLine ?? undefined}>
					<a
						href={withBase(href.flow(entry.project, { node: nodeRef.brain() }))}
						aria-label={entry.brainLine ?? undefined}
						data-testid="presence-brain"
						className="mfw-focus inline-flex min-h-6 items-center no-underline"
						onClick={go(href.flow(entry.project, { node: nodeRef.brain() }))}
					>
						<StateGlyph subject={{ kind: "brain", value: entry.brain }} />
					</a>
				</Tip>
			) : null}
			{entry.collapsed ? (
				<Tip label={`${entry.runCount} live runs`}>
					<span
						className="mfw-num"
						role="img"
						aria-label={`${entry.runCount} live runs`}
						style={{ color: "var(--mfw-status-in-progress)" }}
					>
						<Glyph name="dot" className="mr-0.5 inline size-2.5 align-[-1px]" />
						×{entry.runCount}
					</span>
				</Tip>
			) : (
				<span className="flex items-center gap-0.5">
					{entry.dots.map((dot) => {
						const to = runTarget(entry.project, dot.runId);
						return (
							<Tip key={dot.runId} label={dot.peek}>
								<a
									href={withBase(to)}
									aria-label={dot.peek}
									className="mfw-focus inline-flex min-h-6 min-w-4 items-center justify-center no-underline"
									onClick={go(to)}
								>
									<StateGlyph look={dot.look} />
								</a>
							</Tip>
						);
					})}
				</span>
			)}
			{entry.needs > 0 ? (
				<Tip label={`${entry.needs} need you in ${entry.project}`}>
					<span
						className="mfw-num"
						role="img"
						aria-label={`${entry.needs} need you in ${entry.project}`}
						style={{ color: "var(--mfw-warn)" }}
					>
						<TriangleAlert
							aria-hidden
							className="mr-0.5 inline size-3 align-[-2px]"
						/>
						{entry.needs}
					</span>
				</Tip>
			) : null}
		</li>
	);
}

function NeedsButton({
	count,
	open,
	onToggle,
	onClose,
	onHome,
	children,
}: {
	count: number;
	open: boolean;
	onToggle: () => void;
	onClose: () => void;
	onHome: () => void;
	children: ReactNode;
}) {
	const wrapRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!open) return;
		const outside = (event: PointerEvent) => {
			const target = event.target;
			if (target instanceof Node && wrapRef.current?.contains(target)) return;
			// A confirmation raised from a row renders in a portal; it is not "outside".
			if (target instanceof Element && target.closest('[role="dialog"]'))
				return;
			onClose();
		};
		const onEscape = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		document.addEventListener("pointerdown", outside);
		document.addEventListener("keydown", onEscape);
		return () => {
			document.removeEventListener("pointerdown", outside);
			document.removeEventListener("keydown", onEscape);
		};
	}, [open, onClose]);

	return (
		<div ref={wrapRef} className="relative shrink-0">
			<button
				type="button"
				aria-expanded={open}
				aria-haspopup="true"
				disabled={count === 0}
				className={cn(
					"mfw-focus flex h-6 items-center gap-1 border-0 bg-transparent px-1.5",
					count === 0 && "opacity-60",
				)}
				style={{
					color: count > 0 ? "var(--mfw-warn)" : "var(--mfw-fg-muted)",
				}}
				onClick={onToggle}
			>
				<TriangleAlert aria-hidden className="size-3.5" />
				<span className="mfw-num">{count}</span>
				<span className="max-md:hidden">
					{count === 1 ? "needs you" : "need you"}
				</span>
			</button>
			{open && count > 0 ? (
				<div
					role="dialog"
					aria-label="Needs you"
					className="absolute top-full right-0 z-50 mt-1 flex max-h-[60dvh] w-[min(28rem,calc(100vw-1rem))] flex-col overflow-auto border"
					style={{
						background: "var(--mfw-bg-raised)",
						borderColor: "var(--mfw-border)",
						borderRadius: "var(--mfw-radius-md)",
					}}
				>
					{children}
					<button
						type="button"
						className="mfw-focus border-0 border-t bg-transparent px-3 py-1.5 text-left"
						style={{ borderColor: "var(--mfw-border)" }}
						onClick={() => {
							onClose();
							onHome();
						}}
					>
						Open Home
					</button>
				</div>
			) : null}
		</div>
	);
}
