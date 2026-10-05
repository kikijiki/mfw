import { PlugZap, RefreshCw, TriangleAlert } from "lucide-react";
import { type ReactNode, useState } from "react";

import { Alert } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import { formatRelative } from "../lib/format";
import { useLive } from "../lib/live";
import { humanizeError } from "../lib/toast";

/**
 * Panel-scoped error state: a failed panel renders its own error and leaves
 * siblings alone. The stack is collapsed behind a Detail toggle.
 */
export interface ErrorStateProps {
	title?: string;
	error: unknown;
	onRetry?: () => void;
	className?: string;
}

export function ErrorState({
	title = "Could not load this",
	error,
	onRetry,
	className,
}: ErrorStateProps) {
	const [showDetail, setShowDetail] = useState(false);
	const detail =
		error instanceof Error && error.stack ? error.stack : String(error);

	return (
		<div
			className={cn("flex flex-col items-start gap-2 border p-4", className)}
			style={{
				borderColor:
					"color-mix(in oklch, var(--mfw-critical) 35%, transparent)",
				background: "color-mix(in oklch, var(--mfw-critical) 6%, transparent)",
				borderRadius: "var(--mfw-radius-md)",
			}}
		>
			<div className="flex items-center gap-2">
				<TriangleAlert
					aria-hidden
					className="size-4"
					style={{ color: "var(--mfw-critical)" }}
				/>
				<span style={{ fontSize: "var(--mfw-text-md)" }}>{title}</span>
			</div>
			<p style={{ color: "var(--mfw-fg-muted)" }}>{humanizeError(error)}</p>
			<div className="flex items-center gap-2">
				{onRetry ? (
					<Button size="sm" variant="outline" onClick={onRetry}>
						<RefreshCw aria-hidden /> Retry
					</Button>
				) : null}
				<Button
					size="sm"
					variant="ghost"
					aria-expanded={showDetail}
					onClick={() => setShowDetail((v) => !v)}
				>
					{showDetail ? "Hide detail" : "Detail"}
				</Button>
			</div>
			{showDetail ? (
				<pre
					className="mfw-num max-h-60 w-full overflow-auto p-2 whitespace-pre-wrap"
					style={{
						background: "var(--mfw-bg-inset)",
						borderRadius: "var(--mfw-radius-sm)",
						fontSize: "var(--mfw-text-2xs)",
					}}
				>
					{detail}
				</pre>
			) : null}
		</div>
	);
}

/**
 * Daemon-unreachable banner. Cached data stays on screen (it is all there is);
 * the banner is the caveat, and "running" claims elsewhere must read as unknown.
 */
export function DaemonUnreachableBanner({
	lastContactAt,
	onRetry,
	className,
}: {
	lastContactAt: number | null;
	onRetry: () => void;
	className?: string;
}) {
	return (
		<div
			className={cn("flex flex-wrap items-center gap-2 px-3 py-1.5", className)}
			style={{
				background: "color-mix(in oklch, var(--mfw-critical) 14%, transparent)",
				borderBottom:
					"1px solid color-mix(in oklch, var(--mfw-critical) 35%, transparent)",
				color: "var(--mfw-fg)",
			}}
		>
			<PlugZap
				aria-hidden
				className="size-4"
				style={{ color: "var(--mfw-critical)" }}
			/>
			<span>
				Daemon unreachable
				{lastContactAt ? ` since ${formatRelative(lastContactAt)}` : ""}: what
				you see is the last known state.
			</span>
			<Button size="xs" variant="outline" onClick={onRetry}>
				Retry now
			</Button>
		</div>
	);
}

/** Slim, non-blocking overlay for a connection that dropped seconds ago. */
export function ReconnectingOverlay({ className }: { className?: string }) {
	return (
		<Alert
			role="status"
			aria-live="polite"
			className={cn(
				"pointer-events-none absolute inset-x-0 top-0 z-30 flex items-center gap-2 rounded-none border-0 px-3 py-1",
				className,
			)}
			style={{
				background: "color-mix(in oklch, var(--mfw-warn) 14%, transparent)",
				color: "var(--mfw-fg-muted)",
				fontSize: "var(--mfw-text-xs)",
			}}
		>
			<RefreshCw
				aria-hidden
				className="mfw-pulse size-3.5"
				style={{ color: "var(--mfw-warn)" }}
			/>
			Reconnecting…
		</Alert>
	);
}

/** Wraps present-tense facts ("running", "12m elapsed") that are only valid while the channel is live. */
export function StaleWhenOffline({
	children,
	label = "Status unavailable while disconnected",
}: {
	children: ReactNode;
	label?: string;
}) {
	const { status } = useLive();
	if (status !== "offline") return <>{children}</>;
	return (
		<span
			title={label}
			style={{ color: "var(--mfw-fg-faint)", textDecoration: "line-through" }}
		>
			{children}
		</span>
	);
}
