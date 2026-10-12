import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cpu } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import { TipA, TipSpan, TipTd } from "~/components/ui/tooltip";
import { AppLink } from "../../components/AppLink";
import { StateGlyph } from "../../components/agent/StateGlyph";
import { Cost, Duration } from "../../components/Cost";
import { Empty } from "../../components/Empty";
import { ErrorState } from "../../components/ErrorState";
import { Glyph } from "../../components/icons";
import { LoadingRows } from "../../components/Loading";
import { Chip, Page, PageHeader, Panel, Scroller } from "../../components/Page";
import { useNow } from "../../components/RelativeTime";
import { formatCost } from "../../lib/format";
import { useGo } from "../../lib/nav";
import { type RouterOutputs, useTRPC } from "../../lib/trpc";
import { href, withBase } from "../../routes";
import { UsagePanelBody, useUsage } from "../usage/UsageMeters";
import type { SubscriptionView } from "../usage/usageModel";
import {
	budgetMeter,
	budgetScopeLabel,
	chipLook,
	chipPeek,
	chipTarget,
	type Meter,
	slotMeter,
	spendLine,
	unavailableLabel,
} from "./fleetModel";
import { HealthBlock } from "./HealthBlock";
import {
	formatRate,
	sinceFor,
	verdictList,
	WINDOWS,
	type WindowId,
} from "./modelsFormat";

/**
 * FLEET (design §9): where agents run and what they cost. One page for what
 * Models, Resources, RunPod and OpenRouter used to split four ways:
 *
 *  - Hosts: this machine's slots and each SSH host, with the runs on them;
 *  - Harnesses and models: each harness account, its live runs per model,
 *    its holds and budgets;
 *  - Providers: RunPod and OpenRouter, with their operations pages one link
 *    away (`/fleet/runpod`, `/fleet/openrouter`);
 *  - Budgets, and Outcomes (first-pass rate per harness/model/tier).
 *
 * Every occupant chip is a run: it shows the agent's state and opens that
 * run's inspector in its own project's Flow.
 */

type Fleet = RouterOutputs["fleet"]["summary"];
type Chip_ = Fleet["hosts"][number]["occupants"][number];
type BudgetRow = Fleet["budgets"][number];
type Hold = Fleet["accounts"][number]["hold"];

const GROUP_BY = ["harness", "model", "tier"] as const;

export function FleetPage() {
	const trpc = useTRPC();
	const go = useGo();
	const now = useNow();
	// The shell owns the 60 s refresh; this only reads the shared cache.
	const usage = useUsage();
	const summary = useQuery({
		...trpc.fleet.summary.queryOptions(),
		refetchInterval: 15_000,
		staleTime: 5_000,
	});
	const queryClient = useQueryClient();
	// The host-resource coordinator's single-flight probe: a re-check coalesces
	// with any poll already running, so it is safe to offer on this machine.
	const recheck = useMutation(
		trpc.hostResources.refresh.mutationOptions({
			meta: { label: "Re-check host probes" },
			onSettled: () =>
				queryClient.invalidateQueries({
					queryKey: trpc.fleet.summary.queryKey(),
				}),
		}),
	);
	return (
		<Page className="h-full">
			<PageHeader
				title="Fleet"
				meta="Where agents run and what they cost: hosts, harness accounts, providers and budgets, with the runs on each."
				actions={
					<div className="flex flex-wrap gap-2">
						<AppLink to={href.resources()}>Host resources</AppLink>
						<AppLink to={href.runpod()}>RunPod</AppLink>
						<AppLink to={href.openrouter()}>OpenRouter</AppLink>
					</div>
				}
			/>
			<Scroller className="flex flex-col gap-3 p-3">
				{summary.isPending ? <LoadingRows rows={4} /> : null}
				{summary.error ? (
					<ErrorState
						error={summary.error}
						onRetry={() => void summary.refetch()}
					/>
				) : null}
				{summary.data ? (
					<FleetView
						summary={summary.data}
						usage={usage.views}
						now={now}
						onNavigate={(to) => go(to)}
						onRecheck={() => recheck.mutate({})}
						rechecking={recheck.isPending}
					/>
				) : null}
				<OutcomesPanel />
			</Scroller>
		</Page>
	);
}

