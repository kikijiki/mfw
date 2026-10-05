import type { InboxItem, InboxSeverity } from "@mfw/daemon/inbox";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	CircleCheck,
	CircleX,
	Eye,
	FileStack,
	ListPlus,
	type LucideIcon,
	MessageCircleQuestion,
	OctagonAlert,
	PauseCircle,
	PenLine,
	ShieldAlert,
	Wrench,
	X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import { AppLink } from "../../components/AppLink";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Empty } from "../../components/Empty";
import { ErrorState } from "../../components/ErrorState";
import { LoadingRows } from "../../components/Loading";
import { Chip, Page, PageHeader, Scroller } from "../../components/Page";
import { RelativeTime } from "../../components/RelativeTime";
import { useKeyBindings } from "../../lib/keyboard";
import { useGo } from "../../lib/nav";
import { useToast } from "../../lib/toast";
import { useTRPC } from "../../lib/trpc";
import { href } from "../../routes";
import { ClarifyDialog } from "../clarify/ClarifyDialog";
import { useInbox } from "./useInbox";

/**
 * Inbox: the one queue an operator checks. The list is the server's derivation
 * (`inbox.list`), shared with the shell badge so they cannot disagree.
 *
 * Renders both `/inbox` (cross-project) and `/p/$project/inbox` (same component
 * with `project` set; `useInbox` filters), so an item has the same id and
 * dismissal in both.
 */

const KIND_ICON: Record<InboxItem["kind"], LucideIcon> = {
	main_red: OctagonAlert,
	merge_parked: OctagonAlert,
	clarify: MessageCircleQuestion,
	review: Eye,
	blocked: PauseCircle,
	trigger_disarmed: ShieldAlert,
	// The trigger's own action failed (vs `trigger_disarmed`: the guard tripped).
	trigger_failed: CircleX,
	failed_run: CircleX,
	sweep_infra: Wrench,
	verify_infra: Wrench,
	// A captured one-liner still owed an expansion pass.
	draft_failed: PenLine,
	admission: ShieldAlert,
	// Two unordered tasks declare overlapping `owns`.
	ownership_conflict: FileStack,
	// Work a run discovered and parked in backlog.
	followups: ListPlus,
};

const SEVERITY_ORDER: InboxSeverity[] = ["critical", "attention", "info"];

const SEVERITY_HEADING: Record<InboxSeverity, string> = {
	critical: "Needs a decision",
	attention: "Waiting for you",
	info: "For information",
};

const SEVERITY_TOKEN: Record<InboxSeverity, string> = {
	critical: "--mfw-critical",
	attention: "--mfw-warn",
	info: "--mfw-neutral",
};

/** Where Enter goes for an item. Clarify returns null: it opens the answer dialog in place (`onAnswer`). */
function primaryTarget(item: InboxItem, projectInbox: boolean): string | null {
	switch (item.kind) {
		case "review":
			return item.taskId
				? href.reviewTask(
						item.project,
						item.taskId,
						projectInbox ? "project-inbox" : "inbox",
					)
				: null;
		case "blocked":
			return item.taskId ? href.task(item.project, item.taskId) : null;
		case "admission":
			if (item.runId) return href.run(item.project, item.runId);
			return item.taskId ? href.task(item.project, item.taskId) : null;
		case "main_red":
			return item.taskId
				? href.task(item.project, item.taskId)
				: href.board(item.project);
		case "clarify":
			return null;
		// Triggers carry neither task nor run, only a definition id; link to the Triggers screen row.
		case "trigger_disarmed":
		case "trigger_failed":
			return item.defId ? href.triggers(item.project, item.defId) : null;
		// Not about one task; the board is the closest place to investigate.
		case "sweep_infra":
			return href.board(item.project);
		// Unlike `sweep_infra`, about a specific task (its verification crashed).
		case "verify_infra":
			return item.taskId
				? href.task(item.project, item.taskId)
				: href.board(item.project);
		case "failed_run":
		case "merge_parked":
			if (item.runId) return href.run(item.project, item.runId);
			return item.taskId ? href.task(item.project, item.taskId) : null;
		// The draft card, to expand by hand or see what was typed.
		case "draft_failed":
			return item.taskId ? href.task(item.project, item.taskId) : null;
		// The first task of the pair; its owns is where the overlap is edited.
		case "ownership_conflict":
			return item.taskId
				? href.task(item.project, item.taskId)
				: href.board(item.project);
		// The follow-ups sit in the board's backlog, where they are triaged.
		case "followups":
			return href.board(item.project);
	}
}

