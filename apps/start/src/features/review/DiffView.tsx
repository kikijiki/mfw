import { Check, MessageSquarePlus, Trash2, Undo2 } from "lucide-react";
import { type ReactNode, useMemo, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { cn } from "~/lib/utils";
import { RelativeTime } from "../../components/RelativeTime";
import { useKeyBindings } from "../../lib/keyboard";
import type { RouterOutputs } from "../../lib/trpc";
import type { DiffRow } from "./diff";
import { collapse, countChanges, diffLines } from "./diff";

/** The diff, side by side, with comments anchored to a file and line so they render next to the code and the repair prompt gets addresses. */

export type ReviewFile = RouterOutputs["review"]["bundle"]["files"][number];
export type ReviewComment = RouterOutputs["review"]["comments"]["list"][number];

export interface DiffViewProps {
	file: ReviewFile;
	comments: ReviewComment[];
	unified: boolean;
	onAdd: (input: { line: number; side: "old" | "new"; body: string }) => void;
	onResolve: (id: number, resolved: boolean) => void;
	onRemove: (id: number) => void;
	adding?: boolean;
}

export function DiffView({
	file,
	comments,
	unified,
	onAdd,
	onResolve,
	onRemove,
	adding = false,
}: DiffViewProps) {
	const rows = useMemo(
		() => diffLines(file.oldText, file.newText),
		[file.oldText, file.newText],
	);
	const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
	const blocks = useMemo(() => collapse(rows, 3), [rows]);
	const stats = useMemo(() => countChanges(rows), [rows]);
	const [composer, setComposer] = useState<{
		line: number;
		side: "old" | "new";
	} | null>(null);
	const [draft, setDraft] = useState("");
	const containerRef = useRef<HTMLDivElement | null>(null);
	const hunkRefs = useRef<(HTMLDivElement | null)[]>([]);
	const [hunk, setHunk] = useState(0);

	const byAnchor = useMemo(() => {
		const map = new Map<string, ReviewComment[]>();
		for (const c of comments) {
			const key = `${c.side}:${c.line}`;
			const list = map.get(key) ?? [];
			list.push(c);
			map.set(key, list);
		}
		return map;
	}, [comments]);

	const hunkCount = blocks.filter((b) => b.kind === "rows" && b.changed).length;

	const gotoHunk = (delta: number) => {
		if (hunkCount === 0) return;
		const next = (hunk + delta + hunkCount) % hunkCount;
		setHunk(next);
		hunkRefs.current[next]?.scrollIntoView({ block: "center" });
	};

	useKeyBindings([
		{
			key: "n",
			label: "Next hunk",
			group: "Review",
			enabled: hunkCount > 0,
			run: () => gotoHunk(1),
		},
		{
			key: "p",
			label: "Previous hunk",
			group: "Review",
			enabled: hunkCount > 0,
			run: () => gotoHunk(-1),
		},
	]);

	if (file.binary) {
		return (
			<Note>
				Binary or oversized file ({file.status}). There is nothing to read here;
				judge it from the checks and the agent's report.
			</Note>
		);
	}
	if (rows.length === 0) {
		return <Note>No textual change in this file ({file.status}).</Note>;
	}

	let hunkIndex = -1;

	return (
		<div className="flex min-w-0 flex-col">
			<div
				className="flex items-center gap-3 px-2 py-1"
				style={{
					color: "var(--mfw-fg-muted)",
					fontSize: "var(--mfw-text-xs)",
				}}
			>
				<span className="mfw-num truncate" title={file.path}>
					{file.path}
				</span>
				<span className="mfw-num" style={{ color: "var(--mfw-ok)" }}>
					+{stats.added}
				</span>
				<span className="mfw-num" style={{ color: "var(--mfw-critical)" }}>
					−{stats.removed}
				</span>
				<span className="flex-1" />
				{hunkCount > 0 ? (
					<span>
						hunk {Math.min(hunk + 1, hunkCount)} / {hunkCount} · n / p
					</span>
				) : null}
			</div>

			<div
				ref={containerRef}
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
									// biome-ignore lint/suspicious/noArrayIndexKey: blocks are positional and immutable per file
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
						return (
							<Rows
								// biome-ignore lint/suspicious/noArrayIndexKey: blocks are positional and immutable per file
								key={blockIndex}
								rows={block.rows}
								unified={unified}
								byAnchor={byAnchor}
								composer={composer}
								setComposer={setComposer}
								draft={draft}
								setDraft={setDraft}
								onAdd={onAdd}
								onResolve={onResolve}
								onRemove={onRemove}
								adding={adding}
							/>
						);
					}
					if (block.changed) hunkIndex += 1;
					const myHunk = block.changed ? hunkIndex : -1;
					return (
						<div
							// biome-ignore lint/suspicious/noArrayIndexKey: blocks are positional and immutable per file
							key={blockIndex}
							ref={(node) => {
								if (myHunk >= 0) hunkRefs.current[myHunk] = node;
							}}
						>
							<Rows
								rows={block.rows}
								unified={unified}
								byAnchor={byAnchor}
								composer={composer}
								setComposer={setComposer}
								draft={draft}
								setDraft={setDraft}
								onAdd={onAdd}
								onResolve={onResolve}
								onRemove={onRemove}
								adding={adding}
							/>
						</div>
					);
				})}
			</div>
		</div>
	);
}