/** The summary as sections; pure of data fetching, so it renders in tests. */
export function FleetView({
	summary,
	usage = [],
	now,
	onNavigate,
	timeZone,
	onRecheck,
	rechecking,
}: {
	/** Re-run this machine's probes now (single-flight); omit to hide the action. */
	onRecheck?: () => void;
	rechecking?: boolean;
	summary: Fleet;
	/** Subscription usage views (`useUsage`); empty hides the panel's data, not the panel. */
	usage?: readonly SubscriptionView[];
	now: number;
	onNavigate: (to: string) => void;
	timeZone?: string;
}) {
	return (
		<>
			<Panel title="Hosts" pad={false}>
				<ul className="m-0 flex list-none flex-col p-0">
					{summary.hosts.map((h) => (
						<NodeRowShell
							key={h.id}
							testId={`host-${h.id}`}
							title={h.label}
							subtitle={h.kind === "ssh" ? "ssh" : "local"}
							health={h.health}
							onRecheck={h.kind === "local" ? onRecheck : undefined}
							rechecking={rechecking}
							hold={h.hold}
							now={now}
							timeZone={timeZone}
							meter={
								h.capacity !== null ? slotMeter(h.inUse ?? 0, h.capacity) : null
							}
							budgets={h.budgets}
							spend={h.spend}
							occupants={h.occupants}
							onNavigate={onNavigate}
							note={h.schedulable ? null : (h.reason ?? "not schedulable")}
						>
							{h.slots.length > 0 ? (
								<ul className="m-0 flex list-none flex-col gap-1 p-0 pl-4">
									{h.slots.map((s) => (
										<li
											key={s.resourceId}
											data-slot={s.resourceId}
											className="flex flex-wrap items-center gap-2"
										>
											<span className="mfw-num">{s.resourceId}</span>
											<MeterBar
												meter={slotMeter(s.inUse, s.capacity)}
												width={80}
											/>
											{s.holdReason ? (
												<Chip tone="warn">{s.holdReason}</Chip>
											) : null}
											{s.draining ? <Chip>draining</Chip> : null}
											{s.occupants.map((c) => (
												<OccupantChip
													key={c.runId}
													chip={c}
													onNavigate={onNavigate}
												/>
											))}
										</li>
									))}
								</ul>
							) : null}
						</NodeRowShell>
					))}
				</ul>
			</Panel>

			<Panel title="Subscriptions" pad={false}>
				<UsagePanelBody views={usage} />
			</Panel>

			<Panel title="Harnesses & models" pad={false}>
				{summary.accounts.length === 0 ? (
					<p className="m-0 p-3" style={{ color: "var(--mfw-fg-muted)" }}>
						No harness account has live runs, holds or budgets.
					</p>
				) : (
					<ul className="m-0 flex list-none flex-col p-0">
						{summary.accounts.map((a) => (
							<NodeRowShell
								key={a.key}
								testId={`account-${a.key}`}
								title={a.harness}
								subtitle={a.endpoint ? `@${a.endpoint}` : null}
								health={a.health}
								hold={a.hold}
								now={now}
								timeZone={timeZone}
								meter={null}
								budgets={a.budgets}
								spend={a.spend}
								occupants={[]}
								onNavigate={onNavigate}
								note={null}
							>
								{a.models.length > 0 ? (
									<ul className="m-0 flex list-none flex-col gap-1 p-0 pl-4">
										{a.models.map((m) => (
											<li
												key={m.model}
												className="flex flex-wrap items-center gap-2"
											>
												<span className="mfw-num">{m.model}</span>
												<span style={{ color: "var(--mfw-fg-muted)" }}>
													{m.live} live
												</span>
												{m.occupants.map((c) => (
													<OccupantChip
														key={c.runId}
														chip={c}
														onNavigate={onNavigate}
													/>
												))}
											</li>
										))}
									</ul>
								) : null}
							</NodeRowShell>
						))}
					</ul>
				)}
			</Panel>

			<Panel title="Providers" pad={false}>
				<ul className="m-0 flex list-none flex-col p-0">
					{summary.resources.map((r) => (
						<NodeRowShell
							key={r.id}
							testId={`resource-${r.kind}`}
							title={r.label}
							subtitle={null}
							health={r.health}
							hold={r.hold}
							now={now}
							timeZone={timeZone}
							meter={null}
							budgets={r.budgets}
							spend={r.spend}
							occupants={r.occupants}
							onNavigate={onNavigate}
							note={
								r.kind === "runpod"
									? `${r.livePods} live pod${r.livePods === 1 ? "" : "s"}${
											r.hourlyBurn !== null
												? ` · ${formatCost(r.hourlyBurn)}/h`
												: ""
										}${r.balance !== null ? ` · ${formatCost(r.balance)} credit` : ""}`
									: [
											r.remainingCredits !== null
												? `${formatCost(r.remainingCredits)} credit`
												: null,
											r.usageDaily !== null
												? `${formatCost(r.usageDaily)} today`
												: null,
										]
											.filter(Boolean)
											.join(" · ") || null
							}
							detail={
								<AppLink
									to={r.kind === "runpod" ? href.runpod() : href.openrouter()}
								>
									Operations
								</AppLink>
							}
						>
							{r.kind === "runpod" && r.pods.length > 0 ? (
								<ul className="m-0 flex list-none flex-col gap-1 p-0 pl-4">
									{r.pods.map((p) => (
										<li
											key={p.podId}
											className="flex flex-wrap items-center gap-2"
										>
											<span className="mfw-num">{p.name || p.podId}</span>
											<span style={{ color: "var(--mfw-fg-muted)" }}>
												{p.phase}
											</span>
											{p.costPerHr !== null ? <Cost usd={p.costPerHr} /> : null}
										</li>
									))}
								</ul>
							) : null}
						</NodeRowShell>
					))}
				</ul>
			</Panel>

			<Panel title="Budgets" pad={false}>
				{summary.budgets.length === 0 ? (
					<p className="m-0 p-3" style={{ color: "var(--mfw-fg-muted)" }}>
						No budget is configured. Add ceilings in Settings.
					</p>
				) : (
					<ul className="m-0 flex list-none flex-col gap-1 p-3">
						{summary.budgets.map((b) => (
							<BudgetLine
								key={`${b.scope}:${b.project ?? ""}:${b.id}:${b.unit}`}
								budget={b}
								withName
							/>
						))}
					</ul>
				)}
			</Panel>
		</>
	);
}

