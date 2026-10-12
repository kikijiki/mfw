import {
	type KeyboardEvent,
	type ReactNode,
	type Ref,
	useCallback,
	useEffect,
	useImperativeHandle,
	useRef,
	useState,
} from "react";

import { cn } from "~/lib/utils";
import {
	VirtualList,
	type VirtualListHandle,
} from "../../components/VirtualList";
import { useKeyBindings } from "../../lib/keyboard";
import {
	type FlowRow,
	stepTree,
	type TreeKey,
	type TreeStep,
	treeKeyFor,
} from "./flowModel";

/**
 * The tree as a virtualized `role="treegrid"`: only the rows in (and just
 * around) the viewport mount, whatever the tree's size.
 *
 * Virtualization: this reuses `components/VirtualList` rather than adding
 * `@tanstack/react-virtual`. It already windows by measured offsets, takes a
 * `scrollToIndex` handle and runs under `react-dom/server` for the render
 * tests; the rows here are fixed-height (`--mfw-row-h`), the easy case for it.
 * A second windowing dependency would buy nothing.
 *
 * Keyboard: the treegrid is ONE tab stop and the active row is named by
 * `aria-activedescendant`, so the virtualized-away row of a roving tabindex
 * (which would leave no tab stop at all) cannot happen. `j k h l`, the
 * arrows, Enter and `.` are handled on the grid itself, which stops the
 * event, and are also declared in the key registry so `?` lists them.
 */

export interface TreeGridHandle {
	/** Bring a row into view (centered when it is far away). */
	scrollToKey: (key: string) => void;
}

export interface TreeGridProps {
	rows: readonly FlowRow[];
	/** Accessible name of the grid. */
	label: string;
	/** The row whose node is open in the inspector. */
	selectedKey?: string | null;
	/** Draws one row. `id` and `active` come from the grid. */
	renderRow: (
		row: FlowRow,
		ctx: {
			id: string;
			active: boolean;
			selected: boolean;
			index: number;
			/** A click: moves the cursor here and selects. */
			select: (key: string) => void;
		},
	) => ReactNode;
	/** Open or close a row (`key` is a node ref or a `fold:` key). */
	onToggle: (key: string, open: boolean) => void;
	/** Enter, or a click: select this node. */
	onSelect: (key: string) => void;
	/** `.`: this node's actions. */
	onActions?: (ref: string) => void;
	/** The person moved the view by hand (wheel, touch, keys): follow mode lets go. */
	onManualScroll?: () => void;
	estimateHeight?: number;
	empty?: ReactNode;
	className?: string;
	ref?: Ref<TreeGridHandle>;
}

/**
 * What a keydown on the grid does, or `null` when the grid ignores it: any
 * modifier (the registry's chords), or a key that belongs to a control inside
 * a row. Pure, so the wiring is tested without a DOM.
 */
export function keyboardStep(
	e: {
		key: string;
		metaKey: boolean;
		ctrlKey: boolean;
		altKey: boolean;
		fromControl: boolean;
	},
	rows: readonly FlowRow[],
	activeIndex: number,
): TreeStep | null {
	if (e.metaKey || e.ctrlKey || e.altKey || e.fromControl) return null;
	const verb = treeKeyFor(e.key);
	if (!verb || rows.length === 0) return null;
	return stepTree(rows, activeIndex, verb);
}

