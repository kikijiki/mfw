import type { CSSProperties, ReactNode } from "react";

import { cn } from "~/lib/utils";

/** The page frame every screen composes from, so no screen writes color, radius or padding literals. */

export function Page({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cn("flex min-h-0 w-full flex-col", className)}
			style={{
				color: "var(--mfw-fg)",
				fontFamily: "var(--mfw-font-ui)",
				fontSize: "var(--mfw-font-data)",
				lineHeight: "var(--mfw-leading-data)",
			}}
		>
			{children}
		</div>
	);
}

/**
 * Sticky title row. `meta` sits under the title, `actions` on the right.
 *
 * `title` is optional: screens under the project tab strip already show their
 * name, so omit it there and keep the meta line.
 */
export function PageHeader({
	title,
	meta,
	actions,
	back,
	className,
}: {
	title?: ReactNode;
	meta?: ReactNode;
	actions?: ReactNode;
	back?: ReactNode;
	className?: string;
}) {
	return (
		<header
			className={cn(
				"flex flex-wrap items-start gap-x-3 gap-y-2 border-b px-3 py-2",
				className,
			)}
			style={{
				borderColor: "var(--mfw-border)",
				background: "var(--mfw-bg)",
			}}
		>
			<div className="flex min-w-0 flex-1 flex-col gap-1">
				{back ? <div className="flex items-center gap-2">{back}</div> : null}
				{title ? (
					<h1
						className="min-w-0 truncate font-semibold"
						style={{ fontSize: "var(--mfw-text-lg)" }}
					>
						{title}
					</h1>
				) : null}
				{meta ? (
					<div
						className="flex flex-wrap items-center gap-x-3 gap-y-1"
						style={{
							color: "var(--mfw-fg-muted)",
							fontSize: "var(--mfw-text-xs)",
						}}
					>
						{meta}
					</div>
				) : null}
			</div>
			{actions ? (
				<div className="flex max-w-full shrink-0 flex-wrap items-center gap-2">
					{actions}
				</div>
			) : null}
		</header>
	);
}

/**
 * A bordered surface. `pad={false}` for lists that own their own padding.
 *
 * The body is a shrinkable flex column (`min-h-0`) so a Panel given a height
 * scrolls its own contents instead of pushing scroll out to the document.
 * `grow` (not `flex-1`) keeps the flex basis `auto`, so content-sized Panels
 * are unchanged. The Panel itself must be `shrink-0`: inside a `Scroller`, a
 * shrinkable Panel gets squeezed below its content height and spills past its
 * border instead of the Scroller scrolling.
 */
export function Panel({
	title,
	actions,
	children,
	pad = true,
	className,
	style,
}: {
	title?: ReactNode;
	actions?: ReactNode;
	children: ReactNode;
	pad?: boolean;
	className?: string;
	style?: CSSProperties;
}) {
	return (
		<section
			className={cn("flex min-h-0 min-w-0 shrink-0 flex-col border", className)}
			style={{
				borderColor: "var(--mfw-border)",
				borderRadius: "var(--mfw-radius-md)",
				background: "var(--mfw-bg-raised)",
				...style,
			}}
		>
			{title ? (
				<div
					className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5"
					style={{ borderColor: "var(--mfw-border)" }}
				>
					<h2
						className="min-w-0 flex-1 truncate uppercase"
						style={{
							color: "var(--mfw-fg-muted)",
							fontSize: "var(--mfw-text-2xs)",
							letterSpacing: "0.06em",
						}}
					>
						{title}
					</h2>
					{actions}
				</div>
			) : null}
			<div className={cn("flex min-h-0 min-w-0 grow flex-col", pad && "p-3")}>
				{children}
			</div>
		</section>
	);
}

/** A key/value line in a rail. */
export function Field({
	label,
	children,
	className,
}: {
	label: ReactNode;
	children: ReactNode;
	className?: string;
}) {
	return (
		<div className={cn("flex items-baseline gap-2", className)}>
			<span
				className="shrink-0"
				style={{
					color: "var(--mfw-fg-faint)",
					fontSize: "var(--mfw-text-xs)",
				}}
			>
				{label}
			</span>
			<span className="min-w-0 flex-1 break-words">{children}</span>
		</div>
	);
}

/** Small neutral chip, project names, kinds, labels. */
export function Chip({
	children,
	tone = "neutral",
	className,
	title,
}: {
	children: ReactNode;
	tone?: "neutral" | "accent" | "ok" | "warn" | "critical" | "info";
	className?: string;
	title?: string;
}) {
	const token =
		tone === "neutral"
			? "--mfw-fg-muted"
			: `--mfw-${tone === "accent" ? "accent" : tone}`;
	return (
		<span
			title={title}
			className={cn(
				"inline-flex h-5 shrink-0 items-center gap-1 border px-1.5 whitespace-nowrap",
				className,
			)}
			style={{
				color: `var(${token})`,
				background: `color-mix(in oklch, var(${token}) 10%, transparent)`,
				borderColor: `color-mix(in oklch, var(${token}) 28%, transparent)`,
				borderRadius: "var(--mfw-radius-sm)",
				fontSize: "var(--mfw-text-2xs)",
			}}
		>
			{children}
		</span>
	);
}

/** Body scroll region for screens whose content is a long list. */
export function Scroller({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<div className={cn("min-h-0 flex-1 overflow-auto", className)}>
			{children}
		</div>
	);
}
