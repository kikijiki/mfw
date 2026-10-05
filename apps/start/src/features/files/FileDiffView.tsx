import { type ReactNode, useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import type { RouterOutputs } from "../../lib/trpc";
import type { DiffRow } from "../review/diff";
import { collapse, countChanges, diffLines } from "../review/diff";

/**
 * The Files screen's diff, side by side, read only.
 *
 * Everything here is `review/diff.ts`'s pure line differ wearing a plain
 * skin: no comment threads, no composer, because a dirty file in the
 * workspace browser is not attached to a task review. Pulling in the full
 * `DiffView` would drag its comment affordances along for a screen that has
 * nowhere to send them.
 */

export type WorkspaceFileDiff = RouterOutputs["files"]["diffFile"];

export function FileDiffView({
	diff,
	unified,
}: {
	diff: WorkspaceFileDiff;
	unified: boolean;
}) {
	const rows = useMemo(
		() => diffLines(diff.oldText, diff.newText),
		[diff.oldText, diff.newText],
	);
	const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
	const blocks = useMemo(() => collapse(rows, 3), [rows]);
	const stats = useMemo(() => countChanges(rows), [rows]);

	if (diff.binary) {
		return (
			<Note>
				Binary or oversized file ({diff.status}). There is nothing to diff here.
			</Note>
		);
	}
	if (rows.length === 0) {
		return <Note>No textual change in this file ({diff.status}).</Note>;
	}

	return (
		<div className="flex min-w-0 flex-col">
			<div
				className="flex items-center gap-3 px-2 py-1"
				style={{
					color: "var(--mfw-fg-muted)",
					fontSize: "var(--mfw-text-xs)",
				}}
			>
				<span className="mfw-num" style={{ color: "var(--mfw-ok)" }}>
					+{stats.added}
				</span>
				<span className="mfw-num" style={{ color: "var(--mfw-critical)" }}>
					−{stats.removed}
				</span>
			</div>

			<div
				className="min-w-0 overflow-x-auto border"
				style={{
					borderColor: "var(--mfw-border)",
					borderRadius: "var(--mfw-radius-sm)",
					background: "var(--mfw-bg-raised)",
					fontFamily: "var(--mfw-font-mono)",
					fontSize: "var(--mfw-text-xs)",
					lineHeight: "var(--mfw-leading-data)",
				}}
			>
				{blocks.map((block, blockIndex) => {
					if (block.kind === "gap") {
						const isOpen = expanded.has(blockIndex);
						if (!isOpen) {
							return (
								<button
									// biome-ignore lint/suspicious/noArrayIndexKey: blocks are positional and immutable per diff
									key={blockIndex}
									type="button"
									className="mfw-focus flex w-full items-center gap-2 px-2 py-1"
									style={{
										background: "var(--mfw-bg-inset)",
										color: "var(--mfw-fg-faint)",
									}}
									onClick={() =>
										setExpanded((prev) => new Set(prev).add(blockIndex))
									}
								>
									⋯ {block.rows.length} unchanged lines, click to expand
								</button>
							);
						}
					}
					return (
						// biome-ignore lint/suspicious/noArrayIndexKey: blocks are positional and immutable per diff
						<Rows key={blockIndex} rows={block.rows} unified={unified} />
					);
				})}
			</div>
		</div>
	);
}

function Rows({ rows, unified }: { rows: DiffRow[]; unified: boolean }) {
	return (
		<div className="min-w-fit">
			{rows.map((row) => (
				<div key={`${row.oldLine ?? "-"}:${row.newLine ?? "-"}:${row.kind}`}>
					{unified ? <UnifiedRow row={row} /> : <SplitRow row={row} />}
				</div>
			))}
		</div>
	);
}

const ROW_BG: Record<DiffRow["kind"], { left?: string; right?: string }> = {
	context: {},
	add: { right: "var(--mfw-diff-add-bg)" },
	del: { left: "var(--mfw-diff-del-bg)" },
	change: {
		left: "var(--mfw-diff-del-bg)",
		right: "var(--mfw-diff-add-bg)",
	},
};

function SplitRow({ row }: { row: DiffRow }) {
	const bg = ROW_BG[row.kind];
	return (
		<div className="grid grid-cols-2">
			<Side
				line={row.oldLine}
				text={row.oldText}
				background={bg.left}
				borderRight
			/>
			<Side line={row.newLine} text={row.newText} background={bg.right} />
		</div>
	);
}

function UnifiedRow({ row }: { row: DiffRow }) {
	if (row.kind === "change") {
		return (
			<>
				<Side
					line={row.oldLine}
					text={row.oldText}
					background="var(--mfw-diff-del-bg)"
					marker="−"
				/>
				<Side
					line={row.newLine}
					text={row.newText}
					background="var(--mfw-diff-add-bg)"
					marker="+"
				/>
			</>
		);
	}
	const isAdd = row.kind === "add";
	const isDel = row.kind === "del";
	return (
		<Side
			line={isDel ? row.oldLine : row.newLine}
			text={isDel ? row.oldText : row.newText}
			background={
				isAdd
					? "var(--mfw-diff-add-bg)"
					: isDel
						? "var(--mfw-diff-del-bg)"
						: undefined
			}
			marker={isAdd ? "+" : isDel ? "−" : " "}
		/>
	);
}

function Side({
	line,
	text,
	background,
	borderRight = false,
	marker,
}: {
	line: number | null;
	text: string | null;
	background?: string;
	borderRight?: boolean;
	marker?: string;
}) {
	return (
		<div
			className={cn("flex min-w-0", borderRight && "border-r")}
			style={{ background, borderColor: "var(--mfw-border)" }}
		>
			<span
				className="mfw-num w-12 shrink-0 px-1 text-right select-none"
				style={{
					color: "var(--mfw-fg-faint)",
					background:
						"color-mix(in oklch, var(--mfw-bg-inset) 60%, transparent)",
				}}
			>
				{line ?? ""}
			</span>
			{marker ? (
				<span
					aria-hidden
					className="w-3 shrink-0 text-center"
					style={{ color: "var(--mfw-fg-faint)" }}
				>
					{marker}
				</span>
			) : null}
			<pre className="flex-1 px-2 whitespace-pre">{text ?? ""}</pre>
		</div>
	);
}

function Note({ children }: { children: ReactNode }) {
	return (
		<div
			className="p-3"
			style={{
				color: "var(--mfw-fg-muted)",
				background: "var(--mfw-bg-subtle)",
				borderRadius: "var(--mfw-radius-sm)",
			}}
		>
			{children}
		</div>
	);
}
