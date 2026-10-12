import type { FlowMarker, FlowSpan } from "@mfw/daemon/flow";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ArrowDown } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { shortModel } from "../../components/agent/look";
import { Empty } from "../../components/Empty";
import { ErrorState } from "../../components/ErrorState";
import { LoadingRows } from "../../components/Loading";
import { useKeyBindings } from "../../lib/keyboard";
import { useGo, useMediaQuery } from "../../lib/nav";
import { useTRPC } from "../../lib/trpc";
import { href } from "../../routes";
import { HoverLayer } from "./FlowHover";
import { FlowLegend } from "./FlowLegend";
import {
	buildFlow,
	type FlowFilter,
	type FlowNodeIn,
	type FlowRow,
	followTarget,
	formatFlowFilter,
	parseFlowFilter,
	rowIndexFor,
} from "./flowModel";
import { fitWindowMs } from "./laneLayout";
import { NodeRow } from "./NodeRow";
import {
	quantise,
	rowActions,
	scrubBindings,
	scrubbedAt,
	stepTimes,
	TimeCursor,
} from "./TimeCursor";
import { TimeAxis, TimeControls } from "./TimeHeader";
import { TimelineCell } from "./TimelineCell";
import { TreeGrid, type TreeGridHandle } from "./TreeGrid";
import {
	FIT_WINDOW,
	makeScale,
	panned,
	resolveWindow,
	spanRange,
	type TimeWindow,
} from "./timeScale";

/**
 * The Flow lens: the work tree with a shared time axis (design §5). The tree
 * is `flow.tree`, the bars and markers are `flow.spans` for the window, and
 * the live channel patches both in place (`lib/live.ts`), so a busy board
 * costs the same requests as a quiet one.
 *
 * `FlowPage` is the data half; `FlowLens` is a pure render of what it is
 * given, which is what the tests and the phone/desktop split exercise.
 */

/** Tree column minimum; the timeline takes what is left, within these bounds. */
const TREE_MIN_PX = 380;
const TIMELINE_MIN_PX = 200;
const TIMELINE_MAX_PX = 960;
const PHONE_SPARK_PX = 40;
const SPARK_WINDOW_MS = 2 * 3_600_000;
/** LIVE moves the right edge with the clock; a render clock, it fetches nothing. */
const LIVE_TICK_MS = 5_000;

export interface FlowSearch {
	/** The filter expression (`needs:me live status:doing q`). */
	f?: string;
	/** Window length. */
	w?: string;
	/** Right edge of the window; absent is LIVE. */
	t?: string;
	/** The selected node. */
	node?: string;
	/** The inspector's tab. */
	tab?: string;
}

// ---------------------------------------------------------------------------
// clock
// ---------------------------------------------------------------------------

/** `Date.now()` re-read every `ms` while `enabled` and the tab is visible. */
function useTickingNow(ms: number, enabled: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!enabled) return;
		const id = setInterval(() => {
			if (document.visibilityState !== "hidden") setNow(Date.now());
		}, ms);
		return () => clearInterval(id);
	}, [ms, enabled]);
	return now;
}

/** Observed width of an element. 0 until measured. */
function useWidth(): [(el: HTMLElement | null) => void, number] {
	const [el, setEl] = useState<HTMLElement | null>(null);
	const [width, setWidth] = useState(0);
	useEffect(() => {
		if (!el) return;
		setWidth(el.clientWidth);
		const ro = new ResizeObserver(() => setWidth(el.clientWidth));
		ro.observe(el);
		return () => ro.disconnect();
	}, [el]);
	return [setEl, width];
}

/** The timeline column needs room; below the tablet breakpoint it becomes a sparkline. */
function useIsWide(): boolean {
	return useMediaQuery("(min-width: 768px)");
}

// ---------------------------------------------------------------------------
// the lens (pure render)
// ---------------------------------------------------------------------------