export function InboxPage({ project }: { project?: string } = {}) {
	const trpc = useTRPC();
	const queryClient = useQueryClient();
	const go = useGo();
	// The list is the server's derivation. `clarify.open` is joined by runId only
	// to show the actual question; it never adds or removes rows.
	const { query: inbox, items, counts } = useInbox(project);
	const clarify = useQuery(trpc.clarify.open.queryOptions());
	const [focus, setFocus] = useState(0);
	const [answering, setAnswering] = useState<{
		project: string;
		runId: string;
	} | null>(null);
	const rowRefs = useRef<(HTMLLIElement | null)[]>([]);

	const firstOpenQuestion = useMemo(() => {
		const map = new Map<string, string>();
		for (const set of clarify.data ?? []) {
			const next = set.items.find((i) => i.answer === null);
			if (next) map.set(`${set.project}:${set.runId}`, next.question);
		}
		return map;
	}, [clarify.data]);

	const dismiss = useMutation(
		trpc.inbox.dismiss.mutationOptions({
			meta: { label: "Dismiss" },
			onMutate: async (vars) => {
				const filter = trpc.inbox.list.queryFilter();
				await queryClient.cancelQueries(filter);
				const previous = queryClient.getQueryData(trpc.inbox.list.queryKey());
				queryClient.setQueryData(trpc.inbox.list.queryKey(), (data) => {
					if (!data) return data;
					const gone = data.items.find((i) => i.id === vars.itemId);
					if (!gone) return data;
					return {
						items: data.items.filter((i) => i.id !== vars.itemId),
						counts: {
							total: data.counts.total - 1,
							critical:
								data.counts.critical - (gone.severity === "critical" ? 1 : 0),
							attention:
								data.counts.attention - (gone.severity === "attention" ? 1 : 0),
						},
					};
				});
				return { previous };
			},
			onError: (_err, _vars, ctx) => {
				if (ctx?.previous)
					queryClient.setQueryData(trpc.inbox.list.queryKey(), ctx.previous);
			},
			onSettled: () => {
				void queryClient.invalidateQueries(trpc.inbox.list.queryFilter());
			},
		}),
	);

	// `merge_parked` actions. `retry` needs no confirmation (a repeat conflict
	// just parks again); `abandon` and `sendToReady` discard the branch, so confirm.
	const { toast } = useToast();
	const [confirmingMerge, setConfirmingMerge] = useState<{
		item: InboxItem;
		action: "abandon" | "sendToReady";
	} | null>(null);

	const retryMerge = useMutation(
		trpc.review.mergeJob.retry.mutationOptions({
			meta: { label: "Retry merge" },
			onSuccess: () => {
				toast({
					tone: "success",
					title: "Retrying the merge",
					description: "Back in the queue. A repeat conflict parks it again.",
				});
			},
			onSettled: () => {
				void queryClient.invalidateQueries(trpc.inbox.list.queryFilter());
			},
		}),
	);

	const abandonMerge = useMutation(
		trpc.review.mergeJob.abandon.mutationOptions({
			meta: { label: "Abandon merge" },
			onSuccess: () => {
				setConfirmingMerge(null);
				toast({
					tone: "success",
					title: "Merge job abandoned",
					description:
						"The branch will not merge. The task's own status is unchanged.",
				});
			},
			onSettled: () => {
				void queryClient.invalidateQueries(trpc.inbox.list.queryFilter());
			},
		}),
	);

	const sendMergeToReady = useMutation(
		trpc.review.mergeJob.sendToReady.mutationOptions({
			meta: { label: "Send to ready" },
			onSuccess: () => {
				setConfirmingMerge(null);
				toast({
					tone: "success",
					title: "Sent back to ready",
					description:
						"The branch is abandoned; the task will be re-dispatched from the current tip.",
				});
			},
			onSettled: () => {
				void queryClient.invalidateQueries(trpc.inbox.list.queryFilter());
			},
		}),
	);

	// Keep the focused row in range as items resolve out from under it.
	useEffect(() => {
		setFocus((f) => Math.max(0, Math.min(f, items.length - 1)));
	}, [items.length]);

	const move = useCallback(
		(delta: number) => {
			setFocus((f) => {
				const next = Math.max(0, Math.min(f + delta, items.length - 1));
				rowRefs.current[next]?.scrollIntoView({ block: "nearest" });
				return next;
			});
		},
		[items.length],
	);

	const focused = items[focus];

	useKeyBindings([
		{ key: "j", label: "Next item", group: "Inbox", run: () => move(1) },
		{ key: "k", label: "Previous item", group: "Inbox", run: () => move(-1) },
		{
			key: "Enter",
			label: "Open",
			group: "Inbox",
			enabled: Boolean(focused),
			run: () => {
				if (!focused) return;
				if (focused.kind === "clarify" && focused.runId) {
					setAnswering({ project: focused.project, runId: focused.runId });
					return;
				}
				const to = primaryTarget(focused, Boolean(project));
				if (to) go(to);
			},
		},
		{
			key: "e",
			label: "Dismiss",
			group: "Inbox",
			enabled: Boolean(focused),
			run: () => {
				if (!focused) return;
				dismiss.mutate({ project: focused.project, itemId: focused.id });
			},
		},
	]);

	const grouped = SEVERITY_ORDER.map((severity) => ({
		severity,
		rows: items.filter((i) => i.severity === severity),
	})).filter((g) => g.rows.length > 0);

	let index = -1;

	return (
		<Page className="h-full">
			<PageHeader
				// The project tab strip already says "Inbox".
				title={project ? undefined : "Inbox"}
				meta={
					counts ? (
						<>
							<span>{counts.total} open</span>
							{counts.critical > 0 ? (
								<Chip tone="critical">{counts.critical} critical</Chip>
							) : null}
							<span style={{ color: "var(--mfw-fg-faint)" }}>
								j / k to move · Enter to open · e to dismiss
							</span>
						</>
					) : null
				}
			/>

			<Scroller className="p-3">
				{inbox.isLoading ? (
					<LoadingRows rows={6} />
				) : inbox.error ? (
					<ErrorState
						title="Could not load the inbox"
						error={inbox.error}
						onRetry={() => void inbox.refetch()}
					/>
				) : items.length === 0 ? (
					/* A project inbox must not claim the whole fleet is quiet. */
					project ? (
						<Empty
							icon={CircleCheck}
							tone="success"
							title={`Nothing needs you in ${project}.`}
							action={
								<Button variant="outline" size="sm" asChild>
									<AppLink to={href.inbox()}>See every project</AppLink>
								</Button>
							}
						/>
					) : (
						<Empty
							icon={CircleCheck}
							tone="success"
							title="Nothing needs you."
							action={
								<Button variant="outline" size="sm" asChild>
									<AppLink to={href.history()}>See what happened</AppLink>
								</Button>
							}
						/>
					)
				) : (
					<div className="flex flex-col gap-4">
						{grouped.map((group) => (
							<section key={group.severity}>
								<h2
									className="mb-1 flex items-center gap-2 uppercase"
									style={{
										color: `var(${SEVERITY_TOKEN[group.severity]})`,
										fontSize: "var(--mfw-text-2xs)",
										letterSpacing: "0.06em",
									}}
								>
									{SEVERITY_HEADING[group.severity]}
									<span style={{ color: "var(--mfw-fg-faint)" }}>
										{group.rows.length}
									</span>
								</h2>
								<ul className="flex flex-col gap-1">
									{group.rows.map((item) => {
										index += 1;
										const rowIndex = index;
										const answerRunId =
											item.kind === "clarify" ? item.runId : null;
										return (
											<InboxRow
												key={item.id}
												ref={(node) => {
													rowRefs.current[rowIndex] = node;
												}}
												item={item}
												showProject={!project}
												// Clarify rows only: a plan run that raised questions and
												// failed yields two items with one runId.
												question={
													answerRunId
														? firstOpenQuestion.get(
																`${item.project}:${answerRunId}`,
															)
														: undefined
												}
												focused={rowIndex === focus}
												projectInbox={Boolean(project)}
												onFocus={() => setFocus(rowIndex)}
												onAnswer={
													answerRunId
														? () =>
																setAnswering({
																	project: item.project,
																	runId: answerRunId,
																})
														: undefined
												}
												onDismiss={() =>
													dismiss.mutate({
														project: item.project,
														itemId: item.id,
													})
												}
												onRetryMerge={
													item.kind === "merge_parked" && item.mergeJobId
														? () =>
																retryMerge.mutate({
																	project: item.project,
																	jobId: item.mergeJobId as number,
																})
														: undefined
												}
												onAbandonMerge={
													item.kind === "merge_parked" && item.mergeJobId
														? () =>
																setConfirmingMerge({ item, action: "abandon" })
														: undefined
												}
												onSendMergeToReady={
													item.kind === "merge_parked" && item.mergeJobId
														? () =>
																setConfirmingMerge({
																	item,
																	action: "sendToReady",
																})
														: undefined
												}
											/>
										);
									})}
								</ul>
							</section>
						))}
					</div>
				)}
			</Scroller>

			{answering ? (
				<ClarifyDialog
					project={answering.project}
					runId={answering.runId}
					open
					onOpenChange={(next) => {
						if (!next) setAnswering(null);
					}}
				/>
			) : null}

			<ConfirmDialog
				open={confirmingMerge !== null}
				onOpenChange={(next) => {
					if (!next) setConfirmingMerge(null);
				}}
				pending={
					confirmingMerge?.action === "abandon"
						? abandonMerge.isPending
						: sendMergeToReady.isPending
				}
				title={
					confirmingMerge?.action === "abandon"
						? "Abandon this merge"
						: "Send back to ready"
				}
				confirmLabel={
					confirmingMerge?.action === "abandon" ? "Abandon" : "Send to ready"
				}
				description={
					confirmingMerge?.action === "abandon"
						? "The branch will not merge and this job will not retry. The task's own status is left exactly where it is. This only ends the job."
						: "The branch is discarded and the task goes back to ready, to be re-done from the current tip. The work already on the branch is not recovered from here."
				}
				onConfirm={() => {
					if (!confirmingMerge?.item.mergeJobId) return;
					const vars = {
						project: confirmingMerge.item.project,
						jobId: confirmingMerge.item.mergeJobId,
					};
					if (confirmingMerge.action === "abandon") abandonMerge.mutate(vars);
					else sendMergeToReady.mutate(vars);
				}}
			/>
		</Page>
	);
}

