import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	ArrowLeft,
	Check,
	CircleCheck,
	CircleX,
	FileDiff,
	GitMerge,
	ScrollText,
	ThumbsDown,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "~/components/ui/dialog";
import { Textarea } from "~/components/ui/textarea";
import { cn } from "~/lib/utils";
import { AppLink } from "../../components/AppLink";
import { Cost, Duration, Mono, Tokens } from "../../components/Cost";
import { Empty } from "../../components/Empty";
import { ErrorState } from "../../components/ErrorState";
import { LoadingRows } from "../../components/Loading";
import { Chip, Field, Page, PageHeader, Panel } from "../../components/Page";
import { useKeyBindings } from "../../lib/keyboard";
import { useGo, useWideViewport } from "../../lib/nav";
import { useToast } from "../../lib/toast";
import type { RouterOutputs } from "../../lib/trpc";
import { useTRPC } from "../../lib/trpc";
import { href } from "../../routes";
import { DiffView } from "./DiffView";
import { afterReviewDecisionHref, type ReviewOrigin } from "./navigation";

/**
 * REVIEW: diff, verification, acceptance verdict, agent report, cost and
 * comments on one screen. Rejection requires a reason and previews the repair
 * brief (`review.repairBrief`).
 */

const MIN_REASON = 10;

const REVIEW_CAUSE_LABEL = {
	critic_flagged: "Assisted review flagged concerns",
	critic_unavailable: "Assisted review could not decide",
	human_required: "Human review required by policy",
} as const;

