import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pause, Play, RotateCcw, TriangleAlert } from "lucide-react";
import { type ReactNode, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { Button } from "~/components/ui/button";
import { AppLink } from "../../components/AppLink";
import { StateGlyph } from "../../components/agent/StateGlyph";
import { Empty } from "../../components/Empty";
import { ErrorState } from "../../components/ErrorState";
import { LoadingRows } from "../../components/Loading";
import { Chip } from "../../components/Page";
import { RelativeTime } from "../../components/RelativeTime";
import { formatCost, formatDuration, formatTokens } from "../../lib/format";
import { md } from "../../lib/markdown";
import { useTRPC } from "../../lib/trpc";
import { href } from "../../routes";
import {
	applyFilters,
	BRAIN_OFF_HINT,
	type BrainDecision,
	type BrainSessionView,
	type BrainTurn,
	DECISION_FILTERS,
	type DecisionFilter,
	groupByTurn,
	isProposed,
	lineDiff,
	openEscalations,
} from "../brain/brain";
import { wakeLabel } from "../brain/steering";
import { DecisionRow, SHADOW_TITLE } from "./DecisionRow";
import { MessageBrain } from "./MessageBrain";

/**
 * The brain node's inspector (design §7.4). It replaces a separate Decisions
 * screen: the brain's audit trail lives here and in each task's Story. The
 * tabs are the frame's (`INSPECTOR_TABS.brain`); this component is the body.
 *
 * What needs a person comes first on every tab: an open circuit (retry) and
 * the brain's own `notify_human` calls.
 */

const muted = { color: "var(--mfw-fg-muted)" } as const;
const small = { fontSize: "var(--mfw-text-xs)" } as const;

export type BrainTab = "decisions" | "turns" | "plan" | "session";

const PAGE = 50;

export function BrainInspector({
	project,
	tab,
}: {
	project: string;
	tab: BrainTab;
}) {
	const trpc = useTRPC();
	const session = useQuery(trpc.brain.session.queryOptions({ project }));

	if (session.isPending) return <LoadingRows rows={4} />;
	if (session.isError) {
		return (
			<ErrorState
				title="Could not load the brain"
				error={session.error}
				onRetry={() => void session.refetch()}
			/>
		);
	}
	if (!session.data.enabled && !session.data.session) {
		return <BrainOff project={project} />;
	}
	return (
		<div className="flex min-h-0 flex-col" data-testid="brain-inspector">
			<BrainHeader project={project} view={session.data} />
			<MessageBrain project={project} />
			{tab === "decisions" ? <DecisionsTab project={project} /> : null}
			{tab === "turns" ? <TurnsTab project={project} /> : null}
			{tab === "plan" ? <PlanTab project={project} /> : null}
			{tab === "session" ? (
				<SessionTab project={project} view={session.data} />
			) : null}
		</div>
	);
}

/** No brain configured: nothing to inspect, one quiet hint and the way in. */
export function BrainOff({ project }: { project: string }) {
	return (
		<Empty
			title="No brain in this project"
			description={
				<>
					{BRAIN_OFF_HINT}. Until then nothing is dispatched.{" "}
					<AppLink to={href.projectSettings(project)}>Project settings</AppLink>
				</>
			}
		/>
	);
}

type SessionView = BrainSessionView;

function BrainHeader({
	project,
	view,
}: {
	project: string;
	view: SessionView;
}) {
	const trpc = useTRPC();
	const queryClient = useQueryClient();
	const s = view.session;
	const invalidate = () => {
		void queryClient.invalidateQueries(
			trpc.brain.session.queryFilter({ project }),
		);
		void queryClient.invalidateQueries(trpc.brain.states.queryFilter());
		void queryClient.invalidateQueries(trpc.inbox.list.queryFilter());
	};
	const retry = useMutation(
		trpc.brain.resetCircuit.mutationOptions({ onSuccess: invalidate }),
	);
	const pause = useMutation(
		trpc.brain.setPaused.mutationOptions({ onSuccess: invalidate }),
	);
	const decisions = useQuery(
		trpc.brain.decisions.queryOptions({ project, limit: 100 }),
	);
	const rows = decisions.data ?? [];
	const state: "off" | "idle" | "turn" | "paused" | "failed" = !view.enabled
		? "off"
		: !s || s.status === "retired"
			? "idle"
			: s.status;
	const escalations = openEscalations(rows, Date.now());
	const shadow = rows.some(isProposed);

	return (
		<div
			className="flex flex-col gap-2 border-b px-3 py-2"
			style={{ borderColor: "var(--mfw-border)" }}
		>
			<div className="flex flex-wrap items-center gap-2">
				{state !== "off" ? (
					<StateGlyph subject={{ kind: "brain", value: state }} showLabel />
				) : (
					<span style={muted}>{BRAIN_OFF_HINT}</span>
				)}
				{s ? (
					<span style={{ ...muted, ...small }}>
						gen {s.generation} {"·"} {s.harness} {"·"} {s.model} {"·"}{" "}
						{s.turnsLast24h} turns/24h {"·"} {formatCost(s.spendLast24hUsd)}
						{s.lastTurn?.endedAt ? (
							<>
								{" · last turn "}
								<RelativeTime value={s.lastTurn.endedAt} />
							</>
						) : null}
					</span>
				) : null}
				<span className="ml-auto flex items-center gap-1">
					{state === "failed" ? (
						<Button
							size="xs"
							variant="outline"
							disabled={retry.isPending}
							onClick={() => retry.mutate({ project })}
						>
							<RotateCcw aria-hidden /> Retry
						</Button>
					) : null}
					{state === "idle" || state === "turn" ? (
						<Button
							size="xs"
							variant="ghost"
							disabled={pause.isPending}
							onClick={() => pause.mutate({ project, paused: true })}
						>
							<Pause aria-hidden /> Pause
						</Button>
					) : null}
					{state === "paused" ? (
						<Button
							size="xs"
							variant="ghost"
							disabled={pause.isPending}
							onClick={() => pause.mutate({ project, paused: false })}
						>
							<Play aria-hidden /> Resume
						</Button>
					) : null}
				</span>
			</div>

			{state === "failed" && s ? (
				<div
					role="alert"
					data-testid="brain-stuck"
					className="flex items-start gap-2 border p-2"
					style={{
						...small,
						borderColor:
							"color-mix(in oklch, var(--mfw-critical) 40%, transparent)",
						background:
							"color-mix(in oklch, var(--mfw-critical) 8%, transparent)",
						borderRadius: "var(--mfw-radius-sm)",
					}}
				>
					<TriangleAlert
						aria-hidden
						className="mt-0.5 size-3.5 shrink-0"
						style={{ color: "var(--mfw-critical)" }}
					/>
					<span>
						The brain is stuck: {s.consecutiveFailures} failed turns in a row
						{s.lastTurn?.error ? ` (${s.lastTurn.error})` : ""}. The fixed
						pipeline keeps dispatching. Fix the cause and retry.
					</span>
				</div>
			) : null}

			{escalations.length > 0 ? (
				<section
					aria-label="The brain needs you"
					data-testid="brain-escalations"
					className="flex flex-col gap-1 border p-2"
					style={{
						...small,
						borderColor:
							"color-mix(in oklch, var(--mfw-warn) 40%, transparent)",
						background: "color-mix(in oklch, var(--mfw-warn) 8%, transparent)",
						borderRadius: "var(--mfw-radius-sm)",
					}}
				>
					<strong>The brain needs you ({escalations.length})</strong>
					<ul className="m-0 flex list-none flex-col gap-1 p-0">
						{escalations.map(({ decision, escalation }) => (
							<li key={decision.id}>
								<Chip tone="warn">{escalation.kind.replace(/_/g, " ")}</Chip>{" "}
								<strong>{escalation.title}</strong>
								{escalation.body ? (
									<span style={muted}>
										{" "}
										{"—"} {escalation.body}
									</span>
								) : null}
								{escalation.blocking.length > 0 ? (
									<span style={muted}>
										{" "}
										blocks{" "}
										{escalation.blocking.map((id, i) => (
											<span key={id}>
												{i > 0 ? ", " : ""}
												<AppLink to={href.task(project, id)}>{id}</AppLink>
											</span>
										))}
									</span>
								) : null}
							</li>
						))}
					</ul>
				</section>
			) : null}

			{shadow ? (
				<p
					className="m-0"
					style={{ ...muted, ...small }}
					data-testid="shadow-note"
				>
					<Chip tone="info" title={SHADOW_TITLE}>
						shadow: proposed vs pipeline
					</Chip>{" "}
					Proposed decisions are what the brain would have done; the fixed
					pipeline still acts.
				</p>
			) : null}
		</div>
	);
}

function DecisionsTab({ project }: { project: string }) {
	const trpc = useTRPC();
	const [limit, setLimit] = useState(PAGE);
	const [active, setActive] = useState<DecisionFilter[]>([]);
	const decisions = useQuery(
		trpc.brain.decisions.queryOptions({ project, limit }),
	);
	const turns = useQuery(
		trpc.brain.turns.queryOptions({ project, limit: 100 }),
	);

	if (decisions.isPending) return <LoadingRows rows={5} />;
	if (decisions.isError) {
		return (
			<ErrorState
				error={decisions.error}
				onRetry={() => void decisions.refetch()}
			/>
		);
	}
	const rows = decisions.data;
	const shown = applyFilters(rows, active);
	const groups = groupByTurn(shown, turns.data ?? []);
	const toggle = (f: DecisionFilter) =>
		setActive((cur) =>
			cur.includes(f) ? cur.filter((x) => x !== f) : [...cur, f],
		);

	return (
		<div className="flex min-h-0 flex-col">
			<div
				className="flex flex-wrap items-center gap-1 border-b px-3 py-1.5"
				style={{ borderColor: "var(--mfw-border)", ...small }}
			>
				<span style={muted}>filter</span>
				{DECISION_FILTERS.map((f) => {
					const on = active.includes(f.id);
					return (
						<button
							key={f.id}
							type="button"
							aria-pressed={on}
							onClick={() => toggle(f.id)}
							className="mfw-focus border px-1.5"
							style={{
								borderRadius: "var(--mfw-radius-sm)",
								borderColor: on ? "var(--mfw-accent)" : "var(--mfw-border)",
								color: on ? "var(--mfw-accent)" : "var(--mfw-fg-muted)",
								background: "transparent",
							}}
						>
							{f.label}
						</button>
					);
				})}
			</div>
			{groups.length === 0 ? (
				<Empty
					reason={rows.length > 0 ? "filtered" : "none"}
					title={
						rows.length > 0
							? "No decisions match"
							: "The brain has not decided anything yet"
					}
					description={
						rows.length > 0
							? "Clear a filter to see them."
							: "Decisions appear here as the brain wakes and acts."
					}
				/>
			) : (
				groups.map((g) => (
					<section key={g.turnRunId ?? "no-turn"} aria-label="Turn">
						<TurnHeading project={project} turn={g.turn} runId={g.turnRunId} />
						<ul className="m-0 list-none p-0">
							{g.decisions.map((d) => (
								<DecisionRow key={d.id} decision={d} project={project} />
							))}
						</ul>
					</section>
				))
			)}
			{rows.length >= limit ? (
				<div className="p-2">
					<Button
						size="xs"
						variant="outline"
						onClick={() => setLimit((n) => n + PAGE)}
					>
						Load older
					</Button>
				</div>
			) : null}
		</div>
	);
}

function TurnHeading({
	project,
	turn,
	runId,
}: {
	project: string;
	turn: BrainTurn | null;
	runId: string | null;
}) {
	return (
		<div
			className="flex flex-wrap items-center gap-2 border-b px-3 py-1"
			style={{
				...muted,
				...small,
				borderColor: "var(--mfw-border)",
				background: "var(--mfw-bg-subtle)",
			}}
		>
			{turn ? (
				<>
					<span>turn {turn.seq}</span>
					<span>{wakeLabel(turn.wakeClass)}</span>
					<span>{turn.status}</span>
					{turn.endedAt ? (
						<span>
							{formatDuration(
								turn.endedAt.getTime() - turn.startedAt.getTime(),
							)}
						</span>
					) : null}
				</>
			) : (
				<span>{runId ? `turn ${runId.slice(-6)}` : "outside a turn"}</span>
			)}
			{runId ? (
				<AppLink to={href.board(project, { node: `turn:${runId}` })}>
					digest →
				</AppLink>
			) : null}
		</div>
	);
}

function TurnsTab({ project }: { project: string }) {
	const trpc = useTRPC();
	const turns = useQuery(
		trpc.brain.turns.queryOptions({ project, limit: 100 }),
	);
	if (turns.isPending) return <LoadingRows rows={5} />;
	if (turns.isError) {
		return (
			<ErrorState error={turns.error} onRetry={() => void turns.refetch()} />
		);
	}
	if (turns.data.length === 0) {
		return (
			<Empty
				title="No turns yet"
				description="A turn is one wake of the brain: an event, or the heartbeat."
			/>
		);
	}
	return (
		<ul className="m-0 list-none p-0" data-testid="brain-turns">
			{turns.data.map((t) => {
				const cost = (t.usage as { deltaUsd?: number; costUsd?: number } | null)
					?.deltaUsd;
				return (
					<li
						key={t.runId}
						className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-1.5"
						style={{ borderColor: "var(--mfw-border)", ...small }}
					>
						<span className="mfw-num">#{t.seq}</span>
						<span>{wakeLabel(t.wakeClass)}</span>
						<Chip
							tone={
								t.status === "ok"
									? "ok"
									: t.status === "running"
										? "accent"
										: "critical"
							}
						>
							{t.status}
						</Chip>
						<span style={muted}>
							events {t.eventsFrom}
							{"–"}
							{t.eventsTo}
						</span>
						<span style={muted}>{t.actionsCount} actions</span>
						{t.endedAt ? (
							<span style={muted}>
								{formatDuration(t.endedAt.getTime() - t.startedAt.getTime())}
							</span>
						) : null}
						{typeof cost === "number" ? (
							<span style={muted}>{formatCost(cost)}</span>
						) : null}
						<RelativeTime value={t.startedAt} className="ml-auto" />
						<AppLink to={href.board(project, { node: `turn:${t.runId}` })}>
							digest →
						</AppLink>
						{t.error ? (
							<span
								className="w-full break-words"
								style={{ color: "var(--mfw-critical)" }}
							>
								{t.error}
							</span>
						) : null}
					</li>
				);
			})}
		</ul>
	);
}

function PlanTab({ project }: { project: string }) {
	const trpc = useTRPC();
	const plans = useQuery(
		trpc.brain.decisions.queryOptions({ project, kind: "plan", limit: 2 }),
	);
	const [diff, setDiff] = useState(false);
	if (plans.isPending) return <LoadingRows rows={4} />;
	if (plans.isError) {
		return (
			<ErrorState error={plans.error} onRetry={() => void plans.refetch()} />
		);
	}
	const [latest, previous] = plans.data as (BrainDecision | undefined)[];
	if (!latest) {
		return (
			<Empty
				title="No plan yet"
				description="The plan is the brain's own memory: it writes it with set_plan and reads it back after a rollover."
			/>
		);
	}
	const body = latest.reason ?? "";
	return (
		<div className="flex flex-col gap-2 p-3">
			<div
				className="flex flex-wrap items-center gap-2"
				style={{ ...muted, ...small }}
			>
				<span>decision {latest.id}</span>
				<RelativeTime value={latest.ts} />
				{previous ? (
					<button
						type="button"
						aria-pressed={diff}
						onClick={() => setDiff((v) => !v)}
						className="mfw-focus border-0 bg-transparent p-0 underline"
						style={muted}
					>
						{diff ? "Show plan" : "Show changes since the previous plan"}
					</button>
				) : null}
			</div>
			{diff && previous ? (
				<pre
					data-testid="plan-diff"
					className="m-0 overflow-auto whitespace-pre-wrap"
					style={{ ...small, fontFamily: "var(--mfw-font-mono)" }}
				>
					{lineDiff(previous.reason ?? "", body).map((l, i) => (
						<div
							// biome-ignore lint/suspicious/noArrayIndexKey: a diff has no stable ids
							key={i}
							data-diff={l.kind}
							style={{
								color:
									l.kind === "add"
										? "var(--mfw-ok)"
										: l.kind === "del"
											? "var(--mfw-critical)"
											: "var(--mfw-fg-muted)",
							}}
						>
							{l.kind === "add" ? "+ " : l.kind === "del" ? "- " : "  "}
							{l.text}
						</div>
					))}
				</pre>
			) : (
				<div data-testid="plan-body">
					<ReactMarkdown remarkPlugins={[remarkGfm]} components={md}>
						{body}
					</ReactMarkdown>
				</div>
			)}
		</div>
	);
}

function SessionTab({ project, view }: { project: string; view: SessionView }) {
	const trpc = useTRPC();
	const settings = useQuery(trpc.settings.get.queryOptions({ project }));
	const rollovers = useQuery(
		trpc.brain.decisions.queryOptions({
			project,
			kind: "rollover",
			limit: 10,
		}),
	);
	const s = view.session;
	const cfg = settings.data?.values.brain ?? null;
	return (
		<div className="flex flex-col gap-3 p-3" style={small}>
			{s ? (
				<dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
					<Row label="Harness">
						{s.harness} {"·"} {s.model}
						{s.effort ? ` · ${s.effort}` : ""}
					</Row>
					<Row label="Generation">
						{s.generation}, since <RelativeTime value={s.generationStartedAt} />
					</Row>
					<Row label="Context">
						{formatTokens(s.contextTokens)} tokens
						{cfg?.rolloverTokens
							? ` of ${formatTokens(cfg.rolloverTokens)} before rollover`
							: ""}
					</Row>
					<Row label="Native session">
						<span className="mfw-num break-all">
							{s.nativeSessionId ?? "not started"}
						</span>{" "}
						on {s.nativeHost}
					</Row>
					<Row label="Cursor">event {s.cursor}</Row>
					<Row label="Failures">{s.consecutiveFailures} in a row</Row>
				</dl>
			) : (
				<p className="m-0" style={muted}>
					No session yet: the first wake creates it.
				</p>
			)}
			<div>
				<strong>Routes</strong>
				{cfg ? (
					<ol className="m-0 pl-5">
						{cfg.routes.map((r, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: ordered list, order is identity
							<li key={i}>
								{r.provider}
								{r.model ? ` · ${r.model}` : ""}
								{r.effort ? ` · ${r.effort}` : ""}
							</li>
						))}
					</ol>
				) : (
					<p className="m-0" style={muted}>
						{BRAIN_OFF_HINT}
					</p>
				)}
				<AppLink to={href.projectSettings(project)}>
					Edit in project settings
				</AppLink>
			</div>
			<div>
				<strong>Rollovers</strong>
				{(rollovers.data ?? []).length === 0 ? (
					<p className="m-0" style={muted}>
						None yet.
					</p>
				) : (
					<ul className="m-0 list-none p-0">
						{(rollovers.data ?? []).map((d) => (
							<li key={d.id}>
								<RelativeTime value={d.ts} /> {"·"} {d.reason?.split("\n")[0]}
							</li>
						))}
					</ul>
				)}
			</div>
		</div>
	);
}

function Row({ label, children }: { label: string; children: ReactNode }) {
	return (
		<>
			<dt style={{ color: "var(--mfw-fg-faint)" }}>{label}</dt>
			<dd className="m-0 min-w-0">{children}</dd>
		</>
	);
}
