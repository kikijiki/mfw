import {
	type Key,
	type ReactNode,
	type Ref,
	useCallback,
	useEffect,
	useImperativeHandle,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";

import { cn } from "~/lib/utils";

/**
 * Windowing list for multi-megabyte logs. Hand-rolled: rows have unknown
 * heights, so each rendered row is measured (replacing the estimate) and
 * offsets are a prefix sum recomputed only when a measurement changes.
 * Scroll updates are coalesced to one state update per animation frame.
 */

export interface VirtualListHandle {
	/** Bring an item into view. `align: "center"` for search hits. */
	scrollToIndex: (index: number, align?: "start" | "center") => void;
	scrollToBottom: () => void;
	/** True while the viewport is parked at the end (the follow pin). */
	isPinned: () => boolean;
}

export interface VirtualListProps<T> {
	items: readonly T[];
	itemKey: (item: T, index: number) => string | number;
	renderItem: (item: T, index: number) => ReactNode;
	/** First-render guess; replaced by the measured height. */
	estimateHeight?: number;
	overscan?: number;
	className?: string;
	/** Follow mode: stay at the bottom as items arrive. */
	pinned?: boolean;
	onPinnedChange?: (pinned: boolean) => void;
	ref?: Ref<VirtualListHandle>;
	empty?: ReactNode;
}

/** Distance from the end that still counts as "at the bottom". */
const PIN_SLACK_PX = 24;

export function VirtualList<T>({
	items,
	itemKey,
	renderItem,
	estimateHeight = 40,
	overscan = 8,
	className,
	pinned = false,
	onPinnedChange,
	ref,
	empty,
}: VirtualListProps<T>) {
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const heights = useRef(new Map<Key, number>());
	const [measureVersion, setMeasureVersion] = useState(0);
	const [scrollTop, setScrollTop] = useState(0);
	const [viewport, setViewport] = useState(600);

	// Offsets[i] is the top of item i; offsets[n] is the total height.
	// biome-ignore lint/correctness/useExhaustiveDependencies: heights live in a ref; measureVersion IS the signal that they changed
	const offsets = useMemo(() => {
		const out = new Float64Array(items.length + 1);
		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			const h =
				item === undefined
					? estimateHeight
					: (heights.current.get(itemKey(item, i)) ?? estimateHeight);
			out[i + 1] = (out[i] ?? 0) + h;
		}
		return out;
		// measureVersion is the dependency that matters: heights is a ref.
	}, [items, itemKey, estimateHeight, measureVersion]);

	const total = offsets[items.length] ?? 0;

	// --- scroll + viewport tracking (one state update per frame) -------------
	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		let frame = 0;
		const read = () => {
			frame = 0;
			setScrollTop(el.scrollTop);
			const atBottom =
				el.scrollHeight - el.scrollTop - el.clientHeight <= PIN_SLACK_PX;
			onPinnedChange?.(atBottom);
		};
		const onScroll = () => {
			if (frame) return;
			frame = requestAnimationFrame(read);
		};
		el.addEventListener("scroll", onScroll, { passive: true });

		const ro = new ResizeObserver(() => setViewport(el.clientHeight));
		ro.observe(el);
		setViewport(el.clientHeight);

		return () => {
			el.removeEventListener("scroll", onScroll);
			if (frame) cancelAnimationFrame(frame);
			ro.disconnect();
		};
	}, [onPinnedChange]);

	// --- visible range -------------------------------------------------------
	const [start, end] = useMemo(() => {
		if (items.length === 0) return [0, 0] as const;
		const top = Math.max(0, scrollTop - overscan * estimateHeight);
		const bottom = scrollTop + viewport + overscan * estimateHeight;
		let lo = 0;
		let hi = items.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if ((offsets[mid + 1] ?? 0) <= top) lo = mid + 1;
			else hi = mid;
		}
		let last = lo;
		while (last < items.length && (offsets[last] ?? 0) < bottom) last++;
		return [lo, Math.min(items.length, last + 1)] as const;
	}, [items.length, offsets, scrollTop, viewport, overscan, estimateHeight]);

	// --- measurement ---------------------------------------------------------
	const measure = useCallback((key: Key, node: HTMLElement | null) => {
		if (!node) return;
		const h = node.getBoundingClientRect().height;
		if (h <= 0) return;
		const previous = heights.current.get(key);
		if (previous !== undefined && Math.abs(previous - h) < 0.5) return;
		heights.current.set(key, h);
		setMeasureVersion((v) => v + 1);
	}, []);

	// --- follow --------------------------------------------------------------
	useLayoutEffect(() => {
		if (!pinned) return;
		const el = scrollRef.current;
		if (!el) return;
		el.scrollTop = el.scrollHeight;
	}, [pinned]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: re-pin whenever the content grows
	useLayoutEffect(() => {
		if (!pinned) return;
		const el = scrollRef.current;
		if (!el) return;
		el.scrollTop = el.scrollHeight;
	}, [pinned, items.length, total]);

	useImperativeHandle(
		ref,
		() => ({
			scrollToIndex: (index, align = "start") => {
				const el = scrollRef.current;
				if (!el) return;
				const top =
					offsets[Math.max(0, Math.min(index, items.length - 1))] ?? 0;
				el.scrollTop =
					align === "center" ? Math.max(0, top - el.clientHeight / 2) : top;
			},
			scrollToBottom: () => {
				const el = scrollRef.current;
				if (el) el.scrollTop = el.scrollHeight;
			},
			isPinned: () => {
				const el = scrollRef.current;
				if (!el) return false;
				return el.scrollHeight - el.scrollTop - el.clientHeight <= PIN_SLACK_PX;
			},
		}),
		[offsets, items.length],
	);

	if (items.length === 0 && empty) {
		return (
			<div
				ref={scrollRef}
				className={cn("min-h-0 flex-1 overflow-auto", className)}
			>
				{empty}
			</div>
		);
	}

	return (
		<div
			ref={scrollRef}
			className={cn("min-h-0 flex-1 overflow-auto", className)}
		>
			<div style={{ height: total, position: "relative" }}>
				{items.slice(start, end).map((item, i) => {
					const index = start + i;
					const key = itemKey(item, index);
					return (
						<div
							key={key}
							ref={(node) => measure(key, node)}
							style={{
								position: "absolute",
								top: offsets[index] ?? 0,
								left: 0,
								right: 0,
							}}
						>
							{renderItem(item, index)}
						</div>
					);
				})}
			</div>
		</div>
	);
}