export function ReviewPage({
	project,
	taskId,
	origin,
	selectedFile,
	onSelectFile,
}: {
	project: string;
	taskId: string;
	origin?: ReviewOrigin;
	selectedFile?: string;
	onSelectFile: (path: string | undefined) => void;
}) {
	const trpc = useTRPC();
	const queryClient = useQueryClient();
	const go = useGo();
	const { toast } = useToast();
	const wide = useWideViewport();

	const bundle = useQuery(trpc.review.bundle.queryOptions({ project, taskId }));
	const comments = useQuery(
		trpc.review.comments.list.queryOptions({ project, taskId }),
	);
	const task = useQuery(trpc.tasks.get.queryOptions({ project, id: taskId }));
	const inbox = useQuery(trpc.inbox.list.queryOptions());
	const [rejectOpen, setRejectOpen] = useState(false);

	// Decidable only in `review` with no merge in flight. `mergeJob` is set from
	// approve until the branch lands or parks (the task stays in `review` meanwhile).
	const mergeJob = bundle.data?.mergeJob ?? null;
	const readOnly =
		(task.data ? task.data.status !== "review" : false) || Boolean(mergeJob);

	const files = useMemo(() => bundle.data?.files ?? [], [bundle.data]);
	const activeFile =
		files.find((f) => f.path === selectedFile) ?? files[0] ?? null;
	const fileComments = (comments.data ?? []).filter(
		(c) => c.file === activeFile?.path,
	);
	const unresolved = (comments.data ?? []).filter((c) => !c.resolved);

	// The queue follows the inbox that opened the review; don't leak across projects.
	const queue = useMemo(
		() =>
			(inbox.data?.items ?? []).filter(
				(i): i is typeof i & { taskId: string } =>
					i.kind === "review" &&
					Boolean(i.taskId) &&
					(origin !== "project-inbox" || i.project === project),
			),
		[inbox.data, origin, project],
	);
	const position = queue.findIndex(
		(i) => i.project === project && i.taskId === taskId,
	);

	const goToQueue = (delta: number) => {
		if (queue.length === 0) return;
		const from = position === -1 ? 0 : position;
		const next = queue[(from + delta + queue.length) % queue.length];
		if (next) go(href.reviewTask(next.project, next.taskId, origin));
	};

	/** Where to land once this item leaves the queue. */
	const afterDecision = () => {
		go(afterReviewDecisionHref(project, taskId, origin, queue));
	};

	const dropInboxItem = () => {
		const key = trpc.inbox.list.queryKey();
		const previous = queryClient.getQueryData(key);
		queryClient.setQueryData(key, (data) => {
			if (!data) return data;
			const gone = data.items.find(
				(i) =>
					i.kind === "review" && i.taskId === taskId && i.project === project,
			);
			if (!gone) return data;
			return {
				items: data.items.filter((i) => i.id !== gone.id),
				counts: {
					total: data.counts.total - 1,
					critical: data.counts.critical,
					attention: data.counts.attention - 1,
				},
			};
		});
		return previous;
	};

	const approve = useMutation(
		trpc.tasks.approve.mutationOptions({
			meta: { label: "Approve" },
			onMutate: async () => {
				await queryClient.cancelQueries(trpc.inbox.list.queryFilter());
				return { previous: dropInboxItem() };
			},
			onError: (_err, _vars, ctx) => {
				if (ctx?.previous)
					queryClient.setQueryData(trpc.inbox.list.queryKey(), ctx.previous);
			},
			onSuccess: () => {
				toast({
					tone: "success",
					title: "Approved, merging",
					description:
						"The branch is queued behind the merge lock. A failure comes back as an inbox item.",
				});
				afterDecision();
			},
			onSettled: () => {
				void queryClient.invalidateQueries(trpc.inbox.list.queryFilter());
				void queryClient.invalidateQueries(
					trpc.tasks.get.queryFilter({ project, id: taskId }),
				);
				void queryClient.invalidateQueries(
					trpc.tasks.list.queryFilter({ project }),
				);
			},
		}),
	);

	const reject = useMutation(
		trpc.tasks.reject.mutationOptions({
			meta: { label: "Reject" },
			onMutate: async () => {
				await queryClient.cancelQueries(trpc.inbox.list.queryFilter());
				const previousInbox = dropInboxItem();
				const listFilter = trpc.tasks.list.queryFilter({ project });
				await queryClient.cancelQueries(listFilter);
				const previousLists =
					queryClient.getQueriesData<RouterOutputs["tasks"]["list"]>(
						listFilter,
					);
				for (const [key, rows] of previousLists) {
					if (!Array.isArray(rows)) continue;
					queryClient.setQueryData(key, (current: typeof rows | undefined) =>
						current?.map((row) =>
							row.id === taskId ? { ...row, status: "ready" as const } : row,
						),
					);
				}
				return { previousInbox, previousLists };
			},
			onError: (_err, _vars, ctx) => {
				if (ctx?.previousInbox)
					queryClient.setQueryData(
						trpc.inbox.list.queryKey(),
						ctx.previousInbox,
					);
				for (const [key, rows] of ctx?.previousLists ?? []) {
					queryClient.setQueryData(key, rows);
				}
			},
			onSuccess: () => {
				setRejectOpen(false);
				toast({
					tone: "success",
					title: "Sent back for repair",
					description:
						"Your reason and every unresolved comment go to the agent.",
				});
				afterDecision();
			},
			onSettled: () => {
				void queryClient.invalidateQueries(trpc.inbox.list.queryFilter());
				void queryClient.invalidateQueries(
					trpc.tasks.list.queryFilter({ project }),
				);
				void queryClient.invalidateQueries(
					trpc.tasks.get.queryFilter({ project, id: taskId }),
				);
			},
		}),
	);

	const addComment = useMutation(
		trpc.review.comments.add.mutationOptions({
			meta: { label: "Add comment" },
			onMutate: async (vars) => {
				const key = trpc.review.comments.list.queryKey({ project, taskId });
				await queryClient.cancelQueries(
					trpc.review.comments.list.queryFilter({ project, taskId }),
				);
				const previous = queryClient.getQueryData(key);
				queryClient.setQueryData(key, (rows) => [
					...(rows ?? []),
					{
						// Negative id: provisional, never collides with a real row.
						id: -Date.now(),
						taskId,
						file: vars.file,
						line: vars.line,
						side: vars.side ?? "new",
						body: vars.body,
						resolved: false,
						createdAt: new Date(),
					},
				]);
				return { previous };
			},
			onError: (_err, _vars, ctx) => {
				if (ctx?.previous)
					queryClient.setQueryData(
						trpc.review.comments.list.queryKey({ project, taskId }),
						ctx.previous,
					);
			},
			onSettled: () => {
				void queryClient.invalidateQueries(
					trpc.review.comments.list.queryFilter({ project, taskId }),
				);
			},
		}),
	);

	const resolveComment = useMutation(
		trpc.review.comments.resolve.mutationOptions({
			meta: { label: "Resolve comment" },
			onMutate: async (vars) => {
				const key = trpc.review.comments.list.queryKey({ project, taskId });
				await queryClient.cancelQueries(
					trpc.review.comments.list.queryFilter({ project, taskId }),
				);
				const previous = queryClient.getQueryData(key);
				queryClient.setQueryData(key, (rows) =>
					rows?.map((c) =>
						c.id === vars.id ? { ...c, resolved: vars.resolved } : c,
					),
				);
				return { previous };
			},
			onError: (_err, _vars, ctx) => {
				if (ctx?.previous)
					queryClient.setQueryData(
						trpc.review.comments.list.queryKey({ project, taskId }),
						ctx.previous,
					);
			},
			onSettled: () => {
				void queryClient.invalidateQueries(
					trpc.review.comments.list.queryFilter({ project, taskId }),
				);
			},
		}),
	);

	const removeComment = useMutation(
		trpc.review.comments.remove.mutationOptions({
			meta: { label: "Delete comment" },
			onMutate: async (vars) => {
				const key = trpc.review.comments.list.queryKey({ project, taskId });
				await queryClient.cancelQueries(
					trpc.review.comments.list.queryFilter({ project, taskId }),
				);
				const previous = queryClient.getQueryData(key);
				queryClient.setQueryData(key, (rows) =>
					rows?.filter((c) => c.id !== vars.id),
				);
				return { previous };
			},
			onError: (_err, _vars, ctx) => {
				if (ctx?.previous)
					queryClient.setQueryData(
						trpc.review.comments.list.queryKey({ project, taskId }),
						ctx.previous,
					);
			},
			onSettled: () => {
				void queryClient.invalidateQueries(
					trpc.review.comments.list.queryFilter({ project, taskId }),
				);
			},
		}),
	);

	const fileIndex = files.findIndex((f) => f.path === activeFile?.path);

	useKeyBindings([
		{
			key: "a",
			label: "Approve & merge",
			group: "Review",
			enabled: !readOnly && !approve.isPending && !rejectOpen,
			run: () => approve.mutate({ project, id: taskId }),
		},
		{
			key: "r",
			label: "Reject…",
			group: "Review",
			enabled: !readOnly && !rejectOpen,
			run: () => setRejectOpen(true),
		},
		{
			key: "[",
			label: "Previous in queue",
			group: "Review",
			run: () => goToQueue(-1),
		},
		{
			key: "]",
			label: "Next in queue",
			group: "Review",
			run: () => goToQueue(1),
		},
		{
			key: "j",
			label: "Next file",
			group: "Review",
			enabled: files.length > 1,
			run: () =>
				onSelectFile(files[Math.min(fileIndex + 1, files.length - 1)]?.path),
		},
		{
			key: "k",
			label: "Previous file",
			group: "Review",
			enabled: files.length > 1,
			run: () => onSelectFile(files[Math.max(fileIndex - 1, 0)]?.path),
		},
		{
			key: "t",
			label: "Open transcript",
			group: "Review",
			enabled: Boolean(bundle.data?.run),
			run: () => {
				const runId = bundle.data?.run?.runId;
				if (runId) go(href.run(project, runId));
			},
		},
	]);

	const run = bundle.data?.run ?? null;
	const usage = run?.usage ?? null;

	return (
		<Page className="h-full">
			<PageHeader
				back={
					<Button size="xs" variant="ghost" asChild>
						<AppLink
							to={
								origin === "project-inbox"
									? href.projectInbox(project)
									: origin === "inbox"
										? href.inbox()
										: href.review(project)
							}
						>
							<ArrowLeft aria-hidden />
							{origin ? "Inbox" : "Review queue"}
							{position >= 0 ? ` (${position + 1} of ${queue.length})` : ""}
						</AppLink>
					</Button>
				}
				title={
					<span className="flex flex-wrap items-baseline gap-2">
						<Mono value={taskId} />
						<span>{task.data?.title ?? ""}</span>
						{bundle.data?.reviewCause ? (
							<Chip tone="warn">
								{REVIEW_CAUSE_LABEL[bundle.data.reviewCause]}
							</Chip>
						) : null}
					</span>
				}
				meta={
					run ? (
						<>
							<span>attempt {run.attempt}</span>
							<span>{run.model}</span>
							<Duration ms={run.durationMs} />
							<Cost usd={usage?.costUsd ?? null} />
							{usage?.inputTokens != null || usage?.outputTokens != null ? (
								<Tokens
									count={(usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)}
								/>
							) : null}
							{bundle.data?.branch ? (
								<span className="mfw-num">
									{bundle.data.branch} → integration
								</span>
							) : null}
						</>
					) : null
				}
				actions={
					<>
						<Button size="sm" variant="ghost" asChild>
							<AppLink to={href.task(project, taskId)}>Task</AppLink>
						</Button>
						{run ? (
							<Button size="sm" variant="ghost" asChild>
								<AppLink to={href.run(project, run.runId)}>
									<ScrollText aria-hidden /> Transcript
								</AppLink>
							</Button>
						) : null}
						<Button size="sm" variant="outline" onClick={() => goToQueue(-1)}>
							[
						</Button>
						<Button size="sm" variant="outline" onClick={() => goToQueue(1)}>
							]
						</Button>
					</>
				}
			/>

			{bundle.isLoading ? (
				<div className="p-3">
					<LoadingRows rows={10} />
				</div>
			) : bundle.error ? (
				<div className="p-3">
					<ErrorState
						title="Could not load the review bundle"
						error={bundle.error}
						onRetry={() => void bundle.refetch()}
					/>
				</div>
			) : !bundle.data?.branch ? (
				<Empty
					icon={FileDiff}
					title="Nothing to review here."
					description="No changes are available for this task."
				/>
			) : (
				<div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3 lg:flex-row">
					<FileList
						files={files}
						active={activeFile?.path}
						onSelect={onSelectFile}
						comments={comments.data ?? []}
						wide={wide}
					/>

					<div className="min-w-0 flex-1">
						{activeFile ? (
							<DiffView
								key={activeFile.path}
								file={activeFile}
								comments={fileComments}
								unified={!wide}
								adding={addComment.isPending}
								onAdd={({ line, side, body }) =>
									addComment.mutate({
										project,
										taskId,
										file: activeFile.path,
										line,
										side,
										body,
									})
								}
								onResolve={(id, resolved) =>
									resolveComment.mutate({ project, id, resolved })
								}
								onRemove={(id) => removeComment.mutate({ project, id })}
							/>
						) : (
							<Empty title="No files changed." reason="none" />
						)}
						{bundle.data.truncated ? (
							<p className="mt-2" style={{ color: "var(--mfw-warn)" }}>
								This diff was truncated: the branch touches more files than the
								review bundle carries. Inspect the branch directly before
								approving.
							</p>
						) : null}
					</div>

					<Verdict
						project={project}
						acceptanceCriteria={bundle.data.acceptanceCriteria}
						checks={bundle.data.checks}
						acceptance={bundle.data.acceptance}
						scope={bundle.data.scope}
						review={bundle.data.review}
						runId={run?.runId ?? null}
					/>
				</div>
			)}

			{readOnly ? (
				<ReadOnlyBar
					status={task.data?.status}
					mergeJob={mergeJob}
					total={(comments.data ?? []).length}
				/>
			) : (
				<ActionBar
					unresolved={unresolved.length}
					total={(comments.data ?? []).length}
					approving={approve.isPending}
					disabled={!bundle.data?.branch}
					onApprove={() => approve.mutate({ project, id: taskId })}
					onReject={() => setRejectOpen(true)}
				/>
			)}

			<RejectDialog
				open={rejectOpen}
				onOpenChange={setRejectOpen}
				project={project}
				taskId={taskId}
				pending={reject.isPending}
				onSubmit={(reason) => reject.mutate({ project, id: taskId, reason })}
			/>
		</Page>
	);
}

