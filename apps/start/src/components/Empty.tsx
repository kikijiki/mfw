import { Inbox, type LucideIcon, SearchX } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

/**
 * The empty state: one icon, one sentence, one action.
 *
 * `reason` is not decoration. "Nothing here" and "your filter matched nothing"
 * demand different next moves, and v1 rendered the same blank panel for both,
 * so an operator with a stale label filter concluded the project was empty.
 *
 * `tone="success"` exists for INBOX-at-zero: an empty attention queue is the
 * product working, and it should read like one.
 */
export interface EmptyProps {
	title: string;
	description?: ReactNode;
	icon?: LucideIcon;
	reason?: "none" | "filtered";
	tone?: "neutral" | "success";
	action?: ReactNode;
	className?: string;
}

export function Empty({
	title,
	description,
	icon,
	reason = "none",
	tone = "neutral",
	action,
	className,
}: EmptyProps) {
	const Icon = icon ?? (reason === "filtered" ? SearchX : Inbox);
	const color = tone === "success" ? "var(--mfw-ok)" : "var(--mfw-fg-faint)";
	return (
		<div
			className={cn(
				"flex flex-col items-center justify-center gap-2 px-6 py-10 text-center",
				className,
			)}
		>
			<Icon aria-hidden className="size-6" style={{ color }} />
			<div style={{ fontSize: "var(--mfw-text-md)" }}>{title}</div>
			{description ? (
				<div
					className="max-w-100"
					style={{
						color: "var(--mfw-fg-muted)",
						fontSize: "var(--mfw-text-xs)",
						lineHeight: "var(--mfw-leading-prose)",
					}}
				>
					{description}
				</div>
			) : null}
			{action ? <div className="mt-2 flex gap-2">{action}</div> : null}
		</div>
	);
}
