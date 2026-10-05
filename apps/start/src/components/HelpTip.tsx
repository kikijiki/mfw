import { CircleHelp } from "lucide-react";
import { Tooltip as TooltipPrimitive } from "radix-ui";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

/** Compact, keyboard-accessible help for context that should not crowd a form. */
export function HelpTip({
	children,
	label = "More information",
	className,
}: {
	children: ReactNode;
	label?: string;
	className?: string;
}) {
	return (
		<TooltipPrimitive.Provider delayDuration={250}>
			<TooltipPrimitive.Root>
				<TooltipPrimitive.Trigger asChild>
					<button
						type="button"
						aria-label={label}
						className={cn(
							"mfw-focus inline-flex size-5 shrink-0 items-center justify-center",
							className,
						)}
						style={{ color: "var(--mfw-fg-faint)" }}
					>
						<CircleHelp aria-hidden className="size-3.5" />
					</button>
				</TooltipPrimitive.Trigger>
				<TooltipPrimitive.Portal>
					<TooltipPrimitive.Content
						sideOffset={4}
						collisionPadding={8}
						className="mfw-v2 z-50 max-w-80 p-2 shadow-lg"
						style={{
							color: "var(--mfw-fg)",
							background: "var(--mfw-bg-raised)",
							border: "1px solid var(--mfw-border)",
							borderRadius: "var(--mfw-radius-sm)",
							fontSize: "var(--mfw-text-2xs)",
							lineHeight: "var(--mfw-leading-data)",
						}}
					>
						{children}
						<TooltipPrimitive.Arrow style={{ fill: "var(--mfw-border)" }} />
					</TooltipPrimitive.Content>
				</TooltipPrimitive.Portal>
			</TooltipPrimitive.Root>
		</TooltipPrimitive.Provider>
	);
}
