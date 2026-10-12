import type { UsageSubscription } from "@mfw/daemon/usage-monitor";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { OctagonAlert, TriangleAlert } from "lucide-react";
import { useEffect } from "react";
import { TipA, TipDiv } from "~/components/ui/tooltip";
import { harnessMonogram } from "../../components/agent/look";
import { useNow } from "../../components/RelativeTime";
import { useTRPC, useTRPCClient } from "../../lib/trpc";
import { cn } from "../../lib/utils";
import { href, withBase } from "../../routes";
import {
	type MeterView,
	SEVERITY_TOKEN,
	SEVERITY_WORD,
	type SubscriptionView,
	subscriptionOf,
	subscriptionSeverity,
} from "./usageModel";

/**
 * Subscription usage meters (Claude Code 5h / 7d, Codex windows, ...).
 *
 * Data: ONE shared query, `usage.subscriptions`, refetched every 60 s by
 * `useUsageFeed()` (mounted once, by the shell), plus the `usage.changes`
 * subscription, which invalidates it the moment the daemon sees a change.
 * Every surface below only reads the cache through `useUsage()`.
 */

export const USAGE_REFETCH_MS = 60_000;

/** Mount ONCE (the shell): the 60 s refetch and the change subscription. */
export function useUsageFeed(): void {
	const trpc = useTRPC();
	const client = useTRPCClient();
	const queryClient = useQueryClient();
	useQuery({
		...trpc.usage.subscriptions.queryOptions(),
		refetchInterval: USAGE_REFETCH_MS,
		staleTime: 30_000,
	});
	useEffect(() => {
		const sub = client.usage.changes.subscribe(undefined, {
			onData: (frame) => {
				if (frame.kind === "usage")
					void queryClient.invalidateQueries(
						trpc.usage.subscriptions.queryFilter(),
					);
			},
			// A dropped stream is fine: the 60 s refetch still runs.
			onError: () => {},
		});
		return () => sub.unsubscribe();
	}, [client, queryClient, trpc]);
}

/** Read the shared cache; no interval of its own. */
export function useUsage(): {
	views: SubscriptionView[];
	isLoading: boolean;
	isError: boolean;
} {
	const trpc = useTRPC();
	const q = useQuery({
		...trpc.usage.subscriptions.queryOptions(),
		staleTime: 30_000,
	});
	const now = useNow();
	const views = viewsOf(q.data?.subscriptions ?? [], now);
	return { views, isLoading: q.isLoading, isError: q.isError };
}

