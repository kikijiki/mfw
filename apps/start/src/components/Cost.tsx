import { cn } from "~/lib/utils";
import { formatCost, formatDuration, formatTokens } from "../lib/format";

/**
 * Money, tokens and durations in tabular numerals.
 *
 * `.mfw-num` sets `font-variant-numeric: tabular-nums` on the mono face, so a
 * column of costs stays aligned and a ticking figure does not shift the row it
 * lives in. Scanning a run list for "the expensive one" is a column-comparison
 * task; proportional digits make it a reading task.
 */

export function Cost({
	usd,
	className,
	title,
}: {
	usd: number | null | undefined;
	className?: string;
	title?: string;
}) {
	return (
		<span
			className={cn("mfw-num whitespace-nowrap", className)}
			title={title ?? (usd == null ? undefined : `$${usd}`)}
		>
			{formatCost(usd)}
		</span>
	);
}

export function Tokens({
	count,
	className,
}: {
	count: number | null | undefined;
	className?: string;
}) {
	return (
		<span
			className={cn("mfw-num whitespace-nowrap", className)}
			title={
				count == null ? undefined : `${count.toLocaleString("en-US")} tokens`
			}
		>
			{formatTokens(count)}
		</span>
	);
}

export function Duration({
	ms,
	className,
}: {
	ms: number | null | undefined;
	className?: string;
}) {
	return (
		<span className={cn("mfw-num whitespace-nowrap", className)}>
			{formatDuration(ms)}
		</span>
	);
}

/** Monospaced identifier (task id, run id, branch) with a copy affordance. */
export function Mono({
	value,
	className,
	truncate,
}: {
	value: string;
	className?: string;
	/** Show only the first N characters, run ULIDs are 26 chars of noise. */
	truncate?: number;
}) {
	const shown =
		truncate && value.length > truncate
			? `${value.slice(0, truncate)}…`
			: value;
	return (
		<span className={cn("mfw-num", className)} title={value}>
			{shown}
		</span>
	);
}
