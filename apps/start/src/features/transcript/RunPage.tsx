import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	ArrowDownToLine,
	ArrowLeft,
	ChevronDown,
	ChevronRight,
	Cpu,
	OctagonAlert,
	Search,
	Send,
	Square,
} from "lucide-react";
import type { RefObject } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { cn } from "~/lib/utils";
import { AppLink } from "../../components/AppLink";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Cost, Mono, Tokens } from "../../components/Cost";
import { Empty } from "../../components/Empty";
import { ErrorState, StaleWhenOffline } from "../../components/ErrorState";
import { LoadingRows } from "../../components/Loading";
import { Chip, Page, PageHeader } from "../../components/Page";
import { Elapsed } from "../../components/RelativeTime";
import { StatusPill } from "../../components/StatusPill";
import type { VirtualListHandle } from "../../components/VirtualList";
import { VirtualList } from "../../components/VirtualList";
import { useKeyBindings } from "../../lib/keyboard";
import { humanizeError, useToast } from "../../lib/toast";
import { useTRPC } from "../../lib/trpc";
import { href } from "../../routes";
import {
	buildItems,
	isFailure,
	itemText,
	TranscriptEntry,
	type TranscriptItem,
} from "./entries";
import { isTerminalRunState, useRunStream } from "./useRunStream";

/**
 * The transcript viewer: the screen an operator actually spends
 * their time in.
 *
 * Everything expensive is done once: the server parsed the log, `useRunStream`
 * appends deltas, `buildItems` pairs calls with results, and the list is
 * windowed so a 40 MB run renders the same forty rows a 4 KB one does.
 */

