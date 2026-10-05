import {
	Archive,
	Ban,
	Circle,
	CircleCheck,
	CircleDashed,
	CircleDot,
	CircleSlash,
	CircleStop,
	CircleX,
	Eye,
	GitMerge,
	Hourglass,
	type LucideIcon,
	PenLine,
	Play,
	Timer,
	TriangleAlert,
	Wrench,
} from "lucide-react";

import { cn } from "~/lib/utils";
import { humanizeToken } from "../lib/format";

/** Task status and run state. Each state has its own icon and word; color is never the only signal (colorblind, screenshots). */

export type TaskStatus =
	| "draft"
	| "backlog"
	| "ready"
	| "in_progress"
	| "blocked"
	| "review"
	| "done"
	| "archived";

export type RunState =
	| "starting"
	| "running"
	| "ended"
	| "finalizing"
	| "merging"
	| "completed"
	| "failed"
	| "killed"
	| "interrupted"
	| "rate_limited"
	| "needs_review"
	| "finalize_error";

interface Look {
	icon: LucideIcon;
	/** A CSS custom property name from tokens.css, never a literal color. */
	token: string;
	label?: string;
	/** Live states pulse so a stalled board is visibly not a running one. */
	live?: boolean;
}

const TASK_LOOK: Record<TaskStatus, Look> = {
	draft: { icon: PenLine, token: "--mfw-neutral" },
	backlog: { icon: CircleDashed, token: "--mfw-status-backlog" },
	ready: { icon: Circle, token: "--mfw-status-ready" },
	in_progress: {
		icon: CircleDot,
		token: "--mfw-status-in-progress",
		live: true,
	},
	blocked: { icon: CircleSlash, token: "--mfw-status-blocked" },
	review: { icon: Eye, token: "--mfw-status-review" },
	done: { icon: CircleCheck, token: "--mfw-status-done" },
	archived: { icon: Archive, token: "--mfw-status-archived" },
};

const RUN_LOOK: Record<RunState, Look> = {
	starting: { icon: Hourglass, token: "--mfw-neutral" },
	running: { icon: Play, token: "--mfw-status-in-progress", live: true },
	ended: { icon: CircleStop, token: "--mfw-neutral" },
	finalizing: { icon: Wrench, token: "--mfw-info", live: true },
	merging: { icon: GitMerge, token: "--mfw-info", live: true },
	completed: { icon: CircleCheck, token: "--mfw-ok" },
	failed: { icon: CircleX, token: "--mfw-critical" },
	killed: { icon: Ban, token: "--mfw-warn" },
	interrupted: { icon: CircleSlash, token: "--mfw-warn" },
	// Not a failure: requeued until the limit clears, so not red.
	rate_limited: { icon: Timer, token: "--mfw-warn", label: "rate limited" },
	needs_review: {
		icon: Eye,
		token: "--mfw-status-review",
		label: "needs review",
	},
	finalize_error: {
		icon: TriangleAlert,
		token: "--mfw-critical",
		label: "finalize error",
	},
};

export type StatusPillProps = (
	| { kind: "task"; value: TaskStatus }
	| { kind: "run"; value: RunState }
) & {
	/** `dot` drops the label for dense cells; keep `full` anywhere it fits. */
	variant?: "full" | "dot";
	className?: string;
};

export function StatusPill(props: StatusPillProps) {
	const { variant = "full", className } = props;
	const look =
		props.kind === "task"
			? (TASK_LOOK[props.value] ?? TASK_LOOK.backlog)
			: (RUN_LOOK[props.value] ?? RUN_LOOK.ended);
	const Icon = look.icon;
	const label = look.label ?? humanizeToken(props.value);

	if (variant === "dot") {
		return (
			<Icon
				aria-label={label}
				role="img"
				className={cn("size-3.5 shrink-0", look.live && "mfw-pulse", className)}
				style={{ color: `var(${look.token})` }}
			/>
		);
	}

	return (
		<span
			className={cn(
				"inline-flex h-5 shrink-0 items-center gap-1 border px-1.5 whitespace-nowrap",
				className,
			)}
			style={{
				color: `var(${look.token})`,
				// Tint of the same token: legible in both themes without a second color per state.
				background: `color-mix(in oklch, var(${look.token}) 12%, transparent)`,
				borderColor: `color-mix(in oklch, var(${look.token}) 32%, transparent)`,
				borderRadius: "var(--mfw-radius-sm)",
				fontSize: "var(--mfw-text-2xs)",
			}}
		>
			<Icon
				aria-hidden
				className={cn("size-3 shrink-0", look.live && "mfw-pulse")}
			/>
			{label}
		</span>
	);
}
