import type { MarkerKind } from "@mfw/daemon/flow";

/**
 * The Flow timeline's event marks: the one table the marker lane, the hover
 * card, the cluster popover and the legend all read, so what the legend says
 * is what the timeline draws.
 *
 * Every mark has its own SHAPE and its own colour (never a tint of a shared
 * shape), is drawn at 16px with strokes of at least 1.75px, and is plain SVG
 * geometry (no text glyphs). A mark is a point event; spans are bars and live
 * in the activity lane, never here.
 */

/** What a mark can be: the daemon's marker kinds plus the ones derived from spans. */
export type MarkKind =
	| MarkerKind
	/** A run (or verify) that ended well: a `completed` outcome. */
	| "passed"
	/** A run that ended badly: `failed` / `finalize_error`. */
	| "failed"
	/** A run that was stopped, killed or interrupted. */
	| "stopped"
	/** A hold ended (the end of a `hold` span). */
	| "released";

export type MarkShape =
	| "diamond"
	| "ring"
	| "square"
	| "cross"
	| "check"
	| "disc-cross"
	| "triangle"
	| "bars"
	| "play"
	| "hexagon"
	| "chevrons"
	| "no-entry";

export interface MarkLook {
	/** The legend word. */
	name: string;
	/** One line of what it means. */
	meaning: string;
	shape: MarkShape;
	/** A tokens.css custom property name. */
	token: string;
}

export const MARK_LOOK: Record<MarkKind, MarkLook> = {
	decision: {
		name: "brain decision",
		meaning: "the brain chose an action",
		shape: "diamond",
		token: "--mfw-accent",
	},
	human: {
		name: "human action",
		meaning: "a person steered, approved or overrode",
		shape: "ring",
		token: "--mfw-fg",
	},
	merge: {
		name: "merge",
		meaning: "a merge landed, parked or was abandoned",
		shape: "square",
		token: "--mfw-status-review",
	},
	passed: {
		name: "verify passed",
		meaning: "the run or its checks finished clean",
		shape: "check",
		token: "--mfw-ok",
	},
	verify_fail: {
		name: "verify failed",
		meaning: "a verification check failed",
		shape: "cross",
		token: "--mfw-critical",
	},
	failed: {
		name: "run failed",
		meaning: "the run ended in failure",
		shape: "disc-cross",
		token: "--mfw-critical",
	},
	notify: {
		name: "needs you",
		meaning: "the brain asks for a person",
		shape: "triangle",
		token: "--mfw-warn",
	},
	hold: {
		name: "hold placed",
		meaning: "the task was held for a resource",
		shape: "bars",
		token: "--mfw-fg-muted",
	},
	released: {
		name: "hold released",
		meaning: "the hold ended and the task may run",
		shape: "play",
		token: "--mfw-ok",
	},
	verdict: {
		name: "review verdict",
		meaning: "a reviewer ruled on a run",
		shape: "hexagon",
		token: "--mfw-info",
	},
	spawn: {
		name: "spawned",
		meaning: "an attempt or subagent was started",
		shape: "chevrons",
		token: "--mfw-fg-muted",
	},
	stopped: {
		name: "run stopped",
		meaning: "the run was stopped or interrupted",
		shape: "no-entry",
		token: "--mfw-warn",
	},
};

/** The order the legend lists marks in: the mix the owner asked for first. */
export const MARK_ORDER: readonly MarkKind[] = [
	"decision",
	"human",
	"merge",
	"passed",
	"verify_fail",
	"failed",
	"notify",
	"hold",
	"released",
	"verdict",
	"spawn",
	"stopped",
];

/** Side of a mark's box in px; the layout's pitch is derived from it. */
export const MARK_SIZE = 16;
const STROKE = 2;

/** The geometry of each shape in a 16x16 box. */
function Geometry({ shape }: { shape: MarkShape }) {
	const stroke = {
		fill: "none",
		stroke: "currentColor",
		strokeWidth: STROKE,
		strokeLinecap: "round",
		strokeLinejoin: "round",
	} as const;
	const knock = "var(--mfw-bg-raised)";
	switch (shape) {
		case "diamond":
			return <path d="M8 1 L15 8 L8 15 L1 8 Z" fill="currentColor" />;
		case "ring":
			return (
				<>
					<circle cx="8" cy="8" r="6" {...stroke} />
					<circle cx="8" cy="8" r="2" fill="currentColor" />
				</>
			);
		case "square":
			return (
				<rect x="2" y="2" width="12" height="12" rx="2.5" fill="currentColor" />
			);
		case "cross":
			return (
				<path
					d="M3.5 3.5 L12.5 12.5 M12.5 3.5 L3.5 12.5"
					{...stroke}
					strokeWidth={2.5}
				/>
			);
		case "check":
			return (
				<path d="M2.5 8.5 L6.5 12.5 L13.5 3.5" {...stroke} strokeWidth={2.5} />
			);
		case "disc-cross":
			return (
				<>
					<circle cx="8" cy="8" r="7" fill="currentColor" />
					<path
						d="M5.2 5.2 L10.8 10.8 M10.8 5.2 L5.2 10.8"
						stroke={knock}
						strokeWidth={2}
						strokeLinecap="round"
					/>
				</>
			);
		case "triangle":
			return (
				<>
					<path
						d="M8 1.2 L15.2 14 L0.8 14 Z"
						fill="currentColor"
						stroke="currentColor"
						strokeWidth={1.5}
						strokeLinejoin="round"
					/>
					<path
						d="M8 5.6 L8 9.4"
						stroke={knock}
						strokeWidth={2}
						strokeLinecap="round"
					/>
					<circle cx="8" cy="11.6" r="1.1" fill={knock} />
				</>
			);
		case "bars":
			return (
				<>
					<rect
						x="3"
						y="2.5"
						width="3.6"
						height="11"
						rx="1"
						fill="currentColor"
					/>
					<rect
						x="9.4"
						y="2.5"
						width="3.6"
						height="11"
						rx="1"
						fill="currentColor"
					/>
				</>
			);
		case "play":
			return <path d="M4.5 2.8 L13 8 L4.5 13.2 Z" {...stroke} />;
		case "hexagon":
			return (
				<path
					d="M8 1 L14.4 4.5 L14.4 11.5 L8 15 L1.6 11.5 L1.6 4.5 Z"
					fill="currentColor"
				/>
			);
		case "chevrons":
			return (
				<path
					d="M2.5 3.5 L7 8 L2.5 12.5 M8.5 3.5 L13 8 L8.5 12.5"
					{...stroke}
				/>
			);
		case "no-entry":
			return (
				<>
					<circle cx="8" cy="8" r="6" {...stroke} />
					<path d="M4.6 8 L11.4 8" {...stroke} />
				</>
			);
	}
}

/** One mark, `MARK_SIZE` px by default, in the kind's token colour. */
export function MarkIcon({
	kind,
	size = MARK_SIZE,
	className,
}: {
	kind: MarkKind;
	size?: number;
	className?: string;
}) {
	const look = MARK_LOOK[kind];
	return (
		// biome-ignore lint/a11y/noSvgWithoutTitle: decorative; the owner button carries the name
		<svg
			aria-hidden
			focusable={false}
			width={size}
			height={size}
			viewBox="0 0 16 16"
			data-mark-shape={look.shape}
			className={className}
			style={{ color: `var(${look.token})`, display: "block", flex: "none" }}
		>
			<Geometry shape={look.shape} />
		</svg>
	);
}