function NodeRowShell({
	testId,
	title,
	subtitle,
	health,
	onRecheck,
	rechecking,
	hold,
	now,
	timeZone,
	meter,
	budgets,
	spend,
	occupants,
	onNavigate,
	note,
	detail,
	children,
}: {
	testId: string;
	title: string;
	subtitle: string | null;
	health: Fleet["hosts"][number]["health"];
	onRecheck?: () => void;
	rechecking?: boolean;
	hold: Hold;
	now: number;
	timeZone?: string;
	meter: Meter | null;
	budgets: BudgetRow[];
	spend: { usd: number; tokens: number };
	occupants: Chip_[];
	onNavigate: (to: string) => void;
	note: string | null;
	detail?: ReactNode;
	children?: ReactNode;
}) {
	const held = unavailableLabel(hold, now, timeZone);
	return (
		<li
			data-fleet-node={testId}
			className="flex flex-col gap-1 border-b px-3 py-2"
			style={{ borderColor: "var(--mfw-border)" }}
		>
			<div className="flex flex-wrap items-center gap-2">
				<span className="font-medium">{title}</span>
				{subtitle ? (
					<span style={{ color: "var(--mfw-fg-faint)" }}>{subtitle}</span>
				) : null}
				<HealthBlock
					health={health}
					now={now}
					onRecheck={onRecheck}
					rechecking={rechecking}
				/>
				{meter ? <MeterBar meter={meter} width={96} /> : null}
				{held ? (
					<span
						data-unavailable
						style={{ color: "var(--mfw-warn)", fontSize: "var(--mfw-text-xs)" }}
					>
						<Glyph
							name="hourglass"
							className="mr-1 inline size-3 align-[-2px]"
						/>
						{held}
					</span>
				) : null}
				{note ? (
					<span
						style={{
							color: "var(--mfw-fg-muted)",
							fontSize: "var(--mfw-text-xs)",
						}}
					>
						{note}
					</span>
				) : null}
				<span
					className="ml-auto mfw-num"
					style={{
						color: "var(--mfw-fg-muted)",
						fontSize: "var(--mfw-text-xs)",
					}}
				>
					{spendLine(spend)}
				</span>
				{detail}
			</div>
			{occupants.length > 0 ? (
				<div className="flex flex-wrap items-center gap-2">
					{occupants.map((c) => (
						<OccupantChip key={c.runId} chip={c} onNavigate={onNavigate} />
					))}
				</div>
			) : null}
			{children}
			{budgets.length > 0 ? (
				<ul className="m-0 flex list-none flex-col gap-0.5 p-0">
					{budgets.map((b) => (
						<BudgetLine
							key={`${b.scope}:${b.project ?? ""}:${b.id}:${b.unit}`}
							budget={b}
						/>
					))}
				</ul>
			) : null}
		</li>
	);
}