function FileList({
	files,
	active,
	onSelect,
	comments,
	wide,
}: {
	files: RouterOutputs["review"]["bundle"]["files"];
	active?: string;
	onSelect: (path: string | undefined) => void;
	comments: RouterOutputs["review"]["comments"]["list"];
	wide: boolean;
}) {
	const countFor = (path: string) =>
		comments.filter((c) => c.file === path && !c.resolved).length;

	// Phone: collapse long file lists.
	if (!wide) {
		return (
			<label className="flex items-center gap-2">
				<span style={{ color: "var(--mfw-fg-muted)" }}>File</span>
				<select
					className="mfw-focus min-h-9 min-w-0 flex-1 border px-2"
					style={{
						background: "var(--mfw-bg-raised)",
						borderColor: "var(--mfw-border)",
						borderRadius: "var(--mfw-radius-sm)",
						color: "var(--mfw-fg)",
					}}
					value={active ?? ""}
					onChange={(e) => onSelect(e.target.value)}
				>
					{files.map((f) => (
						<option key={f.path} value={f.path}>
							{f.path} ({f.status})
						</option>
					))}
				</select>
			</label>
		);
	}

	return (
		<Panel
			title={`Files (${files.length})`}
			pad={false}
			className="w-64 shrink-0 self-start"
		>
			<ul className="max-h-150 overflow-auto">
				{files.map((f) => {
					const open = countFor(f.path);
					return (
						<li key={f.path}>
							<button
								type="button"
								onClick={() => onSelect(f.path)}
								className={cn(
									"mfw-focus flex w-full min-w-0 items-center gap-2 px-2 py-1 text-left",
								)}
								style={{
									background:
										f.path === active ? "var(--mfw-bg-hover)" : undefined,
									color:
										f.path === active ? "var(--mfw-fg)" : "var(--mfw-fg-muted)",
								}}
							>
								<span
									aria-hidden
									className="size-1.5 shrink-0 rounded-full"
									style={{
										background:
											f.status === "added"
												? "var(--mfw-ok)"
												: f.status === "deleted"
													? "var(--mfw-critical)"
													: "var(--mfw-warn)",
									}}
								/>
								<span
									className="mfw-num min-w-0 flex-1 truncate"
									title={`${f.path} (${f.status})`}
									dir="rtl"
								>
									{f.path}
								</span>
								{open > 0 ? <Chip tone="accent">{open}</Chip> : null}
							</button>
						</li>
					);
				})}
			</ul>
		</Panel>
	);
}