function InboxRow({
	item,
	question,
	showProject,
	projectInbox,
	focused,
	onFocus,
	onAnswer,
	onDismiss,
	onRetryMerge,
	onAbandonMerge,
	onSendMergeToReady,
	ref,
}: {
	item: InboxItem;
	/** First unanswered question, from `clarify.open`. Clarify rows only. */
	question?: string;
	/** False in a project-scoped inbox, where every row shares one project. */
	showProject: boolean;
	/** Return review decisions to this project's inbox, not the fleet inbox. */
	projectInbox: boolean;
	focused: boolean;
	onFocus: () => void;
	/** Set for a clarify row: the row's action is a dialog, not a route. */
	onAnswer?: () => void;
	onDismiss: () => void;
	/** Set for a `merge_parked` row with a job id. */
	onRetryMerge?: () => void;
	onAbandonMerge?: () => void;
	onSendMergeToReady?: () => void;
	ref: (node: HTMLLIElement | null) => void;
}) {
	const Icon = KIND_ICON[item.kind];
	const token = SEVERITY_TOKEN[item.severity];
	const primary = primaryTarget(item, projectInbox);
	// The question itself beats the server's summary.
	const detail = question ?? item.detail;

	return (
		<li
			ref={ref}
			// biome-ignore lint/a11y/noNoninteractiveTabindex: the row IS the focus target of the j/k model
			tabIndex={0}
			onFocus={onFocus}
			onMouseDown={onFocus}
			className={cn(
				"flex min-h-11 flex-col gap-1 border p-2 sm:flex-row sm:items-center sm:gap-3",
			)}
			style={{
				borderColor: focused ? `var(${token})` : "var(--mfw-border)",
				borderRadius: "var(--mfw-radius-md)",
				background: focused ? "var(--mfw-bg-hover)" : "var(--mfw-bg-raised)",
			}}
		>
			<Icon
				aria-hidden
				className="size-4 shrink-0"
				style={{ color: `var(${token})` }}
			/>
			<div className="flex min-w-0 flex-1 flex-col">
				<div className="flex min-w-0 flex-wrap items-center gap-2">
					{showProject ? <Chip>{item.project}</Chip> : null}
					{primary ? (
						<AppLink to={primary} className="min-w-0 truncate font-medium">
							{item.title}
						</AppLink>
					) : onAnswer ? (
						<button
							type="button"
							onClick={onAnswer}
							className="mfw-focus min-w-0 truncate text-left font-medium underline-offset-2 hover:underline"
						>
							{item.title}
						</button>
					) : (
						<span className="min-w-0 truncate font-medium">{item.title}</span>
					)}
				</div>
				{detail ? (
					<span
						className="min-w-0 truncate"
						style={{
							color: "var(--mfw-fg-muted)",
							fontSize: "var(--mfw-text-xs)",
						}}
						title={detail}
					>
						{detail}
					</span>
				) : null}
			</div>

			<span
				className="shrink-0"
				style={{
					color: "var(--mfw-fg-faint)",
					fontSize: "var(--mfw-text-xs)",
				}}
			>
				<RelativeTime value={item.ts} />
			</span>

			<div className="flex shrink-0 flex-wrap items-center gap-1">
				{onAnswer ? (
					<Button size="sm" variant="outline" onClick={onAnswer}>
						Answer
					</Button>
				) : null}
				{item.kind === "review" && item.taskId ? (
					<Button size="sm" variant="outline" asChild>
						<AppLink
							to={href.reviewTask(
								item.project,
								item.taskId,
								projectInbox ? "project-inbox" : "inbox",
							)}
						>
							Open review
						</AppLink>
					</Button>
				) : null}
				{item.taskId && item.kind !== "review" ? (
					<Button size="sm" variant="ghost" asChild>
						<AppLink to={href.task(item.project, item.taskId)}>Task</AppLink>
					</Button>
				) : null}
				{onRetryMerge ? (
					<Button size="sm" variant="outline" onClick={onRetryMerge}>
						Retry
					</Button>
				) : null}
				{onSendMergeToReady ? (
					<Button size="sm" variant="outline" onClick={onSendMergeToReady}>
						Send to ready
					</Button>
				) : null}
				{onAbandonMerge ? (
					<Button size="sm" variant="ghost" onClick={onAbandonMerge}>
						Abandon
					</Button>
				) : null}
				{item.runId ? (
					<Button size="sm" variant="ghost" asChild>
						<AppLink to={href.run(item.project, item.runId)}>Run</AppLink>
					</Button>
				) : null}
				<Button
					size="icon-sm"
					variant="ghost"
					aria-label={`Dismiss: ${item.title}`}
					title="Dismiss (e)"
					onClick={onDismiss}
				>
					<X aria-hidden />
				</Button>
			</div>
		</li>
	);
}
