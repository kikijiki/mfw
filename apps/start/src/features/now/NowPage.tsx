import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, ChevronDown, ChevronUp, Send, Square } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { AppLink } from "../../components/AppLink";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Mono } from "../../components/Cost";
import { Empty } from "../../components/Empty";
import { ErrorState, StaleWhenOffline } from "../../components/ErrorState";
import { LoadingCards } from "../../components/Loading";
import { Chip, Page, PageHeader, Panel, Scroller } from "../../components/Page";
import { Elapsed } from "../../components/RelativeTime";
import { StatusPill } from "../../components/StatusPill";
import { useToast } from "../../lib/toast";
import type { RouterOutputs } from "../../lib/trpc";
import { useTRPC } from "../../lib/trpc";
import { href } from "../../routes";
import { TranscriptTail } from "../transcript/TranscriptTail";

/**
 * NOW: what the fleet is doing right this second, across every
 * project, with the two controls that matter (steer, stop) on the card itself.
 *
 * v1 had no cross-project view at all: you picked a project and hoped the other
 * one was fine.
 */

type ActiveRun = RouterOutputs["runs"]["active"][number];

export function NowPage({
	selectedRunId,
	onSelect,
}: {
	selectedRunId?: string;
	onSelect: (runId: string | null) => void;
}) {
	const trpc = useTRPC();
	const active = useQuery(trpc.runs.active.queryOptions());
	const health = useQuery(trpc.system.health.queryOptions());

	const runs = active.data ?? [];

	return (
		<Page className="h-full">
			<PageHeader
				title="Now"
				meta={
					<>
						<span>
							<StaleWhenOffline>
								{runs.length === 0
									? "nothing running"
									: `${runs.length} run${runs.length === 1 ? "" : "s"} in flight`}
							</StaleWhenOffline>
						</span>
						{health.data ? (
							<span>
								{health.data.projects.length} project
								{health.data.projects.length === 1 ? "" : "s"} attached
							</span>
						) : null}
					</>
				}
			/>

			<Scroller className="flex flex-col gap-3 p-3">
				<ProjectStrip
					projects={health.data?.projects ?? []}
					error={health.error}
					onRetry={() => void health.refetch()}
				/>

				{active.isLoading ? (
					<LoadingCards cards={2} className="md:grid-cols-2" />
				) : active.error ? (
					<ErrorState
						title="Could not load active runs"
						error={active.error}
						onRetry={() => void active.refetch()}
					/>
				) : runs.length === 0 ? (
					<Empty
						icon={Activity}
						title="Nothing is running."
						description={
							<>
								No agent is working right now. Anything ready to dispatch is
								listed above, per project.
							</>
						}
					/>
				) : (
					<div className="grid gap-3 xl:grid-cols-2">
						{runs.map((run) => (
							<RunCard
								key={run.runId}
								run={run}
								selected={run.runId === selectedRunId}
								onToggle={() =>
									onSelect(run.runId === selectedRunId ? null : run.runId)
								}
							/>
						))}
					</div>
				)}
			</Scroller>
		</Page>
	);
}

/** Per-project one-liner: how much is running, how much is waiting. */
function ProjectStrip({
	projects,
	error,
	onRetry,
}: {
	projects: RouterOutputs["system"]["health"]["projects"];
	error: unknown;
	onRetry: () => void;
}) {
	if (error) {
		return (
			<ErrorState
				title="Could not load project health"
				error={error}
				onRetry={onRetry}
			/>
		);
	}
	if (projects.length === 0) return null;

	return (
		<div className="flex flex-wrap gap-2">
			{projects.map((p) => {
				const ready = p.tasks.byStatus.ready ?? 0;
				const review = p.tasks.byStatus.review ?? 0;
				return (
					<div
						key={p.project}
						className="flex items-center gap-2 border px-2 py-1"
						style={{
							borderColor: "var(--mfw-border)",
							borderRadius: "var(--mfw-radius-md)",
							background: "var(--mfw-bg-subtle)",
						}}
					>
						<AppLink to={href.board(p.project)} className="font-medium">
							{p.project}
						</AppLink>
						<span style={{ color: "var(--mfw-fg-muted)" }}>
							<StaleWhenOffline>{p.runs.active} active</StaleWhenOffline>
						</span>
						{ready > 0 ? (
							<AppLink to={href.board(p.project)}>
								<Chip tone="info">{ready} ready</Chip>
							</AppLink>
						) : null}
						{review > 0 ? (
							<AppLink to={href.review(p.project)}>
								<Chip tone="accent">{review} to review</Chip>
							</AppLink>
						) : null}
						{p.mergeQueue.parked > 0 ? (
							<Chip tone="critical">{p.mergeQueue.parked} merge parked</Chip>
						) : null}
					</div>
				);
			})}
		</div>
	);
}

