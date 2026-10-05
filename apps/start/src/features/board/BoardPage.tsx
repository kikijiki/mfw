import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	CircleHelp,
	Plus,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "~/components/ui/select";
import { cn } from "~/lib/utils";
import { AppLink } from "../../components/AppLink";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Mono } from "../../components/Cost";
import { Empty } from "../../components/Empty";
import { ErrorState } from "../../components/ErrorState";
import { LoadingRows } from "../../components/Loading";
import { Chip, Page } from "../../components/Page";
import { Elapsed } from "../../components/RelativeTime";
import { StatusPill, type TaskStatus } from "../../components/StatusPill";
import {
	readCollapsedColumns,
	writeCollapsedColumns,
} from "../../lib/boardColumns";
import {
	BOARD_SORT_OPTIONS,
	type BoardSort,
	DEFAULT_BOARD_SORT,
	isBoardSort,
	readBoardSort,
	sortBoardTasks,
	writeBoardSort,
} from "../../lib/boardSort";
import { useOpenTaskFromBoard, useWideViewport } from "../../lib/nav";
import { humanizeError, useToast } from "../../lib/toast";
import type { RouterOutputs } from "../../lib/trpc";
import { useTRPC } from "../../lib/trpc";
import { href } from "../../routes";
import { OwnershipConflictNotice } from "./OwnershipConflictNotice";

/** Board. Drag moves a task, optimistically; rolls back with the server's reason if the DoR gate refuses. Phones get a status menu instead of drag. */

type Task = RouterOutputs["tasks"]["list"][number];

const COLUMNS: TaskStatus[] = [
	"draft",
	"backlog",
	"ready",
	"in_progress",
	"blocked",
	"review",
	"done",
	"archived",
];

/** Terminal columns start collapsed. */
const COLLAPSED_BY_DEFAULT: TaskStatus[] = ["done", "archived"];

const PRIORITY_TOKEN: Record<string, string> = {
	critical: "--mfw-critical",
	high: "--mfw-warn",
	medium: "--mfw-neutral",
	low: "--mfw-fg-faint",
};

export interface BoardFilters {
	q?: string;
	label?: string;
	priority?: string;
	type?: string;
}

