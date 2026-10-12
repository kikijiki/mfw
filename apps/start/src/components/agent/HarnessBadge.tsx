import { cn } from "~/lib/utils";
import { TipSpan } from "../ui/tooltip";
import { harnessMonogram } from "./look";

/** Two-letter square for the harness. Neutral on purpose: a harness is not a state. */
export function HarnessBadge({
	harness,
	className,
}: {
	harness: string;
	className?: string;
}) {
	return (
		<TipSpan
			tip={harness}
			className={cn(
				"mfw-num inline-flex size-5 shrink-0 items-center justify-center border",
				className,
			)}
			style={{
				color: "var(--mfw-fg-muted)",
				borderColor: "var(--mfw-border)",
				background: "var(--mfw-bg-subtle)",
				borderRadius: "var(--mfw-radius-sm)",
				fontSize: "var(--mfw-text-2xs)",
				fontWeight: 600,
			}}
		>
			{harnessMonogram(harness)}
		</TipSpan>
	);
}