/**
 * One agent on a node: state mark, what it works on, project and model. It
 * opens the run's inspector in its project's Flow (`?node=run:<id>`); a run
 * no project owns (a lease the registries do not know) is plain text.
 */
export function OccupantChip({
	chip,
	onNavigate,
}: {
	chip: Chip_;
	onNavigate: (to: string) => void;
}) {
	const to = chipTarget(chip);
	const look = chipLook(chip);
	const body = (
		<>
			{look ? (
				<StateGlyph look={look} />
			) : (
				<TipSpan aria-hidden tip="state unknown">
					?
				</TipSpan>
			)}
			<span className="mfw-num">
				{chip.taskId ?? chip.label ?? chip.runId.slice(-6)}
			</span>
			{chip.project ? (
				<span style={{ color: "var(--mfw-fg-faint)" }}>{chip.project}</span>
			) : null}
			{chip.model ? (
				<span style={{ color: "var(--mfw-fg-muted)" }}>{chip.model}</span>
			) : null}
			{chip.liveCostUsd != null ? (
				<span className="mfw-num" style={{ color: "var(--mfw-fg-muted)" }}>
					{formatCost(chip.liveCostUsd)}
				</span>
			) : null}
		</>
	);
	const style = {
		fontSize: "var(--mfw-text-xs)",
		borderColor: "var(--mfw-border)",
		borderRadius: "var(--mfw-radius-sm)",
	} as const;
	const className =
		"inline-flex min-h-6 items-center gap-1 border px-1.5 whitespace-nowrap no-underline";
	if (!to) {
		return (
			<TipSpan
				data-run-chip={chip.runId}
				tip={chipPeek(chip)}
				className={className}
				style={style}
			>
				{body}
			</TipSpan>
		);
	}
	return (
		<TipA
			data-run-chip={chip.runId}
			data-target={to}
			href={withBase(to)}
			tip={chipPeek(chip)}
			className={`mfw-focus ${className}`}
			style={style}
			onClick={(e) => {
				if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0)
					return;
				e.preventDefault();
				onNavigate(to);
			}}
		>
			{body}
		</TipA>
	);
}

const TONE_TOKEN = {
	ok: "--mfw-ok",
	warn: "--mfw-warn",
	critical: "--mfw-critical",
} as const;

function MeterBar({ meter, width }: { meter: Meter; width: number }) {
	return (
		<span
			className="inline-flex items-center gap-1.5"
			style={{ fontSize: "var(--mfw-text-xs)" }}
		>
			{/* biome-ignore lint/a11y/useSemanticElements: a styled bar; <meter> cannot take the tone fill */}
			<span
				role="meter"
				aria-valuemin={0}
				aria-valuemax={100}
				aria-valuenow={meter.pct}
				aria-label={meter.label}
				className="inline-block h-1.5 overflow-hidden"
				style={{
					width,
					background: "var(--mfw-bg-subtle)",
					borderRadius: "var(--mfw-radius-sm)",
				}}
			>
				<span
					className="block h-full"
					style={{
						width: `${meter.pct}%`,
						background: `var(${TONE_TOKEN[meter.tone]})`,
					}}
				/>
			</span>
			<span className="mfw-num">{meter.label}</span>
		</span>
	);
}