function Verdict({
	project,
	acceptanceCriteria,
	checks,
	acceptance,
	scope,
	review,
	runId,
}: {
	project: string;
	acceptanceCriteria: RouterOutputs["review"]["bundle"]["acceptanceCriteria"];
	checks: RouterOutputs["review"]["bundle"]["checks"];
	acceptance: RouterOutputs["review"]["bundle"]["acceptance"];
	scope: RouterOutputs["review"]["bundle"]["scope"];
	review: RouterOutputs["review"]["bundle"]["review"];
	runId: string | null;
}) {
	const trpc = useTRPC();
	const steps = useQuery({
		...trpc.runs.steps.queryOptions({ project, runId: runId ?? "" }),
		enabled: Boolean(runId),
	});

	const report = useMemo(() => {
		const step = (steps.data ?? []).find((s) => s.step === "ingest_report");
		const value = (step?.result as { report?: unknown } | undefined)?.report;
		return value && typeof value === "object"
			? (value as Record<string, unknown>)
			: null;
	}, [steps.data]);

	return (
		<div className="flex w-full shrink-0 flex-col gap-3 lg:w-80">
			<Panel title="Acceptance">
				<ul className="flex flex-col gap-2">
					{(acceptanceCriteria.length > 0
						? acceptanceCriteria
						: acceptance?.criteria.length
							? acceptance.criteria.map((item) => item.criterion)
							: ["Deliver the task goal described on the task."]
					).map((criterion) => {
						const assessment = acceptance?.criteria.find(
							(item) => item.criterion === criterion,
						);
						// Met on the agent's word alone does not count as met.
						const claimed = assessment?.evidenceClass === "claimed";
						return (
							<li key={criterion} className="flex flex-col gap-0.5">
								<span className="flex items-start gap-1.5">
									{assessment?.verdict === "met" ? (
										<CircleCheck
											aria-label={claimed ? "met, claimed only" : "accepted"}
											className="mt-0.5 size-3.5 shrink-0"
											style={{
												color: claimed ? "var(--mfw-warn)" : "var(--mfw-ok)",
											}}
										/>
									) : (
										<CircleX
											aria-label={assessment?.verdict ?? "not assessed"}
											className="mt-0.5 size-3.5 shrink-0"
											style={{ color: "var(--mfw-warn)" }}
										/>
									)}
									<span className="min-w-0 flex-1">{criterion}</span>
									{assessment?.evidenceClass ? (
										<Chip
											tone={EVIDENCE_TONE[assessment.evidenceClass]}
											title={EVIDENCE_HINT[assessment.evidenceClass]}
											className={claimed ? "line-through" : undefined}
										>
											{assessment.evidenceClass}
										</Chip>
									) : null}
								</span>
								{assessment?.evidence ? (
									<span
										className="pl-5"
										style={{ color: "var(--mfw-fg-muted)" }}
									>
										{assessment.evidence}
									</span>
								) : null}
							</li>
						);
					})}
				</ul>
				<div className="mt-2">
					{acceptance ? (
						<Chip tone={acceptance.outcome === "accepted" ? "ok" : "warn"}>
							{acceptance.outcome}
						</Chip>
					) : (
						<p style={{ color: "var(--mfw-fg-faint)" }}>
							No assisted decision. Your approval is the acceptance decision.
						</p>
					)}
				</div>
			</Panel>

			{scope && scope.outside.length > 0 ? (
				<Panel title="Changed outside declared scope">
					<p style={{ color: "var(--mfw-fg-muted)" }}>
						Declared: <span className="mfw-num">{scope.owns.join(", ")}</span>
					</p>
					<ul className="mt-1 flex flex-col gap-0.5">
						{scope.outside.map((path) => (
							<li
								key={path}
								className="mfw-num min-w-0 truncate"
								title={path}
								style={{ color: "var(--mfw-warn)" }}
							>
								{path}
							</li>
						))}
					</ul>
				</Panel>
			) : null}

			<Panel title="Verification checks">
				{checks.length === 0 ? (
					<p style={{ color: "var(--mfw-fg-faint)" }}>
						No verification checks ran. Approval is still required.
					</p>
				) : (
					<ul className="flex flex-col gap-1">
						{checks.map((c) => (
							<li key={c.name} className="flex min-w-0 flex-col">
								<span className="flex items-center gap-1.5">
									{c.ok ? (
										<CircleCheck
											aria-label="passed"
											className="size-3.5 shrink-0"
											style={{ color: "var(--mfw-ok)" }}
										/>
									) : (
										<CircleX
											aria-label="failed"
											className="size-3.5 shrink-0"
											style={{ color: "var(--mfw-critical)" }}
										/>
									)}
									<span className="mfw-num min-w-0 truncate">{c.name}</span>
								</span>
								{c.detail ? (
									<pre
										className="mfw-num mt-0.5 max-h-40 overflow-auto p-1 whitespace-pre-wrap"
										style={{
											background: "var(--mfw-bg-inset)",
											borderRadius: "var(--mfw-radius-sm)",
											color: "var(--mfw-fg-muted)",
											fontSize: "var(--mfw-text-2xs)",
										}}
									>
										{c.detail}
									</pre>
								) : null}
							</li>
						))}
					</ul>
				)}
			</Panel>

			<Panel title="Acceptance detail">
				{acceptance ? (
					<div className="flex flex-col gap-1">
						<Field label="verdict">
							<Chip tone={acceptance.outcome === "accepted" ? "ok" : "warn"}>
								{acceptance.outcome}
							</Chip>
						</Field>
						{review ? (
							<Field label="reviewer">
								<span className="mfw-num">{review.reviewerModel}</span>
								<span style={{ color: "var(--mfw-fg-muted)" }}>
									{review.sameModel
										? " (same model as the implementer)"
										: review.implementerModel
											? ` (implementer: ${review.implementerModel})`
											: ""}
								</span>
							</Field>
						) : null}
						{acceptance.detail ? (
							<p
								className="whitespace-pre-wrap"
								style={{ color: "var(--mfw-fg-muted)" }}
							>
								{acceptance.detail}
							</p>
						) : null}
					</div>
				) : (
					<p style={{ color: "var(--mfw-fg-faint)" }}>
						No assisted acceptance decision was recorded for this run.
					</p>
				)}
			</Panel>

			<Panel title="Agent report">
				{steps.isLoading ? (
					<LoadingRows rows={2} />
				) : steps.error ? (
					<ErrorState
						title="Could not load the agent report"
						error={steps.error}
						onRetry={() => void steps.refetch()}
					/>
				) : report ? (
					<ReportBody report={report} />
				) : (
					<p style={{ color: "var(--mfw-fg-faint)" }}>
						No agent report was provided.
					</p>
				)}
			</Panel>
		</div>
	);
}

