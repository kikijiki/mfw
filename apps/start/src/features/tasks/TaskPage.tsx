import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileDiff, MessageSquare, Play, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import { TipSpan } from "~/components/ui/tooltip";
import { AppLink } from "../../components/AppLink";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ErrorState } from "../../components/ErrorState";
import { LoadingRows } from "../../components/Loading";
import { Chip, Page, PageHeader } from "../../components/Page";
import { RelativeTime } from "../../components/RelativeTime";
import { StatusPill, type TaskStatus } from "../../components/StatusPill";
import { humanizeToken } from "../../lib/format";
import { useGo } from "../../lib/nav";
import { useToast } from "../../lib/toast";
import { useTRPC } from "../../lib/trpc";
import { href } from "../../routes";
import { MessageBrain } from "../inspector/MessageBrain";
import { TaskStory } from "../inspector/TaskStory";
import { ReviewPage } from "../review/ReviewPage";
import { TaskDefinition } from "./TaskDefinition";

export { executionTargetOptions } from "./TaskDefinition";

/**
 * The task inspector's body: the header (move, run, delete) over one of three
 * tabs. Story is the default; Definition is the editor (`TaskDefinition`,
 * kept mounted so an unsaved draft survives a tab switch); Changes is the
 * review page for this task.
 */

export type TaskTab = "story" | "definition" | "changes";

const STATUSES: TaskStatus[] = [
	"draft",
	"backlog",
	"ready",
	"in_progress",
	"blocked",
	"review",
	"done",
	"archived",
];