function BudgetLine({
	budget,
	withName = false,
}: {
	budget: BudgetRow;
	withName?: boolean;
}) {
	const m = budgetMeter(budget);
	return (
		<li
			data-budget={budget.id}
			className="flex flex-wrap items-center gap-2"
			style={{ fontSize: "var(--mfw-text-xs)" }}
		>
			{withName ? <span className="font-medium">{budget.id}</span> : null}
			<MeterBar meter={m} width={120} />
			<span style={{ color: "var(--mfw-fg-faint)" }}>
				{budgetScopeLabel(budget)}
			</span>
			{budget.phase === "exhausted" ? (
				<Chip tone="critical">exhausted</Chip>
			) : budget.phase === "warned" ? (
				<Chip tone="warn">warned</Chip>
			) : null}
		</li>
	);
}

/** First-pass rate per harness / model / tier, the old Models page's table. */
function OutcomesPanel() {
	const trpc = useTRPC();
	const [windowId, setWindowId] = useState<WindowId>("30d");
	const since = useMemo(() => sinceFor(windowId, Date.now()), [windowId]);
	const stats = useQuery({
		...trpc.stats.outcomes.queryOptions({ since, groupBy: [...GROUP_BY] }),
		staleTime: 60_000,
	});
	const groups = stats.data?.groups ?? [];
	return (
		<Panel
			title="Outcomes"
			pad={false}
			actions={
				<div className="flex gap-1">
					{WINDOWS.map((w) => (
						<Button
							key={w.id}
							size="sm"
							variant={w.id === windowId ? "default" : "outline"}
							onClick={() => setWindowId(w.id)}
						>
							{w.label}
						</Button>
					))}
				</div>
			}
		>
			{stats.isPending ? <LoadingRows rows={3} /> : null}
			{stats.error ? (
				<ErrorState error={stats.error} onRetry={() => void stats.refetch()} />
			) : null}
			{stats.data && groups.length === 0 ? (
				<Empty
					icon={Cpu}
					title="No task attempts in this window"
					description="Outcomes are recorded as task runs finish."
				/>
			) : null}
			{groups.length > 0 ? (
				<div className="overflow-x-auto">
					<table className="w-full text-left">
						<thead>
							<tr
								className="border-b"
								style={{
									borderColor: "var(--mfw-border)",
									color: "var(--mfw-fg-muted)",
								}}
							>
								<th className="p-2">Harness</th>
								<th className="p-2">Model</th>
								<th className="p-2">Tier</th>
								<th className="p-2 text-right">Attempts</th>
								<th className="p-2 text-right">First pass</th>
								<th className="p-2 text-right">Merged</th>
								<th className="p-2 text-right">Repairs</th>
								<th className="p-2">Review verdicts</th>
								<th className="p-2 text-right">Cost / merge</th>
								<th className="p-2 text-right">Duration</th>
							</tr>
						</thead>
						<tbody>
							{groups.map((g) => (
								<tr
									key={JSON.stringify(g.key)}
									className="border-b"
									style={{ borderColor: "var(--mfw-border)" }}
								>
									<td className="p-2">{g.key.harness ?? "unknown"}</td>
									<td className="p-2 mfw-num">{g.key.model ?? "—"}</td>
									<td className="p-2">{g.key.tier ?? "—"}</td>
									<td className="p-2 text-right mfw-num">
										{g.attempts}
										{g.open > 0 ? (
											<span style={{ color: "var(--mfw-fg-faint)" }}>
												{" "}
												+{g.open} open
											</span>
										) : null}
									</td>
									<TipTd
										className="p-2 text-right mfw-num"
										tip={`${g.firstPass} of ${g.attempts}`}
									>
										{formatRate(g.firstPassRate)}
									</TipTd>
									<TipTd
										className="p-2 text-right mfw-num"
										tip={`${g.merged} of ${g.attempts}`}
									>
										{formatRate(g.mergeRate)}
									</TipTd>
									<td className="p-2 text-right mfw-num">{g.repairs}</td>
									<td className="p-2">
										<div className="flex flex-wrap gap-1">
											{verdictList(g.verdictMix).map((v) => (
												<Chip key={v.label}>
													{v.label} {v.count}
												</Chip>
											))}
										</div>
									</td>
									<td className="p-2 text-right">
										<Cost usd={g.medianCostPerMerge} />
									</td>
									<td className="p-2 text-right">
										<Duration ms={g.medianDurationMs} />
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			) : null}
		</Panel>
	);
}