type EvidenceClass = NonNullable<
	NonNullable<
		RouterOutputs["review"]["bundle"]["acceptance"]
	>["criteria"][number]["evidenceClass"]
>;

const EVIDENCE_TONE: Record<EvidenceClass, "ok" | "info" | "warn"> = {
	reproduced: "ok",
	"source-confirmed": "info",
	claimed: "warn",
};

const EVIDENCE_HINT: Record<EvidenceClass, string> = {
	reproduced: "A check result or command output shows it",
	"source-confirmed": "Visible in the diff",
	claimed: "Only the agent says so; not counted as met",
};

function ReportBody({ report }: { report: Record<string, unknown> }) {
	const summary = typeof report.summary === "string" ? report.summary : null;
	const notes = typeof report.notes === "string" ? report.notes : null;
	const rest = Object.entries(report).filter(
		([k]) => k !== "summary" && k !== "notes",
	);
	return (
		<div className="flex flex-col gap-1">
			{summary ? (
				<p style={{ lineHeight: "var(--mfw-leading-prose)" }}>{summary}</p>
			) : null}
			{notes ? (
				<p
					className="whitespace-pre-wrap"
					style={{ color: "var(--mfw-fg-muted)" }}
				>
					{notes}
				</p>
			) : null}
			{rest.length > 0 ? (
				<pre
					className="mfw-num max-h-60 overflow-auto p-1 whitespace-pre-wrap"
					style={{
						background: "var(--mfw-bg-inset)",
						borderRadius: "var(--mfw-radius-sm)",
						color: "var(--mfw-fg-muted)",
						fontSize: "var(--mfw-text-2xs)",
					}}
				>
					{JSON.stringify(Object.fromEntries(rest), null, 2)}
				</pre>
			) : null}
		</div>
	);
}