export function BoardPage({
	project,
	filters,
	onFilters,
}: {
	project: string;
	filters: BoardFilters;
	onFilters: (next: BoardFilters) => void;
}) {
	const trpc = useTRPC();
	const queryClient = useQueryClient();
	const { toast } = useToast();
	const wide = useWideViewport();
	const tasks = useQuery(trpc.tasks.list.queryOptions({ project }));
	// SSR-safe default, corrected on mount (as in useTheme()): reading
	// localStorage during render would mismatch server and client markup.
	const [collapsedColumns, setCollapsedColumns] = useState<Set<TaskStatus>>(
		() => new Set(COLLAPSED_BY_DEFAULT),
	);
	const [boardSort, setBoardSort] = useState<BoardSort>(DEFAULT_BOARD_SORT);
	useEffect(() => setBoardSort(readBoardSort()), []);
	useEffect(() => {
		const stored = readCollapsedColumns(project);
		setCollapsedColumns(
			new Set((stored ?? COLLAPSED_BY_DEFAULT) as TaskStatus[]),
		);
	}, [project]);
	const toggleColumn = useCallback(
		(status: TaskStatus) => {
			setCollapsedColumns((prev) => {
				const next = new Set(prev);
				if (next.has(status)) next.delete(status);
				else next.add(status);
				writeCollapsedColumns(project, [...next]);
				return next;
			});
		},
		[project],
	);
	const [mobileStatus, setMobileStatus] = useState<TaskStatus>("ready");
	const [composing, setComposing] = useState(false);
	/** Raw prompt, not a finished task; scheduling and review intent survive the async expansion pass. */
	const [captureText, setCaptureText] = useState("");
	const [afterExpansion, setAfterExpansion] = useState<"backlog" | "ready">(
		"ready",
	);
	const [captureRequireReview, setCaptureRequireReview] = useState(false);
	const [captureRequestId, setCaptureRequestId] = useState(() =>
		globalThis.crypto.randomUUID(),
	);
	/** Set when a drag hits a task whose run is still live: the server refuses
	 *  the move, and this holds what is needed to offer "cancel the run, then move". */
	const [claimConflict, setClaimConflict] = useState<{
		id: string;
		to: TaskStatus;
		reason?: string;
		runId: string;
	} | null>(null);
	const [bulkMove, setBulkMove] = useState<{
		from: TaskStatus;
		to: TaskStatus;
		ids: string[];
	} | null>(null);

	const rows = useMemo(() => tasks.data ?? [], [tasks.data]);

	const labels = useMemo(() => {
		const set = new Set<string>();
		for (const t of rows) for (const l of t.labels) set.add(l);
		return [...set].sort();
	}, [rows]);

	const filtered = useMemo(() => {
		const q = filters.q?.trim().toLowerCase();
		return rows.filter((t) => {
			if (q && !`${t.id} ${t.title}`.toLowerCase().includes(q)) return false;
			if (filters.label && !t.labels.includes(filters.label)) return false;
			if (filters.priority && t.priority !== filters.priority) return false;
			if (filters.type && t.type !== filters.type) return false;
			return true;
		});
	}, [rows, filters]);
	const sorted = useMemo(
		() => sortBoardTasks(filtered, boardSort),
		[filtered, boardSort],
	);

	const isFiltered = Boolean(
		filters.q || filters.label || filters.priority || filters.type,
	);

	const move = useMutation(
		trpc.tasks.move.mutationOptions({
			// Raises its own toast naming the card.
			meta: { toast: false },
			onMutate: async (vars) => {
				const filter = trpc.tasks.list.queryFilter({ project });
				await queryClient.cancelQueries(filter);
				const previous = queryClient.getQueriesData<Task[]>(filter);
				for (const [key, data] of previous) {
					if (!Array.isArray(data)) continue;
					queryClient.setQueryData<Task[]>(key, (current) =>
						current?.map((row) =>
							row.id === vars.id ? { ...row, status: vars.to } : row,
						),
					);
				}
				return { previous };
			},
			onError: (error, vars, ctx) => {
				for (const [key, data] of ctx?.previous ?? []) {
					queryClient.setQueryData(key, data);
				}
				// Run still live: offer cancel-then-move. This runId is display-only; the
				// server re-derives the claim on confirm, so a stale read cannot misfire.
				const code = (error as { data?: { code?: string } }).data?.code;
				const claimedRunId =
					code === "PRECONDITION_FAILED"
						? (ctx?.previous ?? [])
								.flatMap(([, data]) => (Array.isArray(data) ? data : []))
								.find((t) => t.id === vars.id)?.claimedByRunId
						: null;
				if (claimedRunId) {
					setClaimConflict({
						id: vars.id,
						to: vars.to,
						reason: vars.reason,
						runId: claimedRunId,
					});
					return;
				}
				toast({
					tone: "error",
					title: `${vars.id} stayed put`,
					description: humanizeError(error),
					duration: 0,
				});
			},
			onSettled: () => {
				void queryClient.invalidateQueries(
					trpc.tasks.list.queryFilter({ project }),
				);
				void queryClient.invalidateQueries(
					trpc.tasks.graph.queryFilter({ project }),
				);
			},
		}),
	);

	const moveMany = useMutation(
		trpc.tasks.moveMany.mutationOptions({
			meta: { toast: false },
			onSuccess: (result, vars) => {
				setBulkMove(null);
				toast({
					tone: result.skipped.length > 0 ? "warning" : "success",
					title: `${result.moved.length} task${result.moved.length === 1 ? "" : "s"} moved`,
					description:
						result.skipped.length > 0
							? `${result.skipped.length} stayed in ${vars.from.replace("_", " ")} because they changed or are still running.`
							: `Moved to ${vars.to.replace("_", " ")}.`,
				});
			},
			onError: (error) => {
				toast({
					tone: "error",
					title: "Column move failed",
					description: humanizeError(error),
					duration: 0,
				});
			},
			onSettled: () => {
				void queryClient.invalidateQueries(
					trpc.tasks.list.queryFilter({ project }),
				);
				void queryClient.invalidateQueries(
					trpc.tasks.graph.queryFilter({ project }),
				);
			},
		}),
	);

	/**
	 * Quick capture: filed instantly as a `draft` with the raw text; an expansion
	 * pass later fills in body, criteria and checks. The only create path on the
	 * board, to avoid up-front forms on mobile.
	 */
	const captureQuick = useMutation(
		trpc.tasks.captureQuick.mutationOptions({
			meta: { label: "Capture task" },
			retry: 2,
			onSuccess: (task) => {
				setComposing(false);
				setCaptureText("");
				setAfterExpansion("ready");
				setCaptureRequireReview(false);
				setCaptureRequestId(globalThis.crypto.randomUUID());
				setMobileStatus(task.status);
				toast({
					tone: "success",
					title: `${task.id} captured`,
					description:
						task.afterExpansion === "backlog"
							? "It will stay in backlog after expansion."
							: "It will move to ready after expansion.",
				});
				void queryClient.invalidateQueries(
					trpc.tasks.list.queryFilter({ project }),
				);
			},
		}),
	);

	const columnTasks = (status: TaskStatus) =>
		sorted.filter((t) => t.status === status);
	const requestBulkMove = (from: TaskStatus, to: TaskStatus) => {
		const ids = columnTasks(from).map((task) => task.id);
		if (ids.length > 0) setBulkMove({ from, to, ids });
	};

	return (
		<Page className="h-full">
			<div
				className="flex flex-wrap items-center gap-2 border-b px-3 py-1.5"
				style={{
					borderColor: "var(--mfw-border)",
					background: "var(--mfw-bg-subtle)",
				}}
			>
				<Input
					className="max-w-60"
					value={filters.q ?? ""}
					placeholder="Filter by id or title"
					aria-label="Filter tasks"
					onChange={(e) =>
						onFilters({ ...filters, q: e.target.value || undefined })
					}
				/>
				<FilterSelect
					label="label"
					value={filters.label}
					options={labels}
					onChange={(label) => onFilters({ ...filters, label })}
				/>
				<FilterSelect
					label="priority"
					value={filters.priority}
					options={["critical", "high", "medium", "low"]}
					onChange={(priority) => onFilters({ ...filters, priority })}
				/>
				<FilterSelect
					label="type"
					value={filters.type}
					options={["implementation", "spike", "epic", "maintenance"]}
					onChange={(type) => onFilters({ ...filters, type })}
				/>
				<select
					aria-label="Sort tasks"
					className="mfw-focus min-h-8 border px-1.5"
					style={{
						background: "var(--mfw-bg-raised)",
						borderColor: "var(--mfw-border)",
						borderRadius: "var(--mfw-radius-sm)",
						color: "var(--mfw-fg-muted)",
						fontSize: "var(--mfw-text-xs)",
					}}
					value={boardSort}
					onChange={(event) => {
						const next = event.currentTarget.value;
						if (!isBoardSort(next)) return;
						setBoardSort(next);
						writeBoardSort(next);
					}}
				>
					{BOARD_SORT_OPTIONS.map((option) => (
						<option key={option.value} value={option.value}>
							{option.label}
						</option>
					))}
				</select>
				{isFiltered ? (
					<Button size="xs" variant="ghost" onClick={() => onFilters({})}>
						Clear
					</Button>
				) : null}

				<span
					className="ml-auto tabular-nums"
					style={{ color: "var(--mfw-fg-muted)" }}
				>
					{filtered.length} of {rows.length} task
					{rows.length === 1 ? "" : "s"}
				</span>
				{composing ? (
					<Button
						type="submit"
						form="quick-capture-task"
						size="sm"
						disabled={captureQuick.isPending || captureText.trim().length === 0}
					>
						{captureQuick.isPending ? "Creating…" : "Create task"}
					</Button>
				) : (
					<Button size="sm" onClick={() => setComposing(true)}>
						<Plus aria-hidden /> Create task
					</Button>
				)}
			</div>

			{composing ? (
				<form
					id="quick-capture-task"
					className="flex flex-wrap items-center gap-2 border-b px-3 py-2"
					style={{ borderColor: "var(--mfw-border)" }}
					onSubmit={(e) => {
						e.preventDefault();
						const text = captureText.trim();
						if (!text) return;
						captureQuick.mutate({
							project,
							text,
							requestId: captureRequestId,
							afterExpansion,
							requireReview: captureRequireReview,
						});
					}}
				>
					<Input
						className="min-w-64 flex-1"
						autoFocus
						value={captureText}
						placeholder="What needs doing? (an agent will flesh this out)"
						aria-label="Capture task"
						onChange={(e) => setCaptureText(e.target.value)}
					/>
					<Select
						value={afterExpansion}
						onValueChange={(value) =>
							setAfterExpansion(value as "backlog" | "ready")
						}
					>
						<SelectTrigger className="w-44" aria-label="After expansion">
							<SelectValue />
						</SelectTrigger>
						<SelectContent position="popper">
							<SelectItem value="ready">Move to ready</SelectItem>
							<SelectItem value="backlog">Keep in backlog</SelectItem>
						</SelectContent>
					</Select>
					<Label
						htmlFor="quick-capture-human-review"
						className="flex min-h-9 items-center gap-2 whitespace-nowrap"
					>
						<Checkbox
							id="quick-capture-human-review"
							checked={captureRequireReview}
							onCheckedChange={(checked) =>
								setCaptureRequireReview(checked === true)
							}
						/>
						Human review
					</Label>
					<Button
						type="button"
						size="sm"
						variant="ghost"
						onClick={() => setComposing(false)}
					>
						Cancel
					</Button>
				</form>
			) : null}

			<OwnershipConflictNotice project={project} />

			{tasks.isLoading ? (
				<div className="p-3">
					<LoadingRows rows={8} />
				</div>
			) : tasks.error ? (
				<div className="p-3">
					<ErrorState
						title="Could not load tasks"
						error={tasks.error}
						onRetry={() => void tasks.refetch()}
					/>
				</div>
			) : rows.length === 0 ? (
				<Empty
					title="No tasks yet."
					description="Create a task, import existing work, or plan a goal."
					action={
						<Button size="sm" variant="outline" asChild>
							<AppLink to={href.projectSettings(project)}>
								Open project settings
							</AppLink>
						</Button>
					}
				/>
			) : filtered.length === 0 ? (
				<Empty
					reason="filtered"
					title="No task matches this filter."
					action={
						<Button size="sm" variant="outline" onClick={() => onFilters({})}>
							Clear filters
						</Button>
					}
				/>
			) : wide ? (
				<div className="flex min-h-0 flex-1 gap-2 overflow-x-auto p-3">
					{COLUMNS.map((status) => {
						const columnIndex = COLUMNS.indexOf(status);
						const collapsed = collapsedColumns.has(status);
						const list = columnTasks(status);
						return (
							<Column
								key={status}
								status={status}
								tasks={list}
								collapsed={collapsed}
								onToggle={() => toggleColumn(status)}
								previous={COLUMNS[columnIndex - 1]}
								next={COLUMNS[columnIndex + 1]}
								onMoveAll={(to) => requestBulkMove(status, to)}
								acceptsDrop={status !== "in_progress"}
								onDrop={(id) => {
									const task = rows.find((t) => t.id === id);
									if (!task || task.status === status) return;
									move.mutate({ project, id, to: status });
								}}
								project={project}
							/>
						);
					})}
				</div>
			) : (
				<div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
					<div className="flex flex-wrap gap-1">
						{COLUMNS.map((status) => (
							<button
								key={status}
								type="button"
								aria-pressed={status === mobileStatus}
								onClick={() => setMobileStatus(status)}
								className="mfw-focus min-h-9 border px-2"
								style={{
									borderColor:
										status === mobileStatus
											? "var(--mfw-accent)"
											: "var(--mfw-border)",
									color:
										status === mobileStatus
											? "var(--mfw-accent)"
											: "var(--mfw-fg-muted)",
									borderRadius: "var(--mfw-radius-sm)",
									fontSize: "var(--mfw-text-xs)",
								}}
							>
								{status.replace("_", " ")} {columnTasks(status).length}
							</button>
						))}
					</div>
					<div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto">
						<ColumnMoveControls
							status={mobileStatus}
							count={columnTasks(mobileStatus).length}
							previous={COLUMNS[COLUMNS.indexOf(mobileStatus) - 1]}
							next={COLUMNS[COLUMNS.indexOf(mobileStatus) + 1]}
							onMoveAll={(to) => requestBulkMove(mobileStatus, to)}
						/>
						{columnTasks(mobileStatus).map((task) => (
							<TaskCard
								key={task.id}
								task={task}
								project={project}
								draggable={false}
								onMove={(to) => move.mutate({ project, id: task.id, to })}
							/>
						))}
						{columnTasks(mobileStatus).length === 0 ? (
							<Empty title={`Nothing in ${mobileStatus.replace("_", " ")}.`} />
						) : null}
					</div>
				</div>
			)}

			<ConfirmDialog
				open={bulkMove !== null}
				onOpenChange={(open) => {
					if (!open) setBulkMove(null);
				}}
				title={
					bulkMove
						? `Move ${bulkMove.ids.length} task${bulkMove.ids.length === 1 ? "" : "s"} to ${bulkMove.to.replace("_", " ")}?`
						: ""
				}
				description={
					bulkMove
						? `This moves every task currently shown in ${bulkMove.from.replace("_", " ")}. Tasks that start running or change columns before confirmation will stay put.`
						: null
				}
				confirmLabel="Move all"
				pending={moveMany.isPending}
				onConfirm={() => {
					if (bulkMove) moveMany.mutate({ project, ...bulkMove });
				}}
			/>

			<ConfirmDialog
				open={claimConflict !== null}
				onOpenChange={(open) => {
					if (!open) setClaimConflict(null);
				}}
				title={claimConflict ? `${claimConflict.id} is still running` : ""}
				description={
					claimConflict ? (
						<>
							Run <Mono value={claimConflict.runId} /> hasn't finished.
							Cancelling it kills the agent process and moves the task to{" "}
							{claimConflict.to.replace("_", " ")}; committed work on its branch
							is kept.
						</>
					) : null
				}
				confirmLabel="Cancel run and move"
				pending={move.isPending}
				onConfirm={() => {
					if (!claimConflict) return;
					move.mutate({
						project,
						id: claimConflict.id,
						to: claimConflict.to,
						reason: claimConflict.reason,
						cancelRun: true,
					});
					setClaimConflict(null);
				}}
			/>
		</Page>
	);
}

