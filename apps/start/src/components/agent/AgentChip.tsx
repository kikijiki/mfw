import { cn } from "~/lib/utils";
import { Glyph } from "../icons";
import { Elapsed } from "../RelativeTime";
import { TipSpan } from "../ui/tooltip";
import { HarnessBadge } from "./HarnessBadge";
import { type Look, shortModel } from "./look";
import { StateGlyph } from "./StateGlyph";

/** `$0.42`; under a cent `<$0.01`. */
export function formatLiveCost(usd: number): string {
	if (usd > 0 && usd < 0.01) return "<$0.01";
	return `$${usd.toFixed(2)}`;
}

/**
 * One agent in a strip: state mark, harness, short model, age.
 * state icon, harness, model, age. A competing attempt carries the compete mark in front.
 */
export function AgentChip({
	look,
	harness,
	model,
	startedAt,
	competing = false,
	costUsd,
	className,
}: {
	/** Resolved with `lookForRun` or `look`. */
	look: Look;
	harness: string;
	model?: string | null;
	startedAt?: number | null;
	competing?: boolean;
	/** The run's running cost while it is live; absent until the first sample. */
	costUsd?: number | null;
	className?: string;
}) {
	const short = shortModel(model);
	return (
		<span
			className={cn(
				"inline-flex items-center gap-1 whitespace-nowrap",
				className,
			)}
			style={{
				fontSize: "var(--mfw-text-xs)",
				color: look.ring ? `var(${look.token})` : "var(--mfw-fg)",
			}}
		>
			{competing ? (
				<TipSpan tip="Competing attempt" className="inline-flex">
					<Glyph name="compete" label="competing attempt" />
				</TipSpan>
			) : null}
			<StateGlyph look={look} />
			<HarnessBadge harness={harness} />
			{short ? <span className="mfw-num">{short}</span> : null}
			{costUsd != null ? (
				<TipSpan
					className="mfw-num"
					tip="Cost so far, sampled every 30 s"
					style={{ color: "var(--mfw-fg-muted)" }}
				>
					{formatLiveCost(costUsd)}
				</TipSpan>
			) : null}
			{startedAt != null ? (
				<span style={{ color: "var(--mfw-fg-muted)" }}>
					<Elapsed since={startedAt} />
				</span>
			) : null}
		</span>
	);
}