export function TaskPage({
	project,
	taskId,
	tab = "story",
}: {
	project: string;
	taskId: string;
	tab?: TaskTab;
}) {
	const trpc = useTRPC();
	const queryClient = useQueryClient();
	const go = useGo();
	const { toast } = useToast();

	const taskQuery = useQuery(
		trpc.tasks.get.queryOptions({ project, id: taskId }),
	);
	const allTasks = useQuery(trpc.tasks.list.queryOptions({ project }));
	// Flat boards have no spec.md or attachments directory.
	const schema = useQuery(trpc.board.schema.queryOptions({ project }));
	// Only for the Run button's disabled reason.
	const dispatchStatus = useQuery(
		trpc.system.scheduler.status.queryOptions({ project }),
	);

	const task = taskQuery.data ?? null;
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	const [messaging, setMessaging] = useState(false);
	const [reviewFile, setReviewFile] = useState<string | undefined>();
	const taskLocked =
		task?.claimedByRunId != null || task?.draftPhase === "waiting_for_answers";

	/** Ids that name this task in `dependsOn`. Deleting does not rewrite them, so the confirm dialog lists them. */
	const dependents = useMemo(
		() =>
			(allTasks.data ?? [])
				.filter((t) => t.dependsOn.includes(taskId))
				.map((t) => t.id),
		[allTasks.data, taskId],
	);

	const move = useMutation(
		trpc.tasks.move.mutationOptions({
			meta: { label: "Move task" },
			onSettled: () => {
				void queryClient.invalidateQueries(
					trpc.tasks.get.queryFilter({ project, id: taskId }),
				);
				void queryClient.invalidateQueries(
					trpc.tasks.list.queryFilter({ project }),
				);
			},
		}),
	);

	const start = useMutation(
		trpc.runs.startTask.mutationOptions({
			meta: { label: "Run task" },
			onSuccess: (run) => {
				toast({ tone: "success", title: "Run started" });
				go(href.run(project, run.runId));
			},
		}),
	);

	/** Delete this task. Irreversible as far as the API can promise (no recovery story, unlike `tasks.wipe`), so the dialog says nothing about getting it back. */
	const remove = useMutation(
		trpc.tasks.remove.mutationOptions({
			meta: { label: "Delete task" },
			onSuccess: (result) => {
				setConfirmingDelete(false);
				void queryClient.invalidateQueries(
					trpc.tasks.list.queryFilter({ project }),
				);
				void queryClient.invalidateQueries(
					trpc.tasks.graph.queryFilter({ project }),
				);
				void queryClient.invalidateQueries(trpc.inbox.list.queryFilter());
				toast({
					tone: result.removed ? "success" : "info",
					title: result.removed
						? `${taskId} deleted`
						: `${taskId} was already gone`,
				});
				go(href.board(project));
			},
		}),
	);

	if (taskQuery.isLoading || (taskQuery.error && !task)) {
		return (
			<Page className="h-full">
				<div className="p-3">
					{taskQuery.error ? (
						<ErrorState
							title="Could not load this task"
							error={taskQuery.error}
							onRetry={() => void taskQuery.refetch()}
						/>
					) : (
						<LoadingRows rows={10} />
					)}
				</div>
			</Page>
		);
	}

	if (!task) {
		return (
			<Page className="h-full">
				<div className="p-3">
					<ErrorState
						title="No such task"
						error={`${taskId} does not exist in ${project}.`}
					/>
				</div>
			</Page>
		);
	}

	/**
	 * Why Run can't be pressed, or null. A claim only wins the rename out of
	 * `ready/`, so any other status is not claimable. The master stop blocks it
	 * too (`RunEngine.startTask` checks the same gate as the scheduler).
	 */
	const runDisabledReason =
		task.status !== "ready"
			? `Only tasks in Ready can be started manually: this one is ${humanizeToken(task.status)}.`
			: dispatchStatus.data && !dispatchStatus.data.globalPlaying
				? `mfw is stopped everywhere${dispatchStatus.data.reason ? ` (${dispatchStatus.data.reason})` : ""}, so starting is blocked until it's resumed.`
				: null;

	return (
		<Page className="h-full min-w-0 overflow-hidden">
			<PageHeader
				className="shrink-0"
				title={
					<span className="flex min-w-0 items-center gap-2">
						<StatusPill kind="task" value={task.status} />
						<TipSpan className="min-w-0 truncate" tip={task.title} clipped>
							{task.title}
						</TipSpan>
					</span>
				}
				meta={
					<>
						<Chip tone={task.executionTarget === "local" ? "neutral" : "info"}>
							{task.executionTarget}
						</Chip>
						{task.executionTarget === "runpod" ? (
							<AppLink to={href.runpod()}>RunPod operations</AppLink>
						) : null}
						<span>
							rev {task.contentRev} · {task.attemptCount} attempt
							{task.attemptCount === 1 ? "" : "s"}
						</span>
						<span>
							status changed <RelativeTime value={task.statusChangedAt} />
						</span>
						{task.claimedByRunId ? (
							<AppLink to={href.run(project, task.claimedByRunId)}>
								open the agent's transcript
							</AppLink>
						) : null}
					</>
				}
				actions={
					<>
						<select
							aria-label="Move task"
							className="mfw-focus min-h-8 border px-1.5"
							style={{
								background: "var(--mfw-bg-raised)",
								borderColor: "var(--mfw-border)",
								borderRadius: "var(--mfw-radius-sm)",
								color: "var(--mfw-fg)",
							}}
							value={task.status}
							disabled={taskLocked}
							onChange={(e) =>
								move.mutate({
									project,
									id: taskId,
									to: e.target.value as TaskStatus,
								})
							}
						>
							{STATUSES.filter(
								(status) =>
									status === task.status ||
									(status !== "draft" &&
										status !== "in_progress" &&
										(task.status !== "draft" || status === "archived")),
							).map((status) => (
								<option key={status} value={status}>
									{humanizeToken(status)}
								</option>
							))}
						</select>
						{/* A task in `review` waits on the human, so this is the loud (ok green) control. */}
						{task.status === "review" ? (
							<Button
								size="sm"
								asChild
								style={{
									background: "var(--mfw-ok)",
									color: "var(--mfw-bg)",
									borderColor: "var(--mfw-ok)",
								}}
							>
								<AppLink to={href.reviewTask(project, taskId)}>
									<FileDiff aria-hidden /> Review the diff
								</AppLink>
							</Button>
						) : null}
						{/* Merged work (including "no review" tasks) keeps a read-only diff. */}
						{task.status === "done" ? (
							<Button size="sm" variant="outline" asChild>
								<AppLink to={href.reviewTask(project, taskId)}>
									<FileDiff aria-hidden /> View merged diff
								</AppLink>
							</Button>
						) : null}
						<Button
							size="sm"
							// Demoted in review so it does not compete with "Review the diff".
							variant={task.status === "review" ? "outline" : "default"}
							disabled={start.isPending || runDisabledReason !== null}
							title={runDisabledReason ?? undefined}
							onClick={() => start.mutate({ project, taskId })}
						>
							<Play aria-hidden /> {start.isPending ? "Starting…" : "Run"}
						</Button>
						<Button
							size="icon-sm"
							variant="ghost"
							aria-label={`Message the brain about ${taskId}`}
							aria-expanded={messaging}
							title="Message the brain about this task"
							onClick={() => setMessaging((v) => !v)}
						>
							<MessageSquare aria-hidden />
						</Button>
						<Button
							size="icon-sm"
							variant="ghost"
							aria-label={`Delete ${taskId}`}
							disabled={taskLocked}
							onClick={() => setConfirmingDelete(true)}
						>
							<Trash2 aria-hidden />
						</Button>
					</>
				}
			/>

			{messaging ? (
				<MessageBrain
					project={project}
					about={`task:${taskId}`}
					onSent={() => setMessaging(false)}
				/>
			) : null}

			<ConfirmDialog
				open={confirmingDelete}
				onOpenChange={setConfirmingDelete}
				title="Delete this task"
				confirmText={taskId}
				confirmLabel="Delete task"
				pending={remove.isPending}
				description={
					<>
						Removes <span className="mfw-num">{taskId}</span> from {project}'s
						board. Its runs and their transcripts stay in the run history; the
						task itself does not come back from here.
					</>
				}
				onConfirm={() => remove.mutate({ project, id: taskId })}
			>
				{task.claimedByRunId ? (
					<p style={{ color: "var(--mfw-warn)" }}>
						A run is holding this task. Stop it before deleting the task.
					</p>
				) : null}
				{dependents.length > 0 ? (
					<p style={{ color: "var(--mfw-warn)" }}>
						{dependents.length} task{dependents.length === 1 ? "" : "s"} depend
						on it: {dependents.join(", ")}. That dependency is not rewritten, so
						they will be waiting on an id that no longer exists.
					</p>
				) : null}
			</ConfirmDialog>

			{tab === "story" ? (
				<div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto">
					<TaskStory project={project} taskId={taskId} />
				</div>
			) : null}

			{/* Mounted for every tab so an unsaved draft survives switching away. */}
			<div
				className={
					tab === "definition"
						? "flex min-h-0 min-w-0 flex-1 flex-col"
						: "hidden"
				}
			>
				<TaskDefinition
					project={project}
					taskId={taskId}
					task={task}
					layout={schema.data?.layout ?? null}
				/>
			</div>

			{tab === "changes" ? (
				<div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto">
					<ReviewPage
						embedded
						project={project}
						taskId={taskId}
						selectedFile={reviewFile}
						onSelectFile={setReviewFile}
					/>
				</div>
			) : null}
		</Page>
	);
}