export interface FlowLensProps {
	nodes: readonly FlowNodeIn[];
	spans: readonly FlowSpan[];
	markers: readonly FlowMarker[];
	filter: FlowFilter;
	window: TimeWindow;
	now: number;
	/** Width of the whole lens. */
	width: number;
	/** `false` on a phone: no timeline column, a 40px sparkline per row. */
	wide: boolean;
	selectedRef: string | null;
	overrides: ReadonlyMap<string, boolean>;
	onToggle: (key: string, open: boolean) => void;
	onSelect: (ref: string) => void;
	onActions?: (ref: string) => void;
	onManualScroll?: () => void;
	gridRef?: React.Ref<TreeGridHandle>;
}

/** Who a row is (harness and model), for hover cards. */
function rowWho(node: FlowNodeIn | undefined): string | undefined {
	if (node?.run) {
		const model = shortModel(node.run.model);
		return [node.run.harness, model].filter(Boolean).join(" ") || undefined;
	}
	if (node?.brain) return `brain ${node.brain.harness} ${node.brain.model}`;
	return undefined;
}

/** What a run cost, for hover cards. */
function rowCost(node: FlowNodeIn | undefined): string | undefined {
	const usd = node?.run?.liveCostUsd ?? node?.run?.costUsd;
	return usd != null && usd > 0 ? `$${usd.toFixed(2)}` : undefined;
}

export function timelineWidth(total: number): number {
	return Math.max(
		TIMELINE_MIN_PX,
		Math.min(TIMELINE_MAX_PX, total - TREE_MIN_PX),
	);
}

export function FlowLens(props: FlowLensProps) {
	const {
		nodes,
		spans,
		markers,
		filter,
		window: win,
		now,
		width,
		wide,
		selectedRef,
		overrides,
		onToggle,
		onSelect,
		onActions,
		onManualScroll,
		gridRef,
	} = props;

	const view = useMemo(
		() => buildFlow(nodes, { overrides, filter, now }),
		[nodes, overrides, filter, now],
	);

	const byRef = useMemo(() => {
		const spansBy = new Map<string, FlowSpan[]>();
		for (const s of spans) {
			const list = spansBy.get(s.subject);
			if (list) list.push(s);
			else spansBy.set(s.subject, [s]);
		}
		const markersBy = new Map<string, FlowMarker[]>();
		for (const m of markers) {
			const list = markersBy.get(m.subject);
			if (list) list.push(m);
			else markersBy.set(m.subject, [m]);
		}
		const kids = new Map<string, string[]>();
		for (const n of nodes) {
			if (!n.parent) continue;
			const list = kids.get(n.parent);
			if (list) list.push(n.ref);
			else kids.set(n.parent, [n.ref]);
		}
		return { spansBy, markersBy, kids };
	}, [spans, markers, nodes]);

	const timeW = wide ? timelineWidth(width) : PHONE_SPARK_PX;
	const scale = useMemo(
		() =>
			wide
				? makeScale(win.from, win.to, timeW)
				: makeScale(now - SPARK_WINDOW_MS, now, PHONE_SPARK_PX),
		[wide, win.from, win.to, timeW, now],
	);

	/** Activity of everything below a collapsed row, so a closed epic still shows life. */
	const rolledFor = (ref: string): FlowSpan[] => {
		const out: FlowSpan[] = [];
		const stack = [...(byRef.kids.get(ref) ?? [])];
		const seen = new Set<string>();
		while (stack.length > 0) {
			const r = stack.pop() as string;
			if (seen.has(r)) continue;
			seen.add(r);
			for (const s of byRef.spansBy.get(r) ?? []) {
				if (s.lane === "activity") out.push(s);
			}
			stack.push(...(byRef.kids.get(r) ?? []));
		}
		return out;
	};

	const selectMarker = (ref: string) => onSelect(ref);

	const renderRow = (
		row: FlowRow,
		ctx: Parameters<Parameters<typeof TreeGrid>[0]["renderRow"]>[1],
	) => {
		const ref = row.node?.ref;
		const own = ref ? (byRef.spansBy.get(ref) ?? []) : [];
		const collapsed = row.kind === "node" && row.expandable && !row.expanded;
		return (
			<NodeRow
				key={row.key}
				row={row}
				now={now}
				mode="grid"
				id={ctx.id}
				selected={ctx.selected}
				active={ctx.active}
				onToggle={(key) => onToggle(key, !row.expanded)}
				onSelect={ctx.select}
				timeline={
					row.kind === "fold" ? (
						<div style={{ width: timeW, flex: "none" }} />
					) : (
						<TimelineCell
							scale={scale}
							now={now}
							spans={own}
							markers={ref ? (byRef.markersBy.get(ref) ?? []) : []}
							compact={!wide}
							label={`Events on ${row.node?.title ?? row.key}`}
							{...(rowWho(row.node) ? { who: rowWho(row.node) } : {})}
							{...(rowCost(row.node) ? { cost: rowCost(row.node) } : {})}
							{...(collapsed && ref && wide ? { rolled: rolledFor(ref) } : {})}
							onMarker={selectMarker}
						/>
					)
				}
			/>
		);
	};

	return (
		<HoverLayer
			scale={scale}
			className="flex h-full min-h-0 flex-col"
			attrs={{ "data-flow-lens": "", "data-layout": wide ? "wide" : "phone" }}
		>
			<div
				className="flex shrink-0 border-b"
				style={{
					borderColor: "var(--mfw-border)",
					background: "var(--mfw-bg-subtle)",
					scrollbarGutter: "stable",
					overflowY: "hidden",
				}}
			>
				<div
					className="flex min-w-0 flex-1 items-center px-2 uppercase"
					style={{
						height: "var(--mfw-row-h)",
						color: "var(--mfw-fg-faint)",
						fontSize: "var(--mfw-text-2xs)",
						letterSpacing: "0.06em",
					}}
				>
					Tree
					<span className="mfw-num ml-2">{view.rows.length}</span>
				</div>
				{wide ? <TimeAxis scale={scale} now={now} /> : null}
			</div>
			<TreeGrid
				ref={gridRef}
				rows={view.rows}
				label="Work tree"
				selectedKey={selectedRef}
				renderRow={renderRow}
				onToggle={onToggle}
				onSelect={(key) => {
					if (key.startsWith("fold:")) {
						const row = view.rows.find((r) => r.key === key);
						onToggle(key, !row?.expanded);
					} else onSelect(key);
				}}
				{...(onActions ? { onActions } : {})}
				{...(onManualScroll ? { onManualScroll } : {})}
				empty={
					<Empty
						title={nodes.length === 0 ? "Nothing here yet." : "No matches."}
						reason={nodes.length === 0 ? "none" : "filtered"}
						description={
							nodes.length === 0
								? "Tasks and the agent runs working on them appear here as a tree on a shared time axis. Create a task on the Board and it shows up here."
								: "Loosen the filter to see more of the tree."
						}
					/>
				}
			/>
		</HoverLayer>
	);
}