function FilterSelect({
	label,
	value,
	options,
	onChange,
}: {
	label: string;
	value?: string;
	options: string[];
	onChange: (value: string | undefined) => void;
}) {
	if (options.length === 0) return null;
	return (
		<select
			aria-label={`Filter by ${label}`}
			className="mfw-focus min-h-8 border px-1.5"
			style={{
				background: "var(--mfw-bg-raised)",
				borderColor: "var(--mfw-border)",
				borderRadius: "var(--mfw-radius-sm)",
				color: value ? "var(--mfw-fg)" : "var(--mfw-fg-muted)",
				fontSize: "var(--mfw-text-xs)",
			}}
			value={value ?? ""}
			onChange={(e) => onChange(e.target.value || undefined)}
		>
			<option value="">{label}: any</option>
			{options.map((option) => (
				<option key={option} value={option}>
					{option}
				</option>
			))}
		</select>
	);
}

function Column({
	status,
	tasks,
	collapsed,
	onToggle,
	previous,
	next,
	onMoveAll,
	acceptsDrop,
	onDrop,
	project,
}: {
	status: TaskStatus;
	tasks: Task[];
	collapsed: boolean;
	onToggle: () => void;
	previous?: TaskStatus;
	next?: TaskStatus;
	onMoveAll: (to: TaskStatus) => void;
	acceptsDrop: boolean;
	onDrop: (taskId: string) => void;
	project: string;
}) {
	const [over, setOver] = useState(false);

	if (collapsed) {
		return (
			<button
				type="button"
				onClick={onToggle}
				aria-expanded={false}
				className="mfw-focus flex w-10 shrink-0 flex-col items-center gap-2 border py-2"
				style={{
					borderColor: "var(--mfw-border)",
					borderRadius: "var(--mfw-radius-md)",
					background: "var(--mfw-bg-subtle)",
					writingMode: "vertical-rl",
				}}
				title={`Expand ${status}`}
			>
				<span style={{ color: "var(--mfw-fg-muted)" }}>
					{status.replace("_", " ")} · {tasks.length}
				</span>
			</button>
		);
	}

	return (
		<section
			aria-label={`${status.replace("_", " ")} column`}
			className={cn("flex w-72 shrink-0 flex-col gap-2 border p-2")}
			style={{
				borderColor: over ? "var(--mfw-accent)" : "var(--mfw-border)",
				borderRadius: "var(--mfw-radius-md)",
				background: over ? "var(--mfw-accent-subtle)" : "var(--mfw-bg-subtle)",
			}}
			onDragOver={
				acceptsDrop
					? (e) => {
							e.preventDefault();
							setOver(true);
						}
					: undefined
			}
			onDragLeave={acceptsDrop ? () => setOver(false) : undefined}
			onDrop={
				acceptsDrop
					? (e) => {
							e.preventDefault();
							setOver(false);
							const id = e.dataTransfer.getData("text/mfw-task");
							if (id) onDrop(id);
						}
					: undefined
			}
		>
			<header className="flex items-center gap-2">
				<StatusPill kind="task" value={status} />
				<span className="mfw-num" style={{ color: "var(--mfw-fg-muted)" }}>
					{tasks.length}
				</span>
				<ColumnMoveControls
					compact
					status={status}
					count={tasks.length}
					previous={previous}
					next={next}
					onMoveAll={onMoveAll}
				/>
				<Button
					size="icon-xs"
					variant="ghost"
					aria-expanded={true}
					aria-label={`Collapse ${status}`}
					onClick={onToggle}
					title={`Collapse ${status}`}
				>
					<ChevronDown aria-hidden />
				</Button>
			</header>
			<div className="flex min-h-20 flex-col gap-2 overflow-y-auto">
				{tasks.map((task) => (
					<TaskCard key={task.id} task={task} project={project} draggable />
				))}
			</div>
		</section>
	);
}

