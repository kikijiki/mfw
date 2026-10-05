import type { CSSProperties } from "react";

import { cn } from "~/lib/utils";

/**
 * Loading states.
 *
 * Skeletons only, and only on the first load of a surface; live updates make
 * refetches invisible. No full-page spinners. Skeleton shapes must match the
 * real layout (row count, column widths).
 */

export function Skeleton({
	className,
	style,
}: {
	className?: string;
	style?: CSSProperties;
}) {
	return (
		<div
			aria-hidden
			className={cn("mfw-skeleton h-4 w-full", className)}
			style={style}
		/>
	);
}

/** Placeholder for a list/table: `rows` bars at the current row height. */
export function LoadingRows({
	rows = 6,
	className,
}: {
	rows?: number;
	className?: string;
}) {
	return (
		<output
			aria-busy="true"
			aria-label="Loading"
			className={cn("flex w-full flex-col gap-1", className)}
		>
			{Array.from({ length: rows }, (_, i) => (
				<div
					// biome-ignore lint/suspicious/noArrayIndexKey: fixed-length placeholder, never reordered
					key={i}
					className="mfw-skeleton"
					style={{
						height: "var(--mfw-row-h)",
						// Ragged widths read as loading content; uniform bars look broken.
						width: `${88 - (i % 3) * 9}%`,
					}}
				/>
			))}
		</output>
	);
}

/** Placeholder for a card grid (NOW, digest cards). */
export function LoadingCards({
	cards = 2,
	className,
}: {
	cards?: number;
	className?: string;
}) {
	return (
		<output
			aria-busy="true"
			aria-label="Loading"
			className={cn("grid w-full gap-3", className)}
		>
			{Array.from({ length: cards }, (_, i) => (
				<div
					// biome-ignore lint/suspicious/noArrayIndexKey: fixed-length placeholder, never reordered
					key={i}
					className="border p-3"
					style={{
						borderColor: "var(--mfw-border)",
						borderRadius: "var(--mfw-radius-md)",
					}}
				>
					<Skeleton className="mb-2 h-4 w-2/5" />
					<Skeleton className="mb-3 h-3 w-1/4" />
					<Skeleton className="h-16 w-full" />
				</div>
			))}
		</output>
	);
}

/**
 * Inline "working" marker for buttons awaiting a server-authoritative
 * mutation (`tasks.run`, `runs.stop`); no optimistic result.
 */
export function Pending({ label = "Working…" }: { label?: string }) {
	return (
		<span
			aria-live="polite"
			className="mfw-pulse inline-flex items-center gap-1"
			style={{ color: "var(--mfw-fg-muted)" }}
		>
			{label}
		</span>
	);
}