function RunCard({
	run,
	selected,
	onToggle,
}: {
	run: ActiveRun;
	selected: boolean;
	onToggle: () => void;
}) {
	const trpc = useTRPC();
	const queryClient = useQueryClient();
	const { toast } = useToast();
	const [steerOpen, setSteerOpen] = useState(false);
	const [steerText, setSteerText] = useState("");
	const [confirmStop, setConfirmStop] = useState(false);

	const stop = useMutation(
		trpc.runs.stop.mutationOptions({
			meta: { label: "Stop run" },
			onMutate: async () => {
				// Optimistic: the card must stop claiming the agent is working the
				// instant the operator asks it to stop. `ended` is the real state the
				// daemon moves through on its way to finalizing.
				const filter = trpc.runs.active.queryFilter();
				await queryClient.cancelQueries(filter);
				const previous = queryClient.getQueryData(trpc.runs.active.queryKey());
				queryClient.setQueryData(trpc.runs.active.queryKey(), (rows) =>
					rows?.map((r) =>
						r.runId === run.runId ? { ...r, state: "ended" as const } : r,
					),
				);
				return { previous };
			},
			onError: (_err, _vars, ctx) => {
				if (ctx?.previous)
					queryClient.setQueryData(trpc.runs.active.queryKey(), ctx.previous);
			},
			onSuccess: () => {
				setConfirmStop(false);
				toast({ tone: "success", title: `Stopping ${run.label}` });
			},
			onSettled: () => {
				void queryClient.invalidateQueries(trpc.runs.active.queryFilter());
			},
		}),
	);

	const steer = useMutation(
		trpc.runs.steer.mutationOptions({
			meta: { label: "Steer" },
			onSuccess: () => {
				setSteerText("");
				setSteerOpen(false);
				toast({
					tone: "success",
					title: "Steer delivered",
					description: "The agent will see it on its next turn.",
				});
			},
		}),
	);

	const stopping = stop.isPending || run.state === "ended";
	const providerActive = run.state === "running";
	const steerable = providerActive && run.steerable;

	return (
		<Panel
			pad={false}
			className="overflow-hidden"
			style={{ background: "var(--mfw-bg-raised)" }}
		>
			<div className="flex flex-col gap-2 p-3">
				<div className="flex min-w-0 flex-wrap items-center gap-2">
					<Chip>{run.project}</Chip>
					<StatusPill kind="run" value={run.state} />
					{run.taskId ? (
						<AppLink to={href.task(run.project, run.taskId)}>
							<Mono value={run.taskId} />
						</AppLink>
					) : null}
					<AppLink
						to={href.run(run.project, run.runId)}
						className="min-w-0 truncate font-medium"
					>
						{run.taskTitle ??
							(run.taskId && run.label === run.taskId
								? run.runId.slice(-8)
								: run.label)}
					</AppLink>
					<span className="flex-1" />
					<Chip>{run.kind}</Chip>
				</div>

				<div
					className="flex flex-wrap items-center gap-x-3 gap-y-1"
					style={{
						color: "var(--mfw-fg-muted)",
						fontSize: "var(--mfw-text-xs)",
					}}
				>
					{run.providerId ? <Chip>{run.providerId}</Chip> : null}
					<span>{run.model}</span>
					{run.reasoningEffort ? (
						<span>{run.reasoningEffort} effort</span>
					) : null}
					<span>attempt {run.attempt}</span>
					<StaleWhenOffline>
						<span className="inline-flex items-center gap-1">
							elapsed <Elapsed since={run.startedAt} />
						</span>
					</StaleWhenOffline>
					<Mono value={run.runId} truncate={8} />
					{run.capabilities.verified ? (
						<Chip tone="ok">verified harness</Chip>
					) : null}
					{providerActive && run.capabilities.interrupt ? (
						<span>graceful stop</span>
					) : null}
					{run.capabilities.approvals ? <span>approvals</span> : null}
					{run.capabilities.mcp ? <span>MCP</span> : null}
				</div>

				<div className="flex flex-wrap items-center gap-2">
					<Button size="sm" variant="outline" onClick={onToggle}>
						{selected ? <ChevronUp aria-hidden /> : <ChevronDown aria-hidden />}
						{selected ? "Hide output" : "Show output"}
					</Button>
					<Button size="sm" variant="ghost" asChild>
						<AppLink to={href.run(run.project, run.runId)}>
							Open transcript
						</AppLink>
					</Button>
					<span className="flex-1" />
					{steerable ? (
						<Button
							size="sm"
							variant="outline"
							aria-expanded={steerOpen}
							onClick={() => setSteerOpen((v) => !v)}
						>
							<Send aria-hidden />
							Steer
						</Button>
					) : null}
					{providerActive ? (
						<Button
							size="sm"
							variant="destructive"
							disabled={stopping}
							onClick={() => setConfirmStop(true)}
						>
							<Square aria-hidden />
							{stopping ? "Stopping…" : "Stop"}
						</Button>
					) : null}
				</div>

				{steerOpen && steerable ? (
					<form
						className="flex items-center gap-2"
						onSubmit={(e) => {
							e.preventDefault();
							const message = steerText.trim();
							if (!message) return;
							steer.mutate({
								project: run.project,
								runId: run.runId,
								message,
							});
						}}
					>
						<Input
							autoFocus
							value={steerText}
							placeholder="Tell the agent…"
							onChange={(e) => setSteerText(e.target.value)}
							aria-label={`Steer ${run.label}`}
						/>
						<Button
							type="submit"
							size="sm"
							disabled={steer.isPending || steerText.trim().length === 0}
						>
							{steer.isPending ? "Sending…" : "Send"}
						</Button>
					</form>
				) : null}

				{selected ? (
					<TranscriptTail
						project={run.project}
						runId={run.runId}
						runState={run.state}
					/>
				) : null}
			</div>

			<ConfirmDialog
				open={confirmStop}
				onOpenChange={setConfirmStop}
				title={`Stop ${run.label}?`}
				description={
					<>
						{run.capabilities.interrupt
							? "The harness is asked to interrupt the active turn cleanly. If it does not acknowledge, mfw stops the process. "
							: "The agent process is stopped. "}
						Work already committed on <Mono value={run.runId} truncate={8} /> is
						kept and the run is finalized as interrupted; nothing is merged.
					</>
				}
				confirmLabel="Stop run"
				pending={stop.isPending}
				onConfirm={() =>
					stop.mutate({ project: run.project, runId: run.runId })
				}
			/>
		</Panel>
	);
}
