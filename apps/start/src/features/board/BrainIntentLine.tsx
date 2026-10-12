import { TipP } from "~/components/ui/tooltip";
import { Glyph } from "../../components/icons";
import { humanizeToken } from "../../lib/format";
import type { CardIntent } from "./boardAgents";

/** What a brain tool call means in plain words, for a card that has no room for the tool name. */
const INTENT_WORDS: Record<string, string> = {
	"tasks.move": "moved this task",
	"tasks.set_status": "changed this task's status",
	"tasks.update": "edited this task",
	"tasks.create": "created this task",
	"tasks.reparent": "moved this task under another",
	"tasks.split": "split this task",
	"tasks.merge": "merged this task",
	spawn: "started an agent on this",
	spawn_attempts: "started competing attempts",
	select_winner: "picked a winning attempt",
	request_review: "asked for a review",
	steer: "steered the agent",
	stop: "stopped the agent",
	pause: "paused the work",
	resume: "resumed the work",
	notify_human: "asked you",
};

/**
 * The brain's standing intent on a collapsed card (design §6.2): the newest
 * decision about the task, only while no run has started since (the board's
 * `brain.intents` query already applies that rule server-side). One line, so
 * a card stays at most three lines tall.
 *
 * In shadow mode the intent is a proposal: the line says so, and the fixed
 * pipeline is what will actually act.
 */
export function BrainIntentLine({ intent }: { intent: CardIntent }) {
	const shadow = intent.state === "proposed";
	return (
		<TipP
			data-testid="brain-intent"
			className="m-0 min-w-0 truncate"
			style={{
				color: "var(--mfw-accent)",
				fontSize: "var(--mfw-text-xs)",
			}}
			tip={`${intent.rationale}${shadow ? " (shadow: proposed, the pipeline acts)" : ""}`}
			clipped
		>
			<Glyph
				name="diamond"
				label="brain"
				className="mr-1 inline size-3 align-[-2px]"
			/>
			brain{shadow ? " (proposed)" : ""}{" "}
			{INTENT_WORDS[intent.tool] ?? humanizeToken(intent.tool)}
			{intent.rationale ? `: ${intent.rationale}` : ""}
		</TipP>
	);
}
