import { cn } from "~/lib/utils";
import { Glyph } from "../icons";
import { TipSpan } from "../ui/tooltip";
import { type Look, type LookSubject, look } from "./look";

/**
 * One agent state as a mark: an inline SVG icon (`GLYPHS`, never a text
 * glyph), coloured from the state's token, with a label for assistive tech
 * and tooltips. `showLabel` adds the word beside it (legends, inspector
 * headers); without it the label is `aria-label` and a tooltip.
 */
export function StateGlyph({
	subject,
	look: given,
	showLabel = false,
	className,
}: {
	subject?: LookSubject;
	/** An already-resolved look (`lookForRun`), instead of `subject`. */
	look?: Look;
	showLabel?: boolean;
	className?: string;
}) {
	const l = given ?? (subject ? look(subject) : null);
	if (!l) return null;
	const color = `var(${l.token})`;
	return (
		<TipSpan
			role="img"
			aria-label={l.label}
			tip={showLabel ? undefined : l.label}
			data-glyph={l.glyph}
			className={cn("inline-flex items-center gap-1", className)}
		>
			<span aria-hidden className="inline-flex shrink-0" style={{ color }}>
				<Glyph
					name={l.glyph}
					className={l.glyph === "square" ? "size-2.5" : "size-3.5"}
					bold={l.filled}
				/>
			</span>
			{showLabel ? (
				<span style={{ color, fontSize: "var(--mfw-text-2xs)" }}>
					{l.label}
				</span>
			) : null}
		</TipSpan>
	);
}
