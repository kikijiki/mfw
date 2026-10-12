"use client";

import { Tooltip as TooltipPrimitive } from "radix-ui";
import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * TOOLTIP POLICY (enforced for `title=` by `tooltipPolicy.test.ts`).
 *
 * 1. Never the native `title` attribute: it clips, cannot be styled, and is
 *    absent on touch and keyboard focus. Use `Tip` (or a `Tip*` element below).
 * 2. A tooltip ADDS information that is not visible. Delete it when it repeats
 *    the visible text or the control's `aria-label` (an X that closes, a
 *    chevron that expands). A truncated value gets `clipped`, which opens only
 *    when the text is actually cut off.
 * 3. One line, at most one more sentence. A paragraph belongs in a HelpTip or
 *    a visible muted line, not here. Icon-only controls get a short verb phrase
 *    and, where a binding exists, the key in parentheses.
 * 4. Placement never covers the thing described or its neighbours: pass
 *    `side="right"` for sidebar items and stacked rows, `top` elsewhere.
 *    Collision handling flips at the viewport edge.
 * 5. Opens after 400 ms of hover or on focus, closes at once. Touch never
 *    opens it, so nothing may be reachable only through a tooltip.
 *
 * The one tooltip. The native `title` attribute renders in an OS box that is
 * unstyled, slow, clipped at corners and absent on keyboard focus; this one is
 * portalled (so no overflow container clips it), opens on hover and focus after
 * a short delay, closes on Escape, flips at viewport edges and wraps long text.
 *
 * Keep `aria-label` on icon-only controls: a tooltip supplements the name.
 */

function TooltipProvider({
	delayDuration = 400,
	skipDelayDuration = 0,
	...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
	return (
		<TooltipPrimitive.Provider
			delayDuration={delayDuration}
			skipDelayDuration={skipDelayDuration}
			{...props}
		/>
	);
}

function TooltipContent({
	className,
	sideOffset = 6,
	collisionPadding = 8,
	children,
	...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
	return (
		<TooltipPrimitive.Portal>
			<TooltipPrimitive.Content
				data-slot="tooltip-content"
				sideOffset={sideOffset}
				collisionPadding={collisionPadding}
				className={cn(
					"z-[100] w-fit max-w-[min(20rem,calc(100vw-1rem))] rounded-md border px-2 py-1 text-left text-xs leading-snug break-words whitespace-normal shadow-sm",
					className,
				)}
				style={{
					background: "var(--mfw-bg-raised)",
					color: "var(--mfw-fg)",
					borderColor: "var(--mfw-border-strong)",
					borderWidth: 1,
					borderRadius: "var(--mfw-radius-md)",
					fontSize: "var(--mfw-text-xs)",
				}}
				{...props}
			>
				{children}
			</TooltipPrimitive.Content>
		</TooltipPrimitive.Portal>
	);
}

/**
 * `<Tip label="...">{button}</Tip>`: the replacement for `title=`.
 * The child must accept a ref and props (a DOM element or a forwarding
 * component). An empty label renders the child untouched. `clipped` opens the
 * tip only while the child's text is cut off (ellipsis or line clamp).
 */
function Tip({
	label,
	children,
	side = "top",
	align = "center",
	delayDuration,
	disabled = false,
	clipped = false,
}: {
	label: React.ReactNode;
	children: React.ReactElement;
	side?: "top" | "right" | "bottom" | "left";
	align?: "start" | "center" | "end";
	delayDuration?: number;
	disabled?: boolean;
	clipped?: boolean;
}) {
	const ref = React.useRef<HTMLElement | null>(null);
	const [open, setOpen] = React.useState(false);
	if (disabled || label === null || label === undefined || label === "") {
		return children;
	}
	const onOpenChange = clipped
		? (next: boolean) => {
				const el = ref.current;
				setOpen(
					next &&
						el !== null &&
						(el.scrollWidth > el.clientWidth + 1 ||
							el.scrollHeight > el.clientHeight + 1),
				);
			}
		: undefined;
	return (
		<TooltipProvider>
			<TooltipPrimitive.Root
				delayDuration={delayDuration}
				{...(clipped ? { open, onOpenChange } : {})}
			>
				<TooltipPrimitive.Trigger
					asChild
					ref={ref as React.Ref<HTMLButtonElement>}
				>
					{children}
				</TooltipPrimitive.Trigger>
				<TooltipContent side={side} align={align}>
					{label}
				</TooltipContent>
			</TooltipPrimitive.Root>
		</TooltipProvider>
	);
}

type TipProps = {
	/** The tooltip text; empty renders the bare element. */
	tip?: React.ReactNode;
	tipSide?: "top" | "right" | "bottom" | "left";
	tipAlign?: "start" | "center" | "end";
	/** Open only while this element's text is cut off. */
	clipped?: boolean;
};

/** `<TipSpan tip="...">`: a DOM element with a shared tooltip instead of `title=`. */
function tipped<
	K extends
		| "span"
		| "a"
		| "p"
		| "li"
		| "td"
		| "time"
		| "div"
		| "summary"
		| "select"
		| "button",
>(tag: K) {
	function Tipped(props: React.ComponentProps<K> & TipProps) {
		const { tip, tipSide, tipAlign, clipped, ...rest } = props;
		return (
			<Tip
				label={tip}
				clipped={clipped ?? false}
				{...(tipSide ? { side: tipSide } : {})}
				{...(tipAlign ? { align: tipAlign } : {})}
			>
				{React.createElement(tag, rest as object)}
			</Tip>
		);
	}
	Tipped.displayName = `Tip(${tag})`;
	return Tipped;
}

const TipSpan = tipped("span");
const TipA = tipped("a");
const TipP = tipped("p");
const TipLi = tipped("li");
const TipTd = tipped("td");
const TipTime = tipped("time");
const TipDiv = tipped("div");
const TipSummary = tipped("summary");
const TipSelect = tipped("select");
const TipButton = tipped("button");

const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;

export {
	Tip,
	TipA,
	TipButton,
	TipDiv,
	TipLi,
	TipP,
	TipSelect,
	TipSpan,
	TipSummary,
	TipTd,
	TipTime,
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
};