export function viewsOf(
	subs: readonly UsageSubscription[],
	now: number,
): SubscriptionView[] {
	return subs.map((s) => subscriptionOf(s, now));
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function SeverityGlyph({ severity }: { severity: MeterView["severity"] }) {
	if (severity === "critical")
		return <OctagonAlert aria-hidden className="size-3 shrink-0" />;
	if (severity === "warn")
		return <TriangleAlert aria-hidden className="size-3 shrink-0" />;
	return null;
}

/** One thin labelled meter: label, bar, percent; the reset time inline when it matters. */
export function Meter({
	meter,
	name,
}: {
	meter: MeterView;
	/** The subscription's name, for the accessible label. */
	name: string;
}) {
	const color = `var(${SEVERITY_TOKEN[meter.severity]})`;
	const showReset = meter.severity !== "ok" && meter.reset !== null;
	return (
		<TipDiv
			data-testid="usage-meter"
			data-severity={meter.severity}
			tip={meter.tip}
			tipSide="right"
			style={{ opacity: meter.stale ? 0.65 : 1 }}
		>
			<div className="flex items-center gap-1.5">
				<meter
					className="sr-only"
					min={0}
					max={100}
					value={meter.percent}
					aria-label={`${name} ${meter.text}`}
				>
					{meter.percent}%
				</meter>
				<span
					className="mfw-num min-w-6 shrink-0 whitespace-nowrap"
					style={{
						color: "var(--mfw-fg-muted)",
						fontSize: "var(--mfw-text-2xs)",
					}}
				>
					{meter.label}
				</span>
				<span
					aria-hidden
					className="relative h-1.5 min-w-0 flex-1 overflow-hidden"
					style={{
						background: "var(--mfw-border)",
						borderRadius: "var(--mfw-radius-sm)",
					}}
				>
					<span
						className="absolute inset-y-0 left-0"
						style={{
							width: `${meter.fill}%`,
							background: color,
							// Stale numbers are drawn hatched, not just dimmed.
							backgroundImage: meter.stale
								? "repeating-linear-gradient(45deg, transparent 0 3px, color-mix(in oklch, var(--mfw-bg) 55%, transparent) 3px 5px)"
								: undefined,
						}}
					/>
				</span>
				<span
					className="mfw-num inline-flex shrink-0 items-center justify-end gap-0.5"
					style={{
						color: meter.severity === "ok" ? "var(--mfw-fg)" : color,
						fontSize: "var(--mfw-text-2xs)",
						minWidth: "2.6rem",
					}}
				>
					<SeverityGlyph severity={meter.severity} />
					{meter.percent}%
				</span>
			</div>
			{showReset ? (
				<div
					className="pl-[calc(1.5rem+0.375rem)]"
					style={{
						color: "var(--mfw-fg-faint)",
						fontSize: "var(--mfw-text-2xs)",
					}}
				>
					{SEVERITY_WORD[meter.severity]}, {meter.reset}
				</div>
			) : null}
		</TipDiv>
	);
}

/** One subscription: name (plan), its meters, or an honest "unavailable"/"stale". */
export function SubscriptionRow({ view }: { view: SubscriptionView }) {
	return (
		<div
			data-testid={`usage-${view.provider}`}
			data-status={view.status}
			className="flex flex-col gap-0.5"
		>
			<div
				className="flex items-baseline gap-1 truncate"
				style={{ fontSize: "var(--mfw-text-xs)" }}
			>
				<span
					aria-hidden
					className="mfw-num shrink-0"
					style={{ color: "var(--mfw-fg-faint)" }}
				>
					{harnessMonogram(view.provider)}
				</span>
				<span className="truncate font-medium">{view.name}</span>
				{view.plan ? (
					<span className="truncate" style={{ color: "var(--mfw-fg-faint)" }}>
						{view.plan}
					</span>
				) : null}
			</div>
			{view.meters.map((m) => (
				<Meter key={m.label} meter={m} name={view.name} />
			))}
			{view.note ? (
				<div
					data-testid="usage-note"
					style={{
						color:
							view.status === "unavailable"
								? "var(--mfw-fg-muted)"
								: "var(--mfw-fg-faint)",
						fontSize: "var(--mfw-text-2xs)",
					}}
				>
					{view.note}
				</div>
			) : null}
		</div>
	);
}

/** Pure render of the sidebar block, so tests need no query client. */
export function UsageRail({
	views,
	expanded,
	onNavigate,
}: {
	views: readonly SubscriptionView[];
	expanded: boolean;
	onNavigate: (to: string) => void;
}) {
	if (views.length === 0) return null;
	const go = (e: React.MouseEvent) => {
		if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
		e.preventDefault();
		onNavigate(href.fleet());
	};
	if (!expanded) {
		return (
			<ul
				aria-label="Subscription usage"
				className="m-0 flex list-none flex-col items-center gap-1 p-0"
			>
				{views.map((v) => {
					const sev = subscriptionSeverity(v);
					return (
						<li key={v.provider}>
							<TipA
								href={withBase(href.fleet())}
								onClick={go}
								aria-label={v.summary}
								tip={v.summary}
								tipSide="right"
								data-testid={`usage-compact-${v.provider}`}
								data-severity={sev}
								className="mfw-focus flex w-9 flex-col items-center no-underline"
								style={{
									color:
										sev === "ok"
											? "var(--mfw-fg-muted)"
											: `var(${SEVERITY_TOKEN[sev]})`,
									fontSize: "var(--mfw-text-2xs)",
									lineHeight: 1.2,
								}}
							>
								<span className="mfw-num">{harnessMonogram(v.provider)}</span>
								<span className="mfw-num">
									{v.worst ? `${v.worst.percent}%` : "?"}
								</span>
							</TipA>
						</li>
					);
				})}
			</ul>
		);
	}
	return (
		<section
			aria-label="Subscription usage"
			data-testid="usage-rail"
			className="flex flex-col gap-1.5 px-2 py-1"
		>
			<TipA
				href={withBase(href.fleet())}
				onClick={go}
				tip="Open Fleet"
				tipSide="right"
				className="mfw-focus no-underline"
				style={{
					color: "var(--mfw-fg-faint)",
					fontSize: "var(--mfw-text-2xs)",
					letterSpacing: "0.06em",
					textTransform: "uppercase",
				}}
			>
				Usage
			</TipA>
			<div className="flex flex-col gap-2">
				{views.map((v) => (
					<SubscriptionRow key={v.provider} view={v} />
				))}
			</div>
		</section>
	);
}

/** Connected rail: reads the cache. */
export function UsageSidebarBlock({
	expanded,
	onNavigate,
}: {
	expanded: boolean;
	onNavigate: (to: string) => void;
}) {
	const { views } = useUsage();
	return (
		<UsageRail views={views} expanded={expanded} onNavigate={onNavigate} />
	);
}

/** Pure phone strip: one line per subscription, tap opens Fleet. */
export function UsageStrip({
	views,
	onNavigate,
}: {
	views: readonly SubscriptionView[];
	onNavigate: (to: string) => void;
}) {
	if (views.length === 0) return null;
	return (
		<a
			href={withBase(href.fleet())}
			data-testid="usage-strip"
			aria-label={`Subscription usage: ${views.map((v) => v.summary).join("; ")}`}
			onClick={(e) => {
				if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
				e.preventDefault();
				onNavigate(href.fleet());
			}}
			className={cn(
				"mfw-focus flex min-h-9 flex-wrap items-center gap-x-3 gap-y-0.5 border-b px-2 py-1 no-underline md:hidden",
			)}
			style={{
				borderColor: "var(--mfw-border)",
				background: "var(--mfw-bg-subtle)",
				color: "var(--mfw-fg-muted)",
				fontSize: "var(--mfw-text-2xs)",
			}}
		>
			{views.map((v) => (
				<span key={v.provider} className="inline-flex items-center gap-1.5">
					<span className="font-medium">{v.name}</span>
					{v.meters.length === 0 ? (
						<span>
							{v.status === "unavailable" ? "unavailable" : "no data"}
						</span>
					) : (
						v.meters.map((m) => (
							<span
								key={m.label}
								className="mfw-num inline-flex items-center gap-0.5"
								data-severity={m.severity}
								style={{
									color:
										m.severity === "ok"
											? undefined
											: `var(${SEVERITY_TOKEN[m.severity]})`,
								}}
							>
								<SeverityGlyph severity={m.severity} />
								{m.label} {m.percent}%{m.stale ? " (stale)" : ""}
							</span>
						))
					)}
				</span>
			))}
		</a>
	);
}

export function UsageStripBlock({
	onNavigate,
}: {
	onNavigate: (to: string) => void;
}) {
	const { views } = useUsage();
	return <UsageStrip views={views} onNavigate={onNavigate} />;
}

/** The Fleet page's subscriptions list (same data, full size). */
export function UsagePanelBody({
	views,
}: {
	views: readonly SubscriptionView[];
}) {
	if (views.length === 0)
		return (
			<p className="m-0 p-3" style={{ color: "var(--mfw-fg-muted)" }}>
				No subscription with readable usage was found (not installed, not signed
				in, or usage reading is switched off).
			</p>
		);
	return (
		<div
			data-testid="usage-panel"
			className="grid gap-4 p-3 sm:grid-cols-2 lg:grid-cols-3"
		>
			{views.map((v) => (
				<SubscriptionRow key={v.provider} view={v} />
			))}
		</div>
	);
}