interface RowsProps {
	rows: DiffRow[];
	unified: boolean;
	byAnchor: Map<string, ReviewComment[]>;
	composer: { line: number; side: "old" | "new" } | null;
	setComposer: (c: { line: number; side: "old" | "new" } | null) => void;
	draft: string;
	setDraft: (v: string) => void;
	onAdd: (input: { line: number; side: "old" | "new"; body: string }) => void;
	onResolve: (id: number, resolved: boolean) => void;
	onRemove: (id: number) => void;
	adding: boolean;
}

function Rows(props: RowsProps) {
	const { rows, unified } = props;
	return (
		<div className="min-w-fit">
			{rows.map((row) => (
				<div key={`${row.oldLine ?? "-"}:${row.newLine ?? "-"}:${row.kind}`}>
					{unified ? (
						<UnifiedRow row={row} {...props} />
					) : (
						<SplitRow row={row} {...props} />
					)}
					<Threads row={row} {...props} />
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

function SplitRow({ row, setComposer }: RowsProps & { row: DiffRow }) {
	const bg = ROW_BG[row.kind];
	return (
		<div className="grid grid-cols-2">
			<Side
				line={row.oldLine}
				text={row.oldText}
				background={bg.left}
				onComment={
					row.oldLine === null
						? undefined
						: () => setComposer({ line: row.oldLine as number, side: "old" })
				}
				borderRight
			/>
			<Side
				line={row.newLine}
				text={row.newText}
				background={bg.right}
				onComment={
					row.newLine === null
						? undefined
						: () => setComposer({ line: row.newLine as number, side: "new" })
				}
			/>
		</div>
	);
}

function UnifiedRow({ row, setComposer }: RowsProps & { row: DiffRow }) {
	if (row.kind === "change") {
		return (
			<>
				<Side
					line={row.oldLine}
					text={row.oldText}
					background="var(--mfw-diff-del-bg)"
					marker="−"
					onComment={() =>
						setComposer({ line: row.oldLine as number, side: "old" })
					}
				/>
				<Side
					line={row.newLine}
					text={row.newText}
					background="var(--mfw-diff-add-bg)"
					marker="+"
					onComment={() =>
						setComposer({ line: row.newLine as number, side: "new" })
					}
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
			onComment={() => {
				const side = isDel ? "old" : "new";
				const line = isDel ? row.oldLine : row.newLine;
				if (line !== null) setComposer({ line, side });
			}}
		/>
	);
}

function Side({
	line,
	text,
	background,
	onComment,
	borderRight = false,
	marker,
}: {
	line: number | null;
	text: string | null;
	background?: string;
	onComment?: () => void;
	borderRight?: boolean;
	marker?: string;
}) {
	return (
		<div
			className={cn("flex min-w-0", borderRight && "border-r")}
			style={{ background, borderColor: "var(--mfw-border)" }}
		>
			<button
				type="button"
				disabled={!onComment}
				title={onComment ? "Comment on this line" : undefined}
				aria-label={line === null ? undefined : `Comment on line ${line}`}
				onClick={onComment}
				className="mfw-focus mfw-num w-12 shrink-0 px-1 text-right select-none disabled:cursor-default"
				style={{
					color: "var(--mfw-fg-faint)",
					background:
						"color-mix(in oklch, var(--mfw-bg-inset) 60%, transparent)",
				}}
			>
				{line ?? ""}
			</button>
			{marker ? (
				<span
					aria-hidden
					className="w-3 shrink-0 text-center"
					style={{ color: "var(--mfw-fg-faint)" }}
				>
					{marker}
				</span>
			) : null}
			{/*
			 * No `overflow-x-auto` or `min-w-0` here: together they gave every line its
			 * own scrollbar. Without them the widest line sizes the block and the
			 * bordered container scrolls all rows at once. `flex-1` lets short lines
			 * paint their add/delete background across the column.
			 */}
			<pre className="flex-1 px-2 whitespace-pre">{text ?? ""}</pre>
		</div>
	);
}

function Threads({
	row,
	byAnchor,
	composer,
	setComposer,
	draft,
	setDraft,
	onAdd,
	onResolve,
	onRemove,
	adding,
}: RowsProps & { row: DiffRow }) {
	const anchors: { side: "old" | "new"; line: number }[] = [];
	if (row.oldLine !== null) anchors.push({ side: "old", line: row.oldLine });
	if (row.newLine !== null) anchors.push({ side: "new", line: row.newLine });

	const nodes = anchors.flatMap(({ side, line }) => {
		const thread = byAnchor.get(`${side}:${line}`) ?? [];
		const isComposing = composer?.side === side && composer.line === line;
		if (thread.length === 0 && !isComposing) return [];
		return [
			<div
				key={`${side}:${line}`}
				className="border-y px-2 py-1.5"
				style={{
					borderColor: "var(--mfw-border)",
					background: "var(--mfw-bg-subtle)",
					fontFamily: "var(--mfw-font-ui)",
					fontSize: "var(--mfw-text-xs)",
				}}
			>
				<div
					className="mb-1 flex items-center gap-1"
					style={{ color: "var(--mfw-fg-faint)" }}
				>
					<MessageSquarePlus aria-hidden className="size-3" />
					line {line} ({side})
				</div>
				{thread.map((c) => (
					<div key={c.id} className="mb-1 flex items-start gap-2">
						<div className="min-w-0 flex-1">
							<div
								className="break-words whitespace-pre-wrap"
								style={{
									color: c.resolved ? "var(--mfw-fg-faint)" : "var(--mfw-fg)",
									textDecoration: c.resolved ? "line-through" : undefined,
								}}
							>
								{c.body}
							</div>
							<div style={{ color: "var(--mfw-fg-faint)" }}>
								<RelativeTime value={c.createdAt} />
								{c.resolved ? " · resolved" : ""}
							</div>
						</div>
						<Button
							size="icon-xs"
							variant="ghost"
							aria-label={c.resolved ? "Reopen comment" : "Resolve comment"}
							title={c.resolved ? "Reopen" : "Resolve"}
							onClick={() => onResolve(c.id, !c.resolved)}
						>
							{c.resolved ? <Undo2 aria-hidden /> : <Check aria-hidden />}
						</Button>
						<Button
							size="icon-xs"
							variant="ghost"
							aria-label="Delete comment"
							title="Delete"
							onClick={() => onRemove(c.id)}
						>
							<Trash2 aria-hidden />
						</Button>
					</div>
				))}
				{isComposing ? (
					<form
						className="flex flex-col gap-1"
						onSubmit={(e) => {
							e.preventDefault();
							const body = draft.trim();
							if (!body) return;
							onAdd({ line, side, body });
							setDraft("");
							setComposer(null);
						}}
					>
						<Textarea
							autoFocus
							rows={2}
							value={draft}
							placeholder="What needs to change here?"
							onChange={(e) => setDraft(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Escape") {
									e.stopPropagation();
									setComposer(null);
									setDraft("");
								}
								if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
									const body = draft.trim();
									if (!body) return;
									onAdd({ line, side, body });
									setDraft("");
									setComposer(null);
								}
							}}
						/>
						<div className="flex items-center gap-2">
							<Button
								type="submit"
								size="xs"
								disabled={adding || draft.trim().length === 0}
							>
								Comment
							</Button>
							<Button
								type="button"
								size="xs"
								variant="ghost"
								onClick={() => {
									setComposer(null);
									setDraft("");
								}}
							>
								Cancel
							</Button>
							<span style={{ color: "var(--mfw-fg-faint)" }}>⌘⏎ to submit</span>
						</div>
					</form>
				) : null}
			</div>,
		];
	});

	if (nodes.length === 0) return null;
	return <>{nodes}</>;
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
