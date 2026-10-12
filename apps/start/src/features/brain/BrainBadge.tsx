import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { AppLink } from "../../components/AppLink";
import { StateGlyph } from "../../components/agent/StateGlyph";
import { Chip } from "../../components/Page";
import { nodeRef } from "../../lib/nodeRef";
import { useTRPC } from "../../lib/trpc";
import { href } from "../../routes";
import {
	BRAIN_OFF_HINT,
	type BrainStateRow,
	brainGlyph,
	brainLine,
	brainNeedsMe,
} from "./brain";

/**
 * One read for every project's brain (`brain.states`), kept fresh by the
 * `brain.*` live events. The rail, the presence bar and the project header
 * all draw from it, so they cannot disagree.
 */
export function useBrainStates(): ReadonlyMap<string, BrainStateRow> {
	const trpc = useTRPC();
	const q = useQuery({
		...trpc.brain.states.queryOptions(),
		staleTime: 30_000,
	});
	return useMemo(
		() => new Map((q.data ?? []).map((r) => [r.project, r])),
		[q.data],
	);
}

/**
 * A brain's glyph as a link to its inspector: a diamond, pulsing while a
 * turn runs; paused and stuck have their own icons. Draws nothing when the brain is off.
 */
export function BrainGlyphLink({
	project,
	row,
	className,
	onNavigate,
}: {
	project: string;
	row: BrainStateRow | undefined;
	className?: string;
	onNavigate?: (to: string) => void;
}) {
	const state = brainGlyph(row);
	if (!row || !state) return null;
	const to = href.flow(project, { node: nodeRef.brain() });
	return (
		<AppLink
			to={to}
			title={brainLine(row)}
			aria-label={brainLine(row)}
			className={className ?? "inline-flex items-center no-underline"}
			navigate={onNavigate ? () => onNavigate(to) : undefined}
		>
			<StateGlyph subject={{ kind: "brain", value: state }} />
		</AppLink>
	);
}

/**
 * The project header's brain status: the glyph with a word, loud when it is
 * stuck, and a quiet hint (not an error) when no brain is configured.
 */
export function BrainHeaderChip({
	project,
	row,
}: {
	project: string;
	row: BrainStateRow | undefined;
}) {
	// Nothing known yet: draw nothing rather than flash the off hint.
	if (!row) return null;
	if (!row.enabled || row.state === "off") {
		return (
			<AppLink
				to={href.projectSettings(project)}
				data-testid="brain-off-hint"
				className="no-underline"
				style={{
					color: "var(--mfw-fg-faint)",
					fontSize: "var(--mfw-text-xs)",
				}}
			>
				{BRAIN_OFF_HINT}
			</AppLink>
		);
	}
	const state = brainGlyph(row);
	if (!state) return null;
	const stuck = brainNeedsMe(row);
	const word =
		state === "turn"
			? "thinking"
			: state === "failed"
				? "stuck"
				: state === "paused"
					? "paused"
					: "idle";
	return (
		<AppLink
			to={href.flow(project, { node: nodeRef.brain() })}
			title={brainLine(row)}
			className="no-underline"
			data-testid="brain-chip"
		>
			<Chip tone={stuck ? "critical" : "accent"}>
				<StateGlyph subject={{ kind: "brain", value: state }} />
				{word}
			</Chip>
		</AppLink>
	);
}