export { legendEntries } from "./FlowLegend";

// ---------------------------------------------------------------------------
// filter bar
// ---------------------------------------------------------------------------

function distinct(values: (string | null | undefined)[]): string[] {
	return [...new Set(values.filter((v): v is string => !!v))].sort();
}

function FilterBar({
	nodes,
	filter,
	onFilter,
}: {
	nodes: readonly FlowNodeIn[];
	filter: FlowFilter;
	onFilter: (next: FlowFilter) => void;
}) {
	const statuses = distinct(nodes.map((n) => n.status?.value));
	const roles = distinct(nodes.map((n) => n.run?.role));
	const harnesses = distinct(nodes.map((n) => n.run?.harness));
	const hosts = distinct(nodes.map((n) => n.run?.host));
	const toggle = (key: "needsMe" | "live", label: string) => (
		<button
			type="button"
			aria-pressed={!!filter[key]}
			onClick={() =>
				onFilter({ ...filter, [key]: filter[key] ? undefined : true })
			}
			className="mfw-focus px-2 py-0.5"
			style={{
				fontSize: "var(--mfw-text-xs)",
				border: "1px solid var(--mfw-border)",
				borderRadius: "var(--mfw-radius-sm)",
				background: filter[key] ? "var(--mfw-accent-subtle)" : "transparent",
				color: filter[key] ? "var(--mfw-fg)" : "var(--mfw-fg-muted)",
			}}
		>
			{label}
		</button>
	);
	const pick = (
		key: "status" | "role" | "harness" | "host",
		label: string,
		values: string[],
	) =>
		values.length === 0 ? null : (
			<select
				aria-label={label}
				value={filter[key] ?? ""}
				onChange={(e) =>
					onFilter({ ...filter, [key]: e.target.value || undefined })
				}
				className="mfw-focus px-1 py-0.5"
				style={{
					fontSize: "var(--mfw-text-xs)",
					border: "1px solid var(--mfw-border)",
					borderRadius: "var(--mfw-radius-sm)",
					background: "var(--mfw-bg)",
					color: "var(--mfw-fg-muted)",
				}}
			>
				<option value="">{label}</option>
				{values.map((v) => (
					<option key={v} value={v}>
						{v}
					</option>
				))}
			</select>
		);
	return (
		<div className="flex flex-wrap items-center gap-1.5">
			{toggle("needsMe", "needs:me")}
			{toggle("live", "live")}
			{pick("status", "status", statuses)}
			{pick("role", "role", roles)}
			{pick("harness", "harness", harnesses)}
			{pick("host", "host", hosts)}
			<input
				type="search"
				aria-label="Filter text"
				placeholder="Filter…"
				defaultValue={filter.q ?? ""}
				onChange={(e) =>
					onFilter({ ...filter, q: e.target.value.trim() || undefined })
				}
				className="mfw-focus px-2 py-0.5"
				style={{
					fontSize: "var(--mfw-text-xs)",
					border: "1px solid var(--mfw-border)",
					borderRadius: "var(--mfw-radius-sm)",
					background: "var(--mfw-bg)",
					color: "var(--mfw-fg)",
					width: "10rem",
				}}
			/>
		</div>
	);
}