/** A DOM-safe id for a row key. */
export function rowDomId(key: string): string {
	return `flow-row-${key.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

export function TreeGrid({
	rows,
	label,
	selectedKey = null,
	renderRow,
	onToggle,
	onSelect,
	onActions,
	onManualScroll,
	estimateHeight = 36,
	empty,
	className,
	ref,
}: TreeGridProps) {
	const listRef = useRef<VirtualListHandle | null>(null);
	const [activeKey, setActiveKey] = useState<string | null>(null);
	const [focused, setFocused] = useState(false);

	// The cursor: where the keys act. Follows the selection when that moves.
	const [lastSelected, setLastSelected] = useState<string | null>(null);
	if (selectedKey !== lastSelected) {
		setLastSelected(selectedKey);
		if (selectedKey) setActiveKey(selectedKey);
	}
	const found = activeKey ? rows.findIndex((r) => r.key === activeKey) : -1;
	const activeIndex = rows.length === 0 ? -1 : Math.max(0, found);
	const activeRow = activeIndex >= 0 ? rows[activeIndex] : undefined;

	const reveal = useCallback(
		(key: string) => {
			const i = rows.findIndex((r) => r.key === key);
			if (i < 0) return;
			const el =
				typeof document === "undefined"
					? null
					: document.getElementById(rowDomId(key));
			if (el) el.scrollIntoView({ block: "nearest" });
			else listRef.current?.scrollToIndex(i, "center");
		},
		[rows],
	);

	useImperativeHandle(ref, () => ({ scrollToKey: reveal }), [reveal]);

	// Keep the cursor row in view as it moves.
	const activeRowKey = activeRow?.key;
	// biome-ignore lint/correctness/useExhaustiveDependencies: `reveal` changes with rows; only a cursor move should scroll
	useEffect(() => {
		if (activeRowKey && focused) reveal(activeRowKey);
	}, [activeRowKey, focused]);

	const commit = useCallback(
		(step: TreeStep) => {
			const target = rows[step.focus];
			if (target) setActiveKey(target.key);
			if (step.toggle) onToggle(step.toggle.key, step.toggle.open);
			if (step.select) onSelect(step.select);
			if (step.actions) onActions?.(step.actions);
			onManualScroll?.();
		},
		[rows, onToggle, onSelect, onActions, onManualScroll],
	);

	const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		const step = keyboardStep(
			{
				key: e.key,
				metaKey: e.metaKey,
				ctrlKey: e.ctrlKey,
				altKey: e.altKey,
				// A control inside a row (a link, a button) keeps its own keys.
				fromControl:
					e.target !== e.currentTarget &&
					["INPUT", "TEXTAREA", "SELECT", "A", "BUTTON"].includes(
						(e.target as HTMLElement).tagName,
					),
			},
			rows,
			activeIndex,
		);
		if (!step) return;
		e.preventDefault();
		// The registry listens on `window`; this key is already handled.
		e.stopPropagation();
		commit(step);
	};

	useKeyBindings(
		[
			["j", "Next row", "next"],
			["k", "Previous row", "prev"],
			["l", "Open row", "open"],
			["h", "Close row", "close"],
			["Enter", "Inspect row", "select"],
			[".", "Row actions", "actions"],
		].map(([key, text, verb]) => ({
			key: key as string,
			label: text as string,
			group: "Flow tree",
			// Live only while the grid has focus, where its own handler already ran.
			enabled: focused && rows.length > 0,
			run: () => commit(stepTree(rows, activeIndex, verb as TreeKey)),
		})),
	);

	return (
		<div
			role="treegrid"
			aria-label={label}
			aria-rowcount={rows.length}
			aria-activedescendant={activeRow ? rowDomId(activeRow.key) : undefined}
			tabIndex={0}
			onKeyDown={onKeyDown}
			onFocus={() => setFocused(true)}
			onBlur={() => setFocused(false)}
			onWheel={onManualScroll}
			onTouchMove={onManualScroll}
			data-focused={focused ? "" : undefined}
			className={cn(
				"mfw-focus flex min-h-0 flex-1 flex-col outline-none",
				className,
			)}
		>
			<VirtualList
				ref={listRef}
				items={rows}
				itemKey={(row) => row.key}
				estimateHeight={estimateHeight}
				overscan={6}
				empty={empty}
				renderItem={(row, index) =>
					renderRow(row, {
						id: rowDomId(row.key),
						active: focused && index === activeIndex,
						selected:
							row.kind === "node" &&
							selectedKey !== null &&
							row.key === selectedKey,
						index,
						select: (key) => {
							setActiveKey(key);
							onSelect(key);
						},
					})
				}
			/>
		</div>
	);
}