function ColumnMoveControls({
	compact = false,
	status,
	count,
	previous,
	next,
	onMoveAll,
}: {
	compact?: boolean;
	status: TaskStatus;
	count: number;
	previous?: TaskStatus;
	next?: TaskStatus;
	onMoveAll: (to: TaskStatus) => void;
}) {
	// Expansion owns Draft exit and capture owns Draft entry, so adjacent
	// controls stay visible but disabled at those boundaries.
	const canMovePrevious =
		previous !== undefined &&
		previous !== "draft" &&
		previous !== "in_progress";
	const canMoveNext =
		next !== undefined && status !== "draft" && next !== "in_progress";
	const previousTitle =
		previous === "in_progress"
			? "Tasks enter In progress when a run starts"
			: previous === "draft"
				? "Drafts can only be created through capture"
				: previous
					? `Move all shown tasks to ${previous.replace("_", " ")}`
					: "First column";
	const nextTitle =
		next === "in_progress"
			? "Tasks enter In progress when a run starts"
			: status === "draft"
				? "Expansion moves Drafts to their selected destination"
				: next
					? `Move all shown tasks to ${next.replace("_", " ")}`
					: "Last column";
	return (
		<div className={compact ? "ml-auto flex gap-1" : "grid grid-cols-2 gap-1"}>
			<Button
				size={compact ? "icon-xs" : "xs"}
				variant="outline"
				disabled={count === 0 || !canMovePrevious}
				onClick={() => previous && onMoveAll(previous)}
				aria-label={previousTitle}
				title={previousTitle}
			>
				<ChevronLeft aria-hidden />
				{compact ? null : "All"}
			</Button>
			<Button
				size={compact ? "icon-xs" : "xs"}
				variant="outline"
				disabled={count === 0 || !canMoveNext}
				onClick={() => next && onMoveAll(next)}
				aria-label={nextTitle}
				title={nextTitle}
			>
				{compact ? null : "All"}
				<ChevronRight aria-hidden />
			</Button>
		</div>
	);
}