// ---------------------------------------------------------------------------
// the page
// ---------------------------------------------------------------------------

export function FlowPage({
	project,
	search,
	onSearch,
}: {
	project: string;
	search: FlowSearch;
	/** Merge into the URL's search params. `undefined` removes a key. */
	onSearch: (patch: Partial<FlowSearch>) => void;
}) {
	const trpc = useTRPC();
	const go = useGo();
	const wide = useIsWide();
	const [measure, width] = useWidth();
	const filter = useMemo(() => parseFlowFilter(search.f), [search.f]);

	const live = !search.t || !(Date.parse(search.t) < Date.now());
	const now = useTickingNow(LIVE_TICK_MS, live);
	const at = live ? null : scrubbedAt(search.t, now);
	const scrubbed = at !== null;

	// Live: the structure the live channel patches. Scrubbed: the tree as of t
	// (`flow.at`, second-quantised, so a cursor held still is one request).
	const liveTree = useQuery({
		...trpc.flow.tree.queryOptions({ project }),
		enabled: !scrubbed,
	});
	const atTree = useQuery({
		...trpc.flow.at.queryOptions({
			project,
			t: new Date(quantise(at ?? 0)),
		}),
		enabled: scrubbed,
		placeholderData: keepPreviousData,
		staleTime: 60_000,
	});
	const tree = scrubbed ? atTree : liveTree;
	const nodes = useMemo(() => tree.data?.nodes ?? [], [tree.data]);
	const earliest = useMemo(() => {
		let min: number | null = null;
		for (const n of nodes) {
			const at = n.run?.startedAt.getTime();
			if (at !== undefined && (min === null || at < min)) min = at;
		}
		return min;
	}, [nodes]);
	// `fit`: frame the activity (first run to now, padded) instead of a fixed 2h.
	const fitMs = useMemo(() => {
		const stamps: number[] = [];
		for (const n of nodes) {
			if (n.run) stamps.push(n.run.startedAt.getTime());
			if (n.run?.finishedAt) stamps.push(n.run.finishedAt.getTime());
			if (n.sub) stamps.push(n.sub.startedAt.getTime());
		}
		return fitWindowMs(stamps, Date.now());
	}, [nodes]);
	const win = useMemo(
		() =>
			wide
				? resolveWindow({
						w: search.w ?? FIT_WINDOW,
						...(search.t ? { t: search.t } : {}),
						now,
						earliest,
						fitMs,
					})
				: resolveWindow({ w: "2h", now }),
		[wide, search.w, search.t, now, earliest, fitMs],
	);
	const range = useMemo(() => spanRange(win, now), [win, now]);
	const spansQuery = useQuery({
		...trpc.flow.spans.queryOptions({
			project,
			from: new Date(range.from),
			to: new Date(range.to),
		}),
		placeholderData: keepPreviousData,
	});

	const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(
		() => new Map(),
	);
	const onToggle = useCallback((key: string, open: boolean) => {
		setOverrides((prev) => new Map(prev).set(key, open));
	}, []);

	// Follow: keep the newest active node in view until the person scrolls.
	const [follow, setFollow] = useState(false);
	const gridRef = useRef<TreeGridHandle | null>(null);
	const target = useMemo(() => followTarget(nodes), [nodes]);
	useEffect(() => {
		if (!follow || !target) return;
		const view = buildFlow(nodes, { overrides, filter, now: Date.now() });
		const i = rowIndexFor(view, nodes, target);
		const key = view.rows[i]?.key;
		if (key) gridRef.current?.scrollToKey(key);
	}, [follow, target, nodes, overrides, filter]);

	const times = useMemo(
		() =>
			stepTimes(spansQuery.data?.spans ?? [], spansQuery.data?.markers ?? []),
		[spansQuery.data],
	);
	useKeyBindings([
		{
			key: "f",
			label: follow ? "Stop following" : "Follow the newest run",
			group: "Flow",
			run: () => setFollow((v) => !v),
		},
		...scrubBindings({
			at,
			times,
			now,
			onT: (t) => onSearch({ t }),
		}),
	]);

	const setFilter = (next: FlowFilter) =>
		onSearch({ f: formatFlowFilter(next) });
	const windowId = search.w ?? FIT_WINDOW;

	return (
		<div ref={measure} className="flex h-full min-h-0 flex-col">
			<div
				className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b px-3 py-1.5"
				style={{ borderColor: "var(--mfw-border)" }}
			>
				<FilterBar nodes={nodes} filter={filter} onFilter={setFilter} />
				{wide ? (
					<span className="inline-flex items-center gap-1">
						<TimeControls
							windowId={windowId}
							live={win.live}
							onWindow={(w) =>
								onSearch({ w: w === FIT_WINDOW ? undefined : w })
							}
							onPan={(dir) =>
								onSearch({ t: panned(win, dir, now) ?? undefined })
							}
							onLive={() => onSearch({ t: undefined })}
						/>
						<FlowLegend />
					</span>
				) : null}
			</div>
			<TimeCursor
				at={at}
				now={now}
				times={times}
				onT={(t) => onSearch({ t })}
			/>
			<div className="relative flex min-h-0 flex-1 flex-col">
				{tree.isLoading ? (
					<div className="p-3">
						<LoadingRows rows={8} />
					</div>
				) : tree.error ? (
					<div className="p-3">
						<ErrorState
							title="Could not load the work tree"
							error={tree.error}
							onRetry={() => void tree.refetch()}
						/>
					</div>
				) : (
					<FlowLens
						nodes={nodes}
						spans={spansQuery.data?.spans ?? []}
						markers={spansQuery.data?.markers ?? []}
						filter={filter}
						window={win}
						now={now}
						width={width}
						wide={wide}
						selectedRef={search.node ?? null}
						overrides={overrides}
						onToggle={onToggle}
						onSelect={(ref) => onSearch({ node: ref, tab: undefined })}
						// `.`: the row's actions. Until controls land, that is the node as a
						// page. There are none on the past: you cannot steer it.
						{...rowActions(scrubbed, (ref) => go(href.node(project, ref)))}
						onManualScroll={() => setFollow(false)}
						gridRef={gridRef}
					/>
				)}
				{!follow && live && target ? (
					<button
						type="button"
						onClick={() => setFollow(true)}
						className="mfw-focus absolute right-4 bottom-10 inline-flex items-center gap-1 px-2 py-1"
						style={{
							background: "var(--mfw-bg-raised)",
							border: "1px solid var(--mfw-border)",
							borderRadius: "var(--mfw-radius-md)",
							fontSize: "var(--mfw-text-xs)",
						}}
					>
						<ArrowDown aria-hidden className="size-3.5" />
						Follow
					</button>
				) : null}
			</div>
		</div>
	);
}
