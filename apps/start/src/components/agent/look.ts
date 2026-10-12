import { isRunActivity, type RunActivity } from "@mfw/core/activity";

import type { GlyphName } from "../icons/glyphs";
import type { RunState } from "../StatusPill";

/**
 * The agent state vocabulary (design §11.2): one table, used on every surface
 * that draws an agent. Pure, so the glyph components, the board cards, the
 * presence bar and the tests all read the same words.
 *
 * Rules the table keeps:
 * - a state is a glyph AND a label, never colour alone;
 * - the colour is a `tokens.css` custom property name, never a literal;
 * - agent states do not borrow the task-status ramp, except `working`, which
 *   shares the in-progress hue on purpose (a working run IS in-progress work).
 */

export type PipGlyph =
	| "ok"
	| "fail"
	| "stopped"
	| "rate"
	| "winner"
	| "decision";

export type BrainState = "idle" | "turn" | "paused" | "failed";

export interface Look {
	/** The mark: a `GLYPHS` key (components/icons/glyphs.ts), drawn as an SVG in the state's token colour. */
	glyph: GlyphName;
	/** The word for it (tooltip, `aria-label`, legends). */
	label: string;
	/** A CSS custom property name from tokens.css. */
	token: string;
	/** The state asks for a person: callers add a ring to the card or row. */
	ring: boolean;
	/** Drawn heavier (an ask, not a status). */
	filled: boolean;
}

const mk = (
	glyph: GlyphName,
	label: string,
	token: string,
	extra: Partial<Pick<Look, "ring" | "filled">> = {},
): Look => ({
	glyph,
	label,
	token,
	ring: false,
	filled: false,
	...extra,
});

export const ACTIVITY_LOOK = {
	working: mk("dot", "working", "--mfw-status-in-progress"),
	idle: mk("ring", "idle", "--mfw-fg-muted"),
	needs_answer: mk("question", "needs answer", "--mfw-warn", {
		ring: true,
		filled: true,
	}),
	awaiting_approval: mk("alert", "awaiting approval", "--mfw-warn", {
		ring: true,
		filled: true,
	}),
	stalled: mk("dashed", "stalled", "--mfw-critical"),
	ended: mk("square", "ended", "--mfw-fg-faint"),
} as const satisfies Record<RunActivity, Look>;

export const STATE_LOOK = {
	starting: mk("clock", "queued", "--mfw-neutral"),
	running: mk("dot", "running", "--mfw-status-in-progress"),
	ended: mk("square", "ended", "--mfw-fg-faint"),
	finalizing: mk("loader", "finalizing", "--mfw-info"),
	merging: mk("merge", "merging", "--mfw-info"),
	completed: mk("check", "merged", "--mfw-ok"),
	failed: mk("cross", "failed", "--mfw-critical"),
	killed: mk("stop", "stopped", "--mfw-warn"),
	interrupted: mk("stop", "interrupted", "--mfw-warn"),
	rate_limited: mk("hourglass", "rate limited", "--mfw-warn"),
	needs_review: mk("eye", "needs review", "--mfw-status-review"),
	finalize_error: mk("cross", "finalize error", "--mfw-critical"),
} as const satisfies Record<RunState, Look>;

export const PIP_LOOK = {
	ok: mk("check", "verified", "--mfw-ok"),
	fail: mk("cross", "failed", "--mfw-critical"),
	stopped: mk("stop", "stopped", "--mfw-warn"),
	rate: mk("hourglass", "rate limited", "--mfw-warn"),
	winner: mk("star", "winner", "--mfw-accent"),
	decision: mk("diamond", "brain decision", "--mfw-accent"),
} as const satisfies Record<PipGlyph, Look>;

export const BRAIN_LOOK = {
	idle: mk("diamond", "brain idle", "--mfw-accent"),
	turn: mk("diamond_solid", "brain turn running", "--mfw-accent", {}),
	paused: mk("paused", "brain paused", "--mfw-neutral"),
	failed: mk("stuck", "brain failed", "--mfw-critical"),
} as const satisfies Record<BrainState, Look>;