export function RunPage({
	project,
	runId,
	query,
	onQueryChange,
	entrySeq,
}: {
	project: string;
	runId: string;
	query: string;
	onQueryChange: (q: string) => void;
	entrySeq?: number;
}) {
	const trpc = useTRPC();
	const queryClient = useQueryClient();
	const { toast } = useToast();

	const runQuery = useQuery(trpc.runs.get.queryOptions({ project, runId }));
	const run = runQuery.data ?? null;
	const stream = useRunStream(project, runId, { runState: run?.state ?? null });
	const steps = useQuery(trpc.runs.steps.queryOptions({ project, runId }));

	const [showCommands, setShowCommands] = useState(true);
	const [showChanges, setShowChanges] = useState(true);
	const [showMcp, setShowMcp] = useState(true);
	const [showSystem, setShowSystem] = useState(true);
	const [showThinking, setShowThinking] = useState(true);
	const [showMessages, setShowMessages] = useState(true);
	const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
	const [follow, setFollow] = useState(true);
	const [focus, setFocus] = useState(-1);
	const [matchIndex, setMatchIndex] = useState(0);
	const [flashSeq, setFlashSeq] = useState<number | null>(entrySeq ?? null);
	const [confirmStop, setConfirmStop] = useState(false);
	const [steerText, setSteerText] = useState("");
	const [journalOpen, setJournalOpen] = useState(false);
	const [respondingApproval, setRespondingApproval] = useState<string | null>(
		null,
	);

	const listRef = useRef<VirtualListHandle | null>(null);
	const searchRef = useRef<HTMLInputElement | null>(null);
	const steerRef = useRef<HTMLInputElement | null>(null);

	const allItems = useMemo(() => buildItems(stream.entries), [stream.entries]);
	const hello = useMemo(
		() => [...stream.entries].reverse().find((entry) => entry.type === "hello"),
		[stream.entries],
	);
	const session = useMemo(
		() =>
			[...stream.entries].reverse().find((entry) => entry.type === "session"),
		[stream.entries],
	);

	const items = useMemo(
		() =>
			allItems.filter((item) => {
				if (item.kind === "tool") return showCommands;
				if (item.kind === "file_change" || item.kind === "diff")
					return showChanges;
				if (item.kind === "mcp_activity") return showMcp;
				if (item.kind === "thinking") return showThinking;
				if (item.kind === "message") return showMessages;
				if (
					item.kind === "plan" ||
					item.kind === "notice" ||
					item.kind === "done"
				)
					return showSystem;
				return true;
			}),
		[
			allItems,
			showCommands,
			showChanges,
			showMcp,
			showThinking,
			showMessages,
			showSystem,
		],
	);

	const needle = query.trim().toLowerCase();
	const matches = useMemo(() => {
		if (!needle) return [];
		const out: number[] = [];
		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			if (item && itemText(item).toLowerCase().includes(needle)) out.push(i);
		}
		return out;
	}, [items, needle]);

	const failures = useMemo(() => {
		const out: number[] = [];
		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			if (item && isFailure(item)) out.push(i);
		}
		return out;
	}, [items]);

	const toggle = useCallback((seq: number) => {
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(seq)) next.delete(seq);
			else next.add(seq);
			return next;
		});
	}, []);

	const jumpTo = useCallback(
		(index: number, expand = false) => {
			if (index < 0 || index >= items.length) return;
			setFollow(false);
			setFocus(index);
			const item = items[index];
			if (expand && item) setExpanded((prev) => new Set(prev).add(item.seq));
			listRef.current?.scrollToIndex(index, "center");
		},
		[items],
	);

	// Deep link: `?entry=<seq>` scrolls to the entry and marks it briefly.
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs once per deep link, after the entries that satisfy it arrive
	useEffect(() => {
		if (entrySeq == null || items.length === 0) return;
		const index = items.findIndex(
			(i) => i.seq === entrySeq || i.seqs?.includes(entrySeq),
		);
		if (index === -1) return;
		jumpTo(index, true);
		setFlashSeq(items[index]?.seq ?? entrySeq);
		const timer = setTimeout(() => setFlashSeq(null), 2500);
		return () => clearTimeout(timer);
	}, [entrySeq, items.length]);

	const cycle = useCallback(
		(
			list: number[],
			delta: number,
			current: number,
			set: (n: number) => void,
		) => {
			if (list.length === 0) return;
			const next = (current + delta + list.length) % list.length;
			set(next);
			const target = list[next];
			if (target !== undefined) jumpTo(target, true);
		},
		[jumpTo],
	);

	const [failureIndex, setFailureIndex] = useState(0);

	// Scrolling away from the end drops the follow pin; scrolling back restores
	// it, so the toggle and the gesture are the same piece of state.
	const onPinnedChange = useCallback((atBottom: boolean) => {
		setFollow(atBottom);
	}, []);

	const stop = useMutation(
		trpc.runs.stop.mutationOptions({
			meta: { label: "Stop run" },
			onMutate: async () => {
				const filter = trpc.runs.get.queryFilter({ project, runId });
				await queryClient.cancelQueries(filter);
				const key = trpc.runs.get.queryKey({ project, runId });
				const previous = queryClient.getQueryData(key);
				queryClient.setQueryData(key, (row) =>
					row ? { ...row, state: "ended" as const } : row,
				);
				return { previous };
			},
			onError: (_err, _vars, ctx) => {
				if (ctx?.previous)
					queryClient.setQueryData(
						trpc.runs.get.queryKey({ project, runId }),
						ctx.previous,
					);
			},
			onSuccess: () => {
				setConfirmStop(false);
				toast({ tone: "success", title: "Stopping run" });
			},
			onSettled: () => {
				void queryClient.invalidateQueries(
					trpc.runs.get.queryFilter({ project, runId }),
				);
				void queryClient.invalidateQueries(trpc.runs.active.queryFilter());
			},
		}),
	);

	const steer = useMutation(
		trpc.runs.steer.mutationOptions({
			meta: { label: "Steer" },
			onSuccess: () => {
				setSteerText("");
				toast({ tone: "success", title: "Steer delivered" });
			},
		}),
	);
	const respondApproval = useMutation(
		trpc.runs.respondApproval.mutationOptions({
			meta: { label: "Respond to approval" },
			onMutate: ({ requestId }) => setRespondingApproval(requestId),
			onSuccess: () =>
				toast({ tone: "success", title: "Approval response delivered" }),
			onError: () => setRespondingApproval(null),
		}),
	);
	useEffect(() => {
		if (!respondingApproval) return;
		const approval = allItems.find(
			(item) =>
				item.kind === "approval" && item.requestId === respondingApproval,
		);
		if (approval?.kind === "approval" && approval.status !== "pending")
			setRespondingApproval(null);
	}, [allItems, respondingApproval]);

	const live = !isTerminalRunState(run?.state);
	const providerActive = run?.state === "running";
	const steerable = Boolean(
		providerActive && run?.capabilities.verified && run?.capabilities.steer,
	);

	useKeyBindings([
		{
			key: "/",
			label: "Search",
			group: "Transcript",
			run: () => searchRef.current?.focus(),
		},
		{
			key: "n",
			label: "Next match",
			group: "Transcript",
			enabled: matches.length > 0,
			run: () => cycle(matches, 1, matchIndex, setMatchIndex),
		},
		{
			key: "N",
			label: "Previous match",
			group: "Transcript",
			enabled: matches.length > 0,
			run: () => cycle(matches, -1, matchIndex, setMatchIndex),
		},
		{
			key: "e",
			label: "Next error",
			group: "Transcript",
			enabled: failures.length > 0,
			run: () => cycle(failures, 1, failureIndex, setFailureIndex),
		},
		{
			key: "f",
			label: "Toggle follow",
			group: "Transcript",
			run: () => setFollow((v) => !v),
		},
		{
			key: "j",
			label: "Next entry",
			group: "Transcript",
			run: () => jumpTo(Math.min(focus + 1, items.length - 1)),
		},
		{
			key: "k",
			label: "Previous entry",
			group: "Transcript",
			run: () => jumpTo(Math.max(focus - 1, 0)),
		},
		{
			key: "Enter",
			label: "Expand entry",
			group: "Transcript",
			enabled: focus >= 0,
			run: () => {
				const item = items[focus];
				if (item) toggle(item.seq);
			},
		},
		{
			key: "s",
			label: "Focus steer box",
			group: "Transcript",
			enabled: steerable,
			run: () => steerRef.current?.focus(),
		},
	]);

	const usage = run?.usage ?? null;
	const totals = stream.totals;

	return (
		<Page className="h-full">
			<PageHeader
				back={
					<Button size="xs" variant="ghost" asChild>
						<AppLink to={href.runs(project)}>
							<ArrowLeft aria-hidden /> Runs
						</AppLink>
					</Button>
				}
				title={
					<span className="flex min-w-0 flex-wrap items-center gap-2">
						{run ? <StatusPill kind="run" value={run.state} /> : null}
						<span className="min-w-0 truncate">
							{run?.taskTitle ??
								(run?.taskId && run.label === run.taskId
									? runId.slice(-8)
									: (run?.label ?? runId))}
						</span>
					</span>
				}
				meta={
					run ? (
						<>
							<Chip>{run.kind}</Chip>
							<Chip
								tone={run.executionTarget === "runpod" ? "info" : "neutral"}
							>
								{run.executionTarget}
							</Chip>
							{run.executionTarget === "runpod" ? (
								<AppLink to={href.runpod()}>RunPod operations</AppLink>
							) : null}
							{run.providerId ? <Chip>{run.providerId}</Chip> : null}
							<span>{run.model}</span>
							{run.reasoningEffort ? (
								<span>{run.reasoningEffort} effort</span>
							) : null}
							<span>attempt {run.attempt}</span>
							{run.taskId ? (
								<AppLink to={href.task(project, run.taskId)}>
									{run.taskId}
								</AppLink>
							) : null}
							<StaleWhenOffline>
								<span className="inline-flex items-center gap-1">
									{run.finishedAt ? "ran for" : "running for"}
									<Elapsed
										since={run.startedAt}
										until={run.finishedAt ?? undefined}
									/>
								</span>
							</StaleWhenOffline>
							<Cost usd={totals.costUsd ?? usage?.costUsd ?? null} />
							<Tokens
								count={
									totals.inputTokens != null || totals.outputTokens != null
										? (totals.inputTokens ?? 0) + (totals.outputTokens ?? 0)
										: null
								}
							/>
							{totals.cachedInputTokens != null ? (
								<span>{totals.cachedInputTokens.toLocaleString()} cached</span>
							) : null}
							{totals.reasoningOutputTokens != null ? (
								<span>
									{totals.reasoningOutputTokens.toLocaleString()} reasoning
								</span>
							) : null}
							{totals.turns != null ? <span>{totals.turns} turns</span> : null}
							{run.branch ? <Mono value={run.branch} /> : null}
						</>
					) : null
				}
				actions={
					providerActive ? (
						<Button
							size="sm"
							variant="destructive"
							disabled={stop.isPending}
							onClick={() => setConfirmStop(true)}
						>
							<Square aria-hidden /> {stop.isPending ? "Stopping…" : "Stop"}
						</Button>
					) : null
				}
			/>

			<HarnessBar
				provider={run?.providerId ?? hello?.provider ?? null}
				capabilities={run?.capabilities ?? hello?.capabilities ?? null}
				session={
					session?.type === "session"
						? {
								sessionId: session.sessionId,
								turnId: session.turnId,
								ordinal: session.ordinal,
								status:
									session.status === "active" && !providerActive
										? (run?.state ?? session.status)
										: session.status,
							}
						: null
				}
			/>

			<Toolbar
				query={query}
				onQueryChange={(q) => {
					onQueryChange(q);
					setMatchIndex(0);
				}}
				searchRef={searchRef}
				matchCount={matches.length}
				matchIndex={matchIndex}
				onCycleMatch={(d) => cycle(matches, d, matchIndex, setMatchIndex)}
				failureCount={failures.length}
				onJumpFailure={() => cycle(failures, 1, failureIndex, setFailureIndex)}
				showCommands={showCommands}
				showChanges={showChanges}
				showMcp={showMcp}
				showThinking={showThinking}
				showMessages={showMessages}
				showSystem={showSystem}
				setShowCommands={setShowCommands}
				setShowChanges={setShowChanges}
				setShowMcp={setShowMcp}
				setShowThinking={setShowThinking}
				setShowMessages={setShowMessages}
				setShowSystem={setShowSystem}
				follow={follow}
				setFollow={setFollow}
				live={live}
			/>

			<Journal
				open={journalOpen}
				onToggle={() => setJournalOpen((v) => !v)}
				steps={steps.data ?? []}
				error={steps.error}
				onRetry={() => void steps.refetch()}
			/>

			{stream.streamError ? (
				<div
					className="flex items-center gap-2 px-3 py-1"
					style={{
						background: "color-mix(in oklch, var(--mfw-warn) 14%, transparent)",
						color: "var(--mfw-fg-muted)",
						fontSize: "var(--mfw-text-xs)",
					}}
				>
					<OctagonAlert
						aria-hidden
						className="size-3.5"
						style={{ color: "var(--mfw-warn)" }}
					/>
					Live output stopped: {humanizeError(stream.streamError)}
				</div>
			) : null}

			{runQuery.error ? (
				<div className="p-3">
					<ErrorState
						title="Could not load this run"
						error={runQuery.error}
						onRetry={() => void runQuery.refetch()}
					/>
				</div>
			) : stream.error ? (
				<div className="p-3">
					<ErrorState
						title="Could not load the transcript"
						error={stream.error}
						onRetry={stream.refetch}
					/>
				</div>
			) : stream.isLoading ? (
				<div className="p-3">
					<LoadingRows rows={12} />
				</div>
			) : (
				<VirtualList
					ref={listRef}
					items={items}
					itemKey={(item) => item.seq}
					estimateHeight={28}
					pinned={follow && live}
					onPinnedChange={onPinnedChange}
					className="px-2"
					empty={
						<Empty
							title={
								allItems.length === 0
									? "No output yet."
									: "Every entry is filtered out."
							}
							reason={allItems.length === 0 ? "none" : "filtered"}
							description={
								allItems.length === 0
									? "The agent has not written anything to its transcript."
									: "Turn a filter back on to see the rest."
							}
						/>
					}
					renderItem={(item: TranscriptItem, index: number) => (
						<TranscriptEntry
							item={item}
							expanded={expanded.has(item.seq)}
							onToggle={() => toggle(item.seq)}
							query={needle || undefined}
							focused={index === focus}
							flash={item.seq === flashSeq}
							approvalPending={
								item.kind === "approval" &&
								respondingApproval === item.requestId
							}
							onApproval={(requestId, decision) =>
								respondApproval.mutate({ project, runId, requestId, decision })
							}
						/>
					)}
				/>
			)}

			{steerable ? (
				<form
					className="flex items-center gap-2 border-t px-3 py-2"
					style={{
						borderColor: "var(--mfw-border)",
						background: "var(--mfw-bg-subtle)",
					}}
					onSubmit={(e) => {
						e.preventDefault();
						const message = steerText.trim();
						if (!message) return;
						steer.mutate({ project, runId, message });
					}}
				>
					<Send
						aria-hidden
						className="size-4 shrink-0"
						style={{ color: "var(--mfw-fg-faint)" }}
					/>
					<Input
						ref={steerRef}
						value={steerText}
						placeholder="Steer the agent… (s)"
						aria-label="Steer the agent"
						onChange={(e) => setSteerText(e.target.value)}
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

			<ConfirmDialog
				open={confirmStop}
				onOpenChange={setConfirmStop}
				title={`Stop ${run?.label ?? runId}?`}
				description={
					run?.capabilities.verified && run.capabilities.interrupt
						? "The harness is asked to interrupt the active turn cleanly. If it does not acknowledge in time, mfw stops the process. Committed work is kept; nothing is merged."
						: "The agent process is stopped and the run finalizes as interrupted. Committed work is kept; nothing is merged."
				}
				confirmLabel="Stop run"
				pending={stop.isPending}
				onConfirm={() => stop.mutate({ project, runId })}
			/>
		</Page>
	);
}

function HarnessBar({
	provider,
	capabilities,
	session,
}: {
	provider: string | null;
	capabilities: {
		verified?: boolean;
		steer?: boolean;
		interrupt?: boolean;
		approvals?: boolean;
		plan?: boolean;
		fileChanges?: boolean;
		commandProgress?: boolean;
		mcp?: boolean;
	} | null;
	session: {
		sessionId: string;
		turnId?: string;
		ordinal: number;
		status: string;
	} | null;
}) {
	if (!provider && !capabilities && !session) return null;
	const features = capabilities
		? [
				["steer", capabilities.steer],
				["interrupt", capabilities.interrupt],
				["approvals", capabilities.approvals],
				["plans", capabilities.plan],
				["files", capabilities.fileChanges],
				["commands", capabilities.commandProgress],
				["MCP", capabilities.mcp],
			]
				.filter((feature) => feature[1])
				.map(([label]) => String(label))
		: [];
	return (
		<div
			className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-1.5"
			style={{
				borderColor: "var(--mfw-border)",
				background: "var(--mfw-bg-raised)",
				color: "var(--mfw-fg-muted)",
				fontSize: "var(--mfw-text-xs)",
			}}
		>
			<span className="inline-flex items-center gap-1 font-medium">
				<Cpu aria-hidden className="size-3.5" />
				{provider ?? "agent harness"}
			</span>
			{capabilities?.verified ? <Chip tone="ok">verified harness</Chip> : null}
			{session ? (
				<span title={`session ${session.sessionId}`}>
					turn {session.ordinal} · {session.status}
					{session.turnId ? ` · ${session.turnId.slice(-8)}` : ""}
				</span>
			) : null}
			{features.length > 0 ? (
				<span title={features.join(", ")}>
					{features.length} harness{" "}
					{features.length === 1 ? "feature" : "features"}
				</span>
			) : null}
		</div>
	);
}

function Toolbar({
	query,
	onQueryChange,
	searchRef,
	matchCount,
	matchIndex,
	onCycleMatch,
	failureCount,
	onJumpFailure,
	showCommands,
	showChanges,
	showMcp,
	showThinking,
	showMessages,
	showSystem,
	setShowCommands,
	setShowChanges,
	setShowMcp,
	setShowThinking,
	setShowMessages,
	setShowSystem,
	follow,
	setFollow,
	live,
}: {
	query: string;
	onQueryChange: (q: string) => void;
	searchRef: RefObject<HTMLInputElement | null>;
	matchCount: number;
	matchIndex: number;
	onCycleMatch: (delta: number) => void;
	failureCount: number;
	onJumpFailure: () => void;
	showCommands: boolean;
	showChanges: boolean;
	showMcp: boolean;
	showThinking: boolean;
	showMessages: boolean;
	showSystem: boolean;
	setShowCommands: (v: boolean) => void;
	setShowChanges: (v: boolean) => void;
	setShowMcp: (v: boolean) => void;
	setShowThinking: (v: boolean) => void;
	setShowMessages: (v: boolean) => void;
	setShowSystem: (v: boolean) => void;
	follow: boolean;
	setFollow: (v: boolean) => void;
	live: boolean;
}) {
	return (
		<div
			className="flex flex-wrap items-center gap-2 border-b px-3 py-1.5"
			style={{
				borderColor: "var(--mfw-border)",
				background: "var(--mfw-bg-subtle)",
			}}
		>
			<div className="flex min-w-50 flex-1 items-center gap-1">
				<Search
					aria-hidden
					className="size-3.5 shrink-0"
					style={{ color: "var(--mfw-fg-faint)" }}
				/>
				<Input
					ref={searchRef}
					value={query}
					placeholder="Search the transcript  /"
					aria-label="Search the transcript"
					onChange={(e) => onQueryChange(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							onCycleMatch(e.shiftKey ? -1 : 1);
						}
						if (e.key === "Escape") onQueryChange("");
					}}
				/>
				{query ? (
					<span
						className="mfw-num shrink-0 whitespace-nowrap"
						style={{
							color: "var(--mfw-fg-muted)",
							fontSize: "var(--mfw-text-xs)",
						}}
					>
						{matchCount === 0
							? "no matches"
							: `${Math.min(matchIndex + 1, matchCount)} / ${matchCount}`}
					</span>
				) : null}
			</div>

			<div className="flex flex-wrap items-center gap-1">
				<FilterToggle
					label="commands"
					on={showCommands}
					onChange={setShowCommands}
				/>
				<FilterToggle
					label="changes"
					on={showChanges}
					onChange={setShowChanges}
				/>
				<FilterToggle label="MCP" on={showMcp} onChange={setShowMcp} />
				<FilterToggle
					label="thinking"
					on={showThinking}
					onChange={setShowThinking}
				/>
				<FilterToggle
					label="messages"
					on={showMessages}
					onChange={setShowMessages}
				/>
				<FilterToggle label="system" on={showSystem} onChange={setShowSystem} />
			</div>

			<Button
				size="xs"
				variant="outline"
				disabled={failureCount === 0}
				onClick={onJumpFailure}
				title="Jump to the next failure (e)"
			>
				<OctagonAlert aria-hidden /> {failureCount} error
				{failureCount === 1 ? "" : "s"}
			</Button>

			{live ? (
				<Button
					size="xs"
					variant={follow ? "secondary" : "outline"}
					aria-pressed={follow}
					onClick={() => setFollow(!follow)}
					title="Follow the tail (f)"
				>
					<ArrowDownToLine aria-hidden /> {follow ? "Following" : "Follow"}
				</Button>
			) : null}
		</div>
	);
}

