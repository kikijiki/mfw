import { useSyncExternalStore } from "react";

import { cn } from "~/lib/utils";
import { formatAbsolute, formatDuration, formatRelative } from "../lib/format";

/**
 * "3h ago". The tick is a clock, not a poll: one app-wide interval, alive only
 * while a `<RelativeTime>` is mounted and paused while the tab is hidden, that
 * re-renders text derived from `now`.
 */

const TICK_MS = 30_000;

class Clock {
	private listeners = new Set<() => void>();
	private timer: ReturnType<typeof setInterval> | null = null;
	private now = Date.now();

	subscribe = (fn: () => void): (() => void) => {
		this.listeners.add(fn);
		this.start();
		return () => {
			this.listeners.delete(fn);
			if (this.listeners.size === 0) this.stop();
		};
	};

	getSnapshot = (): number => this.now;
	/** SSR renders one fixed instant; the client corrects on hydration. */
	getServerSnapshot = (): number => 0;

	private start(): void {
		if (this.timer !== null || typeof window === "undefined") return;
		this.timer = setInterval(() => {
			// Skip hidden tabs; the next visible tick catches up.
			if (document.visibilityState === "hidden") return;
			this.now = Date.now();
			for (const fn of this.listeners) fn();
		}, TICK_MS);
	}

	private stop(): void {
		if (this.timer === null) return;
		clearInterval(this.timer);
		this.timer = null;
	}
}

const clock = new Clock();

export function useNow(): number {
	const now = useSyncExternalStore(
		clock.subscribe,
		clock.getSnapshot,
		clock.getServerSnapshot,
	);
	// `0` is the SSR sentinel: before hydration there is no meaningful clock.
	return now === 0 ? Date.now() : now;
}

export interface RelativeTimeProps {
	value: Date | number | string | null | undefined;
	className?: string;
	/** Shown instead of nothing when the value is absent. */
	placeholder?: string;
}

export function RelativeTime({
	value,
	className,
	placeholder = "-",
}: RelativeTimeProps) {
	const now = useNow();
	if (value == null) return <span className={className}>{placeholder}</span>;
	const ts = value instanceof Date ? value.getTime() : Number(new Date(value));
	if (!Number.isFinite(ts))
		return <span className={className}>{placeholder}</span>;
	return (
		<time
			dateTime={new Date(ts).toISOString()}
			title={formatAbsolute(ts)}
			className={cn("whitespace-nowrap", className)}
		>
			{formatRelative(ts, now)}
		</time>
	);
}

/** Elapsed time since a start instant, the "12m" on a live run card. */
export function Elapsed({
	since,
	until,
	className,
}: {
	since: Date | number;
	until?: Date | number | null;
	className?: string;
}) {
	const now = useNow();
	const start = since instanceof Date ? since.getTime() : since;
	const end =
		until == null ? now : until instanceof Date ? until.getTime() : until;
	return (
		<span className={cn("mfw-num whitespace-nowrap", className)}>
			{formatDuration(end - start)}
		</span>
	);
}