/** Sticky on phone, where it is the only thing that has to stay reachable. */
function ActionBar({
	unresolved,
	total,
	approving,
	disabled,
	onApprove,
	onReject,
}: {
	unresolved: number;
	total: number;
	approving: boolean;
	disabled: boolean;
	onApprove: () => void;
	onReject: () => void;
}) {
	return (
		<div
			className="sticky bottom-0 flex flex-wrap items-center gap-2 border-t px-3 py-2"
			style={{
				borderColor: "var(--mfw-border)",
				background: "var(--mfw-bg-subtle)",
			}}
		>
			<span style={{ color: "var(--mfw-fg-muted)" }}>
				{total} comment{total === 1 ? "" : "s"}
				{unresolved > 0 ? ` (${unresolved} unresolved)` : ""}
			</span>
			<span className="flex-1" />
			<Button
				className="min-h-9 flex-1 sm:flex-none"
				variant="outline"
				disabled={disabled}
				onClick={onReject}
			>
				<ThumbsDown aria-hidden /> Reject… <Kbd>r</Kbd>
			</Button>
			<Button
				className="min-h-9 flex-1 sm:flex-none"
				disabled={disabled || approving}
				onClick={onApprove}
			>
				<Check aria-hidden />
				{approving ? "Approving…" : "Approve & merge"} <Kbd>a</Kbd>
			</Button>
		</div>
	);
}

