import {
	keepPreviousData,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import {
	ArrowDownUp,
	Bot,
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	ChevronUp,
	CircleHelp,
	Columns3,
	Plus,
	Rows3,
} from "lucide-react";
import {
	createContext,
	type DragEvent,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
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
import { Tip, TipButton, TipSpan } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { AppLink } from "../../components/AppLink";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Mono } from "../../components/Cost";
import { Empty } from "../../components/Empty";
import { ErrorState } from "../../components/ErrorState";
import {
	Glyph,
	PriorityIcon,
	StatusIcon,
	TaskTypeIcon,
} from "../../components/icons";
import { LoadingRows } from "../../components/Loading";
import { Chip, Page } from "../../components/Page";
import { useNow } from "../../components/RelativeTime";
import type { TaskStatus } from "../../components/StatusPill";
import {
	type BoardLayout,
	DEFAULT_BOARD_LAYOUT,
	readBoardLayout,
	readCollapsedColumns,
	readExpandedEmpty,
	writeBoardLayout,
	writeCollapsedColumns,
	writeExpandedEmpty,
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
import { blockedReasonText } from "../../lib/format";
import { useGo, useOpenTaskFromBoard, useWideViewport } from "../../lib/nav";
import { humanizeError, useToast } from "../../lib/toast";
import type { RouterOutputs } from "../../lib/trpc";
import { useTRPC } from "../../lib/trpc";
import { href } from "../../routes";
import { ScopeMeter } from "../agents/ActivityChip";
import { quantise, ScrubBanner, scrubbedAt } from "../flow/TimeCursor";
import { useLatestVerdicts, VerdictChip } from "../review/VerdictHistory";
import { BrainIntentLine } from "./BrainIntentLine";
import {
	BoardAgentsContext,
	boardAgents,
	runsForTask,
	taskLiveRuns,
	taskNeedsHuman,
	useBoardAgents,
} from "./boardAgents";
import { boardAgentsAt, tasksAt } from "./boardAt";
import { CardAgentStrip } from "./CardAgentStrip";
import {
	CardSubtree,
	isCardToggleKey,
	type OutcomeDetail,
} from "./CardSubtree";
import {
	type BoardColumn,
	boardColumns,
	bulkMoveTarget,
	type ColumnViewOptions,
	columnCounts,
	columnView,
	defaultCollapsed,
	dropVerdict,
	isColumnCollapsed,
	tasksByColumn,
	toggleColumnState,
} from "./columns";
import {
	isFocusKey,
	LANE,
	laneChrome,
	laneSizes,
	laneTile,
	SPACE,
	scrollLeftToReveal,
	stepFocus,
	tileMetrics,
	wheelScrollLeft,
} from "./lanes";
import { OwnershipConflictNotice } from "./OwnershipConflictNotice";

/** Board. Drag moves a task, optimistically; rolls back with the server's reason if the DoR gate refuses. Phones get a status menu instead of drag. */

type Task = RouterOutputs["tasks"]["list"][number];

/** The latest reviewer verdict per task: one query for the board, read by every card. */
type Verdicts = ReturnType<typeof useLatestVerdicts>["data"];
const VerdictsContext = createContext<Verdicts>(undefined);

/** The types offered by the filter when `board.schema` has not said (or declares none). */
const DEFAULT_TYPES = ["implementation", "spike", "epic", "maintenance"];

export interface BoardFilters {
	q?: string;
	label?: string;
	priority?: string;
	type?: string;
	/** `review`: only tasks waiting on a person's review (the `gate:review` filter). */
	gate?: "review";
}

/** Tasks awaiting human review: the `gate:review` filter and the header's "N to review". */
export function isAwaitingReview(task: { status: string }): boolean {
	return task.status === "review";
}

/** The toolbar's filters (and the `gate:review` gate) applied to the board's tasks. */
export function filterBoardTasks<
	T extends {
		id: string;
		title: string;
		labels: string[];
		priority: string;
		type: string;
		status: string;
	},
>(rows: readonly T[], filters: BoardFilters): T[] {
	const q = filters.q?.trim().toLowerCase();
	return rows.filter((t) => {
		if (q && !`${t.id} ${t.title}`.toLowerCase().includes(q)) return false;
		if (filters.label && !t.labels.includes(filters.label)) return false;
		if (filters.priority && t.priority !== filters.priority) return false;
		if (filters.type && t.type !== filters.type) return false;
		if (filters.gate === "review" && !isAwaitingReview(t)) return false;
		return true;
	});
}

export function BoardPage({
	project,
	filters,
	onFilters,
	at,
	onLive,
	selectedTask = null,
}: {
	project: string;
	filters: BoardFilters;
	onFilters: (next: BoardFilters) => void;
	/** The task open in the docked inspector (`?node=task:ID`): drawn selected, kept in view. */
	selectedTask?: string | null;
	/** The `t` search value: a past instant shows the board as it was, read-only. */
	at?: string | undefined;
	/** Clear `t` (the banner's "Back to live"). */
	onLive?: () => void;
}) {
	const trpc = useTRPC();
	const queryClient = useQueryClient();
	const { toast } = useToast();
	const wide = useWideViewport();
	const liveTasks = useQuery(trpc.tasks.list.queryOptions({ project }));
	// Scrubbed: the cards are the tasks as they stood at t (`flow.at`), and
	// nothing on the board can be moved: you cannot steer the past.
	const now = useNow();
	const scrubAt = scrubbedAt(at, now);
	const readOnly = scrubAt !== null;
	const atTree = useQuery({
		...trpc.flow.at.queryOptions({
			project,
			t: new Date(quantise(scrubAt ?? 0)),
		}),
		enabled: readOnly,
		placeholderData: keepPreviousData,
		staleTime: 60_000,
	});
	const taskData = useMemo(
		() =>
			readOnly
				? atTree.data
					? tasksAt(liveTasks.data ?? [], atTree.data.nodes)
					: undefined
				: liveTasks.data,
		[readOnly, atTree.data, liveTasks.data],
	);
	const tasks = {
		isLoading: liveTasks.isLoading || (readOnly && atTree.isLoading),
		error: liveTasks.error ?? (readOnly ? atTree.error : null),
		refetch: () => {
			void liveTasks.refetch();
			if (readOnly) void atTree.refetch();
		},
		data: taskData,
	};
	// Shared caches (the dock and the inbox hold them too): no request per card.
	const activeRuns = useQuery(trpc.runs.active.queryOptions());
	const openQuestions = useQuery(trpc.clarify.open.queryOptions());
	// One query for every card's history pips (never one per card).
	const pips = useQuery(trpc.runs.pipsByTask.queryOptions({ project }));
	// One query for the brain's standing intent per task: a project with no
	// brain returns an empty list, so cards simply show no line.
	const intents = useQuery(trpc.brain.intents.queryOptions({ project }));
	const verdicts = useLatestVerdicts(project);
	const schema = useQuery(trpc.board.schema.queryOptions({ project }));
	const agents = useMemo(
		() =>
			readOnly
				? boardAgentsAt(project, atTree.data?.nodes ?? [])
				: boardAgents(
						project,
						activeRuns.data,
						openQuestions.data,
						pips.data,
						intents.data,
					),
		[
			readOnly,
			atTree.data,
			project,
			activeRuns.data,
			openQuestions.data,
			pips.data,
			intents.data,
		],
	);
	const columns = useMemo(
		() => boardColumns(schema.data?.statuses),
		[schema.data],
	);
	const typeOptions = useMemo(() => {
		const declared = schema.data?.types.map((t) => t.value) ?? [];
		return declared.length > 0 ? declared : DEFAULT_TYPES;
	}, [schema.data]);
	// SSR-safe default, corrected on mount (as in useTheme()): reading
	// localStorage during render would mismatch server and client markup.
	const [collapsedColumns, setCollapsedColumns] = useState<Set<string>>(
		() => new Set(defaultCollapsed(columns)),
	);
	const [boardSort, setBoardSort] = useState<BoardSort>(DEFAULT_BOARD_SORT);
	useEffect(() => setBoardSort(readBoardSort()), []);
	// Per project, like the collapsed set; the default until mount corrects it.
	const [layout, setLayout] = useState<BoardLayout>(DEFAULT_BOARD_LAYOUT);
	useEffect(() => setLayout(readBoardLayout(project)), [project]);
	const chooseLayout = (next: BoardLayout) => {
		setLayout(next);
		writeBoardLayout(project, next);
	};
	// Columns with no tasks are rails; these are the empty ones opened on purpose.
	const [expandedEmpty, setExpandedEmpty] = useState<Set<string>>(
		() => new Set(),
	);
	useEffect(() => {
		const stored = readCollapsedColumns(project);
		setCollapsedColumns(new Set(stored ?? defaultCollapsed(columns)));
		setExpandedEmpty(new Set(readExpandedEmpty(project)));
	}, [project, columns]);
	const toggleColumn = useCallback(
		(status: string, taskCount: number) => {
			const next = toggleColumnState(
				status,
				taskCount,
				collapsedColumns,
				expandedEmpty,
			);
			setCollapsedColumns(next.collapsed);
			setExpandedEmpty(next.expandedEmpty);
			writeCollapsedColumns(project, [...next.collapsed]);
			writeExpandedEmpty(project, [...next.expandedEmpty]);
		},
		[project, collapsedColumns, expandedEmpty],
	);
	const [mobilePick, setMobileStatus] = useState<string | null>(null);
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
	/** Set when closing a task whose branch never merged: offer "save to wip/ and close". */
	const [unmergedClose, setUnmergedClose] = useState<{
		id: string;
		to: TaskStatus;
		reason?: string;
		message: string;
	} | null>(null);
	const [bulkMove, setBulkMove] = useState<{
		from: BoardColumn;
		to: BoardColumn;
		ids: string[];
	} | null>(null);

	const rows = useMemo(() => tasks.data ?? [], [tasks.data]);

	const labels = useMemo(() => {
		const set = new Set<string>();
		for (const t of rows) for (const l of t.labels) set.add(l);
		return [...set].sort();
	}, [rows]);

	const filtered = useMemo(
		() => filterBoardTasks(rows, filters),
		[rows, filters],
	);
	const toReview = useMemo(() => rows.filter(isAwaitingReview).length, [rows]);
	const sorted = useMemo(
		() => sortBoardTasks(filtered, boardSort),
		[filtered, boardSort],
	);

	const isFiltered = Boolean(
		filters.q ||
			filters.label ||
			filters.priority ||
			filters.type ||
			filters.gate,
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
				const data = (
					error as { data?: { code?: string; domainError?: string | null } }
				).data;
				if (data?.domainError === "TaskUnmergedError" && !vars.discard) {
					setUnmergedClose({
						id: vars.id,
						to: vars.to,
						reason: vars.reason,
						message: error.message,
					});
					return;
				}
				// Run still live: offer cancel-then-move. This runId is display-only; the
				// server re-derives the claim on confirm, so a stale read cannot misfire.
				const code = data?.code;
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
							? `${result.skipped.length} stayed in ${vars.from.replace("_", " ")} because they changed, are still running or have unmerged work.`
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
				setMobileStatus(
					columns.find((c) => c.role === task.status && c.writable)?.value ??
						null,
				);
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

	const byColumn = useMemo(
		() => tasksByColumn(columns, sorted),
		[columns, sorted],
	);
	const columnTasks = (value: string) => byColumn.get(value) ?? [];
	// Unpicked, land on a column that has tasks: "Nothing in ready" over a
	// board whose four tasks sit in backlog reads as an empty board.
	const mobileStatus =
		(
			columns.find((c) => c.value === mobilePick) ??
			columns.find(
				(c) => c.role === "ready" && columnTasks(c.value).length > 0,
			) ??
			columns.find((c) => columnTasks(c.value).length > 0) ??
			columns.find((c) => c.role === "ready") ??
			columns[0]
		)?.value ?? "";
	const mobileIndex = columns.findIndex((c) => c.value === mobileStatus);
	const mobileColumn = columns[mobileIndex];
	const requestBulkMove = (from: BoardColumn, to: BoardColumn) => {
		if (readOnly) return;
		const ids = columnTasks(from.value).map((task) => task.id);
		if (ids.length > 0) setBulkMove({ from, to, ids });
	};
	/** A drop on a column: refused here, with its reason, when the board cannot take it. */
	const dropOn = (column: BoardColumn, id: string) => {
		if (readOnly) return;
		const task = rows.find((t) => t.id === id);
		if (!task) return;
		if (column.role === task.status && column.writable) return;
		const verdict = dropVerdict(column, task);
		if (!verdict.ok) {
			toast({
				tone: "warning",
				title: `${id} stayed put`,
				description: verdict.reason,
			});
			return;
		}
		if (column.role) move.mutate({ project, id, to: column.role });
	};

	return (
		<BoardAgentsContext.Provider value={agents}>
			<VerdictsContext.Provider value={verdicts.data}>
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
							options={typeOptions}
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
						{toReview > 0 || filters.gate === "review" ? (
							<ReviewChip
								count={toReview}
								active={filters.gate === "review"}
								onToggle={() =>
									onFilters({
										...filters,
										gate: filters.gate === "review" ? undefined : "review",
									})
								}
							/>
						) : null}
						{isFiltered ? (
							<Button size="xs" variant="ghost" onClick={() => onFilters({})}>
								Clear
							</Button>
						) : null}

						{/* Only worth saying when a filter hides something. */}
						{filtered.length !== rows.length ? (
							<span
								className="ml-auto tabular-nums"
								style={{ color: "var(--mfw-fg-muted)" }}
							>
								{filtered.length} of {rows.length} task
								{rows.length === 1 ? "" : "s"}
							</span>
						) : (
							<span className="ml-auto" />
						)}
						{wide ? (
							<LayoutToggle layout={layout} onChange={chooseLayout} />
						) : null}
						{readOnly ? null : composing ? (
							<Button
								type="submit"
								form="quick-capture-task"
								size="sm"
								disabled={
									captureQuick.isPending || captureText.trim().length === 0
								}
							>
								{captureQuick.isPending ? "Creating…" : "Create task"}
							</Button>
						) : (
							<Button size="sm" onClick={() => setComposing(true)}>
								<Plus aria-hidden /> Create task
							</Button>
						)}
					</div>

					{scrubAt !== null ? (
						<ScrubBanner
							at={scrubAt}
							now={now}
							onLive={onLive ?? (() => {})}
							note="Cards are in the columns they had then; nothing can be moved."
						/>
					) : null}

					{composing && !readOnly ? (
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
							title="This board is empty."
							description="Nothing is queued, so no agent has work. Write the first task, or let mfw survey the repository or break a goal into tasks."
							action={
								<span className="flex flex-wrap justify-center gap-2">
									<Button size="sm" onClick={() => setComposing(true)}>
										Create the first task
									</Button>
									<Button size="sm" variant="outline" asChild>
										<AppLink to={`${href.projectSettings(project)}#seed`}>
											Import or plan from the repository
										</AppLink>
									</Button>
								</span>
							}
						/>
					) : filtered.length === 0 ? (
						<Empty
							reason="filtered"
							title="No task matches this filter."
							action={
								<Button
									size="sm"
									variant="outline"
									onClick={() => onFilters({})}
								>
									Clear filters
								</Button>
							}
						/>
					) : wide && layout === "lanes" ? (
						<LaneStack
							project={project}
							readOnly={readOnly}
							selectedTask={selectedTask}
							items={columns.map((column, index) => ({
								column,
								tasks: columnTasks(column.value),
								collapsed: isColumnCollapsed(
									column.value,
									columnTasks(column.value).length,
									collapsedColumns,
									expandedEmpty,
								),
								previous: columns[index - 1],
								next: columns[index + 1],
							}))}
							onToggle={(column, count) => toggleColumn(column.value, count)}
							onMoveAll={requestBulkMove}
							onDrop={dropOn}
						/>
					) : wide ? (
						<div className="flex min-h-0 flex-1 gap-2 overflow-x-auto p-3">
							{columns.map((column, index) => (
								<Column
									key={column.value}
									column={column}
									tasks={columnTasks(column.value)}
									collapsed={isColumnCollapsed(
										column.value,
										columnTasks(column.value).length,
										collapsedColumns,
										expandedEmpty,
									)}
									onToggle={() =>
										toggleColumn(column.value, columnTasks(column.value).length)
									}
									previous={columns[index - 1]}
									next={columns[index + 1]}
									onMoveAll={(to) => requestBulkMove(column, to)}
									onDrop={(id) => dropOn(column, id)}
									project={project}
									readOnly={readOnly}
								/>
							))}
						</div>
					) : (
						<div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
							<div className="flex flex-wrap gap-1">
								{columns.map((column) => (
									<button
										key={column.value}
										type="button"
										aria-pressed={column.value === mobileStatus}
										onClick={() => setMobileStatus(column.value)}
										className="mfw-focus inline-flex min-h-9 items-center gap-1 border px-2"
										style={{
											borderColor:
												column.value === mobileStatus
													? "var(--mfw-accent)"
													: "var(--mfw-border)",
											color:
												column.value === mobileStatus
													? "var(--mfw-accent)"
													: "var(--mfw-fg-muted)",
											borderRadius: "var(--mfw-radius-sm)",
											fontSize: "var(--mfw-text-xs)",
										}}
									>
										<StatusIcon
											statusRole={column.role}
											value={column.value}
											label={column.label}
										/>
										{column.label} {columnTasks(column.value).length}
									</button>
								))}
							</div>
							<div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto">
								{mobileColumn && !readOnly ? (
									<ColumnMoveControls
										column={mobileColumn}
										count={columnTasks(mobileColumn.value).length}
										previous={columns[mobileIndex - 1]}
										next={columns[mobileIndex + 1]}
										onMoveAll={(to) => requestBulkMove(mobileColumn, to)}
									/>
								) : null}
								{columnTasks(mobileStatus).map((task) => (
									<TaskCard
										key={task.id}
										task={task}
										project={project}
										draggable={false}
										{...(readOnly
											? {}
											: {
													moveOptions: columns.filter(
														(c) =>
															c.role !== task.status && dropVerdict(c, task).ok,
													),
													onMove: (to: TaskStatus) =>
														move.mutate({ project, id: task.id, to }),
												})}
									/>
								))}
								{columnTasks(mobileStatus).length === 0 ? (
									<Empty
										title={`Nothing in ${mobileColumn?.label.toLowerCase() ?? "this column"}.`}
									/>
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
								? `Move ${bulkMove.ids.length} task${bulkMove.ids.length === 1 ? "" : "s"} to ${bulkMove.to.label}?`
								: ""
						}
						description={
							bulkMove
								? `This moves every task currently shown in ${bulkMove.from.label}. Tasks that start running or change columns before confirmation will stay put.`
								: null
						}
						confirmLabel="Move all"
						pending={moveMany.isPending}
						onConfirm={() => {
							if (bulkMove?.from.role && bulkMove.to.role)
								moveMany.mutate({
									project,
									ids: bulkMove.ids,
									from: bulkMove.from.role,
									to: bulkMove.to.role,
								});
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
									{claimConflict.to.replace("_", " ")}; committed work on its
									branch is kept.
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
					<ConfirmDialog
						open={unmergedClose !== null}
						onOpenChange={(open) => {
							if (!open) setUnmergedClose(null);
						}}
						title={unmergedClose ? `${unmergedClose.id} has unmerged work` : ""}
						description={
							unmergedClose ? (
								<>
									{unmergedClose.message}. Approve it from Review to merge it,
									or discard: the work is saved to a <Mono value="wip/" />{" "}
									branch, the run branch is deleted and the task moves to{" "}
									{unmergedClose.to.replace("_", " ")}.
								</>
							) : null
						}
						confirmLabel="Save to wip/ and close"
						pending={move.isPending}
						onConfirm={() => {
							if (!unmergedClose) return;
							move.mutate({
								project,
								id: unmergedClose.id,
								to: unmergedClose.to,
								reason: unmergedClose.reason,
								discard: true,
							});
							setUnmergedClose(null);
						}}
					/>
				</Page>
			</VerdictsContext.Provider>
		</BoardAgentsContext.Provider>
	);
}

/** Lanes | Columns: the board's layout, remembered per project. */
export function LayoutToggle({
	layout,
	onChange,
}: {
	layout: BoardLayout;
	onChange: (next: BoardLayout) => void;
}) {
	return (
		<fieldset
			aria-label="Board layout"
			className="m-0 inline-flex border-0 p-0"
		>
			{(
				[
					["lanes", "Lanes", Rows3],
					["columns", "Columns", Columns3],
				] as const
			).map(([value, label, Icon]) => (
				<Button
					key={value}
					size="xs"
					variant={layout === value ? "default" : "outline"}
					aria-pressed={layout === value}
					className={value === "lanes" ? "rounded-r-none" : "rounded-l-none"}
					onClick={() => onChange(value)}
				>
					<Icon aria-hidden />
					{label}
				</Button>
			))}
		</fieldset>
	);
}

/** "3 to review": how many tasks wait on a person, and the `gate:review` filter toggle. */
export function ReviewChip({
	count,
	active,
	onToggle,
}: {
	count: number;
	active: boolean;
	onToggle: () => void;
}) {
	return (
		<Button
			size="xs"
			variant={active ? "default" : "outline"}
			aria-pressed={active}
			title={
				active ? "Show every task again" : "Show only tasks waiting on review"
			}
			onClick={onToggle}
		>
			<StatusIcon statusRole="review" value="review" label="review" />
			{count} to review
		</Button>
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

/** The column header's "live" and "needs you" counts, drawn only when non-zero. */
export function ColumnSignals({
	live,
	needs,
}: {
	live: number;
	needs: number;
}) {
	if (live === 0 && needs === 0) return null;
	return (
		<span
			className="mfw-num inline-flex items-center gap-1.5"
			style={{ fontSize: "var(--mfw-text-xs)" }}
		>
			{live > 0 ? (
				<TipSpan
					role="img"
					aria-label={`${live} live ${live === 1 ? "run" : "runs"}`}
					tip={`${live} live ${live === 1 ? "run" : "runs"}`}
					style={{ color: "var(--mfw-status-in-progress)" }}
				>
					<Glyph name="dot" className="mr-1 inline size-2.5 align-[-1px]" />
					{live}
				</TipSpan>
			) : null}
			{needs > 0 ? (
				<TipSpan
					role="img"
					aria-label={`${needs} ${needs === 1 ? "task needs" : "tasks need"} you`}
					tip={`${needs} ${needs === 1 ? "task needs" : "tasks need"} you`}
					style={{ color: "var(--mfw-warn)" }}
				>
					<Glyph name="needs" className="mr-1 inline size-3 align-[-2px]" />
					{needs}
				</TipSpan>
			) : null}
		</span>
	);
}

export function Column({
	column,
	tasks,
	collapsed,
	onToggle,
	previous,
	next,
	onMoveAll,
	onDrop,
	project,
	readOnly = false,
}: {
	column: BoardColumn;
	tasks: Task[];
	collapsed: boolean;
	onToggle: () => void;
	previous?: BoardColumn;
	next?: BoardColumn;
	onMoveAll: (to: BoardColumn) => void;
	onDrop: (taskId: string) => void;
	project: string;
	/** The board is scrubbed to a past instant: no drops, no drags, no bulk moves. */
	readOnly?: boolean;
}) {
	const [over, setOver] = useState(false);
	const { counts, view, setView, shown } = useColumnView(tasks, project);
	const refuses = columnRefusesDrops(column);

	if (collapsed) {
		return (
			<button
				type="button"
				onClick={onToggle}
				aria-expanded={false}
				data-drop={readOnly ? "readonly" : refuses ? "refused" : "open"}
				className="mfw-focus flex w-9 shrink-0 flex-col items-center gap-2 border py-2"
				style={{
					borderColor: over
						? refuses
							? "var(--mfw-warn)"
							: "var(--mfw-accent)"
						: "var(--mfw-border)",
					borderRadius: "var(--mfw-radius-md)",
					background:
						over && !refuses
							? "var(--mfw-accent-subtle)"
							: "var(--mfw-bg-subtle)",
				}}
				onDragOver={(e) => {
					if (readOnly) return;
					e.preventDefault();
					setOver(true);
				}}
				onDragLeave={() => setOver(false)}
				onDrop={(e) => {
					if (readOnly) return;
					e.preventDefault();
					setOver(false);
					const id = e.dataTransfer.getData("text/mfw-task");
					if (id) onDrop(id);
				}}
				aria-label={`Expand ${column.label}, ${tasks.length} tasks`}
			>
				<StatusIcon
					statusRole={column.role}
					value={column.value}
					label={column.label}
				/>
				<span className="mfw-num" style={{ color: "var(--mfw-fg-muted)" }}>
					{tasks.length}
				</span>
				<span
					style={{
						color: "var(--mfw-fg-muted)",
						writingMode: "vertical-rl",
					}}
				>
					{column.label}
				</span>
				{counts.needs > 0 ? (
					<span
						role="img"
						aria-label={`${counts.needs} ${counts.needs === 1 ? "task needs" : "tasks need"} you`}
						className="mfw-num"
						style={{ color: "var(--mfw-warn)" }}
					>
						<Glyph name="needs" className="mr-1 inline size-3 align-[-2px]" />
						{counts.needs}
					</span>
				) : null}
			</button>
		);
	}

	return (
		<section
			aria-label={`${column.label} column`}
			data-drop={readOnly ? "readonly" : refuses ? "refused" : "open"}
			className={cn(
				"flex min-w-48 max-w-[28rem] flex-1 basis-60 flex-col gap-2 border p-2",
			)}
			style={{
				borderColor: over
					? refuses
						? "var(--mfw-warn)"
						: "var(--mfw-accent)"
					: "var(--mfw-border)",
				borderRadius: "var(--mfw-radius-md)",
				background:
					over && !refuses
						? "var(--mfw-accent-subtle)"
						: "var(--mfw-bg-subtle)",
			}}
			onDragOver={(e) => {
				if (readOnly) return;
				e.preventDefault();
				setOver(true);
			}}
			onDragLeave={() => setOver(false)}
			onDrop={(e) => {
				if (readOnly) return;
				e.preventDefault();
				setOver(false);
				const id = e.dataTransfer.getData("text/mfw-task");
				if (id) onDrop(id);
			}}
		>
			<header className="flex items-center gap-2">
				<span className="inline-flex items-center gap-1.5 font-medium">
					<StatusIcon
						statusRole={column.role}
						value={column.value}
						label={column.label}
					/>
					{column.label}
				</span>
				<span className="mfw-num" style={{ color: "var(--mfw-fg-muted)" }}>
					{counts.total}
				</span>
				<ColumnSignals live={counts.live} needs={counts.needs} />
				<ColumnMoveControls
					compact
					readOnly={readOnly}
					column={column}
					count={tasks.length}
					previous={previous}
					next={next}
					onMoveAll={onMoveAll}
				/>
				<ColumnMenu label={column.label} view={view} setView={setView} />
				<Button
					size="icon-xs"
					className="size-5"
					variant="ghost"
					aria-expanded={true}
					aria-label={`Collapse ${column.label}`}
					onClick={onToggle}
				>
					<ChevronDown aria-hidden />
				</Button>
			</header>
			<div className="flex min-h-20 flex-col gap-2 overflow-y-auto">
				{shown.map((task) => (
					<TaskCard
						key={task.id}
						task={task}
						project={project}
						draggable={!readOnly}
					/>
				))}
				{view.onlyAgents && shown.length === 0 && tasks.length > 0 ? (
					<span style={{ color: "var(--mfw-fg-muted)" }}>
						No agents here right now.
					</span>
				) : null}
			</div>
		</section>
	);
}

/**
 * What a status shows, for both layouts: its header counts and the tasks left
 * after the column menu's two switches (design §6.1; view-only, never changes
 * what a bulk move touches).
 */
function useColumnView(tasks: Task[], project: string) {
	const agents = useBoardAgents();
	const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
	const counts = columnCounts(tasks, {
		liveRuns: (id) => {
			const task = byId.get(id);
			return task ? taskLiveRuns(agents, task) : 0;
		},
		needsHuman: (id) => {
			const task = byId.get(id);
			return task ? taskNeedsHuman(agents, project, task) : false;
		},
	});
	const [view, setView] = useState<ColumnViewOptions>({
		onlyAgents: false,
		byActivity: false,
	});
	const shown = columnView(tasks, view, {
		liveRuns: (t) => taskLiveRuns(agents, t),
		needsHuman: (t) => taskNeedsHuman(agents, project, t),
	});
	return { counts, view, setView, shown };
}

/**
 * A column the board can never take a drop on still receives the drop, so the
 * person is told why instead of the card silently snapping back.
 */
function columnRefusesDrops(column: BoardColumn): boolean {
	return column.role === null || !column.writable
		? true
		: !dropVerdict(column, { status: "ready" }).ok;
}

/** The drag-over highlight and the handlers of one drop target (a column or a lane, collapsed or not). */
function useDropTarget(readOnly: boolean, onDrop: (taskId: string) => void) {
	const [over, setOver] = useState(false);
	return {
		over,
		handlers: {
			onDragOver: (e: DragEvent) => {
				if (readOnly) return;
				e.preventDefault();
				setOver(true);
			},
			onDragLeave: () => setOver(false),
			onDrop: (e: DragEvent) => {
				if (readOnly) return;
				e.preventDefault();
				setOver(false);
				const id = e.dataTransfer.getData("text/mfw-task");
				if (id) onDrop(id);
			},
		},
	};
}

/** A column or lane header's two view switches, each its own icon: "Only with agents", "Sort by activity". */
function ColumnMenu({
	label,
	view,
	setView,
}: {
	label: string;
	view: ColumnViewOptions;
	setView: (update: (v: ColumnViewOptions) => ColumnViewOptions) => void;
	/** Kept for callers; the switches are inline, so there is no popup to place. */
	placement?: "down" | "up";
}) {
	return (
		<div className="flex items-center gap-1">
			<Tip label="Only tasks with agents" side="bottom">
				<Button
					size="icon-xs"
					className="size-5"
					variant={view.onlyAgents ? "secondary" : "ghost"}
					aria-pressed={view.onlyAgents}
					aria-label={`${label}: only with agents`}
					onClick={() => setView((v) => ({ ...v, onlyAgents: !v.onlyAgents }))}
				>
					<Bot aria-hidden />
				</Button>
			</Tip>
			<Tip label="Sort by activity" side="bottom">
				<Button
					size="icon-xs"
					className="size-5"
					variant={view.byActivity ? "secondary" : "ghost"}
					aria-pressed={view.byActivity}
					aria-label={`${label}: sort by activity`}
					onClick={() => setView((v) => ({ ...v, byActivity: !v.byActivity }))}
				>
					<ArrowDownUp aria-hidden />
				</Button>
			</Tip>
		</div>
	);
}

/** One status of the lanes layout, as the stack draws it. */
export interface LaneItem {
	column: BoardColumn;
	tasks: Task[];
	collapsed: boolean;
	previous?: BoardColumn;
	next?: BoardColumn;
}

/**
 * The lanes layout (design: every status is a full-width swimlane exactly one
 * tile tall; each lane scrolls sideways on its own). The tile height is the
 * stack's measured height shared out over the open lanes (`laneSizes`); when
 * even minimum tiles do not fit, the stack scrolls vertically instead.
 */
export function LaneStack({
	items,
	project,
	readOnly = false,
	selectedTask = null,
	onToggle,
	onMoveAll,
	onDrop,
	height,
}: {
	items: LaneItem[];
	project: string;
	readOnly?: boolean;
	selectedTask?: string | null;
	onToggle: (column: BoardColumn, taskCount: number) => void;
	onMoveAll: (from: BoardColumn, to: BoardColumn) => void;
	onDrop: (column: BoardColumn, taskId: string) => void;
	/** Test seam: the stack's height when there is no layout to measure. */
	height?: number;
}) {
	const stack = useRef<HTMLDivElement>(null);
	const [measured, setMeasured] = useState(height ?? 0);
	useEffect(() => {
		const el = stack.current;
		if (!el) return;
		const read = () => setMeasured(el.clientHeight);
		read();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(read);
		observer.observe(el);
		return () => observer.disconnect();
	}, []);
	const isEmpty = (i: LaneItem) => !i.collapsed && i.tasks.length === 0;
	const empty = items.filter(isEmpty).length;
	const open = items.filter((i) => !i.collapsed && !isEmpty(i)).length;
	const sizes = laneSizes({
		available: measured,
		open,
		collapsed: items.length - open - empty,
		empty,
	});
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: arrow keys bubble up from the focusable cards inside; the handler only acts on those
		<div
			ref={stack}
			data-lane-stack
			data-tile-height={sizes.tile}
			className="flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto"
			style={{
				gap: LANE.GAP,
				padding: `${LANE.STACK_PAD / 2}px 12px`,
			}}
			onKeyDown={(e) => {
				if (
					!isFocusKey(e.key) ||
					e.altKey ||
					e.ctrlKey ||
					e.metaKey ||
					e.shiftKey
				)
					return;
				const target = e.target as HTMLElement;
				if (!target.hasAttribute?.("data-card")) return;
				const lists = [
					...e.currentTarget.querySelectorAll<HTMLElement>("[data-lane-strip]"),
				].map((strip) => [
					...strip.querySelectorAll<HTMLElement>(":scope > [data-card]"),
				]);
				const lane = lists.findIndex((l) => l.includes(target));
				if (lane < 0) return;
				const to = stepFocus(
					lists.map((l) => l.length),
					{ lane, index: lists[lane]?.indexOf(target) ?? 0 },
					e.key,
				);
				const next = to ? lists[to.lane]?.[to.index] : undefined;
				if (!next) return;
				e.preventDefault();
				next.focus();
				next.scrollIntoView({ block: "nearest", inline: "nearest" });
			}}
		>
			{items.map((item, index) => (
				<Lane
					key={item.column.value}
					column={item.column}
					tasks={item.tasks}
					collapsed={item.collapsed}
					previous={item.previous}
					next={item.next}
					onToggle={() => onToggle(item.column, item.tasks.length)}
					onMoveAll={(to) => onMoveAll(item.column, to)}
					onDrop={(id) => onDrop(item.column, id)}
					project={project}
					readOnly={readOnly}
					tile={sizes.tile}
					menuPlacement={index < 3 ? "down" : "up"}
					selectedTask={selectedTask}
				/>
			))}
		</div>
	);
}

/** One status as a horizontal swimlane: a fixed header gutter, then a strip of tiles that scrolls on its own. */
export function Lane({
	column,
	tasks,
	collapsed,
	onToggle,
	previous,
	next,
	onMoveAll,
	onDrop,
	project,
	readOnly = false,
	tile: budget,
	menuPlacement = "down",
	selectedTask = null,
}: {
	column: BoardColumn;
	tasks: Task[];
	collapsed: boolean;
	onToggle: () => void;
	previous?: BoardColumn;
	next?: BoardColumn;
	onMoveAll: (to: BoardColumn) => void;
	onDrop: (taskId: string) => void;
	project: string;
	readOnly?: boolean;
	/** The tile height the stack can give this lane; it takes what its titles need, no more. */
	tile: number;
	menuPlacement?: "down" | "up";
	selectedTask?: string | null;
}) {
	const { over, handlers } = useDropTarget(readOnly, onDrop);
	const { counts, view, setView, shown } = useColumnView(tasks, project);
	const refuses = columnRefusesDrops(column);
	const strip = useRef<HTMLDivElement>(null);

	// A wheel over the lane scrolls it sideways while it can; at its edge (or when
	// nothing overflows) the page keeps the wheel. Native listener: React's
	// onWheel is passive and could not prevent the vertical scroll.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the strip only exists while the lane is open, so the listener is re-attached when it toggles
	useEffect(() => {
		const el = strip.current;
		if (!el) return;
		const onWheel = (e: WheelEvent) => {
			const to = wheelScrollLeft({
				deltaX: e.deltaX,
				deltaY: e.deltaY,
				scrollLeft: el.scrollLeft,
				scrollWidth: el.scrollWidth,
				clientWidth: el.clientWidth,
			});
			if (to === null) return;
			e.preventDefault();
			el.scrollLeft = to;
		};
		el.addEventListener("wheel", onWheel, { passive: false });
		return () => el.removeEventListener("wheel", onWheel);
	}, [collapsed]);

	// The selected card (the docked inspector's task) stays in view.
	const hasSelected =
		selectedTask !== null && shown.some((t) => t.id === selectedTask);
	useEffect(() => {
		const el = strip.current;
		if (!el || !hasSelected) return;
		const card = [...el.children].find(
			(c): c is HTMLElement =>
				c instanceof HTMLElement && c.dataset.task === selectedTask,
		);
		if (!card) return;
		el.scrollLeft = scrollLeftToReveal({
			scrollLeft: el.scrollLeft,
			viewport: el.clientWidth,
			left: card.offsetLeft,
			width: card.offsetWidth,
		});
	}, [hasSelected, selectedTask]);

	// The scrollbar only costs height while the strip really overflows, so an
	// uncluttered lane keeps equal padding above and below its tiles.
	const [overflows, setOverflows] = useState(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-measured when the lane toggles or its tiles change
	useEffect(() => {
		const el = strip.current;
		if (!el) return;
		const read = () => setOverflows(el.scrollWidth > el.clientWidth + 1);
		read();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(read);
		observer.observe(el);
		return () => observer.disconnect();
	}, [collapsed, shown.length]);
	const empty = tasks.length === 0;
	const agents = useBoardAgents();
	const hasMeta = shown.some(
		(t) =>
			t.labels.length > 0 ||
			Boolean(t.blockedReason) ||
			t.status === "draft" ||
			runsForTask(agents, t).length > 0 ||
			(agents.pips[t.id]?.length ?? 0) > 0 ||
			agents.intents.has(t.id),
	);
	const tile = laneTile(
		budget,
		shown.map((t) => t.title),
		hasMeta,
	);
	const laneHeight = empty ? LANE.EMPTY_OPEN : tile + laneChrome(overflows);

	const dropState = readOnly ? "readonly" : refuses ? "refused" : "open";
	const frame = {
		borderColor: over
			? refuses
				? "var(--mfw-warn)"
				: "var(--mfw-accent)"
			: "var(--mfw-border)",
		borderRadius: "var(--mfw-radius-md)",
		background:
			over && !refuses ? "var(--mfw-accent-subtle)" : "var(--mfw-bg-subtle)",
	};

	if (collapsed) {
		return (
			<button
				type="button"
				onClick={onToggle}
				aria-expanded={false}
				data-lane-collapsed
				data-drop={dropState}
				className="mfw-focus flex w-full shrink-0 items-center gap-2 border text-left"
				style={{
					...frame,
					height: LANE.COLLAPSED,
					padding: `0 ${SPACE.PAD_X}px`,
				}}
				aria-label={`Expand ${column.label}, ${tasks.length} tasks`}
				{...handlers}
			>
				{/* Same spot as the open lane's collapse button. */}
				<span className="flex size-5 shrink-0 items-center justify-center">
					<ChevronRight
						aria-hidden
						className="size-3.5"
						style={{ color: "var(--mfw-fg-muted)" }}
					/>
				</span>
				<StatusIcon
					statusRole={column.role}
					value={column.value}
					label={column.label}
				/>
				<span className="font-medium" style={{ color: "var(--mfw-fg-muted)" }}>
					{column.label}
				</span>
				<span className="mfw-num" style={{ color: "var(--mfw-fg-muted)" }}>
					{tasks.length}
				</span>
				<ColumnSignals live={counts.live} needs={counts.needs} />
			</button>
		);
	}

	const collapseButton = (
		<Button
			size="icon-xs"
			className="size-5 shrink-0"
			variant="ghost"
			aria-expanded={true}
			aria-label={`Collapse ${column.label}`}
			onClick={onToggle}
		>
			<ChevronDown aria-hidden />
		</Button>
	);

	return (
		<section
			aria-label={`${column.label} lane`}
			data-lane
			data-drop={dropState}
			className="flex shrink-0 border"
			style={{ ...frame, height: laneHeight }}
			{...handlers}
		>
			<header
				className="flex shrink-0 flex-col justify-center border-r"
				style={{
					width: LANE.GUTTER,
					borderColor: "var(--mfw-border)",
					padding: `${SPACE.PAD_Y}px ${SPACE.PAD_X}px`,
					gap: SPACE.ROW_GAP,
				}}
			>
				<div
					className="flex min-w-0 items-center gap-1.5"
					style={{ height: SPACE.ROW_H }}
				>
					{collapseButton}
					<StatusIcon
						statusRole={column.role}
						value={column.value}
						label={column.label}
					/>
					<TipSpan
						className="min-w-0 truncate font-medium"
						tip={column.label}
						clipped
					>
						{column.label}
					</TipSpan>
					<span className="mfw-num" style={{ color: "var(--mfw-fg-muted)" }}>
						{counts.total}
					</span>
					<ColumnSignals live={counts.live} needs={counts.needs} />
				</div>
				{empty ? null : (
					<div
						className="flex items-center gap-2"
						style={{ height: SPACE.ROW_H }}
					>
						<ColumnMoveControls
							compact
							vertical
							readOnly={readOnly}
							column={column}
							count={tasks.length}
							previous={previous}
							next={next}
							onMoveAll={onMoveAll}
						/>
						<ColumnMenu
							label={column.label}
							view={view}
							setView={setView}
							placement={menuPlacement}
						/>
					</div>
				)}
			</header>
			<div
				ref={strip}
				data-lane-strip
				className="relative flex min-w-0 flex-1 items-center overflow-x-auto overflow-y-hidden"
				style={{
					gap: LANE.TILE_GAP,
					padding: `${LANE.STRIP_PAD_Y}px ${LANE.TILE_GAP}px`,
					scrollbarWidth: "thin",
				}}
			>
				{shown.map((task) => (
					<TaskCard
						key={task.id}
						task={task}
						project={project}
						draggable={!readOnly}
						tile={{ height: tile }}
						selected={task.id === selectedTask}
					/>
				))}
				{tasks.length === 0 ? null : view.onlyAgents && shown.length === 0 ? (
					<span
						className="shrink-0 whitespace-nowrap"
						style={{ color: "var(--mfw-fg-muted)" }}
					>
						No agents here right now.
					</span>
				) : null}
			</div>
		</section>
	);
}

function ColumnMoveControls({
	compact = false,
	vertical = false,
	column,
	count,
	previous,
	next,
	onMoveAll,
	readOnly = false,
}: {
	compact?: boolean;
	/** Lanes stack top to bottom, so "previous"/"next" point up/down, not left/right. */
	vertical?: boolean;
	readOnly?: boolean;
	column: BoardColumn;
	count: number;
	previous?: BoardColumn;
	next?: BoardColumn;
	onMoveAll: (to: BoardColumn) => void;
}) {
	// The drop rules decide: Expansion owns Draft exit, capture owns Draft
	// entry, runs own In progress. Controls stay visible but disabled with the
	// reason as their title.
	const prev = bulkMoveTarget(column, previous, "previous");
	const nxt = bulkMoveTarget(column, next, "next");
	const previousTitle = prev.ok
		? `Move all shown tasks to ${previous?.label}`
		: prev.title;
	const nextTitle = nxt.ok
		? `Move all shown tasks to ${next?.label}`
		: nxt.title;
	return (
		<div
			className={
				compact
					? cn("flex gap-1", !vertical && "ml-auto")
					: "grid grid-cols-2 gap-1"
			}
		>
			<Button
				size={compact ? "icon-xs" : "xs"}
				className={compact ? "size-5" : undefined}
				variant="outline"
				disabled={readOnly || count === 0 || !prev.ok}
				onClick={() => previous && onMoveAll(previous)}
				aria-label={previousTitle}
				title={previousTitle}
			>
				{vertical ? <ChevronUp aria-hidden /> : <ChevronLeft aria-hidden />}
				{compact ? null : "All"}
			</Button>
			<Button
				size={compact ? "icon-xs" : "xs"}
				className={compact ? "size-5" : undefined}
				variant="outline"
				disabled={readOnly || count === 0 || !nxt.ok}
				onClick={() => next && onMoveAll(next)}
				aria-label={nextTitle}
				title={nextTitle}
			>
				{compact ? null : "All"}
				{vertical ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
			</Button>
		</div>
	);
}

/**
 * The frame both card layouts share: one padding scale and the "needs you"
 * ring.
 */
function cardFrame(opts: {
	selected: boolean;
	needsHuman: boolean;
	draggable: boolean;
	/** Vertical padding; the spacing scale's unless a dense tile tightens it. */
	padY?: number;
}): React.CSSProperties {
	const padY = opts.padY ?? SPACE.PAD_Y;
	return {
		padding: `${padY}px ${SPACE.PAD_X}px`,
		borderColor: opts.selected ? "var(--mfw-accent)" : "var(--mfw-border)",
		borderRadius: "var(--mfw-radius-sm)",
		background: opts.selected
			? "var(--mfw-accent-subtle)"
			: "var(--mfw-bg-raised)",
		cursor: opts.draggable ? "grab" : undefined,
		boxShadow: opts.needsHuman ? "0 0 0 2px var(--mfw-warn)" : undefined,
	};
}

export function TaskCard({
	task,
	project,
	draggable,
	moveOptions,
	onMove,
	defaultExpanded = false,
	tile,
	selected = false,
}: {
	task: Task;
	project: string;
	draggable: boolean;
	/** The lanes layout's fixed-height tile: one compact card, its runs in a popover. */
	tile?: { height: number };
	/** This task is open in the docked inspector. */
	selected?: boolean;
	/** Start expanded (tests; the board starts every card compact). */
	defaultExpanded?: boolean;
	/** Columns this task may be moved to from the phone's select. */
	moveOptions?: BoardColumn[];
	onMove?: (to: TaskStatus) => void;
}) {
	const openDeps = task.dependsOn.length;
	const openTask = useOpenTaskFromBoard(project);
	const go = useGo();
	const owned = task.claimedByRunId !== null;
	const locked = owned || task.draftPhase === "waiting_for_answers";
	const agents = useBoardAgents();
	const runs = runsForTask(agents, task);
	const firstRun = runs[0];
	const askingRunId = agents.asking.get(task.id);
	const pips = agents.pips[task.id] ?? [];
	const intent = agents.intents.get(task.id);
	// Read from the board's single verdicts query, not one per card.
	const verdict = useContext(VerdictsContext)?.[task.id];
	// The ring: a person is the next move on this card.
	const needsHuman = taskNeedsHuman(agents, project, task);
	// Expanded in place (design §6.3): Space on the focused card, or the chevron.
	const [expanded, setExpanded] = useState(defaultExpanded);
	const [outcomeDetail, setOutcomeDetail] = useState<OutcomeDetail | null>(
		null,
	);
	const ref = useRef<HTMLElement>(null);
	// A tile cannot grow, so its expansion is a popover anchored under it. It
	// is `fixed` (the lane's scroller would clip it) and placed when opened;
	// scrolling, a click elsewhere or Escape close it.
	const [popover, setPopover] = useState<{
		left: number;
		top?: number;
		bottom?: number;
		maxHeight: number;
	} | null>(null);
	const toggle = () => {
		if (!tile) {
			setExpanded((v) => !v);
			return;
		}
		if (expanded) {
			setExpanded(false);
			return;
		}
		const rect = ref.current?.getBoundingClientRect();
		if (rect && typeof window !== "undefined") {
			const width = 440;
			const below = window.innerHeight - rect.bottom - 12;
			const above = rect.top - 12;
			const up = below < 220 && above > below;
			setPopover({
				left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
				...(up
					? { bottom: window.innerHeight - rect.top + 4 }
					: { top: rect.bottom + 4 }),
				maxHeight: Math.max(160, Math.min(520, (up ? above : below) - 4)),
			});
		}
		setExpanded(true);
	};
	const popoverOpen = Boolean(tile) && expanded;
	useEffect(() => {
		if (!popoverOpen) return;
		const away = (e: Event) => {
			if (e.target instanceof Node && ref.current?.contains(e.target)) return;
			setExpanded(false);
		};
		document.addEventListener("mousedown", away);
		window.addEventListener("scroll", away, true);
		return () => {
			document.removeEventListener("mousedown", away);
			window.removeEventListener("scroll", away, true);
		};
	}, [popoverOpen]);

	if (tile) {
		const { lines, gap, padY } = tileMetrics(tile.height);
		const hasStrip = runs.length > 0 || pips.length > 0;
		return (
			<article
				ref={ref}
				data-card
				data-task={task.id}
				data-tile
				data-expanded={expanded}
				data-selected={selected}
				// biome-ignore lint/a11y/noNoninteractiveTabindex: the card is a focus target; arrows move between cards, Space opens its runs
				tabIndex={0}
				onKeyDown={(e) => {
					if (e.key === "Escape" && expanded) {
						e.stopPropagation();
						setExpanded(false);
						return;
					}
					if (!isCardToggleKey(e)) return;
					e.preventDefault();
					toggle();
				}}
				draggable={draggable && !locked}
				onDragStart={(e) => {
					e.dataTransfer.setData("text/mfw-task", task.id);
					e.dataTransfer.effectAllowed = "move";
				}}
				className="flex shrink-0 flex-col justify-center overflow-hidden border"
				style={{
					...cardFrame({
						selected,
						needsHuman,
						draggable: draggable && !locked,
						padY,
					}),
					width: LANE.TILE_W,
					height: tile.height,
					gap,
				}}
			>
				<div
					className="flex min-w-0 items-center gap-1.5"
					style={{ height: SPACE.ROW_H }}
				>
					<Mono value={task.id} />
					<TaskTypeIcon type={task.type} />
					<PriorityIcon priority={task.priority} />
					{askingRunId ? (
						<AppLink
							to={href.run(project, askingRunId)}
							draggable={false}
							title="Its agent asked a question; answer it to resume the work"
						>
							<Chip tone="warn">
								<CircleHelp aria-hidden /> question
							</Chip>
						</AppLink>
					) : null}
					{firstRun ? <ScopeMeter sample={firstRun.scopeSample} /> : null}
					{verdict && task.status !== "done" && task.status !== "archived" ? (
						<VerdictChip verdict={verdict.verdict} round={verdict.round} />
					) : null}
					<span className="flex-1" />
					{openDeps > 0 ? <Chip tone="info">{openDeps} deps</Chip> : null}
					{task.size ? <Chip>{task.size}</Chip> : null}
					<Button
						size="icon-xs"
						className="-mr-1 size-5"
						variant="ghost"
						aria-expanded={expanded}
						aria-label={`${expanded ? "Collapse" : "Expand"} ${task.id}`}
						title={`${expanded ? "Collapse" : "Expand"} runs (Space)`}
						onClick={toggle}
					>
						{expanded ? (
							<ChevronDown aria-hidden />
						) : (
							<ChevronRight aria-hidden />
						)}
					</Button>
				</div>

				<Tip label={task.title} side="bottom" align="start">
					<AppLink
						to={href.task(project, task.id)}
						navigate={() => openTask(task.id)}
						className={cn(
							"min-w-0 font-medium",
							lines === 2 ? "line-clamp-2" : "truncate",
						)}
						style={{ lineHeight: `${SPACE.LINE_H}px` }}
					>
						{task.title}
					</AppLink>
				</Tip>

				{hasStrip ? (
					<CardAgentStrip
						compact
						runs={runs}
						pips={pips}
						isDraft={task.status === "draft"}
						runHref={(runId) => href.run(project, runId)}
						onSelectPip={(ref) => go(href.board(project, { node: ref }))}
					/>
				) : task.blockedReason ? (
					<Tip
						label={blockedReasonText(task.blockedReason)}
						side="bottom"
						align="start"
					>
						<span
							className="truncate"
							style={{
								color: "var(--mfw-warn)",
								fontSize: "var(--mfw-text-xs)",
								lineHeight: `${SPACE.META_H}px`,
							}}
						>
							{blockedReasonText(task.blockedReason)}
						</span>
					</Tip>
				) : task.status === "draft" ? (
					<span
						className="truncate"
						style={{
							color: "var(--mfw-fg-muted)",
							fontSize: "var(--mfw-text-xs)",
							lineHeight: `${SPACE.META_H}px`,
						}}
					>
						{draftPhaseLabel(task.draftPhase, task.draftAttempts)} →{" "}
						{task.afterExpansion}
					</span>
				) : intent ? (
					<BrainIntentLine intent={intent} />
				) : task.labels.length > 0 ? (
					<Tip label={task.labels.join(" · ")} side="bottom" align="start">
						<span
							className="min-w-0 truncate"
							style={{
								color: "var(--mfw-fg-muted)",
								fontSize: "var(--mfw-text-xs)",
								lineHeight: `${SPACE.META_H}px`,
							}}
						>
							{task.labels.slice(0, 2).join(" · ")}
						</span>
					</Tip>
				) : null}

				{expanded ? (
					<div
						role="dialog"
						aria-label={`${task.id} runs`}
						className="z-30 flex w-[440px] max-w-[calc(100vw-16px)] cursor-default flex-col gap-2 overflow-auto border p-2 shadow-lg"
						style={{
							position: popover ? "fixed" : "absolute",
							left: popover?.left ?? 0,
							top: popover ? popover.top : "100%",
							bottom: popover?.bottom,
							maxHeight: popover?.maxHeight ?? 360,
							background: "var(--mfw-bg-raised)",
							borderColor: "var(--mfw-border)",
							borderRadius: "var(--mfw-radius-md)",
							whiteSpace: "normal",
						}}
					>
						<CardAgentStrip
							runs={runs}
							pips={pips}
							isDraft={task.status === "draft"}
							runHref={(runId) => href.run(project, runId)}
							onSelectPip={(ref) => go(href.board(project, { node: ref }))}
							outcomeDetail={outcomeDetail}
						/>
						{intent ? <BrainIntentLine intent={intent} /> : null}
						<CardSubtree
							project={project}
							taskId={task.id}
							onOutcome={setOutcomeDetail}
						/>
					</div>
				) : null}
			</article>
		);
	}

	return (
		<article
			data-card
			data-task={task.id}
			data-expanded={expanded}
			// biome-ignore lint/a11y/noNoninteractiveTabindex: the card is a focus target; Space expands it (the chevron is the pointer path)
			tabIndex={0}
			onKeyDown={(e) => {
				if (!isCardToggleKey(e)) return;
				e.preventDefault();
				setExpanded((v) => !v);
			}}
			draggable={draggable && !locked}
			onDragStart={(e) => {
				e.dataTransfer.setData("text/mfw-task", task.id);
				e.dataTransfer.effectAllowed = "move";
			}}
			className="flex flex-col border"
			style={{
				...cardFrame({
					selected,
					needsHuman,
					draggable: draggable && !locked,
				}),
				gap: SPACE.ROW_GAP,
			}}
		>
			<div
				className="flex items-center gap-1.5"
				style={{ minHeight: SPACE.ROW_H }}
			>
				<Mono value={task.id} />
				{askingRunId ? (
					<AppLink
						to={href.run(project, askingRunId)}
						draggable={false}
						title="Its agent asked a question; answer it to resume the work"
					>
						<Chip tone="warn">
							<CircleHelp aria-hidden /> question
						</Chip>
					</AppLink>
				) : null}
				{firstRun ? <ScopeMeter sample={firstRun.scopeSample} /> : null}
				{verdict && task.status !== "done" && task.status !== "archived" ? (
					<VerdictChip verdict={verdict.verdict} round={verdict.round} />
				) : null}
				<span className="flex-1" />
				{task.size ? <Chip>{task.size}</Chip> : null}
				<Button
					size="icon-xs"
					className="-mr-1 size-5"
					variant="ghost"
					aria-expanded={expanded}
					aria-label={`${expanded ? "Collapse" : "Expand"} ${task.id}`}
					title={`${expanded ? "Collapse" : "Expand"} (Space)`}
					onClick={() => setExpanded((v) => !v)}
				>
					{expanded ? (
						<ChevronDown aria-hidden />
					) : (
						<ChevronRight aria-hidden />
					)}
				</Button>
			</div>

			<Tip label={task.title} side="bottom" align="start">
				<AppLink
					to={href.task(project, task.id)}
					navigate={() => openTask(task.id)}
					className="line-clamp-2 font-medium"
					style={{ lineHeight: `${SPACE.LINE_H}px` }}
				>
					{task.title}
				</AppLink>
			</Tip>

			<CardAgentStrip
				runs={runs}
				pips={pips}
				isDraft={task.status === "draft"}
				runHref={(runId) => href.run(project, runId)}
				onSelectPip={(ref) => go(href.board(project, { node: ref }))}
				outcomeDetail={expanded ? outcomeDetail : null}
			/>
			{!expanded && intent ? <BrainIntentLine intent={intent} /> : null}
			{expanded ? (
				<CardSubtree
					project={project}
					taskId={task.id}
					onOutcome={setOutcomeDetail}
				/>
			) : null}

			<div className="flex flex-wrap items-center gap-1">
				<Chip>
					<TaskTypeIcon type={task.type} />
					{task.type}
				</Chip>
				<PriorityIcon priority={task.priority} />
				{openDeps > 0 ? <Chip tone="info">{openDeps} deps</Chip> : null}
				{task.draftPhase === "waiting_for_answers" ? (
					<TipButton
						type="button"
						className="mfw-focus"
						style={{ background: "none", border: 0, padding: 0 }}
						tip="Expansion is paused until you answer its questions"
						onClick={(e) => {
							e.stopPropagation();
							openTask(task.id);
						}}
					>
						<Chip tone="warn">
							<CircleHelp aria-hidden /> Questions · action required
						</Chip>
					</TipButton>
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
				<TipSpan
					className="truncate"
					style={{
						color: "var(--mfw-warn)",
						fontSize: "var(--mfw-text-2xs)",
					}}
					tip={blockedReasonText(task.blockedReason)}
					clipped
				>
					{blockedReasonText(task.blockedReason)}
				</TipSpan>
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
					{(moveOptions ?? []).map((column) => (
						<option key={column.value} value={column.role ?? ""}>
							move to {column.label}
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