/** How a run relates to the run it grew out of: an icon and the word that goes with it. */
export const RELATION_LOOK: Record<
	string,
	{ glyph: GlyphName; label: string }
> = {
	repair: { glyph: "repair", label: "repair" },
	continue: { glyph: "play", label: "continues" },
	resume: { glyph: "play", label: "resumed" },
	answer: { glyph: "reply", label: "answered" },
	unblock: { glyph: "play", label: "unblocked" },
	replan: { glyph: "refresh", label: "replan" },
};

/** A subagent's own status (running / ok / error), same shape as the run looks. */
export const SUB_LOOK = {
	running: mk("dot", "running", "--mfw-status-in-progress"),
	ok: mk("check", "done", "--mfw-ok"),
	error: mk("cross", "failed", "--mfw-critical"),
} as const satisfies Record<"running" | "ok" | "error", Look>;

export const RUN_ACTIVITIES_LOOKED = Object.keys(
	ACTIVITY_LOOK,
) as RunActivity[];
export const RUN_STATES_LOOKED = Object.keys(STATE_LOOK) as RunState[];
export const PIP_GLYPHS = Object.keys(PIP_LOOK) as PipGlyph[];
export const BRAIN_STATES = Object.keys(BRAIN_LOOK) as BrainState[];

export type LookSubject =
	| { kind: "activity"; value: RunActivity }
	| { kind: "state"; value: RunState }
	| { kind: "pip"; value: PipGlyph }
	| { kind: "brain"; value: BrainState };

/** The look of any agent state; an unknown value reads as `ended` rather than throwing (stored JSON). */
export function look(subject: LookSubject): Look {
	switch (subject.kind) {
		case "activity":
			return ACTIVITY_LOOK[subject.value] ?? ACTIVITY_LOOK.ended;
		case "state":
			return STATE_LOOK[subject.value] ?? STATE_LOOK.ended;
		case "pip":
			return PIP_LOOK[subject.value] ?? PIP_LOOK.stopped;
		case "brain":
			return BRAIN_LOOK[subject.value] ?? BRAIN_LOOK.idle;
	}
}

/**
 * What to draw for a run: its live activity while it is live and has one,
 * otherwise its lifecycle state. Callers pass `shownActivity()` output so a
 * guessed question never gets here.
 */
export function lookForRun(run: { state: RunState; activity?: unknown }): Look {
	const live =
		run.state === "running" ||
		run.state === "starting" ||
		run.state === "finalizing" ||
		run.state === "merging";
	if (live && isRunActivity(run.activity) && run.activity !== "ended") {
		return ACTIVITY_LOOK[run.activity];
	}
	return look({ kind: "state", value: run.state });
}

const MONOGRAMS: Record<string, string> = {
	"claude-cli": "CC",
	claude: "CC",
	"codex-cli": "CX",
	codex: "CX",
	opencode: "OC",
	pi: "PI",
};

/** Two-letter harness mark: `claude-cli` → `CC`. A `harness@endpoint` id is read by its harness. */
export function harnessMonogram(harness: string): string {
	const id = harness.split("@")[0]?.trim().toLowerCase() ?? "";
	const known = MONOGRAMS[id];
	if (known) return known;
	const letters = id.replace(/[^a-z0-9]/g, "");
	return (letters.slice(0, 2) || "??").toUpperCase();
}

/** Short model name for a chip (`claude-opus-4-5` → `opus`); the full id belongs in the tooltip. */
export function shortModel(model: string | null | undefined): string {
	if (!model) return "";
	const id = model.includes("/") ? (model.split("/").pop() ?? model) : model;
	const family = /(opus|sonnet|haiku)/i.exec(id);
	if (family?.[1]) return family[1].toLowerCase();
	const gpt = /^(gpt-\d+)/i.exec(id);
	if (gpt?.[1]) return gpt[1].toLowerCase();
	return id.length > 14 ? `${id.slice(0, 13)}…` : id;
}