/** What each in-flight merge state means to someone deciding whether to wait. */
const MERGE_STATE_LABEL: Record<string, string> = {
	queued: "queued behind the merge lock",
	merging: "merging",
	rebasing: "rebasing onto the target branch",
	reverifying: "re-verifying after rebase",
};

/** Replaces the ActionBar when nothing is left to decide: task left `review`, or its branch is queued or mid-merge. */
function ReadOnlyBar({
	status,
	mergeJob,
	total,
}: {
	status: string | undefined;
	mergeJob: RouterOutputs["review"]["bundle"]["mergeJob"];
	total: number;
}) {
	const message = mergeJob
		? mergeJob.paused
			? "Approved, but the merge queue is paused (main is red). Still queued behind the lock."
			: `Approved: ${MERGE_STATE_LABEL[mergeJob.state] ?? mergeJob.state}.`
		: status === "done"
			? "Already merged. Read only."
			: `No longer awaiting review (status: ${status ?? "unknown"}). Read only.`;

	return (
		<div
			className="sticky bottom-0 flex flex-wrap items-center gap-2 border-t px-3 py-2"
			style={{
				borderColor: "var(--mfw-border)",
				background: "var(--mfw-bg-subtle)",
			}}
		>
			{mergeJob ? (
				<GitMerge
					aria-hidden
					className="size-4 shrink-0"
					style={{
						color: mergeJob.paused ? "var(--mfw-warn)" : "var(--mfw-fg-muted)",
					}}
				/>
			) : (
				<CircleCheck
					aria-hidden
					className="size-4 shrink-0"
					style={{ color: "var(--mfw-ok)" }}
				/>
			)}
			<span style={{ color: "var(--mfw-fg-muted)" }}>{message}</span>
			<span className="flex-1" />
			<span style={{ color: "var(--mfw-fg-faint)" }}>
				{total} comment{total === 1 ? "" : "s"}
			</span>
		</div>
	);
}