function TaskCard({
	task,
	project,
	draggable,
	onMove,
}: {
	task: Task;
	project: string;
	draggable: boolean;
	onMove?: (to: TaskStatus) => void;
}) {
	const openDeps = task.dependsOn.length;
	const openTask = useOpenTaskFromBoard(project);
	const owned = task.claimedByRunId !== null;
	const locked = owned || task.draftPhase === "waiting_for_answers";
	return (
		<article
			draggable={draggable && !locked}
			onDragStart={(e) => {
				e.dataTransfer.setData("text/mfw-task", task.id);
				e.dataTransfer.effectAllowed = "move";
			}}
			className="flex flex-col gap-1 border border-l-3 p-2"
			style={{
				borderColor: "var(--mfw-border)",
				borderLeftColor: `var(${PRIORITY_TOKEN[task.priority] ?? "--mfw-neutral"})`,
				borderRadius: "var(--mfw-radius-sm)",
				background: "var(--mfw-bg-raised)",
				cursor: draggable && !locked ? "grab" : undefined,
			}}
		>
			<div className="flex items-center gap-2">
				<Mono value={task.id} />
				{task.claimedByRunId ? (
					<span
						className="mfw-pulse inline-flex items-center gap-1"
						style={{
							color: "var(--mfw-status-in-progress)",
							fontSize: "var(--mfw-text-2xs)",
						}}
					>
						{task.status === "draft" ? "expanding" : "working"}{" "}
						<Elapsed since={task.claimedAt ?? task.statusChangedAt} />
					</span>
				) : null}
				<span className="flex-1" />
				{task.size ? <Chip>{task.size}</Chip> : null}
			</div>

			<AppLink
				to={href.task(project, task.id)}
				navigate={() => openTask(task.id)}
				className="line-clamp-2 font-medium"
			>
				{task.title}
			</AppLink>

			<div className="flex flex-wrap items-center gap-1">
				<Chip>{task.type}</Chip>
				{openDeps > 0 ? <Chip tone="info">{openDeps} deps</Chip> : null}
				{task.draftPhase === "waiting_for_answers" ? (
					<button
						type="button"
						className="mfw-focus"
						style={{ background: "none", border: 0, padding: 0 }}
						title="Expansion is paused until you answer its questions"
						onClick={(e) => {
							e.stopPropagation();
							openTask(task.id);
						}}
					>
						<Chip tone="warn">
							<CircleHelp aria-hidden /> Questions · action required
						</Chip>
					</button>
				) : null}
				{/* Task checks are optional: project merge checks always apply. */}
				{task.status === "draft" ? (
					<Chip
						tone={
							task.draftPhase === "failed" ||
							task.draftPhase === "waiting_for_answers"
								? "warn"
								: owned
									? "info"
									: undefined
						}
					>
						{draftPhaseLabel(task.draftPhase, task.draftAttempts)} →{" "}
						{task.afterExpansion}
					</Chip>
				) : task.verification ? (
					<Chip tone="ok">task checks</Chip>
				) : (
					<Chip>project checks</Chip>
				)}
				{task.labels.slice(0, 3).map((label) => (
					<Chip key={label}>{label}</Chip>
				))}
			</div>

			{task.blockedReason ? (
				<span
					className="truncate"
					style={{
						color: "var(--mfw-warn)",
						fontSize: "var(--mfw-text-2xs)",
					}}
					title={task.blockedReason}
				>
					{task.blockedReason}
				</span>
			) : null}

			{onMove ? (
				<select
					aria-label={`Move ${task.id}`}
					className="mfw-focus min-h-9 border px-1"
					style={{
						background: "var(--mfw-bg-subtle)",
						borderColor: "var(--mfw-border)",
						borderRadius: "var(--mfw-radius-sm)",
						color: "var(--mfw-fg-muted)",
						fontSize: "var(--mfw-text-xs)",
					}}
					value={task.status}
					disabled={locked}
					onChange={(e) => onMove(e.target.value as TaskStatus)}
				>
					<option value={task.status}>move to…</option>
					{COLUMNS.filter(
						(status) =>
							status !== task.status &&
							status !== "draft" &&
							status !== "in_progress" &&
							(task.status !== "draft" || status === "archived"),
					).map((status) => (
						<option key={status} value={status}>
							move to {status.replace("_", " ")}
						</option>
					))}
				</select>
			) : null}
		</article>
	);
}

function draftPhaseLabel(phase: Task["draftPhase"], attempts: number): string {
	switch (phase) {
		case "expanding":
			return "expanding";
		case "retrying":
			return `retry queued · ${attempts} failed`;
		case "waiting_for_answers":
			return "waiting for your answers";
		case "failed":
			return "expansion failed";
		default:
			return "queued for expansion";
	}
}
