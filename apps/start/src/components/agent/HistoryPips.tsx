import { cn } from "~/lib/utils";
import { Glyph } from "../icons";
import { TipButton, TipSpan } from "../ui/tooltip";
import { PIP_LOOK, type PipGlyph } from "./look";

export interface Pip {
	/** Node ref (`run:…` or `decision:…`), what a click selects. */
	ref: string;
	glyph: PipGlyph;
}

export const PIP_CAP = 12;

/** The pips to draw: the newest `cap`, oldest first, and how many older ones fold into `+n`. */
export function visiblePips(
	pips: readonly Pip[],
	cap: number = PIP_CAP,
): { shown: Pip[]; hidden: number } {
	const hidden = Math.max(0, pips.length - cap);
	return { shown: pips.slice(hidden), hidden };
}

/** One glyph per settled run (and brain decision), oldest first, capped at 12 with `+n`. */
export function HistoryPips({
	pips,
	cap = PIP_CAP,
	onSelect,
	className,
}: {
	pips: readonly Pip[];
	cap?: number;
	onSelect?: (ref: string) => void;
	className?: string;
}) {
	if (pips.length === 0) return null;
	const { shown, hidden } = visiblePips(pips, cap);
	return (
		<ul
			aria-label={`${pips.length} past ${pips.length === 1 ? "event" : "events"}`}
			className={cn(
				"m-0 inline-flex list-none items-center gap-0.5 p-0",
				className,
			)}
			style={{ fontSize: "var(--mfw-text-xs)" }}
		>
			{hidden > 0 ? (
				<li className="mfw-num" style={{ color: "var(--mfw-fg-faint)" }}>
					+{hidden}
				</li>
			) : null}
			{shown.map((pip, i) => {
				const key = `${pip.ref}:${hidden + i}`;
				const l = PIP_LOOK[pip.glyph] ?? PIP_LOOK.stopped;
				const style = { color: `var(${l.token})` };
				const label = `${l.label}: ${pip.ref}`;
				return (
					<li key={key}>
						{onSelect ? (
							<TipButton
								type="button"
								tip={label}
								aria-label={label}
								onClick={() => onSelect(pip.ref)}
								className="mfw-focus inline-flex leading-none"
								style={style}
							>
								<Glyph name={l.glyph} />
							</TipButton>
						) : (
							<TipSpan
								role="img"
								tip={label}
								aria-label={label}
								className="inline-flex leading-none"
								style={style}
							>
								<Glyph name={l.glyph} />
							</TipSpan>
						)}
					</li>
				);
			})}
		</ul>
	);
}