function Kbd({ children }: { children: string }) {
	return (
		<span
			aria-hidden
			className="mfw-num ml-1 border px-1"
			style={{
				borderColor: "var(--mfw-border)",
				borderRadius: "var(--mfw-radius-sm)",
				fontSize: "var(--mfw-text-2xs)",
				opacity: 0.7,
			}}
		>
			{children}
		</span>
	);
}

function RejectDialog({
	open,
	onOpenChange,
	project,
	taskId,
	pending,
	onSubmit,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	project: string;
	taskId: string;
	pending: boolean;
	onSubmit: (reason: string) => void;
}) {
	const trpc = useTRPC();
	const [reason, setReason] = useState("");
	const debounced = useDebounced(reason, 400);
	const valid = reason.trim().length >= MIN_REASON;

	// Server-fetched so the preview is exactly the text the engine sends.
	const brief = useQuery({
		...trpc.review.repairBrief.queryOptions({
			project,
			taskId,
			reason: debounced.trim() || "…",
		}),
		enabled: open && debounced.trim().length >= MIN_REASON,
	});

	useEffect(() => {
		if (!open) setReason("");
	}, [open]);

	return (
		<Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
			<DialogContent className="mfw-v2 sm:max-w-150">
				<DialogHeader>
					<DialogTitle>Reject and send back for repair</DialogTitle>
					<DialogDescription asChild>
						<div style={{ color: "var(--mfw-fg-muted)" }}>
							The task returns to <strong>ready</strong> and the next attempt is
							told why. A reason is required, it is the only thing that makes
							the retry different from the last one.
						</div>
					</DialogDescription>
				</DialogHeader>

				<div className="flex flex-col gap-1.5">
					<Textarea
						autoFocus
						rows={4}
						value={reason}
						placeholder="What is wrong, and what would make it right?"
						onChange={(e) => setReason(e.target.value)}
					/>
					<span
						style={{
							color: valid ? "var(--mfw-fg-faint)" : "var(--mfw-warn)",
							fontSize: "var(--mfw-text-xs)",
						}}
					>
						{valid
							? "This, plus every unresolved comment, becomes the repair brief."
							: `At least ${MIN_REASON} characters.`}
					</span>
				</div>

				<div className="flex flex-col gap-1">
					<span
						className="uppercase"
						style={{
							color: "var(--mfw-fg-faint)",
							fontSize: "var(--mfw-text-2xs)",
							letterSpacing: "0.06em",
						}}
					>
						What the agent will be told
					</span>
					{brief.error ? (
						<ErrorState
							title="Could not build the repair brief"
							error={brief.error}
							onRetry={() => void brief.refetch()}
						/>
					) : (
						<pre
							className="mfw-num max-h-60 overflow-auto p-2 whitespace-pre-wrap"
							style={{
								background: "var(--mfw-bg-inset)",
								borderRadius: "var(--mfw-radius-sm)",
								color: "var(--mfw-fg-muted)",
								fontSize: "var(--mfw-text-xs)",
							}}
						>
							{valid
								? (brief.data ?? "Building…")
								: "Write a reason to see the brief."}
						</pre>
					)}
				</div>

				<DialogFooter>
					<Button
						variant="ghost"
						disabled={pending}
						onClick={() => onOpenChange(false)}
					>
						Cancel
					</Button>
					<Button
						disabled={!valid || pending}
						onClick={() => onSubmit(reason.trim())}
					>
						{pending ? "Sending…" : "Reject & repair"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** Debounce for the repair-brief preview (fires once per typing pause). */
function useDebounced<T>(value: T, ms: number): T {
	const [debounced, setDebounced] = useState(value);
	useEffect(() => {
		const timer = setTimeout(() => setDebounced(value), ms);
		return () => clearTimeout(timer);
	}, [value, ms]);
	return debounced;
}