function FilterToggle({
	label,
	on,
	onChange,
}: {
	label: string;
	on: boolean;
	onChange: (v: boolean) => void;
}) {
	return (
		<button
			type="button"
			aria-pressed={on}
			onClick={() => onChange(!on)}
			className={cn("mfw-focus min-h-6 border px-2 py-1")}
			style={{
				borderColor: on ? "var(--mfw-accent)" : "var(--mfw-border)",
				color: on ? "var(--mfw-accent)" : "var(--mfw-fg-faint)",
				background: on ? "var(--mfw-accent-subtle)" : "transparent",
				borderRadius: "var(--mfw-radius-sm)",
				fontSize: "var(--mfw-text-xs)",
			}}
		>
			{label}
		</button>
	);
}

/** The finalize journal: what the daemon did after the agent stopped. */
function Journal({
	open,
	onToggle,
	steps,
	error,
	onRetry,
}: {
	open: boolean;
	onToggle: () => void;
	steps: {
		step: string;
		status: string;
		error: string | null;
		result: unknown;
	}[];
	error: unknown;
	onRetry: () => void;
}) {
	if (error) {
		return (
			<div className="p-3">
				<ErrorState
					title="Could not load completion steps"
					error={error}
					onRetry={onRetry}
				/>
			</div>
		);
	}
	if (steps.length === 0) return null;
	const failed = steps.filter((s) => s.status === "failed").length;
	return (
		<div
			className="border-b px-3 py-1"
			style={{ borderColor: "var(--mfw-border)" }}
		>
			<button
				type="button"
				aria-expanded={open}
				onClick={onToggle}
				className="mfw-focus flex items-center gap-1.5"
				style={{
					color: "var(--mfw-fg-muted)",
					fontSize: "var(--mfw-text-xs)",
				}}
			>
				{open ? (
					<ChevronDown aria-hidden className="size-3" />
				) : (
					<ChevronRight aria-hidden className="size-3" />
				)}
				Completion: {steps.length} step
				{steps.length === 1 ? "" : "s"}
				{failed > 0 ? `, ${failed} failed` : ""}
			</button>
			{open ? (
				<ul className="mt-1 flex flex-col gap-0.5 pb-1">
					{steps.map((s) => (
						<li key={s.step} className="flex min-w-0 items-baseline gap-2">
							<span
								className="mfw-num w-32 shrink-0"
								style={{
									color:
										s.status === "failed"
											? "var(--mfw-critical)"
											: s.status === "done"
												? "var(--mfw-ok)"
												: "var(--mfw-fg-muted)",
								}}
							>
								{s.step}
							</span>
							<span
								className="min-w-0 flex-1 truncate"
								style={{
									color: "var(--mfw-fg-muted)",
									fontSize: "var(--mfw-text-xs)",
								}}
								title={s.error ?? JSON.stringify(s.result ?? {})}
							>
								{s.error ?? JSON.stringify(s.result ?? {})}
							</span>
						</li>
					))}
				</ul>
			) : null}
		</div>
	);
}
